/**
 * Calibrated frame extraction from encoded video.
 *
 * A user's calibrated clip usually arrives as encoded video, not as a directory of PNGs, and
 * refusing it would make the reconstruction path unusable for the input it exists to serve.
 * So this module extracts frames with the encoder the desktop already ships — the
 * digest-pinned ffmpeg/ffprobe b6.1.1 in `studio/desktop/tools.lock.json`, staged to
 * `studio/tools/{ffmpeg,ffprobe}` — spawned as separate programs, never linked.
 *
 * ## Timestamp integrity is the whole point
 *
 * Decoding frames is easy; knowing *when* each frame was captured is what makes them
 * evaluable. Two independent sources have to agree before a frame is used:
 *
 *   1. the container's own per-frame presentation timestamps, read from `ffprobe`;
 *   2. the clip manifest's declared `cameras[].timing`.
 *
 * The extractor pairs them and refuses on disagreement rather than renumbering frames to fit.
 * A dropped frame, a variable-frame-rate container declared as constant rate, or a manifest
 * whose timestamp count does not match the stream are all real defects that would silently
 * shear the ego history against the imagery — each becomes a typed refusal naming the
 * mismatch.
 *
 * Nothing is re-encoded and no frame is resampled: extraction is one PNG per decoded frame in
 * decode order (`-vsync 0`), so the pixels handed to reconstruction are the pixels that were
 * recorded.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

import { cameraTimestamps } from './cameras.js';
import { deferred } from './deferred.js';
import { RefusalError } from './refusal.js';
import type { CalibratedCamera } from './schema.js';

/** Encoder revision the desktop pins; recorded in extraction provenance. */
export const PINNED_ENCODER = 'ffmpeg-static b6.1.1 (studio/desktop/tools.lock.json)';

/**
 * Largest allowed disagreement between a container timestamp and the manifest's declared
 * timestamp for the same frame. Half a frame at 10 Hz is 50 ms; 20 ms is the same bound G4
 * applies to actor/camera alignment, so imagery and tracks are held to one standard.
 */
export const TIMESTAMP_TOLERANCE_US = 20_000;

export interface EncoderTools {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  /** Where they came from, for provenance. */
  readonly origin: string;
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[]): Promise<CommandResult> {
  const { promise, resolve, reject } = deferred<CommandResult>();
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Runtime manifest the desktop stage step writes, naming the staged tool paths. */
interface StagedManifest {
  readonly tools?: { readonly ffmpeg?: string; readonly ffprobe?: string; readonly version?: string };
}

async function fromStagedManifest(manifestPath: string): Promise<EncoderTools | undefined> {
  let parsed: StagedManifest;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as StagedManifest;
  } catch {
    return undefined;
  }
  const { ffmpeg, ffprobe } = parsed.tools ?? {};
  if (ffmpeg === undefined || ffprobe === undefined) return undefined;
  const root = path.dirname(manifestPath);
  const resolvedFfmpeg = path.resolve(root, ffmpeg);
  const resolvedFfprobe = path.resolve(root, ffprobe);
  if (!(await isExecutable(resolvedFfmpeg)) || !(await isExecutable(resolvedFfprobe))) return undefined;
  return {
    ffmpeg: resolvedFfmpeg,
    ffprobe: resolvedFfprobe,
    origin: `staged desktop runtime manifest ${manifestPath} (${parsed.tools?.version ?? PINNED_ENCODER})`,
  };
}

export interface EncoderResolution {
  /** Explicit paths win over everything; used by callers that already resolved the tools. */
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  /** Desktop runtime manifest naming staged tool paths. */
  readonly manifestPath?: string;
}

/**
 * Locate the encoder.
 *
 * Order: explicit argument, then `SIMFORGE_FFMPEG`/`SIMFORGE_FFPROBE`, then the staged desktop
 * runtime manifest, then `PATH`. A system `ffmpeg` found on `PATH` is accepted last and its
 * origin is recorded as unpinned, because an arbitrary local build is a different program from
 * the one we qualified — the distinction belongs in provenance, not in a silent assumption.
 */
export async function resolveEncoder(resolution: EncoderResolution = {}): Promise<EncoderTools | undefined> {
  if (resolution.ffmpeg !== undefined && resolution.ffprobe !== undefined) {
    return { ffmpeg: resolution.ffmpeg, ffprobe: resolution.ffprobe, origin: 'explicitly supplied paths' };
  }
  const envFfmpeg = process.env['SIMFORGE_FFMPEG'];
  const envFfprobe = process.env['SIMFORGE_FFPROBE'];
  if (envFfmpeg !== undefined && envFfprobe !== undefined) {
    return { ffmpeg: envFfmpeg, ffprobe: envFfprobe, origin: 'SIMFORGE_FFMPEG / SIMFORGE_FFPROBE' };
  }
  if (resolution.manifestPath !== undefined) {
    const staged = await fromStagedManifest(resolution.manifestPath);
    if (staged !== undefined) return staged;
  }
  const probe = await run('ffprobe', ['-version']).catch(() => ({ code: -1, stdout: '', stderr: '' }));
  if (probe.code === 0) {
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', origin: 'PATH (unpinned system build)' };
  }
  return undefined;
}

/** One decoded frame and the container timestamp it carried. */
export interface ExtractedFrame {
  /** File name inside the output directory. */
  readonly file: string;
  /** Absolute capture time in the clip's timebase, microseconds. */
  readonly tUs: number;
  /** Presentation timestamp read from the container, microseconds from stream start. */
  readonly ptsUs: number;
}

export interface ExtractionResult {
  readonly outputDir: string;
  readonly frames: readonly ExtractedFrame[];
  readonly encoder: string;
  /** Worst |container PTS − declared timestamp| observed, microseconds. */
  readonly maxTimestampSkewUs: number;
}

interface ProbeFrame {
  readonly pts_time?: string;
  readonly best_effort_timestamp_time?: string;
}

/**
 * Read every video frame's presentation timestamp from the container.
 *
 * `best_effort_timestamp_time` is preferred because it is what the decoder actually resolved
 * for streams whose PTS is missing or non-monotonic; `pts_time` is the fallback. Frames whose
 * timestamp cannot be determined at all are returned as `NaN` and rejected by the caller
 * instead of being assigned a position in the sequence.
 */
export async function probeFrameTimestamps(tools: EncoderTools, videoPath: string): Promise<number[]> {
  const result = await run(tools.ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'frame=pts_time,best_effort_timestamp_time',
    '-of', 'json',
    videoPath,
  ]);
  if (result.code !== 0) {
    throw new RefusalError({
      code: 'unsupported_input',
      message: `ffprobe could not read ${videoPath}: ${result.stderr.trim()}`,
      missing: [{ path: videoPath, requirement: 'a decodable video stream with readable frame timestamps' }],
      alternatives: [],
    });
  }
  const parsed = JSON.parse(result.stdout) as { frames?: ProbeFrame[] };
  return (parsed.frames ?? []).map((frame) => {
    const raw = frame.best_effort_timestamp_time ?? frame.pts_time;
    const seconds = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(seconds) ? Math.round(seconds * 1e6) : Number.NaN;
  });
}

/**
 * Extract every frame of a calibrated camera's video and bind each to a verified timestamp.
 *
 * Output files are named `<absoluteTimestampUs>.png`, the same convention the NuRec packages
 * use for recorded frames, so a downstream reader needs no sidecar to know when a frame was
 * taken.
 */
export async function extractVideoFrames(
  videoPath: string,
  camera: CalibratedCamera,
  outputDir: string,
  tools: EncoderTools,
): Promise<ExtractionResult> {
  const declared = cameraTimestamps(camera);
  const containerPts = await probeFrameTimestamps(tools, videoPath);

  if (containerPts.length === 0) {
    throw new RefusalError({
      code: 'unsupported_input',
      message: `${videoPath} decoded no video frames`,
      missing: [{ path: videoPath, requirement: 'a video stream with at least one frame' }],
      alternatives: [],
    });
  }
  const undecidable = containerPts.filter((pts) => !Number.isFinite(pts)).length;
  if (undecidable > 0) {
    throw new RefusalError({
      code: 'unsupported_input',
      message:
        `${videoPath}: ${undecidable} of ${containerPts.length} frames carry no usable presentation timestamp. `
        + 'Frames cannot be placed on the clip timebase by counting them, so extraction stops rather than guessing.',
      missing: [{ path: videoPath, requirement: 'a container with per-frame presentation timestamps (remux with timestamps preserved)' }],
      alternatives: [],
    });
  }
  if (containerPts.length !== declared.length) {
    throw new RefusalError({
      code: 'missing_fields',
      message:
        `camera ${camera.sensorId}: the manifest declares ${declared.length} frame timestamps but ${videoPath} contains `
        + `${containerPts.length} frames. Extraction will not renumber frames to make the counts agree, because that would `
        + 'shear the imagery against the ego history.',
      missing: [
        {
          path: `cameras[cameraId=${camera.cameraId}].timing`,
          requirement: `one declared timestamp per encoded frame (${containerPts.length} expected)`,
        },
      ],
      alternatives: [],
    });
  }

  // The container clock starts at the first frame; the manifest's clock is absolute. Anchor
  // them on the first frame and check every later frame agrees on the elapsed time.
  const ptsOrigin = containerPts[0]!;
  const declaredOrigin = declared[0]!;
  let maxSkew = 0;
  let worstIndex = 0;
  for (let index = 0; index < declared.length; index += 1) {
    const skew = Math.abs((containerPts[index]! - ptsOrigin) - (declared[index]! - declaredOrigin));
    if (skew > maxSkew) {
      maxSkew = skew;
      worstIndex = index;
    }
  }
  if (maxSkew > TIMESTAMP_TOLERANCE_US) {
    throw new RefusalError({
      code: 'missing_fields',
      message:
        `camera ${camera.sensorId}: the container's frame timing disagrees with the declared timestamps by `
        + `${(maxSkew / 1000).toFixed(1)} ms at frame ${worstIndex} (tolerance ${TIMESTAMP_TOLERANCE_US / 1000} ms). `
        + 'A variable-frame-rate recording declared as constant rate, or a dropped frame, produces exactly this; '
        + 'declare explicit per-frame timestamps that match the stream.',
      missing: [
        {
          path: `cameras[cameraId=${camera.cameraId}].timing.timestampsUs`,
          requirement: 'per-frame timestamps matching the encoded stream to within 20 ms of elapsed time',
        },
      ],
      alternatives: [],
    });
  }

  await mkdir(outputDir, { recursive: true });
  // `-vsync 0` emits exactly one image per decoded frame in decode order, with no duplication
  // or dropping, so file N corresponds to container frame N.
  const extraction = await run(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-vsync', '0',
    '-pix_fmt', 'rgb24',
    path.join(outputDir, 'frame-%06d.png'),
  ]);
  if (extraction.code !== 0) {
    throw new RefusalError({
      code: 'unsupported_input',
      message: `ffmpeg failed to extract frames from ${videoPath}: ${extraction.stderr.trim()}`,
      missing: [{ path: videoPath, requirement: 'a decodable video stream' }],
      alternatives: [],
    });
  }

  const produced = (await readdir(outputDir)).filter((name) => /^frame-\d{6}\.png$/.test(name)).sort();
  if (produced.length !== declared.length) {
    throw new RefusalError({
      code: 'unsupported_input',
      message:
        `camera ${camera.sensorId}: ffprobe reported ${declared.length} frames but extraction produced ${produced.length}. `
        + 'The decoded frame set is not the probed frame set, so no frame can be trusted to its timestamp.',
      missing: [{ path: videoPath, requirement: 'a stream whose decoded frame count matches its probed frame count' }],
      alternatives: [],
    });
  }

  const frames: ExtractedFrame[] = [];
  for (let index = 0; index < produced.length; index += 1) {
    const tUs = declared[index]!;
    const file = `${tUs}.png`;
    await rename(path.join(outputDir, produced[index]!), path.join(outputDir, file));
    frames.push({ file, tUs, ptsUs: containerPts[index]! });
  }

  return { outputDir, frames, encoder: tools.origin, maxTimestampSkewUs: maxSkew };
}
