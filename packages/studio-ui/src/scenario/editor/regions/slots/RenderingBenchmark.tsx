"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CityView } from "@simforge-oss/viewer/react";
import type { CityViewer } from "@simforge-oss/viewer";
import {
  type ScenarioAuthoringQuality,
} from "../../../../lib/scenario/contracts";
import { AUTHORING_QUALITY } from "../../authoring-quality";
import {
  captureRenderingBenchmarkHardware,
  loadRenderingBenchmark,
  recommendRenderingPreference,
  renderingBenchmarkAssetBase,
  RENDERING_BENCHMARK_CONFIGURATION,
  renderingBenchmarkKey,
  saveRenderingBenchmark,
  waitForViewerSettled,
  type RenderingBenchmarkFailure,
  type RenderingBenchmarkHardware,
  type RenderingBenchmarkResult,
  type RenderingBenchmarkSnapshot,
} from "./rendering-benchmark";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./RenderingBenchmark.stylex";

export type BenchmarkState =
  | { phase: "idle"; snapshot: RenderingBenchmarkSnapshot | null }
  | {
      phase: "loading" | "measuring";
      candidateIndex: number;
      results: RenderingBenchmarkResult[];
      failures: RenderingBenchmarkFailure[];
      hardware: RenderingBenchmarkHardware;
      startedAt: number;
    }
  | { phase: "complete"; snapshot: RenderingBenchmarkSnapshot }
  | {
      phase: "error";
      message: string;
      results: RenderingBenchmarkResult[];
      failures: RenderingBenchmarkFailure[];
      hardware: RenderingBenchmarkHardware;
      startedAt: number;
    };

type Running = Extract<BenchmarkState, { phase: "loading" | "measuring" }>;

/**
 * Runs every quality profile in turn on a hidden viewer, persists the
 * snapshot, and hands the caller a `runner` element to mount alongside its
 * own UI. The UI never leaves the page: progress is data, not an overlay.
 */
export function useRenderingBenchmark(manifestUrl: string, qualities: readonly ScenarioAuthoringQuality[]) {
  const [state, setState] = useState<BenchmarkState>(() => ({
    phase: "idle",
    snapshot: loadRenderingBenchmark(manifestUrl),
  }));
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    setState({ phase: "idle", snapshot: loadRenderingBenchmark(manifestUrl) });
  }, [manifestUrl]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setState({
      phase: "loading",
      candidateIndex: 0,
      results: [],
      failures: [],
      hardware: captureRenderingBenchmarkHardware(),
      startedAt: Date.now(),
    });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ phase: "idle", snapshot: loadRenderingBenchmark(manifestUrl) });
  }, [manifestUrl]);

  const active = state.phase === "loading" || state.phase === "measuring";
  const quality = active
    ? qualities[state.candidateIndex]!
    : null;

  /** Advance to the next profile, or close out the run with a snapshot. */
  const advance = useCallback(
    (
      current: Running,
      results: RenderingBenchmarkResult[],
      failures: RenderingBenchmarkFailure[],
      emptyMessage: string,
    ): BenchmarkState => {
      const nextIndex = current.candidateIndex + 1;
      if (nextIndex < qualities.length) {
        return {
          phase: "loading",
          candidateIndex: nextIndex,
          results,
          failures,
          hardware: current.hardware,
          startedAt: current.startedAt,
        };
      }
      const recommended = recommendRenderingPreference(results);
      if (!recommended) {
        return {
          phase: "error",
          message: emptyMessage,
          results,
          failures,
          hardware: current.hardware,
          startedAt: current.startedAt,
        };
      }
      const snapshot: RenderingBenchmarkSnapshot = {
        manifestUrl: renderingBenchmarkKey(manifestUrl),
        recommended,
        results,
        failures,
        hardware: current.hardware,
        configuration: RENDERING_BENCHMARK_CONFIGURATION,
        capturedAt: new Date().toISOString(),
      };
      saveRenderingBenchmark(snapshot);
      return { phase: "complete", snapshot };
    },
    [manifestUrl, qualities],
  );

  const finishCandidate = useCallback(
    (result: RenderingBenchmarkResult) => {
      setState((current) =>
        current.phase === "measuring"
          ? advance(current, [...current.results, result], current.failures, "No renderer completed.")
          : current,
      );
    },
    [advance],
  );

  const failCandidate = useCallback(
    (reason: unknown) => {
      if ((reason as { name?: string } | null)?.name === "AbortError") return;
      setState((current) => {
        if (current.phase !== "loading" && current.phase !== "measuring") return current;
        const failure = {
          quality: qualities[current.candidateIndex]!,
          message: reason instanceof Error ? reason.message : String(reason),
        };
        return advance(
          current,
          current.results,
          [...current.failures, failure],
          "None of the renderers could be measured.",
        );
      });
    },
    [advance, qualities],
  );

  const runner = quality ? (
    <BenchmarkCanvas
      key={quality}
      manifestUrl={manifestUrl}
      quality={quality}
      signal={abortRef.current?.signal}
      onMeasuring={() =>
        setState((current) =>
          current.phase === "loading" ? { ...current, phase: "measuring" } : current,
        )
      }
      onHardware={(hardware) =>
        setState((current) =>
          current.phase === "loading" || current.phase === "measuring"
            ? { ...current, hardware }
            : current,
        )
      }
      onComplete={finishCandidate}
      onError={failCandidate}
    />
  ) : null;

  return { state, start, cancel, runner };
}

function BenchmarkCanvas({
  manifestUrl,
  quality,
  signal,
  onMeasuring,
  onHardware,
  onComplete,
  onError,
}: {
  manifestUrl: string;
  quality: ScenarioAuthoringQuality;
  signal?: AbortSignal;
  onMeasuring: () => void;
  onHardware: (hardware: RenderingBenchmarkHardware) => void;
  onComplete: (result: RenderingBenchmarkResult) => void;
  onError: (reason: unknown) => void;
}) {
  const viewerRef = useRef<CityViewer | null>(null);
  const loadStartedAt = useRef(performance.now());
  const preset = AUTHORING_QUALITY[quality];

  const run = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      const streamingSettled = await waitForViewerSettled(viewer, {
        signal,
        allowUsableOnTimeout: true,
      });
      if (signal?.aborted) return;
      const settledAt = performance.now();
      const settledCoverage = viewer.getStats().coverage;
      const assetBase = renderingBenchmarkAssetBase(manifestUrl);
      const resources = (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      ).filter(
        (entry) =>
          entry.startTime >= loadStartedAt.current &&
          entry.name.startsWith(assetBase),
      );
      onMeasuring();
      const metrics = await viewer.runBenchmark(
        RENDERING_BENCHMARK_CONFIGURATION.sampleDurationMs,
      );
      if (signal?.aborted) return;
      onComplete({
        quality,
        metrics,
        assetLoading: {
          settleMs: settledAt - loadStartedAt.current,
          streamingSettled,
          requestCount: resources.length,
          transferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
          encodedBodyBytes: resources.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
          decodedBodyBytes: resources.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
          cachedResponses: resources.filter(
            (entry) => entry.transferSize === 0 && entry.decodedBodySize > 0,
          ).length,
        },
        coverage: { settled: settledCoverage, orbit: viewer.getStats().coverage },
      });
    } catch (reason) {
      onError(reason);
    }
  }, [manifestUrl, onComplete, onError, onMeasuring, quality, signal]);

  return (
    <div
      aria-hidden="true"
      {...stylex.props(styles.hiddenViewport)}
      data-testid="rendering-benchmark-canvas"
    >
      <CityView
        manifestUrl={manifestUrl}
        initialOptions={{
          maxPixelRatio: preset.maxPixelRatio,
          antialias: preset.antialias,
          vegetationMaxDistance: preset.live.vegetationMaxDistance,
          byteBudget: preset.live.byteBudget,
          maxScreenSpaceError: preset.live.maxScreenSpaceError,
          vegetationScreenSpaceError: preset.live.vegetationScreenSpaceError,
          uploadBudgetMs: preset.live.uploadBudgetMs,
          uploadPixelsPerFrame: preset.live.uploadPixelsPerFrame,
          exposure: preset.live.exposure,
        }}
        onReady={(viewer) => {
          viewerRef.current = viewer;
          onHardware(captureRenderingBenchmarkHardware(viewer));
        }}
        onDisposed={(disposed) => {
          if (viewerRef.current === disposed) viewerRef.current = null;
        }}
        onMapLoaded={() => void run()}
        onError={onError}
      />
    </div>
  );
}
