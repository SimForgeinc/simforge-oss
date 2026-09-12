/**
 * WorldOverlay — chrome anchored over a live 3D view.
 *
 * Every canvas surface — drive, the map page, scenario preview — grows the
 * same corner and edge stacks, re-derived each time from `absolute inset-0`
 * plus a placement guess. This positions one region against the nearest
 * positioned ancestor and gets the pointer rule right by default: an overlay
 * is transparent to the mouse so drags reach the camera, and only its own
 * children opt back in.
 *
 * The inset travels as the `--sfx-overlay-inset` custom property so a host can
 * shift every overlay at once — under a HUD safe area, say — without each
 * region re-deriving its own offset.
 */

import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { space } from "../../stylex/tokens.stylex";
import { cssVars, mergeStyleProps, type XStyle } from "./surface";

/** Where the region sits over the view. */
export type OverlayPlacement =
  | "top-left"
  | "top-center"
  | "top-right"
  | "left"
  | "right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "center"
  | "fill";

// The custom property is spelled out rather than read from `cssVars`: StyleX
// evaluates `create()` at build time and only inlines constants defined in a
// `.stylex` module. `cssVars.overlayInset` is the same name for runtime code.
const inset = `var(--sfx-overlay-inset, ${space.xl})`;

const styles = stylex.create({
  base: {
    position: "absolute",
    display: "flex",
    // Chrome over a camera view must not eat drags. Children restore pointer
    // events for themselves; see `interactive`.
    pointerEvents: "none",
    zIndex: 1,
  },
  interactive: { pointerEvents: "auto" },
  column: { flexDirection: "column" },
  topLeft: { top: inset, left: inset, alignItems: "flex-start" },
  topCenter: {
    top: inset,
    left: "50%",
    transform: "translateX(-50%)",
    alignItems: "center",
  },
  topRight: { top: inset, right: inset, alignItems: "flex-end" },
  left: {
    top: "50%",
    left: inset,
    transform: "translateY(-50%)",
    alignItems: "flex-start",
  },
  right: {
    top: "50%",
    right: inset,
    transform: "translateY(-50%)",
    alignItems: "flex-end",
  },
  bottomLeft: { bottom: inset, left: inset, alignItems: "flex-start" },
  bottomCenter: {
    bottom: inset,
    left: "50%",
    transform: "translateX(-50%)",
    alignItems: "center",
  },
  bottomRight: { bottom: inset, right: inset, alignItems: "flex-end" },
  center: {
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    alignItems: "center",
    justifyContent: "center",
  },
  fill: {
    inset: 0,
    alignItems: "stretch",
    justifyContent: "stretch",
  },
  gapSm: { gap: space.sm },
  gapMd: { gap: space.lg },
  gapLg: { gap: space.xl },
});

const PLACEMENT: Record<OverlayPlacement, XStyle> = {
  "top-left": styles.topLeft,
  "top-center": styles.topCenter,
  "top-right": styles.topRight,
  left: styles.left,
  right: styles.right,
  "bottom-left": styles.bottomLeft,
  "bottom-center": styles.bottomCenter,
  "bottom-right": styles.bottomRight,
  center: styles.center,
  fill: styles.fill,
};

export type WorldOverlayProps = Omit<
  React.ComponentPropsWithRef<"div">,
  "color"
> & {
  /** Where the region sits. Defaults to `top-left`. */
  placement?: OverlayPlacement;
  /** Stack children vertically. Defaults to `true`. */
  stack?: boolean;
  /** Gap between children. Defaults to `md`. */
  gap?: "sm" | "md" | "lg";
  /** Distance off the anchored edges. Any CSS length; defaults to 16px. */
  inset?: string;
  /** Accept pointer events — for a region that is entirely controls. */
  interactive?: boolean;
  /** Stacking order within the canvas, when regions must overlap. */
  layer?: number;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
};

export function WorldOverlay({
  placement = "top-left",
  stack = true,
  gap = "md",
  inset: insetProp,
  interactive = false,
  layer,
  xstyle,
  className,
  style,
  ...rest
}: WorldOverlayProps) {
  const props = stylex.props(
    styles.base,
    PLACEMENT[placement],
    stack && styles.column,
    gap === "sm" ? styles.gapSm : gap === "lg" ? styles.gapLg : styles.gapMd,
    interactive && styles.interactive,
    xstyle
  );
  const merged = mergeStyleProps(props, className, style);
  const runtime =
    insetProp !== undefined || layer !== undefined
      ? ({
          ...merged.style,
          ...(insetProp !== undefined
            ? { [cssVars.overlayInset]: insetProp }
            : null),
          ...(layer !== undefined ? { zIndex: layer } : null),
        } as React.CSSProperties)
      : merged.style;

  return <div {...rest} {...merged} style={runtime} />;
}
