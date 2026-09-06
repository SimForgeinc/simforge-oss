// Local mode of the desktop shell: the bundled Studio host supervisor.
//
// On launch the shell attaches to an already running local host if one
// exists, otherwise starts the local host supervisor with Electron in Node
// mode (no global Node, pnpm, or tsx) and waits for
// `/api/simforge/host/capabilities` to answer. Closing the window asks the
// supervisor it started to stop; a host it merely attached to is left alone.
// Detached native runner jobs and leased CPU jobs are never children of this
// process, so closing the window cannot kill them.
//
// Packaged, the supervisor is `<resources>/studio/studio/host/host.mjs` from
// the stage `desktop/stage.mjs` produced (see `stage-manifest.json`); from a
// workspace (`pnpm desktop`, after `pnpm build`) it is `scripts/start.ts`
// through the installed `tsx`.
//
// This module is only bundled into the local (fully bundled runtime) package;
// the Cloud-connected package never loads it, so it never needs the host,
// the native addon or `@simforge-oss/studio-host` on Windows/macOS.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import {
  localHostStateDir,
  readLocalHostState,
  waitForLocalHostReady,
} from "@simforge-oss/studio-host/node";
import { assertStagePlatform, readStageManifest } from "./stage-manifest.mjs";

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The supervisor command for this installation: the staged host of a packaged
 * artifact, or the workspace supervisor. Both run under this Electron binary
 * in Node mode.
 * @returns {Promise<{ args: string[]; cwd: string }>}
 */
async function supervisorCommand() {
  if (app.isPackaged) {
    const stageRoot = join(process.resourcesPath, "studio");
    const manifest = await readStageManifest(stageRoot);
    assertStagePlatform(manifest);
    return { args: [join(stageRoot, manifest.hostEntry)], cwd: join(stageRoot, "studio") };
  }
  const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  return { args: [tsxCli, join(studioRoot, "scripts", "start.ts")], cwd: studioRoot };
}

/**
 * @param {{ port: number; onExit: (code: number | null) => void }} options
 *   `onExit` fires only for a supervisor this shell started.
 */
export function createLocalHost({ port, onExit }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  /** @type {import("node:child_process").ChildProcess | null} */
  let supervisor = null;

  async function start() {
    const existing = await readLocalHostState();
    if (existing && processAlive(existing.pid)) {
      const ready = await waitForLocalHostReady(existing.baseUrl, { timeoutMs: 15_000 });
      if (ready) return { baseUrl: existing.baseUrl, owned: false };
    }
    const { args, cwd } = await supervisorCommand();
    supervisor = spawn(process.execPath, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        SIMFORGE_LOCAL_WORKER: process.env.SIMFORGE_LOCAL_WORKER ?? "1",
      },
    });
    supervisor.once("exit", (code) => {
      supervisor = null;
      onExit(code);
    });
    const ready = await waitForLocalHostReady(baseUrl, {
      timeoutMs: 240_000,
      isAlive: () => supervisor !== null && supervisor.exitCode === null,
    });
    if (!ready) throw new Error(`The local Studio host did not become ready at ${baseUrl}.`);
    return { baseUrl, owned: true };
  }

  /** Stop the supervisor this shell started; an attached host is left alone. */
  async function stop() {
    if (!supervisor) return;
    const state = await readLocalHostState();
    if (state && state.pid === supervisor.pid) {
      await fetch(`${state.baseUrl}/api/simforge/host/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.controlToken}` },
      }).catch(() => supervisor?.kill("SIGTERM"));
    } else {
      supervisor.kill("SIGTERM");
    }
    const child = supervisor;
    const { promise, resolve } = Promise.withResolvers();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 20_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    await promise;
  }

  return {
    baseUrl,
    dataDir: localHostStateDir(),
    owned: () => supervisor !== null,
    start,
    stop,
  };
}
