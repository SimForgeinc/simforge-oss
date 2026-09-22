/**
 * MetaLabel: the uppercase, tracked-out instrument label ("ACTOR LIBRARY",
 * "LAST RUN", a stat's name). It is the `typography.eyebrow` recipe with a
 * `tone`, as a component, for the places a label is an element of its own.
 * Where the label is already an element you style, compose
 * `typography.eyebrow` directly instead.
 */

import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { typography } from "../../stylex/recipes.stylex";
import { colors } from "../../stylex/tokens.stylex";
import { type PlacementStyle, type Tone } from "./surface";

/** Elements a label is allowed to be. */
export type MetaLabelElement = "span" | "div" | "p" | "label" | "dt" | "h2" | "h3" | "h4" | "figcaption";

export type MetaLabelProps = Omit<React.ComponentPropsWithRef<"span">, "color" | "className" | "style"> & {
  /** Semantic colour. Defaults to `muted`: a label is rarely the subject. */
  tone?: Tone;
  /** Element to render. Defaults to `span`. */
  as?: MetaLabelElement;
  xstyle?: PlacementStyle;
};

export function MetaLabel({ tone = "muted", as = "span", xstyle, ...rest }: MetaLabelProps) {
  // The element set is closed and every member accepts span's props.
  const Tag = as as "span";
  return <Tag {...rest} {...stylex.props(typography.eyebrow, styles.root, tones[tone], xstyle)} />;
}

const styles = stylex.create({
  root: { display: "inline-flex", alignItems: "center", margin: 0 },
});

const tones = stylex.create({
  neutral: { color: colors.inkSecondary },
  muted: { color: colors.inkMuted },
  accent: { color: colors.accent },
  positive: { color: colors.positive },
  warning: { color: colors.warning },
  critical: { color: colors.critical },
});
