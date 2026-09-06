// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMapAssetFetchGateway } from "../../../src/lib/maps/frontend/map-asset-cache";

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

// ---------------------------------------------------------------------------
// Digital-twin panel coverage: `/api/map-assets/<id>/3d-asset/…` URLs are not
// content-versioned (rebuilds overwrite in place), so the gateway must cache
// exactly the fetches that carry the explicit `?v=<manifest-hash>` token the
// city-viewer appends — and nothing else on that route.
// ---------------------------------------------------------------------------

describe("map-asset cache gateway on 3d-asset URLs", () => {
  // One gateway install per module load: the module captures nativeFetch on
  // install, so a single mutable `network` fn backs every test in this file.
  const network = vi.fn<typeof fetch>();

  beforeEach(() => {
    const storage = fakeCacheStorage();
    vi.stubGlobal("caches", storage);
    Object.defineProperty(window, "caches", { configurable: true, value: storage });
    localStorage.clear();
    network.mockReset();
    vi.stubGlobal("fetch", network);
    Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: network });
    installMapAssetFetchGateway();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("serves versioned tile fetches from cache after one download", async () => {
    const url = "/api/map-assets/belmont_1/3d-asset/tiles/tile_1_1.lod0.glb?v=abc123";
    network.mockImplementation(async () => new Response("tile bytes"));

    expect(await (await window.fetch(url)).text()).toBe("tile bytes");
    network.mockRejectedValue(new Error("network disabled"));
    expect(await (await window.fetch(url)).text()).toBe("tile bytes");
    expect(network).toHaveBeenCalledOnce();
  });

  it("a new version token misses the cache and refetches", async () => {
    const base = "/api/map-assets/belmont_1/3d-asset/tiles/tile_2_2.lod0.glb";
    network.mockImplementation(async () => new Response("build A"));
    expect(await (await window.fetch(`${base}?v=aaa`)).text()).toBe("build A");
    network.mockImplementation(async () => new Response("build B"));
    expect(await (await window.fetch(`${base}?v=bbb`)).text()).toBe("build B");
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("token-less 3d-asset fetches (manifest, probes) always hit the network", async () => {
    const url = "/api/map-assets/belmont_1/3d-asset/manifest.json";
    network.mockImplementation(async () => new Response('{"tiles":[]}'));
    await window.fetch(url);
    await window.fetch(url);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("does not persist a 204 probe response as a cached asset", async () => {
    const url = "/api/map-assets/belmont_1/3d-asset/twin-eval/report.json?v=abc&optional=1";
    network.mockImplementation(async () => new Response(null, { status: 204 }));
    expect((await window.fetch(url)).status).toBe(204);
    network.mockImplementation(async () => new Response("now it exists"));
    expect(await (await window.fetch(url)).text()).toBe("now it exists");
    expect(network).toHaveBeenCalledTimes(2);
  });
});
