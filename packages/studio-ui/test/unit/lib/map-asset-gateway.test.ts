import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapAssetGateway } from "../../../src/lib/maps/frontend/map-asset-gateway";

const ORIGIN = "https://studio.test";
const MAP_URL = `${ORIGIN}/api/simforge/maps/a/browser-assets/3d/tile.glb`;

type FakeCacheStorage = CacheStorage & {
  buckets: Map<string, Map<string, ArrayBuffer>>;
  quotaAfterBytes: number;
  resident(): number;
};

/** Cache Storage stand-in with a hard ceiling the cache only learns by refusal. */
function fakeCacheStorage(): FakeCacheStorage {
  const buckets = new Map<string, Map<string, ArrayBuffer>>();
  const state = {
    buckets,
    quotaAfterBytes: Number.POSITIVE_INFINITY,
    resident() {
      let total = 0;
      for (const bucket of buckets.values()) for (const body of bucket.values()) total += body.byteLength;
      return total;
    },
    async open(name: string) {
      const bucket = buckets.get(name) ?? new Map<string, ArrayBuffer>();
      buckets.set(name, bucket);
      return {
        async match(request: RequestInfo | URL) {
          const body = bucket.get((request instanceof Request ? request.url : String(request)));
          return body
            ? new Response(body.slice(0), { headers: { "content-length": String(body.byteLength) } })
            : undefined;
        },
        async put(request: RequestInfo | URL, response: Response) {
          const body = await response.arrayBuffer();
          if (state.resident() + body.byteLength > state.quotaAfterBytes) {
            throw new DOMException("Quota exceeded.", "QuotaExceededError");
          }
          bucket.set((request instanceof Request ? request.url : String(request)), body);
        },
        async delete(request: RequestInfo | URL) {
          return bucket.delete((request instanceof Request ? request.url : String(request)));
        },
      } as unknown as Cache;
    },
    async delete(name: string) {
      return buckets.delete(name);
    },
    async has(name: string) {
      return buckets.has(name);
    },
    async keys() {
      return [...buckets.keys()];
    },
    async match() {
      return undefined;
    },
  };
  return state;
}

function memoryStorage(): Storage {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  } as unknown as Storage;
}

let caches: FakeCacheStorage;
let storage: Storage;
let persist: Array<() => void>;

function makeGateway(options: { budgetBytes?: number; fetch: typeof fetch }) {
  return new MapAssetGateway({
    cacheName: "map-assets-test",
    indexKey: "map-index",
    aliasKey: "map-aliases",
    legacyCacheNames: ["map-assets-v3", "map-assets-v4"],
    budgetBytes: options.budgetBytes ?? 1_000_000,
    contentPrefix: "/api/simforge/map-cache/sha256/",
    origin: ORIGIN,
    caches,
    storage,
    fetch: options.fetch,
    schedulePersist: (run) => persist.push(run),
  });
}

beforeEach(() => {
  caches = fakeCacheStorage();
  storage = memoryStorage();
  persist = [];
});

describe("MapAssetGateway", () => {
  it("serves a warmed asset with the network unavailable", async () => {
    const network = vi.fn(async () => new Response("offline-ready"));
    const gateway = makeGateway({ fetch: network as unknown as typeof fetch });

    await (await gateway.fetchAsset(MAP_URL)).arrayBuffer();
    network.mockRejectedValue(new Error("network disabled"));

    expect(await (await gateway.fetchAsset(MAP_URL)).text()).toBe("offline-ready");
    expect(network).toHaveBeenCalledOnce();
  });

  it("stores identical bytes once across different URLs", async () => {
    const network = vi.fn(async () => new Response("shared geometry"));
    const gateway = makeGateway({ fetch: network as unknown as typeof fetch });

    await (await gateway.fetchAsset(`${ORIGIN}/api/simforge/maps/a/browser-assets/3d/a.glb`)).arrayBuffer();
    await (await gateway.fetchAsset(`${ORIGIN}/api/simforge/maps/b/browser-assets/3d/b.glb`)).arrayBuffer();

    expect(network).toHaveBeenCalledTimes(2);
    expect(caches.buckets.get("map-assets-test")?.size).toBe(1);
  });

  it("refuses bytes whose digest is not the one the caller was promised", async () => {
    const gateway = makeGateway({ fetch: (async () => new Response("tampered")) as unknown as typeof fetch });

    await expect(gateway.fetchAsset(MAP_URL, {}, { sha256: "a".repeat(64) }))
      .rejects.toThrow("Asset integrity check failed");
  });

  it("transfers from a registered signed URL and keys the result by content", async () => {
    const signed = "https://delivery.example/tile.glb?sig=1";
    const network = vi.fn(async () => new Response("signed bytes"));
    const gateway = makeGateway({ fetch: network as unknown as typeof fetch });
    gateway.registerDownloadUrls(new Map([[MAP_URL, signed]]));
    const target = { fetch: network as unknown as typeof fetch };
    gateway.installFetchGateway(target);

    // A loader that only knows the signed URL still lands in the cache...
    expect(await (await target.fetch(signed)).text()).toBe("signed bytes");
    await vi.waitFor(async () => expect(await gateway.hasAsset(MAP_URL)).toBe(true));
    network.mockRejectedValue(new Error("network disabled"));
    // ...and the canonical URL is then served from it, signature or not.
    expect(await (await target.fetch(MAP_URL)).text()).toBe("signed bytes");
    expect(network).toHaveBeenCalledWith(signed, expect.objectContaining({ credentials: "omit" }));
  });

  it("hands the caller streaming bytes before the copy is written", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const network = vi.fn(async () => new Response(body));
    const gateway = makeGateway({ fetch: network as unknown as typeof fetch });

    const response = await gateway.fetchAsset(MAP_URL, {}, { stream: true });
    const reader = response.body!.getReader();
    source.enqueue(new TextEncoder().encode("first"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    source.enqueue(new TextEncoder().encode("-last"));
    source.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("-last");

    await vi.waitFor(async () => expect(await gateway.hasAsset(MAP_URL)).toBe(true));
    expect(await (await gateway.fetchAsset(MAP_URL)).text()).toBe("first-last");
  });

  it("keeps serving bytes when the browser refuses to store them", async () => {
    caches.quotaAfterBytes = 4;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gateway = makeGateway({
      fetch: (async () => new Response("far too many bytes")) as unknown as typeof fetch,
    });

    const response = await gateway.fetchAsset(MAP_URL);

    expect(await response.text()).toBe("far too many bytes");
    expect(await gateway.hasAsset(MAP_URL)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("records closure receipts that survive a reload and die with a clear", async () => {
    const gateway = makeGateway({ fetch: (async () => new Response("x")) as unknown as typeof fetch });

    gateway.writeReceipt("release-a::high", 12, 1_000);

    expect(gateway.hasReceipt("release-a::high")).toBe(true);
    expect(gateway.hasReceipt("release-a::minimal")).toBe(false);
    // A fresh gateway over the same storage is what a reload looks like.
    expect(makeGateway({ fetch: globalThis.fetch }).hasReceipt("release-a::high")).toBe(true);

    await gateway.clear();
    expect(gateway.hasReceipt("release-a::high")).toBe(false);
  });

  it("reclaims the quota a superseded bucket still holds", async () => {
    await (await caches.open("map-assets-v4")).put(`${ORIGIN}/old`, new Response(new Uint8Array(8)));
    const gateway = makeGateway({ fetch: globalThis.fetch });

    expect(await gateway.purgeLegacyCaches()).toEqual(["map-assets-v4"]);
    expect(await caches.keys()).not.toContain("map-assets-v4");
  });

  it("never asks for persistent storage on its own", async () => {
    const persistRequest = vi.fn(async () => true);
    const gateway = new MapAssetGateway({
      cacheName: "map-assets-test",
      indexKey: "map-index",
      aliasKey: "map-aliases",
      contentPrefix: "/api/simforge/map-cache/sha256/",
      origin: ORIGIN,
      caches,
      storage,
      fetch: (async () => new Response("bytes")) as unknown as typeof fetch,
      storageManager: {
        estimate: async () => ({ quota: 10_000_000, usage: 0 }),
        persisted: async () => false,
        persist: persistRequest,
      } as unknown as StorageManager,
      schedulePersist: (run) => persist.push(run),
    });

    await gateway.fetchAsset(MAP_URL);
    await gateway.status();

    expect(persistRequest).not.toHaveBeenCalled();
    expect(await gateway.requestPersistentStorage()).toBe(true);
    expect(persistRequest).toHaveBeenCalledOnce();
  });
});
