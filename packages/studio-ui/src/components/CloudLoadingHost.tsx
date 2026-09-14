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
 * Maximum visible time a byte-identical loading source may report no progress before
 * the overlay offers recovery instead of silently covering Studio forever.
 */
export const CLOUD_LOADING_STALL_MS = 45_000;

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
      stalled && rawCandidate && rawCandidate.severity !== "error"
        ? stalledLoadingSource(rawCandidate)
        : rawCandidate,
    [rawCandidate, stalled],
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

  useEffect(() => {
    if (stallSignature === null) {
      setStalled(false);
      return;
    }
    let timer: number | undefined;
    const expire = () => {
      clock.dispose();
      setStalled(true);
      const [kind, title] = stallSignature.split("\u0000");
      console.error(
        `Cloud loading stalled: ${kind} source "${title}" made no progress for ${Math.round(CLOUD_LOADING_STALL_MS / 1000)}s.`,
      );
    };
    const schedule = () => {
      window.clearTimeout(timer);
      if (clock.visible) {
        timer = window.setTimeout(expire, Math.max(0, CLOUD_LOADING_STALL_MS - clock.now()));
      }
    };
    const clock = new VisibleClock(schedule);
    schedule();
    return () => {
      window.clearTimeout(timer);
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

function stalledLoadingSource(source: CloudLoadingSource): CloudLoadingSource {
  return {
    kind: source.kind,
    title: "Loading is taking longer than expected",
    detail: `“${source.title}” has made no progress for ${Math.round(CLOUD_LOADING_STALL_MS / 1000)} seconds. Reload to try again; if this keeps happening, report it with the current address.`,
    severity: "error",
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
