/**
 * TechnicalPanel — the technical end of the surface axis.
 *
 * Instrument chrome: opaque, hairline-ruled, no atmosphere. Rails, inspectors,
 * provenance blocks, diagnostic tables. The optional `label` renders the
 * panel's own header row — a meta label above a rule — because a technical
 * pane is rarely unlabelled, and hand-assembling that row per surface is how
 * label styling drifts.
 */

import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { colors, motion, space, text } from "../../stylex/tokens.stylex";
import { mergeStyleProps, type PadStep, type XStyle } from "./surface";

/** Interior rhythm: rail density versus body density. */
export type PanelDensity = "compact" | "regular";

const styles = stylex.create({
  base: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.line,
    color: colors.text,
    transitionProperty: "border-color, background-color",
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeSnappy,
  },
  /** Recessed, for a pane nested inside another technical pane. */
  sunken: { backgroundColor: colors.surfaceDeep },
  /** Lifted, for the active pane in a stack. */
  raised: { backgroundColor: colors.panel2 },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
    color: colors.textMuted,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    letterSpacing: text.trackingMetaWider,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
  },
  headerCompact: { paddingBlock: space.sm, paddingInline: space.lg },
  headerRegular: { paddingBlock: space.md, paddingInline: space.xl },
  body: { minWidth: 0, flex: 1 },
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

/** Density picks the interior step when `padding` is not given. */
const DENSITY_PAD: Record<PanelDensity, PadStep> = {
  compact: "sm",
  regular: "lg",
};

export type TechnicalPanelProps = Omit<
  React.ComponentPropsWithRef<"div">,
  "color" | "title"
> & {
  /** Interior rhythm. Defaults to `regular`. */
  density?: PanelDensity;
  /** Depth relative to the surrounding chrome. */
  tone?: "default" | "sunken" | "raised";
  /** Meta-label header row, rendered above a rule when present. */
  label?: React.ReactNode;
  /** Trailing header content — a counter, a toggle, a status dot. */
  action?: React.ReactNode;
  /** Interior spacing override; the default follows `density`. */
  padding?: PadStep;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
};

export function TechnicalPanel({
  density = "regular",
  tone = "default",
  label,
  action,
  padding,
  xstyle,
  className,
  style,
  children,
  ...rest
}: TechnicalPanelProps) {
  const props = stylex.props(
    styles.base,
    tone === "sunken" && styles.sunken,
    tone === "raised" && styles.raised,
    xstyle
  );

  return (
    <div {...rest} {...mergeStyleProps(props, className, style)}>
      {label !== undefined || action !== undefined ? (
        <div
          {...stylex.props(
            styles.header,
            density === "compact" ? styles.headerCompact : styles.headerRegular
          )}
        >
          <span>{label}</span>
          {action}
        </div>
      ) : null}
      {/* The body carries the padding, so the header rule can span the full
          panel width while the content stays inset. */}
      <div {...stylex.props(styles.body, PAD[padding ?? DENSITY_PAD[density]])}>
        {children}
      </div>
    </div>
  );
}
