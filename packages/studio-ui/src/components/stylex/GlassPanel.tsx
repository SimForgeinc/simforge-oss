/**
 * GlassPanel — the expressive end of the surface axis.
 *
 * A translucent, blurred pane that lets what is behind it through: overlays on
 * the drive canvas, shells over the onboarding sky, dialog bodies. Its
 * counterpart is `TechnicalPanel`, the same pane with the atmosphere removed.
 */

import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { colors, motion, space } from "../../stylex/tokens.stylex";
import { mergeStyleProps, type PadStep, type XStyle } from "./surface";

/** How far the pane lifts off what is behind it. */
export type GlassElevation = "flat" | "low" | "high";

const styles = stylex.create({
  base: {
    position: "relative",
    minWidth: 0,
    backdropFilter: motion.blurGlass,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.line,
    color: colors.text,
    transitionProperty: "background-color, border-color",
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeExpressive,
  },
  // Elevation is weight and shadow together: a pane that reads as higher is
  // also lighter, the way the existing overlays are authored.
  flat: {},
  low: {
    backgroundColor: colors.glassRaised,
    boxShadow: "0 10px 30px -18px rgba(0, 0, 0, 0.78)",
  },
  high: {
    backgroundColor: colors.glassRaised,
    borderColor: colors.lineStrong,
    boxShadow: "0 24px 64px -22px rgba(0, 0, 0, 0.85)",
  },
  interactive: {
    backgroundColor: { default: null, ":hover": colors.glassHover },
    borderColor: { default: null, ":hover": colors.lineStrong },
  },
  padNone: { padding: space.none },
  padXs: { padding: space.xs },
  padSm: { padding: space.sm },
  padMd: { padding: space.lg },
  padLg: { padding: space.xl },
  padXl: { padding: space.xxl },
});

const PAD: Record<PadStep, XStyle> = {
  none: styles.padNone,
  xs: styles.padXs,
  sm: styles.padSm,
  md: styles.padMd,
  lg: styles.padLg,
  xl: styles.padXl,
};

const ELEVATION: Record<GlassElevation, XStyle> = {
  flat: styles.flat,
  low: styles.low,
  high: styles.high,
};

export type GlassPanelProps = Omit<
  React.ComponentPropsWithRef<"div">,
  "color"
> & {
  /** Lift off the backdrop. Defaults to `low`. */
  elevation?: GlassElevation;
  /** Interior spacing from the shared scale. Defaults to `md`. */
  padding?: PadStep;
  /** Respond to hover — for panes that are themselves a control. */
  interactive?: boolean;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
};

export function GlassPanel({
  elevation = "low",
  padding = "md",
  interactive = false,
  xstyle,
  className,
  style,
  ...rest
}: GlassPanelProps) {
  const props = stylex.props(
    styles.base,
    ELEVATION[elevation],
    PAD[padding],
    interactive && styles.interactive,
    xstyle
  );

  return <div {...rest} {...mergeStyleProps(props, className, style)} />;
}
