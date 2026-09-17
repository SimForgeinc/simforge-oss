"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./CloudLoadingHost.stylex";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleAlert } from "lucide-react";
import { CloudLoadingSurface } from "./CloudLoadingSurface";
import {
  CloudLoadingContext,
  type CloudLoadingKind,
  type CloudLoadingSource,
} from "./cloud-loading-context";
import { cn } from "../lib/utils";
import { VisibleClock } from "../lib/visible-clock";
import { formatElapsed, observeTransfers } from "./loading-liveness";
import { formatBytes } from "../scenario/scene/map-load-progress";
import { Button } from "./ui/button";

/**
 * The one place a viewport-scoped `CloudLoadingSurface` is painted.
 *
 * Every `scope="screen"` surface below this provider publishes itself rather
 * than rendering (see `cloud-loading-context.ts`), so a route loader handing
 * over to the scene loader is one surface changing its text, not two surfaces
 * — and the cloud field's WebGL context survives the handoff. The host also
 * owns what no single surface can know: which of several concurrent sources
 * wins, the exit animation after the last one leaves, and the stall watchdog.
 */

/**
 * How long a load may go with no measured progress at all — neither a changed
 * source nor a completed response — before the overlay says so and offers a
 * reload. Progress is evidence, not elapsed time: a map that streams for ten
 * minutes never trips this, and a load that really died reports it in 45 s.
 */
export const CLOUD_LOADING_STALL_MS = 45_000;

/**
 * How long before the overlay starts saying how long it has been waiting and
 * how much has arrived. A long load is normal for a multi-gigabyte map; a
 * silent one is what makes people reload a working load.
 */
export const CLOUD_LOADING_PATIENCE_MS = 20_000;

const EXIT_MS = 900;
const ROUTE_ENTRY_DELAY_MS = 180;
/** The band a `kind: "route"` source competes in; a deeper segment adds to it. */
export const ROUTE_PRIORITY = 10;

type RegisteredSource = {
  order: number;
  source: CloudLoadingSource;
};

const INITIAL_ROUTE_SOURCE: CloudLoadingSource = {
  kind: "route",
  title: "Loading your workspace…",
  detail: "Opening the dashboard in your workspace.",
  progress: null,
  priority: ROUTE_PRIORITY,
};

export function CloudLoadingHost({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<Map<string, RegisteredSource>>(() => new Map());
  const [hydrating, setHydrating] = useState(true);
  const orderRef = useRef(0);
  const rawCandidate = highestPrioritySource(sources) ?? (hydrating ? INITIAL_ROUTE_SOURCE : null);
  const [stalled, setStalled] = useState(false);
  /** Elapsed/transferred evidence, shown once a load outlives the patience window. */
  const [waited, setWaited] = useState<{ elapsedMs: number; bytes: number } | null>(null);
  const stallSignature =
    rawCandidate && rawCandidate.severity !== "error"
      ? [
          rawCandidate.kind,
          rawCandidate.title,
          rawCandidate.detail ?? "",
          rawCandidate.phase ?? "",
          String(rawCandidate.progress ?? ""),
          rawCandidate.progressValueLabel ?? "",
          String(rawCandidate.activityToken ?? ""),
        ].join("\u0000")
      : null;
  const candidate = useMemo(
    () =>
      rawCandidate && rawCandidate.severity !== "error"
        ? stalled
          ? stalledLoadingSource(rawCandidate, waited)
          : waited
            ? waitingLoadingSource(rawCandidate, waited)
            : rawCandidate
        : rawCandidate,
    [rawCandidate, stalled, waited],
  );
  const [renderedSource, setRenderedSource] = useState<CloudLoadingSource>(
    INITIAL_ROUTE_SOURCE,
  );
  const [mounted, setMounted] = useState(true);
  const [visible, setVisible] = useState(true);
  const [entryKind, setEntryKind] = useState<CloudLoadingKind>("route");
  const exitTimerRef = useRef<number | null>(null);
  const exitFrameRef = useRef<number | null>(null);
  const sessionStartedAtRef = useRef(now());

  const setSource = useCallback(
    (id: string, source: CloudLoadingSource | null) => {
      setSources((current) => {
        const existing = current.get(id);
        if (!source && !existing) return current;
        if (source && existing && loadingSourcesEqual(existing.source, source)) {
          return current;
        }
        const next = new Map(current);
        if (!source) {
          next.delete(id);
        } else {
          next.set(id, {
            order: existing?.order ?? ++orderRef.current,
            source,
          });
        }
        return next;
      });
    },
    [],
  );

  const contextValue = useMemo(() => ({ setSource }), [setSource]);

  useEffect(() => {
    setHydrating(false);
  }, []);

  /**
   * The watchdog measures progress instead of inferring it from elapsed time.
   *
   * Two independent signals count: the published source changing
   * (`stallSignature`) and the browser completing a response
   * (`observeTransfers`). Either resets the window. That matters because the
   * window before a viewer exists — route chunks, the map manifest, the first
   * sidecars — has no publisher to report anything, and a large map spends
   * minutes there; the old string-only watchdog called that healthy load dead
   * and told the user to reload it.
   *
   * Between the patience and stall windows the overlay keeps the real source
   * and adds what it is waiting on, so a long load reads as a long load.
   */
  useEffect(() => {
    if (stallSignature === null) {
      setStalled(false);
      setWaited(null);
      return;
    }
    const signature = stallSignature;
    let stallTimer: number | undefined;
    let patienceTimer: number | undefined;
    let transferAtLastProgress = 0;
    const startedAt = now();
    const schedule = () => {
      window.clearTimeout(stallTimer);
      if (clock.visible) {
        stallTimer = window.setTimeout(expire, Math.max(0, CLOUD_LOADING_STALL_MS - clock.now()));
      }
    };
    const clock = new VisibleClock(() => schedule());
    const transfers = observeTransfers((snapshot) => {
      if (snapshot.bytes === transferAtLastProgress) return;
      transferAtLastProgress = snapshot.bytes;
      // Bytes arrived: this load is alive whatever its publisher reports.
      clock.reset();
      setStalled(false);
      schedule();
    });
    function expire() {
      const evidence = transfers.snapshot();
      clock.dispose();
      setStalled(true);
      const [kind, title] = signature.split("\u0000");
      console.error(
        `Cloud loading stalled: ${kind} source "${title}" made no measured progress for `
        + `${Math.round(CLOUD_LOADING_STALL_MS / 1000)}s `
        + `(${evidence.responses} responses, ${evidence.bytes} bytes since it started).`,
      );
    }
    const announceWait = () => {
      setWaited({ elapsedMs: now() - startedAt, bytes: transfers.snapshot().bytes });
      patienceTimer = window.setTimeout(announceWait, 5_000);
    };
    schedule();
    patienceTimer = window.setTimeout(announceWait, CLOUD_LOADING_PATIENCE_MS);
    return () => {
      window.clearTimeout(stallTimer);
      window.clearTimeout(patienceTimer);
      transfers.dispose();
      clock.dispose();
    };
  }, [stallSignature]);

  useLayoutEffect(() => {
    if (candidate) {
      cancelScheduledExit(exitFrameRef, exitTimerRef);
      if (!mounted) {
        sessionStartedAtRef.current = now();
        setEntryKind(candidate.kind);
      }
      setRenderedSource(candidate);
      setMounted(true);
      setVisible(true);
      return;
    }

    if (!mounted) return;
    exitFrameRef.current = scheduleNextFrame(() => {
      exitFrameRef.current = null;
      if (
        entryKind === "route"
        && now() - sessionStartedAtRef.current < ROUTE_ENTRY_DELAY_MS
      ) {
        setVisible(false);
        setMounted(false);
        return;
      }
      setVisible(false);
      exitTimerRef.current = window.setTimeout(() => {
        setMounted(false);
        exitTimerRef.current = null;
      }, EXIT_MS);
    });

    return () => cancelScheduledExit(exitFrameRef, exitTimerRef);
  }, [candidate, entryKind, mounted]);

  useEffect(
    () => () => cancelScheduledExit(exitFrameRef, exitTimerRef),
    [],
  );

  const failed = renderedSource.severity === "error";
  const enteringScene = visible && entryKind === "scene";

  /**
   * One machine-readable answer to "is Studio still loading, and on what?".
   *
   * The overlay is the only honest source of that, and it lives under a
   * portal-less provider whose markup differs per surface, so a caller had to
   * guess which component was mounted — a guess that reads "not loading" while
   * a map streams. Automation, support and the desktop shell read these
   * instead.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (!mounted || !visible) {
      root.removeAttribute("data-simforge-loading");
      root.removeAttribute("data-simforge-loading-kind");
      root.removeAttribute("data-simforge-loading-phase");
      root.removeAttribute("data-simforge-loading-percent");
      root.removeAttribute("data-simforge-loading-stalled");
      return;
    }
    root.setAttribute("data-simforge-loading", renderedSource.title);
    root.setAttribute("data-simforge-loading-kind", renderedSource.kind);
    root.setAttribute("data-simforge-loading-phase", renderedSource.phase ?? "");
    root.setAttribute(
      "data-simforge-loading-percent",
      renderedSource.progress == null ? "" : String(Math.round(renderedSource.progress)),
    );
    root.setAttribute("data-simforge-loading-stalled", String(stalled));
  }, [mounted, renderedSource, stalled, visible]);

  useEffect(
    () => () => {
      const root = document.documentElement;
      root.removeAttribute("data-simforge-loading");
      root.removeAttribute("data-simforge-loading-kind");
      root.removeAttribute("data-simforge-loading-phase");
      root.removeAttribute("data-simforge-loading-percent");
      root.removeAttribute("data-simforge-loading-stalled");
    },
    [],
  );

  return (
    <CloudLoadingContext.Provider value={contextValue}>
      {children}
      {mounted ? (
        // The painted instance sits under an empty context: without it the
        // surface would publish itself straight back to this host.
        <CloudLoadingContext.Provider value={null}>
          <CloudLoadingSurface
            ariaBusy={visible && !failed}
            ariaHidden={!visible}
            backdropClassName={
              visible
                ? enteringScene
                  ? "scene-loader-cloud-enter"
                  : undefined
                : "scene-loader-cloud-exit"
            }
            className={cn(
              entryKind === "route" && "route-loading",
              enteringScene && "dashboard-scene-loading-enter",
            )}
            xstyle={[
              styles.overlay,
              visible ? styles.overlayVisible : styles.overlayHidden,
            ]}
            style={{ transitionDuration: "900ms" }}
            contentWrapClassName={
              visible
                ? enteringScene
                  ? "scene-loader-content-enter"
                  : undefined
                : "scene-loader-content-exit"
            }
            dataTransitionState={visible ? "covering" : "revealing"}
            detail={renderedSource.detail}
            icon={renderedSource.icon}
            kind={renderedSource.kind}
            phase={renderedSource.phase}
            progress={failed ? undefined : renderedSource.progress}
            progressValueLabel={renderedSource.progressValueLabel}
            role={failed ? "alert" : "status"}
            scope="screen"
            telemetry={renderedSource.telemetry}
            title={renderedSource.title}
          >
            {renderedSource.actions}
          </CloudLoadingSurface>
        </CloudLoadingContext.Provider>
      ) : null}
    </CloudLoadingContext.Provider>
  );
}

type WaitEvidence = { elapsedMs: number; bytes: number };

/** `waiting for 2m 05s · 412 MB read`, or without the byte clause at zero. */
function waitSummary(waited: WaitEvidence): string {
  const elapsed = `waiting for ${formatElapsed(waited.elapsedMs)}`;
  return waited.bytes > 0 ? `${elapsed} · ${formatBytes(waited.bytes)} read` : elapsed;
}

/**
 * A load past the patience window keeps its own title, progress and byte
 * telemetry and gains the wait itself. Replacing the source here is what made
 * a working load look broken: the map's own "1,412 files to go" line is more
 * useful than any generic message this host could invent.
 */
function waitingLoadingSource(source: CloudLoadingSource, waited: WaitEvidence): CloudLoadingSource {
  return {
    ...source,
    detail: source.detail ? `${source.detail} (${waitSummary(waited)})` : waitSummary(waited),
  };
}

/**
 * No measured progress at all for the stall window: no completed response and
 * no change from the publisher. The overlay says exactly that, keeps the
 * progress it had, and offers a reload — it does not claim the load failed,
 * because the host may simply be busy and the load may still recover.
 */
function stalledLoadingSource(source: CloudLoadingSource, waited: WaitEvidence | null): CloudLoadingSource {
  const seconds = Math.round(CLOUD_LOADING_STALL_MS / 1000);
  const evidence = waited ? `${waitSummary(waited)}; ` : "";
  return {
    ...source,
    title: `${source.title} — still waiting`,
    detail:
      `No data has arrived for ${seconds} seconds (${evidence}`
      + `phase ${source.phase ?? source.kind}). It may still recover on its own; `
      + `reload if you would rather start over, and report it with the current address if it repeats.`,
    // Deliberately not `severity: "error"`: nothing has failed, and an error
    // severity would also freeze this source at the top priority band.
    priority: 100,
    icon: <CircleAlert aria-hidden="true" {...stylex.props(styles.alertIcon)} />,
    actions: (
      <Button
        xstyle={styles.reload}
        onClick={() => window.location.reload()}
      >
        Reload
      </Button>
    ),
  };
}

function highestPrioritySource(
  sources: Map<string, RegisteredSource>,
): CloudLoadingSource | null {
  let selected: RegisteredSource | null = null;
  for (const candidate of sources.values()) {
    if (!selected || compareSources(candidate, selected) > 0) selected = candidate;
  }
  return selected?.source ?? null;
}

function compareSources(left: RegisteredSource, right: RegisteredSource): number {
  const leftPriority = sourcePriority(left.source);
  const rightPriority = sourcePriority(right.source);
  return leftPriority === rightPriority ? left.order - right.order : leftPriority - rightPriority;
}

function sourcePriority(source: CloudLoadingSource): number {
  if (source.severity === "error") return 100;
  if (source.priority !== undefined) return source.priority;
  switch (source.kind) {
    case "boot": return 30;
    case "scene": return 20;
    case "route": return ROUTE_PRIORITY;
  }
}

function loadingSourcesEqual(
  left: CloudLoadingSource,
  right: CloudLoadingSource,
): boolean {
  return (
    left.kind === right.kind
    && left.title === right.title
    && left.detail === right.detail
    && left.progress === right.progress
    && left.progressValueLabel === right.progressValueLabel
    && left.activityToken === right.activityToken
    && left.telemetry === right.telemetry
    && left.phase === right.phase
    && left.priority === right.priority
    && left.severity === right.severity
    && left.icon === right.icon
    && left.actions === right.actions
  );
}

function scheduleNextFrame(callback: () => void): number {
  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 16);
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function cancelScheduledExit(
  frameRef: { current: number | null },
  timerRef: { current: number | null },
): void {
  if (frameRef.current !== null) {
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(frameRef.current);
    } else {
      window.clearTimeout(frameRef.current);
    }
    frameRef.current = null;
  }
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}
