import { describe, expect, it, vi } from "vitest";
import type { BenchResult, CityViewer } from "@simforge-oss/viewer";
import {
  loadRenderingBenchmark,
  recommendRenderingPreference,
  renderingBenchmarkAssetBase,
  RENDERING_BENCHMARK_CONFIGURATION,
  saveRenderingBenchmark,
  waitForViewerSettled,
  type RenderingBenchmarkResult,
  type RenderingBenchmarkSnapshot,
} from "../../src/scenario/editor/regions/slots/rendering-benchmark";

describe("renderingBenchmarkAssetBase", () => {
  it("resolves production-relative manifest routes against the current page", () => {
    expect(
      renderingBenchmarkAssetBase(
        "/api/simforge/maps/usmv_1/browser-assets/3d/manifest.json",
        "https://simforge.ai/dashboard/scenario",
      ),
    ).toBe("https://simforge.ai/api/simforge/maps/usmv_1/browser-assets/3d/");
  });

  it("preserves absolute manifest origins", () => {
    expect(
      renderingBenchmarkAssetBase(
        "https://assets.example.com/maps/3d/manifest.json",
        "https://simforge.ai/dashboard/scenario",
      ),
    ).toBe("https://assets.example.com/maps/3d/");
  });
});

const hardware = {
  browser: "Chrome 140.0",
  operatingSystem: "macOS",
  userAgent: "test-agent",
  language: "en-US",
  logicalProcessors: 12,
  deviceMemoryGB: 8,
  display: { width: 2560, height: 1440, pixelRatio: 2, colorDepth: 24 },
  renderer: {
    renderer: "Apple M3",
    vendor: "Apple",
    webgl2: true,
    software: false,
  },
  hardwareAccelerated: true,
  gpuClass: "apple" as const,
};

const fullCoverage = { wantedTiles: 120, missingTiles: 0, budgetBlockedTiles: 0, failedTiles: 0 };

function metrics(avgFps: number, p95FrameMs: number): BenchResult {
  return {
    avgFps,
    p50FrameMs: 16,
    p95FrameMs,
    p99FrameMs: p95FrameMs,
    maxFrameMs: p95FrameMs,
    minFps: 1000 / p95FrameMs,
    drawCalls: 100,
    residentBytes: 10,
    frames: 100,
    durationMs: 2500,
    frameTimeCounts: { over16_7: 0, over25: 0, over33_3: 0, over50: 0 },
    orbit: {
      frames: 100,
      durationMs: 2500,
      p50FrameMs: 16,
      p95FrameMs,
      p99FrameMs: p95FrameMs,
      maxFrameMs: p95FrameMs,
      over33_3: p95FrameMs > 33.3 ? 10 : 0,
      over50: p95FrameMs > 50 ? 10 : 0,
    },
    phases: {
      controlsMsAvg: 0,
      streamingMsAvg: 0,
      uploadsMsAvg: 0,
      renderMsAvg: 10,
      integrationMsAvg: 0,
    },
    capturedAt: "2026-08-05T00:00:00.000Z",
    renderingSuspended: false,
    displayFps: avgFps,
    uiFrameP95Ms: p95FrameMs,
    simulationTicksPerSecond: null,
    cpuUtilizationProxy: 50,
  };
}

function result(
  quality: RenderingBenchmarkResult["quality"],
  avgFps: number,
  p95FrameMs: number,
  missingTiles = 0,
): RenderingBenchmarkResult {
  const city = { ...fullCoverage, missingTiles, budgetBlockedTiles: missingTiles };
  return {
    quality,
    metrics: metrics(avgFps, p95FrameMs),
    assetLoading: { settleMs: 1000, streamingSettled: true, requestCount: 2, transferBytes: 100, encodedBodyBytes: 90, decodedBodyBytes: 120, cachedResponses: 0 },
    coverage: {
      settled: { roads: fullCoverage, city, vegetation: null },
      orbit: { roads: fullCoverage, city, vegetation: null },
    },
  };
}

describe("rendering benchmark recommendation", () => {
  it("chooses the highest-fidelity renderer that clears the interactive floor", () => {
    expect(
      recommendRenderingPreference([
        result("low", 55, 24),
        result("medium", 30, 42),
      ]),
    ).toBe("low");
  });

  it("chooses high when every renderer performs well", () => {
    expect(
      recommendRenderingPreference([
        result("low", 60, 19),
        result("medium", 58, 22),
      ]),
    ).toBe("medium");
  });

  it("falls back to the most stable measured renderer when none clear the floor", () => {
    expect(
      recommendRenderingPreference([
        result("low", 25, 52),
        result("medium", 18, 70),
      ]),
    ).toBe("low");
  });

  it("rejects a renderer whose average looks healthy but orbiting stutters", () => {
    const high = result("medium", 56, 24);
    high.metrics.orbit.p95FrameMs = 41;
    high.metrics.orbit.p99FrameMs = 72;
    expect(
      recommendRenderingPreference([
        result("low", 52, 25),
        high,
      ]),
    ).toBe("low");
  });

  it("refuses a fast renderer that leaves building tiles missing", () => {
    expect(
      recommendRenderingPreference([
        result("low", 52, 25),
        result("medium", 58, 22, 7),
      ]),
    ).toBe("low");
  });

  it("prefers complete coverage over a marginally smoother incomplete renderer when none clear the floor", () => {
    expect(
      recommendRenderingPreference([
        result("medium", 30, 40),
        result("low", 31, 38, 3),
      ]),
    ).toBe("medium");
  });
});

describe("rendering benchmark persistence", () => {
  it("restores results only for the map bundle that was measured", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const snapshot: RenderingBenchmarkSnapshot = {
      manifestUrl: "assets.example/map-a/manifest.json",
      recommended: "low",
      results: [result("low", 55, 24)],
      failures: [],
      hardware,
      configuration: RENDERING_BENCHMARK_CONFIGURATION,
      capturedAt: "2026-08-05T00:00:00.000Z",
    };

    saveRenderingBenchmark(snapshot, storage);

    expect(
      loadRenderingBenchmark("https://assets.example/map-a/manifest.json", storage),
    ).toEqual(snapshot);
    expect(loadRenderingBenchmark("https://assets.example/map-b/manifest.json", storage)).toBeNull();
  });

  it("reuses results when only an expiring manifest signature changes", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const snapshot: RenderingBenchmarkSnapshot = {
      manifestUrl: "assets.example/map-a/manifest.json",
      recommended: "low",
      results: [result("low", 55, 24)],
      failures: [],
      hardware,
      configuration: RENDERING_BENCHMARK_CONFIGURATION,
      capturedAt: "2026-08-05T00:00:00.000Z",
    };
    saveRenderingBenchmark(snapshot, storage);

    expect(
      loadRenderingBenchmark(
        "https://assets.example/map-a/manifest.json?signature=new",
        storage,
      ),
    ).toEqual(snapshot);
  });
});

describe("waitForViewerSettled", () => {
  it("waits until streaming work stays drained", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const viewer = {
      getStats: () => ({
        loading: calls++ < 2 ? 1 : 0,
        queued: 0,
        uploading: 0,
        streamingError: null,
      }),
    } as unknown as CityViewer;

    const pending = waitForViewerSettled(viewer, { stableMs: 200, timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(700);
    await expect(pending).resolves.toBe(true);
    vi.useRealTimers();
  });

  it("rejects instead of benchmarking a scene that is still streaming", async () => {
    vi.useFakeTimers();
    const viewer = {
      getStats: () => ({
        loading: 1,
        queued: 2,
        uploading: 0,
        streamingError: null,
      }),
    } as unknown as CityViewer;

    const pending = waitForViewerSettled(viewer, { stableMs: 100, timeoutMs: 300 });
    const expectation = expect(pending).rejects.toThrow("did not settle");
    await vi.advanceTimersByTimeAsync(500);
    await expectation;
    vi.useRealTimers();
  });

  it("measures a usable scene after the load window while background streaming continues", async () => {
    vi.useFakeTimers();
    const viewer = {
      getStats: () => ({
        loading: 1,
        queued: 2,
        uploading: 0,
        roadVisible: true,
        streamingError: null,
      }),
    } as unknown as CityViewer;

    const pending = waitForViewerSettled(viewer, {
      stableMs: 100,
      timeoutMs: 300,
      allowUsableOnTimeout: true,
    });
    const expectation = expect(pending).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await expectation;
    vi.useRealTimers();
  });
});
