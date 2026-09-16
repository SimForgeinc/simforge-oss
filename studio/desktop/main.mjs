// SimForge Studio desktop shell (Electron).
//
// This is packaging, not a second UI: it hosts the same Next.js Studio the
// browser serves. The shell attaches to one Studio host per launch, chosen
// before any host page loads (desktop/connections-window.mjs): by default it
// starts (or attaches to) the bundled local host and loads it from loopback,
// and the host owns the database, artifacts, the on-disk map cache and native
// job state under one per-user data root. A paired remote host makes the
// shell a guest of a host on another machine, starting and supervising
// nothing (see desktop/remote-host.mjs), which puts every filesystem the host
// owns on that machine instead of this one. Switching hosts is a relaunch:
// the trusted origin, the session cookie, the map-cache bridge, the menu and
// the updater are all derived from the choice once, below. SimCloud is a
// connection the local product makes (Settings › SimCloud account: sign-in,
// sign-up, verification and password flows are all in-app forms the local
// host forwards), never a remote site this window navigates to.
//
// Security posture: renderers are sandboxed with context isolation and no
// Node; the only bridge is the narrow map-cache preload
// (desktop/cache-preload.cjs). The local service accepts requests only with
// the per-start control token (native processes: this shell, the worker) or
// the trusted-local session cookie this shell sets on its own session
// (HttpOnly, SameSite=Strict, an HMAC of the token, never the token). Every
// navigation or window.open outside the host origin goes to the system
// browser — docs, mailto links, and the one account flow that must leave the
// app: Google/GitHub sign-in, which returns to the loopback callback.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { access, readFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from "electron";
import { installDesktopMapCache } from "./map-cache.mjs";
import { LOCAL_HOST_SESSION_COOKIE } from "@simforge-oss/studio-host/node";
import { createLocalHost } from "./local-host.mjs";
import { createRemoteHost, REMOTE_HOST_ENV, remoteHostTarget } from "./remote-host.mjs";
import { CHOOSE_CONNECTION_ARG, openConnectionStore, openShellVault, resolveRemoteTarget } from "./connections.mjs";
import { NativeViewportProcess } from "./native-viewport.mjs";
import { chooseConnection, reportLostConnection } from "./connections-window.mjs";
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
let nativeViewport = null;
let mapCache = null;
/** The host origin whose pages may use the bridge; fixed once the host is up. */
let trustedOrigin = "";
/**
 * Set when this shell is a guest of a Studio host on another machine (a
 * paired connection, or `SIMFORGE_REMOTE_HOST`; see desktop/remote-host.mjs).
 * Everything the host owns then lives on the host's filesystem, not this
 * computer's: the database, the artifacts, the map cache folder and the
 * native runtime. The shell features that hand a path of *this* machine to
 * the host, or open a path of *the host* on this machine, are refused rather
 * than silently pointing at the wrong filesystem.
 * @type {string | null}
 */
let remoteHostOrigin = null;
/** True when the environment named this launch's host: the chooser is bypassed and switching is disabled. */
let connectionPinnedByEnv = false;

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
 * `simforge host stop` and the shell agree on one host record. An installed app
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

/**
 * The app's top bar is the window's title bar. `AppTopBar.stylex.ts` sets the
 * bar to 3.5rem, which is 56px at the 16px root the shell always has; the
 * Windows/Linux control overlay is drawn at that height so the native
 * minimise/maximise/close sit inside the bar instead of on a strip above it.
 */
const TOP_BAR_HEIGHT = 56;
/** The bar's ink: `--foreground` in the dark theme (hsl(0 0% 93%)). */
const TOP_BAR_SYMBOL_COLOR = "#ededed";

function createWindow() {
  window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 640,
    title: PRODUCT.name,
    // hsl(0 0% 4%), the product's --background: no flash before shell.css paints.
    backgroundColor: "#0a0a0a",
    // One bar, every platform: the native title bar is hidden and its controls
    // are overlaid on the page (Window Controls Overlay). The page reads their
    // geometry through `env(titlebar-area-*)` and keeps its content clear of
    // them; see `.app-topbar-native` in packages/studio-ui/src/styles.css.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? {
          titleBarOverlay: true,
          // Vertically centred in the bar: the traffic lights are 12px tall.
          trafficLightPosition: { x: 14, y: (TOP_BAR_HEIGHT - 12) / 2 },
        }
      : {
          titleBarOverlay: { color: "#0a0a0a", symbolColor: TOP_BAR_SYMBOL_COLOR, height: TOP_BAR_HEIGHT },
          // The application menu stays reachable with Alt; shown, it would be
          // a second strip between the overlay and the page.
          autoHideMenuBar: true,
        }),
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
 * protected local service, the renderer never names a path. A folder on this
 * computer means nothing to a host on another machine, so remote-host mode
 * refuses instead of pointing the host's cache at a path it cannot write.
 * @returns {Promise<string | null>}
 */
async function chooseDirectory() {
  if (remoteHostOrigin) {
    const refusal = new Error(`The map cache belongs to the Studio host at ${remoteHostOrigin} and is stored on that machine. A folder on this computer cannot hold it; change the cache location from the host machine.`);
    refusal.name = "RemoteHostUnsupported";
    throw refusal;
  }
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
    `Folder: ${status.directory}${remoteHostOrigin ? ` (on ${remoteHostOrigin})` : ""}`,
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
        await dialog.showMessageBox({ type: "info", title: "Map cache", message: remoteHostOrigin ? `Map cache on the Studio host ${remoteHostOrigin}` : "Map cache on this computer", detail: describeStatus(status) });
      }),
    },
    {
      label: "Open Cache Folder",
      click: menuAction(async () => {
        const status = await bridgeCall("status");
        // The path names a folder on the host's filesystem; opening it here
        // would open an unrelated folder of this computer, or nothing.
        if (remoteHostOrigin) throw new Error(`The cache folder ${status.directory} is on the Studio host ${remoteHostOrigin}, not on this computer. Open it there.`);
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

/**
 * Switching hosts is a relaunch, never a hot swap: the trusted origin, the
 * session cookie, the map-cache bridge, the menu and the updater were all
 * derived from this launch's choice, and re-deriving them under a live
 * renderer that assumed one origin would leave that renderer wrong. The new
 * instance shows the chooser; the launcher waits for this one to exit, so
 * the single-instance lock is free by then.
 */
function relaunch({ chooser }) {
  const args = process.argv.slice(1).filter((arg) => arg !== CHOOSE_CONNECTION_ARG);
  app.relaunch({ args: chooser ? [...args, CHOOSE_CONNECTION_ARG] : args });
  app.quit();
}

function relaunchToChooser() {
  relaunch({ chooser: true });
}

function connectionMenu() {
  return {
    label: "Connection",
    submenu: [
      {
        label: remoteHostOrigin ? `Attached to ${remoteHostOrigin}` : "Attached to this computer",
        enabled: false,
      },
      { type: "separator" },
      connectionPinnedByEnv
        ? { label: `Chosen by ${REMOTE_HOST_ENV} for this launch`, enabled: false }
        : {
          label: "Switch Connection…",
          click: menuAction(async () => {
            const { response } = await dialog.showMessageBox({
              type: "question",
              title: "Switch connection",
              message: `Switch to another Studio host?`,
              detail: "SimForge Studio relaunches and shows the connection chooser. This window, its session and its menus are built for one host at startup, so a switch restarts the app rather than swapping the host underneath it. Unsaved edits in the current host are kept by that host.",
              buttons: ["Relaunch and choose", "Cancel"],
              defaultId: 0,
              cancelId: 1,
            });
            if (response === 0) relaunchToChooser();
          }),
        },
    ],
  };
}

function launchNativeViewport() {
  if (nativeViewport) return nativeViewport;
  const executable = process.env.SIMFORGE_NATIVE_VIEWPORT;
  const mapRoot = process.env.SIMFORGE_NATIVE_MAP_ROOT;
  if (!executable || !mapRoot) throw new Error("Native viewport requires SIMFORGE_NATIVE_VIEWPORT and SIMFORGE_NATIVE_MAP_ROOT.");
  nativeViewport = new NativeViewportProcess({
    executable,
    mapRoot,
    mapVersionId: process.env.SIMFORGE_NATIVE_MAP_ID ?? "native-map",
    releaseDigest: process.env.SIMFORGE_NATIVE_RELEASE_DIGEST ?? "native-release",
  });
  nativeViewport.onEvent((event) => {
    if (event.event === "error") console.error("[native-viewport]", event.error);
  });
  nativeViewport.start().catch((error) => console.error("[native-viewport]", error));
  return nativeViewport;
}

/** @param {ReturnType<typeof createLocalHost> | ReturnType<typeof createRemoteHost>} localHost */
function installMenu(localHost) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    // The application menu is a macOS concept; elsewhere its roles are inert.
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    ...(process.env.SIMFORGE_NATIVE_VIEWPORT && process.env.SIMFORGE_NATIVE_MAP_ROOT ? [{
      label: "Native viewport",
      submenu: [{ label: "Open native viewport", click: menuAction(() => launchNativeViewport()) }],
    }] : []),
    connectionMenu(),
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        updateMenuItem(),
        { type: "separator" },
        {
          label: "Open data folder",
          click: menuAction(async () => {
            // A remote host keeps its data root on its own filesystem.
            if (localHost.dataRoot === null) throw new Error(`The data folder belongs to the Studio host at ${trustedOrigin} and is on that machine, not this computer. Open it there.`);
            const failure = await shell.openPath(localHost.dataRoot);
            if (failure) throw new Error(failure);
          }),
        },
        {
          label: "Studio host…",
          click: menuAction(async () => {
            const response = await fetch(`${trustedOrigin}/api/simforge/host/capabilities`, { headers: await localHost.authorization() });
            if (!response.ok) throw new Error(`The Studio host answered ${response.status}.`);
            const capabilities = await response.json();
            const runtime = capabilities.execution?.nativeRuntime;
            await dialog.showMessageBox({
              type: "info",
              title: "Studio host",
              message: `${capabilities.host?.label ?? PRODUCT.name} ${capabilities.host?.version ?? ""}`.trim(),
              detail: [
                `Origin: ${trustedOrigin} (${localHost.owned() ? "started by this app" : remoteHostOrigin ? "remote, not managed by this app" : "attached"})`,
                `Data: ${localHost.dataRoot ?? `on the host machine (${trustedOrigin})`}`,
                `Native runtime: ${runtime?.state === "available" ? `${runtime.runtime.version} (${runtime.runtime.target})` : `unavailable — ${runtime?.reason ?? "unknown"}`}`,
              ].join("\n"),
            });
          }),
        },
      ],
    },
  ]));
}

/** @param {ReturnType<typeof createLocalHost> | ReturnType<typeof createRemoteHost>} localHost */
async function shutdown(localHost) {
  const cache = mapCache;
  mapCache = null;
  await cache?.dispose();
  await localHost.stop();
  nativeViewport?.stop();
  nativeViewport = null;
}

// One application identity everywhere: profile directory, notifications,
// single-instance lock, taskbar grouping.
app.setName(PRODUCT.name);
if (process.platform === "win32") app.setAppUserModelId(PRODUCT.appId);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  /** @type {ReturnType<typeof createLocalHost> | ReturnType<typeof createRemoteHost> | null} */
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
  /**
   * Which host this launch attaches to, decided before any window exists.
   * `SIMFORGE_REMOTE_HOST` names one target for this launch and remembers
   * nothing. Otherwise the remembered choice is used, unless there is none,
   * the launch asked to choose (`--choose-connection`, how "Switch
   * Connection…" relaunches), or the remembered remote has lost its
   * credentials — then the chooser decides.
   * @returns {Promise<{ kind: "local" } | { kind: "remote"; target: { baseUrl: string; controlToken: string } } | { kind: "quit" }>}
   */
  async function selectConnection() {
    const fromEnv = remoteHostTarget(process.env);
    if (fromEnv) {
      connectionPinnedByEnv = true;
      return { kind: "remote", target: fromEnv };
    }
    const userData = app.getPath("userData");
    const store = await openConnectionStore(userData);
    // `safeStorage` is the OS credential store as the Electron binary exposes
    // it; the shell cannot load the product's native keyring binding because
    // app.asar carries no node_modules.
    const vault = await openShellVault({ dir: userData, storage: safeStorage });
    const selected = process.argv.includes(CHOOSE_CONNECTION_ARG) ? null : store.selected();
    if (selected === "local") return { kind: "local" };
    if (selected !== null) {
      const resolved = await resolveRemoteTarget({ store, vault, id: selected });
      if (resolved.kind === "ready") return { kind: "remote", target: resolved.target };
    }
    const chooser = chooseConnection({
      pagesDir,
      store,
      vault,
      local: { dataRoot: await resolveDataRoot(), detail: "Started by this app, or joined if it is already running. Data stays on this computer." },
    });
    const decision = await chooser.decision;
    if (decision.kind !== "quit") createWindow();
    chooser.close();
    return decision;
  }

  /**
   * A remote daemon that stops answering has no exit code to report, only
   * an origin: the window is hidden behind the lost-connection page, which
   * offers to try again, to relaunch into the chooser, or to quit.
   * @param {BrowserWindow} win
   * @param {ReturnType<typeof createRemoteHost>} host
   */
  function watchRemoteHost(win, host) {
    let lost = false;
    let failures = 0;
    const poll = setInterval(async () => {
      if (lost) return;
      if (await host.probe()) failures = 0;
      else if ((failures += 1) >= 2) void onLost(`${remoteHostOrigin} has not answered ${failures} consecutive probes.`);
    }, 15_000);
    poll.unref();
    win.once("closed", () => clearInterval(poll));
    win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation the page itself superseded.
      if (isMainFrame && code !== -3 && isTrusted(url)) void onLost(`${description} (${code}) loading ${url}`);
    });
    async function onLost(reason) {
      if (lost) return;
      lost = true;
      win.hide();
      const report = reportLostConnection({ pagesDir, origin: remoteHostOrigin, reason, probe: host.probe });
      const decision = await report.decision;
      if (decision.kind === "retry") {
        failures = 0;
        lost = false;
        win.show();
        report.close();
        await win.loadURL(`${trustedOrigin}${PRODUCT.landing}`);
      } else if (decision.kind === "switch") {
        relaunchToChooser();
      } else {
        app.quit();
      }
    }
  }

  /**
   * A remote host that never answered at startup is the same situation as
   * one that stops answering later — an origin and a reason, never an exit
   * code — so it gets the same page rather than a dead-end error dialog.
   * Nothing has been derived from the choice yet at this point, so "try
   * again" is a relaunch of the same selection: this launch already spent
   * its startup on a host that was not there.
   * @param {ReturnType<typeof createRemoteHost>} host
   * @param {string} reason
   */
  async function offerAnotherConnection(host, reason) {
    const report = reportLostConnection({ pagesDir, origin: remoteHostOrigin ?? "", reason, probe: host.probe });
    const decision = await report.decision;
    if (decision.kind === "retry") relaunch({ chooser: false });
    else if (decision.kind === "switch") relaunchToChooser();
    else app.quit();
    report.close();
  }

  app.whenReady().then(async () => {
    /** @type {BrowserWindow | null} */
    let win = null;
    /** @type {Awaited<ReturnType<typeof selectConnection>> | null} */
    let selection = null;
    try {
      selection = await selectConnection();
      if (selection.kind === "quit") {
        app.quit();
        return;
      }
      win = window ?? createWindow();
      // A remote host makes the shell a guest: it starts nothing and
      // supervises nothing. Everything else — the Cloud origin, the data
      // root, the port — is the *host's* business in that mode, so none of
      // it is resolved here.
      if (selection.kind === "remote") {
        remoteHostOrigin = selection.target.baseUrl;
        localHost = createRemoteHost(selection.target);
      } else {
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
      }
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
        secure: trustedOrigin.startsWith("https:"),
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
      if (selection.kind === "remote") watchRemoteHost(win, localHost);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A launch the environment pinned has nothing to choose between, so it
      // keeps the dialog; a chosen remote gets the lost-connection state.
      if (selection?.kind === "remote" && !connectionPinnedByEnv && localHost) {
        if (win && !win.isDestroyed()) win.hide();
        await offerAnotherConnection(localHost, reason);
        return;
      }
      dialog.showErrorBox(`${PRODUCT.name} could not start`, reason);
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
