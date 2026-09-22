"use client";

import {
  desktopMapCacheBridge,
  type DesktopMapCacheBridge,
  type DesktopMapCacheStatus,
} from "@simforge-oss/studio-host";
import { randomUuid } from "@simforge-oss/engine/uuid";
import { availableStorageBytes as estimateAvailableStorageBytes } from "./bounded-asset-cache";
import {
  MAP_ASSET_CACHE_DEFAULT_BUDGET_BYTES,
  MapAssetGateway,
  type MapAssetDownloadUrlResolver,
} from "./map-asset-gateway";

/**
 * Persistent cache for immutable map bytes.
 *
 * Two backends, chosen once per page from the environment and never mixed:
 *
 * - `filesystem` — the installed desktop app. Explicit installs and cache
 *   management use the preload bridge to the host's verified store. Normal
 *   reads use the stable asset route, which serves that same store and allows
 *   the GUI's HTTP cache to revalidate without transferring the bytes again.
 * - `browser` — ordinary web mode, local or hosted. Bytes live in Cache
 *   Storage under their content hash, inside an explicit byte budget with
 *   least-recently-used eviction ({@link MapAssetGateway}). The installed fetch
 *   gateway answers every immutable map URL from the cache first and only then
 *   transfers it — from a signed delivery URL when one is issued, streamed to
 *   the caller while its copy is verified and stored behind it.
 */

const CACHE_NAME = "simforge-map-assets-v5";
const INDEX_KEY = "simforge-map-assets-index-v5";
const ALIAS_KEY = "simforge-map-asset-urls-v5";
const CONTENT_PREFIX = "/api/simforge/map-cache/sha256/";
/** The v4 layout kept one unbounded bucket and a combined index. */
const LEGACY_CACHE_NAMES = ["simforge-map-assets-v4"] as const;
const LEGACY_INDEX_KEYS = ["simforge-map-assets-index-v4"] as const;
/** An explicit library install may use this share of the origin's quota. */
const BULK_INSTALL_QUOTA_SHARE = 0.8;

export { MAP_ASSET_CACHE_DEFAULT_BUDGET_BYTES };

export type MapAssetCacheBackend = "browser" | "filesystem";

export type MapAssetCacheStatus =
  | {
      backend: "browser";
      /** Whether the browser granted persistent (eviction-safe) storage. */
      persistent: boolean;
      /** Browser storage used across all origin data; null when unknown. */
      usedBytes: number | null;
      /**
       * Room left for map bytes: the smaller of the budget headroom and the
       * origin's free quota. Null when the browser will not say.
       */
      availableBytes: number | null;
      /** Map bytes held in the cache right now. */
      mapBytes: number;
      /** Ceiling on map bytes; least recently used entries go past it. */
      budgetBytes: number;
      entryCount: number;
      /**
       * Why this browser cannot cache map bytes at all, or null when it can.
       * Cache Storage and the storage estimate exist only in a secure context
       * (HTTPS or localhost); a plain-HTTP LAN or tailnet address has neither.
       */
      unavailable: string | null;
    }
  | DesktopMapCacheStatus;

export type MapAssetEnsureOptions = {
  sha256?: string;
  /** Browser backend only: optional signed delivery URL carrying the same bytes as `url`. The desktop service resolves its own source. */
  networkUrl?: string;
  sizeBytes?: number;
  signal?: AbortSignal;
  /** Kept for callers; the browser backend always batches its index writes. */
  deferIndexWrite?: boolean;
};

export type MapAssetEnsureResult = {
  cacheHit: boolean;
  sizeBytes: number | null;
};

let gateway: MapAssetGateway | null = null;
let nativeFetch: typeof fetch | null = null;
let gatewayInstalled = false;
let downloadUrlResolver: MapAssetDownloadUrlResolver | null = null;
let requestSequence = 0;

/**
 * Why the browser backend cannot cache on this page, or null when it can.
 * Maps still load without it; every visit just transfers them again.
 */
export function browserMapCacheUnavailableReason(): string | null {
  if (typeof window === "undefined") return null;
  if (window.isSecureContext === false) {
    return "this page isn't served over HTTPS, so the browser turns off the storage map caching needs. "
      + "Open Studio from an https:// (or localhost) address to cache maps.";
  }
  if (!("caches" in window) || !window.caches) {
    return "this browser does not offer Cache Storage (a private window or a disabled setting).";
  }
  return null;
}

let unavailableLogged = false;

export function mapAssetCacheBackend(): MapAssetCacheBackend {
  return desktopMapCacheBridge() ? "filesystem" : "browser";
}

/** The network, captured before interception; resolved per call so tests can stub it. */
function networkFetch(input: RequestInfo | URL, init?: RequestInit) {
  return (nativeFetch ?? window.fetch)(input, init);
}

/**
 * Delegates to whatever `caches` is at call time rather than holding one
 * `CacheStorage` for the page's lifetime.
 */
const liveCacheStorage = {
  open: (name: string) => caches.open(name),
  delete: (name: string) => caches.delete(name),
  has: (name: string) => caches.has(name),
  keys: () => caches.keys(),
  match: (request: RequestInfo | URL, options?: MultiCacheQueryOptions) => caches.match(request, options),
} as CacheStorage;

function browserCache(): MapAssetGateway | null {
  if (typeof window === "undefined" || desktopMapCacheBridge() || browserMapCacheUnavailableReason() !== null) return null;
  if (!gateway) {
    gateway = new MapAssetGateway({
      cacheName: CACHE_NAME,
      indexKey: INDEX_KEY,
      aliasKey: ALIAS_KEY,
      legacyCacheNames: LEGACY_CACHE_NAMES,
      budgetBytes: MAP_ASSET_CACHE_DEFAULT_BUDGET_BYTES,
      contentPrefix: CONTENT_PREFIX,
      origin: window.location.origin,
      caches: liveCacheStorage,
      storage: window.localStorage,
      fetch: networkFetch as typeof fetch,
      storageManager: typeof navigator === "undefined" ? undefined : navigator.storage,
    });
    gateway.setDownloadUrlResolver(downloadUrlResolver);
  }
  return gateway;
}

/**
 * Where a cache miss transfers from. The hosted app issues signed object-store
 * URLs in batches; without a resolver a miss goes through the first-party
 * route, which authorizes and redirects.
 */
export function setMapAssetDownloadUrlResolver(resolver: MapAssetDownloadUrlResolver | null): void {
  downloadUrlResolver = resolver;
  gateway?.setDownloadUrlResolver(resolver);
}

/** Pre-register signed delivery URLs for canonical asset URLs about to be fetched. */
export function registerMapAssetDownloadUrls(urls: ReadonlyMap<string, string>): void {
  browserCache()?.registerDownloadUrls(urls);
}

/**
 * Synchronous best guess that `url` is resident in the browser cache. Always
 * false on the filesystem backend, whose host route serves the disk store.
 */
export function isMapAssetLikelyCached(url: string): boolean {
  return browserCache()?.isLikelyCached(url) ?? false;
}

function absoluteUrl(url: string) {
  return new URL(url, window.location.origin).href;
}

/**
 * Same-origin URLs whose bytes are immutable for the lifetime of the URL.
 * Mirrors the gateway's rule; anything else needs a content digest.
 */
function isCacheableMapUrl(url: URL, expectedSha256?: string) {
  if (url.origin !== window.location.origin) return false;
  if (expectedSha256) return /^[a-f0-9]{64}$/.test(expectedSha256);
  if (/^\/api\/simforge\/maps\/[^/]+\/browser-assets\//.test(url.pathname)
    || url.pathname.startsWith("/api/simforge/sumo-runtime/")) {
    return true;
  }
  return /^\/api\/map-assets\/[^/]+\/3d-asset\//.test(url.pathname) && url.searchParams.has("v");
}

function nextRequestId() {
  requestSequence += 1;
  return `${requestSequence}-${randomUuid()}`;
}

/** Ask the disk service for a verified asset; cancellation follows `signal`. */
async function desktopEnsure(
  bridge: DesktopMapCacheBridge,
  canonicalUrl: string,
  options: MapAssetEnsureOptions,
) {
  const { signal } = options;
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
  }
  const requestId = nextRequestId();
  const cancel = () => void bridge.cancel(requestId).catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await bridge.ensure({
      requestId,
      url: canonicalUrl,
      sha256: options.sha256,
      sizeBytes: options.sizeBytes,
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/** Kept for bulk callers; the browser backend already debounces its bookkeeping. */
export function beginMapAssetCacheIndexBatch() {}

/** Write the browser cache bookkeeping out now (page hide, end of a bulk plan, tests). */
export function flushMapAssetCacheIndex() {
  gateway?.flushIndex();
}

export async function hasCachedMapAsset(url: string, expectedSha256?: string) {
  const bridge = desktopMapCacheBridge();
  if (bridge) {
    return bridge.has({ url: absoluteUrl(url), sha256: expectedSha256 });
  }
  return await browserCache()?.hasAsset(url, expectedSha256) ?? false;
}

/**
 * Make an asset resident in the cache without handing its bytes to the caller.
 *
 * Bulk preparation runs this for tens of gigabytes; on the filesystem backend
 * the renderer only sees the ensure receipt, so a 30 GB library never passes
 * through JS heap or IPC. The browser backend must still read the body once
 * to hash and store it.
 */
export async function ensureMapAsset(
  url: string,
  options: MapAssetEnsureOptions = {},
): Promise<MapAssetEnsureResult> {
  const canonicalUrl = absoluteUrl(url);
  const bridge = desktopMapCacheBridge();
  if (bridge) {
    if (!isCacheableMapUrl(new URL(canonicalUrl), options.sha256)) {
      throw new Error(`Map asset URL cannot be cached without a content digest: ${canonicalUrl}`);
    }
    const ensured = await desktopEnsure(bridge, canonicalUrl, options);
    return { cacheHit: ensured.cacheHit, sizeBytes: ensured.sizeBytes };
  }
  const active = browserCache();
  if (active) return active.ensureAsset(canonicalUrl, options);
  const response = await fetchMapAsset(canonicalUrl, { credentials: "same-origin", signal: options.signal }, options.sha256, options.networkUrl);
  response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`${response.status} ${canonicalUrl}`);
  const declared = Number(response.headers.get("content-length"));
  return { cacheHit: false, sizeBytes: Number.isSafeInteger(declared) && declared > 0 ? declared : options.sizeBytes ?? null };
}

/** Fetch, verify and persist one immutable map asset under its content hash. */
export async function fetchMapAsset(
  url: string,
  init: RequestInit = {},
  expectedSha256?: string,
  networkUrl?: string,
  _deferIndexWrite = false,
): Promise<Response> {
  if (init.method && init.method !== "GET") return networkFetch(url, init);
  const active = browserCache();
  if (active) return active.fetchAsset(url, init, { sha256: expectedSha256, networkUrl });
  // The host route already authorizes, verifies and materializes each member
  // (desktop), or there is no Cache Storage (an insecure origin, private
  // mode). Without a cache, a hosted page still transfers straight from the
  // object store rather than paying one authorizing redirect per member.
  if (!desktopMapCacheBridge() && !expectedSha256 && downloadUrlResolver && isCacheableMapUrl(new URL(absoluteUrl(url)))) {
    const canonical = absoluteUrl(url);
    const signed = (await downloadUrlResolver([canonical]).catch(() => new Map<string, string>())).get(canonical);
    if (signed) {
      const direct = await networkFetch(signed, { ...init, credentials: "omit" }).catch(() => null);
      if (direct?.ok) return direct;
      void direct?.body?.cancel().catch(() => undefined);
    }
  }
  // The server's digest header is the one check available without buffering
  // the body.
  const response = await networkFetch(url, init);
  if (response.ok && expectedSha256 && response.headers.get("x-content-sha256") !== expectedSha256) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`Asset integrity check failed for ${url}`);
  }
  return response;
}

/** Install once before a viewer mounts so third-party loaders share this cache. */
export function installMapAssetFetchGateway() {
  if (gatewayInstalled || typeof window === "undefined") return;
  nativeFetch = window.fetch.bind(window);
  gatewayInstalled = true;
  const active = browserCache();
  const unavailable = desktopMapCacheBridge() ? null : browserMapCacheUnavailableReason();
  if (unavailable && !unavailableLogged) {
    unavailableLogged = true;
    console.warn(`[map-asset-cache] Browser caching unavailable: ${unavailable} Maps load from the network on every visit.`);
  }
  if (active) {
    active.installFetchGateway(window);
    window.addEventListener("pagehide", flushMapAssetCacheIndex);
    // Reclaim the unbounded v4 bucket and its index; nothing reads them now.
    void active.purgeLegacyCaches();
    try {
      for (const key of LEGACY_INDEX_KEYS) window.localStorage.removeItem(key);
    } catch {
      // Storage unavailable: nothing to reclaim.
    }
    return;
  }
  // Filesystem backend: the host route is the cache, so fetches pass through.
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const raw = input instanceof Request ? input.url : String(input);
    if (method !== "GET" || !isCacheableMapUrl(new URL(raw, window.location.origin))) return nativeFetch!(input, init);
    const requestInit = input instanceof Request
      ? { method: input.method, headers: input.headers, signal: input.signal, ...init }
      : init;
    return fetchMapAsset(raw, requestInit);
  }) as typeof fetch;
}

/**
 * Explicit bulk install (local library preparation): ask for eviction-safe
 * storage and let the budget grow to the room the origin actually has, so the
 * install does not evict its own earlier members. Browser backend only; disk
 * storage is durable by construction.
 */
export async function prepareMapAssetCache() {
  if (desktopMapCacheBridge()) return true;
  const active = browserCache();
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (active && estimate?.quota) {
    active.setBudgetBytes(Math.max(active.budgetBytes, Math.floor(estimate.quota * BULK_INSTALL_QUOTA_SHARE)));
  }
  if (navigator.storage?.persist) {
    const alreadyPersistent = await navigator.storage.persisted?.().catch(() => false) ?? false;
    return alreadyPersistent || await navigator.storage.persist().catch(() => false);
  }
  return false;
}

/** Explicit user action: discard every cached map asset of the active backend. */
export async function clearMapAssetCache() {
  const bridge = desktopMapCacheBridge();
  if (bridge) {
    await bridge.clear();
    return;
  }
  const active = browserCache();
  if (active) {
    await active.clear();
    await active.purgeLegacyCaches();
    return;
  }
  await caches.delete(CACHE_NAME).catch(() => false);
}

/** Location, usage and free space of whichever backend holds map bytes. */
export async function mapAssetCacheStatus(): Promise<MapAssetCacheStatus> {
  const bridge = desktopMapCacheBridge();
  if (bridge) return bridge.status();
  const active = browserCache();
  const unavailable = active ? null : browserMapCacheUnavailableReason() ?? "Cache Storage is unavailable in this browser.";
  const status = await active?.status();
  const originFree = status?.quotaBytes != null
    ? Math.max(0, status.quotaBytes - (status.originUsageBytes ?? 0))
    : null;
  const budgetBytes = status?.budgetBytes ?? MAP_ASSET_CACHE_DEFAULT_BUDGET_BYTES;
  const mapBytes = status?.usedBytes ?? 0;
  const headroom = Math.max(0, budgetBytes - mapBytes);
  return {
    backend: "browser",
    persistent: status?.persistent ?? false,
    usedBytes: status?.originUsageBytes ?? null,
    // No cache, no room to report: a budget figure here reads as usable space.
    availableBytes: unavailable ? null : originFree === null ? headroom : Math.min(originFree, headroom),
    mapBytes,
    budgetBytes,
    entryCount: status?.entryCount ?? 0,
    unavailable,
  };
}

/** Subscribe to browser cache usage changes; a no-op on the filesystem backend. */
export function onMapAssetCacheChange(listener: () => void): () => void {
  return browserCache()?.onChange(listener) ?? (() => undefined);
}

/**
 * Desktop only: native directory picker; resolves with the resulting status.
 * With `move`, the existing objects and receipts are carried into the chosen
 * folder so nothing is downloaded again.
 */
export async function chooseMapAssetCacheDirectory(
  options?: { move?: boolean },
): Promise<DesktopMapCacheStatus> {
  const bridge = desktopMapCacheBridge();
  if (!bridge) throw new Error("Choosing a cache location requires the SimForge desktop app.");
  return bridge.chooseDirectory(options);
}

/**
 * Free bytes of *browser* storage quota. This is what browser-resident caches
 * (scenario artifacts) consult; map bytes on the filesystem backend report
 * disk free space through `mapAssetCacheStatus` instead.
 */
export async function availableStorageBytes() {
  return estimateAvailableStorageBytes(typeof navigator === "undefined" ? undefined : navigator.storage);
}

export function cacheReceiptKey(releaseKey: string, profile: string) {
  return `${releaseKey}::${profile}`;
}

export function mapCacheReceiptKey(mapVersionId: string, closureSha256: string) {
  return `map::${mapVersionId}::${closureSha256}`;
}

export async function writeCacheReceipt(key: string, assets: number, bytes: number) {
  const bridge = desktopMapCacheBridge();
  if (bridge) {
    await bridge.writeReceipt(key, { completedAt: Date.now(), assets, bytes });
    return;
  }
  browserCache()?.writeReceipt(key, assets, bytes);
}

export async function hasCacheReceipt(key: string) {
  const bridge = desktopMapCacheBridge();
  if (bridge) return Boolean(await bridge.receipt(key));
  return browserCache()?.hasReceipt(key) ?? false;
}

/** Test seam: forget the page's gateway so the next call builds a fresh one. */
export function resetMapAssetCacheForTests() {
  gateway = null;
  nativeFetch = null;
  gatewayInstalled = false;
  downloadUrlResolver = null;
  unavailableLogged = false;
}
