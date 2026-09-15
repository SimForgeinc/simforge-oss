"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import type { EditorDocument, EditorState } from "@simforge-oss/editor";
import {
  V1TimelineRail,
  type V1TimelineBrowserPlayback,
  type V1TimelineSignalAuthoring,
  type V1TimelineSignalLane,
} from "./timeline/V1TimelineRail";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./timeline-dock.stylex";
import type { EditorExperience } from "./simple-timed-routes";

// `editor-trigger-builders.test.ts` imports these from this module path; keep the
// re-export when moving them again.
export {
  buildDefaultScenarioCondition,
  buildDefaultScenarioTrigger,
} from "./timeline/trigger-defaults";

const TIMELINE_DOCK_MIN_WIDTH_PX = 360;
const TIMELINE_DOCK_STORAGE_KEY = "simforge.editor.timeline-dock-insets.v1";
const EDGE_RESET_WINDOW_MS = 350;
const LEFT_INSET_VAR = "--timeline-dock-left-inset";
const RIGHT_INSET_VAR = "--timeline-dock-right-inset";

type TimelineDockInsets = Readonly<{ left: number; right: number }>;

function normalizedInset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Keeps a persisted pair usable after the browser becomes narrower. */
function clampTimelineDockInsets(
  insets: TimelineDockInsets,
  containerWidth: number,
): TimelineDockInsets {
  const left = normalizedInset(insets.left);
  const right = normalizedInset(insets.right);
  const availableInset = Math.max(
    0,
    Math.floor(normalizedInset(containerWidth) - TIMELINE_DOCK_MIN_WIDTH_PX),
  );
  const total = left + right;
  if (total <= availableInset || total === 0) return { left, right };
  const clampedLeft = Math.round(availableInset * left / total);
  return { left: clampedLeft, right: availableInset - clampedLeft };
}

/** During a drag the opposite edge stays put; only the active edge is clamped. */
function clampTimelineDockEdgeInset(
  inset: number,
  oppositeInset: number,
  containerWidth: number,
): number {
  return Math.min(
    normalizedInset(inset),
    Math.max(
      0,
      normalizedInset(containerWidth)
        - TIMELINE_DOCK_MIN_WIDTH_PX
        - normalizedInset(oppositeInset),
    ),
  );
}

function readTimelineDockInsets(storage: Pick<Storage, "getItem">): TimelineDockInsets {
  try {
    const value = JSON.parse(storage.getItem(TIMELINE_DOCK_STORAGE_KEY) ?? "null") as {
      version?: unknown;
      left?: unknown;
      right?: unknown;
    } | null;
    if (
      value?.version !== 1
      || typeof value.left !== "number"
      || typeof value.right !== "number"
      || !Number.isFinite(value.left)
      || !Number.isFinite(value.right)
    ) {
      return { left: 0, right: 0 };
    }
    return {
      left: normalizedInset(value.left),
      right: normalizedInset(value.right),
    };
  } catch {
    return { left: 0, right: 0 };
  }
}

function writeTimelineDockInsets(
  storage: Pick<Storage, "setItem">,
  insets: TimelineDockInsets,
): void {
  try {
    storage.setItem(TIMELINE_DOCK_STORAGE_KEY, JSON.stringify({
      version: 1,
      left: normalizedInset(insets.left),
      right: normalizedInset(insets.right),
    }));
  } catch {
    // Private browsing and storage quotas must not make the dock undraggable.
  }
}

/**
 * Always-visible floating timeline around the V2 document/timing authority.
 *
 * Signal truth and canonical browser playback are optional inputs because their owners
 * load and validate them. Their absence stays visible and inert here: the dock
 * never invents a baseline, fetches a second projection, or advertises Play for
 * an authoring-only document.
 */
export function ScenarioTimelineDock({
  document,
  state,
  signalLanes,
  signalAuthoring,
  playback,
  selectedInteractionId,
  onFocusActor,
  onFocusSignal,
  onSelectActor,
  onSelectInteraction,
  onClearSelection,
  onSelectSignal,
  readOnly = false,
  experience = "advanced",
}: {
  document: EditorDocument;
  state?: Pick<EditorState, "selection" | "mode"> | null;
  signalLanes?: readonly V1TimelineSignalLane[];
  signalAuthoring?: V1TimelineSignalAuthoring | null;
  playback?: V1TimelineBrowserPlayback | null;
  selectedInteractionId?: string | null;
  onFocusActor?: (actorId: string) => void;
  onFocusSignal?: (headId: string) => void;
  onSelectActor?: (actorId: string) => void;
  onSelectInteraction?: (interactionId: string, actorId: string) => void;
  onClearSelection?: () => void;
  onSelectSignal?: (headId: string) => void;
  readOnly?: boolean;
  experience?: EditorExperience;
}) {
  const dockRef = useRef<HTMLDivElement>(null);
  const insetsRef = useRef<TimelineDockInsets>({ left: 0, right: 0 });
  const containerWidthRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<{
    edge: "left" | "right";
    pointerId: number;
    startX: number;
    startInset: number;
  } | null>(null);
  const lastPressRef = useRef({ left: 0, right: 0 });

  const applyInsets = useCallback((insets: TimelineDockInsets) => {
    const dock = dockRef.current;
    if (!dock) return;
    dock.style.setProperty(LEFT_INSET_VAR, `${insets.left}px`);
    dock.style.setProperty(RIGHT_INSET_VAR, `${insets.right}px`);
    dock.dataset.timelineLeftInset = String(insets.left);
    dock.dataset.timelineRightInset = String(insets.right);
    dock.querySelector('[data-testid="timeline-left-resize-handle"]')
      ?.setAttribute("aria-valuenow", String(insets.left));
    dock.querySelector('[data-testid="timeline-right-resize-handle"]')
      ?.setAttribute("aria-valuenow", String(insets.right));
  }, []);

  const paintInsets = useCallback((insets: TimelineDockInsets) => {
    insetsRef.current = insets;
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      applyInsets(insetsRef.current);
    });
  }, [applyInsets]);

  const persistInsets = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    applyInsets(insetsRef.current);
    writeTimelineDockInsets(window.localStorage, insetsRef.current);
  }, [applyInsets]);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    const container = dock?.parentElement;
    if (!dock || !container) return;

    const fitToContainer = () => {
      const width = container.getBoundingClientRect().width;
      if (width <= 0) return;
      containerWidthRef.current = width;
      paintInsets(clampTimelineDockInsets(insetsRef.current, width));
    };

    insetsRef.current = readTimelineDockInsets(window.localStorage);
    fitToContainer();
    applyInsets(insetsRef.current);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(fitToContainer);
    observer?.observe(container);
    window.addEventListener("resize", fitToContainer);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fitToContainer);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [applyInsets, paintInsets]);

  const resetEdge = (edge: "left" | "right") => {
    paintInsets({ ...insetsRef.current, [edge]: 0 });
    persistInsets();
  };

  const beginEdgeDrag = (
    edge: "left" | "right",
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const previousPress = lastPressRef.current[edge];
    lastPressRef.current[edge] = event.timeStamp;
    if (
      event.detail > 1
      || (previousPress > 0 && event.timeStamp - previousPress < EDGE_RESET_WINDOW_MS)
    ) {
      dragRef.current = null;
      lastPressRef.current[edge] = 0;
      resetEdge(edge);
      return;
    }
    dragRef.current = {
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startInset: insetsRef.current[edge],
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveEdgeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.clientX - drag.startX;
    const opposite = drag.edge === "left"
      ? insetsRef.current.right
      : insetsRef.current.left;
    const nextInset = clampTimelineDockEdgeInset(
      drag.startInset + (drag.edge === "left" ? delta : -delta),
      opposite,
      containerWidthRef.current,
    );
    paintInsets({ ...insetsRef.current, [drag.edge]: nextInset });
  };

  const endEdgeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    persistInsets();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const adjustEdgeWithKeyboard = (
    edge: "left" | "right",
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const delta = edge === "left" ? direction * 16 : direction * -16;
    const opposite = edge === "left" ? insetsRef.current.right : insetsRef.current.left;
    paintInsets({
      ...insetsRef.current,
      [edge]: clampTimelineDockEdgeInset(
        insetsRef.current[edge] + delta,
        opposite,
        containerWidthRef.current,
      ),
    });
    persistInsets();
  };

  const dockStyle = {
    width: `calc(100% - var(${LEFT_INSET_VAR}) - var(${RIGHT_INSET_VAR}))`,
    marginLeft: `var(${LEFT_INSET_VAR})`,
    marginRight: `var(${RIGHT_INSET_VAR})`,
    [LEFT_INSET_VAR]: "0px",
    [RIGHT_INSET_VAR]: "0px",
  } as CSSProperties;

  return (
    <div
      {...stylex.props(styles.dock)}
      data-testid="resizable-timeline-dock"
      data-timeline-left-inset="0"
      data-timeline-right-inset="0"
      ref={dockRef}
      style={dockStyle}
    >
      <div
        aria-label="Resize timeline from left edge"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuenow={0}
        {...stylex.props(styles.handle, styles.left)}
        data-testid="timeline-left-resize-handle"
        onDoubleClick={() => resetEdge("left")}
        onKeyDown={(event) => adjustEdgeWithKeyboard("left", event)}
        onPointerCancel={endEdgeDrag}
        onPointerDown={(event) => beginEdgeDrag("left", event)}
        onPointerMove={moveEdgeDrag}
        onPointerUp={endEdgeDrag}
        role="separator"
        tabIndex={0}
      >
        <span {...stylex.props(styles.marker)} />
      </div>
      <V1TimelineRail
        document={document}
        playback={playback}
        signalLanes={signalLanes}
        signalAuthoring={signalAuthoring}
        state={state}
        selectedInteractionId={selectedInteractionId}
        onFocusActor={onFocusActor}
        onFocusSignal={onFocusSignal}
        onSelectActor={onSelectActor}
        onSelectInteraction={onSelectInteraction}
        onClearSelection={onClearSelection}
        onSelectSignal={onSelectSignal}
        disableInteractionCreation={experience === "simple"}
        lockSimpleTimedRoutes={experience === "simple"}
        readOnly={readOnly}
      />
      <div
        aria-label="Resize timeline from right edge"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuenow={0}
        {...stylex.props(styles.handle, styles.right)}
        data-testid="timeline-right-resize-handle"
        onDoubleClick={() => resetEdge("right")}
        onKeyDown={(event) => adjustEdgeWithKeyboard("right", event)}
        onPointerCancel={endEdgeDrag}
        onPointerDown={(event) => beginEdgeDrag("right", event)}
        onPointerMove={moveEdgeDrag}
        onPointerUp={endEdgeDrag}
        role="separator"
        tabIndex={0}
      >
        <span {...stylex.props(styles.marker)} />
      </div>
    </div>
  );
}
