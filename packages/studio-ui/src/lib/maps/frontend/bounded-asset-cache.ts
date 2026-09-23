/**
 * A bounded, content-addressed cache over the Cache API.
 *
 * Ported from `feat/map-cache-rewrite` (`@simforge-oss/maps/asset-cache`). It
 * lives in studio-ui until the maps package can publish a new export.
 *
 * Map closures are far larger than any browser will store: the registry's ten
 * latest releases total ~46 GiB and the largest single map is ~10.6 GiB, while
 * the visible closure of one map at one quality level is a few hundred
 * megabytes. A browser therefore caches the working set of the map that is
 * open, not a library — and it has to give bytes back before the browser
 * starts taking them.
 *
 * The rules that follow from that:
 *
 * - **Explicit budget.** Nothing is stored past `budgetBytes`; the cache makes
 *   room *before* it writes rather than discovering quota at `cache.put`.
 * - **Digest keys.** Entries are keyed by the SHA-256 of their bytes, so
 *   evicting one is always safe: whatever referenced it can re-fetch it and
 *   get byte-identical content back.
 * - **LRU.** The least recently *read* entry is the first to go; reads touch.
 * - **No offline promise.** The browser may still evict the whole cache. Every
 *   miss is a transparent re-fetch, so an evicted cache is slow, never broken.
 *
 * This module is deliberately free of app, DOM-document and framework
 * dependencies: `CacheStorage` and the index store are injected, which is also
 * what makes eviction and quota behaviour testable without a browser.
 */

/** One stored blob: its size, and when it was last read or written. */
export type AssetCacheEntry = {
  bytes: number;
  lastUsedAt: number;
};

export type AssetCacheIndex = {
  entries: Record<string, AssetCacheEntry>;
};

/**
 * Where the index survives a reload. The bytes live in Cache Storage; this is
 * only the bookkeeping (size and recency) that Cache Storage cannot answer
 * without reading every entry back.
 */
export interface AssetCacheIndexStore {
  read(): AssetCacheIndex | null;
  write(index: AssetCacheIndex): void;
  clear(): void;
}

export type AssetCacheUsage = {
  usedBytes: number;
  budgetBytes: number;
  entryCount: number;
  /** Fraction of the budget in use, 0-1; 1 once the budget is full. */
  fill: number;
};

export type AssetCacheStoreOutcome =
  | { stored: true; evictedDigests: string[] }
  /**
   * The bytes are good and were handed to the caller; only the *copy* was
   * refused. `reason` explains it, `evictedDigests` says what was given back
   * trying to make room.
   */
  | { stored: false; reason: string; evictedDigests: string[] };

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * After a `QuotaExceededError` the budget is provably wrong — the browser's
 * real limit for this origin is below it. Retrying at the same fill level
 * would just fail again, so the retry first drops to this fraction of the
 * budget and the budget itself is lowered to what actually fit.
 */
const QUOTA_RETRY_FILL = 0.5;

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
    : error instanceof Error && error.name === "QuotaExceededError";
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export type BoundedAssetCacheOptions = {
  /** Cache Storage bucket name; bump to invalidate an incompatible layout. */
  cacheName: string;
  budgetBytes: number;
  caches: CacheStorage;
  index: AssetCacheIndexStore;
  /**
   * Digest → the Request URL its bytes are stored under. Must be same-origin
   * and stable: it is the only way back to an entry across reloads.
   */
  keyUrl: (digest: string) => string;
  now?: () => number;
  /**
   * Defers the index write that follows a burst of reads and stores. Without
   * it a closure of thousands of members rewrites the whole index thousands
   * of times; `flush()` forces it out (page hide, tests).
   */
  schedulePersist?: (persist: () => void) => void;
};

export class BoundedAssetCache {
  readonly #cacheName: string;
  readonly #caches: CacheStorage;
  readonly #store: AssetCacheIndexStore;
  readonly #keyUrl: (digest: string) => string;
  readonly #now: () => number;
  readonly #schedulePersist: (persist: () => void) => void;
  #budgetBytes: number;
  #entries: Map<string, AssetCacheEntry> | null = null;
  #usedBytes = 0;
  /**
   * Logical clock. `Date.now()` has millisecond resolution, and a closure
   * warm-up stores dozens of members inside one millisecond — raw timestamps
   * tie and LRU order becomes whatever the sort happened to do. Monotonic
   * ticks keep "least recently used" meaningful at burst speed while staying
   * a wall-clock value across sessions.
   */
  #clock = 0;
  #persistScheduled = false;

  constructor(options: BoundedAssetCacheOptions) {
    this.#cacheName = options.cacheName;
    this.#caches = options.caches;
    this.#store = options.index;
    this.#keyUrl = options.keyUrl;
    this.#budgetBytes = Math.max(0, options.budgetBytes);
    this.#now = options.now ?? (() => Date.now());
    this.#schedulePersist = options.schedulePersist ?? ((persist) => { setTimeout(persist, 250); });
  }

  get budgetBytes(): number {
    return this.#budgetBytes;
  }

  /**
   * Lower or raise the ceiling. Lowering evicts on the next store rather than
   * immediately: bytes already here cost nothing until something new needs
   * the room, and an entry the open map is using should outlive a slider.
   */
  setBudgetBytes(budgetBytes: number): void {
    this.#budgetBytes = Math.max(0, budgetBytes);
  }

  usage(): AssetCacheUsage {
    const entries = this.#load();
    return {
      usedBytes: this.#usedBytes,
      budgetBytes: this.#budgetBytes,
      entryCount: entries.size,
      fill: this.#budgetBytes > 0 ? Math.min(1, this.#usedBytes / this.#budgetBytes) : 1,
    };
  }

  /** Digests held right now, least recently used first. */
  digests(): string[] {
    return [...this.#load().entries()]
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
      .map(([digest]) => digest);
  }

  /** Size of a held entry, or null when it is not cached. */
  entryBytes(digest: string): number | null {
    return this.#load().get(digest)?.bytes ?? null;
  }

  async match(digest: string): Promise<Response | undefined> {
    if (!SHA256.test(digest)) return undefined;
    const cache = await this.#open();
    if (!cache) return undefined;
    const hit = await cache.match(new Request(this.#keyUrl(digest)));
    const entries = this.#load();
    if (!hit) {
      // The browser evicted the bytes under us (or a previous session died
      // before its index write). Forget the entry so the usage number stays
      // honest and the caller re-fetches.
      if (entries.delete(digest)) {
        this.#recount();
        this.#persistSoon();
      }
      return undefined;
    }
    const entry = entries.get(digest);
    if (entry) {
      entry.lastUsedAt = this.#tick();
    } else {
      // Present in Cache Storage but unknown to the index: adopt it so it is
      // accounted for and evictable instead of being invisible overhead.
      entries.set(digest, { bytes: await responseBytes(hit), lastUsedAt: this.#tick() });
      this.#recount();
    }
    this.#persistSoon();
    return hit;
  }

  async has(digest: string): Promise<boolean> {
    return Boolean(await this.match(digest));
  }

  /**
   * Store verified bytes under their digest, making room first.
   *
   * The caller already holds the bytes, so a refused write is never fatal: the
   * outcome says what happened and the caller carries on with its response.
   */
  async store(digest: string, body: ArrayBuffer, init?: ResponseInit): Promise<AssetCacheStoreOutcome> {
    if (!SHA256.test(digest)) {
      return { stored: false, reason: `not a sha-256 digest: ${digest}`, evictedDigests: [] };
    }
    const cache = await this.#open();
    if (!cache) return { stored: false, reason: "Cache Storage is unavailable", evictedDigests: [] };
    const size = body.byteLength;
    const entries = this.#load();
    if (entries.has(digest)) {
      entries.get(digest)!.lastUsedAt = this.#tick();
      this.#persistSoon();
      return { stored: true, evictedDigests: [] };
    }
    if (size > this.#budgetBytes) {
      return {
        stored: false,
        reason: `asset is ${size} bytes, larger than the ${this.#budgetBytes} byte map cache budget`,
        evictedDigests: [],
      };
    }
    const evicted = await this.#evictTo(this.#budgetBytes - size);
    const key = new Request(this.#keyUrl(digest));
    try {
      await cache.put(key, new Response(body, init));
    } catch (error) {
      if (!isQuotaExceeded(error)) {
        return { stored: false, reason: describe(error), evictedDigests: evicted };
      }
      // The budget was above what this origin actually gets. Halve the working
      // set, believe the browser over the configured number, and try once more.
      this.#budgetBytes = Math.max(size, Math.floor(this.#usedBytes * QUOTA_RETRY_FILL));
      evicted.push(...await this.#evictTo(Math.floor(this.#budgetBytes * QUOTA_RETRY_FILL) - size));
      try {
        await cache.put(key, new Response(body, init));
      } catch (retryError) {
        return {
          stored: false,
          reason: isQuotaExceeded(retryError)
            ? `browser storage is full even after evicting ${evicted.length} cached `
              + `${evicted.length === 1 ? "asset" : "assets"}; maps will keep loading from the network`
            : describe(retryError),
          evictedDigests: evicted,
        };
      }
    }
    entries.set(digest, { bytes: size, lastUsedAt: this.#tick() });
    this.#recount();
    this.#persistSoon();
    return { stored: true, evictedDigests: evicted };
  }

  /** Drop least recently used entries until at most `targetBytes` remain. */
  async evictTo(targetBytes: number): Promise<string[]> {
    const evicted = await this.#evictTo(targetBytes);
    if (evicted.length > 0) this.#persistSoon();
    return evicted;
  }

  /** Remove exactly these entries (an explicit per-map delete); returns the bytes freed. */
  async delete(digests: readonly string[]): Promise<number> {
    const entries = this.#load();
    const cache = await this.#open();
    let freed = 0;
    for (const digest of new Set(digests)) {
      const entry = entries.get(digest);
      if (!entry) continue;
      await cache?.delete(new Request(this.#keyUrl(digest))).catch(() => false);
      entries.delete(digest);
      freed += entry.bytes;
    }
    if (freed > 0) {
      this.#recount();
      this.#persistSoon();
    }
    return freed;
  }

  async clear(): Promise<void> {
    this.#entries = new Map();
    this.#usedBytes = 0;
    this.#persistScheduled = false;
    this.#store.clear();
    await this.#caches.delete(this.#cacheName).catch(() => false);
  }

  /** Write the index out now instead of on the scheduled tick. */
  flush(): void {
    if (!this.#entries) return;
    this.#persistScheduled = false;
    this.#store.write({ entries: Object.fromEntries(this.#entries) });
  }

  async #evictTo(targetBytes: number): Promise<string[]> {
    const entries = this.#load();
    if (this.#usedBytes <= targetBytes) return [];
    const cache = await this.#open();
    const victims = [...entries.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    const evicted: string[] = [];
    for (const [digest, entry] of victims) {
      if (this.#usedBytes <= targetBytes) break;
      await cache?.delete(new Request(this.#keyUrl(digest))).catch(() => false);
      entries.delete(digest);
      this.#usedBytes -= entry.bytes;
      evicted.push(digest);
    }
    if (this.#usedBytes < 0) this.#recount();
    return evicted;
  }

  async #open(): Promise<Cache | null> {
    try {
      return await this.#caches.open(this.#cacheName);
    } catch {
      return null;
    }
  }

  #load(): Map<string, AssetCacheEntry> {
    if (this.#entries) return this.#entries;
    const snapshot = this.#store.read();
    this.#entries = new Map(Object.entries(snapshot?.entries ?? {}).flatMap(([digest, entry]) => {
      const bytes = Number(entry?.bytes);
      const lastUsedAt = Number(entry?.lastUsedAt);
      return SHA256.test(digest) && Number.isSafeInteger(bytes) && bytes >= 0 && Number.isFinite(lastUsedAt)
        ? [[digest, { bytes, lastUsedAt }] as const]
        : [];
    }));
    for (const entry of this.#entries.values()) this.#clock = Math.max(this.#clock, entry.lastUsedAt);
    this.#recount();
    return this.#entries;
  }

  #tick(): number {
    this.#clock = Math.max(this.#now(), this.#clock + 1);
    return this.#clock;
  }

  #recount(): void {
    let used = 0;
    for (const entry of this.#entries?.values() ?? []) used += entry.bytes;
    this.#usedBytes = used;
  }

  #persistSoon(): void {
    if (this.#persistScheduled) return;
    this.#persistScheduled = true;
    this.#schedulePersist(() => {
      if (!this.#persistScheduled) return;
      this.flush();
    });
  }
}

async function responseBytes(response: Response): Promise<number> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(declared) && declared > 0) return declared;
  return (await response.clone().arrayBuffer()).byteLength;
}

/**
 * Free bytes of the origin's storage quota, or `null` when the browser will
 * not say.
 *
 * Advisory in every engine that implements it — the number moves with disk
 * pressure and with what other origins hold — so it belongs in a "should this
 * large write be attempted at all" decision, never in a correctness one. A
 * browser that throws from `estimate()` (some private-browsing modes do)
 * reports the same "unknown" as one that omits the quota.
 */
export async function availableStorageBytes(
  storage: StorageManager | undefined = globalThis.navigator?.storage,
): Promise<number | null> {
  const estimate = await storage?.estimate?.().catch(() => undefined);
  if (!estimate?.quota) return null;
  return Math.max(0, estimate.quota - (estimate.usage ?? 0));
}

/**
 * Delete cache buckets written by a previous cache layout.
 *
 * A bucket name encodes the layout, so bumping it is how an incompatible
 * change is rolled out — but the old bucket then sits in the origin's quota
 * with nothing able to read it, which is the one kind of cached byte that is
 * pure cost. Returns the names actually removed; a name that was never there
 * is not an error.
 */
export async function purgeLegacyAssetCaches(
  caches: CacheStorage,
  names: readonly string[],
): Promise<string[]> {
  const outcomes = await Promise.all(names.map(async (name) => {
    const deleted = await caches.delete(name).catch(() => false);
    return deleted ? name : null;
  }));
  return outcomes.filter((name): name is string => name !== null);
}

/** `localStorage`-backed index; the only persistence a browser page needs. */
export function localStorageIndexStore(key: string, storage: Storage): AssetCacheIndexStore {
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
        const entries = (parsed as AssetCacheIndex | null)?.entries;
        return entries && typeof entries === "object" ? { entries } : null;
      } catch {
        return null;
      }
    },
    write(index) {
      try {
        storage.setItem(key, JSON.stringify(index));
      } catch {
        // A full localStorage costs recency accuracy, not correctness: the
        // next session re-adopts the entries it finds in Cache Storage.
      }
    },
    clear() {
      try {
        storage.removeItem(key);
      } catch {
        // Same: nothing to do, and nothing depends on it.
      }
    },
  };
}
