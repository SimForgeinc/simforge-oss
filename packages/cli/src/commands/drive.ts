import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { decode, encode } from '@msgpack/msgpack';
import sharp from 'sharp';
import { loadMap, readInstance } from '@simforge-oss/compiler/node';
import type { SessionActorSnapshot, SimScenarioInput } from '@simforge-oss/engine';
import { sessions } from '@simforge-oss/training-env/node';
import type { EnvAction, StepResult } from '@simforge-oss/training-env';
import { NativeServiceClient, stripRgbaPadding } from '@simforge-oss/render/native';

import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';

const WIDTH = 512;
const HEIGHT = 384;
const FRAME_DT = 0.1;
const HISTORY_FRAMES = 4;
const HISTORY_STEPS = 16;
type Resolver<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };
function deferred<T>(): Resolver<T> {
  const promiseConstructor = Promise as PromiseConstructor & { withResolvers<T>(): Resolver<T> };
  return promiseConstructor.withResolvers<T>();
}

type CameraSpec = { sensorId: string; cameraId: number; fwd: number; left: number; up: number; yawDeg: number; hfov: number };
const PROFILES: Record<string, readonly CameraSpec[]> = {
  'alpamayo-2cam': [
    { sensorId: 'camera_front_wide_120fov', cameraId: 1, fwd: 2.05, left: 0, up: 1.5, yawDeg: 0, hfov: 120 },
    { sensorId: 'camera_front_tele_30fov', cameraId: 6, fwd: 2.08, left: 0, up: 1.52, yawDeg: 0, hfov: 30 },
  ],
  'alpamayo-4cam': [
    { sensorId: 'camera_cross_left_120fov', cameraId: 0, fwd: 1.9, left: 0.42, up: 1.46, yawDeg: -55, hfov: 120 },
    { sensorId: 'camera_front_wide_120fov', cameraId: 1, fwd: 2.05, left: 0, up: 1.5, yawDeg: 0, hfov: 120 },
    { sensorId: 'camera_cross_right_120fov', cameraId: 2, fwd: 1.9, left: -0.42, up: 1.46, yawDeg: 55, hfov: 120 },
    { sensorId: 'camera_front_tele_30fov', cameraId: 6, fwd: 2.08, left: 0, up: 1.52, yawDeg: 0, hfov: 30 },
  ],
};

export interface DriveOptions {
  readonly file: string;
  readonly map?: string;
  readonly duration: number;
  readonly cameraProfile: string;
  readonly modelSocket: string;
  readonly renderBinary?: string;
  readonly nativeWorld?: string;
  readonly quant: string;
  readonly seed: number;
  readonly out: string;
  readonly deadlineMs: number;
  readonly noStartModel: boolean;
  readonly noStartRenderer: boolean;
  readonly pretty: boolean;
}
function repositoryRoot(): string {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let current = path.resolve(start);
    for (let depth = 0; depth < 6; depth += 1) {
      try { if (statSync(path.join(current, 'packages', 'cli', 'package.json')).isFile()) return current; } catch { /* continue */ }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error('could not locate SimForge repository root');
}
type ModelResult = { trajectories: number[][][]; reasoning: string[]; timings?: Record<string, number>; vram?: Record<string, number> };
type ModelResponse = { ok: boolean; result?: ModelResult; error?: string };
type TrajectoryPlanPoint = {
  readonly x: number;
  readonly y: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly tS: number;
};
type DrivePose = { readonly tS: number; readonly x: number; readonly y: number; readonly yawRad: number; readonly speedMps: number };

function anchorPlanToWorld(points: readonly TrajectoryPlanPoint[], pose: DrivePose): TrajectoryPlanPoint[] {
  const cos = Math.cos(pose.yawRad);
  const sin = Math.sin(pose.yawRad);
  return points.map((point) => ({
    ...point,
    x: pose.x + point.x * cos - point.y * sin,
    y: pose.y + point.x * sin + point.y * cos,
    headingRad: pose.yawRad + point.headingRad,
    tS: pose.tS + point.tS,
  }));
}

class TrajectoryFollower {
  private plan: readonly TrajectoryPlanPoint[] = [];
  private issuedAt = 0;
  setPlan(plan: readonly TrajectoryPlanPoint[], issuedAt: number): void {
    this.plan = plan;
    this.issuedAt = issuedAt;
  }
  command(pose: DrivePose, now: number): {
    targetSpeedMps: number;
    targetAccelerationMps2: number;
    motionDirection: -1 | 1;
    previewPoint: { x: number; y: number };
    previewHeadingRad: number;
    crossTrackErrorM: number;
  } {
    if (this.plan.length === 0) throw new Error("trajectory follower has no plan");
    const preview = this.plan.find((point) => point.tS >= now + 0.35) ?? this.plan.at(-1)!;
    const dx = preview.x - pose.x;
    const dy = preview.y - pose.y;
    const cos = Math.cos(pose.yawRad);
    const sin = Math.sin(pose.yawRad);
    const localY = -dx * sin + dy * cos;
    const targetSpeedMps = preview.speedMps;
    return {
      targetSpeedMps,
      targetAccelerationMps2: Math.max(-8, Math.min(4, (targetSpeedMps - pose.speedMps) / Math.max(0.1, preview.tS - Math.max(now, this.issuedAt)))),
      motionDirection: targetSpeedMps < 0 ? -1 : 1,
      previewPoint: { x: preview.x, y: preview.y },
      previewHeadingRad: preview.headingRad,
      crossTrackErrorM: localY,
    };
  }
}
export interface DriveEncoder { readonly child: ChildProcess; write(frame: Buffer): Promise<void>; finish(): Promise<void>; }
export interface DriveTelemetry {
  schema: 'simforge.alpamayo-drive.v1'; mapId: string; world: readonly string[]; cameraProfile: string; policy: 'alpamayo-1.5'; seed: number;
  durationS: number; steps: number; renderedFrames: number; model: Record<string, unknown>; records: Record<string, unknown>[];
}

function waitForSocket(socketPath: string, child: ChildProcess | undefined, timeoutMs = 300_000): Promise<void> {
  const { promise, resolve, reject } = deferred<void>();
  child?.once('error', reject);
  const deadline = performance.now() + timeoutMs;
  const poll = (): void => {
    if (child?.exitCode !== null && child?.exitCode !== undefined) { reject(new Error(`service exited during startup with code ${child.exitCode}`)); return; }
    fs.stat(socketPath).then((stat) => { if (stat.isSocket()) resolve(); else throw new Error('not a socket'); }).catch(() => {
      if (performance.now() >= deadline) reject(new Error(`service did not create ${socketPath}`)); else setTimeout(poll, 100).unref();
    });
  };
  poll();
  return promise;
}
function stopChild(child: ChildProcess | undefined): void { if (!child || child.exitCode !== null || child.killed) return; child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 10_000).unref(); }

function nativeWorldPaths(mapId: string, explicit?: string): string[] {
  const cache = process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'maps');
  const candidates = [explicit, process.env['SIMFORGE_NATIVE_WORLD'], path.join(cache, '.corpus', mapId, '3d', 'tiles')].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) return [path.resolve(candidate)];
      if (stat.isDirectory()) {
        const glbs = readdirSync(candidate).filter((name) => name.endsWith('.glb') && !name.startsWith('veg_')).sort().map((name) => path.join(candidate, name));
        if (glbs.length > 0) return glbs;
      }
    } catch { /* continue */ }
  }
  throw new CliError('map_not_present', `native world for ${mapId} is unavailable`, { path: '--native-world', detail: { candidates, hint: `run simforge maps pull ${mapId} or pass --native-world <master.gltf-or-tile-directory>` } });
}
function actorClass(kind: string): string { return ({ car: 'car', truck: 'truck', bus: 'bus', motorcycle: 'motorcycle', bicycle: 'bicycle', pedestrian: 'pedestrian' } as Record<string, string>)[kind] ?? 'prop'; }
function catalogId(actor: SimScenarioInput['actors'][number]): string {
  const tagged = actor.tags?.find((tag) => tag.startsWith('catalog:'));
  if (tagged) return tagged.slice('catalog:'.length);
  return ({ pedestrian: 'pedestrian.adult', bicycle: 'cyclist.commuter', truck: 'vehicle.box-truck', bus: 'vehicle.transit-bus', motorcycle: 'vehicle.motorcycle' } as Record<string, string>)[actor.kind] ?? 'vehicle.sedan';
}
function makeSceneState(input: SimScenarioInput, mapId: string, snapshot: { actors: readonly SessionActorSnapshot[] }): Record<string, unknown> {
  const sourceById = new Map(input.actors.map((actor) => [actor.id, actor]));
  return { version: 'scene-state.v1', mapId, tick: 0, tickHz: 1 / input.dt, actors: snapshot.actors.filter((actor) => actor.present).map((actor) => {
    const source = sourceById.get(actor.id); const yaw = actor.yawRad;
    return { id: actor.id, kind: 'update', catalogId: source ? catalogId(source) : 'vehicle.sedan', actorClass: source ? actorClass(source.kind) : 'car', transform: { position: [actor.x, 0, -actor.y], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] }, velocity: [actor.speedMps * Math.cos(yaw), 0, -actor.speedMps * Math.sin(yaw)] };
  }) };
}
function cameras(profile: string, actorId: string): Record<string, unknown>[] {
  return PROFILES[profile]!.map((spec) => {
    const vfov = 2 * Math.atan(Math.tan(spec.hfov * Math.PI / 360) / (WIDTH / HEIGHT)) * 180 / Math.PI;
    return {
      sensorId: spec.sensorId, width: WIDTH, height: HEIGHT, fovDeg: vfov,
      eye: [0, 0, 0], target: [1, 0, 0],
      attach: { actorId, offsetM: [spec.fwd, -spec.left, spec.up], yawDeg: spec.yawDeg, pitchDeg: 0 },
    };
  });
}
function rgbaToRgb(rgba: Buffer, width: number, height: number): Buffer {
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source]!;
    rgb[target + 1] = rgba[source + 1]!;
    rgb[target + 2] = rgba[source + 2]!;
  }
  return rgb;
}
export function egoHistoryAtPose(positions: readonly number[][], pose: { x: number; y: number; yawRad: number }): number[][] {
  const source = positions.slice(-HISTORY_STEPS);
  const first = source[0] ?? [pose.x, pose.y, 0];
  const padded = [...Array(Math.max(0, HISTORY_STEPS - source.length)).fill(first), ...source] as number[][];
  const cos = Math.cos(pose.yawRad);
  const sin = Math.sin(pose.yawRad);
  return padded.map((point) => {
    const dx = point[0]! - pose.x;
    const dy = point[1]! - pose.y;
    return [dx * cos + dy * sin, -dx * sin + dy * cos, point[2] ?? 0];
  });
}

class AlpamayoClient {
  private readonly socket: net.Socket; private buffer = Buffer.alloc(0); private pending: { resolve: (value: ModelResponse) => void; reject: (reason: Error) => void } | null = null;
  private constructor(socket: net.Socket) { this.socket = socket; socket.on('data', (chunk) => this.receive(chunk)); socket.on('error', (error) => this.pending?.reject(error)); }
  static async connect(socketPath: string): Promise<AlpamayoClient> { const socket = net.createConnection(socketPath); await once(socket, 'connect'); return new AlpamayoClient(socket); }
  call(request: Record<string, unknown>): Promise<ModelResponse> { if (this.pending) return Promise.reject(new Error('Alpamayo request already in flight')); const { promise, resolve, reject } = deferred<ModelResponse>(); this.pending = { resolve, reject }; const payload = Buffer.from(encode(request)); const header = Buffer.allocUnsafe(4); header.writeUInt32LE(payload.length); this.socket.write(Buffer.concat([header, payload])); return promise; }
  hello(): Promise<ModelResponse> { return this.call({ op: 'hello' }); }
  act(obs: Record<string, unknown>, seed: number): Promise<ModelResponse> { return this.call({ op: 'act', obs, seed, params: { num_traj_samples: 1 } }); }
  close(): void { this.socket.end(); }
  private receive(chunk: Buffer): void { this.buffer = Buffer.concat([this.buffer, chunk]); while (this.buffer.length >= 4) { const length = this.buffer.readUInt32LE(0); if (this.buffer.length < length + 4) return; const value = decode(this.buffer.subarray(4, length + 4)) as ModelResponse; this.buffer = this.buffer.subarray(length + 4); const pending = this.pending; this.pending = null; pending?.resolve(value); } }
}
export function decodeAlpamayoTrajectory(raw: number[][]): { points: TrajectoryPlanPoint[]; display: number[][] } {
  if (raw.length < 2 || raw.some((point) => point.length < 2 || point.some((value) => !Number.isFinite(value)))) {
    throw new Error('Alpamayo trajectory contains too few or invalid coordinates');
  }
  const points = raw.map((point, index) => {
    const previous = raw[Math.max(0, index - 1)]!;
    const dx = point[0]! - previous[0]!;
    const dy = point[1]! - previous[1]!;
    return {
      x: point[0]!, y: point[1]!, headingRad: Math.atan2(dy, dx),
      speedMps: (index === 0 ? Math.hypot(point[0]!, point[1]!) : Math.hypot(dx, dy)) / FRAME_DT,
      tS: (index + 1) * FRAME_DT,
    };
  });
  return { points, display: raw.map((point) => [point[0]!, point[1]!]) };
}
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
async function annotate(raw: Buffer, prediction: number[][] | null, text: string): Promise<Buffer> {
  const points = prediction ?? []; const minX = Math.min(0, ...points.map((p) => p[0]!)); const maxX = Math.max(1, ...points.map((p) => p[0]!)); const minY = Math.min(-1, ...points.map((p) => p[1]!)); const maxY = Math.max(1, ...points.map((p) => p[1]!)); const poly = points.map((p) => `${260 + ((p[0]! - minX) / (maxX - minX)) * 220},${350 - ((p[1]! - minY) / (maxY - minY)) * 100}`).join(' ');
  const svg = `<svg width="${WIDTH}" height="${HEIGHT}"><rect x="8" y="8" width="500" height="42" rx="4" fill="#000" fill-opacity=".72"/><text x="16" y="27" fill="white" font-size="12" font-family="monospace">${xml(text.slice(0, 78))}</text><text x="16" y="43" fill="#9fe8ff" font-size="10" font-family="monospace">Alpamayo 1.5 closed loop</text><rect x="250" y="245" width="250" height="130" rx="4" fill="#000" fill-opacity=".55"/><polyline points="${poly}" fill="none" stroke="#ffdc5e" stroke-width="2"/><circle cx="260" cy="350" r="3" fill="#ff5555"/></svg>`;
  return sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).composite([{ input: Buffer.from(svg) }]).raw().toBuffer();
}
async function createEncoder(file: string): Promise<DriveEncoder> {
  const child = spawn(process.env['SIMFORGE_FFMPEG_BINARY'] ?? 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${WIDTH}x${HEIGHT}`, '-r', '10', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'pipe'] });
  const errors: string[] = []; child.stderr?.on('data', (chunk) => errors.push(String(chunk))); const { promise, resolve, reject } = deferred<void>(); child.once('spawn', resolve); child.once('error', reject); await promise;
  return { child, async write(frame) { if (!child.stdin?.write(frame)) await once(child.stdin, 'drain'); }, async finish() { child.stdin?.end(); const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]; if (code !== 0) throw new Error(`ffmpeg failed: ${errors.join('')}`); } };
}

export async function drive(options: DriveOptions): Promise<number> {
  if (!(options.duration > 0) || !Number.isFinite(options.duration)) throw new CliError('bad_value', '--duration must be finite and positive', { path: '--duration' });
  const instance = await readInstance(options.file); const mapId = options.map ?? instance.input.mapId; if (mapId !== instance.input.mapId) throw new CliError('bad_value', `instance map is ${instance.input.mapId}, not ${mapId}`, { path: '--map' }); const map = await loadMap(mapId); const world = nativeWorldPaths(mapId, options.nativeWorld); const profile = PROFILES[options.cameraProfile]; if (!profile) throw new CliError('bad_value', `unknown --camera-profile ${options.cameraProfile}`, { path: '--camera-profile', detail: { known: Object.keys(PROFILES) } });
  const root = repositoryRoot();
  const outputDir = path.resolve(root, options.out);
  await fs.mkdir(outputDir, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'simforge-drive-'));
  const renderSocket = path.join(temp, 'render.sock');
  const shmPath = path.join(temp, 'render.shm');
  const scenePath = path.join(temp, 'scene.json');
  const videoPath = path.join(outputDir, 'alpamayo-drive.mp4');
  const telemetryPath = path.join(outputDir, 'alpamayo-drive.json');
  await fs.writeFile(scenePath, JSON.stringify({ glbs: world, profile: 'sensor', warmupFrames: 20, nearM: 0.5, farM: 900 }));
  const renderBinary = options.renderBinary ?? process.env['SIMFORGE_NATIVE_RENDER_BINARY'] ?? path.join(root, 'renderer/target/release/native-render-service'); const modelScript = path.join(root, 'adapters/alpamayo/scripts/run_server.sh'); let renderer: ChildProcess | undefined; let modelServer: ChildProcess | undefined; let native: NativeServiceClient | undefined; let model: AlpamayoClient | undefined; let encoder: DriveEncoder | undefined;
  const telemetry: DriveTelemetry = { schema: 'simforge.alpamayo-drive.v1', mapId, world, cameraProfile: options.cameraProfile, policy: 'alpamayo-1.5', seed: options.seed, durationS: options.duration, steps: 0, renderedFrames: 0, model: {}, records: [] };
  try {
    if (!options.noStartRenderer) {
      renderer = spawn(renderBinary, ['--scene', scenePath, '--socket', renderSocket, '--shm', shmPath, '--shm-size-mb', '512'], { stdio: ['ignore', 'ignore', 'pipe'] });
      await waitForSocket(renderSocket, renderer);
    }
    native = await NativeServiceClient.connect(renderSocket);
    telemetry.model.renderer = await native.rpc({ op: 'hello' });
    if (!options.noStartModel) {
      modelServer = spawn('bash', [modelScript, '--family', 'alpamayo-1.5', '--quant', options.quant, '--socket', options.modelSocket], { stdio: ['ignore', 'ignore', 'pipe'] });
      await waitForSocket(options.modelSocket, modelServer);
    }
    model = await AlpamayoClient.connect(options.modelSocket);
    const modelHello = await model.hello();
    if (!modelHello.ok) throw new Error(modelHello.error ?? 'Alpamayo hello failed');
    telemetry.model.alpamayo = modelHello;
    encoder = await createEncoder(videoPath);
    const env = sessions().env({ input: instance.input, graph: map.graph, episode: { decisionHz: 10, clipSeconds: options.duration, maxDecisions: Math.ceil(options.duration * 10), observation: { stateVector: true, bev: null } } });
    let result: StepResult = env.reset(options.seed);
    let snapshot = env.snapshot();
    if (!snapshot) throw new Error('simulation did not produce an initial snapshot');
    const frameHistory = new Map<string, Buffer[]>();
    const egoHistory: number[][] = [];
    let prediction: number[][] | null = null;
    let reasoning = 'warming camera history';
    let renderTick = 0;
    const renderCurrent = async (): Promise<void> => {
      const pose = env.egoPose();
      snapshot = env.snapshot();
      if (!snapshot) throw new Error('missing simulation snapshot');
      await native!.rpc({ op: 'load_scene_state', states: [makeSceneState(instance.input, mapId, snapshot)] });
      const response = await native!.rpc({ op: 'render_bundle', sim_tick: renderTick++, tick_index: 0, cameras: cameras(options.cameraProfile, env.ego), passes: ['rgb'] });
      telemetry.renderedFrames += 1;
      let mainRgba: Buffer | undefined;
      for (const spec of profile) {
        const frame = response.frames?.find((candidate) => candidate.sensorId === spec.sensorId && candidate.pass === 'rgb');
        if (!frame) throw new Error(`Bevy did not return RGB frame for ${spec.sensorId}`);
        const rgba = stripRgbaPadding(await native!.readFrame(frame), frame.width, frame.height);
        if (spec.sensorId === profile[0]!.sensorId) mainRgba = rgba;
        const history = frameHistory.get(spec.sensorId) ?? [];
        history.push(rgbaToRgb(rgba, frame.width, frame.height));
        while (history.length > HISTORY_FRAMES) history.shift();
        frameHistory.set(spec.sensorId, history);
      }
      const ego = snapshot.actors.find((actor) => actor.id === env.ego);
      if (!ego) throw new Error('ego actor missing from render state');
      egoHistory.push([ego.x, ego.y, 0]);
      while (egoHistory.length > HISTORY_STEPS) egoHistory.shift();
      await encoder!.write(await annotate(mainRgba!, prediction, `${reasoning} | t=${pose.tS.toFixed(1)}s`));
    };
    for (let i = 0; i < HISTORY_FRAMES; i += 1) await renderCurrent();
    for (let step = 0; step < Math.ceil(options.duration * 10) && !result.terminated && !result.truncated; step += 1) {
      const pose = env.egoPose();
      const cameraObs = profile.map((spec) => {
        const history = frameHistory.get(spec.sensorId) ?? [];
        return { camera_id: spec.cameraId, frames: [...Array(Math.max(0, HISTORY_FRAMES - history.length)).fill(history[0]!), ...history], encoding: 'raw', width: WIDTH, height: HEIGHT };
      });
      const started = performance.now();
      const response = await model.act({ cameras: cameraObs, ego_history_xyz: egoHistoryAtPose(egoHistory, pose) }, options.seed + step);
      const elapsedMs = performance.now() - started;
      if (!response.ok || !response.result) throw new Error(response.error ?? 'Alpamayo act failed');
      const raw = response.result.trajectories[0];
      if (!raw) throw new Error('Alpamayo returned no trajectory');
      const decoded = decodeAlpamayoTrajectory(raw);
      const follower = new TrajectoryFollower();
      follower.setPlan(anchorPlanToWorld(decoded.points, pose), pose.tS);
      const command = follower.command(pose, pose.tS);
      const miss = elapsedMs > options.deadlineMs;
      const applied = miss ? 'zero-control' : 'policy';
      const action: EnvAction = miss ? { control: { throttle: 0, brake: 0, steer: 0 } } : {
        targetSpeedMps: command.targetSpeedMps,
        targetAccelerationMps2: command.targetAccelerationMps2,
        motionDirection: command.motionDirection,
        previewPoint: command.previewPoint,
        previewHeadingRad: command.previewHeadingRad,
      };
      reasoning = response.result.reasoning?.[0] ?? 'no reasoning returned';
      prediction = decoded.display;
      telemetry.records.push({ step, elapsedMs, deadlineMs: options.deadlineMs, miss, applied, reasoning, trajectoryFirst: raw[0], trajectoryLast: raw.at(-1), pose: { ...pose }, crossTrackM: command.crossTrackErrorM, modelTimings: response.result.timings, modelVram: response.result.vram });
      result = env.step(action);
      telemetry.steps += 1;
      await renderCurrent();
    }
    await encoder.finish();
    await fs.writeFile(telemetryPath, `${JSON.stringify({ ...telemetry, outputVideo: videoPath }, null, 2)}\n`);
    emit({ ok: true, ...telemetry, outputVideo: videoPath, telemetry: telemetryPath, mapLoaded: true, worldLoaded: true }, options);
    return EXIT.ok;
  } finally {
    model?.close();
    if (native) await native.close().catch(() => undefined);
    stopChild(encoder?.child);
    stopChild(modelServer);
    stopChild(renderer);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}
