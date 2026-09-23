import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '@msgpack/msgpack';
import type { PolicyObservation } from './policy.js';
import type { CameraSpec } from './profiles.js';

export const POLICY_ENDPOINT_V3 = 'simforge.policy-endpoint/v3';

/** Current native frames are instantaneous global-shutter pinhole observations. */
export function v3Observation(wire: Record<string, unknown>, obs: PolicyObservation, rig: readonly CameraSpec[]): Record<string, unknown> {
  const anchor = { ts: obs.tS, pose: obs.pose };
  const cameras = (wire['cameras'] as Record<string, unknown>[] | undefined)?.map((camera) => {
    const spec = rig.find((entry) => entry.cameraId === camera['camera_id']);
    if (!spec) throw new Error(`v3 camera has no native rig calibration: ${camera['camera_id']}`);
    const width = Number(camera['width']), height = Number(camera['height']);
    const fx = width / (2 * Math.tan(spec.hfov * Math.PI / 360));
    return { ...camera, calibration: {
      ...(camera['calibration'] as Record<string, unknown> | undefined),
      intrinsics: [[fx, 0, width / 2], [0, fx, height / 2], [0, 0, 1]],
      exposure: { startUs: Math.round(obs.tS * 1e6), endUs: Math.round(obs.tS * 1e6) },
      resize: { from: [spec.width, spec.height], to: [width, height], mode: spec.width === width && spec.height === height ? 'identity' : 'bilinear' },
    } };
  });
  return { ...wire, protocol: POLICY_ENDPOINT_V3, adoptionTick: Math.round(obs.tS * 50),
    ego: { anchor, ageS: 0, valid: true },
    route: { ...(wire['route'] as Record<string, unknown> | undefined), anchor, ageS: 0, valid: obs.route.points.length >= 2 },
    ...(cameras ? { cameras } : {}),
  };
}

export interface ModelResult {
  readonly trajectories?: number[][][];
  readonly reasoning?: unknown;
  readonly timings?: Record<string, number>;
  readonly vram?: Record<string, number>;
  readonly [key: string]: unknown;
}

export interface ModelResponse {
  readonly ok: boolean;
  readonly result?: ModelResult;
  readonly error?: unknown;
  readonly [key: string]: unknown;
}

type Resolver<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

// Node 22 implements `Promise.withResolvers`; the workspace lib (ES2022) does not declare it.
const promiseConstructor = Promise as PromiseConstructor & { withResolvers<T>(): Resolver<T> };

/** Length-prefixed MessagePack endpoint shared by every visual driving model. */
export class ModelSocketClient {
  private buffer = Buffer.alloc(0);
  private pending: Resolver<ModelResponse> | null = null;
  private closed = false;
  protocol: string = 'simforge.policy-endpoint/v2';

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('model socket closed')));
  }

  static async connect(socketPath: string): Promise<ModelSocketClient> {
    const socket = net.createConnection(socketPath);
    await once(socket, 'connect');
    return new ModelSocketClient(socket);
  }

  call(request: Record<string, unknown>): Promise<ModelResponse> {
    if (this.closed) return Promise.reject(new Error('model socket is closed'));
    if (this.pending) return Promise.reject(new Error('model socket only permits one in-flight request'));
    const resolver = promiseConstructor.withResolvers<ModelResponse>();
    this.pending = resolver;
    const payload = Buffer.from(encode(request));
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length, 0);
    this.socket.write(Buffer.concat([header, payload]));
    return resolver.promise.then((response) => {
      if (request['op'] === 'hello' && response.ok) {
        const hello = response.result ?? response;
        this.protocol = hello['protocol'] === POLICY_ENDPOINT_V3 ? POLICY_ENDPOINT_V3 : 'simforge.policy-endpoint/v2';
      }
      return response;
    });
  }

  hello(): Promise<ModelResponse> {
    return this.call({ op: 'hello' });
  }

  async act(obs: Record<string, unknown>, seed: number, params?: Record<string, unknown>, context?: { observation: PolicyObservation; cameras: readonly CameraSpec[] }): Promise<ModelResponse> {
    const v3 = this.protocol === POLICY_ENDPOINT_V3;
    if (v3 && !context) throw new Error('v3 endpoint requires timestamped native observation context');
    const request = v3 ? v3Observation(obs, context!.observation, context!.cameras) : obs;
    const response = await this.call({ op: 'act', obs: request, seed, params: params ?? {} });
    if (!v3 || !response.ok) return response;
    const result = response.result;
    const plan = result?.['plan'] as Record<string, unknown> | undefined;
    const health = result?.['health'] as Record<string, unknown> | undefined;
    if (!plan || typeof plan['id'] !== 'string' || !plan['id'] || plan['anchorTs'] !== context!.observation.tS || plan['adoptionTick'] !== request['adoptionTick'] || typeof plan['horizonS'] !== 'number' || !Number.isFinite(plan['horizonS']) || plan['horizonS'] <= 0) {
      throw new Error('v3 endpoint returned an invalid plan identity, anchor, horizon or adoption tick');
    }
    if (!health || !['none', 'prologue', 'closedLoop'].includes(String(health['fallback']))) throw new Error('v3 endpoint omitted model health');
    return { ...response, result: { ...result, extras: {
      ...(result?.['extras'] as Record<string, unknown> | undefined), plan, health,
      ...(health['fallback'] !== 'none' ? { fallbackReason: String(health['reason'] ?? health['fallback']) } : {}),
    } } };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending?.reject(new Error('model socket closed'));
    this.pending = null;
    const { promise, resolve } = promiseConstructor.withResolvers<void>();
    this.socket.once('close', () => resolve());
    this.socket.end();
    setTimeout(resolve, 500).unref();
    await promise;
  }

  private fail(error: unknown): void {
    if (!this.pending) return;
    const resolver = this.pending;
    this.pending = null;
    resolver.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 256 * 1024 * 1024) {
        this.fail(new Error(`model response is too large (${length} bytes)`));
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < length + 4) return;
      const value = decode(this.buffer.subarray(4, length + 4)) as ModelResponse;
      this.buffer = this.buffer.subarray(length + 4);
      const resolver = this.pending;
      this.pending = null;
      resolver?.resolve(value);
    }
  }
}

/** Error for a `{ ok: false }` response; endpoints report either a string or a structured error. */
export function modelError(response: ModelResponse, label: string, operation: string): Error | null {
  if (response.ok) return null;
  const detail = typeof response.error === 'string' ? response.error : response.error === undefined ? '' : JSON.stringify(response.error);
  return new Error(`${label} ${operation} failed${detail ? `: ${detail}` : ''}`);
}

/** Workspace root: the checkout that contains `packages/cli` and `adapters/`. */
export function repositoryRoot(): string {
  for (const start of [path.dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
    let current = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        if (statSync(path.join(current, 'packages', 'cli', 'package.json')).isFile()) return current;
      } catch { /* keep walking up */ }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error('could not locate the SimForge repository root (packages/cli/package.json)');
}

/** SIGTERM, wait up to `graceMs` for the exit, then SIGKILL whatever is left. */
export async function stopProcess(child: ChildProcess | undefined, graceMs = 10_000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const { promise, resolve } = promiseConstructor.withResolvers<void>();
  const timer = setTimeout(resolve, graceMs);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
  child.kill('SIGTERM');
  await promise;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

export interface ModelEndpointOptions {
  /** Human label for log lines and errors, e.g. `Alpamayo`. */
  readonly label: string;
  readonly socketPath: string;
  /** `bash <script> ...args` starts the endpoint; omit when the socket is already served. */
  readonly server?: { readonly script: string; readonly args: readonly string[]; readonly env?: NodeJS.ProcessEnv };
  readonly log: (line: string) => void;
  /** Override the plain `{ op: 'hello' }` handshake, e.g. to send a lane graph once per connection. */
  readonly hello?: Record<string, unknown>;
  readonly startTimeoutMs?: number;
}

export interface ModelEndpoint {
  readonly client: ModelSocketClient;
  /** The endpoint's `hello.result` (or the raw response when it has none). */
  readonly hello: unknown;
  stop(): Promise<void>;
}

async function waitForSocket(socketPath: string, child: ChildProcess | undefined, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(`${label} server exited with ${child.exitCode}`);
    const entry = await fs.stat(socketPath).catch(() => null);
    if (entry?.isSocket()) return;
    if (Date.now() >= deadline) throw new Error(`${label} server did not create ${socketPath}`);
    await sleep(100);
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = promiseConstructor.withResolvers<void>();
  setTimeout(resolve, ms).unref();
  return promise;
}

/**
 * Start (optionally) and connect one model endpoint: spawn the adapter's
 * `run_server.sh`, wait for its Unix socket, connect, and complete `hello`.
 */
export async function openModelEndpoint(options: ModelEndpointOptions): Promise<ModelEndpoint> {
  let server: ChildProcess | undefined;
  if (options.server) {
    await fs.rm(options.socketPath, { force: true }).catch(() => undefined);
    server = spawn('bash', [options.server.script, ...options.server.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.server.env },
    });
    server.stdout?.on('data', (chunk) => options.log(`${options.label}: ${String(chunk).trim()}`));
    server.stderr?.on('data', (chunk) => options.log(`${options.label} stderr: ${String(chunk).trim()}`));
    await waitForSocket(options.socketPath, server, options.label, options.startTimeoutMs ?? 300_000);
  }
  const client = await ModelSocketClient.connect(options.socketPath);
  const response = await client.call(options.hello ?? { op: 'hello' });
  const error = modelError(response, options.label, 'hello');
  if (error) throw error;
  const hello = response.result ?? response;
  options.log(`${options.label} hello: ${JSON.stringify(hello)}`);
  return {
    client,
    hello,
    async stop() {
      await client.close().catch(() => undefined);
      // Nothing may reach the run log after the caller seals it.
      server?.stdout?.removeAllListeners('data');
      server?.stderr?.removeAllListeners('data');
      await stopProcess(server);
      server = undefined;
    },
  };
}
