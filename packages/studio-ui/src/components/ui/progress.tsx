import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { motionRecipe } from "../../stylex/recipes.stylex";
import { colors, motion, space } from "../../stylex/tokens.stylex";
import { mergeStyleProps, type Tone, type XStyle } from "../stylex/surface";

export type ProgressSize = "sm" | "md";

/** The inline custom property the fill reads its 0-1 fraction from. */
const PROGRESS_VAR = "--sfx-progress";

/** Clamp a caller-supplied fraction into 0-1, tolerating junk input. */
function clampFraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

export type ProgressProps = Omit<React.ComponentPropsWithRef<"div">, "color" | "children"> & {
  /** Completion as a fraction, 0-1. Ignored when `indeterminate`. */
  value?: number;
  /** Work is running but unmeasured. */
  indeterminate?: boolean;
  /** Defaults to `accent`. */
  tone?: Tone;
  /** Defaults to `md`. */
  size?: ProgressSize;
  /** Accessible name: required, since the bar has no visible label. */
  "aria-label"?: string;
  /** Where the bar sits and how wide it is. */
  xstyle?: XStyle;
};

/**
 * Progress: a thin bar filling toward a fraction, or sweeping when the work
 * is unmeasured. The fraction travels as a CSS custom property, so a change
 * animates without a new class per value.
 */
export function Progress({ value = 0, indeterminate = false, tone = "accent", size = "md", xstyle, className, style, ...rest }: ProgressProps) {
  const fraction = clampFraction(value);
  const merged = mergeStyleProps(stylex.props(styles.track, sizes[size], tones[tone], xstyle), className, style);
  return (
    <div
      role="progressbar"
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 1}
      aria-valuenow={indeterminate ? undefined : fraction}
      {...rest}
      {...merged}
      style={indeterminate ? merged.style : ({ ...merged.style, [PROGRESS_VAR]: fraction } as React.CSSProperties)}
    >
      {indeterminate ? <div {...stylex.props(motionRecipe.sweep, styles.sweep)} /> : <div {...stylex.props(styles.fill)} />}
    </div>
  );
}

const styles = stylex.create({
  track: { position: "relative", width: "100%", overflow: "hidden", backgroundColor: colors.fillStrong },
  fill: {
    height: "100%",
    width: "100%",
    backgroundColor: "currentColor",
    transformOrigin: "left center",
    transform: "scaleX(var(--sfx-progress, 0))",
    transitionProperty: "transform",
    transitionDuration: motion.durBase,
    transitionTimingFunction: motion.easeStandard,
  },
  sweep: { position: "absolute", insetBlock: 0, width: "25%", backgroundColor: "currentColor" },
});

const sizes = stylex.create({
  sm: { height: "2px" },
  md: { height: space.s1 },
});

const tones = stylex.create({
  neutral: { color: colors.mutedForeground },
  muted: { color: colors.inkMuted },
  accent: { color: colors.accent },
  positive: { color: colors.signalGreen },
  warning: { color: colors.signalYellow },
  critical: { color: colors.signalRed },
});
