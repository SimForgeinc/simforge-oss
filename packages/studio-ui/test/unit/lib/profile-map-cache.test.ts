// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheProfileMapPlan,
  createProfileMapPlan,
  profileMapDownloadConcurrency,
} from "../../../src/lib/scenario/editor/profile-map-cache";
import {
  hasCacheReceipt,
  mapCacheReceiptKey,
} from "../../../src/lib/maps/frontend/map-asset-cache";
import type { ScenarioMapOption } from "../../../src/scenario/list/document-map-groups";

const ROOT = `${window.location.origin}/api/simforge/maps/map-1/browser-assets/`;
const CLOSURE_SHA = "c".repeat(64);
const SHA_A = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";
const SHA_B = "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d";
const SHA_C = "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6";
const SHA_D = "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4";

const map: ScenarioMapOption = {
  mapVersionId: "map-1",
  sourceMapId: "source-1",
  label: "Belmont",
  browserClosureSha256: CLOSURE_SHA,
  browserAssetRootUrl: ROOT,
  browserManifestUrl: `${ROOT}3d/manifest.json`,
  topologyUrl: `${ROOT}topology-index.json.gz`,
};

// One closure member is the SUMO network: local Studio plans the SUMO runtime
// only for closures that carry one, so this fixture has to say so explicitly.
const inventoryAssets = [
  { relativePath: "3d/manifest.json", sha256: SHA_A, byteLength: 1 },
  { relativePath: "3d/fine.glb", sha256: SHA_B, byteLength: 1 },
  { relativePath: "3d/lazy-far-tile.glb", sha256: SHA_C, byteLength: 1 },
  { relativePath: "3d/manifest-copy.json", sha256: SHA_A, byteLength: 1 },
  { relativePath: "derived/sumo/map.net.xml", sha256: SHA_D, byteLength: 1 },
];

function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  return {
    open: vi.fn(async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
        put: vi.fn(async (request: Request, response: Response) => void store.set(request.url, response.clone())),
        keys: vi.fn(async () => [...store.keys()].map((url) => new Request(url))),
        delete: vi.fn(async (request: Request) => store.delete(request.url)),
      };
    }),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };
}

function inventoryResponse() {
  return new Response(JSON.stringify({
    releaseKey: "release-a",
    maps: [{
      mapVersionId: "map-1",
      closureSha256: CLOSURE_SHA,
      assets: inventoryAssets,
    }],
  }), { status: 200 });
}

describe("complete map closure cache planning", () => {
  beforeEach(() => {
    localStorage.clear();
    const storage = fakeCaches();
    vi.stubGlobal("caches", storage);
    Object.defineProperty(window, "caches", { configurable: true, value: storage });
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: vi.fn(async () => ({ quota: 1024 * 1024, usage: 0 })),
        persist: vi.fn(async () => true),
        persisted: vi.fn(async () => true),
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/simforge/maps/cache-plan") return inventoryResponse();
      if (url === "/api/simforge/maps/cache-download-urls") {
        const body = JSON.parse(String(init?.body)) as {
          assets: Array<{ mapVersionId: string; relativePath: string }>;
        };
        return new Response(JSON.stringify({
          assets: body.assets.map((asset) => ({
            ...asset,
            url: `https://download.test/${asset.relativePath}`,
          })),
        }), { status: 200 });
      }
      if (url.includes("/api/simforge/sumo-runtime/") && init?.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": "1" } });
      }
      if (url.startsWith("https://download.test/")) {
        const payload = url.endsWith("manifest.json") ? "a"
          : url.endsWith("fine.glb") ? "b"
            : url.endsWith("lazy-far-tile.glb") ? "c"
              : url.endsWith("map.net.xml") ? "d"
                : "a";
        return new Response(payload, { status: 200, headers: { "content-length": "1" } });
      }
      if (url.includes("/api/simforge/sumo-runtime/")) {
        return new Response("r", { status: 200, headers: { "content-length": "1" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(["roads-only", "ultra-low-3d", "minimal", "high"] as const)(
    "enumerates every published member for the %s profile",
    async (profile) => {
      const plan = await createProfileMapPlan([map], profile, new AbortController().signal);
      const urls = plan.maps[0]?.assets.map((asset) => asset.url);

      expect(urls).toEqual([
        "/api/simforge/maps/map-1/browser-assets/3d/manifest.json",
        "/api/simforge/maps/map-1/browser-assets/3d/fine.glb",
        "/api/simforge/maps/map-1/browser-assets/3d/lazy-far-tile.glb",
        "/api/simforge/maps/map-1/browser-assets/3d/manifest-copy.json",
        "/api/simforge/maps/map-1/browser-assets/derived/sumo/map.net.xml",
      ]);
      expect(plan.maps[0]?.closureSha256).toBe(CLOSURE_SHA);
      // Four unique closure blobs plus the three SUMO runtime files.
      expect(plan.remainingAssets).toBe(7);
      expect(plan.remainingBytes).toBe(7);
      expect(plan.assets).toHaveLength(7);
    },
  );

  it("persists completion per map closure and resumes with no pending assets", async () => {
    const controller = new AbortController();
    const plan = await createProfileMapPlan([map], "roads-only", controller.signal);
    const progress = vi.fn();
    const result = await cacheProfileMapPlan(plan, controller.signal, progress);

    expect(result).toEqual({ failedAssets: 0, failureReason: null, completedMapVersionIds: ["map-1"] });
    expect(await hasCacheReceipt(mapCacheReceiptKey("map-1", CLOSURE_SHA))).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      completedAssets: 7,
      completedBytes: 7,
      totalBytes: 7,
    }));

    const resumed = await createProfileMapPlan([map], "high", controller.signal);
    expect(resumed.remainingAssets).toBe(0);
    expect(resumed.remainingBytes).toBe(0);
    expect(resumed.fullyCachedMapVersionIds).toEqual(["map-1"]);
  });

  it("rejects a stale map descriptor instead of persisting the wrong version", async () => {
    const stale = { ...map, browserClosureSha256: "d".repeat(64) };
    await expect(createProfileMapPlan([stale], "high", new AbortController().signal))
      .rejects.toThrow("changed while its cache plan was being prepared");
  });

  it("leaves the SUMO runtime out of a closure that has no SUMO network", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({
      releaseKey: "release-a",
      maps: [{
        mapVersionId: "map-1",
        closureSha256: CLOSURE_SHA,
        assets: inventoryAssets.filter((asset) => !asset.relativePath.startsWith("derived/sumo/")),
      }],
    }), { status: 200 }));
    const plan = await createProfileMapPlan([map], "high", new AbortController().signal);
    expect(plan.assets.map((asset) => asset.mapVersionId)).toEqual(["map-1", "map-1", "map-1"]);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/sumo-runtime/"))).toBe(false);
  });

  it("uses twelve parallel downloads on capable connections", () => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 12,
    });
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { effectiveType: "4g", saveData: false },
    });

    expect(profileMapDownloadConcurrency()).toBe(12);
  });
});
