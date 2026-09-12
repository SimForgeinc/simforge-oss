/**
 * MetaLabel — the uppercase, tracked-out instrument label.
 *
 * "ACTOR LIBRARY", "INSPECTOR", "LAST RUN". Spelled out per surface as a pile
 * of tracking/size/transform utilities today, which is how the tracking
 * drifted between rails. The `surface` axis picks the face: technical labels
 * use the instrument mono face, expressive ones the body face with tighter
 * tracking, so a product shell does not read as a control panel.
 */

import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { colors, space, text } from "../../stylex/tokens.stylex";
import {
  mergeStyleProps,
  type SurfaceVariant,
  type Tone,
  type XStyle,
} from "./surface";

/** Elements a label is allowed to be. */
export type MetaLabelElement =
  | "span"
  | "div"
  | "p"
  | "label"
  | "dt"
  | "h2"
  | "h3"
  | "h4"
  | "figcaption";

const styles = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    textTransform: "uppercase",
  },
  technical: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    fontWeight: text.weightNormal,
    letterSpacing: text.trackingMetaWider,
    lineHeight: text.lineMicro,
  },
  expressive: {
    fontFamily: text.fontBody,
    fontSize: text.sizeMeta,
    fontWeight: text.weightSemibold,
    letterSpacing: text.trackingMetaTight,
    lineHeight: text.lineMeta,
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

export type MetaLabelProps = Omit<
  React.ComponentPropsWithRef<"span">,
  "color"
> & {
  /** Instrument face versus product face. Defaults to `technical`. */
  surface?: SurfaceVariant;
  /** Semantic colour. Defaults to `muted` — a label is rarely the subject. */
  tone?: Tone;
  /** Element to render. Defaults to `span`. */
  as?: MetaLabelElement;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
};

export function MetaLabel({
  surface = "technical",
  tone = "muted",
  as = "span",
  xstyle,
  className,
  style,
  ...rest
}: MetaLabelProps) {
  const props = stylex.props(
    styles.base,
    surface === "technical" ? styles.technical : styles.expressive,
    TONE[tone],
    xstyle
  );
  // The element set is closed and every member accepts span's props, so this
  // is a widening of known-good tags rather than an escape from typing.
  const Tag = as as "span";

  return <Tag {...rest} {...mergeStyleProps(props, className, style)} />;
}
