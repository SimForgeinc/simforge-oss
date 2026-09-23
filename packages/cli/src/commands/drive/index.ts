import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadMap, readInstance } from '@simforge-oss/compiler/node';
import { canonicalJson, safeParseSimScenarioInput, sha256, type SimScenarioInput } from '@simforge-oss/engine';
import { native as nativeRuntime, type Episode, type FrameRef, type LaneGraph as NativeLaneGraph } from '@simforge-oss/native-runtime';
import type { EnvAction, ObservedSignal } from '@simforge-oss/training-env';
import { resolveNativeLighting, startNativeRenderService, stripRgbaPadding, type NativeServiceSession } from '@simforge-oss/render/native';
import { loadBenchDrivableArea, type ScenarioScoringContext } from '@simforge-oss/evaluation';

import { CliError, EXIT } from '../../errors.js';
import { emit } from '../../output.js';
import { annotateFrame, type HudState } from './hud.js';
import { startLivePreview, type LivePreview } from './live.js';
import { repositoryRoot, stopProcess } from './model-socket.js';
import { RunDirectory, type EpisodeResultCore } from './run-dir.js';
import { HEIGHT, WIDTH, getProfile, type CameraSpec } from './profiles.js';
import { createPolicy, isPolicyId, policyIds } from './policies/index.js';
import type { PolicyObservation, PolicyDecision, SessionActorSnapshot } from './policy.js';
import { actorModelCatalogs, nativeWorldPaths, routeForActor, type Route } from './scene.js';
import { appearanceSpec, startAppearance, type AppearanceSession } from './appearance.js';

const DECISION_HZ = 10;
const HISTORY_STEPS = 64;
/** Always rendered: the HUD video camera, whichever rig the policy uses. */
const MAIN_PROFILE = 'alpamayo-2cam';

type Pose = { readonly tS: number; readonly x: number; readonly y: number; readonly yawRad: number; readonly speedMps: number };

interface CameraFrame {
  readonly sensorId: string;
  readonly pass: string;
  readonly width: number;
  readonly height: number;
  readonly frame: { readonly id: number; readonly format: string };
  readonly enhanceMs?: number;
}


interface EpisodeObservation {
  readonly tS: number;
  readonly stateVector?: number[];
  readonly objects?: readonly { rangeM: number; bearingRad: number; rangeRateMps: number; lineOfSight: boolean }[];
  readonly signals?: readonly ObservedSignal[];
  readonly cameras: readonly CameraFrame[];
}

interface EpisodeSnapshot {
  readonly tS: number;
  readonly egoId: string;
  readonly actors: readonly {
    id: string; kind: string;
    state: { x: number; y: number; headingRad: number; speedMps: number; present: boolean };
  }[];
}

interface EpisodeStep {
  readonly obs: EpisodeObservation;
  readonly dl: { lim: number | null; el: number | null; miss: number; ap: string };
  readonly appliedControl?: { throttle: number; brake: number; steer: number; handbrake: boolean } | null;
}

interface CapturedFrame {
  readonly camera: CameraFrame;
  readonly rgba: Buffer;
}

function snapshotActors(snapshot: EpisodeSnapshot): SessionActorSnapshot[] {
  return snapshot.actors.map(({ id, kind, state }) => ({
    id, kind, x: state.x, y: state.y, yawRad: state.headingRad,
    speedMps: state.speedMps, present: state.present,
  }));
}

function snapshotPose(snapshot: EpisodeSnapshot): Pose {
  const ego = snapshot.actors.find((actor) => actor.id === snapshot.egoId);
  if (!ego) throw new Error(`ego actor ${snapshot.egoId} is absent from Episode snapshot`);
  return { tS: snapshot.tS, x: ego.state.x, y: ego.state.y, yawRad: ego.state.headingRad, speedMps: ego.state.speedMps };
}

/** Translate the policy setpoint/control wire, never execute or choose a fallback. */
function episodeAction(action: EnvAction): Record<string, unknown> {
  if (action.control) return { k: 'c', c: [action.control.throttle, action.control.brake, action.control.steer] };
  return {
    k: 's', speedMps: action.targetSpeedMps, accelerationMps2: action.targetAccelerationMps2,
    motionDirection: action.motionDirection,
    previewPoint: action.previewPoint, previewHeadingRad: action.previewHeadingRad,
  };
}

export interface DriveRunOptions {
  readonly scenario: string;
  readonly policy: string;
  readonly seed: number;
  readonly duration: number;
  readonly out: string;
  readonly live: boolean;
  readonly realtime: boolean;
  readonly deadlineMs: number | null;
  /** Defaults to a per-policy path under the OS temp dir so concurrent heat runs never share a socket. */
  readonly modelSocket?: string;
  readonly noStartModel: boolean;
  readonly noStartRenderer: boolean;
  readonly renderBinary?: string;
  readonly nativeWorld?: string;
  /** CarlaVehicles/CarlaWalkers pack roots; default to the repository catalogs. */
  readonly vehicleModels?: string;
  readonly pedestrianModels?: string;
  readonly quant: string;
  readonly cameraProfile?: string;
  readonly enhance?: string;
  readonly policyInput?: 'raw' | 'enhanced';
  readonly recordControls?: boolean;
  readonly replanHz?: number;
  readonly warmupFrames?: number;
  readonly alpasimStyleScore?: boolean;
  readonly pretty: boolean;
}

interface LoadedDriveScenario {
  readonly input: SimScenarioInput;
  readonly scenarioId: string;
}

async function loadDriveScenario(file: string): Promise<LoadedDriveScenario> {
  let instanceError: unknown;
  try {
    const instance = await readInstance(file);
    return { input: instance.input, scenarioId: path.basename(file, path.extname(file)) };
  } catch (error) {
    instanceError = error;
  }
  let document: unknown;
  try {
    document = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    throw instanceError;
  }
  if (!document || typeof document !== 'object' || !Array.isArray((document as Record<string, unknown>)['instances'])) throw instanceError;
  const instances = (document as Record<string, unknown>)['instances'] as unknown[];
  const first = instances[0];
  let raw = first && typeof first === 'object' && 'input' in first ? (first as Record<string, unknown>)['input'] : first;
  if (typeof raw === 'string') {
    const referenced = JSON.parse(await fs.readFile(path.resolve(path.dirname(file), raw), 'utf8')) as unknown;
    raw = referenced && typeof referenced === 'object' && 'input' in referenced ? (referenced as Record<string, unknown>)['input'] : referenced;
  }
  const parsed = safeParseSimScenarioInput(raw);
  if (!parsed.ok) throw new Error(`scenario episode instance is invalid: ${parsed.issues.map((issue) => issue.path).join(', ')}`);
  const candidateId = (document as Record<string, unknown>)['scenarioId'];
  const scenarioId = typeof candidateId === 'string' ? candidateId : path.basename(file, path.extname(file));
  return { input: parsed.value, scenarioId };
}

function rgbaToRgb(rgba: Buffer, width: number, height: number): Buffer {
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let source = 0, target = 0; source < rgba.length && target < rgb.length; source += 4, target += 3) {
    rgb[target] = rgba[source]!;
    rgb[target + 1] = rgba[source + 1]!;
    rgb[target + 2] = rgba[source + 2]!;
  }
  return rgb;
}

/** Signed lateral offset (m, left positive) from `pose` to the nearest route segment. */
function crossTrackM(route: Route, pose: { x: number; y: number }): number | null {
  let best: number | null = null;
  for (let index = 1; index < route.points.length; index += 1) {
    const [ax, ay] = route.points[index - 1] as [number, number];
    const [bx, by] = route.points[index] as [number, number];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((pose.x - ax) * dx + (pose.y - ay) * dy) / (length * length)));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const signed = ((pose.x - px) * -dy + (pose.y - py) * dx) / length;
    if (best === null || Math.abs(signed) < Math.abs(best)) best = signed;
  }
  return best;
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? null;
}

async function createEncoder(file: string): Promise<{ child: ChildProcess; write(frame: Buffer): Promise<void>; finish(): Promise<void> }> {
  const child = spawn(process.env['SIMFORGE_FFMPEG_BINARY'] ?? 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${WIDTH}x${HEIGHT}`, '-r', String(DECISION_HZ), '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'pipe'] });
  const errors: string[] = [];
  child.stderr?.on('data', (chunk) => errors.push(String(chunk)));
  await once(child, 'spawn');
  return {
    child,
    async write(frame: Buffer) {
      if (!child.stdin) throw new Error('ffmpeg stdin unavailable');
      if (!child.stdin.write(frame)) await once(child.stdin, 'drain');
    },
    async finish() {
      child.stdin?.end();
      const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
      if (code !== 0) throw new Error(`ffmpeg failed: ${errors.join('')}`);
    },
  };
}

export async function runDrive(options: DriveRunOptions): Promise<number> {
  if (!(options.duration > 0) || !Number.isFinite(options.duration)) throw new CliError('bad_value', '--duration must be finite and positive', { path: '--duration' });
  if (options.realtime && (!(options.deadlineMs !== null) || !(options.deadlineMs > 0))) throw new CliError('bad_value', '--realtime requires a positive --deadline-ms', { path: '--deadline-ms' });
  if (!options.realtime && options.deadlineMs !== null) throw new CliError('bad_value', '--deadline-ms is only valid with --realtime', { path: '--deadline-ms' });
  if (!isPolicyId(options.policy)) throw new CliError('bad_value', `unknown --policy ${options.policy}`, { path: '--policy', detail: { known: policyIds() } });
  if (options.policyInput && !['raw', 'enhanced'].includes(options.policyInput)) throw new CliError('bad_value', '--policy-input must be raw or enhanced');
  if (options.policyInput === 'enhanced' && !options.enhance) throw new CliError('bad_value', '--policy-input enhanced requires --enhance');
  if (options.warmupFrames !== undefined && (!Number.isInteger(options.warmupFrames) || options.warmupFrames < 1)) throw new CliError('bad_value', '--warmup-frames must be a positive integer');
  const appearance = options.enhance ? await appearanceSpec(options.enhance) : undefined;
  const scenario = await loadDriveScenario(options.scenario);
  const mapId = scenario.input.mapId;
  const map = await loadMap(mapId);
  if (options.noStartModel && !options.modelSocket) throw new CliError('missing_option', '--no-start-model needs --model-socket pointing at the running endpoint', { path: '--model-socket' });
  const modelSocket = options.modelSocket ?? path.join(os.tmpdir(), `simforge-drive-${options.policy.split(':')[0]}-${process.pid}.sock`);
  const policy = await createPolicy(options.policy, { modelSocket, quant: options.quant, noStartModel: options.noStartModel, replanHz: options.replanHz });
  const policyProfile = options.cameraProfile ?? policy.cameraProfile;
  const policyCameras = getProfile(policyProfile);
  const mainCameras = getProfile(MAIN_PROFILE);
  const cameraById = new Map<string, CameraSpec>();
  for (const camera of [...mainCameras, ...policyCameras]) cameraById.set(camera.sensorId, camera);
  const requiredWarmup = Math.max(1, policy.egoHistorySteps ?? HISTORY_STEPS, policy.historyFrames);
  const warmupFrames = options.warmupFrames ?? requiredWarmup;
  if (warmupFrames < requiredWarmup) throw new CliError('bad_value', `--warmup-frames cannot be less than policy requirement ${requiredWarmup}`);
  const root = repositoryRoot();
  let gitSha = process.env['SIMFORGE_GIT_SHA'];
  if (!gitSha) {
    try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { gitSha = 'unknown'; }
  }
  // Resolved before the run directory so the catalogs the renderer will load
  // are part of the run's recorded provenance, not only its log.
  const actorModels = options.noStartRenderer ? null : await actorModelCatalogs(root, options);
  const run = await RunDirectory.create({
    root: path.resolve(options.out), scenarioId: scenario.scenarioId, mapId, seed: options.seed,
    policyId: policy.id, cameraProfile: policyProfile, decisionHz: DECISION_HZ,
    mode: options.realtime ? 'realtime' : 'offline-simtime',
    deadlineMs: options.realtime ? options.deadlineMs : null,
    durationS: options.duration, warmupFrames, gitSha,
    replanHz: options.replanHz,
    ...(options.alpasimStyleScore ? { scenarioInputSha256: sha256(canonicalJson(scenario.input)), graphDigest: map.graph.digest } : {}),
    ...(appearance ? { appearance: { ...appearance, policyInput: options.policyInput ?? 'raw' } } : {}),
    ...(actorModels ? { actorModels } : {}),
    recordControls: options.recordControls,
  });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'simforge-drive-'));
  const scenePath = path.join(temp, 'scene.json');
  const renderBinary = options.renderBinary ?? process.env['SIMFORGE_NATIVE_RENDER_BINARY'] ?? path.join(root, 'renderer/target/release/native-render-service');
  let renderer: NativeServiceSession | undefined;
  let episode: Episode | undefined;
  let encoder: { child: ChildProcess; write(frame: Buffer): Promise<void>; finish(): Promise<void> } | undefined;
  let live: LivePreview | undefined;
  let enhancement: AppearanceSession | undefined;
  const frameHistory = new Map<string, Buffer[]>();
  const egoHistory: number[][] = [];
  let frameIndex = 0;
  const latencies: number[] = [];
  const planLatencies: number[] = [];
  let policyFallbacks = 0;
  let genuinePlans = 0;
  let invalidPlans = 0;
  let maxPlanAgeS = 0;
  try {
    await run.log(`starting policy=${policy.id} scenario=${options.scenario} map=${mapId} seed=${options.seed}`);
    if (appearance) enhancement = await startAppearance(appearance, temp, run.dir, (line) => { void run.log(line); });
    let renderSocket = process.env['SIMFORGE_NATIVE_RENDER_SOCKET'];
    if (options.noStartRenderer) {
      if (!renderSocket) throw new Error('--no-start-renderer requires SIMFORGE_NATIVE_RENDER_SOCKET');
    } else {
      const world = await nativeWorldPaths(scenario.input, map.graph, root, temp, (message) => run.log(message), options.nativeWorld);
      const conditions = scenario.input.operationalConditions;
      const look = resolveNativeLighting({ weather: conditions.weather === 'rain' ? 'light_rain' : conditions.weather, timeOfDay: conditions.timeOfDay === 'day' ? 'noon' : conditions.timeOfDay, surfacePatches: [] });
      if (!actorModels) throw new Error('actor model catalogs are required to start the renderer');
      await fs.writeFile(scenePath, JSON.stringify({ glbs: world, profile: 'cinematic', lighting: look.lighting, profileConfig: look.profileConfig, autoMeter: true, warmupFrames: 20, nearM: 0.5, farM: 900,
        vehicleModels: actorModels.vehicleModels.directory, pedestrianModels: actorModels.pedestrianModels.directory }));
      renderer = await startNativeRenderService({ binary: renderBinary, workspace: temp, jobId: run.runId, scenePath, signal: new AbortController().signal });
      renderSocket = renderer.socket;
      await run.log(`renderer ready protocol=${renderer.protocol} tiles=${world.length} textureTier=textures-512-bc7 vehicleModels=${actorModels.vehicleModels.directory} (${actorModels.vehicleModels.entries} entries) pedestrianModels=${actorModels.pedestrianModels.directory} (${actorModels.pedestrianModels.entries} entries)`);
      // The service accepts one connection at a time. Episode owns it after readiness.
      await renderer.client.close();
    }
    const runtime = nativeRuntime();
    episode = new runtime.Episode(JSON.stringify({
      scenario: { ...scenario.input, clipSeconds: options.duration + (warmupFrames - 1) / DECISION_HZ },
      seed: options.seed, decisionHz: DECISION_HZ,
      mode: options.realtime ? { kind: 'realtime', deadlineMs: options.deadlineMs, fallback: 'zero-control' } : { kind: 'offline-simtime' },
      warmupDecisions: warmupFrames - 1, maxDecisions: Math.ceil(options.duration * DECISION_HZ),
      observation: { channels: [
        ...(policy.obsPreset === 'visible' ? [{ kind: 'visible' }] : [{ kind: 'state' }, { kind: 'objects' }, { kind: 'signals' }]),
        { kind: 'cameras', rig: { cameras: [...cameraById.values()] }, passes: options.recordControls ? ['rgb', 'depth', 'seg'] : ['rgb'],
          backend: { kind: 'service', socket: renderSocket },
          ...(enhancement ? { enhance: { socket: enhancement.socket, identity: enhancement.identity } } : {}) },
      ] },
    }), map.graph as NativeLaneGraph);
    const egoSource = scenario.input.actors.find((actor) => actor.id === episode!.ego);
    if (!egoSource) throw new Error(`ego actor ${episode.ego} is absent from scenario input`);
    const { hello } = await policy.start({ mapId, graph: map.graph, out: run.dir, log: (message) => { void run.log(message); } });
    const identity = hello && typeof hello === 'object' ? hello as Record<string, unknown> : {};
    const qualificationPath = process.env['SIMFORGE_POLICY_QUALIFICATION'];
    let qualification: Record<string, unknown> | null = null;
    if (qualificationPath) {
      qualification = JSON.parse(await fs.readFile(qualificationPath, 'utf8')) as Record<string, unknown>;
      if (qualification['schema'] !== 'simforge.policy-qualification/v1') throw new Error('invalid policy-server qualification receipt schema');
      const qualifiedModel = qualification['model'] as Record<string, unknown> | undefined;
      if (!qualifiedModel || qualifiedModel['family'] !== identity['family'] || (qualifiedModel['checkpoint_digest'] && qualifiedModel['checkpoint_digest'] !== identity['checkpoint_digest'])) throw new Error('policy-server qualification receipt names a different model/checkpoint');
    }
    encoder = await createEncoder(path.join(run.dir, 'drive.mp4'));
    if (options.live) live = await startLivePreview();

    const capture = (observation: EpisodeObservation, refs: readonly FrameRef[], copy: boolean): CapturedFrame[] => {
      const frames: CapturedFrame[] = [];
      for (const [index, camera] of observation.cameras.entries()) {
        if (!['rgb', 'enhanced', 'seg', 'depth'].includes(camera.pass)
          || camera.frame.format !== (camera.pass === 'depth' ? 'depth32f' : 'rgba8')) throw new Error(`unsupported Episode camera pass/format: ${camera.pass}/${camera.frame.format}`);
        const rgba = stripRgbaPadding(refs[index]!.buffer(), camera.width, camera.height);
        frames.push({ camera, rgba: copy ? Buffer.from(rgba) : rgba });
        if (camera.pass === (options.policyInput === 'enhanced' ? 'enhanced' : 'rgb') && policy.historyFrames > 0 && policyCameras.some((spec) => spec.sensorId === camera.sensorId)) {
          const history = frameHistory.get(camera.sensorId) ?? [];
          history.push(rgbaToRgb(rgba, camera.width, camera.height));
          while (history.length > policy.historyFrames) history.shift();
          frameHistory.set(camera.sensorId, history);
        }
      }
      if (!frames.some(({ camera }) => camera.pass === 'rgb' && camera.sensorId === mainCameras[0]!.sensorId)) throw new Error('Episode main camera frame missing');
      return frames;
    };
    const rememberPose = (pose: Pose): void => {
      if (egoHistory.at(-1)?.[4] !== pose.tS) egoHistory.push([pose.x, pose.y, pose.yawRad, pose.speedMps, pose.tS]);
      while (egoHistory.length > HISTORY_STEPS) egoHistory.shift();
    };
    const encode = async (frames: readonly CapturedFrame[], pose: Pose, decision: PolicyDecision): Promise<void> => {
      await Promise.all(frames.map(({ camera, rgba }) => run.writeFrame(camera.sensorId, frameIndex, rgba, camera.width, camera.height, camera.pass)));
      const main = frames.find(({ camera }) => camera.pass === 'rgb' && camera.sensorId === mainCameras[0]!.sensorId)!;
      const hud: HudState = { policy: policy.id, speedMps: pose.speedMps, latencyMs: decision.latencyMs, step: frameIndex, tS: pose.tS, reasoning: decision.reasoning, trajectory: decision.trajectory, extras: decision.extras };
      const overlay = await annotateFrame(main.rgba, hud);
      await encoder!.write(overlay);
      await live?.write(overlay);
      frameIndex += 1;
    };

    // The kernel advances and renders its prologue. Only image ownership crosses
    // this callback: copied warm-up pixels survive the renderer's bounded ring.
    const warmup: { frames: CapturedFrame[]; pose: Pose }[] = [];
    let observation = JSON.parse(episode.reset((payload: string, refs: FrameRef[]) => {
      try {
        const frame = JSON.parse(payload) as { observation: EpisodeObservation; snapshot: EpisodeSnapshot };
        const pose = snapshotPose(frame.snapshot);
        rememberPose(pose);
        warmup.push({ frames: capture(frame.observation, refs, true), pose });
      } finally {
        for (const ref of refs) ref.release();
      }
    })) as EpisodeObservation;
    const warmupDecision: PolicyDecision = { action: {}, reasoning: { kind: 'text', text: 'warming camera history' }, trajectory: null, latencyMs: 0 };
    for (const frame of warmup) await encode(frame.frames, frame.pose, warmupDecision);
    warmup.length = 0;

    while (!episode.ended) {
      const step = latencies.length;
      const snapshot = JSON.parse(episode.snapshot()) as EpisodeSnapshot;
      const appearanceTiming = enhancement ? { policyInput: options.policyInput ?? 'raw',
        filterMs: Object.fromEntries(observation.cameras.filter((camera) => camera.pass === 'enhanced').map((camera) => [camera.sensorId, camera.enhanceMs])) } : undefined;
      const pose = snapshotPose(snapshot);
      const route = routeForActor(map.graph, egoSource, pose);
      const refs: FrameRef[] = [];
      let decision: PolicyDecision;
      let latencyMs: number;
      rememberPose(pose);
      const priorPose = egoHistory.at(-2);
      const elapsed = priorPose ? pose.tS - priorPose[4]! : 0;
      const yawRate = elapsed > 0 ? Math.atan2(Math.sin(pose.yawRad - priorPose![2]!), Math.cos(pose.yawRad - priorPose![2]!)) / elapsed : 0;
      const trainingObservation = {
        state_vector: observation.stateVector ?? [],
        objects: (observation.objects ?? []).map((object) => [object.rangeM, object.bearingRad, object.rangeRateMps, object.lineOfSight ? 1 : 0, 1]),
        pose, route, motion: [pose.speedMps, yawRate],
      };
      try {
        for (const camera of observation.cameras) refs.push(episode.frame(camera.frame.id));
        const frames = capture(observation, refs, false);
        const policyObservation: PolicyObservation = {
          step, tS: pose.tS, pose, egoHistory: egoHistory.slice(-HISTORY_STEPS),
          frames: Object.fromEntries(frameHistory), frameSize: { width: WIDTH, height: HEIGHT },
          egoId: episode.ego, actors: snapshotActors(snapshot), route,
          nativeObservation: {
            stateVector: observation.stateVector ?? [],
            objects: (observation.objects ?? []).map((object) => [object.rangeM, object.bearingRad, object.rangeRateMps, object.lineOfSight ? 1 : 0, 1]),
            ...(observation.signals ? { signals: observation.signals } : {}),
          },
          mapId, graph: map.graph,
        };
        const started = performance.now();
        decision = await policy.act(policyObservation, options.seed + step);
        latencyMs = Number.isFinite(decision.latencyMs) ? decision.latencyMs : performance.now() - started;
        // HUD/PNG encoding consumes the current observation, never the next tick.
        await encode(frames, pose, { ...decision, latencyMs });
      } finally {
        for (const ref of refs) ref.release();
      }
      const result = JSON.parse(episode.step(JSON.stringify(episodeAction(decision.action)))) as EpisodeStep;
      observation = result.obs;
      const poseAfter = snapshotPose(JSON.parse(episode.snapshot()) as EpisodeSnapshot);
      const miss = result.dl.miss === 1;
      latencies.push(latencyMs);
      if (!decision.extras?.latched) planLatencies.push(latencyMs);
      if (!miss && decision.extras?.fallbackReason) policyFallbacks += 1;
      const plan = decision.extras?.['plan'] as { id?: unknown; anchorTs?: unknown } | undefined;
      if (plan && typeof plan.anchorTs === 'number') maxPlanAgeS = Math.max(maxPlanAgeS, pose.tS - plan.anchorTs);
      if (!decision.extras?.latched && !decision.extras?.fallbackReason && (typeof plan?.id === 'string' || (decision.trajectory && decision.trajectory.length >= 2))) genuinePlans += 1;
      if (decision.trajectory && decision.trajectory.length < 2) invalidPlans += 1;
      await run.writeStep({
        step, tS: poseAfter.tS,
        pose: { x: poseAfter.x, y: poseAfter.y, yawRad: poseAfter.yawRad, speedMps: poseAfter.speedMps },
        action: result.dl.ap === 'zero-control' ? { control: { throttle: 0, brake: 0, steer: 0 } } : decision.action,
        reasoning: decision.reasoning, trajectory: decision.trajectory,
        latencyMs, deadlineMs: result.dl.lim, miss, applied: result.dl.ap,
        crossTrackM: crossTrackM(route, poseAfter), extras: decision.extras ?? {},
        observation: trainingObservation, appliedControl: result.appliedControl ?? null,
        ...(appearanceTiming ? { appearance: appearanceTiming } : {}),
      });
      process.stdout.write(`[drive] policy=${policy.id} step=${step} t=${poseAfter.tS.toFixed(2)} latency_ms=${latencyMs.toFixed(1)} miss=${miss ? 1 : 0} applied=${result.dl.ap} speed_mps=${poseAfter.speedMps.toFixed(2)}\n`);
    }
    const core = JSON.parse(episode.finish()) as EpisodeResultCore;
    await run.writeTrace(episode.traceJson());
    episode.close();
    episode = undefined;
    await encoder.finish();
    await live?.close();
    await policy.stop();
    await stopProcess(enhancement?.child);
    enhancement = undefined;
    if (renderer) {
      await renderer.close();
      await run.log(`renderer stderr:\n${await renderer.readStderr()}`);
      renderer = undefined;
    }
    const actorKinds = Object.fromEntries(scenario.input.actors.map((actor) => [actor.id, actor.kind]));
    const route = routeForActor(map.graph, scenario.input.actors.find((actor) => actor.id === (scenario.input.metricSubject ?? egoSource.id)) ?? scenario.input.actors[0]!, { x: 0, y: 0 });
    let scoringContext: Partial<ScenarioScoringContext> | undefined;
    let authoredRouteLengthM: number | undefined;
    if (options.alpasimStyleScore) {
      const authored = map.graph.route(JSON.stringify(egoSource.behavior.route));
      authoredRouteLengthM = authored.lengthM;
      const authoredRoute: [number, number][] = [];
      for (let s = 0; s < authored.lengthM; s += 2) {
        const pose = authored.poseAt(s);
        authoredRoute.push([pose[0]!, pose[1]!]);
      }
      const end = authored.poseAt(authored.lengthM);
      authoredRoute.push([end[0]!, end[1]!]);
      const cache = process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local/share'), 'simforge/maps');
      const drivableArea = await loadBenchDrivableArea(path.join(cache, 'map-bundles', mapId));
      scoringContext = { metricVersion: 'v2', drivableArea, egoDims: { lengthM: egoSource.dims.l, widthM: egoSource.dims.w }, alpasimStyle: { authoredRoute, egoId: egoSource.id } };
    }
    const modelHealth = {
      decisions: core.decisions, genuinePlans, warmupSteps: core.warmupDecisions + 1,
      sessions: { expected: 1, completed: core.status === 'succeeded' ? 1 : 0 },
      fallbacks: { prologue: 0, closedLoop: core.deadlineMisses + policyFallbacks },
      invalidPlans, timeouts: 0,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
      planLatencyMs: { p50: percentile(planLatencies, 0.5), p95: percentile(planLatencies, 0.95) },
      driveLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
      queueLatencyMs: { p50: null, p95: null },
      deadlineMisses: core.deadlineMisses, maxPlanAgeS,
    };
    const model = {
      family: typeof identity['family'] === 'string' ? identity['family'] : policy.id,
      revision: identity['revision'] ?? identity['code_revision'] ?? null,
      qualification,
      checkpointDigest: identity['checkpoint_digest'] ?? null, quant: identity['quant'] ?? null, hello,
      protocol: identity['protocol'] ?? identity['schema'] ?? 'simforge.policy-endpoint/v2',
    };
    const final = await run.finish({ actorKinds, expectedRouteM: route.remainingM + Math.max(1, options.duration * 8), model, modelHealth, episode: core, scoringContext, authoredRouteLengthM });
    emit({ ok: core.status === 'succeeded', runDir: final.runDir, result: final.resultPath, score: final.scorePath, drivingScore: final.score.drivingScore, policy: policy.id, steps: final.score.steps, traceDigest: core.episodeDigest }, { pretty: options.pretty });
    return core.status === 'succeeded' ? EXIT.ok : EXIT.validationFindings;
  } catch (error) {
    if (episode) await run.writeTrace(episode.traceJson()).catch(() => undefined);
    await run.log(`error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    throw error;
  } finally {
    episode?.close();
    await policy.stop().catch(() => undefined);
    await live?.close().catch(() => undefined);
    await stopProcess(encoder?.child);
    await stopProcess(enhancement?.child);
    if (renderer) await renderer.close().catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

