// SimForge Studio desktop shell (Electron).
//
// This is packaging, not a second UI: it hosts the same Next.js Studio the
// browser serves. There is exactly one mode. The shell starts (or attaches
// to) the bundled local Studio host and loads it from loopback; the host owns
// the database, artifacts, the on-disk map cache and native job state under
// one per-user data root. SimCloud is a connection the local product makes
// (Settings › SimCloud, sign-in in the system browser), never a remote site
// this window navigates to.
//
// Security posture: renderers are sandboxed with context isolation and no
// Node; the only bridge is the narrow map-cache preload
// (desktop/cache-preload.cjs). The local service accepts requests only with
// the per-start control token (native processes: this shell, the worker) or
// the trusted-local session cookie this shell sets on its own session
// (HttpOnly, SameSite=Strict, an HMAC of the token, never the token). Every
// navigation or window.open outside the loopback origin goes to the system
// browser — that is how the SimCloud authorization page opens.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { access, readFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { installDesktopMapCache } from "./map-cache.mjs";
import { LOCAL_HOST_SESSION_COOKIE } from "@simforge-oss/studio-host/node";
import { createLocalHost } from "./local-host.mjs";
import { PRODUCT } from "./stage-manifest.mjs";
import { readDistributionIdentity } from "./release-identity.mjs";
import { checkForUpdates, describeUpdate } from "./update-check.mjs";
import { configureAutoUpdater } from "./auto-updater.mjs";

/** Static pages and the preload ship beside this file (asar when packaged). */
const pagesDir = app.isPackaged ? app.getAppPath() : dirname(fileURLToPath(import.meta.url));
const preloadPath = join(pagesDir, "cache-preload.cjs");
/** Browser permissions the hosted product legitimately asks for; everything else is denied. */
const RENDERER_PERMISSIONS = new Set(["fullscreen", "pointerLock", "clipboard-sanitized-write"]);

/** @type {BrowserWindow | null} */
let window = null;
/** @type {{ dispose(): Promise<void> } | null} */
let mapCache = null;
/** The loopback origin whose pages may use the bridge; fixed once the host is up. */
let trustedOrigin = "";

/**
 * The one per-user data root of this installation: database, artifacts,
 * map cache, native job state. Per-user, non-roaming, never purged by the OS
 * as a cache, and outside the install directory so installers and updates
 * never touch it. Windows keeps it in %LOCALAPPDATA% (the NSIS uninstaller
 * only clears %APPDATA%, and only with deleteAppDataOnUninstall); Linux uses
 * XDG data, not the ~/.config profile; macOS uses Application Support (Caches
 * would be purgeable).
 *
 * `SIMFORGE_CLOUD_ROOT` overrides it (isolated qualification, developers). A
 * workspace shell (`pnpm desktop`) keeps the CLI default so `pnpm dev`,
 * `pnpm host:stop` and the shell agree on one host record. An installed app
 * whose OS location holds no database yet adopts an existing `~/.simforge/cloud`
 * from earlier builds rather than presenting an empty Studio.
 */
async function resolveDataRoot() {
  const explicit = process.env.SIMFORGE_CLOUD_ROOT?.trim();
  const legacy = join(homedir(), ".simforge", "cloud");
  if (explicit) return explicit;
  if (!app.isPackaged) return legacy;
  const osRoot = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), PRODUCT.dataDir)
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", PRODUCT.dataDir)
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), PRODUCT.packageName);
  const exists = (path) => access(path).then(() => true, () => false);
  if (!(await exists(join(osRoot, "db"))) && (await exists(join(legacy, "db")))) return legacy;
  return osRoot;
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
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 18 } }
      : {}),
    ...(process.platform === "linux" ? { icon: join(pagesDir, "icon.png") } : {}),
    webPreferences: webPreferences(),
  });
  guardContents(window.webContents);
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(RENDERER_PERMISSIONS.has(permission) && isTrusted(details.requestingUrl));
  });
  window.loadFile(join(pagesDir, "starting.html"));
  window.on("closed", () => {
    window = null;
  });
  return window;
}

/**
 * The native folder picker the cache bridge calls for
 * `mapCache.chooseDirectory()`; only this process hands the chosen path to the
 * protected local service, the renderer never names a path.
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
 * trusted page: no second IPC surface, and the bridge's sender checks and
 * scoping apply unchanged. The bridge's rejection is carried back explicitly:
 * executeJavaScript replaces a thrown error with a generic message.
 * @param {"status" | "clear" | "chooseDirectory"} method
 */
async function bridgeCall(method) {
  if (!window || window.isDestroyed() || !isTrusted(window.webContents.getURL())) {
    throw new Error(`${PRODUCT.name} is not open yet; the map cache is available once the app has loaded.`);
  }
  const result = await window.webContents.executeJavaScript(
    `window.simforgeDesktop.mapCache.${method}().then((value) => ({ value }), (error) => ({ error: String(error?.message ?? error) }))`,
    true,
  );
  if ("error" in result) throw new Error(result.error);
  return result.value;
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** @param {{ directory: string; usedBytes: number; availableBytes: number | null; assetCount: number; activeDownloads: number; unavailable: string | null }} status */
function describeStatus(status) {
  return [
    `Folder: ${status.directory}`,
    ...(status.unavailable ? [`Location unavailable: ${status.unavailable}`] : []),
    `Stored: ${formatBytes(status.usedBytes)} in ${status.assetCount} assets`,
    `Free on disk: ${status.availableBytes === null ? "unknown" : formatBytes(status.availableBytes)}`,
    `Active downloads: ${status.activeDownloads}`,
  ].join("\n");
}

/** @param {() => Promise<void>} action */
function menuAction(action) {
  return () => action().catch((error) => {
    dialog.showErrorBox(PRODUCT.name, error instanceof Error ? error.message : String(error));
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
          detail: `${status.assetCount} assets in ${status.directory} will be removed and downloaded again when needed. Projects, jobs and their artifacts are kept.`,
          buttons: ["Clear cache", "Keep"],
          defaultId: 1,
          cancelId: 1,
        });
        if (response === 0) await bridgeCall("clear");
      }),
    },
  ],
};

/**
 * What this packaged build says about itself: the Cloud service it connects
 * to and the distribution it was published as. Absent when the shell runs
 * unpackaged (`electron desktop/main.mjs`), where there is no app.asar and
 * no publication.
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function packagedMetadata() {
  if (!app.isPackaged) return null;
  return JSON.parse(await readFile(join(pagesDir, "package.json"), "utf8"));
}

/**
 * The shell's updater, once configured (see desktop/auto-updater.mjs). Its
 * state drives the Help menu; Electron menus are immutable once built, so a
 * state change rebuilds the menu rather than mutating a label.
 * @type {{ enabled: boolean; state?: string; detail?: string; check?: () => Promise<unknown>; install?: () => void; timer?: NodeJS.Timeout } | null}
 */
let shellUpdater = null;

/**
 * Help › Check for Updates…. With the updater enabled (packaged Windows or
 * Linux build with a distribution identity) this checks, downloads and,
 * once a version is ready, restarts into it. Otherwise (unpackaged, unlabelled,
 * or macOS without a signing identity) it stays the manual read-only check
 * of desktop/update-check.mjs: a release name and a page to open.
 */
function updateMenuItem() {
  const updater = shellUpdater;
  if (updater?.enabled) {
    const label = updater.state === "checking" ? "Checking for Updates…"
      : updater.state === "downloading" ? `Downloading update ${updater.detail ?? ""}`.trim()
      : updater.state === "ready" ? `Restart to update to ${updater.detail}`
      : updater.state === "current" ? "Up to date — check again"
      : updater.state === "error" ? "Update check failed — retry"
      : "Check for Updates…";
    return {
      label,
      enabled: updater.state !== "checking" && updater.state !== "downloading",
      click: () => {
        if (updater.state === "ready") updater.install?.();
        else void updater.check?.().catch((error) => {
          dialog.showErrorBox(PRODUCT.name, error instanceof Error ? error.message : String(error));
        });
      },
    };
  }
  return {
    label: "Check for Updates…",
    click: menuAction(async () => {
      const metadata = await packagedMetadata();
      const result = await checkForUpdates({
        identity: readDistributionIdentity(metadata?.simforgeDistribution),
        cloudOrigin: typeof metadata?.simforgeCloudOrigin === "string" ? metadata.simforgeCloudOrigin : null,
        userAgent: `${PRODUCT.packageName}/${app.getVersion()} (+https://github.com/SimForgeinc/simforge-oss)`,
      });
      const { message, detail, url } = describeUpdate(result);
      const buttons = url ? ["Open release page", "Close"] : ["Close"];
      const { response } = await dialog.showMessageBox({
        type: result.state === "update-available" ? "info" : "none",
        title: "SimForge Studio updates",
        message,
        detail,
        buttons,
        defaultId: url ? 1 : 0,
        cancelId: buttons.length - 1,
      });
      if (url && response === 0) openExternal(url);
    }),
  };
}

/** @param {ReturnType<typeof createLocalHost>} localHost */
function installMenu(localHost) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    // The application menu is a macOS concept; elsewhere its roles are inert.
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    cacheMenu,
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        updateMenuItem(),
        { type: "separator" },
        { label: "Open data folder", click: () => void shell.openPath(localHost.dataRoot) },
        {
          label: "Local host…",
          click: menuAction(async () => {
            const response = await fetch(`${trustedOrigin}/api/simforge/host/capabilities`, { headers: await localHost.authorization() });
            if (!response.ok) throw new Error(`The local host answered ${response.status}.`);
            const capabilities = await response.json();
            const runtime = capabilities.execution?.nativeRuntime;
            await dialog.showMessageBox({
              type: "info",
              title: "Local host",
              message: `${capabilities.host?.label ?? PRODUCT.name} ${capabilities.host?.version ?? ""}`.trim(),
              detail: [
                `Origin: ${trustedOrigin} (${localHost.owned() ? "started by this app" : "attached"})`,
                `Data: ${localHost.dataRoot}`,
                `Native runtime: ${runtime?.state === "available" ? `${runtime.runtime.version} (${runtime.runtime.target})` : `unavailable — ${runtime?.reason ?? "unknown"}`}`,
              ].join("\n"),
            });
          }),
        },
      ],
    },
  ]));
}

/** @param {ReturnType<typeof createLocalHost>} localHost */
async function shutdown(localHost) {
  const cache = mapCache;
  mapCache = null;
  await cache?.dispose();
  await localHost.stop();
}

// One application identity everywhere: profile directory, notifications,
// single-instance lock, taskbar grouping.
app.setName(PRODUCT.name);
if (process.platform === "win32") app.setAppUserModelId(PRODUCT.appId);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  /** @type {ReturnType<typeof createLocalHost> | null} */
  let localHost = null;
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
    const win = createWindow();
    try {
      const dataRoot = await resolveDataRoot();
      let cloudOrigin = process.env.SIMFORGE_CLOUD_ORIGIN?.trim();
      if (app.isPackaged) {
        const metadata = JSON.parse(await readFile(join(pagesDir, "package.json"), "utf8"));
        if (typeof metadata.simforgeCloudOrigin !== "string") throw new Error("The desktop package has no Cloud service origin");
        const configured = new URL(metadata.simforgeCloudOrigin);
        if (configured.protocol !== "https:" || configured.origin !== metadata.simforgeCloudOrigin) {
          throw new Error("The desktop package has an invalid Cloud service origin");
        }
        cloudOrigin ||= metadata.simforgeCloudOrigin;
      }
      localHost = createLocalHost({
        port: Number(process.env.PORT ?? (app.isPackaged ? "0" : "5199")),
        dataRoot,
        env: cloudOrigin ? { SIMFORGE_CLOUD_ORIGIN: cloudOrigin } : {},
        onExit: (code) => {
          if (window && !window.isDestroyed()) {
            void window.loadFile(join(pagesDir, "host-exited.html"), { query: { code: String(code ?? "unknown") } });
          }
        },
      });
      installMenu(localHost);
      const host = await localHost.start();
      trustedOrigin = new URL(host.baseUrl).origin;
      if (win.isDestroyed()) return;
      // The trusted-local session for this window's origin only: HttpOnly, so
      // page script never sees it; Strict, so no cross-site page can ride it.
      await win.webContents.session.cookies.set({
        url: trustedOrigin,
        name: LOCAL_HOST_SESSION_COOKIE,
        value: localHost.sessionToken(),
        httpOnly: true,
        sameSite: "strict",
        secure: false,
      });
      // Background updates: only a packaged build with a distribution identity
      // knows its channel; the first check waits for the window to be on
      // screen and the local host to be serving, so a slow update feed never
      // delays startup.
      const distribution = readDistributionIdentity((await packagedMetadata())?.simforgeDistribution);
      shellUpdater = configureAutoUpdater({
        channel: distribution?.channel ?? null,
        onState: (state, detail) => {
          if (!shellUpdater) return;
          shellUpdater.state = state;
          shellUpdater.detail = detail;
          if (localHost) installMenu(localHost);
        },
      });
      if (shellUpdater.enabled) {
        const check = () => void shellUpdater?.check?.().catch(() => undefined);
        setTimeout(check, 15_000).unref();
        shellUpdater.timer = setInterval(check, 4 * 60 * 60 * 1000);
        shellUpdater.timer.unref();
      }
      mapCache = await installDesktopMapCache({
        ipcMain,
        window: win,
        trustedOrigin,
        hostBaseUrl: host.baseUrl,
        hostAuthorization: localHost.authorization,
        chooseDirectory,
      });
      if (win.isDestroyed()) return;
      await win.loadURL(`${trustedOrigin}${PRODUCT.landing}`);
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
    if (shellUpdater?.timer) clearInterval(shellUpdater.timer);
    if (quitting || !localHost || (!mapCache && !localHost.owned())) return;
    event.preventDefault();
    quitting = true;
    void shutdown(localHost).finally(() => app.quit());
  });
}
