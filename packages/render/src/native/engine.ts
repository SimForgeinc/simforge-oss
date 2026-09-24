import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  ENGINE_CAPABILITIES_V1_SCHEMA,
  hashFile,
  scheduleFrameMicros,
  type EngineCapabilityDeclaration,
  type RenderArtifactManifest,
  type RenderEngineAdapter,
  type RenderExecutionContext,
  type RenderInputFile,
  type RenderInputSelectionContext,
} from '../index.js';
import {
  CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK, CONTROL_FEATURE_NATIVE_ROAD_DECALS, CONTROL_FEATURE_NATIVE_TEXTURE_RESIDENCY, CONTROL_FEATURE_NATIVE_FRAME_INTEGRITY, CONTROL_FEATURE_NATIVE_ENCODER, CONTROL_FEATURE_NATIVE_PARITY, CONTROL_FEATURE_NATIVE_RENDER_CONFIG,
  CONTROL_FEATURE_NATIVE_SCENE_SOURCE, CONTROL_FEATURE_NATIVE_STAGE_TIMINGS, CONTROL_FEATURE_NATIVE_VRAM_DETECTED,
} from '../worker-control.js';
import { RenderInputError } from '../render-input-error.js';
import { LEGACY_XOSC_MOTION_SOURCE, parseRenderIntent, type RenderIntentV1, type RenderPreset, type RenderRequest, type RenderSourceV3 } from '@simforge-oss/scenario';

import { lowerTimelineToNative, type NativeTimelineLowering } from './timeline-lowering.js';
import { lowerOpenScenarioToNative, type NativeSceneLowering } from './lowering.js';
import { RENDER_TIMELINE_INPUT_ID, checkTimelineContact, compareObserved, openRenderTimeline, type ContactGateReport, type ParityReport } from '../timeline/index.js';
import { createNativeCameraSchedule, createNativeSensorRigs } from './camera-schedule.js';
import { LidarVideoRasterizer, RadarVideoRasterizer, parseLidarPly, parseRadarCsv } from './sensor-video.js';
import { StreamingZipWriter, HashedArtifactSink } from '../web/artifacts.js';
import { stripRgbaPadding, type NativeActorObservation, type NativeBundleResponse, type NativeFrameIdentity, type NativeFrameRecord } from './service-client.js';
import { DEFAULT_SHM_SIZE_MB, startNativeRenderService } from './service-process.js';
import {
  NATIVE_ACTOR_ASSETS_INPUT_ID, assertActorAnimationsBound, assertActorAppearanceGrounded, ensureActorAssets, nativeActorAssetsCacheDir,
} from './actor-assets.js';
import { NativeRenderManifestSchema, NativeRunDiagnosticsSchema, nativeSensorVideoFormat } from './evidence.js';
import { resolveActorAssets, resolveEncoder, resolveNativeRenderService, type LocalExecutableSource } from './local-runtime.js';
import { nativeLightingSiteFromOpenDrive, resolveNativeLighting } from './lighting.js';
import { collectNativeMapMembers, isNativeMapMemberInputId, nativeMapMemberInputId, NATIVE_MAP_MASTER_INPUT_ID } from './map-closure.js';
import { NativeGpuMemoryError, nativeSceneEstimateBytes, nativeStartupTimeoutMs, NativeTextureCapacityError, planNativeTextureMembers, stageNativeTextureProfile } from './texture-profile.js';
import { NATIVE_GEOMETRY_LOD_MANIFEST, planNativeGeometryLod, type NativeGeometryLodMode } from './geometry-lod.js';
import { NATIVE_ROAD_DECALS_MANIFEST, planNativeRoadDecals } from './road-decals.js';
import { NATIVE_TEXTURE_DENSITY_MANIFEST, nativeTextureResidencyLevels, nativeTextureResidencyPlan, planNativeTextureDensity } from './texture-residency.js';
import type { NativeTextureResidency } from './texture-residency.js';
import { NATIVE_STAGE_TIMINGS_V1_SCHEMA, StageSamples, splitServiceStages, type NativeStageTimings } from './stage-timings.js';
import {
  DEFAULT_NVENC_MAX_SESSIONS, VideoEncoder, assignVideoCodecs, encoderCodecArgs, nvencAvailable,
  type NativeVideoCodec, type NativeVideoEncoderPreference, type VideoFormat,
} from './video-encoder.js';

/** The map ground surface member (`derived/ground`, docs/engineering/ground-height.md). */
const GROUND_MESH_MEMBER = 'derived/ground/ground-mesh.bin';

export const NATIVE_RENDER_ENGINE_ID = 'bevy-retained';
/** Per-RPC budgets for a started service (the start itself scales with the scene: `nativeStartupTimeoutMs`). */
export const NATIVE_LOAD_STATE_TIMEOUT_MS = 300_000;
export const NATIVE_FIRST_BUNDLE_TIMEOUT_MS = 600_000;
export const NATIVE_BUNDLE_TIMEOUT_MS = 120_000;
/** Bundle requests kept queued behind the one being answered (pipelining). */
export const NATIVE_BUNDLE_LOOKAHEAD = 2;

/** Bytes one published bundle of `sources` takes in the shared-memory ring. */
export function nativeBundleBytes(sources: readonly { modality: string; attributes: object }[]): number {
  return sources.reduce((sum, source) => {
    if (source.modality !== 'rgb') return sum + 8 * 1024 * 1024;
    const { width, height } = source.attributes as { width: number; height: number };
    return sum + Math.ceil(width * 4 / 256) * 256 * height;
  }, 0);
}

/**
 * The shared-memory ring for a rig: it must hold every published-but-unread
 * bundle, `3 + lookahead` of them. Sized from the rig (never below the
 * service default, rounded up to 64 MiB). An explicit size too small for the
 * requested lookahead is an error, not a quiet switch to serial ticks.
 */
export function nativeShmSizeMb(bundleBytes: number, lookahead: number, explicitMb?: number): number {
  const neededMb = lookahead > 0 ? Math.ceil((3 + lookahead) * bundleBytes / (64 * 1024 * 1024)) * 64 : 0;
  if (explicitMb !== undefined) {
    if (explicitMb < neededMb) {
      throw new RenderInputError('native_shm_too_small',
        `shared-memory ring of ${explicitMb} MiB cannot hold ${3 + lookahead} bundles of ${Math.ceil(bundleBytes / (1024 * 1024))} MiB `
        + `(bundle lookahead ${lookahead} needs ${neededMb} MiB): raise shmSizeMb or set bundleLookahead 0`);
    }
    return explicitMb;
  }
  return Math.max(DEFAULT_SHM_SIZE_MB, neededMb);
}
const NATIVE_ENGINE_VERSION = '0.1.0-rc.65';

export interface NativeRenderEngineOptions {
  /** Path to the `simforge-render` binary (default: the installed native runtime's). */
  readonly binary?: string;
  readonly ffmpegBinary?: string;
  readonly engineVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly shmSizeMb?: number;
  /**
   * Meter the sky through each frame's camera (the Lookdev Lab's
   * highlight-priority meter), so a sunward low sun stops the camera down
   * instead of printing a white sky. Default on; off leaves the incident
   * meter alone, which is what the pre-rev23 platform did.
   */
  readonly autoMeter?: boolean;
  /** Where the pinned actor closure's blobs come from; defaults to the installed closure (`resolveActorAssets`). */
  readonly actorAssetsBaseUrl?: string;
  readonly actorAssetsCacheDir?: string;
  readonly nativeCacheDirectory?: string;
  /**
   * Send the timeline's road + body pitch/roll to the service (default on:
   * the service applies full actor rotations). Off sends yaw-only rotations.
   */
  readonly applyAttitude?: boolean;
  /**
   * Video encoder: `auto` (default; NVENC where this ffmpeg can open a
   * session on the device, libx264 otherwise), `libx264` or `h264_nvenc`
   * (required). `SIMFORGE_NATIVE_VIDEO_ENCODER` sets it for a worker.
   */
  readonly videoEncoder?: NativeVideoEncoderPreference;
  /** NVENC sessions one job may open (default 6; the rest use libx264). */
  readonly nvencMaxSessions?: number;
  /**
   * This worker's default render configuration (preset, `RenderConfig`
   * overrides, geometry LOD mode). The intent's own `render` wins: its
   * preset and geometry LOD mode replace these, its overrides apply on top.
   */
  readonly render?: RenderRequest;
  /** Bundle requests queued behind the one being answered (default 2; 0 disables pipelining). */
  readonly bundleLookahead?: number;
}

/**
 * Capacity for the texture-profile check: the intent's (fleet) capacity,
 * lowered to the job's measured device when the worker reported one.
 */
export function nativeVramCapacity(intentCapacity: number | undefined, detectedTotal: number | undefined): {
  capacityBytes: number | undefined; detected: boolean; intentCapacity: number | undefined; measuredBytes: number | undefined;
} {
  if (detectedTotal === undefined || !Number.isSafeInteger(detectedTotal) || detectedTotal <= 0) {
    return { capacityBytes: intentCapacity, detected: false, intentCapacity, measuredBytes: undefined };
  }
  if (intentCapacity !== undefined && intentCapacity <= detectedTotal) return { capacityBytes: intentCapacity, detected: false, intentCapacity, measuredBytes: detectedTotal };
  return { capacityBytes: detectedTotal, detected: true, intentCapacity, measuredBytes: detectedTotal };
}

/**
 * The staged profile as evidence. `capacityBytes`/`capacitySource` keep their
 * baseline meaning (the intent's capacity, `assumed` or `explicit`). A plane
 * that lists native-evidence.vram-detected also gets `detectedCapacityBytes`:
 * the job's measured device whenever the worker measured it (the check ran
 * against the smaller of the two). It is absent only when nothing was
 * measured, which the run also reports (`gpu_memory_unmeasured`).
 */
export function nativeTextureEvidence<T extends { capacityBytes: number; capacitySource: 'assumed' | 'explicit' }>(
  staged: T,
  vram: { detected: boolean; intentCapacity: number | undefined; measuredBytes?: number | undefined },
  explicitBudget: boolean,
  features: ReadonlySet<string>,
): T & { detectedCapacityBytes?: number } {
  const baseline = !explicitBudget && vram.detected && vram.intentCapacity !== undefined
    ? { ...staged, capacityBytes: vram.intentCapacity, capacitySource: 'assumed' as const }
    : staged;
  return features.has(CONTROL_FEATURE_NATIVE_VRAM_DETECTED) && vram.measuredBytes !== undefined
    ? { ...baseline, detectedCapacityBytes: vram.measuredBytes }
    : baseline;
}

/** Diagnostics `frameIntegrity`: the non-finite pixel total and the first 100 affected camera frames. */
export function nativeFrameIntegrity(frames: readonly { tick: number; sensorId: string; pixels: number }[]) {
  return { nonFinitePixels: frames.reduce((sum, frame) => sum + frame.pixels, 0), frames: frames.slice(0, 100).map((frame) => ({ ...frame })) };
}

/** The preset a render without one uses: platform renders are delivery video. */
export const NATIVE_DEFAULT_PRESET: RenderPreset = 'showcase';

/** The render request a job resolves to, and its geometry LOD mode. */
export interface NativeRenderRequest {
  /** The scene spec's `render` (`render_core::render_config::RenderRequest`). */
  readonly request: { readonly preset: RenderPreset; readonly set: Readonly<Record<string, unknown>> };
  readonly geometryLod: NativeGeometryLodMode;
}

/**
 * The job's render configuration: the intent's `render`, over the worker's
 * default (`options.render`), over `showcase` with geometry LOD `auto`. The
 * staged texture tier is part of it (`textures.tier`), so the service
 * refuses a config that names another tier.
 */
export function nativeRenderRequest(intent: RenderIntentV1, options: NativeRenderEngineOptions): NativeRenderRequest {
  // fallback-ok: documented defaults (intent `render` absent = showcase, LOD auto); the resolved request is recorded in the manifest
  const worker = options.render ?? {};
  const job = intent.render ?? {}; // fallback-ok: see above
  const set: Record<string, unknown> = { ...worker.set, ...job.set };
  if (intent.renderTextures) {
    if (set['textures.tier'] !== undefined && set['textures.tier'] !== intent.renderTextures) {
      throw new RenderInputError('native_render_config_invalid', `render.set textures.tier ${String(set['textures.tier'])} but the intent stages ${intent.renderTextures}`);
    }
    set['textures.tier'] = intent.renderTextures;
  }
  return {
    request: { preset: job.preset ?? worker.preset ?? NATIVE_DEFAULT_PRESET, set },
    geometryLod: job.geometryLod ?? worker.geometryLod ?? 'auto', // fallback-ok: documented default mode, recorded in the manifest
  };
}

/** How captured pixels relate to time, from the service's resolved render config (manifest `capture`). */
export function nativeCaptureEvidence(renderConfig: Readonly<Record<string, unknown>>): {
  clock: 'simulation-time' | 'update-count'; antiAlias: string; samplesPerFrame: number;
} {
  const aa = renderConfig.aa as { mode?: unknown; taaSamples?: unknown } | undefined;
  const clock = (renderConfig.clock as { mode?: unknown } | undefined)?.mode;
  if (typeof aa?.mode !== 'string' || typeof aa.taaSamples !== 'number' || (clock !== 'pinned' && clock !== 'free')) {
    throw new Error(`native_render_config_unreadable: the service reported no aa.mode/aa.taaSamples/clock.mode (${JSON.stringify(renderConfig).slice(0, 200)})`);
  }
  return {
    clock: clock === 'pinned' ? 'simulation-time' : 'update-count',
    antiAlias: aa.mode,
    samplesPerFrame: clock === 'pinned' && aa.mode === 'taa' ? aa.taaSamples : 1,
  };
}

const CAPABILITIES: EngineCapabilityDeclaration = {
  schema: ENGINE_CAPABILITIES_V1_SCHEMA,
  engineId: NATIVE_RENDER_ENGINE_ID,
  engineVersion: NATIVE_ENGINE_VERSION,
  backend: 'native',
  protocolVersion: 1,
  capabilities: [
    'openscenario.1_4',
    'timing.fixed_step',
    'environment.authored',
    'sensor.rgb',
    'sensor.lidar',
    'sensor.radar',
    'artifact.video',
    'artifact.manifest',
    'artifact.trace',
    'artifact.sensor_archive',
    'map.static_semantics',
  ],
  modalities: ['rgb', 'lidar', 'radar'],
  limits: {
    maxSimultaneousSensors: 64,
    maxWidth: 4096,
    maxHeight: 4096,
    maxFramesPerSecond: 120,
  },
  requiresGpu: true,
};

/**
 * The claimed inputs a native render reads: every non-map input, the map
 * master, and exactly the members of the intent's texture tier (see
 * `planNativeTextureMembers`), plus the geometry LOD derivative unless the
 * job turns it off (`planNativeGeometryLod`). A closure carries both tiers
 * plus sources the renderer never opens (OpenDRIVE, GeoJSON, reports), so a
 * full-tier render skips the 512 px variants and a `bc7-512` render skips
 * the full images.
 */
export async function selectNativeRenderInputs(context: RenderInputSelectionContext): Promise<ReadonlySet<string>> {
  const intent = parseRenderIntent(context.intent);
  const selected = new Set(context.inputs.filter((input) => !isNativeMapMemberInputId(input.inputId)).map((input) => input.inputId));
  const byPath = new Map(context.inputs.filter((input) => input.relativePath && isNativeMapMemberInputId(input.inputId)).map((input) => [input.relativePath!, input]));
  if (byPath.size === 0) return selected;
  if (!intent.renderTextures) return new Set(context.inputs.map((input) => input.inputId));
  selected.add(NATIVE_MAP_MASTER_INPUT_ID);
  const master = JSON.parse((await context.read(NATIVE_MAP_MASTER_INPUT_ID)).toString('utf8')) as Parameters<typeof planNativeTextureMembers>[0];
  const memberSource = {
    sha256: (uri: string) => byPath.get(uri)?.sha256,
    readText: async (uri: string) => (await context.read(nativeMapMemberInputId(uri))).toString('utf8'),
  };
  const plan = await planNativeTextureMembers(master, intent.renderTextures, memberSource);
  for (const uri of plan.members) selected.add(nativeMapMemberInputId(uri));
  // fallback-ok: the documented default mode; the worker re-plans with the same mode and records it
  const lod = await planNativeGeometryLod(intent.render?.geometryLod ?? 'auto', memberSource);
  if (lod) for (const uri of lod.members) selected.add(nativeMapMemberInputId(uri));
  // Every derivative the run reads (`nativeDerivativesRead`) is downloaded:
  // a derivative left out here would render as if the map had none.
  for (const uri of nativeDerivativesRead(intent.renderTextures)) {
    if (byPath.has(uri)) selected.add(nativeMapMemberInputId(uri));
  }
  return selected;
}

/**
 * The single-file map derivatives a native run reads when the map carries
 * them: the road decal manifest, and at `uastc-full` the texture density
 * manifest (per-job residency). Geometry LOD members depend on the LOD mode
 * and are selected by its plan.
 */
export function nativeDerivativesRead(renderTextures: RenderIntentV1['renderTextures']): readonly string[] {
  return renderTextures === 'uastc-full' ? [NATIVE_ROAD_DECALS_MANIFEST, NATIVE_TEXTURE_DENSITY_MANIFEST] : [NATIVE_ROAD_DECALS_MANIFEST];
}

/**
 * Refuses a run whose intent declares a derivative the run reads that did
 * not reach the job's inputs: without it the run would silently render
 * without the decals, or upload every mip level and fail admission.
 */
export function assertNativeDerivativesDelivered(
  intent: Pick<RenderIntentV1, 'assets' | 'renderTextures'>,
  delivered: ReadonlySet<string>,
): void {
  const declared = new Set(intent.assets.map((asset) => asset.assetId));
  for (const uri of nativeDerivativesRead(intent.renderTextures)) {
    if (declared.has(nativeMapMemberInputId(uri)) && !delivered.has(uri)) {
      throw new RenderInputError('native_derivative_not_delivered', `the intent declares ${uri} but the job's inputs do not carry it`);
    }
  }
}

/**
 * `sceneSource` / `timelineSha256` are newer than the baseline native
 * evidence contract: written only when the control plane lists
 * `native-evidence.scene-source` (an older plane parses manifests strictly
 * and rejects the whole job on an unknown key). `parity` is gated the same
 * way by `native-evidence.parity`.
 */
export function gatedSceneSourceEvidence(
  features: ReadonlySet<string>,
  sceneSource: 'render-timeline' | 'openscenario-legacy',
  timelineSha256: string | undefined,
): { sceneSource?: 'render-timeline' | 'openscenario-legacy'; timelineSha256?: string } {
  if (!features.has(CONTROL_FEATURE_NATIVE_SCENE_SOURCE)) return {};
  return { sceneSource, ...(timelineSha256 ? { timelineSha256 } : {}) };
}

/**
 * `look` and `render` for the native manifest. A plane that lists
 * `native-evidence.render-config` reads the render config from `render`; an
 * older plane requires the rc.73 look keys (`profile: cinematic`,
 * `profileConfig`), which then carry the same resolved config.
 */
export function gatedRenderEvidence(
  features: ReadonlySet<string>,
  look: { readonly lighting: object; readonly autoMeter: boolean; readonly provenance: object },
  renderRequest: NativeRenderRequest,
  renderConfig: Readonly<Record<string, unknown>>,
  geometryLod: { readonly manifestSha256: string; readonly buildKey: string } | undefined,
) {
  // `look` keeps its baseline keys for every plane (an rc.75 plane requires
  // `profile` and `profileConfig`): `profile` is the retired look's name and
  // `profileConfig` the resolved render config. `render` is new.
  const base = { profile: 'cinematic' as const, lighting: { ...look.lighting }, profileConfig: { ...renderConfig }, autoMeter: look.autoMeter, provenance: { ...look.provenance } };
  if (!features.has(CONTROL_FEATURE_NATIVE_RENDER_CONFIG)) return { look: base };
  return {
    look: base,
    render: {
      request: { preset: renderRequest.request.preset, set: { ...renderRequest.request.set } },
      config: { ...renderConfig },
      geometryLod: {
        mode: renderRequest.geometryLod,
        manifestSha256: geometryLod ? geometryLod.manifestSha256 : null,
        buildKey: geometryLod ? geometryLod.buildKey : null,
      },
    },
  };
}

export function resolveBinary(options: NativeRenderEngineOptions): string {
  if (options.binary) return options.binary;
  const service = resolveNativeRenderService();
  return service.state === 'available' ? service.path : service.searched[service.searched.length - 1]!;
}


/** The ffmpeg a native render encodes with, and how it was found (recorded in the manifest). */
export interface NativeEncoderIdentity {
  readonly path: string;
  readonly source: 'option' | LocalExecutableSource;
  readonly version: string;
}

/**
 * The encoder binary: the engine option, else the runtime's resolved ffmpeg
 * (`resolveEncoder`: env, runtime root, then a PATH lookup that is recorded
 * as `path`). Nothing found fails the job (`native_encoder_missing`); a bare
 * `ffmpeg` is never spawned on the chance that one exists.
 */
export function resolveNativeEncoder(options: Pick<NativeRenderEngineOptions, 'ffmpegBinary'>, env: NodeJS.ProcessEnv = process.env): { path: string; source: NativeEncoderIdentity['source'] } {
  if (options.ffmpegBinary) return { path: options.ffmpegBinary, source: 'option' };
  const encoder = resolveEncoder(env);
  if (encoder.state === 'available') return { path: encoder.path, source: encoder.source };
  throw new RenderInputError('native_encoder_missing', `no ffmpeg encoder is installed for the native render (looked in ${encoder.searched.length > 0 ? encoder.searched.join(', ') : 'nowhere: PATH is empty'})`);
}

/** `ffmpeg -version`'s banner line, which names the build; a binary that cannot report it cannot encode. */
export function nativeEncoderVersion(ffmpeg: string): string {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 20_000 });
  const banner = probe.status === 0 ? probe.stdout.split('\n')[0]?.trim() : undefined;
  if (!banner) {
    throw new RenderInputError('native_encoder_missing', `ffmpeg ${ffmpeg} did not report its version (${probe.error?.message ?? `exit ${String(probe.status)}`})`);
  }
  return banner.slice(0, 512);
}

/**
 * The scene's clip planes: the nearest near plane and the farthest far plane
 * of the RGB cameras. Each camera renders with its own planes (the camera
 * schedule sends them per camera); the scene pair covers them all and is
 * what the service uses where one value is shared: the prewarm view, the
 * aerial-perspective LUT's far plane, and the residency plan's near bound
 * (the nearest plane is the conservative one). Lidar and radar cast their
 * own rays and never move them.
 */
export function nativeCameraClipPlanes(sources: readonly RenderSourceV3[]): { nearM: number; farM: number } {
  const cameras = sources.flatMap((source) => (source.modality === 'rgb' ? [source.attributes] : []));
  if (cameras.length === 0) throw new RenderInputError('native_render_camera_missing', 'native render requires at least one RGB camera');
  return {
    nearM: Math.min(...cameras.map((camera) => camera.nearM)),
    farM: Math.max(...cameras.map((camera) => camera.farM)),
  };
}

/**
 * Refuses sources the service would render other than authored:
 * - a camera whose frame exceeds the engine's limits;
 * - an asymmetric lidar vertical band: the service's lidar fan is symmetric
 *   about the mount, and tilting the rig to fake it would tilt the scan plane.
 */
/**
 * The video the intent asks for, as the native encoder can make it: MP4/H.264
 * at the reference quality (libx264 CRF 18, or NVENC at its measured
 * equivalent), which meets `draft`, `standard` and `high`. Another container
 * or codec, or `lossless`, is refused rather than encoded as something else.
 */
export function assertNativeVideoProfileSupported(video: RenderIntentV1['renderSpec']['video']): void {
  if (!video) return;
  if (video.container !== 'mp4' || video.codec !== 'h264') {
    throw new RenderInputError('native_video_profile_unsupported', `the native engine encodes mp4+h264; the intent asks for ${video.container}+${video.codec}`);
  }
  if (video.quality === 'lossless') {
    throw new RenderInputError('native_video_quality_unsupported', 'the native engine encodes lossy H.264 (CRF 18); the intent asks for lossless video');
  }
}

export function assertNativeSourcesSupported(sources: readonly RenderSourceV3[]): void {
  for (const source of sources) {
    if (source.modality === 'rgb') {
      const { width, height } = source.attributes;
      if (width > CAPABILITIES.limits.maxWidth || height > CAPABILITIES.limits.maxHeight) {
        throw new RenderInputError('native_camera_size_unsupported', `camera ${source.outputName} asks for ${width}x${height}; the native engine renders at most ${CAPABILITIES.limits.maxWidth}x${CAPABILITIES.limits.maxHeight}`);
      }
    }
    if (source.modality === 'lidar') {
      const { upperFovDeg, lowerFovDeg } = source.attributes;
      if (Math.abs(upperFovDeg + lowerFovDeg) > 1e-9) {
        throw new RenderInputError('native_lidar_asymmetric_fov_unsupported', `lidar ${source.outputName} scans ${lowerFovDeg} to ${upperFovDeg} deg; the native service casts a vertical fan symmetric about the mount`);
      }
    }
  }
}

/** A service frame must be the pass, size and format this job asked for. */
function assertFrameMatchesRequest(frame: NativeFrameRecord, encoder: Encoder, tick: number): void {
  const expected = encoder.source.modality === 'rgb'
    ? { format: 'rgba8', width: encoder.width, height: encoder.height, pass: 'rgb' }
    : encoder.source.modality === 'lidar'
      ? { format: 'ply-ascii', pass: 'lidar' }
      : { format: 'radar-csv', pass: 'radar' };
  const geometry = 'width' in expected && (frame.width !== expected.width || frame.height !== expected.height);
  if (frame.pass !== expected.pass || geometry) {
    throw new RenderInputError('native_frame_geometry_mismatch', `the render service returned a ${frame.width}x${frame.height} ${frame.pass} frame for ${encoder.source.outputName} at tick ${tick}; the job asked for ${'width' in expected ? `${expected.width}x${expected.height} ` : ''}${expected.pass}`);
  }
  if (frame.format !== expected.format) {
    throw new RenderInputError('native_frame_format_mismatch', `the render service returned ${frame.format} for ${encoder.source.outputName} at tick ${tick}; expected ${expected.format}`);
  }
}

/** One source's video: its ffmpeg encoder plus the source it encodes. */
interface Encoder {
  readonly source: RenderSourceV3;
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
  readonly video: VideoEncoder;
}

function startEncoder(ffmpeg: string, outputPath: string, source: RenderSourceV3, format: VideoFormat, codec: NativeVideoCodec): Encoder {
  return {
    source, width: format.width, height: format.height, framesPerSecond: format.framesPerSecond,
    video: new VideoEncoder(ffmpeg, outputPath, format, codec),
  };
}

/** `auto` (NVENC where the device can open a session, else libx264), or a fixed codec. */
function videoEncoderPreference(options: NativeRenderEngineOptions): NativeVideoEncoderPreference {
  const requested = options.videoEncoder ?? process.env.SIMFORGE_NATIVE_VIDEO_ENCODER ?? 'auto';
  if (requested !== 'auto' && requested !== 'libx264' && requested !== 'h264_nvenc') {
    throw new Error(`native_video_encoder_invalid: ${requested} (auto | libx264 | h264_nvenc)`);
  }
  return requested;
}

/** Ticks whose raw RGBA frames are dumped for offline comparison (`SIMFORGE_NATIVE_DUMP_TICKS=0,24,95`). */
function dumpTicks(): ReadonlySet<number> {
  const raw = process.env.SIMFORGE_NATIVE_DUMP_TICKS ?? '';
  return new Set(raw.split(',').map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value >= 0));
}

interface SensorArchive {
  readonly path: string;
  readonly writer: StreamingZipWriter;
  receipt: { sha256: string; byteLength: number } | null;
}

/** One zip per structured sensor holding every tick's raw service payload (PLY / CSV). */
async function openSensorArchive(filePath: string): Promise<SensorArchive> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath);
  const sink = new HashedArtifactSink(
    { role: 'sensor-archive', actorId: null, sensorId: null, modality: 'frames' },
    'application/zip',
    {
      write: (chunk) => new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
      close: () => new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => (error ? reject(error) : resolve()))),
      abort: async () => { stream.destroy(); },
    },
  );
  return { path: filePath, writer: new StreamingZipWriter(sink), receipt: null };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

export function createRenderEngine(options: NativeRenderEngineOptions = {}): RenderEngineAdapter {
  const capabilities: EngineCapabilityDeclaration = options.engineVersion
    ? { ...CAPABILITIES, engineVersion: options.engineVersion }
    : CAPABILITIES;
  const binary = resolveBinary(options);

  return {
    capabilities,
    inputPlacement: 'cache',
    selectInputs: selectNativeRenderInputs,
    async execute(context: RenderExecutionContext): Promise<RenderArtifactManifest> {
      const startedAt = new Date().toISOString();
      const wallStarted = performance.now();
      // Stage timings (`timings.stages`): one-off phases, per-tick service
      // stages from each bundle response, and per-tick host stages.
      const startupMs: Record<string, number> = {};
      let phaseStarted = wallStarted;
      const phase = (name: string): void => {
        const now = performance.now();
        startupMs[name] = (startupMs[name] ?? 0) + (now - phaseStarted);
        phaseStarted = now;
      };
      const serverStages = new StageSamples();
      const clientStages = new StageSamples();
      const counters: Record<string, number> = {};
      const tickRecords: string[] = [];
      // Per tick, the exposure each RGB camera metered (dash-cam camera model).
      const exposures: { tick: number; cameras: Record<string, never> }[] = [];
      // Frames whose HDR image had non-finite pixels (a shading bug), per camera.
      const nonFinite: { tick: number; sensorId: string; pixels: number }[] = [];
      await fs.mkdir(context.workspace, { recursive: true });
      const intent = parseRenderIntent(context.intent);
      const sources = intent.renderSpec.sources;
      const unsupported = sources.find((source) => source.modality !== 'rgb' && source.modality !== 'lidar' && source.modality !== 'radar');
      if (unsupported) throw new RenderInputError('native_modality_unsupported', `native retained engine does not render ${unsupported.modality} source ${unsupported.outputName}`);
      assertNativeSourcesSupported(sources);
      assertNativeVideoProfileSupported(intent.renderSpec.video);
      const clipPlanes = nativeCameraClipPlanes(sources);
      // Bundle pipelining needs a ring that holds every published-but-unread
      // bundle: size it from the rig before the service starts.
      const requestedLookahead = options.bundleLookahead
        ?? (process.env.SIMFORGE_NATIVE_BUNDLE_LOOKAHEAD ? Number(process.env.SIMFORGE_NATIVE_BUNDLE_LOOKAHEAD) : NATIVE_BUNDLE_LOOKAHEAD);
      if (!Number.isInteger(requestedLookahead) || requestedLookahead < 0) {
        throw new RenderInputError('native_bundle_lookahead_invalid', `bundle lookahead must be a non-negative integer, got ${requestedLookahead}`);
      }
      const bundleBytes = nativeBundleBytes(sources);
      const shmSizeMb = nativeShmSizeMb(bundleBytes, requestedLookahead, options.shmSizeMb);
      counters.bundleBytes = bundleBytes;
      counters.shmSizeMb = shmSizeMb;
      counters.bundleLookaheadRequested = requestedLookahead;
      // Resolve the encoder before any download or GPU work: a job that
      // cannot encode fails in milliseconds, naming the missing binary.
      const encoderBinary = resolveNativeEncoder(options);
      const encoderIdentity: NativeEncoderIdentity = { ...encoderBinary, version: nativeEncoderVersion(encoderBinary.path) };
      const ffmpeg = encoderIdentity.path;
      const rgbSchedules = context.schedules.filter((schedule) => {
        const source = sources.find((candidate) => candidate.outputName === schedule.sourceId);
        return source?.modality === 'rgb';
      });
      const xoscInput = context.inputs.get('scenario.xosc');
      if (!xoscInput) throw new Error('native render requires scenario.xosc');
      const closure = collectNativeMapMembers(context.inputs.values());
      if (!intent.renderTextures) throw new Error('native_render_texture_profile_missing');
      assertNativeDerivativesDelivered(intent, new Set(closure.members.keys()));
      if (!intent.nativeVramBudgetBytes && !intent.nativeVramCapacityBytes) throw new Error('native_vram_capacity_missing');
      const warnings: { code: string; message: string }[] = [];
      const sensorVideo = nativeSensorVideoFormat(intent);
      // The intent's capacity is the fleet's largest device (or 16 GiB); the
      // device this job holds is measured by the worker. Check against the
      // smaller of the two.
      const vram = nativeVramCapacity(intent.nativeVramCapacityBytes, context.gpuMemory?.totalBytes);
      if (!context.gpuMemory) {
        // No silent default: admission ran on the intent's capacity, and the
        // run says the device itself was never measured, and why.
        const why = context.gpuMemoryUnavailable ?? 'the worker reported no device memory';
        const assumed = intent.nativeVramBudgetBytes ?? intent.nativeVramCapacityBytes;
        warnings.push({ code: 'gpu_memory_unmeasured', message: `device memory was not measured (${why}); admission used the intent's ${intent.nativeVramBudgetBytes !== undefined ? 'explicit budget' : 'assumed fleet capacity'}${assumed !== undefined ? ` of ${(assumed / 1024 ** 3).toFixed(1)} GiB` : ''}` });
        console.error(JSON.stringify({ event: 'native.gpu_memory_unmeasured', jobId: context.jobId, reason: why }));
      }
      const renderRequest = nativeRenderRequest(intent, options);
      const closureSource = {
        sha256: (uri: string) => closure.members.get(uri)?.sha256,
        readText: (uri: string) => fs.readFile(closure.members.get(uri)!.path, 'utf8'),
      };
      const geometryLod = await planNativeGeometryLod(renderRequest.geometryLod, closureSource);
      const roadDecals = await planNativeRoadDecals(closureSource);
      // Per-job mip residency (texture-residency.ts): full-resolution jobs on
      // maps with the ingest-built density derivative upload only the levels
      // their cameras can sample. Admission then waits for the camera poses.
      const residencyDisabled = process.env.SIMFORGE_NATIVE_TEXTURE_RESIDENCY === 'off';
      const textureDensity = intent.renderTextures === 'uastc-full' && !residencyDisabled ? await planNativeTextureDensity(closureSource) : undefined;
      if (residencyDisabled) warnings.push({ code: 'texture_residency_disabled', message: 'SIMFORGE_NATIVE_TEXTURE_RESIDENCY=off: every texture uploads its full mip chain' });
      const framePixels = sources.reduce((sum, source) => sum + (source.modality === 'rgb' ? source.attributes.width * source.attributes.height : sensorVideo.width * sensorVideo.height), 0);
      const textureProfile = await stageNativeTextureProfile({
        closure,
        renderTextures: intent.renderTextures,
        budgetBytes: intent.nativeVramBudgetBytes,
        capacityBytes: vram.capacityBytes,
        framePixels,
        cacheDirectory: options.nativeCacheDirectory,
        extraMembers: [...(geometryLod?.members ?? []), ...(roadDecals?.members ?? [])],
        deferCapacityCheck: textureDensity !== undefined,
      });
      // Fail in seconds, not after a startup timeout, when the device the job
      // holds cannot take the scene at this tier (textures + geometry + frame
      // attachments + reserve, the same estimate the admission check uses).
      if (!textureDensity && context.gpuMemory && textureProfile.estimatedBytes > context.gpuMemory.freeBytes) {
        throw new NativeGpuMemoryError(textureProfile.estimatedBytes, context.gpuMemory, intent.renderTextures);
      }
      phase('textureProfile');
      const masterPath = textureProfile.masterPath;
      await writeJson(path.join(context.workspace, 'native-texture-profile.json'), textureProfile);
      const { masterPath: _stagedPath, transcodeAtLoad, ...stagedEvidence } = textureProfile;
      if (transcodeAtLoad) {
        // Identical pixels, but the service spends minutes of CPU on a map
        // ingest should have pre-transcoded: never silent.
        warnings.push({ code: 'texture_tier_miss', message: `uastc-full textures transcode at load: ${transcodeAtLoad}` });
        console.error(JSON.stringify({ event: 'native.texture_tier_miss', jobId: context.jobId, reason: transcodeAtLoad }));
      }
      const textureEvidence = nativeTextureEvidence(stagedEvidence, vram, intent.nativeVramBudgetBytes !== undefined, context.controlFeatures ?? new Set());
      // Actor appearance is part of the render contract: the intent declares
      // the actor closure as `actors.native-closure`, the worker delivers its
      // bytes, and the closure's members must verify before any frame is
      // rendered. There is no default closure and no proxy downgrade.
      const closureInput = context.inputs.get(NATIVE_ACTOR_ASSETS_INPUT_ID);
      if (!closureInput) throw new Error(`native render requires ${NATIVE_ACTOR_ASSETS_INPUT_ID}`);
      const closureAsset = intent.assets.find((asset) => asset.assetId === NATIVE_ACTOR_ASSETS_INPUT_ID);
      if (!closureAsset || closureAsset.sha256 !== closureInput.sha256 || closureAsset.sizeBytes !== closureInput.sizeBytes) {
        throw new Error(`${NATIVE_ACTOR_ASSETS_INPUT_ID} input does not match the intent's declared actor closure`);
      }
      const actorSource = resolveActorAssets();
      if (!options.actorAssetsBaseUrl && actorSource.state === 'missing') {
        throw new Error(`the pinned actor closure ${actorSource.digest} is not installed (looked in ${actorSource.searched.join(', ')})`);
      }
      // A packaged closure directory already holds `blobs/sha256/<xx>/<sha>`: verify it in place, never copy it.
      const packagedActorRoot = !options.actorAssetsCacheDir && actorSource.state === 'available' && actorSource.source.kind === 'directory'
        ? actorSource.source.root
        : undefined;
      const actorCacheDir = options.actorAssetsCacheDir ?? packagedActorRoot ?? nativeActorAssetsCacheDir(path.join(tmpdir(), 'simforge-actor-assets'));
      const actorAssets = await ensureActorAssets({
        closure: closureInput,
        destination: path.join(context.workspace, 'actor-assets'),
        baseUrl: options.actorAssetsBaseUrl ?? (actorSource.state === 'available' ? actorSource.blobBaseUrl : undefined),
        cacheDir: actorCacheDir,
        // One shared, hard-linked tree per closure digest beside the writable
        // cache instead of a 1.3 GB per-job copy.
        ...(packagedActorRoot ? {} : { treeRoot: path.join(actorCacheDir, 'trees') }),
      });

      phase('actorAssets');
      // The render contract is the render timeline: sample the authoritative
      // trace through the shared sampler. The only other scene source is the
      // explicitly requested legacy replay (`motionSource: 'original-xosc'`,
      // for revisions with no stored trace), recorded as
      // `openscenario-legacy`; it is never chosen because a timeline is absent.
      const timelineInput = context.inputs.get(RENDER_TIMELINE_INPUT_ID);
      const legacyReplay = intent.motionSource === LEGACY_XOSC_MOTION_SOURCE;
      if (legacyReplay && timelineInput) {
        throw new RenderInputError('native_motion_source_conflict', `job ${context.jobId} requests the legacy OpenSCENARIO replay but also declares ${RENDER_TIMELINE_INPUT_ID}`);
      }
      if (!legacyReplay && !timelineInput) {
        throw new RenderInputError('native_render_timeline_missing', `native render requires the ${RENDER_TIMELINE_INPUT_ID} input (the simulation's render timeline); job ${context.jobId} declares none and does not request motionSource '${LEGACY_XOSC_MOTION_SOURCE}'`);
      }
      // The map's ground derivative: the renderer's placement heights and
      // the contact gate both come from it (docs/engineering/ground-height.md).
      const groundMember = closure.members.get(GROUND_MESH_MEMBER);
      let contactGate: ContactGateReport | undefined;
      const applyAttitude = options.applyAttitude !== false;
      let lowering: NativeSceneLowering | NativeTimelineLowering;
      let timelineSha256: string | undefined;
      if (timelineInput) {
        const timelineLowering = await lowerTimelineToNative(await fs.readFile(timelineInput.path), rgbSchedules, { attitude: applyAttitude });
        timelineSha256 = timelineLowering.timelineSha256;
        if (timelineSha256 !== timelineInput.sha256) {
          throw new RenderInputError('render_timeline_digest_mismatch', `${RENDER_TIMELINE_INPUT_ID} bytes ${timelineInput.sha256} are not the canonical timeline ${timelineSha256}`);
        }
        lowering = timelineLowering;
        // Contact gate: every wheel the renderer will draw stands on the
        // rendered ground within 3 cm (docs/engineering/ground-height.md).
        if (groundMember) {
          const opened = await openRenderTimeline(await fs.readFile(timelineInput.path));
          try {
            contactGate = checkTimelineContact(opened, new Uint8Array(await fs.readFile(groundMember.path)));
          } finally {
            opened.free();
          }
          if (!contactGate.pass) {
            const worst = contactGate.failures[0];
            throw new RenderInputError('render_contact_gate_failed', `${contactGate.failureCount} wheel contact(s) off the rendered ground by more than ${contactGate.toleranceM} m; worst ${worst?.actorId} tick ${worst?.tick} ${worst?.contact} gap ${worst?.gapM.toFixed(3)} m`, { failures: contactGate.failures.slice(0, 10) });
          }
        } else {
          warnings.push({ code: 'render_contact_gate_unavailable', message: `the map closure carries no ${GROUND_MESH_MEMBER}; wheel contact was not checked (a map version published before its ground derivative)` });
        }
      } else {
        lowering = lowerOpenScenarioToNative((await fs.readFile(xoscInput.path)).toString('utf8'), xoscInput.sha256, rgbSchedules);
      }
      assertActorAppearanceGrounded(lowering.appearances, intent.sensorHosts, actorAssets);
      assertActorAnimationsBound(lowering.appearances, lowering.states, actorAssets);
      phase('lowering');
      const cameraSchedule = createNativeCameraSchedule(sources, intent.sensorHosts, lowering.states);
      let textureResidency: (NativeTextureResidency & { readonly estimatedBytes: number }) | undefined;
      let residencyPlanPath: string | undefined;
      if (textureDensity) {
        const levels = nativeTextureResidencyLevels(textureDensity.images, cameraSchedule, clipPlanes.nearM);
        const residency = await nativeTextureResidencyPlan({
          closureMasterPath: closure.members.get('master.gltf')!.path,
          stagedMasterPath: textureProfile.masterPath,
          levels,
          density: textureDensity,
        });
        // The deferred admission check, on the textures this job uploads.
        const textureBytes = textureProfile.textureBytes - residency.fullTextureBytes + residency.residentTextureBytes;
        const estimatedBytes = nativeSceneEstimateBytes({ textureBytes, geometryBytes: textureProfile.geometryBytes, framePixels });
        if (estimatedBytes > textureProfile.capacityBytes) throw new NativeTextureCapacityError(estimatedBytes, textureProfile.capacityBytes, textureProfile.capacitySource);
        if (context.gpuMemory && estimatedBytes > context.gpuMemory.freeBytes) {
          throw new NativeGpuMemoryError(estimatedBytes, context.gpuMemory, intent.renderTextures);
        }
        textureResidency = { ...residency, estimatedBytes };
        residencyPlanPath = path.join(context.workspace, 'native-texture-residency.json');
        await writeJson(residencyPlanPath, residency.plan);
        phase('textureResidency');
      }
      const sensorRigs = createNativeSensorRigs(sources, intent.sensorHosts);
      // Lidar and radar videos ride the cameras' fixed-step clock: one frame
      // per simulated tick, so every video of the run is time-locked.
      const wantsSensorArchive = intent.renderSpec.artifacts.includes('sensorArchive');
      const traceRelative = 'trace/native-trace.json';
      const tracePath = path.join(context.workspace, traceRelative);
      const traceDocument = {
        schema: 'simforge.render-trace/v1',
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        sceneSource: lowering.source,
        ...(timelineSha256 ? { timelineSha256 } : {}),
        ...(contactGate ? { contactGate: { pass: contactGate.pass, checked: contactGate.checked, maxAbsGapM: contactGate.maxAbsGapM, unsupported: contactGate.unsupported, groundSha256: contactGate.groundSha256 } } : {}),
        mapId: lowering.mapId,
        fixedTimestepSeconds: lowering.fixedTimestepSeconds,
        frames: lowering.states,
      };
      // Observed per-frame actor transforms (`observe_actors`): what the
      // renderer drew, graded against the shared sampler after the run.
      const observedFrames: string[] = [];

      const scenePath = path.join(context.workspace, 'native-service-scene.json');
      // The scenario's environment as the renderer's physical lighting and
      // the Lookdev Lab's cinematic look: same weather presets, same solar
      // model, same profile. The service meters the sky through each
      // frame's camera on top (`autoMeter`).
      // The sun is placed at the map's own site: its OpenDRIVE geoReference.
      const mapSha256 = intent.scenarioRevision.map.sha256;
      const xodrInput = [...context.inputs.values()].find((input) => input.sha256 === mapSha256);
      if (!xodrInput) {
        throw new RenderInputError('native_lighting_site_unknown', `the map's OpenDRIVE (${mapSha256}) was not delivered with the job; the sun cannot be placed`);
      }
      const site = nativeLightingSiteFromOpenDrive(await fs.readFile(xodrInput.path, 'utf8'), intent.scenarioRevision.map.mapId);
      const resolvedLook = resolveNativeLighting(intent.renderSpec.authoredEnvironment, {
        site,
        cloudFixedStepS: 1 / Math.max(1, ...rgbSchedules.map((schedule) => schedule.framesPerSecond)),
      });
      const look = resolvedLook;
      await writeJson(scenePath, {
        glbs: [masterPath],
        lighting: look.lighting,
        autoMeter: options.autoMeter ?? true,
        nearM: clipPlanes.nearM,
        farM: clipPlanes.farM,
        warmupFrames: 20,
        vehicleModels: actorAssets.directory,
        pedestrianModels: actorAssets.directory,
        render: renderRequest.request,
        textureTier: intent.renderTextures,
        ...(geometryLod ? { geometryLod: path.join(path.dirname(masterPath), NATIVE_GEOMETRY_LOD_MANIFEST) } : {}),
        ...(roadDecals ? { roadDecals: path.join(path.dirname(masterPath), NATIVE_ROAD_DECALS_MANIFEST) } : {}),
        ...(residencyPlanPath ? { textureResidency: residencyPlanPath } : {}),
        ...(groundMember ? { groundMesh: groundMember.path } : {}),
      });
      // Scene load is the longest silent stretch of a large-map job: report
      // it as `preparing` seconds against a budget that scales with the scene.
      const startupTimeoutMs = options.startupTimeoutMs ?? nativeStartupTimeoutMs(textureProfile);
      phase('sceneSpec');
      const loadStarted = performance.now();
      const loadTicker = setInterval(() => {
        const elapsedS = Math.min(startupTimeoutMs / 1000, (performance.now() - loadStarted) / 1000);
        void context.reportProgress({
          schema: 'simforge.render-progress/v1', jobId: context.jobId, attempt: context.attempt, sequence: 0,
          timestamp: new Date().toISOString(), event: 'stage.progress', stage: 'preparing',
          completed: Math.round(elapsedS), total: Math.round(startupTimeoutMs / 1000), unit: 'seconds',
        }).catch(() => undefined);
      }, 10_000);
      let session;
      try {
        session = await startNativeRenderService({
          binary, workspace: context.workspace, jobId: context.jobId, scenePath, signal: context.signal,
          startupTimeoutMs, shmSizeMb,
        });
      } finally {
        clearInterval(loadTicker);
      }
      phase('serviceStart');
      const { client } = session;
      // The look is the service's resolved render config: record exactly
      // what it renders with, not what was asked for.
      if (!client.supports('render_config')) {
        await session.close();
        throw new RenderInputError('native_render_config_unsupported', 'the render service predates the render config; it cannot render the preset this job asks for');
      }
      const renderConfig = session.renderConfig;
      const capture = nativeCaptureEvidence(renderConfig);
      const groundSource = client.ground;
      if (!groundSource) {
        await session.close();
        throw new RenderInputError('native_ground_source_unreported', 'the render service did not report its placement height source at hello (a service that predates the ground derivative)');
      }
      if (groundMember) {
        // The service must place actors on the same surface the gate checked.
        if (!client.supports('ground_mesh') || groundSource.source !== 'ground-mesh') {
          await session.close();
          throw new RenderInputError('native_ground_mesh_unsupported', `the render service did not load ${GROUND_MESH_MEMBER} (reported ${JSON.stringify(groundSource)}); it would place actors on a different ground than the simulator`);
        }
        if (groundSource.sha256 !== groundMember.sha256) {
          await session.close();
          throw new RenderInputError('native_ground_mesh_mismatch', `the render service loaded ground ${groundSource.sha256}, the closure carries ${groundMember.sha256}`);
        }
      } else {
        warnings.push({ code: 'native_ground_legacy_field', message: `the map closure carries no ${GROUND_MESH_MEMBER}; heights for actors without one come from the renderer's legacy mesh field (a map version published before its ground derivative)` });
      }

      const encoders = new Map<string, Encoder>();
      const rasterizers = new Map<string, LidarVideoRasterizer | RadarVideoRasterizer>();
      const archives = new Map<string, SensorArchive>();
      const scheduleBySource = new Map(rgbSchedules.map((schedule) => [schedule.sourceId, schedule]));
      let serverMs = 0;
      const frameIdentities: NativeFrameIdentity[] = [];
      let encodingComplete = false;
      // Host work of tick N (sensor rasterisation, encoder writes, archives)
      // runs while the service renders tick N+1: one tick in flight, strictly
      // in order, so every video and archive receives its frames in tick order.
      let inFlight: Promise<void> | undefined;
      const drainInFlight = async (): Promise<void> => {
        const pending = inFlight;
        inFlight = undefined;
        if (pending) await pending;
      };
      const progressBase = () => ({
        schema: 'simforge.render-progress/v1' as const, jobId: context.jobId, attempt: context.attempt, sequence: 0,
        timestamp: new Date().toISOString(),
      });
      try {
        // A wedged service must fail the job, not hold the GPU (and a
        // heartbeating lease) forever. The first bundle also compiles
        // pipelines, so it gets the longer budget.
        await client.rpc({ op: 'load_scene_state', states: lowering.states }, NATIVE_LOAD_STATE_TIMEOUT_MS);
        phase('loadSceneState');
        const cameras = cameraSchedule;
        await fs.mkdir(path.join(context.workspace, 'video'), { recursive: true });
        // NVENC sessions go to the camera videos first (the heavy encodes);
        // sensor visualisations follow in declaration order.
        const preference = videoEncoderPreference(options);
        const codecs = assignVideoCodecs(
          [...sources.filter((source) => source.modality === 'rgb'), ...sources.filter((source) => source.modality !== 'rgb')].map((source) => source.outputName),
          { preference, nvenc: preference !== 'libx264' && nvencAvailable(ffmpeg), maxSessions: options.nvencMaxSessions ?? DEFAULT_NVENC_MAX_SESSIONS },
        );
        for (const source of sources) {
          const outputPath = path.join(context.workspace, 'video', `${source.outputName}.mp4`);
          const format: VideoFormat = source.modality === 'rgb'
            ? { width: source.attributes.width, height: source.attributes.height, framesPerSecond: source.attributes.fps }
            : sensorVideo;
          encoders.set(source.outputName, startEncoder(ffmpeg, outputPath, source, format, codecs.get(source.outputName)!));
          if (source.modality === 'lidar') {
            rasterizers.set(source.outputName, new LidarVideoRasterizer(format.width, format.height, source.attributes.rangeM, source.transform.position.y));
          } else if (source.modality === 'radar') {
            rasterizers.set(source.outputName, new RadarVideoRasterizer(format.width, format.height, source.attributes.horizontalFovDeg, source.attributes.rangeM));
          }
          if (wantsSensorArchive && source.modality !== 'rgb') {
            archives.set(source.outputName, await openSensorArchive(path.join(context.workspace, 'sensors', `${source.outputName}.zip`)));
          }
        }
        phase('encoderStart');
        const wantedMicros = new Map<string, Set<number>>();
        for (const [sourceId, schedule] of scheduleBySource) wantedMicros.set(sourceId, new Set(scheduleFrameMicros(schedule)));

        const dumps = dumpTicks();
        const dumpDirectory = path.join(context.workspace, 'diagnostics', 'frames');
        if (dumps.size > 0) await fs.mkdir(dumpDirectory, { recursive: true });
        const tickDetails: Record<string, unknown>[] = [];
        type TickItem = { readonly frame: NativeFrameRecord; readonly payload: Buffer };
        const consumeTick = async (tick: number, items: readonly TickItem[], timing: Record<string, number>): Promise<void> => {
          // Start after the tick loop has issued its next request.
          await Promise.resolve();
          const writes: Promise<void>[] = [];
          for (const { frame, payload } of items) {
            const encoder = encoders.get(frame.sensorId)!;
            if (frame.pass === 'lidar' || frame.pass === 'radar') {
              const rasterizer = rasterizers.get(frame.sensorId)!;
              const rasterStarted = performance.now();
              const rgba = rasterizer instanceof LidarVideoRasterizer
                ? rasterizer.frame(parseLidarPly(payload, `lidar ${frame.sensorId} tick ${tick}`))
                : rasterizer.frame(parseRadarCsv(payload, `radar ${frame.sensorId} tick ${tick}`));
              timing.raster = (timing.raster ?? 0) + (performance.now() - rasterStarted);
              // `write` copies the frame: the rasterizer reuses its buffer.
              writes.push(encoder.video.write(rgba));
              const archive = archives.get(frame.sensorId);
              if (archive) {
                const archiveStarted = performance.now();
                const extension = frame.pass === 'lidar' ? 'ply' : 'csv';
                await archive.writer.add(`tick-${String(tick).padStart(6, '0')}.${extension}`, payload, context.signal);
                timing.archive = (timing.archive ?? 0) + (performance.now() - archiveStarted);
              }
              continue;
            }
            const rgba = stripRgbaPadding(payload, frame.width, frame.height);
            if (dumps.has(tick)) await fs.writeFile(path.join(dumpDirectory, `tick-${String(tick).padStart(6, '0')}.${frame.sensorId}.${frame.width}x${frame.height}.rgba`), rgba);
            writes.push(encoder.video.write(rgba));
          }
          const encodeStarted = performance.now();
          await Promise.all(writes);
          timing.encodeWrite = (timing.encodeWrite ?? 0) + (performance.now() - encodeStarted);
        };

        // Bundle pipelining: with requests queued behind the one it is
        // answering, the service submits the next capture before collecting
        // the current one (CPU frame build overlaps GPU work). Needs the
        // service to report observations inside the bundle, and a ring that
        // holds every published-but-unread bundle.
        // The ring was sized for the requested lookahead above. A service
        // without pipelined bundles (an older binary) renders serially: that
        // is recorded (bundleLookaheadRequested vs bundleLookahead), never
        // silent.
        const servicePipelines = client.supports('render_bundle.pipeline') && client.supports('render_bundle.observe');
        const lookahead = requestedLookahead > 0 && servicePipelines ? requestedLookahead : 0;
        if (requestedLookahead > 0 && !servicePipelines) {
          console.warn(JSON.stringify({ event: 'native.bundle_lookahead_unsupported', jobId: context.jobId, requested: requestedLookahead }));
        }
        const bundleBody = (tick: number) => ({
          sim_tick: tick, tick_index: tick, cameras: cameras[tick], passes: ['rgb'], sim_time_s: lowering.frameTimes[tick],
          // The non-camera rig is retained by the service: declare it once.
          ...(tick === 0 && sensorRigs.lidars.length > 0 ? { lidars: sensorRigs.lidars } : {}),
          ...(tick === 0 && sensorRigs.radars.length > 0 ? { radars: sensorRigs.radars } : {}),
          ...(lookahead > 0 ? { pipeline: true, observe: true } : {}),
        });
        const queued: Promise<NativeBundleResponse>[] = [];
        let nextTick = 0;
        const send = () => {
          const tick = nextTick;
          nextTick += 1;
          const sent = client.renderBundle(bundleBody(tick), tick === 0 ? NATIVE_FIRST_BUNDLE_TIMEOUT_MS : NATIVE_BUNDLE_TIMEOUT_MS * (1 + lookahead));
          sent.catch(() => undefined);
          queued.push(sent);
        };
        counters.bundleLookahead = lookahead;

        for (let tick = 0; tick < lowering.states.length; tick += 1) {
          if (context.signal.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error('native render aborted');
          const tickStarted = performance.now();
          const tickClient: Record<string, number> = {};
          const clientStage = (name: string, since: number): number => {
            const now = performance.now();
            tickClient[name] = (tickClient[name] ?? 0) + (now - since);
            return now;
          };
          // Tick 0 (pipeline compile, sensor scenes) goes alone; then keep
          // `lookahead` requests queued behind the one being answered.
          while (nextTick < lowering.states.length && nextTick <= (tick === 0 ? 0 : tick + lookahead)) send();
          const response = await queued.shift()!;
          if (response.frame.simTick !== tick) {
            throw new Error(`native service answered tick ${tick} with a frame for tick ${response.frame.simTick}`);
          }
          serverMs += response.server_ms ?? 0;
          frameIdentities.push(response.frame);
          let clientMark = clientStage('bundleRpc', tickStarted);
          const service = splitServiceStages(response.stages);
          for (const [stage, ms] of Object.entries(service.durations)) serverStages.add(stage, ms);
          serverStages.add('total', response.server_ms ?? 0);
          for (const [counter, value] of Object.entries(service.counts)) counters[counter] = (counters[counter] ?? 0) + value;
          const bundled = response.observed_actors as NativeActorObservation['actors'] | undefined;
          {
            const observation = bundled
              ? { tick: (response.observed_tick as number | null | undefined) ?? null, actors: bundled }
              : lookahead > 0 ? null : await client.observeActors();
            if (observation === null) {
              throw new RenderInputError('native_render_parity_unavailable', `the render service reported no observed actor transforms at tick ${tick}; the render timeline's pose parity cannot be graded`);
            }
            observedFrames.push(JSON.stringify({
              tick, time: lowering.frameTimes[tick],
              actors: observation.actors.map((actor) => ({
                id: actor.id, position: actor.position, rotation: actor.rotation, visible: actor.visible,
                ...(actor.modelPosition ? { modelPosition: actor.modelPosition, modelRotation: actor.modelRotation } : {}),
              })),
            }));
            clientMark = clientStage('observe', clientMark);
          }
          // Copy this tick's payloads out of the shared-memory ring now: the
          // next bundle reuses it while this tick is still being encoded.
          const frameMicros = Math.round(lowering.frameTimes[tick]! * 1_000_000);
          const items: TickItem[] = [];
          const digests: Record<string, string> = {};
          for (const frame of response.frames) {
            if (frame.pass === 'lidar' || frame.pass === 'radar') {
              if (!encoders.has(frame.sensorId) || !rasterizers.has(frame.sensorId)) throw new Error(`native service returned unknown ${frame.pass} sensor ${frame.sensorId}`);
            } else {
              if (frame.pass !== 'rgb' || !wantedMicros.get(frame.sensorId)?.has(frameMicros)) continue;
              if (!encoders.has(frame.sensorId)) throw new Error(`native service returned unknown camera ${frame.sensorId}`);
            }
            assertFrameMatchesRequest(frame, encoders.get(frame.sensorId)!, tick);
            items.push({ frame, payload: await client.readFrame(frame) });
            digests[`${frame.sensorId}:${frame.pass}`] = frame.digest;
          }
          // Every requested camera frame and every retained lidar/radar must
          // arrive: a missing one would leave its video a frame short (or
          // shifted) instead of failing here, at the tick that lost it.
          for (const [sourceId, micros] of wantedMicros) {
            if (micros.has(frameMicros) && !items.some((item) => item.frame.sensorId === sourceId && item.frame.pass === 'rgb')) {
              throw new RenderInputError('native_frame_missing', `the render service returned no rgb frame for camera ${sourceId} at tick ${tick}`);
            }
          }
          for (const sourceId of rasterizers.keys()) {
            if (!items.some((item) => item.frame.sensorId === sourceId && item.frame.pass !== 'rgb')) {
              throw new RenderInputError('native_frame_missing', `the render service returned no sensor frame for ${sourceId} at tick ${tick}`);
            }
          }
          clientMark = clientStage('read', clientMark);
          await drainInFlight();
          clientMark = clientStage('pipelineWait', clientMark);
          // The exposure each RGB camera metered for this frame (dash-cam camera
          // model): EV100, adjustment, aperture/shutter/ISO/gain.
          const exposure = (response as { exposure?: Record<string, { nonFinitePixels?: number }> }).exposure ?? null; // fallback-ok: a look without the camera model reports no exposure
          if (exposure) {
            // The frame's non-finite (NaN/inf) HDR pixel count rides with the
            // exposure; it is reported on its own (`frameIntegrity`).
            const cameras: Record<string, unknown> = {};
            for (const [sensorId, { nonFinitePixels, ...metered }] of Object.entries(exposure)) {
              if (nonFinitePixels !== undefined && nonFinitePixels > 0) nonFinite.push({ tick, sensorId, pixels: nonFinitePixels });
              cameras[sensorId] = metered;
            }
            exposures.push({ tick, cameras: cameras as Record<string, never> });
          }
          const detail: Record<string, unknown> = { tick, serverMs: response.server_ms ?? null, server: response.stages ?? null, client: tickClient, crc32: digests, exposure };
          tickDetails.push(detail);
          const consumed = consumeTick(tick, items, tickClient);
          // Surfaced by the next drain; never an unhandled rejection meanwhile.
          consumed.catch(() => undefined);
          inFlight = consumed;
          const total = lowering.states.length;
          // Every ~1% (at least each second-ish tick group) and the last tick: enough for a live bar, not a flood.
          if (tick + 1 === total || (tick + 1) % Math.max(1, Math.floor(total / 100)) === 0) {
            await context.reportProgress({ ...progressBase(), event: 'stage.progress', stage: 'rendering', completed: tick + 1, total, unit: 'frames' });
            clientMark = clientStage('progress', clientMark);
          }
          detail.tickMs = performance.now() - tickStarted;
        }
        await drainInFlight();
        for (const detail of tickDetails) {
          clientStages.add('tick', detail.tickMs as number);
          for (const [stage, ms] of Object.entries(detail.client as Record<string, number>)) clientStages.add(stage, ms);
          tickRecords.push(JSON.stringify(detail));
        }
        phase('ticks');
        await context.reportProgress({ ...progressBase(), event: 'stage.progress', stage: 'encoding', completed: 0, total: 1, unit: 'items' });
        await Promise.all([...encoders.values()].map((encoder) => encoder.video.finish()));
        phase('encoderFinish');
        for (const archive of archives.values()) archive.receipt = await archive.writer.close(context.signal);
        phase('archiveClose');
        await context.reportProgress({ ...progressBase(), event: 'stage.progress', stage: 'encoding', completed: 1, total: 1, unit: 'items' });
        encodingComplete = true;
      } finally {
        if (!encodingComplete) {
          await drainInFlight().catch(() => undefined);
          for (const encoder of encoders.values()) encoder.video.abort();
          for (const archive of archives.values()) await archive.writer.abort(new Error('native render did not complete'));
        }
        await session.close();
        phase('serviceClose');
      }

      // The parity gate: with a timeline, every drawn actor must match the
      // shared sampler at its frame time (Bevy: <= 1e-3 m / 0.05 deg).
      if (observedFrames.length !== lowering.states.length) {
        throw new RenderInputError('native_render_parity_unavailable', `observed actor transforms cover ${observedFrames.length} of ${lowering.states.length} ticks; parity cannot be graded`);
      }
      // The explicit legacy replay has no timeline to grade against: it is
      // recorded as scene source `openscenario-legacy` without parity.
      let parity: ParityReport | undefined;
      if (timelineInput) {
        const timeline = await openRenderTimeline(await fs.readFile(timelineInput.path));
        try {
          parity = compareObserved(timeline, observedFrames.join('\n'), {
            name: 'bevy', positionToleranceM: 1e-3, angleToleranceDeg: 0.05,
            frame: 'scene-yup', heightReference: 'ground', compareAttitude: applyAttitude,
          });
        } finally {
          timeline.free();
        }
      }
      const observedRelative = 'trace/observed-frames.jsonl';
      if (observedFrames.length > 0) {
        await fs.mkdir(path.join(context.workspace, 'trace'), { recursive: true });
        await fs.writeFile(path.join(context.workspace, observedRelative), `${observedFrames.join('\n')}\n`);
      }
      await writeJson(tracePath, {
        ...traceDocument,
        ...(observedFrames.length > 0 ? { observedFramesPath: observedRelative, observedFrames: observedFrames.map((line) => JSON.parse(line) as unknown) } : {}),
        parity,
        attitude: applyAttitude ? 'full' : 'yaw-only',
        groundSource,
      });
      const traceDigest = await hashFile(tracePath);
      phase('parityAndTrace');
      if (parity && !parity.pass) {
        throw new RenderInputError('native_render_parity_failed', `max ${parity.maxPositionErrorM.toExponential(3)} m / ${parity.maxHeadingErrorDeg.toFixed(4)} deg heading, ${parity.presenceMismatches} presence mismatches (tolerance 1e-3 m / 0.05 deg)`);
      }

      const videoRecords = [];
      const artifacts: RenderArtifactManifest['artifacts'] = [];
      for (const encoder of [...encoders.values()].sort((left, right) => left.source.outputName.localeCompare(right.source.outputName))) {
        const digest = await hashFile(encoder.video.path);
        const relativePath = path.relative(context.workspace, encoder.video.path);
        const expectedFrames = encoder.source.modality === 'rgb'
          ? scheduleBySource.get(encoder.source.outputName)?.frameCount
          : sensorVideo.frameCount;
        if (expectedFrames === undefined) throw new Error(`native render produced ${encoder.source.outputName} without a schedule`);
        if (encoder.video.frames !== expectedFrames) {
          throw new Error(`native render encoded ${encoder.video.frames} frames for ${encoder.source.outputName}; its schedule requires ${expectedFrames}`);
        }
        videoRecords.push({
          actorId: encoder.source.actorId, sensorId: encoder.source.sensorId, relativePath,
          sensor: {
            ...(encoder.source.sensorLabel ? { label: encoder.source.sensorLabel } : {}),
            role: encoder.source.modality === 'lidar' || encoder.source.modality === 'radar' ? encoder.source.modality : 'camera',
            modality: encoder.source.modality,
            mount: encoder.source.transform,
          },
          width: encoder.width, height: encoder.height,
          framesPerSecond: encoder.framesPerSecond, frameCount: encoder.video.frames,
          sha256: digest.sha256, sizeBytes: digest.sizeBytes,
        });
        artifacts.push({
          identity: { role: 'video', actorId: encoder.source.actorId, sensorId: encoder.source.sensorId, modality: encoder.source.modality },
          relativePath, sha256: digest.sha256, sizeBytes: digest.sizeBytes,
          mediaType: 'video/mp4', frameCount: encoder.video.frames,
        });
        const archive = archives.get(encoder.source.outputName);
        if (archive) {
          if (!archive.receipt) throw new Error(`sensor archive for ${encoder.source.outputName} was not closed`);
          artifacts.push({
            identity: { role: 'sensorArchive', actorId: encoder.source.actorId, sensorId: encoder.source.sensorId, modality: encoder.source.modality },
            relativePath: path.relative(context.workspace, archive.path), sha256: archive.receipt.sha256, sizeBytes: archive.receipt.byteLength,
            mediaType: 'application/zip', frameCount: encoder.video.frames,
          });
        }
      }
      artifacts.push({
        identity: { role: 'trace', actorId: null, sensorId: null, modality: null },
        relativePath: traceRelative, sha256: traceDigest.sha256, sizeBytes: traceDigest.sizeBytes,
        mediaType: 'application/json', frameCount: lowering.states.length,
      });

      // Evidence fields newer than the baseline contract are written only for
      // a control plane that accepts them (an older one parses strictly and
      // would reject the whole job). The trace file is not parsed upstream.
      const features = context.controlFeatures ?? new Set<string>();
      const sceneSourceEvidence = gatedSceneSourceEvidence(features, lowering.source, timelineSha256);
      if (nonFinite.length > 0) {
        // Never silent: the frames are delivered (they print black where the
        // HDR image was not finite), and the run says which ones.
        const total = nonFinite.reduce((sum, frame) => sum + frame.pixels, 0);
        warnings.push({ code: 'non_finite_pixels', message: `${total} non-finite (NaN/inf) pixels before tone mapping in ${nonFinite.length} camera frame(s), first at tick ${nonFinite[0]!.tick} ${nonFinite[0]!.sensorId}` });
        console.error(JSON.stringify({ event: 'native.non_finite_pixels', jobId: context.jobId, total, frames: nonFinite.slice(0, 10) }));
      }
      const nativeManifestRelative = 'manifest/native-render.json';
      const nativeManifestPath = path.join(context.workspace, nativeManifestRelative);
      await writeJson(nativeManifestPath, NativeRenderManifestSchema.parse({
        schema: 'simforge.native-render-manifest/v1',
        textureProfile: textureEvidence,
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        ...sceneSourceEvidence,
        actorAssetsSha256: actorAssets.digest,
        frameCount: lowering.states.length,
        ...(features.has(CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK) ? { capture } : {}),
        ...(features.has(CONTROL_FEATURE_NATIVE_ROAD_DECALS) ? { roadDecals: roadDecals
          ? { manifestSha256: roadDecals.manifestSha256, buildKey: roadDecals.buildKey, opacityScale: roadDecals.opacityScale, materials: roadDecals.materials }
          : null } : {}),
        ...(features.has(CONTROL_FEATURE_NATIVE_TEXTURE_RESIDENCY) ? { textureResidency: textureResidency && textureDensity
          ? {
            densityManifestSha256: textureDensity.manifestSha256, densityBuildKey: textureDensity.buildKey, planSha256: textureResidency.plan.planSha256,
            levelsDropped: [...textureResidency.levelsDropped], fullTextureBytes: textureResidency.fullTextureBytes,
            residentTextureBytes: textureResidency.residentTextureBytes, estimatedBytes: textureResidency.estimatedBytes,
          }
          : null } : {}),
        ...gatedRenderEvidence(features, {
          lighting: look.lighting, autoMeter: options.autoMeter ?? true, provenance: look.provenance,
        }, renderRequest, renderConfig, geometryLod),
        ...(features.has(CONTROL_FEATURE_NATIVE_ENCODER) ? { encoder: {
          ...encoderIdentity,
          videos: [...encoders.values()]
            .sort((left, right) => left.source.outputName.localeCompare(right.source.outputName))
            .map((encoder) => ({
              actorId: encoder.source.actorId,
              sensorId: encoder.source.sensorId,
              codec: encoder.video.codec,
              ...(encoder.video.fellBack ? { startedAs: 'h264_nvenc' as const } : {}),
              args: encoderCodecArgs(encoder.video.codec),
            })),
        } } : {}),
        videos: videoRecords,
      }));
      const nativeManifestDigest = await hashFile(nativeManifestPath);
      artifacts.push({
        identity: { role: 'manifest', actorId: null, sensorId: null, modality: null },
        relativePath: nativeManifestRelative, sha256: nativeManifestDigest.sha256, sizeBytes: nativeManifestDigest.sizeBytes,
        mediaType: 'application/json', frameCount: null,
      });

      phase('evidence');
      const stageTimings: NativeStageTimings = {
        schema: NATIVE_STAGE_TIMINGS_V1_SCHEMA,
        ticks: frameIdentities.length,
        startupMs,
        server: serverStages.summary(),
        client: clientStages.summary(),
        counters,
        encoders: Object.fromEntries([...encoders.values()].map((encoder) => [encoder.source.outputName, encoder.video.codec])),
      };
      // Per-tick detail stays in the workspace (not an uploaded artifact);
      // the summary goes to the worker log and, when accepted, the evidence.
      await fs.mkdir(path.join(context.workspace, 'diagnostics'), { recursive: true });
      await fs.writeFile(path.join(context.workspace, 'diagnostics', 'native-stages.jsonl'), `${tickRecords.join('\n')}\n`);
      console.error(JSON.stringify({ event: 'native.stage_timings', jobId: context.jobId, wallMs: performance.now() - wallStarted, serverMs, ...stageTimings }));
      const diagnosticsRelative = 'diagnostics/native-run.json';
      const diagnosticsPath = path.join(context.workspace, diagnosticsRelative);
      await writeJson(diagnosticsPath, NativeRunDiagnosticsSchema.parse({
        schema: 'simforge.native-run-diagnostics/v1',
        textureProfile: textureEvidence,
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        ...sceneSourceEvidence,
        actorAssetsSha256: actorAssets.digest,
        fixedTimestepSeconds: lowering.fixedTimestepSeconds,
        frameCount: lowering.states.length,
        traceSha256: traceDigest.sha256,
        videoCount: videoRecords.length,
        videos: videoRecords.map(({ actorId, sensorId, frameCount, sha256 }) => ({ actorId, sensorId, frameCount, sha256 })),
        service: { protocol: session.protocol, binary },
        frames: frameIdentities,
        ...(features.has(CONTROL_FEATURE_NATIVE_RENDER_CONFIG) && exposures.length > 0 ? { exposure: exposures } : {}),
        ...(features.has(CONTROL_FEATURE_NATIVE_FRAME_INTEGRITY) && exposures.length > 0 ? { frameIntegrity: nativeFrameIntegrity(nonFinite) } : {}),
        ...(parity && features.has(CONTROL_FEATURE_NATIVE_PARITY) ? { parity: {
          schema: parity.schema, pass: parity.pass, comparedPoses: parity.comparedPoses,
          maxPositionErrorM: parity.maxPositionErrorM, maxHeadingErrorDeg: parity.maxHeadingErrorDeg,
          maxPitchErrorDeg: parity.maxPitchErrorDeg, maxRollErrorDeg: parity.maxRollErrorDeg,
          presenceMismatches: parity.presenceMismatches,
        } } : {}),
        timings: {
          wallMs: performance.now() - wallStarted,
          serverMs,
          ...(features.has(CONTROL_FEATURE_NATIVE_STAGE_TIMINGS) ? { stages: stageTimings } : {}),
        },
      }));
      const diagnosticsDigest = await hashFile(diagnosticsPath);
      artifacts.push({
        identity: { role: 'diagnostics', actorId: null, sensorId: null, modality: null },
        relativePath: diagnosticsRelative, sha256: diagnosticsDigest.sha256, sizeBytes: diagnosticsDigest.sizeBytes,
        mediaType: 'application/json', frameCount: null,
      });

      return {
        schema: 'simforge.render-artifact-manifest/v1',
        intentSha256: context.intentSha256,
        engine: { engineId: NATIVE_RENDER_ENGINE_ID, engineVersion: capabilities.engineVersion, backend: 'native' },
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts,
        warnings,
      };
    },
  };
}
