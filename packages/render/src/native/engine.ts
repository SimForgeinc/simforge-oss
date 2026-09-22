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
import { parseRenderIntent, type RenderSourceV3 } from '@simforge-oss/scenario';

import { lowerOpenScenarioToNative, type NativeSceneLowering } from './lowering.js';
import { lowerTimelineToNative } from './timeline-lowering.js';
import { RENDER_TIMELINE_INPUT_ID, compareObserved, openRenderTimeline, type ParityReport } from '../timeline/index.js';
import { createNativeCameraSchedule, createNativeSensorRigs } from './camera-schedule.js';
import { LidarVideoRasterizer, RadarVideoRasterizer, parseLidarPly, parseRadarCsv } from './sensor-video.js';
import { StreamingZipWriter, HashedArtifactSink } from '../web/artifacts.js';
import { stripRgbaPadding, type NativeFrameIdentity } from './service-client.js';
import { startNativeRenderService, terminateProcess } from './service-process.js';
import { NATIVE_ACTOR_ASSETS_INPUT_ID, assertActorAppearanceGrounded, ensureActorAssets } from './actor-assets.js';
import { NativeRenderManifestSchema, NativeRunDiagnosticsSchema, nativeSensorVideoFormat } from './evidence.js';
import { resolveActorAssets, resolveEncoder, resolveNativeRenderService } from './local-runtime.js';
import { resolveNativeLighting } from './lighting.js';
import { collectNativeMapMembers } from './map-closure.js';
import { stageNativeTextureProfile } from './texture-profile.js';

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

export function resolveBinary(options: NativeRenderEngineOptions): string {
  if (options.binary) return options.binary;
  const service = resolveNativeRenderService();
  return service.state === 'available' ? service.path : service.searched[service.searched.length - 1]!;
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
      const look = resolveNativeLighting(intent.renderSpec.authoredEnvironment, {
        cloudFixedStepS: 1 / Math.max(1, ...rgbSchedules.map((schedule) => schedule.framesPerSecond)),
      });
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
          }
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
        await fs.writeFile(path.join(context.workspace, observedRelative), `${observedFrames.join('\n')}\n`);
      }
      await writeJson(tracePath, {
        ...traceDocument,
        ...(observedFrames.length > 0 ? { observedFramesPath: observedRelative, observedFrames: observedFrames.map((line) => JSON.parse(line) as unknown) } : {}),
        ...(parity ? { parity } : {}),
      });
      const traceDigest = await hashFile(tracePath);
      if (parity && !parity.pass) {
        throw new Error(`native_render_parity_failed: max ${parity.maxPositionErrorM.toExponential(3)} m / ${parity.maxHeadingErrorDeg.toFixed(4)} deg heading, ${parity.presenceMismatches} presence mismatches (tolerance 1e-3 m / 0.05 deg)`);
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
          sensor: {
            ...(encoder.source.sensorLabel ? { label: encoder.source.sensorLabel } : {}),
            role: encoder.source.modality === 'lidar' || encoder.source.modality === 'radar' ? encoder.source.modality : 'camera',
            modality: encoder.source.modality,
            mount: encoder.source.transform,
          },
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
        textureProfile: textureEvidence,
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        sceneSource: lowering.source,
        ...(timelineSha256 ? { timelineSha256 } : {}),
        actorAssetsSha256: actorAssets.digest,
        frameCount: lowering.states.length,
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

      const diagnosticsRelative = 'diagnostics/native-run.json';
      const diagnosticsPath = path.join(context.workspace, diagnosticsRelative);
      await writeJson(diagnosticsPath, NativeRunDiagnosticsSchema.parse({
        schema: 'simforge.native-run-diagnostics/v1',
        textureProfile: textureEvidence,
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        sceneSource: lowering.source,
        ...(timelineSha256 ? { timelineSha256 } : {}),
        actorAssetsSha256: actorAssets.digest,
        fixedTimestepSeconds: lowering.fixedTimestepSeconds,
        frameCount: lowering.states.length,
        traceSha256: traceDigest.sha256,
        videoCount: videoRecords.length,
        videos: videoRecords.map(({ actorId, sensorId, frameCount, sha256 }) => ({ actorId, sensorId, frameCount, sha256 })),
        service: { protocol: session.protocol, binary },
        frames: frameIdentities,
        ...(parity ? { parity: {
          schema: parity.schema, pass: parity.pass, comparedPoses: parity.comparedPoses,
          maxPositionErrorM: parity.maxPositionErrorM, maxHeadingErrorDeg: parity.maxHeadingErrorDeg,
          maxPitchErrorDeg: parity.maxPitchErrorDeg, maxRollErrorDeg: parity.maxRollErrorDeg,
          presenceMismatches: parity.presenceMismatches,
        } } : {}),
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
        warnings,
      };
    },
  };
}
