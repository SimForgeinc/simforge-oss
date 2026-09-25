// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readMapAssetCacheBudgetSetting } from "../../../src/lib/maps/frontend/map-asset-cache";
import {
  MAP_ASSET_CACHE_DEFAULT_BUDGET_BYTES,
  MAP_ASSET_CACHE_MAX_QUOTA_SHARE,
  MapAssetGateway,
  effectiveMapCacheCeiling,
  maxSelectableMapCacheCeiling,
} from "../../../src/lib/maps/frontend/map-asset-gateway";

const GIB = 1024 ** 3;
const ORIGIN = "https://studio.test";

function memoryStorage(): Storage {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  } as unknown as Storage;
}

function memoryCaches(): CacheStorage {
  const buckets = new Map<string, Map<string, ArrayBuffer>>();
  return {
    async open(name: string) {
      const bucket = buckets.get(name) ?? new Map<string, ArrayBuffer>();
      buckets.set(name, bucket);
      return {
        async match(request: Request) {
          const body = bucket.get(request.url);
          return body ? new Response(body.slice(0), { headers: { "content-length": String(body.byteLength) } }) : undefined;
        },
        async put(request: Request, response: Response) { bucket.set(request.url, await response.arrayBuffer()); },
        async delete(request: Request) { return bucket.delete(request.url); },
      } as unknown as Cache;
    },
    async delete(name: string) { return buckets.delete(name); },
    async has(name: string) { return buckets.has(name); },
    async keys() { return [...buckets.keys()]; },
    async match() { return undefined; },
  } as unknown as CacheStorage;
}

/** A storage manager whose quota a persistence grant raises, the way Firefox's does. */
function storageManager(quota: number, grantedQuota = quota) {
  let persisted = false;
  let current = quota;
  return {
    estimate: vi.fn(async () => ({ quota: current, usage: 0 })),
    persisted: vi.fn(async () => persisted),
    persist: vi.fn(async () => {
      persisted = true;
      current = grantedQuota;
      return true;
    }),
  } as unknown as StorageManager & { persist: ReturnType<typeof vi.fn> };
}

function gateway(options: { budgetBytes?: number; storageManager?: StorageManager }) {
  return new MapAssetGateway({
    cacheName: "ceiling-test",
    indexKey: "ceiling-index",
    aliasKey: "ceiling-aliases",
    budgetBytes: options.budgetBytes,
    contentPrefix: "/api/simforge/map-cache/sha256/",
    origin: ORIGIN,
    caches: memoryCaches(),
    storage: memoryStorage(),
    fetch: vi.fn() as unknown as typeof fetch,
    storageManager: options.storageManager,
    schedulePersist: () => undefined,
  });
}

describe("map cache ceiling", () => {
  it("defaults to 32 GiB, enough for every map at the default profile", () => {
    expect(MAP_ASSET_CACHE_DEFAULT_BUDGET_BYTES).toBe(32 * GIB);
    expect(MAP_ASSET_CACHE_MAX_QUOTA_SHARE).toBe(0.5);
  });

  it("clamps the configured budget to half of the origin quota", () => {
    expect(effectiveMapCacheCeiling(32 * GIB, 200 * GIB)).toBe(32 * GIB);
    expect(effectiveMapCacheCeiling(32 * GIB, 10 * GIB)).toBe(5 * GIB);
    // An unknown quota leaves the configured budget as the only bound.
    expect(effectiveMapCacheCeiling(32 * GIB, null)).toBe(32 * GIB);
    expect(effectiveMapCacheCeiling(32 * GIB, 0)).toBe(32 * GIB);
    expect(maxSelectableMapCacheCeiling(120 * GIB)).toBe(60 * GIB);
    expect(maxSelectableMapCacheCeiling(null)).toBeNull();
  });

  it("enforces the clamped ceiling once the quota is known", async () => {
    const cache = gateway({ storageManager: storageManager(10 * GIB) });
    const status = await cache.status();
    expect(status.configuredBudgetBytes).toBe(32 * GIB);
    expect(status.budgetBytes).toBe(5 * GIB);
    expect(status.quotaBytes).toBe(10 * GIB);
  });

  it("re-derives the ceiling after a persistence grant raises the quota", async () => {
    const manager = storageManager(10 * GIB, 400 * GIB);
    const cache = gateway({ storageManager: manager });
    expect((await cache.status()).budgetBytes).toBe(5 * GIB);
    await expect(cache.requestPersistentStorage()).resolves.toBe(true);
    expect(manager.persist).toHaveBeenCalledTimes(1);
    const after = await cache.status();
    expect(after.persistent).toBe(true);
    expect(after.quotaBytes).toBe(400 * GIB);
    expect(after.budgetBytes).toBe(32 * GIB);
  });

  it("never requests persistence on its own", async () => {
    const manager = storageManager(100 * GIB);
    const cache = gateway({ storageManager: manager });
    await cache.status();
    await cache.refreshQuota();
    expect(manager.persist).not.toHaveBeenCalled();
  });

  it("applies a chosen size inside the quota clamp, including raising it again", async () => {
    const cache = gateway({ storageManager: storageManager(40 * GIB) });
    await cache.status();
    cache.setBudgetBytes(8 * GIB);
    expect(cache.budgetBytes).toBe(8 * GIB);
    cache.setBudgetBytes(64 * GIB);
    expect(cache.budgetBytes).toBe(20 * GIB);
    expect(cache.configuredBudgetBytes).toBe(64 * GIB);
  });

  it("deletes exactly the digests it is given and reports the bytes freed", async () => {
    const network = vi.fn(async (url: string) => new Response(url.endsWith("a") ? "aaaa" : "bb"));
    const cache = new MapAssetGateway({
      cacheName: "delete-test",
      indexKey: "delete-index",
      aliasKey: "delete-aliases",
      budgetBytes: 1_000,
      contentPrefix: "/api/simforge/map-cache/sha256/",
      origin: ORIGIN,
      caches: memoryCaches(),
      storage: memoryStorage(),
      fetch: network as unknown as typeof fetch,
      schedulePersist: () => undefined,
    });
    const shaA = "61be55a8e2f6b4e172338bddf184d6dbee29c98853e0a0485ecee7f27b9af0b4";
    const shaB = "3b64db95cb55c763391c707108489ae18b4112d783300de38e033b4c98c3deaf";
    await cache.ensureAsset(`${ORIGIN}/api/simforge/maps/m/browser-assets/a`, { sha256: shaA });
    await cache.ensureAsset(`${ORIGIN}/api/simforge/maps/m/browser-assets/b`, { sha256: shaB });
    expect(cache.holdsDigest(shaA)).toBe(true);
    await expect(cache.deleteDigests([shaA, "f".repeat(64)])).resolves.toBe(4);
    expect(cache.holdsDigest(shaA)).toBe(false);
    expect(cache.holdsDigest(shaB)).toBe(true);
    expect(cache.cache.usage().usedBytes).toBe(2);
  });
});

describe("chosen cache size", () => {
  // The reader takes its storage as an argument, so the module is imported once,
  // statically: a cold `vi.resetModules()` + dynamic import of the whole cache
  // graph took longer than the 10 s test timeout under the merge gate's load.
  beforeEach(() => {
    localStorage.clear();
  });

  it("reads the default, a preset and Max from storage, ignoring junk", () => {
    const store = memoryStorage();
    expect(readMapAssetCacheBudgetSetting(store)).toEqual({ kind: "bytes", bytes: 32 * GIB });
    store.setItem("simforge.map-cache.budget.v1", JSON.stringify({ kind: "bytes", bytes: 8 * GIB }));
    expect(readMapAssetCacheBudgetSetting(store)).toEqual({ kind: "bytes", bytes: 8 * GIB });
    store.setItem("simforge.map-cache.budget.v1", JSON.stringify({ kind: "max" }));
    expect(readMapAssetCacheBudgetSetting(store)).toEqual({ kind: "max" });
    store.setItem("simforge.map-cache.budget.v1", "{not json");
    expect(readMapAssetCacheBudgetSetting(store)).toEqual({ kind: "bytes", bytes: 32 * GIB });
    store.setItem("simforge.map-cache.budget.v1", JSON.stringify({ kind: "bytes", bytes: -1 }));
    expect(readMapAssetCacheBudgetSetting(store)).toEqual({ kind: "bytes", bytes: 32 * GIB });
  });
});
