// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheReceiptKey,
  clearMapAssetCache,
  fetchMapAsset,
  flushMapAssetCacheIndex,
  hasCachedMapAsset,
  hasCacheReceipt,
  installMapAssetFetchGateway,
  prepareMapAssetCache,
  sha256Hex,
  writeCacheReceipt,
} from "../../../src/lib/maps/frontend/map-asset-cache";

function fakeCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  return {
    open: vi.fn(async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
        put: vi.fn(async (request: Request, response: Response) => {
          store.set(request.url, response.clone());
        }),
      };
    }),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };
}

describe("unified map asset cache", () => {
  beforeEach(() => {
    const storage = fakeCacheStorage();
    vi.stubGlobal("caches", storage);
    Object.defineProperty(window, "caches", { configurable: true, value: storage });
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores identical bytes once by SHA across different map URLs", async () => {
    const bytes = new TextEncoder().encode("shared geometry");
    const sha = await sha256Hex(bytes.buffer);
    const network = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", network);

    await (await fetchMapAsset("/api/simforge/maps/a/browser-assets/3d/a.glb", {}, sha!)).arrayBuffer();
    await (await fetchMapAsset("/api/simforge/maps/b/browser-assets/3d/b.glb", {}, sha!)).arrayBuffer();

    expect(network).toHaveBeenCalledOnce();
    expect(await hasCachedMapAsset("/api/simforge/maps/b/browser-assets/3d/b.glb", sha!)).toBe(true);
  });

  it("serves a warmed runtime request with the network completely unavailable", async () => {
    const url = "/api/simforge/maps/a/browser-assets/3d/tile.glb";
    const network = vi.fn(async () => new Response("offline-ready"));
    vi.stubGlobal("fetch", network);
    await (await fetchMapAsset(url)).arrayBuffer();
    network.mockRejectedValue(new Error("network disabled"));

    expect(await (await fetchMapAsset(url)).text()).toBe("offline-ready");
    expect(network).toHaveBeenCalledOnce();
  });

  it("serves byte ranges from the cached full object", async () => {
    const url = "/api/simforge/maps/a/browser-assets/signals.geojson.gz";
    const network = vi.fn(async () => new Response("0123456789"));
    vi.stubGlobal("fetch", network);
    await (await fetchMapAsset(url)).arrayBuffer();

    const partial = await fetchMapAsset(url, { headers: { Range: "bytes=2-5" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");
    expect(network).toHaveBeenCalledOnce();
  });

  it("warms the complete asset in the background when normal use requests a range", async () => {
    const url = "/api/simforge/sumo-runtime/v1/sumo.wasm";
    const network = vi.fn()
      .mockResolvedValueOnce(new Response("partial", { status: 206 }))
      .mockResolvedValueOnce(new Response("complete wasm"));
    vi.stubGlobal("fetch", network);

    const partial = await fetchMapAsset(url, { headers: { Range: "bytes=0-6" } });
    expect(partial.status).toBe(206);
    await vi.waitFor(async () => {
      expect(await hasCachedMapAsset(url)).toBe(true);
    });
    expect(new Headers(network.mock.calls[1]?.[1]?.headers).has("range")).toBe(false);
  });

  it("rejects content that does not match the verified inventory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("tampered")));
    await expect(fetchMapAsset(
      "/api/simforge/maps/a/browser-assets/3d/a.glb",
      {},
      "a".repeat(64),
    )).rejects.toThrow("Asset integrity check failed");
  });

  it("records completion only under the release and rendering profile", () => {
    const key = cacheReceiptKey("release-a", "high");
    writeCacheReceipt(key, 12, 1000);
    expect(hasCacheReceipt(key)).toBe(true);
    expect(hasCacheReceipt(cacheReceiptKey("release-a", "minimal"))).toBe(false);
  });

  it("clears the single consolidated cache and receipt index", async () => {
    writeCacheReceipt(cacheReceiptKey("release-a", "high"), 1, 1);
    await clearMapAssetCache();
    expect(caches.delete).toHaveBeenCalledWith("simforge-map-assets-v4");
    expect(hasCacheReceipt(cacheReceiptKey("release-a", "high"))).toBe(false);
  });

  it("continues caching when the browser declines persistent storage", async () => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persisted: vi.fn(async () => false),
        persist: vi.fn(async () => false),
      },
    });

    await expect(prepareMapAssetCache()).resolves.toBe(false);
  });

  it("downloads directly from a batch-resolved URL and flushes one deferred index", async () => {
    const canonical = "/api/simforge/maps/a/browser-assets/3d/direct.glb";
    const direct = "https://optimized-assets.s3.amazonaws.com/direct.glb?signed=1";
    const bytes = new TextEncoder().encode("direct optimized bytes");
    const sha = await sha256Hex(bytes.buffer);
    const network = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", network);

    await fetchMapAsset(canonical, {}, sha!, direct, true);

    expect(network).toHaveBeenCalledWith(
      direct,
      expect.objectContaining({ credentials: "omit" }),
    );
    expect(localStorage.getItem("simforge-map-assets-index-v4")).toBeNull();
    flushMapAssetCacheIndex();
    expect(localStorage.getItem("simforge-map-assets-index-v4")).not.toBeNull();
    expect(await hasCachedMapAsset(canonical, sha!)).toBe(true);
  });

  it("automatically caches assets fetched during normal app use", async () => {
    const url = "/api/simforge/maps/a/browser-assets/3d/visible-tile.glb";
    const network = vi.fn(async () => new Response("cached while browsing"));
    vi.stubGlobal("fetch", network);
    Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: network });
    installMapAssetFetchGateway();

    expect(await (await window.fetch(url)).text()).toBe("cached while browsing");
    network.mockRejectedValue(new Error("network disabled"));
    expect(await (await window.fetch(url)).text()).toBe("cached while browsing");
    expect(network).toHaveBeenCalledOnce();
  });
});
