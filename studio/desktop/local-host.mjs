// The desktop shell's view of the bundled Studio host.
//
// On launch the shell attaches to an already running local host if one
// exists and speaks this application's contract, otherwise it starts the
// local host supervisor with Electron in Node mode (no global Node, pnpm or
// tsx) and waits for `/api/simforge/host/capabilities` to answer with the
// per-start control token. Closing the app asks the supervisor it started to
// stop; a host it merely attached to is left alone. Detached native runner
// jobs are never children of this process, so closing the window cannot kill
// them; the leased CPU worker is the supervisor's child and stops with it.
//
// Packaged, the supervisor is `<resources>/studio/studio/host/host.mjs` from
// the stage `desktop/stage.mjs` produced (see `stage-manifest.json`); from a
// workspace (`pnpm desktop`, after `pnpm build`) it is `scripts/start.ts`
// through the installed `tsx`.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import {
  localHostSessionToken,
  readLocalHostState,
  waitForLocalHostReady,
} from "@simforge-oss/studio-host/node";
import { assertStagePlatform, readStageManifest } from "./stage-manifest.mjs";

const CAPABILITIES_SCHEMA = "simforge.studio-host-capabilities/v1";

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
    if (manifest.studioVersion !== app.getVersion()) {
      throw new Error(`${stageRoot} was staged for Studio ${manifest.studioVersion}, this application is ${app.getVersion()}.`);
    }
    return { args: [join(stageRoot, manifest.hostEntry)], cwd: join(stageRoot, "studio") };
  }
  const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  return { args: [tsxCli, join(studioRoot, "scripts", "start.ts")], cwd: studioRoot };
}

/**
 * Attach only to a host that is this application's: same capability schema
 * and Studio version. Another version's host (an older install still running)
 * is reported, never adopted, so UI and service never disagree on contracts.
 * @param {string} baseUrl
 * @param {string} controlToken
 * @returns {Promise<{ ok: true } | { ok: false; reason: string }>}
 */
async function checkContract(baseUrl, controlToken) {
  const response = await fetch(`${baseUrl}/api/simforge/host/capabilities`, {
    headers: { authorization: `Bearer ${controlToken}` },
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => ({ ok: false, status: 0, statusText: String(error?.message ?? error), json: async () => null }));
  if (!response.ok) return { ok: false, reason: `capabilities answered ${response.status} ${response.statusText}` };
  const capabilities = await response.json().catch(() => null);
  if (!capabilities || capabilities.schema !== CAPABILITIES_SCHEMA) return { ok: false, reason: `unexpected capabilities schema ${capabilities?.schema}` };
  const version = capabilities.host?.version;
  if (version !== app.getVersion()) return { ok: false, reason: `host is Studio ${version ?? "unknown"}, this application is ${app.getVersion()}` };
  return { ok: true };
}

/**
 * @param {{ port: number; dataRoot: string; env: Record<string, string>; onExit: (code: number | null) => void }} options
 *   `dataRoot` becomes `SIMFORGE_CLOUD_ROOT` for the host; `env` carries the
 *   other overrides the shell decides. `onExit` fires only for a supervisor
 *   this shell started.
 */
export function createLocalHost({ port, dataRoot, env, onExit }) {
  const hostEnv = { ...process.env, ...env, SIMFORGE_CLOUD_ROOT: dataRoot };
  /** @type {import("node:child_process").ChildProcess | null} */
  let supervisor = null;
  /** @type {string} */
  let controlToken = "";

  /** @returns {Promise<{ baseUrl: string; owned: boolean }>} */
  async function start() {
    const existing = await readLocalHostState(hostEnv);
    if (existing && processAlive(existing.pid)) {
      const ready = await waitForLocalHostReady(existing.baseUrl, {
        timeoutMs: 15_000,
        headers: { authorization: `Bearer ${existing.controlToken}` },
      });
      if (ready) {
        const contract = await checkContract(existing.baseUrl, existing.controlToken);
        if (!contract.ok) {
          throw new Error(`A different SimForge Studio host is already running at ${existing.baseUrl} (pid ${existing.pid}): ${contract.reason}. Quit it, then relaunch.`);
        }
        controlToken = existing.controlToken;
        return { baseUrl: existing.baseUrl, owned: false };
      }
    }
    const { args, cwd } = await supervisorCommand();
    const baseUrl = `http://127.0.0.1:${port}`;
    supervisor = spawn(process.execPath, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...hostEnv,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        SIMFORGE_LOCAL_WORKER: hostEnv.SIMFORGE_LOCAL_WORKER ?? "1",
      },
    });
    supervisor.once("exit", (code) => {
      supervisor = null;
      onExit(code);
    });
    // The supervisor publishes host.json (with the token) before it migrates;
    // wait for that record, then for the server behind it.
    const deadline = Date.now() + 240_000;
    /** @type {import("@simforge-oss/studio-host/node").LocalHostState | null} */
    let state = null;
    while (Date.now() < deadline && supervisor !== null && supervisor.exitCode === null) {
      state = await readLocalHostState(hostEnv);
      if (state && state.pid === supervisor.pid) break;
      state = null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!state) throw new Error(`The local Studio host did not publish its record under ${dataRoot}.`);
    const ready = await waitForLocalHostReady(state.baseUrl, {
      timeoutMs: Math.max(deadline - Date.now(), 1_000),
      headers: { authorization: `Bearer ${state.controlToken}` },
      isAlive: () => supervisor !== null && supervisor.exitCode === null,
    });
    if (!ready) throw new Error(`The local Studio host did not become ready at ${state.baseUrl}.`);
    const contract = await checkContract(state.baseUrl, state.controlToken);
    if (!contract.ok) throw new Error(`The bundled Studio host does not match this application: ${contract.reason}.`);
    controlToken = state.controlToken;
    return { baseUrl: state.baseUrl, owned: true };
  }

  /** Stop the supervisor this shell started; an attached host is left alone. */
  async function stop() {
    if (!supervisor) return;
    const child = supervisor;
    const state = await readLocalHostState(hostEnv);
    if (state && state.pid === child.pid) {
      await fetch(`${state.baseUrl}/api/simforge/host/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.controlToken}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => child.kill("SIGTERM"));
    } else {
      child.kill("SIGTERM");
    }
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
    dataRoot,
    owned: () => supervisor !== null,
    /** Headers native calls from this process present to the local service. */
    authorization: async () => ({ authorization: `Bearer ${controlToken}` }),
    /** The cookie value the renderer session carries; never the token itself. */
    sessionToken: () => localHostSessionToken(controlToken),
    start,
    stop,
  };
}
