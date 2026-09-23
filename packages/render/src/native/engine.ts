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
  CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK, CONTROL_FEATURE_NATIVE_PARITY, CONTROL_FEATURE_NATIVE_SCENE_SOURCE, CONTROL_FEATURE_NATIVE_STAGE_TIMINGS,
} from '../worker-control.js';
import { parseRenderIntent, type RenderSourceV3 } from '@simforge-oss/scenario';

import { lowerOpenScenarioToNative, type NativeSceneLowering } from './lowering.js';
import { lowerTimelineToNative } from './timeline-lowering.js';
import { RENDER_TIMELINE_INPUT_ID, compareObserved, openRenderTimeline, type ParityReport } from '../timeline/index.js';
import { createNativeCameraSchedule, createNativeSensorRigs } from './camera-schedule.js';
import { LidarVideoRasterizer, RadarVideoRasterizer, parseLidarPly, parseRadarCsv } from './sensor-video.js';
import { StreamingZipWriter, HashedArtifactSink } from '../web/artifacts.js';
import { stripRgbaPadding, type NativeFrameIdentity, type NativeFrameRecord } from './service-client.js';
import { startNativeRenderService } from './service-process.js';
import { NATIVE_ACTOR_ASSETS_INPUT_ID, assertActorAppearanceGrounded, ensureActorAssets, nativeActorAssetsCacheDir } from './actor-assets.js';
import { NativeRenderManifestSchema, NativeRunDiagnosticsSchema, nativeSensorVideoFormat } from './evidence.js';
import { resolveActorAssets, resolveEncoder, resolveNativeRenderService } from './local-runtime.js';
import { resolveNativeLighting } from './lighting.js';
import { collectNativeMapMembers, isNativeMapMemberInputId, nativeMapMemberInputId, NATIVE_MAP_MASTER_INPUT_ID } from './map-closure.js';
import { NativeGpuMemoryError, nativeStartupTimeoutMs, planNativeTextureMembers, stageNativeTextureProfile } from './texture-profile.js';
import { NATIVE_STAGE_TIMINGS_V1_SCHEMA, StageSamples, splitServiceStages, type NativeStageTimings } from './stage-timings.js';
import {
  DEFAULT_NVENC_MAX_SESSIONS, VideoEncoder, assignVideoCodecs, nvencAvailable,
  type NativeVideoCodec, type NativeVideoEncoderPreference, type VideoFormat,
} from './video-encoder.js';

export const NATIVE_RENDER_ENGINE_ID = 'bevy-retained';
/** Per-RPC budgets for a started service (the start itself scales with the scene: `nativeStartupTimeoutMs`). */
export const NATIVE_LOAD_STATE_TIMEOUT_MS = 300_000;
export const NATIVE_FIRST_BUNDLE_TIMEOUT_MS = 600_000;
export const NATIVE_BUNDLE_TIMEOUT_MS = 120_000;
const NATIVE_ENGINE_VERSION = '0.1.0-rc.65';

export interface NativeRenderEngineOptions {
  /** Path to the retained native-render-service binary. */
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
   * `pinned` (default): one capture per frame, each a function of its scene
   * and simulation time. `free`: the rc.73 update-count semantics, kept for
   * byte-identical comparison. `SIMFORGE_NATIVE_CAPTURE_CLOCK` overrides.
   */
  readonly captureClock?: 'pinned' | 'free';
  /** Cinematic anti-aliasing (`smaa-high`, `taa`, ...); default `NATIVE_DEFAULT_ANTI_ALIAS`. */
  readonly antiAlias?: string;
  /** Jittered samples a pinned TAA capture accumulates (default 4; ignored for other AA). */
  readonly taaSamples?: number;
}

/** Anti-aliasing of the pinned (default) capture clock. */
export const NATIVE_DEFAULT_ANTI_ALIAS = 'smaa-high';
export const NATIVE_DEFAULT_TAA_SAMPLES = 4;
const ANTI_ALIAS_MODES = new Set(['none', 'fxaa', 'smaa-low', 'smaa-medium', 'smaa-high', 'smaa-ultra', 'taa']);

/** The capture semantics a render asks for (engine options, then the worker environment). */
export function nativeCaptureSettings(options: NativeRenderEngineOptions, env: NodeJS.ProcessEnv = process.env): {
  clock: 'pinned' | 'free'; antiAlias: string; samplesPerFrame: number;
} {
  const clock = options.captureClock ?? (env.SIMFORGE_NATIVE_CAPTURE_CLOCK as 'pinned' | 'free' | undefined) ?? 'pinned';
  if (clock !== 'pinned' && clock !== 'free') throw new Error(`native_capture_clock_invalid: ${String(clock)} (pinned | free)`);
  // The free clock is the rc.73 look, byte for byte: its TAA and nothing else.
  const antiAlias = clock === 'free' ? 'taa' : options.antiAlias ?? env.SIMFORGE_NATIVE_ANTI_ALIAS ?? NATIVE_DEFAULT_ANTI_ALIAS;
  if (!ANTI_ALIAS_MODES.has(antiAlias)) throw new Error(`native_anti_alias_invalid: ${antiAlias}`);
  const taaSamples = options.taaSamples ?? (env.SIMFORGE_NATIVE_TAA_SAMPLES ? Number(env.SIMFORGE_NATIVE_TAA_SAMPLES) : NATIVE_DEFAULT_TAA_SAMPLES);
  if (!Number.isInteger(taaSamples) || taaSamples < 1 || taaSamples > 16) throw new Error(`native_taa_samples_invalid: ${taaSamples}`);
  return { clock, antiAlias, samplesPerFrame: clock === 'pinned' && antiAlias === 'taa' ? taaSamples : 1 };
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
 * `planNativeTextureMembers`). A closure carries both tiers plus sources the
 * renderer never opens (OpenDRIVE, GeoJSON, reports), so a full-tier render
 * skips the 512 px variants and a `bc7-512` render skips the full images.
 */
export async function selectNativeRenderInputs(context: RenderInputSelectionContext): Promise<ReadonlySet<string>> {
  const intent = parseRenderIntent(context.intent);
  const selected = new Set(context.inputs.filter((input) => !isNativeMapMemberInputId(input.inputId)).map((input) => input.inputId));
  const byPath = new Map(context.inputs.filter((input) => input.relativePath && isNativeMapMemberInputId(input.inputId)).map((input) => [input.relativePath!, input]));
  if (byPath.size === 0) return selected;
  if (!intent.renderTextures) return new Set(context.inputs.map((input) => input.inputId));
  selected.add(NATIVE_MAP_MASTER_INPUT_ID);
  const master = JSON.parse((await context.read(NATIVE_MAP_MASTER_INPUT_ID)).toString('utf8')) as Parameters<typeof planNativeTextureMembers>[0];
  const plan = await planNativeTextureMembers(master, intent.renderTextures, {
    sha256: (uri) => byPath.get(uri)?.sha256,
    readText: async (uri) => (await context.read(nativeMapMemberInputId(uri))).toString('utf8'),
  });
  for (const uri of plan.members) selected.add(nativeMapMemberInputId(uri));
  return selected;
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

export function resolveBinary(options: NativeRenderEngineOptions): string {
  if (options.binary) return options.binary;
  const service = resolveNativeRenderService();
  return service.state === 'available' ? service.path : service.searched[service.searched.length - 1]!;
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

/**
 * Where the service caches static sensor scenes (content-addressed, see
 * `renderer/service`): the worker's persistent cache directory.
 */
function nativeSensorCacheDir(options: NativeRenderEngineOptions): string | undefined {
  const root = process.env.SIMFORGE_NATIVE_SENSOR_CACHE_DIR
    ?? (process.env.SIMFORGE_CACHE_DIR ? path.join(process.env.SIMFORGE_CACHE_DIR, 'native-sensor-scenes') : undefined)
    ?? (options.nativeCacheDirectory ? path.join(path.dirname(options.nativeCacheDirectory), 'native-sensor-scenes') : undefined);
  return root && root.length > 0 ? root : undefined;
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
  const encoder = resolveEncoder();
  const ffmpeg = options.ffmpegBinary ?? (encoder.state === 'available' ? encoder.path : 'ffmpeg');

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
      await fs.mkdir(context.workspace, { recursive: true });
      const intent = parseRenderIntent(context.intent);
      const sources = intent.renderSpec.sources;
      const unsupported = sources.find((source) => source.modality !== 'rgb' && source.modality !== 'lidar' && source.modality !== 'radar');
      if (unsupported) throw new Error(`native retained engine does not render ${unsupported.modality} sources`);
      const rgbSchedules = context.schedules.filter((schedule) => {
        const source = sources.find((candidate) => candidate.outputName === schedule.sourceId);
        return source?.modality === 'rgb';
      });
      const xoscInput = context.inputs.get('scenario.xosc');
      if (!xoscInput) throw new Error('native render requires scenario.xosc');
      const closure = collectNativeMapMembers(context.inputs.values());
      if (!intent.renderTextures) throw new Error('native_render_texture_profile_missing');
      if (!intent.nativeVramBudgetBytes && !intent.nativeVramCapacityBytes) throw new Error('native_vram_capacity_missing');
      const sensorVideo = nativeSensorVideoFormat(intent);
      const textureProfile = await stageNativeTextureProfile({
        closure,
        renderTextures: intent.renderTextures,
        budgetBytes: intent.nativeVramBudgetBytes,
        capacityBytes: intent.nativeVramCapacityBytes,
        framePixels: sources.reduce((sum, source) => sum + (source.modality === 'rgb' ? source.attributes.width * source.attributes.height : sensorVideo.width * sensorVideo.height), 0),
        cacheDirectory: options.nativeCacheDirectory,
      });
      // Fail in seconds, not after a startup timeout, when the device the job
      // holds cannot take the scene at this tier (textures + geometry + frame
      // attachments + reserve, the same estimate the admission check uses).
      if (context.gpuMemory && textureProfile.estimatedBytes > context.gpuMemory.freeBytes) {
        throw new NativeGpuMemoryError(textureProfile.estimatedBytes, context.gpuMemory, intent.renderTextures);
      }
      phase('textureProfile');
      const masterPath = textureProfile.masterPath;
      await writeJson(path.join(context.workspace, 'native-texture-profile.json'), textureProfile);
      const { masterPath: _stagedPath, ...textureEvidence } = textureProfile;
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
      // trace through the shared sampler. Re-lowering the derived xosc is a
      // labelled fallback for execution packages that predate the timeline.
      const timelineInput = context.inputs.get(RENDER_TIMELINE_INPUT_ID);
      const warnings: { code: string; message: string }[] = [];
      let lowering: NativeSceneLowering;
      let timelineSha256: string | undefined;
      let timelineBytes: Uint8Array | undefined;
      const applyAttitude = options.applyAttitude !== false;
      if (timelineInput) {
        timelineBytes = await fs.readFile(timelineInput.path);
        const timelineLowering = await lowerTimelineToNative(timelineBytes, rgbSchedules, { attitude: applyAttitude });
        if (timelineLowering.timelineSha256 !== timelineInput.sha256) {
          throw new Error(`render_timeline_digest_mismatch: ${RENDER_TIMELINE_INPUT_ID} bytes ${timelineInput.sha256} are not the canonical timeline ${timelineLowering.timelineSha256}`);
        }
        lowering = timelineLowering;
        timelineSha256 = timelineLowering.timelineSha256;
      } else {
        const xosc = await fs.readFile(xoscInput.path);
        lowering = lowerOpenScenarioToNative(xosc.toString('utf8'), xoscInput.sha256, rgbSchedules);
        warnings.push({ code: 'scene_source_openscenario_legacy', message: 'no render.timeline input; poses were re-lowered from the derived OpenSCENARIO export' });
      }
      assertActorAppearanceGrounded(lowering.appearances, intent.sensorHosts, actorAssets);
      phase('lowering');
      const cameraSchedule = createNativeCameraSchedule(sources, intent.sensorHosts, lowering.states);
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
        mapId: lowering.mapId,
        fixedTimestepSeconds: lowering.fixedTimestepSeconds,
        frames: lowering.states,
      };
      // Observed per-frame actor transforms (`observe_actors`): what the
      // renderer drew, graded against the shared sampler after the run.
      const observedFrames: string[] = [];
      let observing = true;

      const scenePath = path.join(context.workspace, 'native-service-scene.json');
      // The scenario's environment as the renderer's physical lighting and
      // the Lookdev Lab's cinematic look: same weather presets, same solar
      // model, same profile. The service meters the sky through each
      // frame's camera on top (`autoMeter`).
      const capture = nativeCaptureSettings(options);
      const resolvedLook = resolveNativeLighting(intent.renderSpec.authoredEnvironment, {
        cloudFixedStepS: 1 / Math.max(1, ...rgbSchedules.map((schedule) => schedule.framesPerSecond)),
      });
      const look = {
        ...resolvedLook,
        profileConfig: { ...resolvedLook.profileConfig, cinematic: { ...resolvedLook.profileConfig.cinematic, aa: capture.antiAlias } },
      };
      await writeJson(scenePath, {
        glbs: [masterPath],
        profile: 'cinematic',
        lighting: look.lighting,
        profileConfig: look.profileConfig,
        autoMeter: options.autoMeter ?? true,
        nearM: Math.min(...sources.map((source) => source.modality === 'rgb' ? source.attributes.nearM : 0.05)),
        farM: Math.max(...sources.map((source) => source.modality === 'rgb' ? source.attributes.farM : 1_000)),
        warmupFrames: 20,
        vehicleModels: actorAssets.directory,
        pedestrianModels: actorAssets.directory,
        captureClock: capture.clock,
        taaSamples: capture.samplesPerFrame,
        ...(sensorRigs.lidars.length + sensorRigs.radars.length > 0 && nativeSensorCacheDir(options)
          ? { sensorCacheDir: nativeSensorCacheDir(options) }
          : {}),
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
          startupTimeoutMs, shmSizeMb: options.shmSizeMb,
        });
      } finally {
        clearInterval(loadTicker);
      }
      phase('serviceStart');
      const { client } = session;
      // A service that predates the pinned clock renders update-count frames
      // whatever the scene spec asked for: record what actually ran.
      const captureClock = capture.clock === 'pinned' && !client.supports('capture_clock.pinned') ? 'free' : capture.clock;
      if (captureClock !== capture.clock) {
        warnings.push({ code: 'native_capture_clock_unsupported', message: 'the render service does not pin the capture clock; frames use update-count semantics' });
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
          const writes: Promise<void>[] = [];
          for (const { frame, payload } of items) {
            const encoder = encoders.get(frame.sensorId)!;
            if (frame.pass === 'lidar' || frame.pass === 'radar') {
              const rasterizer = rasterizers.get(frame.sensorId)!;
              const rasterStarted = performance.now();
              const rgba = rasterizer instanceof LidarVideoRasterizer
                ? rasterizer.frame(parseLidarPly(payload))
                : rasterizer.frame(parseRadarCsv(payload));
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

        for (let tick = 0; tick < lowering.states.length; tick += 1) {
          if (context.signal.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error('native render aborted');
          const tickStarted = performance.now();
          const tickClient: Record<string, number> = {};
          const clientStage = (name: string, since: number): number => {
            const now = performance.now();
            tickClient[name] = (tickClient[name] ?? 0) + (now - since);
            return now;
          };
          const response = await client.renderBundle({
            sim_tick: tick, tick_index: tick, cameras: cameras[tick], passes: ['rgb'], sim_time_s: lowering.frameTimes[tick],
            // The non-camera rig is retained by the service: declare it once.
            ...(tick === 0 && sensorRigs.lidars.length > 0 ? { lidars: sensorRigs.lidars } : {}),
            ...(tick === 0 && sensorRigs.radars.length > 0 ? { radars: sensorRigs.radars } : {}),
          }, tick === 0 ? NATIVE_FIRST_BUNDLE_TIMEOUT_MS : NATIVE_BUNDLE_TIMEOUT_MS);
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
          if (observing) {
            const observation = await client.observeActors();
            if (observation === null) {
              observing = false;
              warnings.push({ code: 'native_observation_unavailable', message: 'the render service does not report observed actor transforms; parity was not graded' });
            } else {
              observedFrames.push(JSON.stringify({
                tick, time: lowering.frameTimes[tick],
                actors: observation.actors.map((actor) => ({
                  id: actor.id, position: actor.position, rotation: actor.rotation, visible: actor.visible,
                  ...(actor.modelPosition ? { modelPosition: actor.modelPosition, modelRotation: actor.modelRotation } : {}),
                })),
              }));
            }
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
            items.push({ frame, payload: await client.readFrame(frame) });
            digests[`${frame.sensorId}:${frame.pass}`] = frame.digest;
          }
          clientMark = clientStage('read', clientMark);
          await drainInFlight();
          clientMark = clientStage('pipelineWait', clientMark);
          const detail: Record<string, unknown> = { tick, serverMs: response.server_ms ?? null, server: response.stages ?? null, client: tickClient, crc32: digests };
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
      let parity: ParityReport | undefined;
      if (timelineBytes && observing && observedFrames.length > 0) {
        const timeline = await openRenderTimeline(timelineBytes);
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
        ...(parity ? { parity } : {}),
      });
      const traceDigest = await hashFile(tracePath);
      phase('parityAndTrace');
      if (parity && !parity.pass) {
        throw new Error(`native_render_parity_failed: max ${parity.maxPositionErrorM.toExponential(3)} m / ${parity.maxHeadingErrorDeg.toFixed(4)} deg heading, ${parity.presenceMismatches} presence mismatches (tolerance 1e-3 m / 0.05 deg)`);
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
        ...(features.has(CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK) ? { capture: {
          clock: captureClock === 'pinned' ? 'simulation-time' as const : 'update-count' as const,
          antiAlias: capture.antiAlias,
          samplesPerFrame: captureClock === 'pinned' ? capture.samplesPerFrame : 1,
        } } : {}),
        look: {
          profile: 'cinematic',
          lighting: look.lighting,
          profileConfig: look.profileConfig,
          autoMeter: options.autoMeter ?? true,
          provenance: look.provenance,
        },
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
