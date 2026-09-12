/**
 * Progress — a determinate or indeterminate bar.
 *
 * The fraction is the one genuinely runtime number in this folder. It is
 * written to the `--sfx-progress` custom property and the fill scales by it,
 * so a value that changes every frame mutates one inline property instead of
 * minting a StyleX class per percentage. Scaling a transform also keeps the
 * animation off the layout path, unlike the `width: n%` bars in the tree.
 */

import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { colors, motion, space } from "../../stylex/tokens.stylex";
import {
  clampFraction,
  cssVars,
  mergeStyleProps,
  type Tone,
  type XStyle,
} from "./surface";

export type ProgressSize = "sm" | "md";

const slide = stylex.keyframes({
  "0%": { transform: "translateX(-100%)" },
  "100%": { transform: "translateX(400%)" },
});

const styles = stylex.create({
  track: {
    position: "relative",
    width: "100%",
    overflow: "hidden",
    backgroundColor: colors.chip,
  },
  sm: { height: 2 },
  md: { height: space.xs },
  fill: {
    height: "100%",
    width: "100%",
    backgroundColor: "currentColor",
    transformOrigin: "left center",
    // The 0–1 fraction the component writes inline. The name is spelled out
    // here because StyleX evaluates `create()` at build time and will only
    // inline constants that come from a `.stylex` module; `cssVars.progress`
    // below is the same string, and is what runtime code must use.
    transform: "scaleX(var(--sfx-progress, 0))",
    transitionProperty: "transform",
    transitionDuration: motion.durBase,
    transitionTimingFunction: motion.easeStandard,
  },
  // An indeterminate bar has no fraction to animate toward, so the transition
  // would fight the keyframes; it sweeps a short block instead.
  sweep: {
    position: "absolute",
    insetBlock: 0,
    width: "25%",
    backgroundColor: "currentColor",
    animationName: {
      default: slide,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "1.5s",
    animationIterationCount: "infinite",
    animationTimingFunction: motion.easeStandard,
  },
  neutral: { color: colors.textMuted },
  muted: { color: colors.textSubtle },
  accent: { color: colors.accent },
  positive: { color: colors.signalGreen },
  warning: { color: colors.signalYellow },
  critical: { color: colors.signalRed },
});

const TONE: Record<Tone, XStyle> = {
  neutral: styles.neutral,
  muted: styles.muted,
  accent: styles.accent,
  positive: styles.positive,
  warning: styles.warning,
  critical: styles.critical,
};

export type ProgressProps = Omit<
  React.ComponentPropsWithRef<"div">,
  "color" | "children"
> & {
  /** Completion as a fraction, 0–1. Ignored when `indeterminate`. */
  value?: number;
  /** Work is running but unmeasured. */
  indeterminate?: boolean;
  /** Defaults to `accent`. */
  tone?: Tone;
  /** Defaults to `md`. */
  size?: ProgressSize;
  /** Accessible name — required, since the bar has no visible label. */
  "aria-label"?: string;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
};

export function Progress({
  value = 0,
  indeterminate = false,
  tone = "accent",
  size = "md",
  xstyle,
  className,
  style,
  ...rest
}: ProgressProps) {
  const fraction = clampFraction(value);
  const props = stylex.props(
    styles.track,
    size === "sm" ? styles.sm : styles.md,
    TONE[tone],
    xstyle
  );
  const merged = mergeStyleProps(props, className, style);

  return (
    <div
      role="progressbar"
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 1}
      aria-valuenow={indeterminate ? undefined : fraction}
      {...rest}
      {...merged}
      style={
        indeterminate
          ? merged.style
          : ({
              ...merged.style,
              [cssVars.progress]: fraction,
            } as React.CSSProperties)
      }
    >
      {indeterminate ? (
        <div {...stylex.props(styles.sweep)} />
      ) : (
        <div {...stylex.props(styles.fill)} />
      )}
    </div>
  );
}
