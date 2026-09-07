// Desktop bridge for the map cache: a thin adapter, not a store.
//
// The map bytes, index and journal live in the LOCAL SERVICE
// (studio/app/lib/map-cache, endpoints /api/simforge/map-cache/**), which
// outlives this window and also serves native jobs. This module only:
//   - answers the renderer's `window.simforgeDesktop.mapCache.*` IPC calls
//     (cache-preload.cjs) by forwarding them, with the shell's per-start host
//     credentials, to the protected local endpoints;
//   - owns the one thing a web page cannot do: the native folder picker, whose
//     selected path is sent to the service's `location` endpoint by main alone.
// Asset bytes never pass through here: `ensure` answers with a same-origin
// `/api/simforge/map-cache/stream/...` capability URL the page fetches itself.

/** Same literal as cache-preload.cjs and studio-host's DESKTOP_MAP_CACHE_IPC_PREFIX. */
export const DESKTOP_MAP_CACHE_IPC_PREFIX = "simforge:map-cache:";
const API_PREFIX = "/api/simforge/map-cache";

/**
 * @typedef {object} InstallOptions
 * @property {import("electron").IpcMain} ipcMain
 * @property {import("electron").BrowserWindow} window  the only window allowed to call the bridge
 * @property {string} trustedOrigin  exact origin the local UI is loaded from
 * @property {string} hostBaseUrl  loopback base URL of the local host, e.g. http://127.0.0.1:5199
 * @property {() => Promise<Record<string, string>>} hostAuthorization  headers that authenticate
 *   the shell to the local service (must carry the per-start host control token)
 * @property {() => Promise<string | null>} chooseDirectory  native picker; null = keep current
 */

/**
 * Install the renderer bridge for `window`. Resolves once the
 * `simforge:map-cache:*` IPC handlers accept calls from the trusted origin.
 * @param {InstallOptions} options
 * @returns {Promise<{ dispose(): Promise<void> }>}
 */
export async function installDesktopMapCache({ ipcMain, window, trustedOrigin, hostBaseUrl, hostAuthorization, chooseDirectory }) {
  if (typeof trustedOrigin !== "string" || new URL(trustedOrigin).origin !== trustedOrigin) {
    throw new Error(`installDesktopMapCache: trustedOrigin must be an exact origin, got ${trustedOrigin}`);
  }
  const host = new URL(hostBaseUrl);
  if (host.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) {
    throw new Error(`installDesktopMapCache: hostBaseUrl must be a loopback HTTP URL, got ${hostBaseUrl}`);
  }
  if (typeof hostAuthorization !== "function") throw new Error("installDesktopMapCache: hostAuthorization callback is required");
  if (typeof chooseDirectory !== "function") throw new Error("installDesktopMapCache: chooseDirectory callback is required");

  /**
   * One call to the local service. Errors come back as `{ error: { name, message } }`
   * and are rethrown under that name so the renderer sees AbortError,
   * NotAuthorized, QuotaExceededError... exactly as the service raised them.
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function call(method, path, body) {
    const headers = { accept: "application/json", ...(await hostAuthorization()) };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(new URL(`${API_PREFIX}${path}`, host), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch (error) {
      const failure = new Error(`The local SimForge service is not reachable: ${error?.message ?? String(error)}`);
      failure.name = "NetworkError";
      throw failure;
    }
    const payload = await response.json().catch(() => null);
    if (response.ok) return payload;
    const detail = payload && typeof payload === "object" && payload.error && typeof payload.error === "object" ? payload.error : {};
    const failure = new Error(typeof detail.message === "string" ? detail.message : `The local SimForge service answered HTTP ${response.status}`);
    failure.name = typeof detail.name === "string" && detail.name ? detail.name : "MapCacheError";
    throw failure;
  }

  /** @param {{ url: string }} result */
  function absolute(result) {
    return { ...result, url: new URL(result.url, trustedOrigin).href };
  }

  const methods = {
    status: () => call("GET", "/status"),
    has: async (query) => (await call("POST", "/has", query)).cached === true,
    ensure: async (request) => absolute(await call("POST", "/ensure", request)),
    cancel: async (requestId) => {
      await call("POST", "/cancel", { requestId });
    },
    receipt: async (key) => (await call("GET", `/receipt?key=${encodeURIComponent(String(key))}`)).receipt ?? null,
    writeReceipt: async (key, receipt) => {
      await call("PUT", "/receipt", { key, receipt });
    },
    clear: async () => {
      await call("POST", "/clear");
    },
    chooseDirectory: async () => {
      const selected = await chooseDirectory();
      if (selected === null || selected === undefined) return call("GET", "/status");
      return call("POST", "/location", { directory: selected });
    },
  };

  /** @param {import("electron").IpcMainInvokeEvent} event */
  function trustedSender(event) {
    if (window.isDestroyed()) return false;
    const contents = window.webContents;
    if (!event.sender || event.sender.id !== contents.id) return false;
    const frame = event.senderFrame;
    const main = contents.mainFrame;
    if (!frame || !main || frame.processId !== main.processId || frame.routingId !== main.routingId) return false;
    try {
      return new URL(frame.url).origin === trustedOrigin;
    } catch {
      return false;
    }
  }

  const channels = Object.keys(methods).map((name) => `${DESKTOP_MAP_CACHE_IPC_PREFIX}${name}`);
  for (const [name, method] of Object.entries(methods)) {
    ipcMain.handle(`${DESKTOP_MAP_CACHE_IPC_PREFIX}${name}`, async (event, ...args) => {
      if (!trustedSender(event)) {
        return { ok: false, error: { name: "SecurityError", message: "The desktop map cache is only available to the SimForge window" } };
      }
      try {
        return { ok: true, value: await method(...args) };
      } catch (error) {
        return {
          ok: false,
          error: {
            name: typeof error?.name === "string" && error.name ? error.name : "Error",
            message: error?.message ?? String(error),
          },
        };
      }
    });
  }

  return {
    async dispose() {
      for (const channel of channels) ipcMain.removeHandler(channel);
    },
  };
}
