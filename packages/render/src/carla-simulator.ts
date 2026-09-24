import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

import { scrubbedLogTail } from './log-scrub.js';

/**
 * An on-demand CARLA (UE) server owned by the worker process.
 *
 * A resident UE server holds ~6.5 GiB of VRAM whether or not it renders, so a
 * GPU shared with another engine cannot keep one up permanently. The worker
 * therefore starts the server when it leases a CARLA job, reuses it for the
 * jobs that follow, and stops it after `idleStopMs` without a job (or at once
 * when a co-tenant job takes the GPU, see `releaseGpuResidency`).
 *
 * Failing to start is loud and final for the attempt: the job fails with a
 * `carla_simulator_*` code naming why (occupied port, early exit, no answer
 * within `readyTimeoutMs`). Nothing falls back to another engine or to a
 * server this worker did not start (docs/engineering/no-silent-fallbacks.md).
 */
export interface CarlaSimulatorOptions {
  /** The server launcher, e.g. `/home/carla/CarlaUnreal.sh`. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly host: string;
  readonly port: number;
  /** How long a cold start may take before the job fails. */
  readonly readyTimeoutMs: number;
  /** A server without a job for this long is stopped. */
  readonly idleStopMs: number;
  /**
   * The argv that proves the server answers (a client handshake), run after
   * the RPC port accepts; `{host}` and `{port}` are substituted. `null` trusts
   * the TCP accept alone (tests).
   */
  readonly handshake?: readonly string[] | null;
  /** SIGTERM grace before the process group is killed. */
  readonly stopGraceMs?: number;
  readonly log?: (event: Record<string, unknown>) => void;
}

export type CarlaSimulatorErrorCode =
  | 'carla_simulator_port_occupied'
  | 'carla_simulator_spawn_failed'
  | 'carla_simulator_exited'
  | 'carla_simulator_start_timeout';

export class CarlaSimulatorError extends Error {
  constructor(
    readonly code: CarlaSimulatorErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CarlaSimulatorError';
  }
}

export type CarlaSimulatorStart =
  | { readonly cold: true; readonly coldStartMs: number; readonly residentSince: string }
  | { readonly cold: false; readonly residentSince: string };

export interface CarlaSimulatorResidency {
  readonly residentSince: string;
  readonly pid: number;
}

export const DEFAULT_CARLA_HANDSHAKE: readonly string[] = [
  'python3', '-c',
  'import sys, carla\n'
  + 'client = carla.Client(sys.argv[1], int(sys.argv[2]))\n'
  + 'client.set_timeout(5.0)\n'
  + 'sys.stdout.write(client.get_server_version())\n',
  '{host}', '{port}',
];

const OUTPUT_CAPTURE_CHARS = 16_384;

function portAccepts(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function runHandshake(argv: readonly string[], host: string, port: number, timeoutMs = 10_000): Promise<boolean> {
  const [command, ...args] = argv.map((part) => part.replaceAll('{host}', host).replaceAll('{port}', String(port)));
  if (!command) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class CarlaSimulator {
  private child: ChildProcess | undefined;
  private exit: Promise<void> | undefined;
  private residentSince: Date | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private output = '';
  private outputTruncated = false;
  private readonly handshake: readonly string[] | null;
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly killOnExit = (): void => this.signalGroup('SIGKILL');

  constructor(private readonly options: CarlaSimulatorOptions) {
    this.handshake = options.handshake === undefined ? DEFAULT_CARLA_HANDSHAKE : options.handshake;
    this.log = options.log ?? ((event) => console.error(JSON.stringify(event)));
  }

  /** The running server, or null when none is up. */
  residency(): CarlaSimulatorResidency | null {
    const child = this.child;
    if (!child || !this.alive(child) || !this.residentSince || child.pid === undefined) return null;
    return { residentSince: this.residentSince.toISOString(), pid: child.pid };
  }

  /** A serving server for the job about to run: the resident one, else a cold start. */
  async ensureRunning(signal: AbortSignal): Promise<CarlaSimulatorStart> {
    this.clearIdle();
    const child = this.child;
    if (child && this.alive(child) && this.residentSince) {
      if (await this.answers()) return { cold: false, residentSince: this.residentSince.toISOString() };
      // Up but not answering (hung): never render through it; start afresh.
      await this.stop('resident server stopped answering');
    }
    return this.coldStart(signal);
  }

  /** Called when a job ends: the server stays warm for `idleStopMs`, then stops. */
  markIdle(): void {
    this.clearIdle();
    if (!this.residency()) return;
    this.idleTimer = setTimeout(() => {
      void this.stop(`idle for ${Math.round(this.options.idleStopMs / 1000)} s`);
    }, this.options.idleStopMs);
    this.idleTimer.unref();
  }

  async stop(reason: string): Promise<void> {
    this.clearIdle();
    const child = this.child;
    const exit = this.exit;
    if (!child || !exit) return;
    const residentMs = this.residentSince ? Date.now() - this.residentSince.getTime() : null;
    if (this.alive(child)) {
      this.signalGroup('SIGTERM');
      const grace = this.options.stopGraceMs ?? 20_000;
      const exited = await Promise.race([exit.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), grace).unref())]);
      if (!exited) {
        this.signalGroup('SIGKILL');
        await exit;
      }
    }
    this.forget(child);
    this.log({ event: 'carla.simulator_stopped', reason, pid: child.pid ?? null, residentMs });
  }

  private async coldStart(signal: AbortSignal): Promise<CarlaSimulatorStart> {
    const { host, port, readyTimeoutMs } = this.options;
    // The server binds the host network: anything already on the port is not
    // this worker's server, and rendering through it would be a silent swap.
    if (await portAccepts(host, port)) {
      throw new CarlaSimulatorError(
        'carla_simulator_port_occupied',
        `something already listens on ${host}:${port}, but this worker has no CARLA server running; stop it (e.g. a leftover always-on simulator container) so the worker can start its own`,
        false,
        { host, port },
      );
    }
    const startedAt = Date.now();
    this.output = '';
    this.outputTruncated = false;
    let child: ChildProcess;
    try {
      child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new CarlaSimulatorError('carla_simulator_spawn_failed', `could not start ${this.options.command}: ${error instanceof Error ? error.message : String(error)}`, false, { command: this.options.command });
    }
    const capture = (chunk: Buffer): void => {
      const joined = `${this.output}${chunk.toString('utf8')}`;
      if (joined.length > OUTPUT_CAPTURE_CHARS) this.outputTruncated = true;
      this.output = joined.slice(-OUTPUT_CAPTURE_CHARS);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    let spawnError: Error | undefined;
    this.exit = new Promise<void>((resolve) => {
      child.once('error', (error) => { spawnError = error; resolve(); });
      child.once('exit', () => resolve());
    });
    this.child = child;
    process.on('exit', this.killOnExit);
    this.log({ event: 'carla.simulator_starting', command: this.options.command, pid: child.pid ?? null, port });

    const deadline = startedAt + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        await this.stop('job aborted during cold start');
        throw signal.reason instanceof Error ? signal.reason : new Error('job aborted during CARLA cold start');
      }
      if (!this.alive(child) || spawnError) {
        const tail = scrubbedLogTail(this.output, { truncatedHead: this.outputTruncated });
        this.forget(child);
        if (spawnError) {
          throw new CarlaSimulatorError('carla_simulator_spawn_failed', `could not start ${this.options.command}: ${spawnError.message}`, false, { command: this.options.command });
        }
        throw new CarlaSimulatorError(
          'carla_simulator_exited',
          `the CARLA server exited (code ${String(child.exitCode)}, signal ${String(child.signalCode)}) ${Date.now() - startedAt} ms into its cold start, before answering on ${host}:${port}${tail ? `; last output:\n${tail}` : '; it printed nothing'}`,
          true,
          { exitCode: child.exitCode, signal: child.signalCode, outputTail: tail },
        );
      }
      if (await this.answers()) {
        this.residentSince = new Date();
        const coldStartMs = this.residentSince.getTime() - startedAt;
        this.log({ event: 'carla.simulator_ready', pid: child.pid ?? null, port, coldStartMs });
        return { cold: true, coldStartMs, residentSince: this.residentSince.toISOString() };
      }
      await sleep(1000, signal);
    }
    const tail = scrubbedLogTail(this.output, { truncatedHead: this.outputTruncated });
    await this.stop(`no answer within ${readyTimeoutMs} ms`);
    throw new CarlaSimulatorError(
      'carla_simulator_start_timeout',
      `the CARLA server did not answer on ${host}:${port} within ${Math.round(readyTimeoutMs / 1000)} s of its cold start; it was stopped${tail ? `; last output:\n${tail}` : ''}`,
      true,
      { readyTimeoutMs, outputTail: tail },
    );
  }

  private async answers(): Promise<boolean> {
    const { host, port } = this.options;
    if (!(await portAccepts(host, port))) return false;
    return this.handshake === null ? true : runHandshake(this.handshake, host, port);
  }

  private alive(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (pid === undefined || !this.child || !this.alive(this.child)) return;
    try {
      // The launcher script forks the UE binary: signal the whole group.
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  }

  private forget(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.exit = undefined;
    this.residentSince = undefined;
    process.off('exit', this.killOnExit);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
