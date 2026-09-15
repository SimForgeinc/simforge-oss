// The window that shows desktop/connections.html: the chooser before any host
// page loads, and the lost-connection report when a remote host stops
// answering. One BrowserWindow with its own narrow preload
// (connections-preload.cjs); its IPC handlers are registered for the life of
// that window and answer only its own frame.
//
// Both entry points resolve with what the user decided and nothing else. The
// caller (main.mjs) attaches, relaunches or quits; this module never derives
// anything from the choice, because five things are derived from it at boot
// and a switch is a relaunch, not a hot swap.
import { join } from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { forgetRemoteHost, pairRemoteHost, parseConnectLink, parseHostOrigin, resolveRemoteTarget } from "./connections.mjs";
import { checkContract } from "./host-contract.mjs";

const IPC_PREFIX = "simforge:connections:";
const METHODS = ["state", "probe", "choose", "pair", "forget", "retry", "switch", "quit"];

/**
 * @param {{ pagesDir: string; query: Record<string, string> }} input
 * @returns {BrowserWindow}
 */
function createConnectionsWindow({ pagesDir, query }) {
  const window = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 560,
    minHeight: 480,
    title: "SimForge Studio",
    backgroundColor: "#0a0a0a",
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { titleBarOverlay: true } : { titleBarOverlay: { color: "#0a0a0a", symbolColor: "#ededed", height: 40 }, autoHideMenuBar: true }),
    ...(process.platform === "linux" ? { icon: join(pagesDir, "icon.png") } : {}),
    webPreferences: {
      preload: join(pagesDir, "connections-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  // A page outside any host: nothing it links to may navigate this window.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void window.loadFile(join(pagesDir, "connections.html"), { query });
  return window;
}

/**
 * Serve `methods` to exactly this window's main frame until it closes.
 * `decision` resolves the first time a method calls `settle`, or with
 * `{ kind: "quit" }` when the window is closed first. The window stays open
 * until the caller calls `close()`: closing it before the next window exists
 * would fire `window-all-closed` and quit the app under the caller's feet.
 * @template T
 * @param {BrowserWindow} window
 * @param {(settle: (value: T) => void) => Record<string, (...args: unknown[]) => Promise<unknown>>} build
 * @returns {{ decision: Promise<T | { kind: "quit" }>; close(): void }}
 */
function serve(window, build) {
  let settled = false;
  const decision = new Promise((resolve) => {
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const methods = build(settle);
    for (const method of METHODS) {
      ipcMain.handle(`${IPC_PREFIX}${method}`, async (event, ...args) => {
        if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
          return { ok: false, error: { name: "NotAuthorized", message: "Not the connection window" } };
        }
        try {
          const handler = methods[method];
          if (!handler) throw new Error(`${method} is not available in this window`);
          return { ok: true, value: await handler(...args) };
        } catch (error) {
          return { ok: false, error: { name: error?.name ?? "Error", message: error instanceof Error ? error.message : String(error) } };
        }
      });
    }
    window.once("closed", () => {
      for (const method of METHODS) ipcMain.removeHandler(`${IPC_PREFIX}${method}`);
      settle({ kind: "quit" });
    });
  });
  return {
    decision,
    close() {
      if (!window.isDestroyed()) window.close();
    },
  };
}

/**
 * Show the chooser and wait for a decision.
 * @param {{
 *   pagesDir: string;
 *   store: Awaited<ReturnType<typeof import("./connections.mjs").openConnectionStore>>;
 *   vault: Awaited<ReturnType<typeof import("./connections.mjs").openShellVault>>;
 *   local: { origin: string; detail: string };
 * }} input
 * @returns {{ decision: Promise<{ kind: "local" } | { kind: "remote"; target: { baseUrl: string; controlToken: string }; remote: import("./connections.mjs").RemoteTarget } | { kind: "quit" }>; close(): void }}
 */
export function chooseConnection({ pagesDir, store, vault, local }) {
  const window = createConnectionsWindow({ pagesDir, query: { mode: "choose" } });
  return serve(window, (settle) => ({
    async state() {
      const remotes = [];
      for (const remote of store.remotes()) {
        const resolved = await resolveRemoteTarget({ store, vault, id: remote.id });
        remotes.push({
          id: remote.id,
          label: remote.label,
          origin: remote.origin,
          hasToken: resolved.kind !== "unpaired",
          refused: resolved.kind === "refused" ? resolved.reason : null,
        });
      }
      return { selected: store.selected(), local, remotes, vaultPersistence: vault.persistence };
    },
    /**
     * Reachability and contract in ONE answer, from the one function the
     * shell already adopts a host with (`checkContract`): it dials
     * `/api/simforge/host/capabilities` with the row's own token and rejects
     * a host that answers but is not this application's — wrong capability
     * schema, wrong protocol version, wrong Studio version.
     *
     * Deliberately not split into "reachable?" then "compatible?": that
     * needs two requests to say one thing, and a row that reported
     * reachability from the first request could read "reachable" for a host
     * the second request then refused. `ok: false` carries `checkContract`'s
     * own reason verbatim, so the row never claims more than was checked.
     * @param {string} id
     */
    async probe(id) {
      const resolved = await resolveRemoteTarget({ store, vault, id });
      if (resolved.kind !== "ready") {
        return { ok: false, reason: resolved.kind === "refused" ? resolved.reason : "not paired on this computer" };
      }
      const contract = await checkContract(resolved.target.baseUrl, resolved.target.controlToken);
      return contract.ok ? { ok: true, host: contract.host ?? null } : { ok: false, reason: contract.reason };
    },
    /** @param {string} id */
    async choose(id) {
      if (id === "local") {
        await store.select("local");
        settle({ kind: "local" });
        return;
      }
      const resolved = await resolveRemoteTarget({ store, vault, id });
      if (resolved.kind === "refused") throw new Error(resolved.reason);
      if (resolved.kind === "unpaired") throw new Error(`${resolved.remote.origin} has no credentials on this computer; pair with it again.`);
      await store.select(id);
      settle({ kind: "remote", target: resolved.target, remote: resolved.remote });
    },
    /**
     * `target` is a simforge://connect link (origin and code together) or a
     * bare host origin with the code in `code`.
     * A plain-HTTP network origin with no acknowledgement comes back as
     * `{ refused }`, not as a throw. It is a state the form shows — the
     * acknowledgement box — and it has to travel as a value: `contextBridge`
     * rebuilds a rejected promise's Error in the renderer's world from its
     * message alone, so a `name` the renderer could branch on does not
     * survive the bridge (measured: the refusal arrived with `name`
     * `"Error"` and landed in the generic error slot).
     * @param {{ target: string; code: string; label: string; plaintextAcknowledged: boolean }} input
     * @returns {Promise<{ remote: import("./connections.mjs").RemoteTarget } | { refused: string }>}
     */
    async pair({ target, code, label, plaintextAcknowledged }) {
      if (typeof target !== "string" || typeof code !== "string" || typeof label !== "string") throw new Error("Invalid pairing request");
      const link = target.startsWith("simforge:") ? parseConnectLink(target) : { origin: parseHostOrigin(target).origin, code };
      if (!link.code) throw new Error("Enter the pairing code `simforge host pair` printed.");
      try {
        const remote = await pairRemoteHost({ store, vault, origin: link.origin, code: link.code, label, plaintextAcknowledged: plaintextAcknowledged === true });
        return { remote };
      } catch (error) {
        if (error?.name === "PlaintextRefused") return { refused: error.message };
        throw error;
      }
    },
    /** @param {string} id */
    async forget(id) {
      await forgetRemoteHost({ store, vault, id });
    },
    async quit() {
      settle({ kind: "quit" });
    },
  }));
}

/**
 * Report a remote host that stopped answering and wait for a decision.
 * @param {{ pagesDir: string; origin: string; reason: string; probe: () => Promise<boolean> }} input
 * @returns {{ decision: Promise<{ kind: "retry" } | { kind: "switch" } | { kind: "quit" }>; close(): void }}
 */
export function reportLostConnection({ pagesDir, origin, reason, probe }) {
  const window = createConnectionsWindow({ pagesDir, query: { mode: "lost", origin } });
  return serve(window, (settle) => ({
    async state() {
      return { origin, lostReason: reason };
    },
    async retry() {
      const answered = await probe();
      if (answered) settle({ kind: "retry" });
      return answered;
    },
    async switch() {
      settle({ kind: "switch" });
    },
    async quit() {
      settle({ kind: "quit" });
    },
  }));
}
