import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { NATIVE_SERVICE_PROTOCOL, NativeServiceClient } from './service-client.js';

/**
 * One retained native-render-service process bound to a caller's workspace:
 * the same launch, readiness, protocol and teardown path for a full Bevy
 * render and for a still preview, so neither carries its own copy.
 */
export interface NativeServiceOptions {
  /** Path to the retained native-render-service binary. */
  readonly binary: string;
  /**
   * Caller-owned directory the service's transient files (shared memory,
   * ready file, log) live in. The session removes only what it created
   * there; the workspace itself is never deleted.
   */
  readonly workspace: string;
  /** Names the Windows pipe; must be stable and filesystem-safe-ish (sanitized). */
  readonly jobId: string;
  /** Scene document for `--scene`, already written by the caller. */
  readonly scenePath: string;
  /** Aborting terminates the service; in-flight RPCs then reject as the socket closes. */
  readonly signal: AbortSignal;
  /** Budget for the process to write its ready file and answer `hello`. Default 300 s. */
  readonly startupTimeoutMs?: number;
  /** Default 512. */
  readonly shmSizeMb?: number;
}

export interface NativeServiceSession {
  readonly client: NativeServiceClient;
  /** Wire protocol the running service declared (equals `NATIVE_SERVICE_PROTOCOL`). */
  readonly protocol: number;
  /** The service's stderr, captured to a file in the workspace; survives `close()`. */
  readonly logPath: string;
  /** Tail (at most 8 KiB) of the captured stderr. */
  readStderr(): Promise<string>;
  /**
   * Bounded shutdown: asks the service to close, terminates the process,
   * waits for it to exit (SIGKILL after 10 s), then removes the private
   * socket directory, ready file and shared-memory file. Idempotent.
   */
  close(): Promise<void>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
const DEFAULT_SHM_SIZE_MB = 512;
const KILL_AFTER_MS = 10_000;
/** SIGKILL lands within `KILL_AFTER_MS`; this is the slack after it before `close()` stops waiting. */
const EXIT_WAIT_MS = KILL_AFTER_MS + 5_000;
const STDERR_TAIL_BYTES = 8_192;

const ReadyFileSchema = z.object({
  protocol: z.number().int(),
  pid: z.number().int(),
  endpoint: z.string().min(1),
  shm: z.object({ path: z.string().min(1), size_bytes: z.number().int(), meta_bytes: z.number().int() }),
});

/** Sends SIGTERM once, escalating to SIGKILL if the process lingers. */
export function terminateProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
  timer.unref();
}

/**
 * The service's `--socket` endpoint: a Unix socket under a short private
 * directory, or on Windows a private named pipe for this job.
 */
function serviceEndpoint(socketDirectory: string | null, jobId: string): string {
  if (socketDirectory !== null) return path.join(socketDirectory, 'rpc.sock');
  return `\\\\.\\pipe\\simforge-render-${jobId.replace(/[^A-Za-z0-9._-]/g, '-')}-${process.pid}`;
}

async function readLogTail(logPath: string): Promise<string> {
  let log;
  try {
    log = await fs.open(logPath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  try {
    const { size } = await log.stat();
    const bytes = Buffer.alloc(Math.min(size, STDERR_TAIL_BYTES));
    const result = await log.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.subarray(0, result.bytesRead).toString('utf8').trim();
  } finally {
    await log.close();
  }
}

/** Resolves once the child has exited or failed to spawn; never rejects and never leaves a child error unhandled. */
function watchExit(child: ChildProcess): { readonly exited: Promise<void>; settled(): Error | null } {
  let outcome: Error | null | undefined;
  const exited = new Promise<void>((resolve) => {
    child.on('error', (error) => {
      outcome ??= error;
      resolve();
    });
    child.once('exit', (code, signal) => {
      outcome ??= new Error(`native render service exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`}`);
      resolve();
    });
  });
  return { exited, settled: () => outcome ?? null };
}

export async function startNativeRenderService(options: NativeServiceOptions): Promise<NativeServiceSession> {
  const { workspace, signal } = options;
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('native render aborted');
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const shmPath = path.join(workspace, 'native-render.shm');
  const readyFile = path.join(workspace, 'native-render-ready.json');
  const logPath = path.join(workspace, 'native-render-service.log');
  await fs.mkdir(workspace, { recursive: true });
  await Promise.all([fs.rm(readyFile, { force: true }), fs.rm(shmPath, { force: true })]);
  // Unix sockaddr paths are limited to 104 bytes on macOS and 108 on Linux.
  // A user-selected data directory can exceed either limit; mkdtemp is private (0700).
  const socketDirectory = process.platform === 'win32'
    ? null
    : await fs.mkdtemp(path.join(Buffer.byteLength(tmpdir()) < 70 ? tmpdir() : '/tmp', 'sf-render-'));
  const endpoint = serviceEndpoint(socketDirectory, options.jobId);
  const log = await fs.open(logPath, 'w', 0o644);
  const child = spawn(options.binary, [
    '--scene', options.scenePath, '--socket', endpoint, '--shm', shmPath,
    '--shm-size-mb', String(options.shmSizeMb ?? DEFAULT_SHM_SIZE_MB), '--ready-file', readyFile,
  ], { stdio: ['ignore', 'ignore', log.fd], windowsHide: true });
  const exit = watchExit(child);
  const abort = (): void => terminateProcess(child);
  signal.addEventListener('abort', abort, { once: true });

  let client: NativeServiceClient | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      signal.removeEventListener('abort', abort);
      if (client) await client.close();
      terminateProcess(child);
      if (exit.settled() === null) await Promise.race([exit.exited, delay(EXIT_WAIT_MS, undefined, { ref: false })]);
      await log.close();
      await Promise.all([
        fs.rm(readyFile, { force: true }),
        fs.rm(shmPath, { force: true }),
        ...(socketDirectory === null ? [] : [fs.rm(socketDirectory, { recursive: true, force: true })]),
      ]);
    })();
    return closing;
  };

  try {
    const deadline = performance.now() + startupTimeoutMs;
    let ready: z.infer<typeof ReadyFileSchema> | undefined;
    // Poll the atomically written ready file (portable on every OS) while
    // watching the child, so a crash during startup surfaces as its exit
    // code or spawn error, never as a timeout.
    while (ready === undefined) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('native render aborted');
      const failure = exit.settled();
      if (failure !== null) throw new Error(`${failure.message}\n${await readLogTail(logPath)}`, { cause: failure });
      if (performance.now() >= deadline) {
        throw new Error(`native render service did not become ready within ${startupTimeoutMs} ms\n${await readLogTail(logPath)}`);
      }
      try {
        const parsed = ReadyFileSchema.safeParse(JSON.parse(await fs.readFile(readyFile, 'utf8')));
        if (parsed.success) ready = parsed.data;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (ready === undefined) await delay(50);
    }
    if (ready.protocol !== NATIVE_SERVICE_PROTOCOL) {
      throw new Error(`native render service protocol ${ready.protocol}; this client speaks ${NATIVE_SERVICE_PROTOCOL}`);
    }
    client = await NativeServiceClient.connect(ready.endpoint, {
      signal,
      helloTimeoutMs: Math.max(1_000, deadline - performance.now()),
    });
    return {
      client,
      protocol: ready.protocol,
      logPath,
      readStderr: () => readLogTail(logPath),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
