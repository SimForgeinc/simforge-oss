import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import {
  LOCAL_HOST_TOKEN_ENV,
  localHostStateDir,
  readLocalHostState,
  removeLocalHostState,
  writeLocalHostState,
  type LocalHostState,
} from "./local-host-state";

/**
 * The local Studio supervisor: bootstrap (seed, which runs migrations), the Next
 * server, the optional interactive CPU worker, and one `host.json` record
 * other processes attach to.
 *
 * The caller decides *what* serves Studio through a {@link LocalHostPlan}:
 * the CLI daemon runs `next` and `tsx` from the installed workspace, the
 * desktop artifact runs the staged standalone server and the bundled worker
 * (`studio/desktop/host.ts`). Every child is started with the interpreter
 * running this supervisor, so neither plan needs a globally installed
 * `pnpm`, `tsx`, or Node: under Electron the interpreter is Electron in Node
 * mode.
 *
 * Shutdown is one SIGTERM to this process: the server and the worker receive
 * SIGTERM, the worker releases its lease at a safe boundary, and the host
 * record is removed. Native runner jobs are `job start --detach`ed under the
 * runner's own supervisor and are not children of this process by design.
 */
export type HostCommand = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
};

export type LocalHostPlan = {
  /**
   * Runs migrations and seed while this process still owns the database;
   * must close every database handle before returning so only the server
   * owns the persistent database afterwards.
   */
  readonly bootstrap: () => Promise<void>;
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
 * Pins `process.title` before any module of a host child runs.
 *
 * On macOS, libuv implements `process.title` by checking the process in with
 * LaunchServices, and LaunchServices puts every checked-in process in the
 * Dock: for a Node-mode Electron child that is a generic "exec" tile beside
 * the real application icon. Next sets its title unconditionally
 * (`next-server (vX)`), so the children get the property pinned instead. A
 * `data:` import needs no file to stage, and forked grandchildren inherit it
 * through `execArgv`. Other platforms have no such surface and get nothing.
 */
const HOLD_PROCESS_TITLE = `data:text/javascript,${encodeURIComponent(
  'Object.defineProperty(process, "title", { configurable: true, enumerable: true, get: () => "simforge-host", set() {} });',
)}`;

/**
 * Makes a host child die with the supervisor.
 *
 * Shutdown is one signal to the supervisor, and its `finally` stops the
 * children - but only if it runs. A SIGKILLed supervisor, or one whose own
 * launcher was killed, left the Next server behind: an orphan holding the
 * port, the data-root lock and (for `next dev`) gigabytes of resident memory,
 * with nothing left to stop it and no record pointing at it. The next start
 * then failed on `EADDRINUSE` or the PGlite lock instead of naming the
 * process still alive.
 *
 * `process.ppid` is read from the OS on every access, so a reparented child
 * sees a different parent than the one it was spawned under and exits. Node
 * has no `PR_SET_PDEATHSIG` binding and the watch must work on every
 * platform, so this is a poll; the timer is unref'd, so it never keeps an
 * otherwise-finished process alive. Children forked by a child inherit it
 * through `execArgv`, which is what reaches `next dev`'s own server process.
 */
const PARENT_DEATH_WATCH = `data:text/javascript,${encodeURIComponent(
  'const parent = process.ppid;'
  + 'setInterval(() => { if (process.ppid !== parent) process.exit(1); }, 1000).unref();',
)}`;

function spawnHostCommand(command: HostCommand, extraEnv: Record<string, string>): ChildProcess {
  const args = command.args.map((arg) =>
    arg === "${SIMFORGE_RENDER_WORKER_TOKEN}"
      ? extraEnv.SIMFORGE_RENDER_WORKER_TOKEN ?? arg
      : arg,
  );
  // Every host child runs this interpreter, so both concerns ride in as
  // loaders rather than as wrappers the plans would have to carry.
  const finalArgs = command.command === process.execPath
    ? [
      "--import", PARENT_DEATH_WATCH,
      ...(process.platform === "darwin" ? ["--import", HOLD_PROCESS_TITLE] : []),
      ...args,
    ]
    : args;
  return spawn(command.command, finalArgs, {
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Exit status when another live host already owns the data root. */
const LOCAL_HOST_BUSY_EXIT = 3;

/**
 * A start refused because another host already owns this data root. The
 * caller is told which process to deal with - pid, port, base URL, start time
 * - instead of receiving a bare exit code, an `EADDRINUSE` from the server
 * child, or a PGlite lock error with nothing actionable in it.
 */
function reportBusy(event: string, stateDir: string, current: LocalHostState | null): number {
  process.stderr.write(`${JSON.stringify({
    component: "simforge-local-host",
    event,
    dataRoot: stateDir,
    ...(current ? { pid: current.pid, port: current.port, baseUrl: current.baseUrl, startedAt: current.startedAt } : {}),
    message: current
      ? `A Studio host already owns ${stateDir}: pid ${current.pid} on port ${current.port} (${current.baseUrl}), started ${current.startedAt}. Stop it with \`simforge host stop --data-root ${stateDir}\`.`
      : `Another process owns the Studio data root ${stateDir} but published no host record. Find it with \`ss -ltnp\` / \`pgrep -f next-server\` and stop it before starting a host here.`,
  })}\n`);
  return LOCAL_HOST_BUSY_EXIT;
}

export async function runLocalHost(plan: LocalHostPlan, config: LocalHostConfig = localHostConfig()): Promise<number> {
  const { port, hostname, withWorker } = config;
  const stateDir = localHostStateDir();
  const runtimeEnv = {
    SIMFORGE_NATIVE_RUNTIME_STATE_ROOT: process.env.SIMFORGE_NATIVE_RUNTIME_STATE_ROOT?.trim()
      || resolve(stateDir, "native-runtime"),
  };
  const baseUrl = `http://${hostname}:${port}`;
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
    return reportBusy("host.ownership_busy", stateDir, await readLocalHostState());
  }

  let published = false;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  try {
    const current = await readLocalHostState();
    if (current && current.pid !== process.pid && processAlive(current.pid)) {
      return reportBusy("host.record_busy", stateDir, current);
    }
    // Claim ownership before PGlite is opened, including migration and seeding.
    const controlToken = randomBytes(24).toString("base64url");
    await writeLocalHostState({
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
      SIMFORGE_RENDER_WORKER_TOKEN: process.env.SIMFORGE_RENDER_WORKER_TOKEN?.trim() || controlToken,
    };
    await plan.bootstrap();
    if (ownershipError) throw ownershipError;

    const server = spawnHostCommand(plan.server, { ...runtimeEnv, ...accessEnv, PORT: String(port), HOSTNAME: hostname });
    children.push(server);
    if (withWorker) {
      children.push(spawnHostCommand(plan.worker, {
        ...runtimeEnv,
        ...accessEnv,
        SIMFORGE_API_BASE_URL: process.env.SIMFORGE_API_BASE_URL ?? `http://127.0.0.1:${port}`,
      }));
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => stop(signal === "SIGHUP" ? "SIGTERM" : signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      server.once("exit", (code) => resolveExit(code ?? 1));
      server.once("error", rejectExit);
    });
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
