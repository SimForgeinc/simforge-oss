import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';

import {
  ENGINE_CAPABILITIES_V1_SCHEMA,
  hashFile,
  scheduleFrameMicros,
  type EngineCapabilityDeclaration,
  type RenderArtifactManifest,
  type RenderEngineAdapter,
  type RenderExecutionContext,
  type RenderInputFile,
} from '../index.js';
import {
  GENERIC_CAMERA_PROFILE,
  parseRenderIntent,
  type CameraProfile,
  type RenderSourceV3,
} from '@simforge-oss/scenario';
import { assertEngineSupportsIntent } from '../capabilities.js';

import { lowerOpenScenarioToNative } from './lowering.js';
import { createNativeCameraSchedule, createNativeSensorRigs } from './camera-schedule.js';
import { LidarVideoRasterizer, RadarVideoRasterizer, parseLidarPly, parseRadarCsv } from './sensor-video.js';
import { StreamingZipWriter, HashedArtifactSink } from '../web/artifacts.js';
import { stripRgbaPadding, type NativeFrameIdentity } from './service-client.js';
import { startNativeRenderService, terminateProcess } from './service-process.js';
import { NATIVE_ACTOR_ASSETS_INPUT_ID, assertActorAppearanceGrounded, ensureActorAssets, linkOrCopy } from './actor-assets.js';
import { NativeRenderManifestSchema, NativeRunDiagnosticsSchema, nativeSensorVideoFormat } from './evidence.js';
import { resolveActorAssets, resolveEncoder, resolveNativeRenderService } from './local-runtime.js';
import { resolveNativeLighting } from './lighting.js';
import { NATIVE_MAP_MASTER_PATH, collectNativeMapMembers, type NativeMapClosure } from './map-closure.js';

export const NATIVE_RENDER_ENGINE_ID = 'bevy-retained';
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
   * meter alone. Dataset capture always disables it.
   */
  readonly autoMeter?: boolean;
  /** Where the pinned actor closure's blobs come from; defaults to the installed closure (`resolveActorAssets`). */
  readonly actorAssetsBaseUrl?: string;
  readonly actorAssetsCacheDir?: string;
}

export function resolveNativeCaptureProfile(
  fidelity: 'review' | 'dataset',
  autoMeter?: boolean,
): { profile: 'cinematic' | 'sensor'; autoMeter: boolean } {
  return {
    profile: fidelity === 'dataset' ? 'sensor' : 'cinematic',
    autoMeter: fidelity === 'dataset' ? false : autoMeter ?? true,
  };
}

export function resolveEffectiveCameraProfile(
  requested: CameraProfile,
  captureProfile: 'cinematic' | 'sensor',
): { effective: CameraProfile | null; differences: string[] } {
  if (captureProfile === 'cinematic') {
    return { effective: null, differences: ['cameraProfile: not applied by cinematic review capture'] };
  }
  return {
    effective: GENERIC_CAMERA_PROFILE,
    differences: JSON.stringify(requested) === JSON.stringify(GENERIC_CAMERA_PROFILE)
      ? []
      : ['cameraProfile: generic-rgb@1 sensor profile used instead of requested profile'],
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
    'camera.projection.pinhole',
    'camera.shutter.global',
    'camera.output.linear_rgb',
    'full-mount-rotation',
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

export function resolveBinary(options: NativeRenderEngineOptions): string {
  if (options.binary) return options.binary;
  const service = resolveNativeRenderService();
  return service.state === 'available' ? service.path : service.searched[service.searched.length - 1]!;
}

/**
 * Uses the closure members in place when they already lie at their
 * closure-relative paths under one directory (the ensured local map); only
 * a scattered closure (per-attempt downloads) is linked into the workspace.
 */
async function materializeMapRoot(workspace: string, closure: NativeMapClosure<RenderInputFile>): Promise<string> {
  const master = closure.members.get(NATIVE_MAP_MASTER_PATH)!;
  const sharedRoot = path.dirname(master.path);
  const inPlace = [...closure.members].every(([member, input]) => path.resolve(sharedRoot, member) === path.resolve(input.path));
  if (inPlace) return sharedRoot;
  const mapRoot = path.join(workspace, 'map');
  await fs.rm(mapRoot, { recursive: true, force: true });
  for (const [member, input] of closure.members) {
    await linkOrCopy(input.path, path.join(mapRoot, member));
  }
  return mapRoot;
}

interface Encoder {
  readonly source: RenderSourceV3;
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
  readonly process: ChildProcessByStdio<Writable, null, Readable>;
  readonly path: string;
  readonly stderr: string[];
  readonly completion: Promise<unknown[]>;
  frames: number;
}

interface VideoFormat {
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
}

function startEncoder(ffmpeg: string, outputPath: string, source: RenderSourceV3, format: VideoFormat): Encoder {
  const child = spawn(ffmpeg, [
    '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${format.width}x${format.height}`,
    '-r', String(format.framesPerSecond), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', outputPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr.push(chunk);
    if (stderr.length > 32) stderr.shift();
  });
  return {
    source, width: format.width, height: format.height, framesPerSecond: format.framesPerSecond,
    process: child, path: outputPath, stderr, completion: once(child, 'exit'), frames: 0,
  };
}

async function finishEncoder(encoder: Encoder): Promise<void> {
  encoder.process.stdin.end();
  const [code, signal] = await encoder.completion as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(`ffmpeg exited code=${String(code)} signal=${String(signal)}\n${encoder.stderr.join('')}`);
  }
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
    async execute(context: RenderExecutionContext): Promise<RenderArtifactManifest> {
      const startedAt = new Date().toISOString();
      const wallStarted = performance.now();
      await fs.mkdir(context.workspace, { recursive: true });
      const intent = parseRenderIntent(context.intent);
      assertEngineSupportsIntent(capabilities, intent);
      const captureProfile = resolveNativeCaptureProfile(
        intent.renderSpec.capabilityIntent.fidelity,
        options.autoMeter,
      );
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
      const mapRoot = await materializeMapRoot(context.workspace, closure);
      const masterPath = path.join(mapRoot, NATIVE_MAP_MASTER_PATH);
      const document = JSON.parse(await fs.readFile(masterPath, 'utf8')) as {
        buffers?: Array<{ uri?: string }>;
        images?: Array<{ uri?: string }>;
        textures?: Array<{ source?: number; extensions?: { KHR_texture_basisu?: { source: number } } }>;
      };
      const imageIndices = new Set<number>();
      for (const texture of document.textures ?? []) {
        const source = texture.extensions?.KHR_texture_basisu?.source ?? texture.source;
        if (source !== undefined) imageIndices.add(source);
      }
      const resources = [...(document.buffers ?? [])];
      for (const index of imageIndices) {
        const image = document.images?.[index];
        if (!image) throw new Error(`master references missing image ${index}`);
        resources.push(image);
      }
      for (const resource of resources) {
        if (!resource.uri || resource.uri.startsWith('data:')) continue;
        if (!closure.members.has(resource.uri)) throw new Error(`master references undeclared map member: ${resource.uri}`);
      }
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
      const actorAssets = await ensureActorAssets({
        closure: closureInput,
        destination: path.join(context.workspace, 'actor-assets'),
        baseUrl: options.actorAssetsBaseUrl ?? (actorSource.state === 'available' ? actorSource.blobBaseUrl : undefined),
        // A packaged closure directory already holds `blobs/sha256/<xx>/<sha>`: verify it in place, never copy it.
        cacheDir: options.actorAssetsCacheDir
          ?? (actorSource.state === 'available' && actorSource.source.kind === 'directory'
            ? actorSource.source.root
            : process.env.SIMFORGE_ACTOR_ASSETS_CACHE_DIR ?? path.join(tmpdir(), 'simforge-actor-assets')),
      });

      const xosc = await fs.readFile(xoscInput.path);
      const lowering = lowerOpenScenarioToNative(xosc.toString('utf8'), xoscInput.sha256, rgbSchedules);
      assertActorAppearanceGrounded(lowering.appearances, intent.sensorHosts, actorAssets);
      const cameraSchedule = createNativeCameraSchedule(sources, intent.sensorHosts, lowering.states);
      const sensorRigs = createNativeSensorRigs(sources, intent.sensorHosts);
      // Lidar and radar videos ride the cameras' fixed-step clock: one frame
      // per simulated tick, so every video of the run is time-locked.
      const sensorVideo = nativeSensorVideoFormat(intent);
      const wantsSensorArchive = intent.renderSpec.artifacts.includes('sensorArchive');
      const traceRelative = 'trace/native-trace.json';
      const tracePath = path.join(context.workspace, traceRelative);
      await writeJson(tracePath, {
        schema: 'simforge.render-trace/v1',
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        mapId: lowering.plan.mapId,
        fixedTimestepSeconds: lowering.plan.dt,
        frames: lowering.states,
      });
      const traceDigest = await hashFile(tracePath);

      const scenePath = path.join(context.workspace, 'native-service-scene.json');
      // Dataset capture uses the non-temporal sensor profile; review capture
      // retains the cinematic look. The effective choice is recorded below.
      const look = resolveNativeLighting(intent.renderSpec.authoredEnvironment, {
        cloudFixedStepS: 1 / Math.max(1, ...rgbSchedules.map((schedule) => schedule.framesPerSecond)),
      });
      await writeJson(scenePath, {
        glbs: [masterPath],
        profile: captureProfile.profile,
        lighting: look.lighting,
        profileConfig: look.profileConfig,
        autoMeter: captureProfile.autoMeter,
        nearM: Math.min(...sources.map((source) => source.modality === 'rgb' ? source.attributes.nearM : 0.05)),
        farM: Math.max(...sources.map((source) => source.modality === 'rgb' ? source.attributes.farM : 1_000)),
        warmupFrames: 20,
        vehicleModels: actorAssets.directory,
        pedestrianModels: actorAssets.directory,
      });
      const session = await startNativeRenderService({
        binary, workspace: context.workspace, jobId: context.jobId, scenePath, signal: context.signal,
        startupTimeoutMs: options.startupTimeoutMs, shmSizeMb: options.shmSizeMb,
      });
      const { client } = session;

      const encoders = new Map<string, Encoder>();
      const rasterizers = new Map<string, LidarVideoRasterizer | RadarVideoRasterizer>();
      const archives = new Map<string, SensorArchive>();
      const scheduleBySource = new Map(rgbSchedules.map((schedule) => [schedule.sourceId, schedule]));
      let serverMs = 0;
      const frameIdentities: NativeFrameIdentity[] = [];
      let encodingComplete = false;
      const progressBase = () => ({
        schema: 'simforge.render-progress/v1' as const, jobId: context.jobId, attempt: context.attempt, sequence: 0,
        timestamp: new Date().toISOString(),
      });
      try {
        await client.rpc({ op: 'load_scene_state', states: lowering.states });
        const cameras = cameraSchedule;
        await fs.mkdir(path.join(context.workspace, 'video'), { recursive: true });
        for (const source of sources) {
          const outputPath = path.join(context.workspace, 'video', `${source.outputName}.mp4`);
          const format: VideoFormat = source.modality === 'rgb'
            ? { width: source.attributes.width, height: source.attributes.height, framesPerSecond: source.attributes.fps }
            : sensorVideo;
          encoders.set(source.outputName, startEncoder(ffmpeg, outputPath, source, format));
          if (source.modality === 'lidar') {
            rasterizers.set(source.outputName, new LidarVideoRasterizer(format.width, format.height, source.attributes.rangeM, source.transform.position.y));
          } else if (source.modality === 'radar') {
            rasterizers.set(source.outputName, new RadarVideoRasterizer(format.width, format.height, source.attributes.horizontalFovDeg, source.attributes.rangeM));
          }
          if (wantsSensorArchive && source.modality !== 'rgb') {
            archives.set(source.outputName, await openSensorArchive(path.join(context.workspace, 'sensors', `${source.outputName}.zip`)));
          }
        }
        const wantedMicros = new Map<string, Set<number>>();
        for (const [sourceId, schedule] of scheduleBySource) wantedMicros.set(sourceId, new Set(scheduleFrameMicros(schedule)));

        for (let tick = 0; tick < lowering.states.length; tick += 1) {
          if (context.signal.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error('native render aborted');
          const response = await client.renderBundle({
            sim_tick: tick, tick_index: tick, cameras: cameras[tick], passes: ['rgb'],
            // The non-camera rig is retained by the service: declare it once.
            ...(tick === 0 && sensorRigs.lidars.length > 0 ? { lidars: sensorRigs.lidars } : {}),
            ...(tick === 0 && sensorRigs.radars.length > 0 ? { radars: sensorRigs.radars } : {}),
          });
          if (response.frame.simTick !== tick) {
            throw new Error(`native service answered tick ${tick} with a frame for tick ${response.frame.simTick}`);
          }
          serverMs += response.server_ms ?? 0;
          frameIdentities.push(response.frame);
          const frameMicros = Math.round(lowering.frameTimes[tick]! * 1_000_000);
          for (const frame of response.frames) {
            if (frame.pass === 'lidar' || frame.pass === 'radar') {
              const encoder = encoders.get(frame.sensorId);
              const rasterizer = rasterizers.get(frame.sensorId);
              if (!encoder || !rasterizer) throw new Error(`native service returned unknown ${frame.pass} sensor ${frame.sensorId}`);
              const payload = await client.readFrame(frame);
              const rgba = rasterizer instanceof LidarVideoRasterizer
                ? rasterizer.frame(parseLidarPly(payload))
                : rasterizer.frame(parseRadarCsv(payload));
              if (!encoder.process.stdin.write(rgba)) await once(encoder.process.stdin, 'drain');
              encoder.frames += 1;
              const archive = archives.get(frame.sensorId);
              if (archive) {
                const extension = frame.pass === 'lidar' ? 'ply' : 'csv';
                await archive.writer.add(`tick-${String(tick).padStart(6, '0')}.${extension}`, payload, context.signal);
              }
              continue;
            }
            if (frame.pass !== 'rgb' || !wantedMicros.get(frame.sensorId)?.has(frameMicros)) continue;
            const encoder = encoders.get(frame.sensorId);
            if (!encoder) throw new Error(`native service returned unknown camera ${frame.sensorId}`);
            const rgba = stripRgbaPadding(await client.readFrame(frame), frame.width, frame.height);
            if (!encoder.process.stdin.write(rgba)) await once(encoder.process.stdin, 'drain');
            encoder.frames += 1;
          }
          const total = lowering.states.length;
          // Every ~1% (at least each second-ish tick group) and the last tick: enough for a live bar, not a flood.
          if (tick + 1 === total || (tick + 1) % Math.max(1, Math.floor(total / 100)) === 0) {
            await context.reportProgress({ ...progressBase(), event: 'stage.progress', stage: 'rendering', completed: tick + 1, total, unit: 'frames' });
          }
        }
        await context.reportProgress({ ...progressBase(), event: 'stage.progress', stage: 'encoding', completed: 0, total: 1, unit: 'items' });
        await Promise.all([...encoders.values()].map(finishEncoder));
        for (const archive of archives.values()) archive.receipt = await archive.writer.close(context.signal);
        await context.reportProgress({ ...progressBase(), event: 'stage.progress', stage: 'encoding', completed: 1, total: 1, unit: 'items' });
        encodingComplete = true;
      } finally {
        if (!encodingComplete) {
          for (const encoder of encoders.values()) {
            encoder.process.stdin.destroy();
            terminateProcess(encoder.process);
          }
          for (const archive of archives.values()) await archive.writer.abort(new Error('native render did not complete'));
        }
        await session.close();
      }

      const videoRecords = [];
      const artifacts: RenderArtifactManifest['artifacts'] = [];
      for (const encoder of [...encoders.values()].sort((left, right) => left.source.outputName.localeCompare(right.source.outputName))) {
        const digest = await hashFile(encoder.path);
        const relativePath = path.relative(context.workspace, encoder.path);
        const expectedFrames = encoder.source.modality === 'rgb'
          ? scheduleBySource.get(encoder.source.outputName)?.frameCount
          : sensorVideo.frameCount;
        if (expectedFrames === undefined) throw new Error(`native render produced ${encoder.source.outputName} without a schedule`);
        if (encoder.frames !== expectedFrames) {
          throw new Error(`native render encoded ${encoder.frames} frames for ${encoder.source.outputName}; its schedule requires ${expectedFrames}`);
        }
        videoRecords.push({
          actorId: encoder.source.actorId, sensorId: encoder.source.sensorId, relativePath,
          width: encoder.width, height: encoder.height,
          framesPerSecond: encoder.framesPerSecond, frameCount: encoder.frames,
          sha256: digest.sha256, sizeBytes: digest.sizeBytes,
        });
        artifacts.push({
          identity: { role: 'video', actorId: encoder.source.actorId, sensorId: encoder.source.sensorId, modality: encoder.source.modality },
          relativePath, sha256: digest.sha256, sizeBytes: digest.sizeBytes,
          mediaType: 'video/mp4', frameCount: encoder.frames,
        });
        const archive = archives.get(encoder.source.outputName);
        if (archive) {
          if (!archive.receipt) throw new Error(`sensor archive for ${encoder.source.outputName} was not closed`);
          artifacts.push({
            identity: { role: 'sensorArchive', actorId: encoder.source.actorId, sensorId: encoder.source.sensorId, modality: encoder.source.modality },
            relativePath: path.relative(context.workspace, archive.path), sha256: archive.receipt.sha256, sizeBytes: archive.receipt.byteLength,
            mediaType: 'application/zip', frameCount: encoder.frames,
          });
        }
      }
      artifacts.push({
        identity: { role: 'trace', actorId: null, sensorId: null, modality: null },
        relativePath: traceRelative, sha256: traceDigest.sha256, sizeBytes: traceDigest.sizeBytes,
        mediaType: 'application/json', frameCount: lowering.states.length,
      });

      const nativeManifestRelative = 'manifest/native-render.json';
      const nativeManifestPath = path.join(context.workspace, nativeManifestRelative);
      await writeJson(nativeManifestPath, NativeRenderManifestSchema.parse({
        schema: 'simforge.native-render-manifest/v1',
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        actorAssetsSha256: actorAssets.digest,
        frameCount: lowering.states.length,
        look: {
          profile: captureProfile.profile,
          lighting: look.lighting,
          profileConfig: look.profileConfig,
          autoMeter: captureProfile.autoMeter,
          provenance: look.provenance,
        },
        fidelityMode: intent.renderSpec.capabilityIntent.fidelity,
        cameraProfiles: sources.flatMap((source) => source.modality === 'rgb' ? [{
          actorId: source.actorId,
          sensorId: source.sensorId,
          outputName: source.outputName,
          requested: source.attributes.cameraProfile,
          ...resolveEffectiveCameraProfile(source.attributes.cameraProfile, captureProfile.profile),
        }] : []),
        warnings: [],
        videos: videoRecords,
      }));
      const nativeManifestDigest = await hashFile(nativeManifestPath);
      artifacts.push({
        identity: { role: 'manifest', actorId: null, sensorId: null, modality: null },
        relativePath: nativeManifestRelative, sha256: nativeManifestDigest.sha256, sizeBytes: nativeManifestDigest.sizeBytes,
        mediaType: 'application/json', frameCount: null,
      });

      const diagnosticsRelative = 'diagnostics/native-run.json';
      const diagnosticsPath = path.join(context.workspace, diagnosticsRelative);
      await writeJson(diagnosticsPath, NativeRunDiagnosticsSchema.parse({
        schema: 'simforge.native-run-diagnostics/v1',
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        actorAssetsSha256: actorAssets.digest,
        fixedTimestepSeconds: lowering.plan.dt,
        frameCount: lowering.states.length,
        traceSha256: traceDigest.sha256,
        videoCount: videoRecords.length,
        videos: videoRecords.map(({ actorId, sensorId, frameCount, sha256 }) => ({ actorId, sensorId, frameCount, sha256 })),
        service: { protocol: session.protocol, binary },
        frames: frameIdentities,
        timings: { wallMs: performance.now() - wallStarted, serverMs },
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
        warnings: [],
      };
    },
  };
}
