/**
 * `@simforge-oss/render/timeline` — the render timeline for Node hosts:
 * build it from the authoritative trace (the CPU timeline step), open it,
 * sample it, and grade a renderer's observed transforms against it.
 *
 * Every call goes through the same Rust functions as the editor (WASM),
 * Bevy and CARLA (Python): this module loads the WASM build of the native
 * runtime into Node and never re-implements the sampler in TypeScript.
 * Contract: `docs/engineering/render-timeline.md`.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { loadNative, type NativeWasm } from '@simforge-oss/native-runtime/browser';

export const RENDER_TIMELINE_VERSION = 'simforge.render-timeline.v1';
export const TIMELINE_SAMPLER_VERSION = 'simforge.timeline-sampler/1';
/** Render-job input id carrying the timeline's canonical JSON bytes. */
export const RENDER_TIMELINE_INPUT_ID = 'render.timeline';
/** Width of one sampled pose in `poseArray` / `posesArray`. */
export const POSE_ARRAY_LEN = 20;
/** Width of one actor record in `sceneFramesArray`. */
export const SCENE_FRAME_RECORD_LEN = 12;

export type RenderTimelineHandle = ReturnType<NativeWasm['RenderTimeline']['fromBytes']>;

let runtime: Promise<NativeWasm> | null = null;

/** Locate `simforge_native_runtime_bg.wasm` beside the installed native runtime. */
export function nativeWasmPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SIMFORGE_NATIVE_WASM?.trim();
  if (explicit) return explicit;
  const require = createRequire(import.meta.url);
  // `./browser` resolves to dist/browser.js (published) or src/browser.ts
  // (workspace); the WASM sits in `../wasm/` from either.
  let entry: string;
  try {
    entry = require.resolve('@simforge-oss/native-runtime/browser');
  } catch {
    entry = join(dirname(require.resolve('@simforge-oss/native-runtime')), 'browser.js');
  }
  return join(dirname(entry), '..', 'wasm', 'simforge_native_runtime_bg.wasm');
}

/** The WASM native runtime, loaded once per process. */
export function timelineRuntime(): Promise<NativeWasm> {
  runtime ??= loadNative(readFileSync(nativeWasmPath())).catch((error: unknown) => {
    runtime = null;
    throw error;
  });
  return runtime;
}

function bytesOf(value: Uint8Array | string | object): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
}

export interface BuildRenderTimelineInput {
  /** The authoritative trace: a parsed object, or plain / gzipped JSON bytes. */
  readonly trace: Uint8Array | string | object;
  /** The map's `.xodr` (its sha256 must equal the trace's `engineGraphDigest`). */
  readonly xodr: Uint8Array | string;
  /** The map's `topology-index.json(.gz)` sidecar. */
  readonly topology: Uint8Array | string;
  /** v1: `null` (everything is derived from the trace). */
  readonly catalogDigest?: string | null;
  /**
   * The identity recorded next to a STORED trace (`sim_results.trace_sha256`),
   * after the caller verified the stored bytes. A current-format trace must
   * recompute to it; a trace upgraded in memory from an older format adopts
   * it (its writer's digest can't be recomputed after a format change).
   */
  readonly recordedTraceSha256?: string;
}

export interface BuiltRenderTimeline {
  readonly timelineKey: string;
  readonly timelineSha256: string;
  readonly traceSha256: string;
  readonly heightFieldDigest: string;
  readonly catalogDigest: string | null;
  readonly samplerVersion: string;
  /** `canonicalJson(timeline)`; `sha256(bytes) === timelineSha256`. */
  readonly bytes: Uint8Array;
}

function built(timeline: RenderTimelineHandle): BuiltRenderTimeline {
  return {
    timelineKey: timeline.key,
    timelineSha256: timeline.sha256,
    traceSha256: timeline.traceSha256,
    heightFieldDigest: timeline.heightFieldDigest,
    catalogDigest: timeline.catalogDigest ?? null,
    samplerVersion: timeline.samplerVersion,
    bytes: new TextEncoder().encode(timeline.toCanonicalJson()),
  };
}

/**
 * The CPU timeline step: trace + map height source → canonical timeline
 * bytes and identities. Pure: equal inputs give equal bytes in every binding.
 */
export async function buildRenderTimeline(input: BuildRenderTimelineInput): Promise<BuiltRenderTimeline> {
  const wasm = await timelineRuntime();
  const timeline = wasm.RenderTimeline.build(
    bytesOf(input.trace), bytesOf(input.xodr), bytesOf(input.topology), input.catalogDigest ?? undefined,
    input.recordedTraceSha256,
  );
  try {
    return built(timeline);
  } finally {
    timeline.free();
  }
}

/**
 * Open a stored timeline of ANY sampler version for inspection only (motion
 * comparison across sampler versions). Never render it: a timeline from
 * another sampler is re-derived from its trace under the current one.
 */
export async function inspectRenderTimeline(bytes: Uint8Array | string): Promise<RenderTimelineHandle> {
  const wasm = await timelineRuntime();
  let raw = bytesOf(bytes);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
  return wasm.RenderTimeline.inspect(raw);
}

/** Open (parse and validate) timeline bytes: plain or gzipped canonical JSON. */
export async function openRenderTimeline(bytes: Uint8Array | string): Promise<RenderTimelineHandle> {
  const wasm = await timelineRuntime();
  let raw = bytesOf(bytes);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
  return wasm.RenderTimeline.fromBytes(raw);
}

/** One sampled pose (xodr-local / OpenSCENARIO frame). */
export interface TimelinePose {
  readonly present: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly headingRad: number;
  readonly pitchRad: number;
  readonly rollRad: number;
  readonly speedMps: number;
  readonly velocity: readonly [number, number, number];
  readonly acceleration: readonly [number, number, number];
  readonly roadPitchRad: number;
  readonly roadRollRad: number;
  readonly bodyPitchRad: number;
  readonly bodyRollRad: number;
  readonly wheelSteerRad: number | null;
  readonly wheelSpinRad: number | null;
}

/** Decode one 20-float pose record (`poseArray` / `posesArray`). */
export function decodePose(values: ArrayLike<number>, offset = 0): TimelinePose {
  const v = (i: number) => values[offset + i]!;
  const optional = (i: number) => (Number.isNaN(v(i)) ? null : v(i));
  return {
    present: v(0) === 1,
    x: v(1), y: v(2), z: v(3),
    headingRad: v(4), pitchRad: v(5), rollRad: v(6),
    speedMps: v(7),
    velocity: [v(8), v(9), v(10)],
    acceleration: [v(11), v(12), v(13)],
    roadPitchRad: v(14), roadRollRad: v(15), bodyPitchRad: v(16), bodyRollRad: v(17),
    wheelSteerRad: optional(18), wheelSpinRad: optional(19),
  };
}

/** `pose(timeline, actorId, t)`. */
export function pose(timeline: RenderTimelineHandle, actorId: string, t: number): TimelinePose {
  return decodePose(timeline.poseArray(actorId, t));
}

export interface ParityProfile {
  readonly name: string;
  readonly positionToleranceM: number;
  readonly angleToleranceDeg: number;
  readonly frame: 'scene-yup' | 'xodr-local';
  readonly heightReference: 'ground' | 'body-centre';
  readonly compareAttitude: boolean;
}

export interface ParityPoseError {
  readonly t: number;
  readonly actorId: string;
  readonly positionErrorM: number;
  readonly horizontalErrorM: number;
  readonly verticalErrorM: number;
  readonly headingErrorDeg: number;
  readonly pitchErrorDeg?: number;
  readonly rollErrorDeg?: number;
}

/** `simforge.render-parity/v1`. */
export interface ParityReport {
  readonly schema: 'simforge.render-parity/v1';
  readonly timelineSha256: string;
  readonly timelineKey: string;
  readonly samplerVersion: string;
  readonly profile: ParityProfile;
  readonly frames: number;
  readonly comparedPoses: number;
  readonly maxPositionErrorM: number;
  readonly maxHorizontalErrorM: number;
  readonly maxVerticalErrorM: number;
  readonly maxHeadingErrorDeg: number;
  readonly maxPitchErrorDeg: number | null;
  readonly maxRollErrorDeg: number | null;
  readonly p95PositionErrorM: number;
  readonly p95HeadingErrorDeg: number;
  readonly presenceMismatches: number;
  readonly presenceMismatchSamples: readonly { t: number; actorId: string; observed: boolean }[];
  readonly worst: readonly ParityPoseError[];
  readonly perActor: Readonly<Record<string, {
    compared: number; maxPositionErrorM: number; maxHeadingErrorDeg: number; maxAttitudeErrorDeg: number;
  }>>;
  readonly pass: boolean;
}

/**
 * Grade a renderer's observed per-frame transforms (JSONL: Bevy
 * `observed-frames.jsonl`, CARLA observed transforms) against the sampler.
 */
export function compareObserved(
  timeline: RenderTimelineHandle,
  observedJsonl: string,
  profile: 'bevy' | 'carla' | ParityProfile = 'bevy',
): ParityReport {
  const spec = typeof profile === 'string' ? profile : JSON.stringify(profile);
  return JSON.parse(timeline.compareObservedJson(observedJsonl, spec)) as ParityReport;
}
