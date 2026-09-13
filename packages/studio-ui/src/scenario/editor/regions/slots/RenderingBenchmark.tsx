"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Clipboard,
  Gauge,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { CityView } from "@simforge-oss/viewer/react";
import type { CityViewer } from "@simforge-oss/viewer";
import {
  SCENARIO_AUTHORING_QUALITY_CHOICES,
  SCENARIO_AUTHORING_QUALITY_IDS,
  type ScenarioAuthoringQuality,
} from "../../../../lib/scenario/contracts";
import { Button } from "../../../../components/ui/button";
import { SkyCloudBackdrop } from "../../../../components/SkyCloudBackdrop";
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

export function useRenderingBenchmark(manifestUrl: string) {
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
  const candidateIndex = active ? state.candidateIndex : null;
  const quality =
    candidateIndex === null
      ? null
      : SCENARIO_AUTHORING_QUALITY_IDS[candidateIndex];

  const finishCandidate = useCallback(
    (result: RenderingBenchmarkResult) => {
      setState((current) => {
        if (current.phase !== "measuring") return current;
        const results = [...current.results, result];
        const nextIndex = current.candidateIndex + 1;
        if (nextIndex < SCENARIO_AUTHORING_QUALITY_IDS.length) {
          return {
            phase: "loading",
            candidateIndex: nextIndex,
            results,
            failures: current.failures,
            hardware: current.hardware,
            startedAt: current.startedAt,
          };
        }
        const recommended = recommendRenderingPreference(results);
        if (!recommended) {
          return {
            phase: "error",
            message: "No renderer completed.",
            results,
            failures: current.failures,
            hardware: current.hardware,
            startedAt: current.startedAt,
          };
        }
        const snapshot: RenderingBenchmarkSnapshot = {
          manifestUrl: renderingBenchmarkKey(manifestUrl),
          recommended,
          results,
          failures: current.failures,
          hardware: current.hardware,
          configuration: RENDERING_BENCHMARK_CONFIGURATION,
          capturedAt: new Date().toISOString(),
        };
        saveRenderingBenchmark(snapshot);
        return { phase: "complete", snapshot };
      });
    },
    [manifestUrl],
  );

  const failCandidate = useCallback(
    (reason: unknown) => {
      if ((reason as { name?: string } | null)?.name === "AbortError") return;
      setState((current) => {
        if (current.phase !== "loading" && current.phase !== "measuring")
          return current;
        const message =
          reason instanceof Error ? reason.message : String(reason);
        const failures = [
          ...current.failures,
          {
            quality: SCENARIO_AUTHORING_QUALITY_IDS[current.candidateIndex]!,
            message,
          },
        ];
        const nextIndex = current.candidateIndex + 1;
        if (nextIndex < SCENARIO_AUTHORING_QUALITY_IDS.length) {
          return {
            phase: "loading",
            candidateIndex: nextIndex,
            results: current.results,
            failures,
            hardware: current.hardware,
            startedAt: current.startedAt,
          };
        }
        const recommended = recommendRenderingPreference(current.results);
        if (!recommended) {
          return {
            phase: "error",
            message: "None of the renderers could be measured.",
            results: current.results,
            failures,
            hardware: current.hardware,
            startedAt: current.startedAt,
          };
        }
        const snapshot: RenderingBenchmarkSnapshot = {
          manifestUrl: renderingBenchmarkKey(manifestUrl),
          recommended,
          results: current.results,
          failures,
          hardware: current.hardware,
          configuration: RENDERING_BENCHMARK_CONFIGURATION,
          capturedAt: new Date().toISOString(),
        };
        saveRenderingBenchmark(snapshot);
        return { phase: "complete", snapshot };
      });
    },
    [manifestUrl],
  );

  const runner = quality ? (
    <BenchmarkCanvas
      key={quality}
      manifestUrl={manifestUrl}
      quality={quality}
      signal={abortRef.current?.signal}
      onMeasuring={() =>
        setState((current) =>
          current.phase === "loading"
            ? { ...current, phase: "measuring" }
            : current,
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

export function RenderingBenchmarkCard({
  manifestUrl,
  mapLabel,
  currentQuality,
  onApply,
}: {
  manifestUrl: string;
  mapLabel: string;
  currentQuality: ScenarioAuthoringQuality;
  onApply: (quality: ScenarioAuthoringQuality) => void;
}) {
  const benchmark = useRenderingBenchmark(manifestUrl);
  return (
    <div {...stylex.props(styles.wideCenteredXLeftText)}>
      <RenderingBenchmarkSection
        state={benchmark.state}
        currentQuality={currentQuality}
        mapLabel={mapLabel}
        onStart={benchmark.start}
        onCancel={benchmark.cancel}
        onApply={onApply}
      />
      {benchmark.runner}
    </div>
  );
}

export function RenderingBenchmarkSection({
  state,
  currentQuality,
  mapLabel = "Current map",
  onStart,
  onCancel,
  onApply,
}: {
  state: BenchmarkState;
  currentQuality: ScenarioAuthoringQuality;
  mapLabel?: string;
  onStart: () => void;
  onCancel: () => void;
  onApply: (quality: ScenarioAuthoringQuality) => void;
}) {
  const [copied, setCopied] = useState(false);
  const snapshot =
    state.phase === "complete" || state.phase === "idle"
      ? state.snapshot
      : null;
  const active = state.phase === "loading" || state.phase === "measuring";
  const results =
    snapshot?.results ?? ("results" in state ? state.results : []);
  const failures =
    snapshot?.failures ?? ("failures" in state ? state.failures : []);
  const startedAt = "startedAt" in state ? state.startedAt : null;
  const elapsedSeconds = useElapsedSeconds(active, startedAt);
  const completedCount = results.length + failures.length;
  const candidate = active
    ? choiceLabel(SCENARIO_AUTHORING_QUALITY_IDS[state.candidateIndex]!)
    : null;

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  return (
    <div data-testid="rendering-benchmark">
      <button
        type="button"
        onClick={onStart}
        className={`${stylex.props(styles.relClipWide).className} group`}
        aria-label={
          snapshot ? "Run benchmark again" : `Start benchmark on ${mapLabel}`
        }
      >
        <span {...stylex.props(styles.relFlexCenter)}>
          <span className={`${stylex.props(styles.gridCenteredTight).className} group-hover:scale-105`}>
            <Gauge className={stylex.props(styles.size9).className} aria-hidden="true" />
          </span>
          <span {...stylex.props(styles.fillNarrowable)}>
            <span {...stylex.props(styles.blockCapsMeta)}>
              Benchmark
            </span>
            <span {...stylex.props(styles.blockXlWhite)}>
              {snapshot ? "Run Benchmark Again" : "Start Benchmark"}
            </span>
            <span {...stylex.props(styles.blockXsTruncate)}>
              {mapLabel}
            </span>
          </span>
          <ArrowRight
            className={`${stylex.props(styles.tight).className} group-hover:translate-x-1`}
            aria-hidden="true"
          />
        </span>
      </button>

      {snapshot ? (
        <p {...stylex.props(styles.microMutedCenterText)}>
          Last result:{" "}
          <span {...stylex.props(styles.inkSemibold)}>
            {choiceLabel(snapshot.recommended)}
          </span>
        </p>
      ) : null}

      {state.phase === "error" ? (
        <div
          {...stylex.props(styles.flexBetweenStart)}
          role="alert"
        >
          <span {...stylex.props(styles.dangerNarrowable)}>
            <span {...stylex.props(styles.block)}>Benchmark stopped: {state.message}</span>
            {state.failures.length > 0 ? (
              <span {...stylex.props(styles.block2)}>
                {state.failures
                  .map(
                    (failure) =>
                      `${choiceLabel(failure.quality)}: ${failure.message}`,
                  )
                  .join(" · ")}
              </span>
            ) : null}
          </span>
          <Button size="sm" variant="outline" onClick={onStart}>
            Try again
          </Button>
        </div>
      ) : null}

      {active ? (
        <BenchmarkProgressOverlay
          state={state}
          results={results}
          failures={failures}
          elapsedSeconds={elapsedSeconds}
          candidate={candidate ?? "Renderer"}
          completedCount={completedCount}
          onCancel={onCancel}
        />
      ) : null}

      {state.phase === "complete" ? (
        <BenchmarkResultOverlay
          snapshot={state.snapshot}
          currentQuality={currentQuality}
          copied={copied}
          onCopy={() => {
            if (!navigator.clipboard) return;
            void navigator.clipboard
              .writeText(JSON.stringify(state.snapshot, null, 2))
              .then(() => setCopied(true));
          }}
          onApply={onApply}
          onRestart={onStart}
        />
      ) : null}
    </div>
  );
}

function BenchmarkProgressOverlay({
  state,
  results,
  failures,
  elapsedSeconds,
  candidate,
  completedCount,
  onCancel,
}: {
  state: Extract<BenchmarkState, { phase: "loading" | "measuring" }>;
  results: RenderingBenchmarkResult[];
  failures: RenderingBenchmarkFailure[];
  elapsedSeconds: number;
  candidate: string;
  completedCount: number;
  onCancel: () => void;
}) {
  return (
    <div
      {...stylex.props(styles.fixedGridCentered)}
      role="status"
      aria-live="polite"
    >
      <SkyCloudBackdrop xstyle={styles.fixed} />
      <Button
        xstyle={styles.absRoundRaised}
        size="sm"
        variant="ghost"
        onClick={onCancel}
      >
        <X className={stylex.props(styles.size4).className} aria-hidden="true" /> Cancel
      </Button>

      <div
        {...stylex.props(styles.relWideRaised)}
        data-testid="benchmark-progress-content"
        data-visual-treatment="flat"
      >
        <div {...stylex.props(styles.relGridCentered)}>
          <div className={`${stylex.props(styles.absBorderedRound).className} animate-spin rounded-full`} />
          <div className={`${stylex.props(styles.absBorderedRound2).className} animate-spin rounded-full`} />
          <div {...stylex.props(styles.absRoundPulsing)} />
          <div {...stylex.props(styles.relGridCentered2)}>
            {state.phase === "loading" ? (
              <LoaderCircle
                className={stylex.props(styles.spinner).className}
                aria-hidden="true"
              />
            ) : (
              <Activity className={stylex.props(styles.pulsing).className} aria-hidden="true" />
            )}
          </div>
        </div>

        <p {...stylex.props(styles.capsMetaAccent)}>
          {state.phase === "loading"
            ? "Preparing renderer"
            : "Testing orbit smoothness"}
        </p>
        <h2 {...stylex.props(styles.xxxlInkSemibold)}>
          {candidate}
        </h2>
        <p {...stylex.props(styles.smMutedNums)}>
          {elapsedSeconds}s elapsed · {completedCount} of{" "}
          {SCENARIO_AUTHORING_QUALITY_IDS.length} complete
        </p>

        <div
          {...stylex.props(styles.gridCenteredXCols4)}
          aria-label="Benchmark progress"
        >
          {SCENARIO_AUTHORING_QUALITY_IDS.map((quality, index) => {
            const result = results.find((item) => item.quality === quality);
            const failed = failures.some((item) => item.quality === quality);
            const current = index === state.candidateIndex;
            return (
              <div key={quality} {...stylex.props(styles.narrowable)}>
                <div
                  className={stylex.props(styles.relClipRound, result && styles.bgPrimary, failed && styles.bgDestructive70).className}
                >
                  {current ? (
                    <span {...stylex.props(styles.absRoundPulsing2)} />
                  ) : null}
                </div>
                <p
                  {...stylex.props(current ? styles.mutedInkSemibold : styles.mutedTruncate)}
                >
                  {choiceLabel(quality)}
                </p>
                {result ? (
                  <p {...stylex.props(styles.microAccentSemibold)}>
                    {result.metrics.avgFps.toFixed(0)} FPS
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BenchmarkResultOverlay({
  snapshot,
  currentQuality,
  copied,
  onCopy,
  onApply,
  onRestart,
}: {
  snapshot: RenderingBenchmarkSnapshot;
  currentQuality: ScenarioAuthoringQuality;
  copied: boolean;
  onCopy: () => void;
  onApply: (quality: ScenarioAuthoringQuality) => void;
  onRestart: () => void;
}) {
  const recommendedResult = snapshot.results.find(
    (result) => result.quality === snapshot.recommended,
  );
  return (
    <div
      {...stylex.props(styles.fixedWhiteScrollY)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="benchmark-result-title"
    >
      <SkyCloudBackdrop xstyle={styles.fixed} />
      <div {...stylex.props(styles.relFlexCol)}>
        <div {...stylex.props(styles.relGridCentered3)}>
          <span {...stylex.props(styles.absBorderedRound3)} />
          <Sparkles className={stylex.props(styles.size9).className} aria-hidden="true" />
        </div>
        <p {...stylex.props(styles.capsMetaAccent2)}>
          Your best match
        </p>
        <h2
          id="benchmark-result-title"
          {...stylex.props(styles.hugeInkSemibold)}
        >
          {choiceLabel(snapshot.recommended)}
        </h2>
        {recommendedResult ? (
          <div {...stylex.props(styles.flexCenterMid)}>
            <span>
              <strong {...stylex.props(styles.xlInkSemibold)}>
                {recommendedResult.metrics.avgFps.toFixed(0)}
              </strong>{" "}
              FPS
            </span>
            <span {...stylex.props(styles.h8WPxBgBorder)} />
            <span>
              <strong {...stylex.props(styles.xlInkSemibold)}>
                {recommendedResult.metrics.p95FrameMs.toFixed(1)}
              </strong>{" "}
              ms p95
            </span>
          </div>
        ) : null}
        <Button
          autoFocus
          xstyle={styles.smRoundGap2}
          size="lg"
          onClick={() => onApply(snapshot.recommended)}
        >
          {currentQuality === snapshot.recommended
            ? "Continue with recommendation"
            : `Use recommended ${choiceLabel(snapshot.recommended)}`}
          <ArrowRight className={stylex.props(styles.size4).className} aria-hidden="true" />
        </Button>

        <section
          {...stylex.props(styles.wide)}
          aria-labelledby="benchmark-manual-selection-title"
        >
          <div {...stylex.props(styles.flexCenterGap4)}>
            <span {...stylex.props(styles.fill)} />
            <h3
              id="benchmark-manual-selection-title"
              {...stylex.props(styles.capsMetaMuted)}
            >
              Manual selection
            </h3>
            <span {...stylex.props(styles.fill)} />
          </div>
          <div {...stylex.props(styles.gridGap2)}>
            {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => {
              const result = snapshot.results.find(
                (candidate) => candidate.quality === choice.id,
              );
              const failed = snapshot.failures.some(
                (candidate) => candidate.quality === choice.id,
              );
              return (
                <button
                  key={choice.id}
                  type="button"
                  aria-label={`Use ${choice.label}`}
                  onClick={() => onApply(choice.id)}
                  className={stylex.props(currentQuality === choice.id ? styles.pad3LeftText : styles.pad3LeftText2).className}
                >
                  <span {...stylex.props(styles.flexBetweenStart2)}>
                    <span {...stylex.props(styles.smInkSemibold)}>
                      {choice.label}
                    </span>
                    {choice.id === snapshot.recommended ? (
                      <span {...stylex.props(styles.capsMetaAccent3)}>
                        Best
                      </span>
                    ) : currentQuality === choice.id ? (
                      <span {...stylex.props(styles.capsMetaMuted2)}>
                        Current
                      </span>
                    ) : null}
                  </span>
                  <span {...stylex.props(styles.blockMicroMuted)}>
                    {result
                      ? `${result.metrics.avgFps.toFixed(0)} FPS · ${result.metrics.orbit.p95FrameMs.toFixed(1)} ms orbit p95`
                      : failed
                        ? "Test unavailable · select anyway"
                        : "Select this profile"}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <details {...stylex.props(styles.borderedWideLeftText)}>
          <summary {...stylex.props(styles.xsMutedSemibold)}>
            Benchmark details
          </summary>
          <div {...stylex.props(styles.ruleTPad4)}>
            <HardwareSummary hardware={snapshot.hardware} />
            <div {...stylex.props(styles.stackMd)} aria-label="Renderer benchmark results">
              {snapshot.results.map((result) => (
                <BenchmarkResultCard
                  key={result.quality}
                  result={result}
                  recommended={result.quality === snapshot.recommended}
                />
              ))}
              {snapshot.failures.map((failure) => (
                <div
                  key={failure.quality}
                  {...stylex.props(styles.xsBorderedPad3)}
                >
                  <div {...stylex.props(styles.flexCenterBetween)}>
                    <span {...stylex.props(styles.inkSemibold)}>
                      {choiceLabel(failure.quality)}
                    </span>
                    <span {...stylex.props(styles.danger)}>Unavailable</span>
                  </div>
                  <p {...stylex.props(styles.microMuted)}>
                    {failure.message}
                  </p>
                </div>
              ))}
            </div>
            <div {...stylex.props(styles.flexWrapGap2)}>
              <Button
                xstyle={styles.gap2}
                size="sm"
                variant="outline"
                onClick={onCopy}
              >
                <Clipboard className={stylex.props(styles.size35).className} aria-hidden="true" />
                {copied ? "Report copied" : "Copy developer report"}
              </Button>
              <Button
                xstyle={styles.gap2}
                size="sm"
                variant="ghost"
                onClick={onRestart}
              >
                <RotateCcw className={stylex.props(styles.size35).className} aria-hidden="true" /> Run again
              </Button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

function useElapsedSeconds(active: boolean, startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active, startedAt]);
  return startedAt === null
    ? 0
    : Math.max(0, Math.floor((now - startedAt) / 1000));
}

function HardwareSummary({
  hardware,
}: {
  hardware: RenderingBenchmarkHardware;
}) {
  const display =
    hardware.display.width && hardware.display.height
      ? `${hardware.display.width}×${hardware.display.height} @ ${hardware.display.pixelRatio.toFixed(2)}×`
      : "Unavailable";
  return (
    <section
      {...stylex.props(styles.borderedPad3)}
      aria-label="Benchmark hardware"
    >
      <h3 {...stylex.props(styles.capsMetaMicro)}>
        Hardware and runtime
      </h3>
      <dl {...stylex.props(styles.gridMicroCols2)}>
        <Diagnostic label="Browser" value={hardware.browser} />
        <Diagnostic label="Operating system" value={hardware.operatingSystem} />
        <Diagnostic
          label="CPU threads"
          value={hardware.logicalProcessors?.toString() ?? "Unavailable"}
        />
        <Diagnostic
          label="Device memory"
          value={
            hardware.deviceMemoryGB
              ? `${hardware.deviceMemoryGB} GB`
              : "Unavailable"
          }
        />
        <Diagnostic label="Display" value={display} />
        <Diagnostic
          label="Graphics API"
          value={
            hardware.renderer
              ? hardware.renderer.webgl2
                ? "WebGL 2"
                : "WebGL 1"
              : "Detecting…"
          }
        />
        <Diagnostic
          label="Benchmark canvas"
          value={`${RENDERING_BENCHMARK_CONFIGURATION.viewportWidth}×${RENDERING_BENCHMARK_CONFIGURATION.viewportHeight}`}
        />
        <Diagnostic
          label="Sample window"
          value={`${(RENDERING_BENCHMARK_CONFIGURATION.sampleDurationMs / 1000).toFixed(1)} seconds per bundle`}
        />
      </dl>
      <dl {...stylex.props(styles.microRuleT)}>
        <Diagnostic
          label="GPU / renderer"
          value={
            hardware.renderer
              ? `${hardware.renderer.renderer} · ${hardware.renderer.vendor}${hardware.renderer.software ? " · software" : ""}`
              : "Detecting from benchmark canvas…"
          }
        />
      </dl>
    </section>
  );
}

function Diagnostic({ label, value }: { label: string; value: string }) {
  return (
    <div {...stylex.props(styles.narrowable)}>
      <dt {...stylex.props(styles.muted)}>{label}</dt>
      <dd
        {...stylex.props(styles.inkMediumBreakWords)}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function BenchmarkResultCard({
  result,
  recommended,
}: {
  result: RenderingBenchmarkResult;
  recommended: boolean;
}) {
  const { metrics } = result;
  return (
    <article
      {...stylex.props(recommended ? styles.borderedPad32 : styles.borderedPad33)}
    >
      <div {...stylex.props(styles.flexCenterBetween2)}>
        <h4 {...stylex.props(styles.inkSemibold)}>
          {choiceLabel(result.quality)}
        </h4>
        {recommended ? (
          <span {...stylex.props(styles.capsMetaBold)}>
            Recommended
          </span>
        ) : null}
      </div>
      <div {...stylex.props(styles.gridCols4Gap2)}>
        <Metric label="Average" value={`${metrics.avgFps.toFixed(1)} FPS`} />
        <Metric label="Minimum" value={`${metrics.minFps.toFixed(1)} FPS`} />
        <Metric
          label="Orbit p95"
          value={`${metrics.orbit.p95FrameMs.toFixed(1)} ms`}
        />
        <Metric
          label="Orbit p99"
          value={`${metrics.orbit.p99FrameMs.toFixed(1)} ms`}
        />
        <Metric
          label="Orbit stalls"
          value={metrics.orbit.over33_3.toLocaleString()}
        />
        <Metric label="Draw calls" value={metrics.drawCalls.toLocaleString()} />
        <Metric label="Resident" value={formatBytes(metrics.residentBytes)} />
        <Metric
          label="CPU proxy"
          value={`${metrics.cpuUtilizationProxy.toFixed(0)}%`}
        />
        <Metric
          label={
            result.assetLoading.streamingSettled
              ? "Assets ready"
              : "Load window"
          }
          value={`${(result.assetLoading.settleMs / 1000).toFixed(1)} s${result.assetLoading.streamingSettled ? "" : "+"}`}
        />
        <Metric
          label="Transferred"
          value={formatBytes(result.assetLoading.transferBytes)}
        />
        <Metric
          label="Asset requests"
          value={result.assetLoading.requestCount.toLocaleString()}
        />
        <Metric
          label="Cache hits"
          value={result.assetLoading.cachedResponses.toLocaleString()}
        />
      </div>
      <p {...stylex.props(styles.microMuted2)}>
        {metrics.frames.toLocaleString()} frames over{" "}
        {(metrics.durationMs / 1000).toFixed(1)}s · three orbit passes reverse
        direction and change viewing angle · worst orbit frame{" "}
        {metrics.orbit.maxFrameMs.toFixed(1)} ms
      </p>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p {...stylex.props(styles.capsMuted)}>
        {label}
      </p>
      <p {...stylex.props(styles.microInkSemibold)}>
        {value}
      </p>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
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
      if (!signal?.aborted)
        onComplete({
          quality,
          metrics,
          assetLoading: {
            settleMs: settledAt - loadStartedAt.current,
            streamingSettled,
            requestCount: resources.length,
            transferBytes: resources.reduce(
              (sum, entry) => sum + entry.transferSize,
              0,
            ),
            encodedBodyBytes: resources.reduce(
              (sum, entry) => sum + entry.encodedBodySize,
              0,
            ),
            decodedBodyBytes: resources.reduce(
              (sum, entry) => sum + entry.decodedBodySize,
              0,
            ),
            cachedResponses: resources.filter(
              (entry) => entry.transferSize === 0 && entry.decodedBodySize > 0,
            ).length,
          },
        });
    } catch (reason) {
      onError(reason);
    }
  }, [manifestUrl, onComplete, onError, onMeasuring, quality, signal]);

  return (
    <div
      aria-hidden="true"
      {...stylex.props(styles.fixedClipInert)}
      data-testid="rendering-benchmark-canvas"
    >
      <CityView
        manifestUrl={manifestUrl}
        options={{
          maxPixelRatio: preset.maxPixelRatio,
          antialias: preset.antialias,
          ultraLowFidelity: preset.ultraLow,
          roadsOnlyFidelity: preset.roadsOnly,
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
        onMapLoaded={() => void run()}
        onError={onError}
      />
    </div>
  );
}

function choiceLabel(quality: ScenarioAuthoringQuality) {
  return (
    SCENARIO_AUTHORING_QUALITY_CHOICES.find(
      (choice) => choice.id === quality,
    )?.label ?? quality
  );
}
