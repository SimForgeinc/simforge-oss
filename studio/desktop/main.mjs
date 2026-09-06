// SimForge desktop shell (Electron).
//
// This is packaging, not a second UI: it hosts the same Next.js Studio the
// browser serves, in one of two explicit modes.
//
//   local   The fully bundled runtime: starts or attaches to the local Studio
//           host (desktop/local-host.mjs) and loads it from loopback. Native
//           pieces are platform-qualified by the stage manifest.
//   cloud   SimCloud connected: loads the configured HTTPS SimCloud origin, the
//           full hosted product, in an isolated persistent session so sign-in
//           survives restarts. No host, no native runtime, nothing Linux-only.
//
// Both modes give the page the filesystem map cache through the preload bridge
// (desktop/cache-preload.cjs) and the `simforge-cache://` streaming protocol
// installed by desktop/map-cache.mjs, so the multi-gigabyte map corpus lives
// on disk instead of in browser storage. Renderers stay sandboxed with context
// isolation and no Node; only the shell-trusted origin can use the bridge.
//
// The mode is fixed at stage time (desktop/stage.mjs, desktop/stage-cloud.mjs
// bake SIMFORGE_DESKTOP_MODE / SIMFORGE_DESKTOP_BUILT_ORIGIN into this
// bundle); from a workspace, `pnpm desktop` is local and
// `SIMFORGE_DESKTOP_MODE=cloud SIMCLOUD_ORIGIN=… pnpm desktop` is cloud.
// SIMCLOUD_ORIGIN overrides the built origin at runtime; only HTTPS, or HTTP on
// loopback for local qualification, is accepted.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from "electron";

const CLOUD = process.env.SIMFORGE_DESKTOP_MODE === "cloud";
// Dead in the cloud bundle: the stage defines SIMFORGE_DESKTOP_MODE, so the
// local host (and @simforge-oss/studio-host) is never bundled into it.
const localHostModule = process.env.SIMFORGE_DESKTOP_MODE === "cloud" ? null : await import("./local-host.mjs");

const PRODUCT = CLOUD
  ? { name: "SimCloud", appId: "ai.simforge.simcloud", dataDir: "SimCloud", landing: "/dashboard" }
  : { name: "SimForge Studio", appId: "ai.simforge.studio", dataDir: "SimForge Studio", landing: "/dashboard/scenario" };

/** Static pages and the preload ship beside this file (asar when packaged). */
const pagesDir = app.isPackaged ? app.getAppPath() : dirname(fileURLToPath(import.meta.url));
const preloadPath = join(pagesDir, "cache-preload.cjs");
/** Browser permissions the hosted product legitimately asks for; everything else is denied. */
const RENDERER_PERMISSIONS = new Set(["fullscreen", "pointerLock", "clipboard-sanitized-write"]);

/** @type {BrowserWindow | null} */
let window = null;
/** @type {{ dispose(): Promise<void> } | null} */
let mapCache = null;
/** The origin whose pages may use the bridge; fixed once the mode resolves it. */
let trustedOrigin = "";
const localHost = localHostModule?.createLocalHost({
  port: Number(process.env.PORT ?? "5199"),
  onExit: (code) => {
    if (window && !window.isDestroyed()) {
      void window.loadFile(join(pagesDir, "host-exited.html"), { query: { code: String(code ?? "unknown") } });
    }
  },
}) ?? null;

/**
 * The SimCloud origin this build connects to. HTTPS only; plain HTTP is
 * accepted solely on loopback so Main can qualify the packaged app against a
 * locally served product.
 */
function resolveCloudOrigin() {
  const configured = process.env.SIMCLOUD_ORIGIN ?? process.env.SIMFORGE_DESKTOP_BUILT_ORIGIN;
  if (!configured) throw new Error("No SimCloud origin is configured: set SIMCLOUD_ORIGIN (https://…).");
  /** @type {URL} */
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`SimCloud origin is not a URL: ${configured}`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`SimCloud origin must be https:// (http:// only on loopback): ${configured}`);
  }
  return url.origin;
}

/**
 * Where downloaded maps live unless the user picks another folder: per-user,
 * non-roaming, never purged by the OS as a cache, and outside the install
 * directory so installers and updates never touch it.
 */
function defaultMapCacheRoot() {
  switch (process.platform) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), PRODUCT.dataDir, "map-cache");
    case "darwin":
      return join(homedir(), "Library", "Application Support", PRODUCT.dataDir, "map-cache");
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), PRODUCT.dataDir.toLowerCase().replace(/ /g, "-"), "map-cache");
  }
}

/** @param {string} target */
function isTrusted(target) {
  try {
    return new URL(target).origin === trustedOrigin;
  } catch {
    return false;
  }
}

/** Hand links to the system browser; nothing else (file:, custom schemes) leaves the app. */
function openExternal(target) {
  if (/^(https?|mailto):/i.test(target)) void shell.openExternal(target);
}

/** @returns {import("electron").WebPreferences} */
function webPreferences() {
  return {
    preload: preloadPath,
    partition: CLOUD ? "persist:simcloud" : undefined,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
}

/**
 * Renderers may navigate and open windows only within the trusted origin;
 * every other link goes to the system browser. Same-origin popups get the
 * same locked-down preferences, and are guarded recursively.
 * @param {import("electron").WebContents} contents
 */
function guardContents(contents) {
  contents.on("will-navigate", (event, target) => {
    if (isTrusted(target)) return;
    event.preventDefault();
    openExternal(target);
  });
  contents.on("will-redirect", (event, target) => {
    if (isTrusted(target)) return;
    event.preventDefault();
    openExternal(target);
  });
  contents.setWindowOpenHandler(({ url: target }) => {
    if (isTrusted(target)) {
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: webPreferences() } };
    }
    openExternal(target);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => guardContents(child.webContents));
}

function createWindow() {
  window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 640,
    title: PRODUCT.name,
    backgroundColor: "#0b0e14",
    webPreferences: webPreferences(),
  });
  guardContents(window.webContents);
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(RENDERER_PERMISSIONS.has(permission) && isTrusted(details.requestingUrl));
  });
  if (CLOUD) {
    window.webContents.on("did-fail-load", (_event, code, description, target, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation superseded by another, not a failure.
      if (!isMainFrame || code === -3 || !window || window.isDestroyed()) return;
      void window.loadFile(join(pagesDir, "unreachable.html"), {
        query: { origin: trustedOrigin, url: target, error: `${description} (${code})` },
      });
    });
  }
  window.loadFile(join(pagesDir, "starting.html"), { query: { product: PRODUCT.name, mode: CLOUD ? "cloud" : "local" } });
  window.on("closed", () => {
    window = null;
  });
  return window;
}

/**
 * The native folder picker the cache installer calls for
 * `mapCache.chooseDirectory()`; the switch itself (after active transfers
 * settle, leaving the old folder intact) is the installer's.
 * @returns {Promise<string | null>}
 */
async function chooseDirectory() {
  const owner = window && !window.isDestroyed() ? window : undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
    title: "Choose the map cache folder",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return canceled || filePaths.length === 0 ? null : filePaths[0];
}

/**
 * Menu-driven cache controls go through the very bridge the page uses, in the
 * trusted page: no second IPC surface, and the installer's sender checks and
 * scoping apply unchanged.
 * @param {"status" | "clear" | "chooseDirectory"} method
 */
async function bridgeCall(method) {
  if (!window || window.isDestroyed() || !isTrusted(window.webContents.getURL())) {
    throw new Error(`${PRODUCT.name} is not open yet; the map cache is available once the app has loaded.`);
  }
  return window.webContents.executeJavaScript(`window.simforgeDesktop.mapCache.${method}()`, true);
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** @param {{ directory: string; usedBytes: number; availableBytes: number | null; assetCount: number; activeDownloads: number }} status */
function describeStatus(status) {
  return [
    `Folder: ${status.directory}`,
    `Stored: ${formatBytes(status.usedBytes)} in ${status.assetCount} assets`,
    `Free on disk: ${status.availableBytes === null ? "unknown" : formatBytes(status.availableBytes)}`,
    `Active downloads: ${status.activeDownloads}`,
  ].join("\n");
}

/** @param {() => Promise<void>} action */
function menuAction(action) {
  return () => action().catch((error) => {
    dialog.showErrorBox("Map cache", error instanceof Error ? error.message : String(error));
  });
}

const cacheMenu = {
  label: "Map Cache",
  submenu: [
    {
      label: "Cache Usage…",
      click: menuAction(async () => {
        const status = await bridgeCall("status");
        await dialog.showMessageBox({ type: "info", title: "Map cache", message: "Map cache on this computer", detail: describeStatus(status) });
      }),
    },
    {
      label: "Open Cache Folder",
      click: menuAction(async () => {
        const status = await bridgeCall("status");
        const failure = await shell.openPath(status.directory);
        if (failure) throw new Error(failure);
      }),
    },
    { type: "separator" },
    {
      label: "Change Cache Location…",
      click: menuAction(async () => {
        const status = await bridgeCall("chooseDirectory");
        await dialog.showMessageBox({ type: "info", title: "Map cache", message: "Map cache location", detail: describeStatus(status) });
      }),
    },
    {
      label: "Clear Map Cache…",
      click: menuAction(async () => {
        const status = await bridgeCall("status");
        const { response } = await dialog.showMessageBox({
          type: "warning",
          title: "Clear map cache",
          message: `Delete ${formatBytes(status.usedBytes)} of downloaded maps?`,
          detail: `${status.assetCount} assets in ${status.directory} will be removed and downloaded again when needed.`,
          buttons: ["Clear cache", "Keep"],
          defaultId: 1,
          cancelId: 1,
        });
        if (response === 0) await bridgeCall("clear");
      }),
    },
  ],
};

function installMenu() {
  const helpItems = CLOUD
    ? [
      { label: "Reconnect", click: () => { if (trustedOrigin) void window?.loadURL(`${trustedOrigin}${PRODUCT.landing}`); } },
      { label: `Open ${PRODUCT.name} in browser`, click: () => openExternal(trustedOrigin) },
    ]
    : [
      { label: "Open data folder", click: () => void shell.openPath(localHost.dataDir) },
      { label: "Host capabilities", click: () => openExternal(`${trustedOrigin}/api/simforge/host/capabilities`) },
    ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    cacheMenu,
    { role: "windowMenu" },
    { role: "help", submenu: helpItems },
  ]));
}

/** Resolve the trusted origin for this mode; local mode starts or attaches to the host first. */
async function resolveOrigin() {
  if (CLOUD) return resolveCloudOrigin();
  const host = await localHost.start();
  return new URL(host.baseUrl).origin;
}

async function shutdown() {
  const cache = mapCache;
  mapCache = null;
  await cache?.dispose();
  await localHost?.stop();
}

// Scheme privileges must be registered before the app is ready; the cache
// installer registers the handler itself on the window's session.
protocol.registerSchemesAsPrivileged([{
  scheme: "simforge-cache",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);
if (process.platform === "win32") app.setAppUserModelId(PRODUCT.appId);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  app.whenReady().then(async () => {
    installMenu();
    const win = createWindow();
    try {
      trustedOrigin = await resolveOrigin();
      mapCache = await installDesktopMapCache({
        session: win.webContents.session,
        ipcMain,
        window: win,
        trustedOrigin,
        defaultCacheRoot: defaultMapCacheRoot(),
        chooseDirectory,
      });
      if (win.isDestroyed()) return;
      // Cloud: an unreachable origin is shown by did-fail-load (unreachable.html)
      // and retried from the menu; only the local host failing is fatal.
      await (CLOUD ? win.loadURL(`${trustedOrigin}${PRODUCT.landing}`).catch(() => undefined) : win.loadURL(`${trustedOrigin}${PRODUCT.landing}`));
    } catch (error) {
      dialog.showErrorBox(`${PRODUCT.name} could not start`, error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });
  app.on("window-all-closed", () => {
    app.quit();
  });
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || (!mapCache && !localHost?.owned())) return;
    event.preventDefault();
    quitting = true;
    void shutdown().finally(() => app.quit());
  });
}
