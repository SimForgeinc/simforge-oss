import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LOCAL_HOST_STATE_FILE = "host.json";

/**
 * Environment variable the supervisor sets for the processes it owns (the
 * Next server and the CPU worker) carrying the per-start control token. Native
 * processes present it as `Authorization: Bearer …` on every local service
 * request; the server verifies it in `studio/proxy.ts`.
 */
export const LOCAL_HOST_TOKEN_ENV = "SIMFORGE_LOCAL_HOST_TOKEN";

/**
 * The trusted-local session cookie the desktop shell sets on its renderer
 * session (HttpOnly, SameSite=Strict) and `/api/simforge/host/session` sets
 * for a browser. Its value is derived from the control token, never the token
 * itself: a page that could read it still could not stop the host or move the
 * map cache.
 */
export const LOCAL_HOST_SESSION_COOKIE = "simforge_local_session";

/** The renderer-facing session value for a control token (HMAC, base64url). */
export function localHostSessionToken(controlToken: string): string {
  return createHmac("sha256", controlToken).update("simforge.local-host-session/v1").digest("base64url");
}

/** Constant-time comparison of two presented secrets. */
export function secretsEqual(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

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
 * or the supervised process is reported dead by `isAlive`. The route sits
 * behind the local access gate, so callers pass the control token as
 * `headers` (`{ authorization: "Bearer …" }`).
 */
export async function waitForLocalHostReady(
  baseUrl: string,
  options: { timeoutMs?: number; intervalMs?: number; isAlive?: () => boolean; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const intervalMs = options.intervalMs ?? 500;
  while (Date.now() < deadline) {
    if (options.signal?.aborted || options.isAlive?.() === false) return false;
    try {
      const response = await fetch(`${baseUrl}/api/simforge/host/capabilities`, {
        headers: options.headers,
        signal: AbortSignal.timeout(intervalMs * 4),
      });
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
