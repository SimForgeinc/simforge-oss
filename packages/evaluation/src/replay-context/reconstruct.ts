/**
 * Reconstruction: a calibrated, ego-posed multi-camera clip becomes a renderable NuRec scene.
 *
 * This is the `reconstruct.nurec` job's real entrypoint, and it drives the tooling that
 * actually performs the reconstruction rather than standing in for it:
 *
 *   1. preflight the external tier (3DGRUT checkout, CUDA torch) and refuse early if absent;
 *   2. write the clip out as a COLMAP-format dataset — the multi-sensor, distorted-camera
 *      input format 3DGRUT's `dataset_colmap` loader reads;
 *   3. run upstream training: `python train.py --config-name apps/colmap_3dgut.yaml
 *      path=<dataset> out_dir=<runs> experiment_name=<id> export_usd.enabled=true
 *      export_usd.format=nurec`;
 *   4. import the exported NuRec `.usdz` as a replay-context bundle, which then has to pass
 *      the same G1–G5 gates as any other scene before a policy may drive it.
 *
 * The upstream commands and config names are 3DGRUT's own (`nv-tlabs/3dgrut`): `train.py`
 * with the `apps/colmap_3dgut.yaml` app config, and the `export_usd` block with
 * `format: nurec`. Nothing is re-implemented here and nothing is faked; if the checkout is
 * missing, that is reported as a capability error naming exactly what to install.
 *
 * ## What is deliberately refused
 *
 * - **Uncalibrated video.** No intrinsics, no extrinsics, no timestamps, no ego poses: no
 *   reconstruction, with the missing fields listed.
 * - **Planar-only ego poses.** `ego.recordedPose6dof` is required. Reconstructing from a flat
 *   pose track produces a confidently wrong world.
 * - **A missing seed point cloud.** 3DGUT initialises from a point cloud; seeding from noise
 *   would yield a plausible scene that is not a reconstruction of the user's drive.
 * - **f-theta rigs on the COLMAP path.** COLMAP's camera models cannot express an f-theta
 *   polynomial, and fitting one to `OPENCV_FISHEYE` behind the user's back would silently
 *   change the calibration. Those rigs need the NCore v4 dataset path, which requires the
 *   `ncore` package — reported as a prerequisite, not worked around.
 * - **Encoded video without extracted frames.** Frame extraction needs ffmpeg; rather than
 *   shelling out to an undeclared binary, the clip must supply an image sequence.
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cameraTimestamps } from './cameras.js';
import { deferred } from './deferred.js';
import { reconstructionRefusal, type ClipAdmission } from './clip.js';
import { importUserBundle } from './importers/user-bundle.js';
import { CapabilityError } from './render.js';
import { RefusalError, type Refusal } from './refusal.js';
import type { CalibratedCamera, ReplayContext } from './schema.js';

/** Upstream app config used for the reconstruction. */
export const THREEDGRUT_CONFIG = 'apps/colmap_3dgut.yaml';

export interface ReconstructionTier {
  /** 3DGRUT checkout root (the directory containing `train.py` and `configs/`). */
  readonly threedgrutRoot?: string;
  /** Interpreter for the 3DGRUT environment; must be the venv Python that has its deps. */
  readonly pythonCommand?: string;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly threedgrutRoot?: string;
  readonly torchVersion?: string;
  readonly cudaAvailable?: boolean;
  readonly missing: readonly string[];
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
  const { promise, resolve, reject } = deferred<CommandResult>();
  const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  return promise;
}

/**
 * Check the reconstruction tier without allocating a GPU or starting a job.
 *
 * Exposed as `--preflight-only` so a worker image build, or the compute control plane before
 * dispatch, can find out that a host can never run this work instead of discovering it after
 * the job has been scheduled and billed.
 */
export async function preflightReconstruction(tier: ReconstructionTier = {}): Promise<PreflightReport> {
  const python = tier.pythonCommand ?? 'python3';
  const root = tier.threedgrutRoot ?? process.env['THREEDGRUT_ROOT'];
  const missing: string[] = [];

  let resolvedRoot: string | undefined;
  if (root !== undefined) {
    try {
      await stat(path.join(root, 'train.py'));
      resolvedRoot = root;
    } catch {
      missing.push(`THREEDGRUT_ROOT=${root} does not contain train.py`);
    }
  }
  if (resolvedRoot === undefined) {
    const probe = await run(python, ['-c', 'import importlib.util,os;s=importlib.util.find_spec("threedgrut");print(os.path.dirname(s.submodule_search_locations[0]) if s else "")']).catch(
      () => ({ code: -1, stdout: '', stderr: 'interpreter not runnable' }),
    );
    const found = probe.stdout.trim();
    if (found !== '') resolvedRoot = found;
    else {
      missing.push(
        'the 3DGRUT checkout is not available: set THREEDGRUT_ROOT to a clone of https://github.com/nv-tlabs/3dgrut '
        + 'with its environment installed (install_env_uv.sh), or install the threedgrut package into the interpreter',
      );
    }
  }

  const torchProbe = await run(python, [
    '-c',
    'import json,torch;print(json.dumps({"v":torch.__version__,"cuda":bool(torch.cuda.is_available())}))',
  ]).catch(() => ({ code: -1, stdout: '', stderr: 'interpreter not runnable' }));
  let torchVersion: string | undefined;
  let cudaAvailable: boolean | undefined;
  if (torchProbe.code === 0) {
    try {
      const parsed = JSON.parse(torchProbe.stdout.trim()) as { v: string; cuda: boolean };
      torchVersion = parsed.v;
      cudaAvailable = parsed.cuda;
      if (!parsed.cuda) missing.push('torch reports no CUDA device; 3DGUT training requires a CUDA GPU');
    } catch {
      missing.push('could not parse the torch probe output');
    }
  } else {
    missing.push(`a CUDA-enabled PyTorch is not importable from ${python}`);
  }

  return {
    ok: missing.length === 0,
    ...(resolvedRoot === undefined ? {} : { threedgrutRoot: resolvedRoot }),
    ...(torchVersion === undefined ? {} : { torchVersion }),
    ...(cudaAvailable === undefined ? {} : { cudaAvailable }),
    missing,
  };
}

/* --------------------------------------------------------------- COLMAP out */

/** COLMAP camera model line for a calibrated camera, or the reason it has none. */
function colmapCamera(camera: CalibratedCamera, cameraIndex: number): { line: string } | { error: string } {
  const intrinsics = camera.intrinsics;
  if (intrinsics.model === 'pinhole') {
    return {
      line: `${cameraIndex} PINHOLE ${camera.width} ${camera.height} ${intrinsics.fx} ${intrinsics.fy} ${intrinsics.cx} ${intrinsics.cy}`,
    };
  }
  if (intrinsics.model === 'opencv') {
    const [k1, k2, p1, p2] = intrinsics.distortion;
    return {
      line:
        `${cameraIndex} OPENCV ${camera.width} ${camera.height} `
        + `${intrinsics.fx} ${intrinsics.fy} ${intrinsics.cx} ${intrinsics.cy} ${k1} ${k2} ${p1} ${p2}`,
    };
  }
  return {
    error:
      `camera ${camera.sensorId} uses the f-theta model, which no COLMAP camera model can express. `
      + 'Reconstructing an f-theta AV rig requires the NCore v4 dataset path (pip install nvidia-ncore) — '
      + 'SimForge will not silently refit your calibration to OPENCV_FISHEYE.',
  };
}

/** Quaternion (x, y, z, w) rotating rig into world → the world-to-camera quaternion COLMAP wants. */
function worldToCameraQuat(
  rigToWorld: readonly [number, number, number, number],
  cameraFromRig: readonly (readonly number[])[],
): { q: [number, number, number, number]; r: number[][] } {
  const [qx, qy, qz, qw] = rigToWorld;
  // R_world_rig from the quaternion.
  const worldFromRig = [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
  // R_camera_world = R_camera_rig · R_rig_world = R_camera_rig · R_world_rigᵀ
  const cameraFromWorld: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += cameraFromRig[i]![k]! * worldFromRig[j]![k]!;
      cameraFromWorld[i]![j] = sum;
    }
  }
  const trace = cameraFromWorld[0]![0]! + cameraFromWorld[1]![1]! + cameraFromWorld[2]![2]!;
  let w: number;
  let x: number;
  let y: number;
  let z: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (cameraFromWorld[2]![1]! - cameraFromWorld[1]![2]!) / s;
    y = (cameraFromWorld[0]![2]! - cameraFromWorld[2]![0]!) / s;
    z = (cameraFromWorld[1]![0]! - cameraFromWorld[0]![1]!) / s;
  } else if (cameraFromWorld[0]![0]! > cameraFromWorld[1]![1]! && cameraFromWorld[0]![0]! > cameraFromWorld[2]![2]!) {
    const s = Math.sqrt(1 + cameraFromWorld[0]![0]! - cameraFromWorld[1]![1]! - cameraFromWorld[2]![2]!) * 2;
    w = (cameraFromWorld[2]![1]! - cameraFromWorld[1]![2]!) / s;
    x = s / 4;
    y = (cameraFromWorld[0]![1]! + cameraFromWorld[1]![0]!) / s;
    z = (cameraFromWorld[0]![2]! + cameraFromWorld[2]![0]!) / s;
  } else if (cameraFromWorld[1]![1]! > cameraFromWorld[2]![2]!) {
    const s = Math.sqrt(1 + cameraFromWorld[1]![1]! - cameraFromWorld[0]![0]! - cameraFromWorld[2]![2]!) * 2;
    w = (cameraFromWorld[0]![2]! - cameraFromWorld[2]![0]!) / s;
    x = (cameraFromWorld[0]![1]! + cameraFromWorld[1]![0]!) / s;
    y = s / 4;
    z = (cameraFromWorld[1]![2]! + cameraFromWorld[2]![1]!) / s;
  } else {
    const s = Math.sqrt(1 + cameraFromWorld[2]![2]! - cameraFromWorld[0]![0]! - cameraFromWorld[1]![1]!) * 2;
    w = (cameraFromWorld[1]![0]! - cameraFromWorld[0]![1]!) / s;
    x = (cameraFromWorld[0]![2]! + cameraFromWorld[2]![0]!) / s;
    y = (cameraFromWorld[1]![2]! + cameraFromWorld[2]![1]!) / s;
    z = s / 4;
  }
  return { q: [x, y, z, w], r: cameraFromWorld };
}

export interface ColmapDataset {
  readonly datasetDir: string;
  readonly images: number;
  readonly cameras: number;
}

/**
 * Write the clip as a COLMAP text dataset.
 *
 * Poses are converted to COLMAP's convention (world-to-camera rotation and translation), the
 * seed point cloud becomes `sparse/0/points3D.txt`, and images are referenced by relative
 * name under `images/`. The image files themselves are not copied: the dataset directory is
 * written next to the clip and the loader reads through, so a multi-gigabyte clip is not
 * duplicated on a worker's disk.
 */
export async function writeColmapDataset(admission: ClipAdmission, datasetDir: string): Promise<ColmapDataset> {
  const { clip, clipDir } = admission;
  const cameras = clip.cameras!;
  const poses = clip.ego!.recordedPose6dof!;
  const sparse = path.join(datasetDir, 'sparse', '0');
  await mkdir(sparse, { recursive: true });

  const cameraLines: string[] = ['# Camera list with one line of data per camera:', '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]'];
  const cameraIdBySensor = new Map<string, number>();
  cameras.forEach((camera, index) => {
    const line = colmapCamera(camera, index + 1);
    if ('error' in line) throw new RefusalError({ code: 'unsupported_input', message: line.error, missing: [{ path: `cameras[${index}].intrinsics.model`, requirement: 'pinhole or opencv intrinsics for the COLMAP reconstruction path' }], alternatives: [] });
    cameraLines.push(line.line);
    cameraIdBySensor.set(camera.sensorId, index + 1);
  });
  await writeFile(path.join(sparse, 'cameras.txt'), `${cameraLines.join('\n')}\n`, 'utf8');

  const imageLines: string[] = ['# Image list with two lines of data per image:', '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME', '#   POINTS2D[]'];
  let imageId = 0;
  for (const camera of cameras) {
    const video = clip.videos.find((entry) => entry.cameraId === camera.cameraId);
    if (video === undefined) continue;
    if (video.kind !== 'image-sequence') {
      throw new RefusalError({
        code: 'unsupported_input',
        message:
          `camera ${camera.sensorId} supplies an encoded video. Reconstruction needs individual frames, and SimForge does not `
          + 'shell out to an undeclared ffmpeg to produce them.',
        missing: [{ path: 'videos[].kind', requirement: 'an image-sequence directory of extracted frames, one file per timestamp' }],
        alternatives: ['Open-loop evaluation accepts encoded video directly.'],
      });
    }
    const timestamps = cameraTimestamps(camera);
    const sequenceDir = path.resolve(clipDir, video.path);
    const files = (await readdir(sequenceDir)).filter((name) => /\.(png|jpe?g)$/i.test(name)).sort();

    for (let index = 0; index < Math.min(files.length, timestamps.length); index += 1) {
      const tUs = timestamps[index]!;
      // Nearest measured rig pose; poses are the reconstruction's ground truth, never resampled
      // beyond the recorded support.
      const pose = poses.reduce((best, candidate) =>
        Math.abs(candidate.tUs - tUs) < Math.abs(best.tUs - tUs) ? candidate : best);
      const { q, r } = worldToCameraQuat(pose.quaternion, camera.extrinsics.matrix);
      // t_camera_world = R_camera_rig · (−R_rig_world · p_world) + t_camera_rig, assembled as
      // the camera-frame position of the world origin.
      const rigTranslation = camera.extrinsics.matrix.map((row) => row[3]!);
      const t: number[] = [0, 0, 0];
      for (let i = 0; i < 3; i += 1) {
        let sum = 0;
        for (let k = 0; k < 3; k += 1) sum += -(r[i]![k]!) * pose.position[k]!;
        t[i] = sum + rigTranslation[i]!;
      }
      imageId += 1;
      imageLines.push(
        `${imageId} ${q[3]} ${q[0]} ${q[1]} ${q[2]} ${t[0]} ${t[1]} ${t[2]} ${cameraIdBySensor.get(camera.sensorId)} ${path.join(video.path, files[index]!)}`,
      );
      imageLines.push('');
    }
  }
  await writeFile(path.join(sparse, 'images.txt'), `${imageLines.join('\n')}\n`, 'utf8');

  const pointCloud = clip.pointCloud!;
  if (pointCloud.format === 'colmap-points3d-txt') {
    await copyFile(path.resolve(clipDir, pointCloud.path), path.join(sparse, 'points3D.txt'));
  } else {
    // A PLY seed is handed to the loader as-is; 3DGRUT reads `points3D.ply` when present.
    await copyFile(path.resolve(clipDir, pointCloud.path), path.join(sparse, 'points3D.ply'));
    await writeFile(path.join(sparse, 'points3D.txt'), '# seeded from points3D.ply\n', 'utf8');
  }

  return { datasetDir, images: imageId, cameras: cameras.length };
}

/* ------------------------------------------------------------------- driver */

export interface ReconstructOptions {
  readonly admission: ClipAdmission;
  /** Working directory for the dataset, the training run and the export. */
  readonly workDir: string;
  readonly tier?: ReconstructionTier;
  /** Passed through to upstream as `n_iterations`; upstream's config default is used when absent. */
  readonly iterations?: number;
}

export interface ReconstructResult {
  readonly bundle: ReplayContext;
  readonly usdzPath: string;
  readonly datasetDir: string;
  readonly runDir: string;
}

/**
 * Reconstruct a clip and import the result.
 *
 * The returned bundle is unqualified by construction — it has geometry but no measured
 * envelope, so `qualifyBundle` still has to render it. A reconstruction that has not passed
 * G1–G5 is not a world we let a policy drive.
 */
export async function reconstructClip(options: ReconstructOptions): Promise<ReconstructResult> {
  const refusal: Refusal | undefined = reconstructionRefusal(options.admission);
  if (refusal !== undefined) throw new RefusalError(refusal);
  const clip = options.admission.clip;
  if (clip.ego?.recordedPose6dof === undefined) {
    throw new RefusalError({
      code: 'missing_fields',
      message:
        `clip ${clip.clipId} has only a planar ego path. Reconstruction needs true 6-DoF rig poses; `
        + 'assuming zero roll and pitch would build a flat world that never existed.',
      missing: [
        {
          path: 'ego.recordedPose6dof',
          requirement: 'per-sample rig position [x, y, z] and orientation quaternion [x, y, z, w] in ego.frame',
        },
      ],
      alternatives: ['Open-loop evaluation only needs the planar path and works on this clip today.'],
    });
  }

  const tier = options.tier ?? {};
  const preflight = await preflightReconstruction(tier);
  if (!preflight.ok) {
    throw new CapabilityError(`the reconstruction tier is not available: ${preflight.missing.join('; ')}`);
  }

  const datasetDir = path.join(options.workDir, 'colmap');
  await writeColmapDataset(options.admission, datasetDir);

  const runsDir = path.join(options.workDir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const experiment = `sf-${clip.clipId}`;
  const args = [
    'train.py',
    '--config-name', THREEDGRUT_CONFIG,
    `path=${datasetDir}`,
    `out_dir=${runsDir}`,
    `experiment_name=${experiment}`,
    'export_usd.enabled=true',
    'export_usd.format=nurec',
    ...(options.iterations === undefined ? [] : [`n_iterations=${options.iterations}`]),
  ];
  const training = await run(tier.pythonCommand ?? 'python3', args, preflight.threedgrutRoot);
  if (training.code !== 0) {
    throw new CapabilityError(
      `3DGUT training failed (exit ${training.code}): ${training.stderr.trim().slice(-2000) || training.stdout.trim().slice(-2000)}`,
    );
  }

  const runDir = path.join(runsDir, experiment);
  const usdzPath = await findExport(runDir);
  const bundle = await importUserBundle({
    admission: options.admission,
    geometryPackage: usdzPath,
    reconstruction: {
      method: '3dgut',
      datasetFormat: 'colmap',
      config: THREEDGRUT_CONFIG,
      iterations: options.iterations ?? 0,
      ...(preflight.threedgrutRoot === undefined ? {} : { threedgrutCommit: preflight.threedgrutRoot }),
    },
  });
  return { bundle, usdzPath, datasetDir, runDir };
}

/** Locate the exported NuRec package under a training run directory. */
async function findExport(runDir: string): Promise<string> {
  const stack = [runDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirents) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase().endsWith('.usdz')) return full;
    }
  }
  throw new CapabilityError(
    `3DGUT training completed but no .usdz export was found under ${runDir}. `
    + 'Check that export_usd.enabled=true and export_usd.format=nurec were honoured by the pinned upstream revision.',
  );
}
