// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RenderingBenchmarkSection,
  type BenchmarkState,
} from "../../src/scenario/editor/regions/slots/RenderingBenchmark";
import type { BenchResult } from "@simforge-oss/viewer";
import { RENDERING_BENCHMARK_CONFIGURATION } from "../../src/scenario/editor/regions/slots/rendering-benchmark";

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
};

describe("RenderingBenchmarkSection", () => {
  it("leads with one prominent benchmark action", () => {
    render(
      <RenderingBenchmarkSection
        state={{ phase: "idle", snapshot: null }}
        currentQuality="minimal"
        mapLabel="Yale Street"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Start benchmark on Yale Street" }).textContent).toContain("Start Benchmark");
  });

  it("shows background progress for the current bundle", () => {
    const state: BenchmarkState = {
      phase: "measuring",
      candidateIndex: 2,
      results: [],
      failures: [],
      hardware,
      startedAt: Date.now() - 2_000,
    };
    render(
      <RenderingBenchmarkSection
        state={state}
        currentQuality="high"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Testing orbit smoothness");
    expect(screen.getByRole("status").textContent).toContain("Balanced");
    expect(screen.getByRole("status").textContent).toContain("0 of 4 complete");
    const content = screen.getByTestId("benchmark-progress-content");
    expect(content.getAttribute("data-visual-treatment")).toBe("flat");
    expect(content.className).not.toContain("bg-[");
    expect(content.className).not.toContain("shadow-");
    expect(content.className).not.toContain("ring-");
    expect(content.className).not.toContain("backdrop-");
  });

  it("shows the renderer failure details when every candidate fails", () => {
    render(
      <RenderingBenchmarkSection
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
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Roads Only: Map streaming did not settle",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "High: WebGL context unavailable",
    );
  });

  it("reports results and allows either the recommendation or a manual renderer", async () => {
    const onApply = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const state: BenchmarkState = {
      phase: "complete",
      snapshot: {
        manifestUrl: "https://assets.example/manifest.json",
        recommended: "minimal",
        results: [{
          quality: "minimal",
          metrics,
          assetLoading: { settleMs: 2300, streamingSettled: true, requestCount: 14, transferBytes: 25 * 1024 * 1024, encodedBodyBytes: 24 * 1024 * 1024, decodedBodyBytes: 30 * 1024 * 1024, cachedResponses: 5 },
        }],
        failures: [{ quality: "high", message: "WebGL context unavailable" }],
        hardware,
        configuration: RENDERING_BENCHMARK_CONFIGURATION,
        capturedAt: "2026-08-05T00:00:00.000Z",
      },
    };
    render(
      <RenderingBenchmarkSection
        state={state}
        currentQuality="high"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onApply={onApply}
      />,
    );
    expect(screen.getByText("55.0 FPS")).toBeTruthy();
    expect(screen.getByText("Orbit p95")).toBeTruthy();
    expect(screen.getByText("Orbit stalls")).toBeTruthy();
    expect(screen.getByText("31.5 ms")).toBeTruthy();
    expect(screen.getByText("320")).toBeTruthy();
    expect(screen.getByText("1.50 GB")).toBeTruthy();
    expect(screen.getByText("68%")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Your best match");
    fireEvent.click(screen.getByRole("button", { name: "Copy developer report" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const report = JSON.parse(writeText.mock.calls[0]![0] as string);
    expect(report.hardware.renderer.renderer).toBe("Apple M3");
    expect(report.configuration.viewportWidth).toBe(1280);
    fireEvent.click(screen.getByRole("button", { name: "Use recommended Balanced" }));
    expect(onApply).toHaveBeenCalledWith("minimal");
    fireEvent.click(screen.getByRole("button", { name: "Use Roads Only" }));
    expect(onApply).toHaveBeenLastCalledWith("roads-only");
    expect(screen.getByText("Manual selection")).toBeTruthy();
  });
});
