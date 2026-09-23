/**
 * Fetch-through map asset cache: the portable layer between an application's
 * network calls and {@link BoundedAssetCache}.
 *
 * Ported from `feat/map-cache-rewrite` (`@simforge-oss/maps/asset-gateway`),
 * plus what the hosted viewer needs on top of it: a lazily resolved signed
 * delivery URL that is only asked for after a cache miss (so a warm load makes
 * no URL-issuing request at all), an `x-simforge-cache: hit` marker on
 * answers from the cache, and quiet handling of the aborts a streaming viewer
 * issues whenever its tile window moves.
 *
 * `asset-cache.ts` answers "what bytes are resident, and what has to go to
 * make room". That is a storage question and it has no opinion about HTTP.
 * Everything that turns it into a cache a *page* can use — hashing a response
 * before storing it, remembering which URL produced which digest, collapsing
 * concurrent requests for the same asset, serving a byte range out of a
 * resident full object, warming the full object behind a range request,
 * substituting a signed delivery URL for a canonical one, and intercepting
 * `fetch` so third-party loaders participate without knowing any of this —
 * lives here.
 *
 * It is a factory rather than a module singleton because two consumers with
 * different bucket names, budgets and origins have to coexist in one process
 * (a test suite is the common case, a host embedding two surfaces is the
 * other). Nothing here reads `window`, `document` or `localStorage` directly:
 * the origin, `CacheStorage`, `Storage` and the network `fetch` are all
 * supplied, which is what keeps it testable and what keeps a deployment's
 * specifics — signed CDN URLs, a different bucket name — out of the package.
 *
 * `navigator.storage.persist()` is never called from any of this. It raises a
 * permission prompt in several browsers, so it belongs to an explicit user
 * action: {@link MapAssetGateway.requestPersistentStorage}, wired to a button
 * the user pressed, and nothing else.
 */

import {
  BoundedAssetCache,
  availableStorageBytes,
  localStorageIndexStore,
  purgeLegacyAssetCaches,
  type AssetCacheUsage,
} from "./bounded-asset-cache";

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * URL aliases are bounded independently of the byte budget: a closure of
 * thousands of members, a few maps deep, must not turn the alias record into
 * the thing that runs out of room.
 */
const MAX_ALIASES = 8_192;

/** How long a signed delivery URL is assumed usable once registered. */
const DOWNLOAD_URL_TTL_MS = 50 * 60 * 1000;

/** Signed delivery URLs remembered at once; oldest registration drops first. */
const MAX_DOWNLOAD_URLS = 4_096;

/**
 * Default ceiling on cached map bytes: 32 GiB.
 *
 * High enough that a person can download every published map at the default
 * render profile (Low · no foliage is tens to hundreds of MB per map; the
 * whole dev catalog at Medium is well under this), while the quota clamp
 * below still keeps the cache to a share of what the browser actually grants
 * the origin. Chrome and Edge grant an origin up to ~60% of the disk; Firefox
 * grants ~10 GB best-effort, or 50% of the disk once persistent storage is
 * granted, which is why the download flow asks for persistence on the user's
 * explicit "Download" and re-reads the quota afterwards.
 */
export const MAP_ASSET_CACHE_DEFAULT_BUDGET_BYTES = 32 * 1024 ** 3;

/** Never take more than this share of the origin's quota, whatever the budget says. */
export const MAP_ASSET_CACHE_MAX_QUOTA_SHARE = 0.5;

/**
 * The ceiling that is actually enforced: the configured budget, clamped to
 * {@link MAP_ASSET_CACHE_MAX_QUOTA_SHARE} of the origin quota when the browser
 * reports one. Pure so the rule can be tested without a browser.
 */
export function effectiveMapCacheCeiling(configuredBytes: number, quotaBytes: number | null | undefined): number {
  const configured = Math.max(0, Math.floor(configuredBytes));
  if (!quotaBytes || !Number.isFinite(quotaBytes) || quotaBytes <= 0) return configured;
  return Math.min(configured, Math.floor(quotaBytes * MAP_ASSET_CACHE_MAX_QUOTA_SHARE));
}

/** The largest ceiling a person may choose: the quota share, or null when the quota is unknown. */
export function maxSelectableMapCacheCeiling(quotaBytes: number | null | undefined): number | null {
  if (!quotaBytes || !Number.isFinite(quotaBytes) || quotaBytes <= 0) return null;
  return Math.floor(quotaBytes * MAP_ASSET_CACHE_MAX_QUOTA_SHARE);
}

export type MapAssetCacheStatus = AssetCacheUsage & {
  /** Whether the origin already holds persistent storage. Never requested here. */
  persistent: boolean;
  /** `navigator.storage.estimate()`: the origin's whole quota and usage. */
  quotaBytes: number | null;
  originUsageBytes: number | null;
  /** The budget the person (or the default) asked for, before the quota clamp. */
  configuredBudgetBytes: number;
};

export type MapAssetEnsureOptions = {
  sha256?: string;
  /** Optional signed delivery URL carrying the same bytes as the canonical URL. */
  networkUrl?: string;
  sizeBytes?: number;
  signal?: AbortSignal;
};

export type MapAssetEnsureResult = {
  cacheHit: boolean;
  sizeBytes: number | null;
};

export type MapAssetFetchOptions = {
  /** Expected content digest. Supplying it makes any same-origin URL cacheable. */
  sha256?: string;
  /** Signed delivery URL carrying the same bytes; fetched with `credentials: "omit"`. */
  networkUrl?: string;
  /**
   * Resolves a signed delivery URL on a miss only. A cache hit never calls it,
   * which is what keeps a warm load free of URL-issuing requests.
   */
  resolveNetworkUrl?: () => Promise<string | undefined>;
  /**
   * Hand the caller the network response as soon as headers arrive, and verify
   * and store its clone in the background.
   *
   * A renderer streaming a large mesh must not wait for the whole body to be
   * buffered, hashed and written before it can start decoding. Only available
   * without `sha256`: a caller that asked for an integrity guarantee gets the
   * verified body, not a head start.
   */
  stream?: boolean;
};

export type MapCacheReceipt = {
  completedAt: number;
  assets: number;
  bytes: number;
};

export type MapAssetGatewayOptions = {
  /** Cache Storage bucket name; bump to invalidate an incompatible layout. */
  cacheName: string;
  /** `Storage` key holding the byte index (sizes and recency). */
  indexKey: string;
  /** `Storage` key holding URL aliases and closure receipts. */
  aliasKey: string;
  /** Buckets from a previous layout, deleted by {@link MapAssetGateway.purgeLegacyCaches}. */
  legacyCacheNames?: readonly string[];
  budgetBytes?: number;
  /** Same-origin path prefix the digest-keyed entries are stored under. */
  contentPrefix: string;
  origin: string;
  caches: CacheStorage;
  storage: Storage;
  /** The real network. Captured before any `fetch` interception is installed. */
  fetch: typeof fetch;
  /** Reports quota and persistence. Absent in a non-browser host. */
  storageManager?: StorageManager;
  now?: () => number;
  schedulePersist?: (persist: () => void) => void;
};

type AliasRecord = {
  urls: Record<string, string>;
  receipts: Record<string, MapCacheReceipt>;
};

/** Header set on every response answered from the cache (download progress reads it). */
export const MAP_ASSET_CACHE_HIT_HEADER = "x-simforge-cache";

/**
 * Batch resolver for signed delivery URLs, keyed by canonical absolute URL.
 * Returns the URLs it could issue; a missing entry falls back to the
 * canonical first-party route.
 */
export type MapAssetDownloadUrlResolver = (canonicalUrls: readonly string[]) => Promise<ReadonlyMap<string, string>>;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

/** A cached response marked as such; Cache API responses are not mutated in place. */
function markedHit(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(MAP_ASSET_CACHE_HIT_HEADER, "hit");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Rebuild a Response from bytes already read out of it. A Response body is
 * single-use, so anything that hashed or sliced the bytes has to hand the
 * caller a fresh one carrying the original status and headers.
 */
function responseFromBytes(body: ArrayBuffer, source: Response): Response {
  return new Response(body, { status: source.status, statusText: source.statusText, headers: source.headers });
}


function rangeResponse(bytes: ArrayBuffer, range: string, source: Response): Response | null {
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
export function isImmutableMapUrl(url: URL, origin: string): boolean {
  if (url.origin !== origin) return false;
  if (/^\/api\/simforge\/maps\/[^/]+\/browser-assets\//.test(url.pathname)
    || url.pathname.startsWith("/api/simforge/sumo-runtime/")) {
    return true;
  }
  return /^\/api\/map-assets\/[^/]+\/3d-asset\//.test(url.pathname) && url.searchParams.has("v");
}

export class MapAssetGateway {
  readonly #options: MapAssetGatewayOptions;
  readonly #networkFetch: typeof fetch;
  readonly #cache: BoundedAssetCache;
  readonly #inFlight = new Map<string, Promise<Response>>();
  readonly #backgroundWarmups = new Map<string, Promise<void>>();
  readonly #changeListeners = new Set<() => void>();
  /** Canonical URL → signed delivery URL, and the reverse for interception. */
  readonly #resolvedDownloads = new Map<string, { url: string; expiresAt: number }>();
  readonly #canonicalDownloads = new Map<string, string>();
  #aliases: AliasRecord | null = null;
  #aliasWriteScheduled = false;
  #configuredBudgetBytes: number;
  #quotaProbe: Promise<void> | null = null;
  #lastQuotaBytes: number | null = null;
  #lastWriteFailure: string | null = null;
  #installedOn: { fetch: typeof fetch } | null = null;
  #downloadUrlResolver: MapAssetDownloadUrlResolver | null = null;

  constructor(options: MapAssetGatewayOptions) {
    this.#options = options;
    this.#networkFetch = options.fetch;
    this.#configuredBudgetBytes = Math.max(0, options.budgetBytes ?? MAP_ASSET_CACHE_DEFAULT_BUDGET_BYTES);
    this.#cache = new BoundedAssetCache({
      cacheName: options.cacheName,
      budgetBytes: this.#configuredBudgetBytes,
      caches: options.caches,
      index: localStorageIndexStore(options.indexKey, options.storage),
      keyUrl: (digest) => `${options.origin}${options.contentPrefix}${digest}`,
      now: options.now,
      schedulePersist: options.schedulePersist,
    });
    void this.#probeQuota();
  }

  /** The bounded store itself, for callers that need usage or direct eviction. */
  get cache(): BoundedAssetCache {
    return this.#cache;
  }

  get budgetBytes(): number {
    return this.#cache.budgetBytes;
  }

  /** The budget asked for, before the quota clamp. */
  get configuredBudgetBytes(): number {
    return this.#configuredBudgetBytes;
  }

  /**
   * Override the ceiling. Used by the cache size control, and by tests that
   * need eviction to happen at a size they can write. The quota clamp still
   * applies: the enforced ceiling is {@link effectiveMapCacheCeiling}.
   */
  setBudgetBytes(budgetBytes: number): void {
    this.#configuredBudgetBytes = Math.max(0, budgetBytes);
    this.#cache.setBudgetBytes(effectiveMapCacheCeiling(this.#configuredBudgetBytes, this.#lastQuotaBytes));
    this.#notifyChanged();
  }

  /**
   * Re-read the origin quota and re-derive the ceiling from the configured
   * budget. Called after persistent storage is granted, which can raise the
   * quota (Firefox moves from its best-effort group limit to half the disk).
   */
  async refreshQuota(): Promise<void> {
    this.#quotaProbe = null;
    await this.#probeQuota();
    this.#notifyChanged();
  }

  /**
   * Forget specific content: a per-map delete. Digests shared with a map the
   * caller keeps must not be passed; the cache has no idea which map owns what.
   */
  async deleteDigests(digests: readonly string[]): Promise<number> {
    const freed = await this.#cache.delete(digests);
    this.#notifyChanged();
    return freed;
  }

  /**
   * Whether the byte index holds `digest` (no Cache Storage round trip). With
   * `url`, a held digest also teaches that path its identity, so a loader
   * asking for the same bytes under another map's path is answered from the
   * cache instead of transferring them again.
   */
  holdsDigest(digest: string, url?: string): boolean {
    const held = SHA256.test(digest) && this.#cache.entryBytes(digest) !== null;
    if (held && url) this.#rememberAlias(this.#absoluteUrl(url), digest);
    return held;
  }

  /** Subscribe to usage changes so a budget readout follows a download live. */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => void this.#changeListeners.delete(listener);
  }

  /**
   * Remember that a canonical asset URL is currently served by a signed
   * delivery URL.
   *
   * A deployment that hands out short-lived CDN links still wants one cache
   * entry per *content*, not one per signature. Registering the pair lets the
   * installed gateway intercept a loader's request for either form, transfer
   * from the signed URL, and key the result by digest — so the link expiring
   * costs nothing that is already resident.
   */
  registerDownloadUrls(urls: ReadonlyMap<string, string>): void {
    const expiresAt = (this.#options.now?.() ?? Date.now()) + DOWNLOAD_URL_TTL_MS;
    for (const [source, url] of urls) {
      const canonical = this.#absoluteUrl(source);
      const previous = this.#resolvedDownloads.get(canonical);
      if (previous) this.#canonicalDownloads.delete(previous.url);
      this.#resolvedDownloads.set(canonical, { url, expiresAt });
      this.#canonicalDownloads.set(url, canonical);
    }
    while (this.#resolvedDownloads.size > MAX_DOWNLOAD_URLS) {
      const oldest = this.#resolvedDownloads.keys().next().value!;
      this.#canonicalDownloads.delete(this.#resolvedDownloads.get(oldest)!.url);
      this.#resolvedDownloads.delete(oldest);
    }
  }

  /**
   * Resolve signed delivery URLs lazily: the installed gateway asks only after
   * a cache miss, so resident assets never cost a URL-issuing request.
   */
  setDownloadUrlResolver(resolver: MapAssetDownloadUrlResolver | null): void {
    this.#downloadUrlResolver = resolver;
  }

  /**
   * Synchronous best guess that `url` is resident: its digest is known and
   * the byte index holds it. Used to skip issuing delivery URLs for assets
   * the cache will answer; a wrong guess only costs a first-party redirect.
   */
  isLikelyCached(url: string): boolean {
    const digest = this.#knownDigest(this.#absoluteUrl(url));
    return digest !== null && this.#cache.entryBytes(digest) !== null;
  }

  /** Current signed delivery URL for a canonical asset URL, if one is registered and fresh. */
  registeredDownloadUrl(url: string): string | undefined {
    const resolved = this.#resolvedDownloads.get(this.#absoluteUrl(url));
    return resolved && resolved.expiresAt > (this.#options.now?.() ?? Date.now()) ? resolved.url : undefined;
  }

  async #resolveDownloadUrl(canonicalUrl: string): Promise<string | undefined> {
    const registered = this.registeredDownloadUrl(canonicalUrl);
    if (registered || !this.#downloadUrlResolver) return registered;
    const issued = await this.#downloadUrlResolver([canonicalUrl]);
    if (issued.size > 0) this.registerDownloadUrls(issued);
    return this.registeredDownloadUrl(canonicalUrl);
  }

  #forgetDownloadUrl(canonicalUrl: string): void {
    const previous = this.#resolvedDownloads.get(canonicalUrl);
    if (!previous) return;
    this.#canonicalDownloads.delete(previous.url);
    this.#resolvedDownloads.delete(canonicalUrl);
  }

  async hasAsset(url: string, expectedSha256?: string): Promise<boolean> {
    const canonicalUrl = this.#absoluteUrl(url);
    const digest = this.#knownDigest(canonicalUrl, expectedSha256);
    if (!digest) return false;
    if (!await this.#cache.has(digest)) return false;
    // A hit by content identity also teaches this path, so an alias of an
    // already-cached member answers by URL alone next time.
    this.#rememberAlias(canonicalUrl, digest);
    return true;
  }

  /**
   * Make an asset resident without handing its bytes to the caller. Used by
   * closure warm-up, where only the receipt matters.
   */
  async ensureAsset(url: string, options: MapAssetEnsureOptions = {}): Promise<MapAssetEnsureResult> {
    const canonicalUrl = this.#absoluteUrl(url);
    if (await this.hasAsset(canonicalUrl, options.sha256)) {
      const digest = this.#knownDigest(canonicalUrl, options.sha256);
      return { cacheHit: true, sizeBytes: digest ? this.#cache.entryBytes(digest) : null };
    }
    const response = await this.fetchAsset(
      canonicalUrl,
      { credentials: "same-origin", signal: options.signal },
      { sha256: options.sha256, networkUrl: options.networkUrl },
    );
    // The clone `fetchAsset` hands back is one branch of a tee; per the
    // Streams spec its cancel() settles only once the sibling branch is done,
    // so it is released without being awaited.
    response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error(`${response.status} ${canonicalUrl}`);
    const declared = Number(response.headers.get("content-length"));
    const sizeBytes = Number.isSafeInteger(declared) && declared > 0 ? declared : null;
    return { cacheHit: false, sizeBytes: sizeBytes ?? options.sizeBytes ?? null };
  }

  /** Fetch, verify and persist one immutable map asset under its content hash. */
  async fetchAsset(url: string, init: RequestInit = {}, options: MapAssetFetchOptions = {}): Promise<Response> {
    if (init.method && init.method !== "GET") return this.#networkFetch(url, init);
    const { sha256: expectedSha256 } = options;
    let networkUrl = options.networkUrl;
    const canonicalUrl = this.#absoluteUrl(url);
    const digest = this.#knownDigest(canonicalUrl, expectedSha256);
    if (digest) {
      const cached = await this.#cache.match(digest);
      if (cached) {
        // Content-addressed: the bytes were verified against this digest when
        // stored, so a warm hit streams without a second full read and rehash.
        this.#rememberAlias(canonicalUrl, digest);
        const range = new Headers(init.headers).get("range");
        if (!range) return markedHit(cached);
        const bytes = await cached.arrayBuffer();
        return markedHit(rangeResponse(bytes, range, cached) ?? responseFromBytes(bytes, cached));
      }
    }

    const inFlightKey = digest ?? canonicalUrl;
    const existing = this.#inFlight.get(inFlightKey);
    if (existing) {
      const response = (await existing).clone();
      if (response.ok && digest) this.#rememberAlias(canonicalUrl, digest);
      return response;
    }

    const persist = async (response: Response): Promise<Response> => {
      const bytes = await response.arrayBuffer();
      const actualSha = await sha256Hex(bytes);
      if (expectedSha256 && actualSha !== expectedSha256) {
        throw new Error(`Asset integrity check failed for ${canonicalUrl}`);
      }
      const stored = responseFromBytes(bytes, response);
      // The integrity check above is the contract; storage is an optimisation,
      // so a browser that refuses the write must not fail the asset whose
      // bytes are already here and verified.
      const outcome = await this.#cache.store(actualSha, bytes, {
        status: 200,
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/octet-stream",
          // The decoded length: a gzip-encoded transfer is stored inflated.
          "content-length": String(bytes.byteLength),
        },
      });
      if (outcome.stored) {
        this.#rememberAlias(canonicalUrl, actualSha);
        this.#lastWriteFailure = null;
      } else if (this.#lastWriteFailure !== outcome.reason) {
        this.#lastWriteFailure = outcome.reason;
        console.warn(`[map-asset-cache] not caching map bytes: ${outcome.reason}. Loads continue over the network.`);
      }
      this.#notifyChanged();
      return stored;
    };

    let publishResponse: ((response: Response) => void) | undefined;
    let rejectResponse: ((error: unknown) => void) | undefined;
    const responseReady = options.stream && !expectedSha256
      ? new Promise<Response>((resolve, reject) => { publishResponse = resolve; rejectResponse = reject; })
      : null;
    const pending = (async () => {
      if (!networkUrl && options.resolveNetworkUrl) {
        networkUrl = await options.resolveNetworkUrl().catch(() => undefined);
      }
      let transferUrl = networkUrl ?? url;
      let response = await this.#networkFetch(transferUrl, {
        ...init,
        credentials: networkUrl ? "omit" : "same-origin",
      });
      if (networkUrl && !response.ok && response.status !== 416) {
        // An expired or revoked signature is not the asset missing: forget the
        // delivery URL and let the first-party route authorize and redirect.
        void response.body?.cancel().catch(() => undefined);
        this.#forgetDownloadUrl(canonicalUrl);
        networkUrl = undefined;
        transferUrl = url;
        response = await this.#networkFetch(url, { ...init, credentials: "same-origin" });
      }
      publishResponse?.(response.clone());
      if (!response.ok) return response;
      if (response.status === 206) {
        this.#warmFullObject(inFlightKey, transferUrl, init, networkUrl, persist);
        return response;
      }
      // Persist only full 200 bodies — an `ok` 204 (for example an
      // `optional=1` existence probe against an absent object) must not become
      // a cached empty asset that keeps answering after the object appears.
      if (response.status !== 200) return response;
      return persist(response);
    })().catch((error: unknown) => {
      rejectResponse?.(error);
      throw error;
    }).finally(() => this.#inFlight.delete(inFlightKey));
    this.#inFlight.set(inFlightKey, pending);
    if (responseReady) {
      // The live renderer consumes network bytes while its clone is verified
      // and persisted. Checksum-bound callers still await persistence, and
      // this branch owns the rejection so the background copy of the promise
      // is never unhandled.
      void pending.catch((error: unknown) => {
        if (!isAbort(error)) console.warn("[map-asset-cache] background persistence failed", error);
      });
      return responseReady;
    }
    return (await pending).clone();
  }

  /**
   * Install once before a viewer mounts so third-party loaders share this
   * cache. Returns the uninstall function; calling it twice is harmless.
   */
  installFetchGateway(target: { fetch: typeof fetch }): () => void {
    if (this.#installedOn) return () => undefined;
    const native = this.#networkFetch;
    this.#installedOn = target;
    target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const raw = input instanceof Request ? input.url : String(input);
      const canonical = this.#canonicalDownloads.get(this.#absoluteUrl(raw));
      const intercept = method === "GET"
        && (canonical !== undefined || isImmutableMapUrl(new URL(raw, this.#options.origin), this.#options.origin));
      if (!intercept) return native(input, init);
      const url = canonical ?? raw;
      const absolute = this.#absoluteUrl(url);
      const networkUrl = this.registeredDownloadUrl(absolute);
      const requestInit = input instanceof Request
        ? { method: input.method, headers: input.headers, signal: input.signal, ...init }
        : init;
      return this.fetchAsset(url, requestInit, {
        networkUrl,
        resolveNetworkUrl: networkUrl ? undefined : () => this.#resolveDownloadUrl(absolute),
        stream: true,
      });
    }) as typeof fetch;
    return () => {
      if (this.#installedOn !== target) return;
      target.fetch = native;
      this.#installedOn = null;
    };
  }

  /**
   * Write the cache bookkeeping out now rather than on its own timer. Called
   * on page hide, and by tests that assert what survives a reload.
   */
  flushIndex(): void {
    this.#aliasWriteScheduled = false;
    this.#cache.flush();
    if (!this.#aliases) return;
    try {
      this.#options.storage.setItem(this.#options.aliasKey, JSON.stringify(this.#aliases));
    } catch {
      // Recency and alias hits are optimisations; losing them costs re-fetches.
    }
  }

  /**
   * Record that a named closure finished downloading. The key names whatever
   * the caller considers one unit of completeness — a release and profile, a
   * map version and its closure digest.
   */
  writeReceipt(key: string, assets: number, bytes: number): void {
    this.#readAliases().receipts[key] = {
      completedAt: this.#options.now?.() ?? Date.now(),
      assets,
      bytes,
    };
    this.flushIndex();
  }

  hasReceipt(key: string): boolean {
    return Boolean(this.#readAliases().receipts[key]);
  }

  /** Reclaim the quota still held by buckets from a previous cache layout. */
  async purgeLegacyCaches(): Promise<string[]> {
    return purgeLegacyAssetCaches(this.#options.caches, this.#options.legacyCacheNames ?? []);
  }

  /**
   * Ask the browser for eviction-resistant storage.
   *
   * Only ever call this from a control the user pressed: in Firefox and Safari
   * it raises a permission prompt, and an app that prompts on load teaches the
   * user to deny it. A `false` result is normal and changes nothing — the
   * cache never promised residency.
   */
  async requestPersistentStorage(): Promise<boolean> {
    const storage = this.#options.storageManager;
    if (!storage?.persist) return false;
    if (await storage.persisted?.().catch(() => false)) return true;
    const granted = await storage.persist().catch(() => false);
    // A grant can raise the quota; the ceiling follows it.
    if (granted) await this.refreshQuota();
    return granted;
  }

  /** Explicit user action: discard every cached map byte. */
  async clear(): Promise<void> {
    this.#aliases = { urls: {}, receipts: {} };
    this.#aliasWriteScheduled = false;
    this.#inFlight.clear();
    this.#backgroundWarmups.clear();
    this.#resolvedDownloads.clear();
    this.#canonicalDownloads.clear();
    this.#lastWriteFailure = null;
    try {
      this.#options.storage.removeItem(this.#options.aliasKey);
    } catch {
      // Nothing depends on the alias record surviving a clear.
    }
    await this.#cache.clear();
    this.#notifyChanged();
  }

  /** Budget, usage and the browser's own estimate, for the cache readouts. */
  async status(): Promise<MapAssetCacheStatus> {
    await this.#probeQuota();
    const storage = this.#options.storageManager;
    const estimate = await storage?.estimate?.().catch(() => undefined);
    return {
      ...this.#cache.usage(),
      // Reported, never requested: see `requestPersistentStorage`.
      persistent: await storage?.persisted?.().catch(() => false) ?? false,
      quotaBytes: estimate?.quota ?? null,
      originUsageBytes: estimate?.usage ?? null,
      configuredBudgetBytes: this.#configuredBudgetBytes,
    };
  }

  /** Free bytes of browser storage quota, for callers sizing their own writes. */
  async availableStorageBytes(): Promise<number | null> {
    return availableStorageBytes(this.#options.storageManager);
  }

  #warmFullObject(
    inFlightKey: string,
    transferUrl: string,
    init: RequestInit,
    networkUrl: string | undefined,
    persist: (response: Response) => Promise<Response>,
  ): void {
    if (this.#backgroundWarmups.has(inFlightKey)) return;
    const headers = new Headers(init.headers);
    headers.delete("range");
    const warmup = (async () => {
      const full = await this.#networkFetch(transferUrl, {
        ...init,
        headers,
        signal: undefined,
        credentials: networkUrl ? "omit" : "same-origin",
      });
      if (full.ok && full.status === 200) await persist(full);
    })()
      .catch(() => undefined)
      .finally(() => this.#backgroundWarmups.delete(inFlightKey));
    this.#backgroundWarmups.set(inFlightKey, warmup);
  }

  /**
   * Derive the enforced ceiling from the configured budget and the origin's
   * real quota share.
   *
   * `estimate()` is advisory and can change (other origins, disk pressure, a
   * persistence grant), so the ceiling is re-derived from the configured
   * budget each time rather than only ever tightened; the bounded cache's
   * `QuotaExceededError` path still shrinks it if the browser disagrees.
   */
  async #probeQuota(): Promise<void> {
    this.#quotaProbe ??= (async () => {
      const estimate = await this.#options.storageManager?.estimate?.().catch(() => undefined);
      const quota = estimate?.quota;
      if (!quota) return;
      this.#lastQuotaBytes = quota;
      this.#cache.setBudgetBytes(effectiveMapCacheCeiling(this.#configuredBudgetBytes, quota));
    })();
    return this.#quotaProbe;
  }

  #notifyChanged(): void {
    for (const listener of this.#changeListeners) listener();
  }

  #absoluteUrl(url: string): string {
    return new URL(url, this.#options.origin).href;
  }

  /** Digest already known for this URL, from the caller or a previous store. */
  #knownDigest(canonicalUrl: string, expectedSha256?: string): string | null {
    const digest = expectedSha256 ?? this.#readAliases().urls[canonicalUrl];
    return digest && SHA256.test(digest) ? digest : null;
  }

  #readAliases(): AliasRecord {
    if (this.#aliases) return this.#aliases;
    try {
      const parsed: unknown = JSON.parse(this.#options.storage.getItem(this.#options.aliasKey) ?? "null");
      const record = parsed as Partial<AliasRecord> | null;
      this.#aliases = {
        urls: record?.urls && typeof record.urls === "object" ? record.urls : {},
        receipts: record?.receipts && typeof record.receipts === "object" ? record.receipts : {},
      };
    } catch {
      this.#aliases = { urls: {}, receipts: {} };
    }
    return this.#aliases;
  }

  #rememberAlias(canonicalUrl: string, digest: string): void {
    const known = this.#readAliases();
    if (known.urls[canonicalUrl] === digest) return;
    if (Object.keys(known.urls).length >= MAX_ALIASES) {
      // Oldest-first is not knowable here and not worth a second recency
      // index: an alias only saves one digest lookup, and a dropped one costs
      // a conditional re-fetch that the content cache usually answers anyway.
      known.urls = { [canonicalUrl]: digest };
    } else {
      known.urls[canonicalUrl] = digest;
    }
    this.#scheduleAliasWrite();
  }

  #scheduleAliasWrite(): void {
    if (this.#aliasWriteScheduled) return;
    this.#aliasWriteScheduled = true;
    setTimeout(() => {
      if (!this.#aliasWriteScheduled) return;
      this.flushIndex();
    }, 250);
  }
}

export function createMapAssetGateway(options: MapAssetGatewayOptions): MapAssetGateway {
  return new MapAssetGateway(options);
}
