/**
 * MetricReadout — a number the machine is telling you.
 *
 * Speed, frame time, scenario counts, disk reserve. The value is tabular so
 * digits do not jitter as they tick, the unit rides at meta size beside it,
 * and the optional label sits above in the instrument face.
 *
 * Values arrive pre-formatted: rounding, unit conversion and locale are the
 * caller's decisions, and a primitive that guessed them would be wrong on
 * every surface that already made the choice.
 */

import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { MetaLabel } from "./MetaLabel";
import { colors, space, text } from "../../stylex/tokens.stylex";
import {
  mergeStyleProps,
  type SurfaceVariant,
  type Tone,
  type XStyle,
} from "./surface";

export type MetricSize = "sm" | "md" | "lg";

const styles = stylex.create({
  base: {
    display: "inline-flex",
    flexDirection: "column",
    gap: space.xxs,
    minWidth: 0,
  },
  row: { display: "flex", alignItems: "baseline", gap: space.xs },
  value: {
    fontVariantNumeric: "tabular-nums",
    // Tabular figures alone still let a glyph-width change shift the row;
    // fixing the advance is what keeps a per-frame readout from jittering.
    fontFeatureSettings: '"tnum" 1',
    lineHeight: text.lineTight,
  },
  technical: { fontFamily: text.fontMeta, fontWeight: text.weightNormal },
  expressive: { fontFamily: text.fontDisplay, fontWeight: text.weightSemibold },
  sm: { fontSize: text.sizeSm },
  md: { fontSize: text.sizeLg },
  lg: { fontSize: text.size2xl },
  unit: {
    color: colors.textSubtle,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    letterSpacing: text.trackingMetaNarrow,
    textTransform: "uppercase",
  },
  neutral: { color: colors.text },
  muted: { color: colors.textMuted },
  accent: { color: colors.accent },
  positive: { color: colors.signalGreen },
  warning: { color: colors.signalYellow },
  critical: { color: colors.dangerText },
});

const TONE: Record<Tone, XStyle> = {
  neutral: styles.neutral,
  muted: styles.muted,
  accent: styles.accent,
  positive: styles.positive,
  warning: styles.warning,
  critical: styles.critical,
};

const SIZE: Record<MetricSize, XStyle> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

export type MetricReadoutProps = Omit<
  React.ComponentPropsWithRef<"div">,
  "color" | "children"
> & {
  /** The formatted number. */
  value: React.ReactNode;
  /** Unit suffix — "km/h", "ms", "GB". */
  unit?: React.ReactNode;
  /** Caption above the value, in the instrument face. */
  label?: React.ReactNode;
  /** Defaults to `md`. */
  size?: MetricSize;
  /** Defaults to `neutral`. */
  tone?: Tone;
  /** Instrument face versus product face. Defaults to `technical`. */
  surface?: SurfaceVariant;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
};

export function MetricReadout({
  value,
  unit,
  label,
  size = "md",
  tone = "neutral",
  surface = "technical",
  xstyle,
  className,
  style,
  ...rest
}: MetricReadoutProps) {
  const props = stylex.props(styles.base, xstyle);

  return (
    <div {...rest} {...mergeStyleProps(props, className, style)}>
      {/* The caption is a meta label, not a lookalike: one definition of the
          instrument caption keeps readouts and panel headers in step. */}
      {label !== undefined ? <MetaLabel>{label}</MetaLabel> : null}
      <span {...stylex.props(styles.row)}>
        <span
          {...stylex.props(
            styles.value,
            surface === "technical" ? styles.technical : styles.expressive,
            SIZE[size],
            TONE[tone]
          )}
        >
          {value}
        </span>
        {unit !== undefined ? (
          <span {...stylex.props(styles.unit)}>{unit}</span>
        ) : null}
      </span>
    </div>
  );
}
