// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushMapAssetCacheIndex,
  installMapAssetFetchGateway,
  isMapAssetLikelyCached,
  mapAssetCacheStatus,
  resetMapAssetCacheForTests,
} from "../../lib/maps/frontend/map-asset-cache";
import { createDirectMapAssetUrlResolver, resetDirectMapAssetUrlsForTests } from "./direct-map-asset-urls";

const ORIGIN = window.location.origin;
const asset = (path: string, map = "map") => `/api/simforge/maps/${map}/browser-assets/${path}`;
const absolute = (path: string, map = "map") => `${ORIGIN}${asset(path, map)}`;

/** Cache Storage that outlives a simulated page reload, like the real one. */
function fakeCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (request: RequestInfo | URL) => request instanceof Request ? request.url : String(request);
  return {
    open: vi.fn(async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: vi.fn(async (request: RequestInfo | URL) => store.get(keyOf(request))?.clone()),
        put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
          const body = await response.arrayBuffer();
          store.set(keyOf(request), new Response(body, { status: response.status, headers: response.headers }));
        }),
        delete: vi.fn(async (request: RequestInfo | URL) => store.delete(keyOf(request))),
      };
    }),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    has: vi.fn(async (name: string) => stores.has(name)),
    keys: vi.fn(async () => [...stores.keys()]),
  };
}

type Call = { url: string; method: string };

/**
 * The deployment as the browser sees it: a URL-issuing POST that signs every
 * member afresh on each call (so the HTTP cache can never hit), the object
 * store behind those signatures, and the first-party redirect route.
 */
function deployment() {
  const calls: Call[] = [];
  let signature = 0;
  const bytes = (path: string) => new TextEncoder().encode(`bytes of ${path}`);
  const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("/api/simforge/maps/cache-download-urls")) {
      signature += 1;
      const { assets } = JSON.parse(String(init?.body)) as { assets: Array<{ mapVersionId: string; relativePath: string }> };
      return new Response(JSON.stringify({
        assets: assets.map(({ mapVersionId, relativePath }) => ({
          mapVersionId,
          relativePath,
          url: `https://bucket.s3.test/${mapVersionId}/${relativePath}?X-Amz-Signature=${signature}`,
        })),
      }), { headers: { "content-type": "application/json" } });
    }
    const s3 = /^https:\/\/bucket\.s3\.test\/([^/]+)\/(.+)\?/.exec(url);
    if (s3) return new Response(bytes(s3[2]!), { headers: { "content-type": "model/gltf-binary" } });
    const firstParty = /\/browser-assets\/(.+)$/.exec(new URL(url, ORIGIN).pathname);
    if (firstParty) return new Response(bytes(firstParty[1]!));
    return new Response("not found", { status: 404 });
  });
  return { calls, network, bytes };
}

function bootPage(network: typeof fetch) {
  Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: network });
  vi.stubGlobal("fetch", network);
  resetMapAssetCacheForTests();
  resetDirectMapAssetUrlsForTests();
  installMapAssetFetchGateway();
}

/** What the city viewer does per map: resolve its member URLs, then fetch each one. */
async function viewerLoad(paths: string[]) {
  const urls = paths.map((path) => asset(path));
  const resolve = createDirectMapAssetUrlResolver("map");
  const resolved = await resolve(urls, new AbortController().signal);
  return Promise.all(urls.map(async (url) => {
    const response = await window.fetch(resolved.get(url) ?? url);
    return { response, text: await response.text() };
  }));
}

const TILES = ["3d/manifest.json", "3d/tiles/tile_0_0.lod0.glb", "3d/tiles/tile_0_1.lod0.glb", "3d/textures/road.ktx2"];

describe("viewer map loads through the map asset cache", () => {
  let storage: ReturnType<typeof fakeCacheStorage>;

  beforeEach(() => {
    storage = fakeCacheStorage();
    vi.stubGlobal("caches", storage);
    Object.defineProperty(window, "caches", { configurable: true, value: storage });
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("makes no request of any kind on a second load after a reload", async () => {
    const cold = deployment();
    bootPage(cold.network as typeof fetch);
    const first = await viewerLoad(TILES);
    expect(first.map(({ text }) => text)).toEqual(TILES.map((path) => `bytes of ${path}`));
    // Cold: one batched URL issue, then every member straight from the object store.
    expect(cold.calls.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(cold.calls.filter(({ url }) => url.startsWith("https://bucket.s3.test/"))).toHaveLength(TILES.length);
    expect(cold.calls.some(({ url }) => url.includes("/browser-assets/"))).toBe(false);
    await vi.waitFor(() => {
      for (const path of TILES) expect(isMapAssetLikelyCached(absolute(path))).toBe(true);
    });
    flushMapAssetCacheIndex();

    // Reload: a fresh page over the same Cache Storage and localStorage.
    const warm = deployment();
    bootPage(warm.network as typeof fetch);
    const second = await viewerLoad(TILES);

    expect(second.map(({ text }) => text)).toEqual(TILES.map((path) => `bytes of ${path}`));
    expect(second.every(({ response }) => response.headers.get("x-simforge-cache") === "hit")).toBe(true);
    expect(warm.calls).toEqual([]);
  });

  it("hands the loader canonical URLs, never signed object-store URLs", async () => {
    const { network } = deployment();
    bootPage(network as typeof fetch);
    const resolve = createDirectMapAssetUrlResolver("map");
    const urls = [asset("a.bin"), asset("b.bin")];
    const resolved = await resolve(urls, new AbortController().signal);
    expect([...resolved.entries()]).toEqual(urls.map((url) => [url, url]));
  });

  it("issues URLs for concurrent misses in one POST, across map versions", async () => {
    const { calls, network } = deployment();
    bootPage(network as typeof fetch);
    await Promise.all([
      window.fetch(asset("a.bin", "map-1")).then((response) => response.text()),
      window.fetch(asset("b.bin", "map-2")).then((response) => response.text()),
    ]);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(calls.filter(({ url }) => url.startsWith("https://bucket.s3.test/map-1/a.bin"))).toHaveLength(1);
    expect(calls.filter(({ url }) => url.startsWith("https://bucket.s3.test/map-2/b.bin"))).toHaveLength(1);
  });

  it("splits more than 256 misses into bounded batches", async () => {
    const { calls, network } = deployment();
    bootPage(network as typeof fetch);
    const paths = Array.from({ length: 300 }, (_, index) => `tile-${index}.bin`);
    await viewerLoad(paths);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(2);
  });

  it("falls back to the first-party route when URL issuing fails", async () => {
    const { calls, network } = deployment();
    const failing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/cache-download-urls")) throw new Error("offline");
      return network(input, init);
    });
    bootPage(failing as typeof fetch);
    const [loaded] = await viewerLoad(["offline.bin"]);
    expect(loaded?.text).toBe("bytes of offline.bin");
    expect(calls.some(({ url }) => url.endsWith("/browser-assets/offline.bin"))).toBe(true);
  });

  it("retries an expired signature through the first-party route", async () => {
    const { calls, network } = deployment();
    const expired = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://bucket.s3.test/")) {
        calls.push({ url: String(input), method: "GET" });
        return new Response("<Error>Request has expired</Error>", { status: 403 });
      }
      return network(input, init);
    });
    bootPage(expired as typeof fetch);
    const [loaded] = await viewerLoad(["expired.bin"]);
    expect(loaded?.response.ok).toBe(true);
    expect(loaded?.text).toBe("bytes of expired.bin");
  });

  it("passes non-map URLs straight through without issuing anything", async () => {
    const { calls, network } = deployment();
    bootPage(network as typeof fetch);
    const resolve = createDirectMapAssetUrlResolver("map");
    const url = "https://example.test/other/file.bin";
    expect((await resolve([url], new AbortController().signal)).get(url)).toBe(url);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toEqual([]);
  });
});

describe("a page that cannot cache (plain HTTP on a LAN or tailnet address)", () => {
  beforeEach(() => {
    // An insecure context has neither Cache Storage nor the storage estimate.
    delete (window as { caches?: unknown }).caches;
    vi.stubGlobal("caches", undefined);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("says why instead of reporting unknown usage, and still loads straight from the object store", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { calls, network } = deployment();
    bootPage(network as typeof fetch);

    const status = await mapAssetCacheStatus();
    expect(status.backend).toBe("browser");
    expect(status.backend === "browser" && status.unavailable).toMatch(/isn't served over HTTPS/);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("Browser caching unavailable"))).toHaveLength(1);

    const [loaded] = await viewerLoad(["3d/tiles/tile_0_0.lod0.glb"]);
    expect(loaded?.text).toBe("bytes of 3d/tiles/tile_0_0.lod0.glb");
    expect(calls.some(({ url }) => url.startsWith("https://bucket.s3.test/"))).toBe(true);
    expect(calls.some(({ url }) => url.includes("/browser-assets/"))).toBe(false);
  });
});
