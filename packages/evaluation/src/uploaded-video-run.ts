import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { endpointInvoke, type EndpointHealth, type EndpointTarget, type InvokeSuccess } from './protocol/endpoint-client.js';
import { describeArtifact, type EvalArtifact, type ResultStatus } from './protocol/manifest.js';
import { OPENLOOP_RESULT_SCHEMA, buildAggregate, type OpenloopItem, type OpenloopResult, type UploadedVideoProvenance } from './protocol/openloop.js';
import type { OpenloopParams, UploadedVideo } from './protocol/params.js';
import { resolveEncoder } from './replay-context/video.js';
import { sha256File } from './replay-context/digest.js';
import { deferred } from './replay-context/deferred.js';

const WINDOW_OFFSETS_S = [-0.3, -0.2, -0.1, 0] as const;
const INFERENCE_WIDTH = 512;
const INFERENCE_HEIGHT = 384;
/** Canonical dataset-view yaw in FLU degrees (positive left), used only for the assumed overlay calibration. */
const CAMERA_YAW_DEG: Readonly<Record<number, number>> = {
  0: 55,
  1: 0,
  2: -55,
  3: 125,
  4: 180,
  5: -125,
  6: 0,
};
const FRAME_TARGET_TOLERANCE_S = 0.105;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  options: { stdout?: boolean; stdin?: 'ignore' | 'pipe' } = {},
): Promise<CommandResult> {
  const { promise, resolve, reject } = deferred<CommandResult>();
  if (signal.aborted) {
    reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'));
    return promise;
  }
  const child = spawn(command, [...args], {
    stdio: [options.stdin ?? 'ignore', options.stdout === false ? 'ignore' : 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const abort = () => child.kill('SIGTERM');
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', reject);
  child.once('close', (code, killedBy) => {
    signal.removeEventListener('abort', abort);
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'));
    } else if (code !== 0) {
      reject(new Error(`${path.basename(command)} exited ${code ?? killedBy}: ${Buffer.concat(stderr).toString('utf8').slice(-4_000)}`));
    } else {
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    }
  });
  return promise;
}

interface VideoProbe {
  readonly width: number;
  readonly height: number;
  readonly encodedWidth: number;
  readonly encodedHeight: number;
  readonly rotationDegrees: number;
  readonly durationS: number;
  readonly containerStartPtsS: number;
  readonly frameTimesS: readonly number[];
}

async function probeVideo(ffprobe: string, source: string, signal: AbortSignal): Promise<VideoProbe> {
  const result = await runProcess(
    ffprobe,
    [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,duration:stream_tags=rotate:stream_side_data=rotation:'
      + 'format=duration:frame=best_effort_timestamp_time,pkt_pts_time',
      '-of', 'json', source,
    ],
    signal,
  );
  const document = JSON.parse(result.stdout) as {
    streams?: {
      width?: number;
      height?: number;
      duration?: string;
      tags?: { rotate?: string };
      side_data_list?: { rotation?: number }[];
    }[];
    format?: { duration?: string };
    frames?: { best_effort_timestamp_time?: string; pkt_pts_time?: string }[];
  };
  const stream = document.streams?.[0];
  const rawTimes = (document.frames ?? [])
    .map((frame) => Number(frame.best_effort_timestamp_time ?? frame.pkt_pts_time))
    .filter(Number.isFinite);
  if (!stream?.width || !stream.height || rawTimes.length < 4) {
    throw new Error(`${source} has no usable video stream or fewer than four timestamped frames`);
  }
  const first = rawTimes[0]!;
  const frameTimesS = rawTimes.map((timestamp) => timestamp - first);
  for (let index = 1; index < frameTimesS.length; index += 1) {
    if (frameTimesS[index]! <= frameTimesS[index - 1]!) {
      throw new Error(`${source} has non-increasing presentation timestamps at decoded frame ${index}`);
    }
  }
  const declaredDuration = Number(stream.duration ?? document.format?.duration);
  const rawRotation = Number(stream.side_data_list?.find((entry) => Number.isFinite(entry.rotation))?.rotation ?? stream.tags?.rotate ?? 0);
  if (!Number.isFinite(rawRotation) || Math.abs(rawRotation / 90 - Math.round(rawRotation / 90)) > 1e-6) {
    throw new Error('uploaded video rotation must be a multiple of 90 degrees');
  }
  const rotationDegrees = ((Math.round(rawRotation / 90) * 90) % 360 + 360) % 360;
  const swapsAxes = rotationDegrees === 90 || rotationDegrees === 270;
  return {
    width: swapsAxes ? stream.height : stream.width,
    height: swapsAxes ? stream.width : stream.height,
    encodedWidth: stream.width,
    encodedHeight: stream.height,
    rotationDegrees,
    durationS: Number.isFinite(declaredDuration) ? declaredDuration : frameTimesS.at(-1)!,
    containerStartPtsS: first,
    frameTimesS,
  };
}

interface PreparedCamera {
  readonly cameraId: number;
  readonly inputIndex: number;
  readonly offsetSeconds: number;
  readonly source: string;
  readonly probe: VideoProbe;
  readonly sha256: string;
  readonly framePathByIndex: ReadonlyMap<number, string>;
}

function selectFrameIndex(frameTimesS: readonly number[], targetS: number): number {
  let low = 0;
  let high = frameTimesS.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frameTimesS[middle]! <= targetS + 1e-9) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  if (index < 0 || targetS - frameTimesS[index]! > FRAME_TARGET_TOLERANCE_S) {
    throw new Error(`no decoded frame at or before requested source timestamp ${targetS.toFixed(6)}s within ${FRAME_TARGET_TOLERANCE_S}s`);
  }
  return index;
}

async function extractFrames(
  ffmpeg: string,
  camera: Omit<PreparedCamera, 'framePathByIndex'>,
  inferenceTimesS: readonly number[],
  directory: string,
  signal: AbortSignal,
): Promise<PreparedCamera> {
  const windows = inferenceTimesS.map((commonTime) => {
    const sourceT0 = commonTime - camera.offsetSeconds;
    const selected = WINDOW_OFFSETS_S.map((offset) => selectFrameIndex(camera.probe.frameTimesS, sourceT0 + offset));
    if (new Set(selected).size !== WINDOW_OFFSETS_S.length) {
      throw new Error(
        `camera ${camera.cameraId} cannot supply four distinct decoded frames for 10 Hz window ending at ${sourceT0.toFixed(6)}s`,
      );
    }
    return selected;
  });
  const indices = [...new Set(windows.flat())].sort((left, right) => left - right);
  const cameraDir = path.join(directory, `camera-${camera.cameraId}`);
  await mkdir(cameraDir, { recursive: true });
  const expression = indices.map((index) => `eq(n\\,${index})`).join('+');
  const normalize = `scale=${INFERENCE_WIDTH}:${INFERENCE_HEIGHT}:force_original_aspect_ratio=decrease,`
    + `pad=${INFERENCE_WIDTH}:${INFERENCE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  await runProcess(
    ffmpeg,
    ['-v', 'error', '-y', '-i', camera.source, '-vf', `select=${expression},${normalize}`, '-vsync', '0', path.join(cameraDir, '%08d.png')],
    signal,
    { stdout: false },
  );
  const framePathByIndex = new Map<number, string>();
  indices.forEach((frameIndex, outputIndex) => {
    const framePath = path.join(cameraDir, `${String(outputIndex + 1).padStart(8, '0')}.png`);
    if (!existsSync(framePath)) throw new Error(`ffmpeg did not decode selected frame ${frameIndex} for camera ${camera.cameraId}`);
    framePathByIndex.set(frameIndex, framePath);
  });
  return { ...camera, framePathByIndex };
}

function assumedProjection(video: UploadedVideo, camera: PreparedCamera): NonNullable<OpenloopItem['projection']> {
  const focal = camera.probe.width / (2 * Math.tan((video.horizontalFovDeg * Math.PI) / 360));
  const yaw = CAMERA_YAW_DEG[camera.cameraId]! * Math.PI / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    cameraId: camera.cameraId,
    K: [[focal, 0, camera.probe.width / 2], [0, focal, camera.probe.height / 2], [0, 0, 1]],
    distortion: { model: 'pinhole-assumed', coeffs: [] },
    extrinsicsRigFromCamera: [
      [s, 0, c, 0],
      [-c, 0, s, 0],
      [0, -1, 0, video.cameraHeightM],
      [0, 0, 0, 1],
    ],
    imageSize: [camera.probe.width, camera.probe.height],
    timestampsUs: [],
  };
}

function constantSpeedHistory(speedMps: number): { xyz: number[][]; rotations: number[][][]; times: number[] } {
  const times = Array.from({ length: 16 }, (_, index) => (index - 15) * 0.1);
  return {
    xyz: times.map((time) => [speedMps * time, 0, 0]),
    rotations: times.map(() => [[1, 0, 0], [0, 1, 0], [0, 0, 1]]),
    times,
  };
}

export interface UploadedVideoRunOptions {
  readonly runId: string;
  readonly attemptId: string | null;
  readonly params: OpenloopParams;
  readonly target: EndpointTarget;
  readonly health: EndpointHealth;
  readonly outDir: string;
  readonly resolveInput: (item: OpenloopParams['items'][number], index: number) => string;
  readonly signal: AbortSignal;
  readonly maxPredictionCount: number;
  readonly maxVideoSeconds: number;
  readonly fallbackModel?: {
    readonly family?: string | null;
    readonly revision?: string | null;
    readonly quant?: string | null;
    readonly checkpointDigest?: string | null;
  };
}

export interface UploadedVideoRunOutcome {
  readonly status: ResultStatus;
  readonly scored: false;
  readonly exploratory: true;
  readonly result: OpenloopResult;
  readonly metrics: Record<string, unknown>;
  readonly artifacts: EvalArtifact[];
  readonly model: Record<string, unknown>;
  readonly inputKind: string;
  readonly inputDigest: string;
}

export async function executeUploadedVideoOpenloop(options: UploadedVideoRunOptions): Promise<UploadedVideoRunOutcome> {
  const video = options.params.video;
  if (!video) throw new Error('executeUploadedVideoOpenloop requires params.video');
  const encoder = await resolveEncoder();
  if (!encoder) throw new Error('uploaded-video execution requires FFmpeg/ffprobe via SIMFORGE_FFMPEG and SIMFORGE_FFPROBE or PATH');
  await mkdir(options.outDir, { recursive: true });
  const workDir = path.join(options.outDir, '.uploaded-video-frames');
  await mkdir(workDir, { recursive: true });

  const sourceByInput = new Map<number, string>();
  for (const camera of video.cameras) {
    sourceByInput.set(camera.inputIndex, options.resolveInput(options.params.items[camera.inputIndex]!, camera.inputIndex));
  }
  const bareCameras = await Promise.all(video.cameras.map(async (camera) => {
    const source = sourceByInput.get(camera.inputIndex)!;
    const [probe, sha256] = await Promise.all([probeVideo(encoder.ffprobe, source, options.signal), sha256File(source)]);
    return { ...camera, source, probe, sha256 };
  }));
  const overlong = bareCameras.find((camera) => camera.probe.durationS > options.maxVideoSeconds + 1e-9);
  if (overlong) {
    throw new Error(
      `uploaded camera ${overlong.cameraId} is ${overlong.probe.durationS.toFixed(3)}s, `
      + `limit is ${options.maxVideoSeconds}s; videos are rejected rather than truncated`,
    );
  }
  const commonStartS = Math.max(0, ...bareCameras.map((camera) => camera.offsetSeconds)) + 0.3;
  const commonEndS = Math.min(...bareCameras.map((camera) => camera.offsetSeconds + camera.probe.frameTimesS.at(-1)!));
  const commonDurationS = commonEndS - commonStartS;
  if (!(commonDurationS >= 0)) throw new Error('uploaded camera videos do not share a synchronized interval long enough for a four-frame window');
  if (commonDurationS > options.maxVideoSeconds + 1e-9) {
    throw new Error(`common uploaded-video inference interval is ${commonDurationS.toFixed(3)}s, limit is ${options.maxVideoSeconds}s`);
  }
  const inferenceTimesS: number[] = [];
  const periodS = 1 / video.predictionHz;
  for (let timestamp = commonStartS; timestamp <= commonEndS + 1e-9; timestamp = commonStartS + inferenceTimesS.length * periodS) {
    inferenceTimesS.push(timestamp);
  }
  if (inferenceTimesS.length > options.maxPredictionCount) {
    throw new Error(`uploaded-video schedule has ${inferenceTimesS.length} predictions, limit is ${options.maxPredictionCount}`);
  }
  const cameras = await Promise.all(
    bareCameras.map((camera) => extractFrames(encoder.ffmpeg, camera, inferenceTimesS, workDir, options.signal)),
  );
  const primary = cameras.find((camera) => camera.cameraId === video.primaryCameraId)!;
  const projection = {
    ...assumedProjection(video, primary),
    timestampsUs: inferenceTimesS.map((commonTime) => {
      const frameIndex = selectFrameIndex(primary.probe.frameTimesS, commonTime - primary.offsetSeconds);
      return Math.round((primary.probe.frameTimesS[frameIndex]! + primary.offsetSeconds) * 1_000_000);
    }),
  };
  const history = constantSpeedHistory(video.egoSpeedMps);
  const items: OpenloopItem[] = [];
  let aggregateRng: Record<string, unknown> | null = null;

  for (let index = 0; index < inferenceTimesS.length; index += 1) {
    if (options.signal.aborted) break;
    const commonTimeS = inferenceTimesS[index]!;
    const invokeCameras = cameras
      .slice()
      .sort((left, right) => left.cameraId - right.cameraId)
      .map((camera) => {
        const sourceT0 = commonTimeS - camera.offsetSeconds;
        const selected = WINDOW_OFFSETS_S.map((offset) => selectFrameIndex(camera.probe.frameTimesS, sourceT0 + offset));
        return {
          camera_id: camera.cameraId,
          frames_paths: selected.map((frameIndex) => camera.framePathByIndex.get(frameIndex)!),
          encoding: 'png' as const,
          width: INFERENCE_WIDTH,
          height: INFERENCE_HEIGHT,
        };
      });
    const startedAt = Date.now();
    const response = await endpointInvoke(options.target, {
      runId: options.runId,
      attemptId: options.attemptId,
      index,
      seed: options.params.seed,
      task: 'act',
      obs: {
        cameras: invokeCameras,
        ego_history_xyz: history.xyz,
        ego_history_rot: history.rotations,
        ego_history_t_s: history.times,
        exploratory_video: true,
        ...(options.params.sampling.navText ? { nav_text: options.params.sampling.navText } : {}),
      },
      params: {
        num_traj_samples: options.params.sampling.numTrajSamples,
        top_p: options.params.sampling.topP,
        temperature: options.params.sampling.temperature,
        diffusion_steps: options.params.sampling.diffusionSteps,
        nav_text: options.params.sampling.navText,
      },
    }, options.signal);
    const input = { ...options.params.items[primary.inputIndex]!, t0Us: Math.round(commonTimeS * 1_000_000) };
    if (!response.ok) {
      items.push({
        index,
        itemId: `video:${input.t0Us}`,
        status: 'refused',
        input,
        frame: 'ego@t0', convention: 'FLU', dtS: 0.1, horizonS: 6.4,
        points: [], rotations: null, reasoning: [], text: null, fields: null,
        reference: { kind: 'none', frame: 'ego@t0', convention: 'FLU', dtS: 0.1, points: [] },
        projection, metrics: null, latencyMs: Date.now() - startedAt,
        refusal: {
          code: response.error.code === 'camera_set_violation' || response.error.code === 'camera_set_invalid' ? 'camera_set_invalid' : 'input_error',
          message: response.error.message,
          missingFields: [...(response.error.fields ?? [])],
          requiredCameras: response.error.required_cameras ? [...response.error.required_cameras] : null,
        },
        error: null, coldStart: false, rngProvenance: null,
      });
      continue;
    }
    const result: InvokeSuccess['result'] = response.result;
    const samples = (result.trajectories ?? []) as number[][][];
    aggregateRng ??= (result.rng_provenance ?? null) as Record<string, unknown> | null;
    const dtS = result.dt_s ?? 0.1;
    items.push({
      index,
      itemId: `video:${input.t0Us}`,
      status: 'ok',
      input,
      frame: result.frame ?? 'ego@t0', convention: 'FLU', dtS,
      horizonS: result.horizon_s ?? dtS * (samples[0]?.length ?? 0),
      points: samples,
      rotations: (result.rotations ?? result.trajectory_rot ?? null) as number[][][][] | null,
      reasoning: [...(result.reasoning ?? [])], text: result.text ?? null, fields: result.fields ?? null,
      reference: { kind: 'none', frame: 'ego@t0', convention: 'FLU', dtS: 0.1, points: [] },
      projection, metrics: null, latencyMs: Date.now() - startedAt,
      refusal: null, error: null, coldStart: false,
      rngProvenance: (result.rng_provenance ?? null) as Record<string, unknown> | null,
    });
  }

  const model = {
    family: options.health.family ?? options.fallbackModel?.family ?? null,
    revision: options.health.revision ?? options.fallbackModel?.revision ?? null,
    quant: options.health.quant ?? options.fallbackModel?.quant ?? null,
    quantStatus: options.health.quant_status ?? null,
    checkpointDigest: options.health.checkpoint_digest ?? options.fallbackModel?.checkpointDigest ?? null,
    cameraProfile: 'uploaded-video',
    attn: options.health.attn ?? null,
    torch: options.health.torch ?? null,
    cuda: options.health.cuda ?? null,
    numTrajSamples: options.params.sampling.numTrajSamples,
    diffusionSteps: options.params.sampling.diffusionSteps,
    rngProvenance: aggregateRng,
  };
  const videoProvenance: UploadedVideoProvenance = {
    mode: 'uploaded-video',
    sources: cameras.map((camera) => ({
      cameraId: camera.cameraId,
      inputIndex: camera.inputIndex,
      offsetSeconds: camera.offsetSeconds,
      width: camera.probe.width,
      height: camera.probe.height,
      encodedWidth: camera.probe.encodedWidth,
      encodedHeight: camera.probe.encodedHeight,
      rotationDegrees: camera.probe.rotationDegrees,
      durationSeconds: camera.probe.durationS,
      firstTimestampSeconds: camera.probe.frameTimesS[0]!,
      lastTimestampSeconds: camera.probe.frameTimesS.at(-1)!,
      containerStartPtsSeconds: camera.probe.containerStartPtsS,
      sha256: camera.sha256,
      inferenceWindows: inferenceTimesS.map((commonTime) => ({
        inferenceT0Us: Math.round(commonTime * 1_000_000),
        sourceT0Us: Math.round((commonTime - camera.offsetSeconds) * 1_000_000),
        decodedFrameTimestampsUs: WINDOW_OFFSETS_S.map((offset) => {
          const target = commonTime - camera.offsetSeconds + offset;
          return Math.round(camera.probe.frameTimesS[selectFrameIndex(camera.probe.frameTimesS, target)]! * 1_000_000);
        }),
        decodedFrameContainerPtsUs: WINDOW_OFFSETS_S.map((offset) => {
          const target = commonTime - camera.offsetSeconds + offset;
          const relativePts = camera.probe.frameTimesS[selectFrameIndex(camera.probe.frameTimesS, target)]!;
          return Math.round((relativePts + camera.probe.containerStartPtsS) * 1_000_000);
        }),
      })),
    })),
    primaryCameraId: video.primaryCameraId,
    inferenceTimestampsUs: inferenceTimesS.slice(0, items.length).map((time) => Math.round(time * 1_000_000)),
    windowOffsetsSeconds: [-0.3, -0.2, -0.1, 0] as [-0.3, -0.2, -0.1, 0],
    inferenceImage: { width: INFERENCE_WIDTH, height: INFERENCE_HEIGHT, resize: 'aspect-preserving-letterbox' },
    assumptions: {
      intrinsics: 'approximated-pinhole',
      horizontalFovDeg: video.horizontalFovDeg,
      cameraHeightM: video.cameraHeightM,
      primaryYawDeg: CAMERA_YAW_DEG[primary.cameraId]!,
      egoHistory: 'constant-speed-straight',
      egoSpeedMps: video.egoSpeedMps,
      synchronizedStarts: video.cameras.every((camera) => camera.offsetSeconds === 0),
    },
    encoder: { origin: encoder.origin, version: encoder.version ?? null, bytesVerified: encoder.bytesVerified },
  };
  const aggregate = buildAggregate(items, new Map());
  const result: OpenloopResult = {
    schema: OPENLOOP_RESULT_SCHEMA,
    runId: options.runId,
    attemptId: options.attemptId,
    task: 'act', exploratory: true, items, aggregate,
    provenance: { model, sampling: options.params.sampling, reference: 'none', horizonsS: options.params.horizonsS, seed: options.params.seed, video: videoProvenance },
  };
  await writeFile(path.join(options.outDir, 'openloop.json'), `${JSON.stringify(result, null, 1)}\n`, 'utf8');
  await writeFile(path.join(options.outDir, 'trajectories.json'), `${JSON.stringify({
    schema: 'simforge.eval-trajectories/v1', runId: options.runId,
    items: items.filter((item) => item.status === 'ok').map((item) => ({
      itemId: item.itemId, input: item.input, frame: item.frame, convention: item.convention,
      dtS: item.dtS, horizonS: item.horizonS, points: item.points, rotations: item.rotations,
      reasoning: item.reasoning, reference: item.reference, projection: item.projection,
    })),
    provenance: { video: videoProvenance },
  }, null, 1)}\n`, 'utf8');

  const sourceVideoPath = path.join(options.outDir, 'source-video.mp4');
  await runProcess(encoder.ffmpeg, [
    '-v', 'error', '-y', '-i', primary.source, '-map', '0:v:0', '-an', '-c:v', 'libx264',
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sourceVideoPath,
  ], options.signal, { stdout: false });
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptCandidates = [
    path.join(moduleDir, 'scripts', 'render-uploaded-video-overlay.py'),
    path.join(moduleDir, '..', 'scripts', 'render-uploaded-video-overlay.py'),
  ];
  const renderer = scriptCandidates.find(existsSync);
  if (!renderer) throw new Error(`uploaded-video overlay renderer is missing (looked in ${scriptCandidates.join(', ')})`);
  const overlayPath = path.join(options.outDir, 'prediction-overlay.mp4');
  await runProcess(process.env['SIMFORGE_PYTHON'] ?? 'python3', [
    renderer, '--ffmpeg', encoder.ffmpeg, '--ffprobe', encoder.ffprobe,
    '--source', primary.source, '--result', path.join(options.outDir, 'openloop.json'), '--output', overlayPath,
    '--primary-offset-seconds', String(primary.offsetSeconds),
  ], options.signal, { stdout: false });
  await rm(workDir, { recursive: true, force: true });

  const artifacts = [
    await describeArtifact(options.outDir, 'openloop.json', 'openloop-result', 'application/json'),
    await describeArtifact(options.outDir, 'trajectories.json', 'trajectories', 'application/json'),
    await describeArtifact(options.outDir, 'source-video.mp4', 'video', 'video/mp4'),
    await describeArtifact(options.outDir, 'prediction-overlay.mp4', 'overlay-video', 'video/mp4'),
  ];
  const sourceDigest = createHash('sha256').update(cameras.map((camera) => camera.sha256).join(':')).digest('hex');
  const cancelled = options.signal.aborted;
  const status: ResultStatus = cancelled ? 'cancelled' : aggregate.okItems === inferenceTimesS.length ? 'succeeded' : 'partial';
  return {
    status, scored: false, exploratory: true, result, metrics: {}, artifacts, model,
    inputKind: 'user-clip', inputDigest: sourceDigest,
  };
}
