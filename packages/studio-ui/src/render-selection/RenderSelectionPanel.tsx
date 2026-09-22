"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Circle,
  CircleDashed,
  Clipboard,
  Gauge,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../components/ui/button";
import {
  SCENARIO_AUTHORING_QUALITY_CHOICES,
  SCENARIO_AUTHORING_QUALITY_IDS,
  type ScenarioAuthoringQuality,
} from "../lib/scenario/contracts";
import {
  useRenderingBenchmark,
  type BenchmarkState,
} from "../scenario/editor/regions/slots/RenderingBenchmark";
import {
  missingCityTiles,
  type RenderingBenchmarkFailure,
  type RenderingBenchmarkHardware,
  type RenderingBenchmarkResult,
} from "../scenario/editor/regions/slots/rendering-benchmark";
import { styles } from "./RenderSelectionPanel.stylex";

const LABELS: Record<ScenarioAuthoringQuality, string> = Object.fromEntries(
  SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => [choice.id, choice.label]),
) as Record<ScenarioAuthoringQuality, string>;

const SUMMARY: Record<ScenarioAuthoringQuality, string> = {
  low: "Same world, smaller 256 px textures; 640 MiB scene budget.",
  medium: "512 px texture target; 1.5 GiB scene budget.",
};

/**
 * The whole render-selection surface on one page: diagnostics that expand in
 * place under their own button, then the manual choice. Nothing here
 * navigates; the page that mounts it owns what happens after `onChoose`.
 */
export function RenderSelectionPanel({
  manifestUrl,
  mapLabel,
  catalogReady,
  currentQuality,
  onChoose,
  titleId,
  descriptionId,
  footer,
}: {
  /** Browser manifest of the map the benchmark streams; null when none is published. */
  manifestUrl: string | null;
  mapLabel: string;
  /** False while the map catalog is still loading, so "no map" is not shown too early. */
  catalogReady: boolean;
  currentQuality: ScenarioAuthoringQuality;
  onChoose: (quality: ScenarioAuthoringQuality) => void;
  titleId?: string;
  descriptionId?: string;
  footer?: ReactNode;
}) {
  const qualities = SCENARIO_AUTHORING_QUALITY_IDS;
  const { state, start, cancel, runner } = useRenderingBenchmark(manifestUrl ?? "", qualities);
  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.content)} data-testid="render-selection-content">
        <header {...stylex.props(styles.header)}>
          <p {...stylex.props(styles.eyebrow)}>Rendering</p>
          <h1 id={titleId} {...stylex.props(styles.title)}>
            Render Selection
          </h1>
          <p id={descriptionId} {...stylex.props(styles.lede)}>
            Run the diagnostics once and use the setting that works best on this device. You can change it any time.
          </p>
        </header>

        {manifestUrl ? (
          <>
            <RenderDiagnostics
              qualities={qualities}
              state={state}
              currentQuality={currentQuality}
              mapLabel={mapLabel}
              onStart={start}
              onCancel={cancel}
              onApply={onChoose}
            />
            {runner}
          </>
        ) : (
          <div {...stylex.props(styles.card)} data-testid="rendering-benchmark-placeholder">
            <div {...stylex.props(styles.cardHead)}>
              <Gauge {...stylex.props(styles.checkIcon, styles.checkPending)} aria-hidden="true" />
              <div {...stylex.props(styles.cardHeadText)}>
                <p {...stylex.props(styles.cardTitle)}>
                  {catalogReady ? "Diagnostics unavailable" : "Preparing diagnostics…"}
                </p>
                <p {...stylex.props(styles.cardMeta)}>
                  {catalogReady
                    ? "No published map to test against. Choose a setting below."
                    : "Selecting a test map."}
                </p>
              </div>
            </div>
          </div>
        )}

        <section {...stylex.props(styles.section)} aria-labelledby="render-selection-manual">
          <div {...stylex.props(styles.sectionHead)}>
            <div {...stylex.props(styles.rule)} />
            <h2 id="render-selection-manual" {...stylex.props(styles.sectionTitle)}>
              Manual selection
            </h2>
            <div {...stylex.props(styles.rule)} />
          </div>
          <p {...stylex.props(styles.choiceCopy)}>These are texture targets. A weaker device may select lower quality; the viewport reports the actual tier and reason.</p>
          <div {...stylex.props(styles.choices)}>
            {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => {
              const current = choice.id === currentQuality;
              return (
                <button
                  key={choice.id}
                  type="button"
                  onClick={() => onChoose(choice.id)}
                  aria-label={`Use ${choice.label}`}
                  aria-pressed={current}
                  {...stylex.props(styles.choice, current && styles.choiceCurrent)}
                >
                  <span {...stylex.props(styles.choiceLabel)}>
                    {choice.label}
                    {current ? (
                      <span {...stylex.props(styles.choiceTag)}>Current</span>
                    ) : choice.recommended ? (
                      <span {...stylex.props(styles.choiceTag)}>Default</span>
                    ) : null}
                  </span>
                  <span {...stylex.props(styles.choiceCopy)}>{SUMMARY[choice.id]}</span>
                  <span {...stylex.props(styles.choiceMeta)}>{choice.downloadGuidance}</span>
                  <span {...stylex.props(styles.choiceMeta)}>{choice.gpuMemoryGuidance}</span>
                </button>
              );
            })}
          </div>
        </section>

        {footer ? <div {...stylex.props(styles.footer)}>{footer}</div> : null}
      </div>
    </div>
  );
}

/**
 * The diagnostics card. One button when idle; started, the body reveals in
 * place and fills with the checks, the four profile lanes and the verdict.
 */
export function RenderDiagnostics({
  state,
  currentQuality,
  mapLabel,
  onStart,
  onCancel,
  onApply,
  qualities,
}: {
  state: BenchmarkState;
  currentQuality: ScenarioAuthoringQuality;
  mapLabel: string;
  onStart: () => void;
  onCancel: () => void;
  onApply: (quality: ScenarioAuthoringQuality) => void;
  qualities: readonly ScenarioAuthoringQuality[];
}) {
  const active = state.phase === "loading" || state.phase === "measuring";
  const snapshot =
    state.phase === "complete" ? state.snapshot : state.phase === "idle" ? state.snapshot : null;
  const inFlight = state.phase === "idle" || state.phase === "complete" ? null : state;
  const results: readonly RenderingBenchmarkResult[] = snapshot?.results ?? inFlight?.results ?? [];
  const failures: readonly RenderingBenchmarkFailure[] = snapshot?.failures ?? inFlight?.failures ?? [];
  const hardware = snapshot?.hardware ?? inFlight?.hardware ?? null;
  const recommended = snapshot?.recommended ?? null;
  const open = state.phase !== "idle" || snapshot !== null;
  const completedCount = results.length + failures.length;
  const candidateIndex = active ? state.candidateIndex : -1;
  const runningPhase = active ? state.phase : null;
  const checks = diagnosticChecks({ hardware, results, failures, recommended, running: active });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyReport = () => {
    if (!snapshot || !navigator.clipboard) return;
    void navigator.clipboard
      .writeText(JSON.stringify(snapshot, null, 2))
      .then(() => setCopied(true));
  };

  return (
    <section
      {...stylex.props(styles.card)}
      data-testid="rendering-benchmark"
      data-phase={state.phase}
      aria-labelledby="render-diagnostics-title"
    >
      <div {...stylex.props(styles.cardHead)}>
        <div {...stylex.props(styles.cardHeadText)}>
          <p id="render-diagnostics-title" {...stylex.props(styles.cardTitle)}>
            Diagnostics
          </p>
          <p {...stylex.props(styles.cardMeta)}>
            {snapshot
              ? `Measured on ${mapLabel} · ${new Date(snapshot.capturedAt).toLocaleString()}`
              : `Streams ${mapLabel} through every setting and measures each one.`}
          </p>
        </div>
        {active ? (
          <Button
            xstyle={styles.cancelButton}
            variant="outline"
            size="sm"
            type="button"
            onClick={onCancel}
          >
            <X aria-hidden="true" />
            Cancel
          </Button>
        ) : (
          <Button
            xstyle={styles.startButton}
            size="sm"
            type="button"
            onClick={onStart}
            aria-label={`Start benchmark on ${mapLabel}`}
          >
            {snapshot ? <RotateCcw aria-hidden="true" /> : <Gauge aria-hidden="true" />}
            {snapshot ? "Run Again" : "Start Benchmark"}
          </Button>
        )}
      </div>

      <div {...stylex.props(styles.reveal, open && styles.revealOpen)} aria-hidden={!open}>
        <div {...stylex.props(styles.revealClip)}>
          <div {...stylex.props(styles.body)}>
            <Progress state={state} completedCount={completedCount} total={qualities.length} />

            {active ? (
              <p {...stylex.props(styles.status)} role="status" aria-live="polite">
                <span>
                  <span {...stylex.props(styles.statusStrong)}>
                    Testing {LABELS[qualities[state.candidateIndex]!]}
                  </span>
                  {" · "}
                  {state.phase === "loading" ? "loading map" : "orbiting camera"}
                </span>
                <span>
                  {completedCount} of {qualities.length} complete
                </span>
              </p>
            ) : null}

            <ul {...stylex.props(styles.checks)}>
              {checks.map((check) => (
                <li key={check.id} {...stylex.props(styles.check)}>
                  <CheckIcon status={check.status} />
                  <div>
                    <p {...stylex.props(styles.checkTitle)}>{check.title}</p>
                    <p {...stylex.props(styles.checkDetail)}>{check.detail}</p>
                  </div>
                </li>
              ))}
            </ul>

            <div {...stylex.props(styles.lanes)}>
              {qualities.map((quality, index) => (
                <Lane
                  key={quality}
                  quality={quality}
                  result={results.find((item) => item.quality === quality) ?? null}
                  failure={failures.find((item) => item.quality === quality) ?? null}
                  phase={
                    index === candidateIndex && runningPhase
                      ? runningPhase
                      : index < candidateIndex || !active
                        ? "done"
                        : "queued"
                  }
                  best={recommended === quality}
                />
              ))}
            </div>

            {state.phase === "error" ? (
              <div {...stylex.props(styles.alert)} role="alert">
                <p>{state.message}</p>
                {state.failures.map((failure) => (
                  <p key={failure.quality}>
                    {LABELS[failure.quality]}: {failure.message}
                  </p>
                ))}
              </div>
            ) : null}

            {snapshot ? (
              <div {...stylex.props(styles.verdict)}>
                <div {...stylex.props(styles.verdictText)}>
                  <p {...stylex.props(styles.verdictTitle)}>
                    Best match: {LABELS[snapshot.recommended]}
                  </p>
                  <p {...stylex.props(styles.verdictDetail)}>
                    {snapshot.recommended === currentQuality
                      ? "This is your current setting."
                      : `Currently ${LABELS[currentQuality]}.`}
                    {snapshot.failures.length > 0
                      ? ` ${snapshot.failures.length} setting${snapshot.failures.length === 1 ? "" : "s"} could not be measured.`
                      : ""}
                  </p>
                </div>
                <Button
                  xstyle={styles.ghostButton}
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={copyReport}
                  aria-label="Copy developer report"
                >
                  <Clipboard aria-hidden="true" />
                  {copied ? "Copied" : "Copy report"}
                </Button>
                <Button
                  xstyle={styles.startButton}
                  size="sm"
                  type="button"
                  onClick={() => onApply(snapshot.recommended)}
                  aria-label={`Use recommended ${LABELS[snapshot.recommended]}`}
                >
                  <Check aria-hidden="true" />
                  Use {LABELS[snapshot.recommended]}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function Progress({ state, completedCount, total }: { state: BenchmarkState; completedCount: number; total: number }) {
  const active = state.phase === "loading" || state.phase === "measuring";
  const fraction = state.phase === "complete" ? 1 : completedCount / total;
  return (
    <div
      {...stylex.props(styles.progressTrack)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={state.phase === "complete" ? total : completedCount}
    >
      <div
        {...stylex.props(styles.progressFill)}
        style={{ transform: `scaleX(${fraction})` }}
      />
      {active ? <div {...stylex.props(styles.progressSweep)} /> : null}
    </div>
  );
}

function CheckIcon({ status }: { status: DiagnosticStatus }) {
  switch (status) {
    case "pass":
      return <Check {...stylex.props(styles.checkIcon, styles.checkPass)} aria-hidden="true" />;
    case "warn":
      return <AlertTriangle {...stylex.props(styles.checkIcon, styles.checkWarn)} aria-hidden="true" />;
    case "fail":
      return <XCircle {...stylex.props(styles.checkIcon, styles.checkFail)} aria-hidden="true" />;
    default:
      return <CircleDashed {...stylex.props(styles.checkIcon, styles.checkPending)} aria-hidden="true" />;
  }
}

function Lane({
  quality,
  result,
  failure,
  phase,
  best,
}: {
  quality: ScenarioAuthoringQuality;
  result: RenderingBenchmarkResult | null;
  failure: RenderingBenchmarkFailure | null;
  phase: "loading" | "measuring" | "done" | "queued";
  best: boolean;
}) {
  const running = phase === "loading" || phase === "measuring";
  const city = result?.coverage.orbit.city ?? result?.coverage.settled.city ?? null;
  const missing = result ? missingCityTiles(result) : 0;
  return (
    <div
      {...stylex.props(styles.lane, running && styles.laneActive, best && styles.laneBest)}
      data-testid={`benchmark-lane-${quality}`}
    >
      <p {...stylex.props(styles.laneLabel)}>
        {LABELS[quality]}
        {best ? <span {...stylex.props(styles.laneBadge)}>Best</span> : null}
      </p>
      {result ? (
        <>
          <p {...stylex.props(styles.laneValue)}>
            {Math.round(result.metrics.avgFps)}
            <span {...stylex.props(styles.laneUnit)}>fps</span>
          </p>
          <div {...stylex.props(styles.laneRows)}>
            <p {...stylex.props(styles.laneRow)}>
              <span>p95 orbit</span>
              <span>{result.metrics.orbit.p95FrameMs.toFixed(1)} ms</span>
            </p>
            <p {...stylex.props(styles.laneRow)}>
              <span>Resident</span>
              <span>{formatBytes(result.metrics.residentBytes)}</span>
            </p>
            <p {...stylex.props(styles.laneRow)}>
              <span>Load</span>
              <span>{(result.assetLoading.settleMs / 1000).toFixed(1)} s</span>
            </p>
            {city ? (
              <p {...stylex.props(styles.laneRow, missing > 0 && styles.laneRowBad)}>
                <span>Buildings</span>
                <span>
                  {missing > 0
                    ? `${missing} of ${city.wantedTiles} missing`
                    : `${city.wantedTiles} tiles complete`}
                </span>
              </p>
            ) : null}
          </div>
        </>
      ) : failure ? (
        <>
          <p {...stylex.props(styles.laneValue, styles.laneValueMuted)}>Unavailable</p>
          <p {...stylex.props(styles.laneRows)}>{failure.message}</p>
        </>
      ) : (
        <p {...stylex.props(styles.laneValue, styles.laneValueMuted)}>
          {phase === "loading"
            ? "Loading map"
            : phase === "measuring"
              ? "Orbiting camera"
              : phase === "queued"
                ? "Queued"
                : "Not measured"}
        </p>
      )}
    </div>
  );
}

export type DiagnosticStatus = "pass" | "warn" | "fail" | "pending";

export type DiagnosticCheck = {
  id: "gpu" | "buildings" | "smoothness";
  status: DiagnosticStatus;
  title: string;
  detail: string;
};

/**
 * The three questions the diagnostics answer, as data. Rendered as the check
 * list; also what the recommendation is explained by.
 */
export function diagnosticChecks({
  hardware,
  results,
  failures,
  recommended,
  running,
}: {
  hardware: RenderingBenchmarkHardware | null;
  results: readonly RenderingBenchmarkResult[];
  failures: readonly RenderingBenchmarkFailure[];
  recommended: ScenarioAuthoringQuality | null;
  running: boolean;
}): DiagnosticCheck[] {
  return [gpuCheck(hardware), buildingsCheck(results, running), smoothnessCheck(results, failures, recommended, running)];
}

function gpuCheck(hardware: RenderingBenchmarkHardware | null): DiagnosticCheck {
  const renderer = hardware?.renderer;
  if (!hardware || !renderer) {
    return {
      id: "gpu",
      status: "pending",
      title: "Checking the graphics adapter",
      detail: "Waiting for the first renderer to start.",
    };
  }
  const name = renderer.renderer;
  if (hardware.gpuClass === "software" || hardware.hardwareAccelerated === false) {
    return {
      id: "gpu",
      status: "fail",
      title: "Rendering on the CPU",
      detail: `${name} is a software rasterizer. Enable hardware acceleration in the browser, or check that the app is allowed to use the GPU. Low targets 256 px textures; the app reports any device-pressure downgrade.`,
    };
  }
  if (hardware.gpuClass === "integrated") {
    return {
      id: "gpu",
      status: "warn",
      title: `Integrated graphics: ${name}`,
      detail: "If this device also has a discrete GPU, set the browser to \"high performance\" graphics so it is used instead.",
    };
  }
  return {
    id: "gpu",
    status: "pass",
    title: `GPU accelerated: ${name}`,
    detail: `${renderer.webgl2 ? "WebGL 2" : "WebGL 1"} · ${hardware.logicalProcessors ?? "?"} cores · ${hardware.deviceMemoryGB ? `${hardware.deviceMemoryGB} GB RAM` : "memory unknown"}`,
  };
}

function buildingsCheck(results: readonly RenderingBenchmarkResult[], running: boolean): DiagnosticCheck {
  const withCity = results.filter((result) => result.coverage.settled.city || result.coverage.orbit.city);
  if (withCity.length === 0) {
    return {
      id: "buildings",
      status: running || results.length === 0 ? "pending" : "warn",
      title: "Checking that every building spawns",
      detail: running || results.length === 0
        ? "Counting the city tiles the camera asks for against the ones that arrive."
        : "No 3D setting could be measured.",
    };
  }
  const incomplete = withCity.filter((result) => missingCityTiles(result) > 0);
  if (incomplete.length === 0) {
    const wanted = Math.max(
      ...withCity.map((result) => result.coverage.orbit.city?.wantedTiles ?? result.coverage.settled.city?.wantedTiles ?? 0),
    );
    return {
      id: "buildings",
      status: running ? "pending" : "pass",
      title: "Every building spawns",
      detail: `All ${wanted} city tiles the camera asked for were resident, in every 3D setting measured so far.`,
    };
  }
  const detail = incomplete
    .map((result) => {
      const city = result.coverage.orbit.city ?? result.coverage.settled.city!;
      const missing = missingCityTiles(result);
      const budget = Math.max(
        result.coverage.settled.city?.budgetBlockedTiles ?? 0,
        result.coverage.orbit.city?.budgetBlockedTiles ?? 0,
      );
      const failed = Math.max(
        result.coverage.settled.city?.failedTiles ?? 0,
        result.coverage.orbit.city?.failedTiles ?? 0,
      );
      const reasons = [
        budget > 0 ? `${budget} over the memory budget` : null,
        failed > 0 ? `${failed} failed to load` : null,
      ].filter(Boolean);
      return `${LABELS[result.quality]}: ${missing} of ${city.wantedTiles} missing${reasons.length ? ` (${reasons.join(", ")})` : ""}`;
    })
    .join(" · ");
  return {
    id: "buildings",
    status: "warn",
    title: `Buildings missing in ${incomplete.map((result) => LABELS[result.quality]).join(", ")}`,
    detail: `${detail}. Those settings are not recommended.`,
  };
}

function smoothnessCheck(
  results: readonly RenderingBenchmarkResult[],
  failures: readonly RenderingBenchmarkFailure[],
  recommended: ScenarioAuthoringQuality | null,
  running: boolean,
): DiagnosticCheck {
  if (running || (results.length === 0 && failures.length === 0)) {
    return {
      id: "smoothness",
      status: "pending",
      title: "Measuring frame pacing",
      detail: "Each setting orbits the camera for a few seconds while frame times are sampled.",
    };
  }
  if (!recommended) {
    return {
      id: "smoothness",
      status: "fail",
      title: "No setting could be measured",
      detail: failures.map((failure) => `${LABELS[failure.quality]}: ${failure.message}`).join(" · "),
    };
  }
  const best = results.find((result) => result.quality === recommended);
  const interactive =
    best &&
    best.metrics.avgFps >= 40 &&
    best.metrics.orbit.p95FrameMs <= 33.3 &&
    best.metrics.orbit.p99FrameMs <= 50;
  return {
    id: "smoothness",
    status: interactive ? "pass" : "warn",
    title: interactive
      ? `${LABELS[recommended]} stays smooth`
      : `${LABELS[recommended]} is the smoothest, but stutters`,
    detail: best
      ? `${Math.round(best.metrics.avgFps)} fps average · p95 ${best.metrics.orbit.p95FrameMs.toFixed(1)} ms · p99 ${best.metrics.orbit.p99FrameMs.toFixed(1)} ms while orbiting.`
      : "",
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
