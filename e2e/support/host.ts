import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  LOCAL_HOST_STATE_FILE,
  readLocalHostState,
  waitForLocalHostReady,
  type LocalHostState,
} from "../../packages/studio-host/src/node/local-host-state";
import type { E2eContext } from "./context";
import { currentHostMode, type HostMode } from "./env";
import { STUDIO_ROOT } from "./paths";

/**
 * A Studio host the harness started and owns: the real supervisor
 * (`studio/scripts/boot.ts` or `start.ts`) with this test's isolated data
 * root, so migrations, seed, `host.json` and the access gate all behave
 * exactly as they do for a developer running `pnpm dev`.
 */
export type LocalHost = {
  readonly baseUrl: string;
  readonly port: number;
  /** The per-start secret the supervisor generated; native callers present it as a bearer. */
  readonly controlToken: string;
  readonly state: LocalHostState;
  readonly withWorker: boolean;
  stop(): Promise<void>;
};

export type StartLocalHostOptions = {
  hostMode?: HostMode;
  /** Start the interactive CPU worker alongside the server. */
  worker?: boolean;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
};

const require = createRequire(import.meta.url);

/** An OS-assigned loopback port, released immediately before the host claims it. */
async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Could not reserve a loopback port");
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function waitForHostRecord(context: E2eContext, child: ChildProcess, deadline: number): Promise<LocalHostState> {
  const env = { SIMFORGE_CLOUD_ROOT: context.dataRoot };
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `The Studio supervisor exited (code ${child.exitCode ?? "null"}, signal ${child.signalCode ?? "null"}) before publishing `
        + `${join(context.dataRoot, LOCAL_HOST_STATE_FILE)}`,
      );
    }
    const state = await readLocalHostState(env);
    if (state !== null) return state;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The Studio supervisor did not publish ${LOCAL_HOST_STATE_FILE} within the readiness deadline`);
}

/**
 * Start the supervisor, wait for `host.json` and then for the capability route
 * to answer behind the access gate. `dev` compiles on demand, which is why the
 * default readiness budget is generous.
 */
export async function startLocalHost(context: E2eContext, options: StartLocalHostOptions = {}): Promise<LocalHost> {
  const hostMode = options.hostMode ?? currentHostMode();
  const port = await reserveLoopbackPort();
  const script = join(STUDIO_ROOT, "scripts", hostMode === "dev" ? "boot.ts" : "start.ts");
  const child = spawn(process.execPath, [require.resolve("tsx/cli"), script], {
    cwd: STUDIO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      ...context.env,
      ...options.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      SIMFORGE_LOCAL_WORKER: options.worker ? "1" : "0",
    },
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // One SIGTERM is the documented shutdown: the supervisor stops the
      // server and worker and removes its host record.
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      await exited;
      clearTimeout(timer);
    }
    await exited;
  };
  const deadline = Date.now() + (options.readyTimeoutMs ?? (hostMode === "dev" ? 300_000 : 120_000));
  try {
    const state = await waitForHostRecord(context, child, deadline);
    const ready = await waitForLocalHostReady(state.baseUrl, {
      timeoutMs: Math.max(1_000, deadline - Date.now()),
      headers: { authorization: `Bearer ${state.controlToken}` },
      isAlive: () => child.exitCode === null && child.signalCode === null,
    });
    if (!ready) throw new Error(`Studio host at ${state.baseUrl} never became ready (data root ${context.dataRoot})`);
    return { baseUrl: state.baseUrl, port: state.port, controlToken: state.controlToken, state, withWorker: state.withWorker, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * The production browser bootstrap: exchange the control token for a one-use
 * ticket (`POST /api/simforge/host/session`), then follow the ticket URL so the
 * host itself sets the trusted-local session cookie. The harness never writes
 * the cookie and never presents the control token to the page.
 */
export async function requestBrowserTicketUrl(host: LocalHost, route: string): Promise<string> {
  const response = await fetch(new URL("/api/simforge/host/session", host.baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${host.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ next: route }),
  });
  if (!response.ok) throw new Error(`Could not open a trusted browser session: HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("url" in body) || typeof body.url !== "string") {
    throw new Error("The host session route returned no bootstrap URL");
  }
  const target = new URL(body.url);
  const expected = new URL(host.baseUrl);
  const isLoopbackAlias = (hostname: string): boolean =>
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (
    target.protocol !== expected.protocol
    || target.port !== expected.port
    || !(target.hostname === expected.hostname
      || (isLoopbackAlias(target.hostname) && isLoopbackAlias(expected.hostname)))
  ) {
    throw new Error("Host returned a foreign browser bootstrap URL");
  }
  return target.href;
}
