import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lock } from "proper-lockfile";
import {
  LOCAL_HOST_TOKEN_ENV,
  localHostStateDir,
  readLocalHostState,
  removeLocalHostState,
  waitForLocalHostReady,
  writeLocalHostState,
} from "@simforge-oss/studio-host/node";
import { migrate } from "./migrate";
import { seed } from "./seed";
import { simforgeEnv } from "../lib/simforge-env";
import { shutdownDatabase } from "../app/lib/db/data-api";

/**
 * The local Studio supervisor: migrations, seed, the Next server, the optional
 * interactive CPU worker, and one `host.json` record other processes attach to.
 *
 * The caller decides *what* serves Studio through a {@link LocalHostPlan}:
 * the workspace (`dev`/`start`, {@link workspaceHostPlan}) runs `next` and
 * `tsx` from the installed workspace, the desktop artifact runs the staged
 * standalone server and the bundled worker (`desktop/host.ts`). Every child is
 * started with the interpreter running this supervisor, so neither plan needs
 * a globally installed `pnpm`, `tsx`, or Node: under Electron the interpreter
 * is Electron in Node mode.
 *
 * Shutdown is one SIGTERM to this process: the server and the worker receive
 * SIGTERM, the worker releases its lease at a safe boundary, and the host
 * record is removed. Native runner jobs are `job start --detach`ed under the
 * runner's own supervisor and are not children of this process by design.
 */
export type LocalHostMode = "dev" | "start";

export type HostCommand = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
};

export type LocalHostPlan = {
  /** Serves Studio; receives `PORT` and `HOSTNAME` in its environment. */
  readonly server: HostCommand;
  /** The interactive CPU worker; spawned only when the worker is enabled. */
  readonly worker: HostCommand;
};

export type LocalHostConfig = {
  readonly port: number;
  readonly hostname: string;
  readonly withWorker: boolean;
};

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `PORT`, `HOSTNAME`, and `SIMFORGE_LOCAL_WORKER=1` / `--with-worker`. */
export function localHostConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): LocalHostConfig {
  return {
    port: Number(env.PORT ?? "5199"),
    hostname: env.HOSTNAME ?? "127.0.0.1",
    withWorker: env.SIMFORGE_LOCAL_WORKER === "1" || argv.includes("--with-worker"),
  };
}

/**
 * The workspace plan: `next dev`/`next start` and the TypeScript worker
 * through `tsx`, both resolved from the installed workspace and run with the
 * current interpreter.
 */
export function workspaceHostPlan(mode: LocalHostMode, config: LocalHostConfig): LocalHostPlan {
  const require = createRequire(import.meta.url);
  const nextBin = require.resolve("next/dist/bin/next");
  const tsxCli = require.resolve("tsx/cli");
  const port = String(config.port);
  return {
    server: {
      command: process.execPath,
      args: mode === "dev"
        ? [nextBin, "dev", "--webpack", "-p", port]
        : [nextBin, "start", "-p", port, "-H", config.hostname],
      cwd: studioRoot,
    },
    worker: {
      command: process.execPath,
      args: [tsxCli, resolve(studioRoot, "worker", "index.ts")],
      cwd: studioRoot,
    },
  };
}

function spawnHostCommand(command: HostCommand, extraEnv: Record<string, string>): ChildProcess {
  return spawn(command.command, command.args, {
    cwd: command.cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      // Children of an Electron-hosted supervisor are Electron too; keep them in Node mode.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      ...extraEnv,
    },
  });
}

export async function runLocalHost(plan: LocalHostPlan, config: LocalHostConfig = localHostConfig()): Promise<number> {
  const { port, hostname, withWorker } = config;
  const stateDir = localHostStateDir();
  const runtimeEnv = {
    SIMFORGE_NATIVE_RUNTIME_STATE_ROOT: process.env.SIMFORGE_NATIVE_RUNTIME_STATE_ROOT?.trim()
      || resolve(stateDir, "native-runtime"),
  };
  const baseUrl = `http://${hostname}:${port}`;
  const existing = await readLocalHostState();
  if (existing && existing.pid !== process.pid && processAlive(existing.pid)) {
    process.stderr.write(`${JSON.stringify({
      component: "simforge-local-host",
      event: "host.already_running",
      pid: existing.pid,
      baseUrl: existing.baseUrl,
    })}\n`);
    return 3;
  }

  const children: ChildProcess[] = [];
  let stopping = false;
  let ownershipError: Error | undefined;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill(signal);
  };
  await mkdir(stateDir, { recursive: true });
  let releaseOwnership: () => Promise<void>;
  try {
    releaseOwnership = await lock(stateDir, {
      lockfilePath: join(stateDir, "host.lock"),
      retries: 0,
      stale: 30_000,
      update: 10_000,
      onCompromised: (error) => {
        ownershipError = error;
        stop("SIGTERM");
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
    process.stderr.write(`${JSON.stringify({
      component: "simforge-local-host",
      event: "host.ownership_busy",
      dataRoot: stateDir,
    })}\n`);
    return 3;
  }

  let published = false;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  try {
    const current = await readLocalHostState();
    if (current && current.pid !== process.pid && processAlive(current.pid)) return 3;
    // Claim ownership before PGlite is opened, including migration and seeding.
    const controlToken = randomBytes(24).toString("base64url");
    const statePath = await writeLocalHostState({
      schema: "simforge.local-host-state/v1",
      pid: process.pid,
      port,
      baseUrl,
      controlToken,
      startedAt: new Date().toISOString(),
      withWorker,
    });
    published = true;
    // The per-start secret every owned process presents to the local service
    // (studio/proxy.ts). The CPU worker's own bearer is the same secret, so
    // the public default worker token never authorizes anything here.
    const accessEnv = {
      [LOCAL_HOST_TOKEN_ENV]: controlToken,
      SIMFORGE_RENDER_WORKER_TOKEN: simforgeEnv("RENDER_WORKER_TOKEN")?.trim() || controlToken,
    };
    try {
      await migrate();
      await seed();
    } finally {
      // Only the server may own the persistent database after bootstrap.
      await shutdownDatabase();
    }
    if (ownershipError) throw ownershipError;

    const server = spawnHostCommand(plan.server, { ...runtimeEnv, ...accessEnv, PORT: String(port), HOSTNAME: hostname });
    children.push(server);
    if (withWorker) {
      children.push(spawnHostCommand(plan.worker, {
        ...runtimeEnv,
        ...accessEnv,
        SIMFORGE_API_BASE_URL: simforgeEnv("API_BASE_URL") ?? `http://127.0.0.1:${port}`,
      }));
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => stop(signal === "SIGHUP" ? "SIGTERM" : signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    void waitForLocalHostReady(baseUrl, {
      headers: { authorization: `Bearer ${controlToken}` },
      isAlive: () => !stopping && server.exitCode === null && server.signalCode === null,
    }).then((ready) => {
      process.stdout.write(`${JSON.stringify({
        component: "simforge-local-host",
        event: ready ? "host.ready" : "host.not_ready",
        baseUrl,
        statePath,
        withWorker,
        // Browsers need a trusted-local session; `pnpm host:open` establishes one.
        open: ready ? "pnpm host:open" : undefined,
      })}\n`);
    });
    const { promise, resolve: resolveExit, reject: rejectExit } = Promise.withResolvers<number>();
    server.once("exit", (code) => resolveExit(code ?? 1));
    server.once("error", rejectExit);
    const exitCode = await promise;
    if (ownershipError) throw ownershipError;
    return exitCode;
  } finally {
    stop("SIGTERM");
    await Promise.all(children.map((child) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
    }));
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (published && !ownershipError) await removeLocalHostState();
    // A compromised lease is already released by proper-lockfile.
    if (!ownershipError) await releaseOwnership();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
