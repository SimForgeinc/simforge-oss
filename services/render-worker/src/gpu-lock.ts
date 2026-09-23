import { randomUUID } from 'node:crypto';
import { constants, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/**
 * One render at a time per GPU, across every worker process and container
 * that mounts the same lock file (dev and staging workers on one box share
 * it).
 *
 * The holder refreshes the file's mtime every `refreshMs`, so liveness does
 * not depend on PIDs: containers have their own PID namespaces, and a
 * restarted worker is usually the same PID (e.g. 51) as the dead one that
 * left the lock behind, which made a PID check call a stale lock "alive"
 * forever (usrj_0272cd18, attempt 3). A lock is stale when:
 *   - it was not refreshed for `staleAfterMs` (its holder is gone), or
 *   - it comes from this same container (its `instance`: cgroup container id,
 *     else hostname) and this process does not hold it, while its writer was
 *     another process lifetime (`processStartedAt`) or this very PID. That
 *     includes token-less locks from pre-refresh workers, which age alone
 *     would otherwise keep for hours after a pid-51 container restart, or
 *   - `isJobActive` says its job is no longer running (checked at acquire).
 * Every exit path releases it: normal release, and a synchronous unlink on
 * process exit. A busy GPU is waited for (bounded), not failed. A lock
 * written by an older worker (no token, never refreshed) is honoured until
 * it is older than any render could run.
 */

export interface GpuJobLock {
  release(): Promise<void>;
}

export interface GpuLockOptions {
  /** How long to wait for another job's lock before failing. Default 30 min. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly refreshMs?: number;
  readonly staleAfterMs?: number;
  readonly signal?: AbortSignal;
  /** Called while waiting, e.g. to report "waiting for the GPU". */
  readonly onWait?: (owner: GpuLockOwner) => void;
  /** Whether the lock owner's job is still running (e.g. this worker's own finished jobs). */
  readonly isJobActive?: (jobId: string) => boolean | Promise<boolean>;
  /** Age after which a legacy (token-less, unrefreshed) lock is presumed dead. */
  readonly legacyMaxAgeMs?: number;
}

export interface GpuLockOwner {
  readonly pid?: number;
  readonly host?: string;
  /** Container (or host) this process runs in; see `processInstance`. */
  readonly instance?: string;
  /** When the owning process started (epoch ms): tells two lifetimes of one PID apart. */
  readonly processStartedAt?: number;
  readonly token?: string;
  readonly jobId?: string;
  readonly acquiredAt?: string;
}

const held = new Map<string, string>();

/**
 * The container this process runs in: its id from the cgroup path when there
 * is one (Docker, containerd), else the hostname. Worker containers all run
 * node as about pid 51, so a PID alone cannot tell a dead container's lock
 * from a live one; instance plus process start time can.
 */
function processInstance(): string {
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
    const id = /([a-f0-9]{64})/.exec(cgroup)?.[1];
    if (id) return `container:${id}`;
  } catch { /* not Linux or no cgroup: fall back */ }
  return `host:${hostname()}`;
}

const INSTANCE = processInstance();
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

/** For tests: the identity this process writes into a lock it takes. */
export function gpuLockIdentity(): { instance: string; processStartedAt: number; pid: number; host: string } {
  return { instance: INSTANCE, processStartedAt: PROCESS_STARTED_AT, pid: process.pid, host: hostname() };
}
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const [path, token] of held) {
      try {
        if ((JSON.parse(readFileSync(path, 'utf8')) as GpuLockOwner).token === token) unlinkSync(path);
      } catch { /* already gone */ }
    }
  });
}

async function readOwner(path: string): Promise<GpuLockOwner | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as GpuLockOwner;
  } catch {
    return null;
  }
}

/** Why a present lock may be removed, or null when it must be respected. */
export async function staleGpuLockReason(
  path: string,
  options: Pick<GpuLockOptions, 'staleAfterMs' | 'isJobActive' | 'legacyMaxAgeMs'> = {},
  now = Date.now(),
): Promise<string | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  const owner = await readOwner(path);
  if (!owner) return null; // unreadable: treat as live
  if (owner.jobId && options.isJobActive && !(await options.isJobActive(owner.jobId))) {
    return `its job ${owner.jobId} is no longer active`;
  }
  // A lock this process does not hold, written from this same container by a
  // process that is not this one (a different lifetime, or this PID reused
  // after a restart), has no live owner, whether or not it carries a token:
  // containers have their own PID namespaces, so the PID alone proves nothing.
  const oursNow = held.has(path) && owner.token === held.get(path);
  const sameInstance = owner.instance !== undefined ? owner.instance === INSTANCE : owner.host === hostname();
  if (!oursNow && sameInstance) {
    if (owner.processStartedAt !== undefined && owner.processStartedAt !== PROCESS_STARTED_AT) {
      return 'left by an earlier process in this container';
    }
    if (owner.pid === process.pid) return 'left by a previous process with this identity';
  }
  if (!owner.token) {
    // A pre-refresh worker's lock (no token, never refreshed). Its PID may
    // belong to another container's namespace, so only age can prove it dead:
    // no render outlives the worker's execution budget.
    const legacyMaxMs = options.legacyMaxAgeMs ?? 4 * 3_600_000 + 30 * 60_000;
    return now - info.mtimeMs > legacyMaxMs ? `legacy lock older than ${Math.round(legacyMaxMs / 60_000)} min` : null;
  }
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  if (now - info.mtimeMs > staleAfterMs) return `not refreshed for ${Math.round((now - info.mtimeMs) / 1000)} s`;
  return null;
}

/** Removes a stale lock at worker startup; returns the reason when it did. */
export async function clearStaleGpuLock(path: string, options: Pick<GpuLockOptions, 'staleAfterMs' | 'isJobActive' | 'legacyMaxAgeMs'> = {}): Promise<string | null> {
  const reason = await staleGpuLockReason(path, options);
  if (reason) await unlink(path).catch(() => undefined);
  return reason;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function acquireGpuJobLock(path: string, jobId: string, options: GpuLockOptions = {}): Promise<GpuJobLock> {
  await mkdir(dirname(path), { recursive: true });
  const refreshMs = options.refreshMs ?? 10_000;
  const deadline = Date.now() + (options.waitMs ?? 30 * 60_000);
  const token = randomUUID();
  for (;;) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(JSON.stringify({
        pid: process.pid, host: hostname(), instance: INSTANCE, processStartedAt: PROCESS_STARTED_AT,
        token, jobId, acquiredAt: new Date().toISOString(),
      } satisfies GpuLockOwner));
      await handle.close();
      held.set(path, token);
      installExitHook();
      const refresher = setInterval(() => {
        const now = new Date();
        void utimes(path, now, now).catch(() => undefined);
      }, refreshMs);
      refresher.unref();
      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          clearInterval(refresher);
          held.delete(path);
          // Only remove the lock if it is still ours.
          const owner = await readOwner(path);
          if (owner?.token !== token) return;
          await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const reason = await staleGpuLockReason(path, options);
    if (reason) {
      console.error(JSON.stringify({ event: 'gpu.lock_stale_removed', path, jobId, reason, owner: await readOwner(path) }));
      await unlink(path).catch(() => undefined);
      continue;
    }
    const owner = (await readOwner(path)) ?? {};
    if (Date.now() >= deadline) {
      throw new Error(`GPU is locked by job ${String(owner.jobId ?? 'unknown')} (${String(owner.host ?? '?')} pid ${String(owner.pid ?? '?')})`);
    }
    options.onWait?.(owner);
    await delay(options.pollMs ?? 2_000, options.signal);
  }
}
