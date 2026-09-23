import { closeSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";

/**
 * One process at a time may open a PGlite data directory.
 *
 * PGlite runs Postgres as a single-user backend inside this process. It writes
 * a `postmaster.pid` with a fixed fake pid and never checks it, so nothing stops
 * a second process from opening the same directory. Two instances each keep
 * their own WAL insert position in memory: when the second one closes it writes
 * a shutdown checkpoint and points `pg_control` at it, and the first one's next
 * commits overwrite that checkpoint record in the shared WAL segment. The
 * directory keeps working while the first process lives; once it is killed the
 * next open PANICs with "could not locate a valid checkpoint record" and PGlite
 * reports only `Aborted()`. That is how the 2026-09-22 ~/.simforge/cloud/db was
 * lost to an OOM kill.
 *
 * The lock is a sibling file created with O_EXCL that names its owner. A lock
 * whose owner is no longer running (SIGKILL, OOM, power loss) is stale and is
 * taken over; a live owner is a hard error naming the process, never a silent
 * second open.
 */
export type DataDirLockOwner = {
  schema: "simforge.pglite-owner/v1";
  pid: number;
  hostname: string;
  startedAt: string;
  argv: string[];
};

export class DataDirLockedError extends Error {
  readonly code = "PGLITE_DATA_DIR_LOCKED";
  constructor(readonly lockPath: string, readonly owner: DataDirLockOwner | null) {
    super(
      owner
        ? `The local database is already open in another process: pid ${owner.pid} on ${owner.hostname}, started ${owner.startedAt} (${owner.argv.join(" ").slice(0, 200)}). `
          + `Only one process may open a PGlite data directory; stop that process or point this one at another SIMFORGE_CLOUD_ROOT. Lock: ${lockPath}`
        : `The local database lock ${lockPath} exists but names no readable owner. Make sure no other process uses this data root, then remove the file.`,
    );
    this.name = "DataDirLockedError";
  }
}

function readOwner(lockPath: string): DataDirLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<DataDirLockOwner>;
    if (parsed.schema !== "simforge.pglite-owner/v1" || typeof parsed.pid !== "number" || typeof parsed.hostname !== "string") return null;
    return {
      schema: parsed.schema,
      pid: parsed.pid,
      hostname: parsed.hostname,
      startedAt: String(parsed.startedAt ?? ""),
      argv: Array.isArray(parsed.argv) ? parsed.argv.map(String) : [],
    };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else - still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreate(lockPath: string, owner: DataDirLockOwner): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(owner)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

export type DataDirLock = {
  readonly lockPath: string;
  /** Idempotent and synchronous, so it is safe from a process `exit` hook. */
  release(): void;
};

export function acquireDataDirLock(lockPath: string): DataDirLock {
  const owner: DataDirLockOwner = {
    schema: "simforge.pglite-owner/v1",
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(1),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (tryCreate(lockPath, owner)) {
      let held = true;
      return {
        lockPath,
        release() {
          if (!held) return;
          held = false;
          const current = readOwner(lockPath);
          if (current?.pid === owner.pid && current.startedAt === owner.startedAt) {
            try { unlinkSync(lockPath); } catch { /* already gone */ }
          }
        },
      };
    }
    const current = readOwner(lockPath);
    if (current === null) {
      // A lock being written right now reads as empty; give its writer a moment.
      if (attempt < 2) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); continue; }
      throw new DataDirLockedError(lockPath, null);
    }
    if (current.hostname !== owner.hostname || processAlive(current.pid)) {
      throw new DataDirLockedError(lockPath, current);
    }
    // Stale: its owner is gone. Rename it aside first so that of two processes
    // reclaiming the same stale lock only one wins the O_EXCL create.
    const aside = `${lockPath}.stale-${current.pid}-${process.pid}`;
    try {
      renameSync(lockPath, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    const moved = readOwner(aside);
    if (moved && (moved.pid !== current.pid || moved.startedAt !== current.startedAt)) {
      // Another process reclaimed the stale lock between our read and our
      // rename; what we moved is its live lock. Put it back and retry.
      try { linkSync(aside, lockPath); } catch { /* a newer lock already stands */ }
    }
    try { unlinkSync(aside); } catch { /* already gone */ }
  }
  throw new DataDirLockedError(lockPath, readOwner(lockPath));
}
