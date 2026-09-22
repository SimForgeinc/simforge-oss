"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ResizablePanel.stylex";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeStyleProps } from "../components/stylex/surface";

/**
 * A resizable left panel with a persisted width.
 *
 * The 400px default is the 56px dataset strip plus a ~340px scenario column — wide enough for a row's
 * name and actions, narrow enough to keep the list subordinate to the scene. The 320-520 bounds keep the
 * column usable at either end.
 *
 * The drag writes to a ref and to a CSS variable during the gesture and only commits to React state on
 * release. Setting state per `pointermove` would re-render the panel's whole subtree — the scenario list,
 * every row — on every frame of a drag, next to a live WebGL canvas.
 */

const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 320;
const MAX_WIDTH = 520;

function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

export function loadPanelWidth(storageKey: string): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return DEFAULT_WIDTH;
    // A stored value outside the bounds is clamped rather than discarded: the bounds may have narrowed
    // since it was written, and the nearest legal width is closer to intent than the default is.
    return clampWidth(Number(stored));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function savePanelWidth(storageKey: string, width: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Storage blocked or full. The width still applies for this session.
  }
}

export { DEFAULT_WIDTH as DEFAULT_PANEL_WIDTH, MAX_WIDTH as MAX_PANEL_WIDTH, MIN_WIDTH as MIN_PANEL_WIDTH };

export function ResizablePanel({
  storageKey,
  label,
  variant = "solid",
  collapsed = false,
  className,
  xstyle,
  resizable = true,
  inert = false,
  children,
}: {
  /** `localStorage` key for the width. Distinct keys let two panels remember separate widths. */
  storageKey: string;
  /** Accessible name for the drag handle, e.g. "Resize the scenario list". */
  label: string;
  /** Visual treatment for the panel background. */
  variant?: "solid" | "blur-gradient";
  /**
   * Slide the panel out to the left, yielding its width to whatever sits beside it.
   *
   * Negative margin rather than `width: 0`: the children keep their measured width and travel as a
   * block, where collapsing the width would reflow the whole scenario list on every frame of the
   * animation and reflow it back on the way in.
   */
  collapsed?: boolean;
  className?: string;
  xstyle?: stylex.StyleXStyles;
  resizable?: boolean;
  inert?: boolean;
  children: React.ReactNode;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const widthRef = useRef(DEFAULT_WIDTH);

  // Read stored width after mount, not during render: `localStorage` is unavailable on the server, and
  // seeding from it during render would make the server and client markup disagree.
  useEffect(() => {
    const stored = loadPanelWidth(storageKey);
    widthRef.current = stored;
    setWidth(stored);
  }, [storageKey]);

  const applyLiveWidth = useCallback((next: number) => {
    widthRef.current = next;
    const node = panelRef.current;
    if (node) node.style.width = `${next}px`;
  }, []);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      const handle = event.currentTarget;
      // Pointer capture keeps the drag alive when the cursor outruns the 6px handle, which it always
      // does. Without it the gesture dies the moment the pointer crosses onto the canvas.
      handle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        applyLiveWidth(clampWidth(startWidth + (moveEvent.clientX - startX)));
      };
      const onEnd = () => {
        handle.releasePointerCapture?.(event.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        // Commit once, on release.
        setWidth(widthRef.current);
        savePanelWidth(storageKey, widthRef.current);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [applyLiveWidth, storageKey],
  );

  // Arrow keys on the separator. A pointer-only resize is unreachable without a mouse, and a separator
  // that takes focus but does nothing is worse than one that is not focusable at all.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 50 : 10;
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = widthRef.current - step;
      else if (event.key === "ArrowRight") next = widthRef.current + step;
      else if (event.key === "Home") next = MIN_WIDTH;
      else if (event.key === "End") next = MAX_WIDTH;
      if (next === null) return;
      event.preventDefault();
      const clamped = clampWidth(next);
      applyLiveWidth(clamped);
      setWidth(clamped);
      savePanelWidth(storageKey, clamped);
    },
    [applyLiveWidth, storageKey],
  );

  return (
    <div
      ref={panelRef}
      {...mergeStyleProps(stylex.props(styles.panel, variant === "blur-gradient" ? styles.gradient : styles.solid, collapsed && styles.collapsed, !resizable && styles.singlePane, xstyle), className ? `render-surface-motion ${className}` : "render-surface-motion", resizable ? { width, marginLeft: collapsed ? -width : 0 } : undefined)}
      data-testid="scenario-resizable-panel"
      data-panel-visual={variant}
      data-panel-collapsed={collapsed ? "true" : undefined}
      inert={inert || collapsed || undefined}
    >
      {children}
      {resizable ? <div
        role="separator"
        aria-label={label}
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        // Sits just outside the border so it does not overlap the list's own scrollbar.
        {...stylex.props(styles.scenarioPanelResizeHandle)}
        data-testid="scenario-panel-resize-handle"
      /> : null}
    </div>
  );
}
