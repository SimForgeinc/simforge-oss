"use client";

import { useEffect, useState, type RefObject } from "react";
import { MousePointer2, TriangleAlert } from "lucide-react";
import type { EditorState } from "@simforge-oss/editor";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./PlacementCursorHint.stylex";

interface CursorPoint {
  x: number;
  y: number;
}

/** Quiet, map-local placement guidance. The controller remains placement authority. */
export function PlacementCursorHint({
  state,
  hostRef,
  canvas,
}: {
  state: EditorState | null;
  hostRef: RefObject<HTMLDivElement | null>;
  canvas?: HTMLCanvasElement | null;
}) {
  const [point, setPoint] = useState<CursorPoint | null>(null);

  useEffect(() => {
    const target = canvas ?? hostRef.current?.querySelector("canvas");
    if (!target) return;
    const onPointerMove = (event: PointerEvent) => {
      setPoint({
        x: Math.min(event.clientX + 16, window.innerWidth - 224),
        y: Math.min(event.clientY + 18, window.innerHeight - 74),
      });
    };
    target.addEventListener("pointermove", onPointerMove);
    return () => target.removeEventListener("pointermove", onPointerMove);
  }, [canvas, hostRef]);

  if (!state || (state.mode !== "placing" && state.mode !== "grab")) return null;

  const moving = state.mode === "grab";
  const ready = state.valid && state.dropOutcome !== "invalid";
  const warning = state.placementWarning
    ?? (moving && state.dropOutcome === "free"
      ? "Warning: off-road — will place unanchored."
      : null);
  const detail = warning ?? (ready
    ? state.snapped && state.laneLabel
      ? state.laneLabel
      : "Free placement"
    : moving ? state.hint : "Move onto a valid surface");
  const action = moving ? "move" : "place";
  const Icon = warning ? TriangleAlert : MousePointer2;

  return (
    <div
      {...stylex.props(styles.hint, warning ? styles.hintWarning : styles.hintNeutral)}
      data-placement-mode={state.mode}
      data-placement-valid={String(ready)}
      data-placement-warning={String(Boolean(warning))}
      data-testid="placement-cursor-hint"
      role="status"
      aria-live="polite"
      style={point ? { left: point.x, top: point.y } : { left: 76, bottom: 24 }}
    >
      <Icon
        aria-hidden="true"
        className={stylex.props(styles.icon, warning || !ready ? styles.iconWarning : styles.iconReady).className}
      />
      <span {...stylex.props(styles.narrowable)}>
        <strong {...stylex.props(styles.headline, warning ? styles.headlineWarning : null)}>
          {warning ? `Route warning · click to ${action} anyway` : ready ? `Click to ${action}` : moving ? "Move blocked" : "Placement armed"}
        </strong>
        <span {...stylex.props(styles.detail, warning ? styles.detailWarning : styles.detailNeutral)}>
          {detail}{warning ? " Interactions may not work properly on this road." : ""} · Esc cancel
        </span>
      </span>
    </div>
  );
}
