/**
 * Renderer-facing contract of the installed desktop map cache.
 *
 * The Electron preload exposes `window.simforgeDesktop` through
 * `contextBridge`; every method is a narrow, promise-returning IPC call.
 * Control and metadata travel over IPC, asset payloads never do: `ensure`
 * returns an unguessable `simforge-cache://` capability URL whose `fetch`
 * streams the verified on-disk bytes (byte ranges included).
 */

export const DESKTOP_BRIDGE_VERSION = 1 as const;

/** `ipcMain.handle` channel prefix shared by preload and main process. */
export const DESKTOP_MAP_CACHE_IPC_PREFIX = "simforge:map-cache:" as const;

/** Custom scheme that streams verified cache content into the renderer. */
export const DESKTOP_MAP_CACHE_PROTOCOL = "simforge-cache" as const;

export type DesktopMapCacheStatus = {
  backend: "filesystem";
  /** Absolute cache root currently in use. */
  directory: string;
  usedBytes: number;
  /** Free bytes on the volume holding `directory`; null when unknown. */
  availableBytes: number | null;
  assetCount: number;
  activeDownloads: number;
};

export type DesktopMapCacheHasRequest = {
  url: string;
  sha256?: string;
};

export type DesktopMapCacheEnsureRequest = {
  /** Subscriber handle for `cancel`; deduplicated peers keep their transfer. */
  requestId: string;
  /** Canonical authenticated same-origin map URL. */
  url: string;
  /** Optional server-provided signed delivery URL for the same bytes. */
  downloadUrl?: string;
  /** Expected content digest; the service rejects mismatching bytes. */
  sha256?: string;
  /** Declared byte length; enforced when supplied. */
  sizeBytes?: number;
};

export type DesktopMapCacheEnsureResult = {
  /** Window-scoped `simforge-cache://` capability URL; never a file path. */
  url: string;
  sha256: string;
  sizeBytes: number;
  cacheHit: boolean;
};

export type DesktopMapCacheReceipt = {
  completedAt: number;
  assets: number;
  bytes: number;
};

export interface DesktopMapCacheBridge {
  status(): Promise<DesktopMapCacheStatus>;
  has(request: DesktopMapCacheHasRequest): Promise<boolean>;
  ensure(request: DesktopMapCacheEnsureRequest): Promise<DesktopMapCacheEnsureResult>;
  cancel(requestId: string): Promise<void>;
  receipt(key: string): Promise<DesktopMapCacheReceipt | null>;
  writeReceipt(key: string, receipt: DesktopMapCacheReceipt): Promise<void>;
  /** Explicit user-requested clearing only. */
  clear(): Promise<void>;
  /** Native directory picker; resolves with the (possibly unchanged) status. */
  chooseDirectory(): Promise<DesktopMapCacheStatus>;
}

export type SimforgeDesktopBridge = {
  version: typeof DESKTOP_BRIDGE_VERSION;
  mapCache: DesktopMapCacheBridge;
};

declare global {
  interface Window {
    simforgeDesktop?: SimforgeDesktopBridge;
  }
}

/**
 * The installed desktop bridge, or null in an ordinary browser.
 *
 * A bridge with an unexpected version is an installation fault, not a browser:
 * throwing here is what keeps the desktop app from silently degrading to
 * browser storage for its map bytes.
 */
export function desktopMapCacheBridge(): DesktopMapCacheBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.simforgeDesktop;
  if (!bridge) return null;
  if (bridge.version !== DESKTOP_BRIDGE_VERSION || typeof bridge.mapCache?.ensure !== "function") {
    throw new Error(
      `SimForge desktop bridge version ${String(bridge.version)} is not supported by this application build; reinstall the desktop app.`,
    );
  }
  return bridge.mapCache;
}
