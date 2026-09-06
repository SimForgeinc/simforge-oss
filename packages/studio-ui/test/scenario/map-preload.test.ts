import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioMapOption } from "../../src/scenario/list/document-map-groups";
import {
  isMapWarmed,
  pickRandomMap,
  preloadMapManifests,
  renderableMaps,
  resetMapPreloadCacheForTests,
} from "../../src/scenario/scene/mapCatalog";

/**
 * The datasets-page map preloader.
 *
 * The properties under test are the ones that make a preload safe to run behind a live scene: it must
 * never reject, never mark a map warmed on a response it did not actually get, and never re-fetch what
 * it already has. Each of those failing is silent — a preloader that throws takes down a working page,
 * and one that mis-marks a transient 503 permanently suppresses the retry.
 */

function map(id: string, overrides: Partial<ScenarioMapOption> = {}): ScenarioMapOption {
  return {
    mapVersionId: id,
    sourceMapId: `${id}-source`,
    label: id.toUpperCase(),
    locality: null,
    thumbnailUrl: null,
    browserManifestUrl: `/api/simforge/maps/${id}/browser-assets/manifest.json`,
    ...overrides,
  };
}

function ok() {
  return { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetMapPreloadCacheForTests();
  fetchMock = vi.fn(() => Promise.resolve(ok()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderableMaps", () => {
  it("drops maps with no manifest url, because there is nothing to mount", () => {
    // A map version with no browser asset set has no renderer entry point. Including it would hand
    // `CityView` an undefined manifest and surface as a broken scene rather than a missing map.
    const maps = [map("a"), map("b", { browserManifestUrl: null }), map("c")];
    expect(renderableMaps(maps).map((entry) => entry.mapVersionId)).toEqual(["a", "c"]);
  });
});

describe("pickRandomMap", () => {
  it("returns null rather than a map that cannot be rendered", () => {
    expect(pickRandomMap([])).toBeNull();
    expect(pickRandomMap([map("a", { browserManifestUrl: null })])).toBeNull();
  });

  it("only ever returns a renderable map", () => {
    const maps = [map("a", { browserManifestUrl: null }), map("b")];
    // Every draw must land on "b" — the unrenderable entry must not be reachable at any random value.
    for (let i = 0; i < 25; i += 1) {
      expect(pickRandomMap(maps)?.mapVersionId).toBe("b");
    }
  });
});

describe("preloadMapManifests", () => {
  it("fetches each renderable manifest exactly once and reports the count", async () => {
    const warmed = await preloadMapManifests([map("a"), map("b")]);
    expect(warmed).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(isMapWarmed("a")).toBe(true);
    expect(isMapWarmed("b")).toBe(true);
  });

  it("skips maps already warmed, so a second pass is not a second download", async () => {
    await preloadMapManifests([map("a")]);
    fetchMock.mockClear();
    const warmed = await preloadMapManifests([map("a"), map("b")]);
    expect(warmed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never requests a map without a manifest url", async () => {
    await preloadMapManifests([map("a", { browserManifestUrl: null })]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a failed status un-warmed so a later pass retries it", async () => {
    // A 503 is transient. Marking it warmed would mean the map is never fetched again for the life of
    // the page, and the user would hit a cold load on the one map that had a hiccup.
    fetchMock.mockResolvedValueOnce({ ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    expect(await preloadMapManifests([map("a")])).toBe(0);
    expect(isMapWarmed("a")).toBe(false);

    fetchMock.mockResolvedValueOnce(ok());
    expect(await preloadMapManifests([map("a")])).toBe(1);
    expect(isMapWarmed("a")).toBe(true);
  });

  it("resolves rather than rejecting when the network throws", async () => {
    // This runs behind a visible scene from an idle callback. An unhandled rejection here would be an
    // error the user cannot act on, about work they did not ask for.
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(preloadMapManifests([map("a"), map("b")])).resolves.toBe(0);
    expect(isMapWarmed("a")).toBe(false);
  });

  it("stops early when aborted instead of draining the whole catalog", async () => {
    const controller = new AbortController();
    let started = 0;
    fetchMock.mockImplementation(() => {
      started += 1;
      // Abort partway so the remaining workers observe it before claiming more work.
      if (started === 1) controller.abort();
      return Promise.resolve(ok());
    });
    const many = Array.from({ length: 12 }, (_, index) => map(`m${index}`));
    await expect(preloadMapManifests(many, { signal: controller.signal })).resolves.toBeTypeOf("number");
    // The concurrency cap is 3, so at most the in-flight batch proceeds — nowhere near all twelve.
    expect(started).toBeLessThanOrEqual(3);
  });

  it("does no work and no fetching when every map is already warmed", async () => {
    await preloadMapManifests([map("a")]);
    fetchMock.mockClear();
    expect(await preloadMapManifests([map("a")])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
