import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LOCAL_HOST_STATE_FILE = "host.json";

/**
 * Published by the local host supervisor when it claims startup ownership, read by the
 * desktop shell (attach or launch) and by the shutdown route (authorize and
 * signal). Lives under the same data root as the PGlite database so one
 * installation has exactly one host record.
 */
export type LocalHostState = {
  schema: "simforge.local-host-state/v1";
  /** PID of the supervisor process that owns the server and workers. */
  pid: number;
  port: number;
  baseUrl: string;
  /** Bearer secret the shutdown route requires; generated per host start. */
  controlToken: string;
  startedAt: string;
  withWorker: boolean;
};

/** `${SIMFORGE_CLOUD_ROOT:-~/.simforge/cloud}` — the local Studio data root. */
export function localHostStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SIMFORGE_CLOUD_ROOT?.trim() || join(homedir(), ".simforge", "cloud");
}

export async function readLocalHostState(env: NodeJS.ProcessEnv = process.env): Promise<LocalHostState | null> {
  try {
    const raw = await readFile(join(localHostStateDir(env), LOCAL_HOST_STATE_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null
      || !("schema" in parsed) || parsed.schema !== "simforge.local-host-state/v1"
      || !("pid" in parsed) || typeof parsed.pid !== "number"
      || !("port" in parsed) || typeof parsed.port !== "number"
      || !("baseUrl" in parsed) || typeof parsed.baseUrl !== "string"
      || !("controlToken" in parsed) || typeof parsed.controlToken !== "string"
      || !("startedAt" in parsed) || typeof parsed.startedAt !== "string"
      || !("withWorker" in parsed) || typeof parsed.withWorker !== "boolean"
    ) {
      return null;
    }
    // Every field was checked above.
    const state = parsed as LocalHostState;
    return state;
  } catch {
    return null;
  }
}

export async function writeLocalHostState(state: LocalHostState, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = join(localHostStateDir(env), LOCAL_HOST_STATE_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function removeLocalHostState(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(join(localHostStateDir(env), LOCAL_HOST_STATE_FILE), { force: true });
}

/**
 * Poll the host's capability route until it answers 200, the deadline passes,
 * or the supervised process is reported dead by `isAlive`.
 */
export async function waitForLocalHostReady(
  baseUrl: string,
  options: { timeoutMs?: number; intervalMs?: number; isAlive?: () => boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const intervalMs = options.intervalMs ?? 500;
  while (Date.now() < deadline) {
    if (options.signal?.aborted || options.isAlive?.() === false) return false;
    try {
      const response = await fetch(`${baseUrl}/api/simforge/host/capabilities`, { signal: AbortSignal.timeout(intervalMs * 4) });
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
