/**
 * StatusIndicator — a lamp, optionally captioned.
 *
 * One mapping from run state to colour, so a queued job is the same yellow in
 * the rail, the job list and the drive HUD. The lamp pulses only while the
 * state is genuinely live, and the pulse is suppressed under
 * `prefers-reduced-motion`.
 *
 * The state name is written out for assistive technology: colour alone never
 * carries the meaning.
 */

import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { colors, motion, space, text } from "../../stylex/tokens.stylex";
import { mergeStyleProps, type XStyle } from "./surface";

/** The run states the product actually distinguishes. */
export type Status =
  | "idle"
  | "pending"
  | "running"
  | "success"
  | "warning"
  | "error";

const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.35 },
});

const styles = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
  },
  lamp: {
    flexShrink: 0,
    width: 8,
    height: 8,
    borderRadius: "9999px",
    backgroundColor: "currentColor",
  },
  lampLg: { width: 10, height: 10 },
  // The halo is what makes a live lamp read as emitting rather than painted.
  live: {
    boxShadow: "0 0 0 3px color-mix(in srgb, currentColor 22%, transparent)",
    animationName: {
      default: pulse,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "1.6s",
    animationIterationCount: "infinite",
    animationTimingFunction: motion.easeStandard,
  },
  caption: {
    color: colors.textMuted,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    letterSpacing: text.trackingMetaWide,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  idle: { color: colors.signalOff },
  pending: { color: colors.signalYellow },
  running: { color: colors.accent },
  success: { color: colors.signalGreen },
  warning: { color: colors.signalYellow },
  error: { color: colors.signalRed },
});

const STATUS: Record<Status, XStyle> = {
  idle: styles.idle,
  pending: styles.pending,
  running: styles.running,
  success: styles.success,
  warning: styles.warning,
  error: styles.error,
};

/** States that are still moving, and so earn the pulse. */
const LIVE: Record<Status, boolean> = {
  idle: false,
  pending: true,
  running: true,
  success: false,
  warning: false,
  error: false,
};

export type StatusIndicatorProps = Omit<
  React.ComponentPropsWithRef<"span">,
  "color" | "children"
> & {
  status: Status;
  /** Visible caption. Without one the status name is exposed to AT only. */
  label?: React.ReactNode;
  /** Larger lamp, for HUD and hero surfaces. Defaults to `false`. */
  large?: boolean;
  /** Force the pulse on or off; defaults to whether the state is live. */
  pulse?: boolean;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
};

export function StatusIndicator({
  status,
  label,
  large = false,
  pulse: pulseProp,
  xstyle,
  className,
  style,
  ...rest
}: StatusIndicatorProps) {
  const props = stylex.props(styles.root, STATUS[status], xstyle);
  const live = pulseProp ?? LIVE[status];

  return (
    <span {...rest} {...mergeStyleProps(props, className, style)}>
      <span
        {...stylex.props(styles.lamp, large && styles.lampLg, live && styles.live)}
      />
      {label === undefined ? null : (
        <span {...stylex.props(styles.caption)}>{label}</span>
      )}
      {/* Colour is not a label. When there is no visible caption the state
          still has to reach a screen reader. */}
      {label === undefined ? <VisuallyHidden>{status}</VisuallyHidden> : null}
    </span>
  );
}

const hidden = stylex.create({
  clip: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    clipPath: "inset(50%)",
    borderWidth: 0,
  },
});

function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return <span {...stylex.props(hidden.clip)}>{children}</span>;
}
