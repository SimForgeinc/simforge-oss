"use client";

import {
  desktopMapCacheBridge,
  type DesktopMapCacheBridge,
  type DesktopMapCacheStatus,
} from "@simforge-oss/studio-host";

/**
 * Persistent cache for immutable map bytes.
 *
 * Two backends, chosen once per page from the environment and never mixed:
 *
 * - `filesystem` — the installed desktop app. Bytes live on disk in the local
 *   service's store behind the preload bridge; the renderer only ever sees
 *   metadata over IPC and streams verified content through same-origin
 *   `/api/simforge/map-cache/stream/...` capability URLs. A bridge failure is
 *   surfaced, never papered over with browser storage.
 * - `browser` — ordinary web mode. Bytes live in Cache Storage under their
 *   content hash with a small localStorage index for URL aliases and receipts.
 */

const CACHE_NAME = "simforge-map-assets-v4";
const INDEX_KEY = "simforge-map-assets-index-v4";
const CONTENT_PREFIX = "/api/simforge/map-cache/sha256/";
const SHA256 = /^[a-f0-9]{64}$/;

export type MapAssetCacheBackend = "browser" | "filesystem";

export type MapAssetCacheStatus =
  | {
      backend: "browser";
      /** Whether the browser granted persistent (eviction-safe) storage. */
      persistent: boolean;
      /** Browser storage used across all origin data; null when unknown. */
      usedBytes: number | null;
      availableBytes: number | null;
    }
  | DesktopMapCacheStatus;

export type MapAssetEnsureOptions = {
  sha256?: string;
  /** Browser backend only: optional signed delivery URL carrying the same bytes as `url`. The desktop service resolves its own source. */
  networkUrl?: string;
  sizeBytes?: number;
  signal?: AbortSignal;
  /** Browser backend: batch index writes until `flushMapAssetCacheIndex`. */
  deferIndexWrite?: boolean;
};

export type MapAssetEnsureResult = {
  cacheHit: boolean;
  sizeBytes: number | null;
};

type CacheIndex = {
  urls: Record<string, string>;
  content: Record<string, { bytes: number }>;
  receipts: Record<string, { completedAt: number; assets: number; bytes: number }>;
};

const EMPTY_INDEX: CacheIndex = { urls: {}, content: {}, receipts: {} };
const inFlight = new Map<string, Promise<Response>>();
const backgroundWarmups = new Map<string, Promise<void>>();
let pendingBulkIndex: CacheIndex | null = null;
let nativeFetch: typeof fetch | null = null;
let gatewayInstalled = false;
let requestSequence = 0;

export function mapAssetCacheBackend(): MapAssetCacheBackend {
  return desktopMapCacheBridge() ? "filesystem" : "browser";
}

function readIndex(): CacheIndex {
  if (pendingBulkIndex) return pendingBulkIndex;
  try {
    const parsed = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "null") as Partial<CacheIndex> | null;
    return {
      urls: parsed?.urls && typeof parsed.urls === "object" ? parsed.urls : {},
      content: parsed?.content && typeof parsed.content === "object" ? parsed.content : {},
      receipts: parsed?.receipts && typeof parsed.receipts === "object" ? parsed.receipts : {},
    };
  } catch {
    return structuredClone(EMPTY_INDEX);
  }
}

function persistIndex(index: CacheIndex) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

function writeIndex(index: CacheIndex, defer = false) {
  if (defer) {
    pendingBulkIndex = index;
    return;
  }
  persistIndex(index);
}

/**
 * Browser backend only: hold the index in memory across a burst of lookups
 * and stores so a plan over thousands of members does not parse and rewrite
 * the whole localStorage record per member. `flushMapAssetCacheIndex` ends
 * the batch; the filesystem backend persists every write itself.
 */
export function beginMapAssetCacheIndexBatch() {
  if (pendingBulkIndex || desktopMapCacheBridge()) return;
  pendingBulkIndex = readIndex();
}

export function flushMapAssetCacheIndex() {
  if (!pendingBulkIndex) return;
  persistIndex(pendingBulkIndex);
  pendingBulkIndex = null;
}

/** Record a URL → content binding; writes only when the index actually changes. */
function remember(
  index: CacheIndex,
  canonicalUrl: string,
  sha256: string,
  bytes: number | null,
  defer: boolean,
) {
  const known = index.content[sha256];
  if (index.urls[canonicalUrl] === sha256 && known) return;
  index.urls[canonicalUrl] = sha256;
  // The storing fetch records the true length first; later hits never
  // overwrite it with a header-derived guess.
  if (!known) index.content[sha256] = { bytes: bytes ?? 0 };
  writeIndex(index, defer);
}

function declaredLength(response: Response) {
  const size = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

function absoluteUrl(url: string) {
  return new URL(url, window.location.origin).href;
}

function contentRequest(sha256: string) {
  return new Request(`${window.location.origin}${CONTENT_PREFIX}${sha256}`);
}

async function digest(bytes: ArrayBuffer) {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  try {
    return await digest(bytes);
  } catch {
    return null;
  }
}

function networkFetch(input: RequestInfo | URL, init?: RequestInit) {
  return (nativeFetch ?? window.fetch)(input, init);
}

function responseFromBytes(body: ArrayBuffer, source: Response) {
  return new Response(body, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });
}

function requestedRange(init: RequestInit) {
  return new Headers(init.headers).get("range");
}

function withoutRange(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.delete("range");
  return { ...init, headers, signal: undefined, credentials: "same-origin" };
}

function rangeResponse(bytes: ArrayBuffer, range: string, source: Response) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : bytes.byteLength - 1;
  const end = Math.min(bytes.byteLength - 1, requestedEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
  const body = bytes.slice(start, end + 1);
  const headers = new Headers(source.headers);
  headers.set("content-length", String(body.byteLength));
  headers.set("content-range", `bytes ${start}-${end}/${bytes.byteLength}`);
  headers.set("accept-ranges", "bytes");
  return new Response(body, { status: 206, headers });
}

/**
 * Same-origin URLs whose bytes are immutable for the lifetime of the URL, and
 * therefore safe to cache by URL alone. Anything else is only cacheable when
 * the caller supplies the expected content digest.
 *
 * Scenario browser-assets and the SUMO runtime are content-versioned paths.
 * Digital-twin `3d-asset` paths are rebuilt in place, so only fetches carrying
 * the explicit `?v=<manifest-hash>` token (appended by the city-viewer, see
 * `CityViewerCore.start`) qualify: rebuild → new manifest bytes → new token →
 * every asset URL misses and refetches. Token-less 3d-asset fetches (the
 * manifest itself, `optional=1` probes, mutable twin-eval artifacts) always
 * pass through to the network.
 */
function isImmutableMapUrl(url: URL) {
  if (url.origin !== window.location.origin) return false;
  if (/^\/api\/simforge\/maps\/[^/]+\/browser-assets\//.test(url.pathname)
    || url.pathname.startsWith("/api/simforge/sumo-runtime/")) {
    return true;
  }
  return /^\/api\/map-assets\/[^/]+\/3d-asset\//.test(url.pathname)
    && url.searchParams.has("v");
}

function isCacheableMapUrl(url: URL, expectedSha256?: string) {
  if (expectedSha256) return url.origin === window.location.origin && SHA256.test(expectedSha256);
  return isImmutableMapUrl(url);
}

function nextRequestId() {
  requestSequence += 1;
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${requestSequence}-${random}`;
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

async function desktopFetch(
  bridge: DesktopMapCacheBridge,
  canonicalUrl: string,
  init: RequestInit,
  options: MapAssetEnsureOptions,
): Promise<Response> {
  const ensured = await desktopEnsure(bridge, canonicalUrl, { ...options, signal: init.signal ?? undefined });
  const headers = new Headers();
  const range = requestedRange(init);
  if (range) headers.set("range", range);
  // The capability URL is same-origin on the local host: the local session
  // cookie authorizes it and the service re-checks map access on every read.
  // The file IS the cache, so Chromium's HTTP cache must not copy it.
  return networkFetch(ensured.url, {
    method: "GET",
    headers,
    signal: init.signal,
    credentials: "same-origin",
    cache: "no-store",
  });
}

/**
 * The URL a context without this module's fetch gateway (a worker) should
 * fetch for a map asset. On the filesystem backend a cacheable asset is made
 * resident first and its same-origin capability URL is returned, so worker
 * loads stream from disk like main-thread ones; anything else, and the browser
 * backend, keeps the canonical URL.
 */
export async function resolveMapAssetUrl(
  url: string,
  options: Pick<MapAssetEnsureOptions, "sha256" | "signal"> = {},
): Promise<string> {
  const canonicalUrl = absoluteUrl(url);
  const bridge = desktopMapCacheBridge();
  if (!bridge || !isCacheableMapUrl(new URL(canonicalUrl), options.sha256)) return canonicalUrl;
  return (await desktopEnsure(bridge, canonicalUrl, options)).url;
}

export async function hasCachedMapAsset(url: string, expectedSha256?: string) {
  const bridge = desktopMapCacheBridge();
  if (bridge) {
    return bridge.has({ url: absoluteUrl(url), sha256: expectedSha256 });
  }
  if (!("caches" in window)) return false;
  const index = readIndex();
  const canonicalUrl = absoluteUrl(url);
  const sha256 = expectedSha256 ?? index.urls[canonicalUrl];
  if (!sha256 || !SHA256.test(sha256)) return false;
  const cached = await (await caches.open(CACHE_NAME)).match(contentRequest(sha256));
  if (!cached) return false;
  // A hit by content identity also teaches the index this path, so an alias of
  // an already-cached member answers by URL alone later (offline runtime).
  remember(index, canonicalUrl, sha256, declaredLength(cached), Boolean(pendingBulkIndex));
  return true;
}

/**
 * Make an asset resident in the cache without handing its bytes to the caller.
 *
 * Bulk preparation runs this for tens of gigabytes; on the filesystem backend
 * the renderer only sees the ensure receipt, so a 30 GB library never passes
 * through JS heap or IPC. The browser backend must still stream the body once
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
  if (await hasCachedMapAsset(canonicalUrl, options.sha256)) {
    const index = readIndex();
    const sha256 = options.sha256 ?? index.urls[canonicalUrl];
    return { cacheHit: true, sizeBytes: sha256 ? index.content[sha256]?.bytes ?? null : null };
  }
  const response = await fetchMapAsset(
    canonicalUrl,
    { credentials: "same-origin", signal: options.signal },
    options.sha256,
    options.networkUrl,
    options.deferIndexWrite,
  );
  // The clone `fetchMapAsset` hands back is one branch of a tee; per the
  // Streams spec its cancel() settles only once the sibling branch is done,
  // so it is released without being awaited.
  response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`${response.status} ${canonicalUrl}`);
  return { cacheHit: false, sizeBytes: declaredLength(response) ?? options.sizeBytes ?? null };
}

/** Fetch, verify and persist one immutable map asset under its content hash. */
export async function fetchMapAsset(
  url: string,
  init: RequestInit = {},
  expectedSha256?: string,
  networkUrl?: string,
  deferIndexWrite = false,
): Promise<Response> {
  if (init.method && init.method !== "GET") return networkFetch(url, init);
  const bridge = desktopMapCacheBridge();
  if (bridge) {
    const canonicalUrl = absoluteUrl(url);
    if (!isCacheableMapUrl(new URL(canonicalUrl), expectedSha256)) return networkFetch(url, init);
    return desktopFetch(bridge, canonicalUrl, init, { sha256: expectedSha256, networkUrl });
  }
  if (!("caches" in window)) return networkFetch(url, init);
  const canonicalUrl = absoluteUrl(url);
  const index = readIndex();
  const knownSha = expectedSha256 ?? index.urls[canonicalUrl];
  const cache = await caches.open(CACHE_NAME);
  if (knownSha && SHA256.test(knownSha)) {
    const cached = await cache.match(contentRequest(knownSha));
    if (cached) {
      // Content-addressed: the bytes were verified against this digest when
      // stored, so a warm hit streams without a second full read and rehash.
      remember(index, canonicalUrl, knownSha, declaredLength(cached), deferIndexWrite);
      const range = requestedRange(init);
      if (!range) return cached;
      const bytes = await cached.arrayBuffer();
      return rangeResponse(bytes, range, cached) ?? responseFromBytes(bytes, cached);
    }
  }

  const inFlightKey = knownSha && SHA256.test(knownSha) ? knownSha : canonicalUrl;
  const existing = inFlight.get(inFlightKey);
  if (existing) {
    const response = (await existing).clone();
    if (response.ok && knownSha && SHA256.test(knownSha)) {
      remember(readIndex(), canonicalUrl, knownSha, declaredLength(response), deferIndexWrite);
    }
    return response;
  }
  const persist = async (response: Response) => {
    const bytes = await response.arrayBuffer();
    const actualSha = await digest(bytes);
    if (expectedSha256 && actualSha !== expectedSha256) {
      throw new Error(`Asset integrity check failed for ${canonicalUrl}`);
    }
    // One Response is built from the bytes; its clone shares the body for the
    // cache write instead of copying the buffer a second time.
    const stored = responseFromBytes(bytes, response);
    await cache.put(contentRequest(actualSha), stored.clone());
    remember(readIndex(), canonicalUrl, actualSha, bytes.byteLength, deferIndexWrite);
    return stored;
  };
  const pending = (async () => {
    const transferUrl = networkUrl ?? url;
    const response = await networkFetch(transferUrl, {
      ...init,
      credentials: networkUrl ? "omit" : "same-origin",
    });
    if (!response.ok) return response;
    if (response.status === 206) {
      if (!backgroundWarmups.has(inFlightKey)) {
        const warmup = (async () => {
          const full = await networkFetch(transferUrl, {
            ...withoutRange(init),
            credentials: networkUrl ? "omit" : "same-origin",
          });
          if (full.ok && full.status === 200) await persist(full);
        })()
          .catch(() => undefined)
          .finally(() => backgroundWarmups.delete(inFlightKey));
        backgroundWarmups.set(inFlightKey, warmup);
      }
      return response;
    }
    // Persist only full 200 bodies — an `ok` 204 (e.g. an `optional=1`
    // existence probe against an absent object) must not become a cached
    // empty asset that keeps answering after the object appears.
    if (response.status !== 200) return response;
    return persist(response);
  })().finally(() => inFlight.delete(inFlightKey));
  inFlight.set(inFlightKey, pending);
  return (await pending).clone();
}

function isMapAssetRequest(input: RequestInfo | URL, init?: RequestInit) {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method !== "GET") return false;
  const raw = input instanceof Request ? input.url : String(input);
  return isImmutableMapUrl(new URL(raw, window.location.origin));
}

/** Install once before a viewer mounts so third-party loaders share this cache. */
export function installMapAssetFetchGateway() {
  if (gatewayInstalled || typeof window === "undefined") return;
  nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!isMapAssetRequest(input, init)) return nativeFetch!(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const requestInit = input instanceof Request
      ? { method: input.method, headers: input.headers, signal: input.signal, ...init }
      : init;
    return fetchMapAsset(url, requestInit);
  }) as typeof fetch;
  gatewayInstalled = true;
}

/**
 * Request eviction-safe storage before a bulk download. Browser backend only;
 * disk storage is durable by construction.
 */
export async function prepareMapAssetCache() {
  if (desktopMapCacheBridge()) return true;
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
  pendingBulkIndex = null;
  await caches.delete(CACHE_NAME).catch(() => false);
  localStorage.removeItem(INDEX_KEY);
}

/** Location, usage and free space of whichever backend holds map bytes. */
export async function mapAssetCacheStatus(): Promise<MapAssetCacheStatus> {
  const bridge = desktopMapCacheBridge();
  if (bridge) return bridge.status();
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  const persistent = await navigator.storage?.persisted?.().catch(() => false) ?? false;
  return {
    backend: "browser",
    persistent,
    usedBytes: estimate?.usage ?? null,
    availableBytes: estimate?.quota ? Math.max(0, estimate.quota - (estimate.usage ?? 0)) : null,
  };
}

/** Desktop only: native directory picker; resolves with the resulting status. */
export async function chooseMapAssetCacheDirectory(): Promise<DesktopMapCacheStatus> {
  const bridge = desktopMapCacheBridge();
  if (!bridge) throw new Error("Choosing a cache location requires the SimForge desktop app.");
  return bridge.chooseDirectory();
}

/**
 * Free bytes of *browser* storage quota. This is what browser-resident caches
 * (scenario artifacts) consult; map bytes on the filesystem backend report
 * disk free space through `mapAssetCacheStatus` instead.
 */
export async function availableStorageBytes() {
  const estimate = await navigator.storage?.estimate?.();
  if (!estimate?.quota) return null;
  return Math.max(0, estimate.quota - (estimate.usage ?? 0));
}

export function cacheReceiptKey(releaseKey: string, profile: string) {
  return `${releaseKey}::${profile}`;
}

export function mapCacheReceiptKey(mapVersionId: string, closureSha256: string) {
  return `map::${mapVersionId}::${closureSha256}`;
}

export async function writeCacheReceipt(key: string, assets: number, bytes: number) {
  const receipt = { completedAt: Date.now(), assets, bytes };
  const bridge = desktopMapCacheBridge();
  if (bridge) {
    await bridge.writeReceipt(key, receipt);
    return;
  }
  const index = readIndex();
  index.receipts[key] = receipt;
  writeIndex(index, Boolean(pendingBulkIndex));
}

export async function hasCacheReceipt(key: string) {
  const bridge = desktopMapCacheBridge();
  if (bridge) return Boolean(await bridge.receipt(key));
  return Boolean(readIndex().receipts[key]);
}
