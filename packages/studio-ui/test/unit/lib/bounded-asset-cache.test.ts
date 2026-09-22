import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BoundedAssetCache,
  availableStorageBytes,
  localStorageIndexStore,
  purgeLegacyAssetCaches,
  type AssetCacheIndex,
  type AssetCacheIndexStore,
} from "../../../src/lib/maps/frontend/bounded-asset-cache";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

/**
 * Cache Storage stand-in. `quotaAfterBytes` makes the browser refuse writes
 * past a hard limit the cache does not know about, which is the only way the
 * quota path is reachable without a real origin under storage pressure.
 */
class FakeCaches implements CacheStorage {
  readonly buckets = new Map<string, Map<string, ArrayBuffer>>();
  quotaAfterBytes = Number.POSITIVE_INFINITY;
  putCalls = 0;

  #bucket(name: string) {
    const existing = this.buckets.get(name);
    if (existing) return existing;
    const created = new Map<string, ArrayBuffer>();
    this.buckets.set(name, created);
    return created;
  }

  #resident() {
    let total = 0;
    for (const bucket of this.buckets.values()) {
      for (const body of bucket.values()) total += body.byteLength;
    }
    return total;
  }

  async open(name: string): Promise<Cache> {
    const bucket = this.#bucket(name);
    const owner = this;
    return {
      async match(request: RequestInfo | URL) {
        const body = bucket.get((request instanceof Request ? request.url : String(request)));
        return body ? new Response(body.slice(0)) : undefined;
      },
      async put(request: RequestInfo | URL, response: Response) {
        owner.putCalls += 1;
        const body = await response.arrayBuffer();
        if (owner.#resident() + body.byteLength > owner.quotaAfterBytes) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        bucket.set((request instanceof Request ? request.url : String(request)), body);
      },
      async delete(request: RequestInfo | URL) {
        return bucket.delete((request instanceof Request ? request.url : String(request)));
      },
    } as unknown as Cache;
  }

  async delete(name: string) {
    return this.buckets.delete(name);
  }

  async has(name: string) {
    return this.buckets.has(name);
  }

  async keys() {
    return [...this.buckets.keys()];
  }

  async match() {
    return undefined;
  }
}

type MemoryIndexStore = AssetCacheIndexStore & { snapshot: AssetCacheIndex | null; writes: number };

function memoryIndexStore(): MemoryIndexStore {
  return {
    snapshot: null,
    writes: 0,
    read() {
      return this.snapshot;
    },
    write(index) {
      this.writes += 1;
      this.snapshot = structuredClone(index);
    },
    clear() {
      this.snapshot = null;
    },
  };
}

let clock = 1_000;
let caches: FakeCaches;
let index: MemoryIndexStore;
let persist: Array<() => void>;

function makeCache(budgetBytes: number) {
  return new BoundedAssetCache({
    cacheName: "test-assets",
    budgetBytes,
    caches,
    index,
    keyUrl: (digest) => `https://studio.test/cache/${digest}`,
    now: () => (clock += 1),
    schedulePersist: (run) => persist.push(run),
  });
}

beforeEach(() => {
  clock = 1_000;
  caches = new FakeCaches();
  index = memoryIndexStore();
  persist = [];
});

describe("BoundedAssetCache", () => {
  it("serves a stored asset back and counts it against the budget", async () => {
    const cache = makeCache(1_000);
    expect(await cache.match(A)).toBeUndefined();

    const outcome = await cache.store(A, new Uint8Array(300).buffer);

    expect(outcome).toEqual({ stored: true, evictedDigests: [] });
    expect((await (await cache.match(A))?.arrayBuffer())?.byteLength).toBe(300);
    expect(cache.usage()).toMatchObject({ usedBytes: 300, budgetBytes: 1_000, entryCount: 1 });
  });

  it("evicts least recently used entries before the budget is exceeded", async () => {
    const cache = makeCache(1_000);
    await cache.store(A, new Uint8Array(400).buffer);
    await cache.store(B, new Uint8Array(400).buffer);
    // A is read after B is written, so B is now the least recently used.
    await cache.match(A);

    const outcome = await cache.store(C, new Uint8Array(400).buffer);

    expect(outcome).toEqual({ stored: true, evictedDigests: [B] });
    expect(await cache.has(B)).toBe(false);
    expect(await cache.has(A)).toBe(true);
    expect(await cache.has(C)).toBe(true);
    expect(cache.usage().usedBytes).toBe(800);
  });

  it("refuses an asset larger than the whole budget instead of emptying the cache", async () => {
    const cache = makeCache(500);
    await cache.store(A, new Uint8Array(400).buffer);

    const outcome = await cache.store(B, new Uint8Array(900).buffer);

    expect(outcome.stored).toBe(false);
    expect(await cache.has(A)).toBe(true);
  });

  it("evicts and retries once when the browser reports QuotaExceededError", async () => {
    const cache = makeCache(10_000);
    await cache.store(A, new Uint8Array(400).buffer);
    await cache.store(B, new Uint8Array(400).buffer);
    // The real ceiling is far below the configured budget.
    caches.quotaAfterBytes = 1_000;

    const outcome = await cache.store(C, new Uint8Array(400).buffer);

    expect(outcome.stored).toBe(true);
    expect(outcome.evictedDigests).toContain(A);
    expect(await cache.has(C)).toBe(true);
    // The budget now reflects what the browser actually allowed.
    expect(cache.budgetBytes).toBeLessThan(10_000);
  });

  it("reports a clear reason, without throwing, when even eviction cannot make room", async () => {
    const cache = makeCache(10_000);
    caches.quotaAfterBytes = 100;

    const outcome = await cache.store(A, new Uint8Array(400).buffer);

    expect(outcome.stored).toBe(false);
    if (outcome.stored) throw new Error("unreachable");
    expect(outcome.reason).toContain("browser storage is full");
  });

  it("forgets an entry the browser evicted behind its back", async () => {
    const cache = makeCache(1_000);
    await cache.store(A, new Uint8Array(400).buffer);
    caches.buckets.get("test-assets")!.clear();

    expect(await cache.match(A)).toBeUndefined();
    expect(cache.usage()).toMatchObject({ usedBytes: 0, entryCount: 0 });
  });

  it("re-fetches nothing but starts empty after a clear", async () => {
    const cache = makeCache(1_000);
    await cache.store(A, new Uint8Array(400).buffer);

    await cache.clear();

    expect(await cache.has(A)).toBe(false);
    expect(cache.usage()).toMatchObject({ usedBytes: 0, entryCount: 0 });
    expect(index.snapshot).toBeNull();
  });

  it("restores usage and recency from the persisted index", async () => {
    const first = makeCache(1_000);
    await first.store(A, new Uint8Array(400).buffer);
    await first.store(B, new Uint8Array(100).buffer);
    for (const run of persist.splice(0)) run();

    const second = makeCache(1_000);

    expect(second.usage()).toMatchObject({ usedBytes: 500, entryCount: 2 });
    expect(second.digests()).toEqual([A, B]);
  });

  it("coalesces index writes across a burst instead of writing per asset", async () => {
    const cache = makeCache(10_000);
    for (const digest of [A, B, C]) await cache.store(digest, new Uint8Array(100).buffer);

    expect(index.writes).toBe(0);
    for (const run of persist.splice(0)) run();
    expect(index.writes).toBe(1);
  });

  it("adopts bytes present in Cache Storage but missing from the index", async () => {
    const cache = makeCache(1_000);
    const bucket = await caches.open("test-assets");
    await bucket.put(`https://studio.test/cache/${A}`, new Response(new Uint8Array(250)));

    expect(await cache.has(A)).toBe(true);
    expect(cache.usage()).toMatchObject({ usedBytes: 250, entryCount: 1 });
  });

  it("ignores a digest that is not a sha-256", async () => {
    const cache = makeCache(1_000);
    const outcome = await cache.store("not-a-digest", new Uint8Array(10).buffer);
    expect(outcome.stored).toBe(false);
    expect(await cache.match("not-a-digest")).toBeUndefined();
  });
});

describe("localStorageIndexStore", () => {
  it("round-trips an index and survives unparseable storage", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    } as unknown as Storage;
    const store = localStorageIndexStore("map-index", storage);

    store.write({ entries: { [A]: { bytes: 7, lastUsedAt: 2 } } });
    expect(store.read()).toEqual({ entries: { [A]: { bytes: 7, lastUsedAt: 2 } } });

    backing.set("map-index", "{oops");
    expect(store.read()).toBeNull();

    store.clear();
    expect(store.read()).toBeNull();
  });

  it("keeps working when the browser refuses a storage write", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
      removeItem: vi.fn(),
    } as unknown as Storage;

    expect(() => localStorageIndexStore("map-index", storage).write({ entries: {} })).not.toThrow();
  });
});

describe("availableStorageBytes", () => {
  it("reports the unused share of the quota", async () => {
    const storage = { estimate: async () => ({ quota: 1_000, usage: 250 }) } as unknown as StorageManager;

    expect(await availableStorageBytes(storage)).toBe(750);
  });

  it("reports unknown rather than a number when the browser will not say", async () => {
    const noQuota = { estimate: async () => ({ usage: 10 }) } as unknown as StorageManager;
    const refuses = { estimate: async () => { throw new DOMException("no", "SecurityError"); } } as unknown as StorageManager;

    expect(await availableStorageBytes(noQuota)).toBeNull();
    expect(await availableStorageBytes(refuses)).toBeNull();
    expect(await availableStorageBytes(undefined)).toBeNull();
  });

  it("never reports negative headroom when usage already exceeds the estimate", async () => {
    const overfull = { estimate: async () => ({ quota: 100, usage: 400 }) } as unknown as StorageManager;

    expect(await availableStorageBytes(overfull)).toBe(0);
  });
});

describe("purgeLegacyAssetCaches", () => {
  it("removes superseded buckets and leaves the current one alone", async () => {
    await (await caches.open("simforge-map-assets-v3")).put("https://studio.test/a", new Response(new Uint8Array(4)));
    await (await caches.open("simforge-map-assets-v4")).put("https://studio.test/b", new Response(new Uint8Array(4)));

    const purged = await purgeLegacyAssetCaches(caches, [
      "simforge-map-assets-v3",
      "never-existed",
    ]);

    expect(purged).toEqual(["simforge-map-assets-v3"]);
    expect(await caches.keys()).toEqual(["simforge-map-assets-v4"]);
  });

  it("survives a CacheStorage that refuses deletion", async () => {
    const hostile = { delete: async () => { throw new DOMException("no", "InvalidStateError"); } } as unknown as CacheStorage;

    await expect(purgeLegacyAssetCaches(hostile, ["old"])).resolves.toEqual([]);
  });
});
