/**
 * Direct NuRec package importer: a `.usdz` scene artifact becomes a
 * `simforge.replay-context/v1` bundle with no intermediate sidecar directory.
 *
 * Everything needed is a plain member of the archive, so this path needs neither CUDA nor
 * the renderer:
 *
 *   `rig_trajectories.json`  `camera_calibrations` (f-theta parameters + `T_sensor_rig`) and
 *                            `rig_trajectories[0]` (`T_rig_worlds`, `T_rig_world_timestamps_us`)
 *   `sequence_tracks.json`   `tracks_data` (ids, classes, timestamps, poses) + `cuboids_dims`
 *   `frames/<sensor>/<us>.jpeg`  the recorded frames, which are also the capture timestamps
 *
 * These are the same members the splat backend reads
 * (`renderer/splat/python/simforge_splat/providers/nurec.py`), so a bundle and the renders
 * measured against it agree about calibration and motion by construction rather than by a
 * re-derivation that can drift.
 *
 * Calibration is carried, never reconstructed. If a camera's f-theta polynomial cannot be
 * located under any of the spellings these packages use, that camera is dropped with the
 * keys that *were* present listed in the reason — it is not replaced with a pinhole guess.
 */

import { stat } from 'node:fs/promises';

import { cameraIndex } from '../cameras.js';
import { measureDynamicsConsistency, measureEgoHistoryParity } from '../envelope.js';
import { DEFAULT_GATE_THRESHOLDS, gateG3, gateG4, type GateThresholds } from '../gates.js';
import { sha256File } from '../digest.js';
import { RefusalError, type MissingField } from '../refusal.js';
import {
  REPLAY_CONTEXT_SCHEMA,
  ReplayContextSchema,
  type CalibratedCamera,
  type EgoPose,
  type GateId,
  type GateVerdict,
  type Intrinsics,
  type ReplayContext,
  type Track,
} from '../schema.js';
import { readZipIndex, readZipJson, recordedFrames } from '../usdz.js';
import { RawRigTrajectoriesSchema, RawSequenceTracksSchema } from './raw-schema.js';

export const PACKAGE_IMPORTER = { name: 'simforge.replay-context.nurec-package-importer', version: '1' } as const;

export interface PackageImportOptions {
  /** Path to the `.usdz` scene artifact. */
  readonly packagePath: string;
  /** Stable scene id; defaults to the package file stem. */
  readonly sceneId?: string;
  /** Where this artifact came from (dataset revision, AlpaSim suite, ...). */
  readonly origin?: string;
  readonly license: string;
  readonly redistributable?: boolean;
  /** Expected package digest. When given it is enforced; when absent it is computed and recorded. */
  readonly expectedSha256?: string;
  readonly source?: ReplayContext['source']['kind'];
  readonly thresholds?: GateThresholds;
}

const CLASS_BY_SOURCE: Record<string, Track['class']> = {
  car: 'car',
  automobile: 'car',
  van: 'car',
  vehicle: 'car',
  truck: 'truck',
  heavy_truck: 'truck',
  trailer: 'truck',
  bus: 'bus',
  motorcycle: 'motorcycle',
  scooter: 'motorcycle',
  bicycle: 'bicycle',
  cyclist: 'bicycle',
  pedestrian: 'pedestrian',
  person: 'pedestrian',
  static_object: 'static-object',
};

function firstArray(source: Record<string, unknown>, keys: readonly string[]): number[] | undefined {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value) && value.length >= 2 && value.every((entry) => typeof entry === 'number')) {
      return value as number[];
    }
    // Some packages carry the polynomial as a whitespace-separated string of coefficients.
    if (typeof value === 'string') {
      const parsed = value.trim().split(/\s+/).map(Number);
      if (parsed.length >= 2 && parsed.every((entry) => Number.isFinite(entry))) return parsed;
    }
  }
  return undefined;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

/**
 * Pull f-theta intrinsics out of an ncore camera-parameter block.
 *
 * Three spellings are accepted because all three occur across the releases we consume:
 * ncore snake_case, the camelCase our own rig files use, and the flat `properties` form the
 * dataset calibration estimate ships (`polynomial`, `polynomial-type`, `cx`, `cy`).
 */
function fthetaIntrinsics(params: Record<string, unknown>): { intrinsics: Intrinsics; width: number; height: number } | { error: string } {
  const resolution = params['resolution'];
  const width =
    firstNumber(params, ['width'])
    ?? (Array.isArray(resolution) && typeof resolution[0] === 'number' ? resolution[0] : undefined);
  const height =
    firstNumber(params, ['height'])
    ?? (Array.isArray(resolution) && typeof resolution[1] === 'number' ? resolution[1] : undefined);
  const principal = params['principal_point'] ?? params['principalPoint'];
  const cx = firstNumber(params, ['cx']) ?? (Array.isArray(principal) && typeof principal[0] === 'number' ? principal[0] : undefined);
  const cy = firstNumber(params, ['cy']) ?? (Array.isArray(principal) && typeof principal[1] === 'number' ? principal[1] : undefined);

  let pixeldistToAngle = firstArray(params, ['pixeldist_to_angle_poly', 'pixeldistToAnglePoly', 'pixeldist-to-angle-poly']);
  let angleToPixeldist = firstArray(params, ['angle_to_pixeldist_poly', 'angleToPixeldistPoly', 'angle-to-pixeldist-poly']);
  const polynomialType = params['polynomial-type'] ?? params['polynomial_type'];
  const polynomial = firstArray(params, ['polynomial']);
  if (polynomial !== undefined) {
    if (polynomialType === 'pixeldistance-to-angle') pixeldistToAngle ??= polynomial;
    if (polynomialType === 'angle-to-pixeldistance') angleToPixeldist ??= polynomial;
  }
  const maxAngleRad = firstNumber(params, ['max_angle', 'maxAngleRad', 'max_angle_rad']);

  if (width === undefined || height === undefined || cx === undefined || cy === undefined) {
    return { error: `incomplete image geometry (keys present: ${Object.keys(params).sort().join(', ')})` };
  }
  if (pixeldistToAngle === undefined || angleToPixeldist === undefined) {
    return {
      error:
        'f-theta polynomials not found under any known spelling '
        + `(keys present: ${Object.keys(params).sort().join(', ')}); the calibration is not being guessed`,
    };
  }
  const linear = firstArray(params, ['linear_cde', 'linearCde']);
  return {
    width: Math.round(width),
    height: Math.round(height),
    intrinsics: {
      model: 'ftheta',
      cx,
      cy,
      pixeldistToAnglePoly: pixeldistToAngle,
      angleToPixeldistPoly: angleToPixeldist,
      // A missing max angle falls back to the widest half-angle the image can subtend, which is
      // a property of the polynomial's domain, not an invented calibration value.
      maxAngleRad: maxAngleRad ?? Math.PI / 2,
      ...(linear !== undefined && linear.length === 3 ? { linearCde: [linear[0]!, linear[1]!, linear[2]!] as [number, number, number] } : {}),
    },
  };
}

/** Yaw about +z from a rotation matrix or an (x, y, z, w) quaternion. */
function yawFromMatrix(matrix: readonly (readonly number[])[]): number {
  return Math.atan2(matrix[1]![0]!, matrix[0]![0]!);
}

function yawFromQuat(x: number, y: number, z: number, w: number): number {
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}


/**
 * Import a NuRec `.usdz` scene artifact.
 *
 * The result is deliberately unqualified: geometry fidelity (G1/G2) needs renders and stock
 * replay (G5) needs an episode, so the envelope is zero-width until `qualifyBundle` measures
 * one. G3/G4 are computed here because they are pure trajectory algebra.
 */
export async function importNurecPackage(options: PackageImportOptions): Promise<ReplayContext> {
  const { packagePath } = options;
  let bytes = 0;
  try {
    const info = await stat(packagePath);
    if (!info.isFile()) throw new Error('not a file');
    bytes = info.size;
  } catch {
    throw new RefusalError({
      code: 'missing_fields',
      message: `NuRec package ${packagePath} is not reachable`,
      missing: [{ path: 'packagePath', requirement: 'an existing .usdz scene artifact' }],
      alternatives: [],
    });
  }

  const digest = await sha256File(packagePath);
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== digest) {
    throw new RefusalError({
      code: 'integrity_failed',
      message: `package identity mismatch for ${packagePath}`,
      missing: [{ path: packagePath, requirement: `sha256 ${options.expectedSha256}, found ${digest}` }],
      alternatives: [],
    });
  }

  const entries = await readZipIndex(packagePath);
  const missing: MissingField[] = [];
  const rigRaw = await readZipJson(packagePath, entries, 'rig_trajectories.json');
  const tracksRaw = await readZipJson(packagePath, entries, 'sequence_tracks.json');
  const rigParsed = rigRaw === undefined ? undefined : RawRigTrajectoriesSchema.safeParse(rigRaw);
  const tracksParsed = tracksRaw === undefined ? undefined : RawSequenceTracksSchema.safeParse(tracksRaw);
  const rig = rigParsed?.success === true ? rigParsed.data : undefined;
  const tracksDoc = tracksParsed?.success === true ? tracksParsed.data : undefined;
  if (rig === undefined) {
    missing.push({
      path: 'rig_trajectories.json',
      requirement: rigParsed?.success === false
        ? rigParsed.error.issues.map((issue) => issue.message).join('; ')
        : 'camera calibrations and the recorded rig trajectory',
    });
  }
  if (tracksDoc === undefined) {
    missing.push({
      path: 'sequence_tracks.json',
      requirement: tracksParsed?.success === false
        ? tracksParsed.error.issues.map((issue) => issue.message).join('; ')
        : 'recorded dynamic-actor tracks',
    });
  }
  if (rig === undefined || tracksDoc === undefined) {
    throw new RefusalError({
      code: 'missing_fields',
      message: `${packagePath} is not a NuRec scene package`,
      missing,
      alternatives: [],
    });
  }

  /* --------------------------------------------------------------- cameras */

  const frames = recordedFrames(entries);
  const framesBySensor = new Map(frames.map((entry) => [entry.sensorId, entry]));
  const cameras: CalibratedCamera[] = [];
  const droppedCameras: { sensorId: string; reason: string }[] = [];
  for (const calibration of Object.values(rig.camera_calibrations ?? {})) {
    const sensorId = String(calibration.logical_sensor_name ?? '');
    const id = cameraIndex(sensorId);
    if (id === undefined) {
      droppedCameras.push({ sensorId, reason: 'not an Alpamayo camera name; the inference wire has no index for it' });
      continue;
    }
    const model = calibration.camera_model;
    if (model?.type !== 'ftheta') {
      droppedCameras.push({ sensorId, reason: `unsupported camera model "${String(model?.type)}"` });
      continue;
    }
    const parameters = model.parameters ?? {};
    const extracted = fthetaIntrinsics(parameters);
    if ('error' in extracted) {
      droppedCameras.push({ sensorId, reason: extracted.error });
      continue;
    }
    const transform = calibration.T_sensor_rig;
    if (transform === undefined || transform.length < 3 || transform[0] === undefined || transform[0].length < 4) {
      droppedCameras.push({ sensorId, reason: 'T_sensor_rig is not a row-major 3x4/4x4 transform' });
      continue;
    }
    const recorded = framesBySensor.get(sensorId);
    if (recorded === undefined || recorded.timestampsUs.length === 0) {
      droppedCameras.push({ sensorId, reason: 'the package contains no recorded frames for this sensor' });
      continue;
    }
    const rows = transform;
    cameras.push({
      cameraId: id,
      sensorId,
      width: extracted.width,
      height: extracted.height,
      intrinsics: extracted.intrinsics,
      extrinsics: {
        matrix: [
          [rows[0]![0]!, rows[0]![1]!, rows[0]![2]!, rows[0]![3]!],
          [rows[1]![0]!, rows[1]![1]!, rows[1]![2]!, rows[1]![3]!],
          [rows[2]![0]!, rows[2]![1]!, rows[2]![2]!, rows[2]![3]!],
        ],
      },
      timing: {
        // These releases publish a reference frame per camera, not the recorded sequence, so
        // the instants are labelled for what they are rather than passed off as a timeline.
        kind: 'reference-frames',
        timestampsUs: [...recorded.timestampsUs],
        shutterUs: Math.round(firstNumber(parameters, ['shutter_duration_us']) ?? 30_000),
      },
    });
  }
  if (cameras.length === 0) {
    throw new RefusalError({
      code: 'missing_fields',
      message: `${packagePath} has no usable calibrated cameras`,
      missing: droppedCameras.map((entry) => ({ path: `camera_calibrations#${entry.sensorId}`, requirement: entry.reason })),
      alternatives: [],
    });
  }
  cameras.sort((a, b) => a.cameraId - b.cameraId);

  /* ------------------------------------------------------------------- ego */

  const trajectory = (rig.rig_trajectories ?? [])[0];
  const poses = trajectory?.T_rig_worlds;
  const times = trajectory?.T_rig_world_timestamps_us;
  if (poses === undefined || times === undefined || poses.length < 2 || times.length !== poses.length) {
    throw new RefusalError({
      code: 'missing_fields',
      message: `${packagePath} has no usable recorded rig trajectory`,
      missing: [{ path: 'rig_trajectories[0]', requirement: 'T_rig_worlds with matching T_rig_world_timestamps_us (>= 2 samples)' }],
      alternatives: [],
    });
  }
  const recordedPath: EgoPose[] = [];
  for (let i = 0; i < poses.length; i += 1) {
    const matrix = poses[i]!;
    const tUs = Math.round(times[i]!);
    const previous = recordedPath[recordedPath.length - 1];
    if (previous !== undefined && tUs <= previous.tUs) continue;
    recordedPath.push({ tUs, x: matrix[0]![3]!, y: matrix[1]![3]!, headingRad: yawFromMatrix(matrix) });
  }
  // Speed is differentiated from the recorded poses rather than declared: the package does
  // not ship a speed channel, and a made-up constant would silently enter the ego history.
  const speedMps = recordedPath.map((pose, index) => {
    const a = recordedPath[Math.max(0, index - 1)]!;
    const b = recordedPath[Math.min(recordedPath.length - 1, index + 1)]!;
    const dt = (b.tUs - a.tUs) / 1e6;
    return dt <= 0 ? 0 : Math.hypot(b.x - a.x, b.y - a.y) / dt;
  });

  /* -------------------------------------------------------------- dynamics */

  const sequenceKeys = Object.keys(tracksDoc);
  const sequence = sequenceKeys.length > 0 ? tracksDoc[sequenceKeys[0]!] : undefined;
  const data = sequence?.tracks_data;
  const dims = sequence?.cuboidtracks_data?.cuboids_dims ?? [];
  const ids = data?.tracks_id ?? [];
  const classes = data?.tracks_label_class ?? [];
  const stamps = data?.tracks_timestamps_us ?? [];
  const trackPoses = data?.tracks_poses ?? [];

  const tracks: Track[] = [];
  const excluded: { trackId: string; reason: string }[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const trackId = String(ids[index]);
    const samplesTimes = stamps[index] ?? [];
    const samplePoses = trackPoses[index] ?? [];
    if (samplesTimes.length === 0 || samplePoses.length === 0) {
      excluded.push({ trackId, reason: 'track has no recorded samples' });
      continue;
    }
    const dimension = dims[index];
    if (dimension === undefined || dimension.length < 3 || !(dimension[0]! > 0 && dimension[1]! > 0 && dimension[2]! > 0)) {
      excluded.push({ trackId, reason: 'track has no positive cuboid dimensions' });
      continue;
    }
    const sourceClass = String(classes[index] ?? 'unknown');
    const samples = samplePoses
      .map((pose, sampleIndex) => ({
        tUs: Math.round(samplesTimes[sampleIndex] ?? 0),
        x: pose[0]!,
        y: pose[1]!,
        headingRad: yawFromQuat(pose[3]!, pose[4]!, pose[5]!, pose[6]!),
      }))
      .filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y))
      .sort((a, b) => a.tUs - b.tUs);
    if (samples.length === 0) {
      excluded.push({ trackId, reason: 'track samples are not finite' });
      continue;
    }
    tracks.push({
      trackId,
      sourceClass,
      class: CLASS_BY_SOURCE[sourceClass] ?? 'unknown',
      // ncore cuboid dims are (length, width, height) in the track frame.
      dims: { l: dimension[0]!, w: dimension[1]!, h: dimension[2]! },
      samples,
    });
  }

  /* ---------------------------------------------------------------- bundle */

  const sceneId = options.sceneId ?? packagePath.replace(/^.*\//, '').replace(/\.usdz$/i, '');
  const draft: ReplayContext = {
    schema: REPLAY_CONTEXT_SCHEMA,
    sceneId,
    source: {
      kind: options.source ?? 'nurec',
      sceneId,
      origin: options.origin ?? packagePath,
      license: options.license,
      redistributable: options.redistributable ?? false,
      inputs: [{ path: packagePath, sha256: digest, bytes }],
      importer: { ...PACKAGE_IMPORTER },
    },
    cameras,
    ego: {
      frame: 'nurec-source-z-up',
      originUs: recordedPath[0]!.tUs,
      endUs: recordedPath[recordedPath.length - 1]!.tUs,
      recordedPath,
      speedMps,
      source: 'dataset',
    },
    dynamics: { agentMode: 'replay', tracks, excluded },
    geometry: {
      kind: 'nurec-usdz',
      sourcePackage: packagePath,
      sourcePackageSha256: digest,
      // The recorded rig trajectory is the extent the reconstruction was built over.
      timeSupportUs: { startUs: recordedPath[0]!.tUs, endUs: recordedPath[recordedPath.length - 1]!.tUs },
      renderer: 'nurec-splat-renderer',
    },
    // The package carries no lane graph; route context is whatever the scene itself implies
    // until a map bundle is bound to it, and that is recorded as low confidence.
    map: { source: 'derived-from-reconstruction', confidence: 'low' },
    validity: {
      qualified: false,
      // No profile has been measured yet; qualification is always for a camera set.
      profileCameraIds: [],
      envelope: { lateralM: 0, longitudinalS: 0, headingRad: 0 },
      gates: {},
      envelopeBasis: { offsetsTestedM: [], headingsTestedRad: [], largestPassingLateralM: 0, largestPassingHeadingRad: 0 },
    },
  };

  const thresholds = options.thresholds ?? DEFAULT_GATE_THRESHOLDS;
  const gates: Partial<Record<GateId, GateVerdict>> = {
    G3: gateG3(measureEgoHistoryParity(draft), thresholds),
    G4: gateG4(measureDynamicsConsistency(draft), thresholds),
  };
  return ReplayContextSchema.parse({ ...draft, validity: { ...draft.validity, gates } });
}
