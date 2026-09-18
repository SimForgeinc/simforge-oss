// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchResult } from "@simforge-oss/viewer";
import type { BenchmarkState } from "../../src/scenario/editor/regions/slots/RenderingBenchmark";
import {
  RENDERING_BENCHMARK_CONFIGURATION,
  classifyGpu,
  type RenderingBenchmarkHardware,
  type RenderingBenchmarkResult,
} from "../../src/scenario/editor/regions/slots/rendering-benchmark";
import { RenderDiagnostics, diagnosticChecks } from "../../src/render-selection/RenderSelectionPanel";

vi.mock("@simforge-oss/viewer/react", () => ({
  CityView: () => null,
}));

afterEach(cleanup);

const metrics: BenchResult = {
  avgFps: 55,
  p50FrameMs: 18,
  p95FrameMs: 24.2,
  p99FrameMs: 31.5,
  maxFrameMs: 45,
  minFps: 22.2,
  drawCalls: 320,
  residentBytes: 1_610_612_736,
  frames: 138,
  durationMs: 2500,
  frameTimeCounts: { over16_7: 40, over25: 10, over33_3: 3, over50: 0 },
  orbit: {
    frames: 138,
    durationMs: 2500,
    p50FrameMs: 18,
    p95FrameMs: 24.2,
    p99FrameMs: 31.5,
    maxFrameMs: 45,
    over33_3: 3,
    over50: 0,
  },
  phases: {
    controlsMsAvg: 0.2,
    streamingMsAvg: 1.4,
    uploadsMsAvg: 0.8,
    renderMsAvg: 12.45,
    integrationMsAvg: 0.3,
  },
  capturedAt: "2026-08-05T00:00:00.000Z",
  renderingSuspended: false,
  displayFps: 55,
  uiFrameP95Ms: 24.2,
  simulationTicksPerSecond: null,
  cpuUtilizationProxy: 68,
  ultraLowFidelity: false,
  roadsOnlyFidelity: false,
};

const hardware: RenderingBenchmarkHardware = {
  browser: "Chrome 140.0",
  operatingSystem: "macOS",
  userAgent: "test-agent",
  language: "en-US",
  logicalProcessors: 12,
  deviceMemoryGB: 8,
  display: { width: 2560, height: 1440, pixelRatio: 2, colorDepth: 24 },
  renderer: { renderer: "Apple M3", vendor: "Apple", webgl2: true, software: false },
  hardwareAccelerated: true,
  gpuClass: "apple",
};

const coverage = { wantedTiles: 96, missingTiles: 0, budgetBlockedTiles: 0, failedTiles: 0 };

function result(quality: RenderingBenchmarkResult["quality"], missingTiles = 0): RenderingBenchmarkResult {
  const city = quality === "roads-only" ? null : { ...coverage, missingTiles, budgetBlockedTiles: missingTiles };
  return {
    quality,
    metrics,
    assetLoading: { settleMs: 2300, streamingSettled: true, requestCount: 14, transferBytes: 25 * 1024 * 1024, encodedBodyBytes: 24 * 1024 * 1024, decodedBodyBytes: 30 * 1024 * 1024, cachedResponses: 5 },
    coverage: {
      settled: { roads: coverage, city, vegetation: null },
      orbit: { roads: coverage, city, vegetation: null },
    },
  };
}

const noop = {
  onStart: vi.fn(), onCancel: vi.fn(), onApply: vi.fn(),
  qualities: ["roads-only", "ultra-low-3d", "minimal", "high"] as const,
  availability: { checking: false, unavailable: {} },
};

describe("RenderDiagnostics", () => {
  it("is one button until started, with the body collapsed", () => {
    render(
      <RenderDiagnostics
        state={{ phase: "idle", snapshot: null }}
        currentQuality="minimal"
        mapLabel="Yale Street"
        {...noop}
      />,
    );
    const start = screen.getByRole("button", { name: "Start benchmark on Yale Street" });
    expect(start.textContent).toContain("Start Benchmark");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("rendering-benchmark").getAttribute("data-phase")).toBe("idle");
  });

  it("shows live per-profile progress in place, never in an overlay", () => {
    const state: BenchmarkState = {
      phase: "measuring",
      candidateIndex: 2,
      results: [result("roads-only"), result("ultra-low-3d")],
      failures: [],
      hardware,
      startedAt: Date.now() - 2_000,
    };
    render(
      <RenderDiagnostics state={state} currentQuality="high" mapLabel="Yale Street" {...noop} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Testing Balanced");
    expect(status.textContent).toContain("2 of 4 complete");
    expect(screen.getByTestId("benchmark-lane-roads-only").textContent).toContain("55");
    expect(screen.getByTestId("benchmark-lane-minimal").textContent).toContain("Orbiting camera");
    expect(screen.getByTestId("benchmark-lane-high").textContent).toContain("Queued");
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeTruthy();
  });

  it("surfaces every failure when nothing could be measured", () => {
    render(
      <RenderDiagnostics
        state={{
          phase: "error",
          message: "None of the renderers could be measured.",
          results: [],
          failures: [
            { quality: "roads-only", message: "Map streaming did not settle" },
            { quality: "high", message: "WebGL context unavailable" },
          ],
          hardware,
          startedAt: Date.now() - 30_000,
        }}
        currentQuality="minimal"
        mapLabel="Yale Street"
        {...noop}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Roads Only: Map streaming did not settle");
    expect(alert.textContent).toContain("High: WebGL context unavailable");
  });

  it("reports the verdict inline and applies either the recommendation or a manual choice", async () => {
    const onApply = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const state: BenchmarkState = {
      phase: "complete",
      snapshot: {
        manifestUrl: "https://assets.example/manifest.json",
        recommended: "minimal",
        results: [result("minimal")],
        failures: [{ quality: "high", message: "WebGL context unavailable" }],
        hardware,
        configuration: RENDERING_BENCHMARK_CONFIGURATION,
        capturedAt: "2026-08-05T00:00:00.000Z",
      },
    };
    render(
      <RenderDiagnostics state={state} currentQuality="high" mapLabel="Yale Street" {...noop} onApply={onApply} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Best match: Balanced")).toBeTruthy();
    expect(screen.getByTestId("benchmark-lane-minimal").textContent).toContain("96 tiles complete");
    expect(screen.getByTestId("benchmark-lane-high").textContent).toContain("Unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Copy developer report" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const report = JSON.parse(writeText.mock.calls[0]![0] as string);
    expect(report.hardware.renderer.renderer).toBe("Apple M3");
    expect(report.results[0].coverage.settled.city.wantedTiles).toBe(96);
    fireEvent.click(screen.getByRole("button", { name: "Use recommended Balanced" }));
    expect(onApply).toHaveBeenCalledWith("minimal");
  });
});

describe("diagnosticChecks", () => {
  it("passes a hardware GPU with every building tile resident and an interactive profile", () => {
    const checks = diagnosticChecks({
      hardware,
      results: [result("ultra-low-3d"), result("minimal")],
      failures: [],
      recommended: "minimal",
      running: false,
    });
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ["gpu", "pass"],
      ["buildings", "pass"],
      ["smoothness", "pass"],
    ]);
    expect(checks[0]!.title).toContain("Apple M3");
    expect(checks[1]!.detail).toContain("96 city tiles");
  });

  it("fails the GPU check when the browser rasterizes on the CPU", () => {
    const software = {
      ...hardware,
      renderer: { renderer: "Google SwiftShader", vendor: "Google Inc.", webgl2: true, software: true },
      hardwareAccelerated: false,
      gpuClass: "software" as const,
    };
    const [gpu] = diagnosticChecks({ hardware: software, results: [], failures: [], recommended: null, running: true });
    expect(gpu!.status).toBe("fail");
    expect(gpu!.title).toContain("CPU");
  });

  it("warns about an integrated adapter that may be shadowing a discrete one", () => {
    const integrated = {
      ...hardware,
      renderer: { renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", vendor: "Google Inc. (Intel)", webgl2: true, software: false },
      gpuClass: classifyGpu({ renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", vendor: "Google Inc. (Intel)", webgl2: true, software: false }),
    };
    const [gpu] = diagnosticChecks({ hardware: integrated, results: [], failures: [], recommended: null, running: true });
    expect(integrated.gpuClass).toBe("integrated");
    expect(gpu!.status).toBe("warn");
    expect(gpu!.detail).toContain("high performance");
  });

  it("flags missing buildings with the reason and keeps that profile off the recommendation", () => {
    const checks = diagnosticChecks({
      hardware,
      results: [result("ultra-low-3d"), result("minimal", 5)],
      failures: [],
      recommended: "ultra-low-3d",
      running: false,
    });
    const buildings = checks.find((check) => check.id === "buildings")!;
    expect(buildings.status).toBe("warn");
    expect(buildings.title).toContain("Balanced");
    expect(buildings.detail).toContain("5 of 96 missing (5 over the memory budget)");
  });
});

describe("classifyGpu", () => {
  it("separates discrete, integrated, Apple and software adapters", () => {
    const capability = (renderer: string, software = false) => ({ renderer, vendor: "", webgl2: true, software });
    expect(classifyGpu(capability("NVIDIA GeForce RTX 4070/PCIe/SSE2"))).toBe("discrete");
    expect(classifyGpu(capability("AMD Radeon RX 7800 XT"))).toBe("discrete");
    expect(classifyGpu(capability("AMD Radeon(TM) Graphics"))).toBe("integrated");
    expect(classifyGpu(capability("Intel(R) UHD Graphics 630"))).toBe("integrated");
    expect(classifyGpu(capability("Apple M3 Pro"))).toBe("apple");
    expect(classifyGpu(capability("Google SwiftShader", true))).toBe("software");
    expect(classifyGpu(null)).toBe("unknown");
  });
});
