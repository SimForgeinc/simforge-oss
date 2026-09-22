import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { motionRecipe } from "../../stylex/recipes.stylex";
import { colors } from "../../stylex/tokens.stylex";
import { type PlacementStyle, type Tone } from "../stylex/surface";

export type DotSize = "sm" | "md";

/**
 * Dot: a status lamp. Round (`data-shape` opts out of the global square
 * reset). `pulse` makes it breathe while the state is live, and stops under
 * reduced motion. Colour alone never carries meaning, so put the state in
 * text beside it or in `label`.
 *
 *   <Dot tone="positive" /> Ready
 */
export function Dot({
  tone = "neutral",
  size = "sm",
  pulse = false,
  label,
  xstyle,
}: {
  tone?: Tone;
  size?: DotSize;
  pulse?: boolean;
  /** Announced to assistive technology when there is no visible caption. */
  label?: string;
  xstyle?: PlacementStyle;
}) {
  return (
    <span
      data-shape="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...stylex.props(pulse && motionRecipe.pulse, styles.dot, sizes[size], tones[tone], xstyle)}
    />
  );
}

const styles = stylex.create({
  dot: { display: "inline-block", flexShrink: 0, },
});

const sizes = stylex.create({
  sm: { width: "0.375rem", height: "0.375rem" },
  md: { width: "0.5rem", height: "0.5rem" },
});

const tones = stylex.create({
  neutral: { backgroundColor: colors.inkSecondary },
  muted: { backgroundColor: colors.inkFaint },
  accent: { backgroundColor: colors.accent },
  positive: { backgroundColor: colors.positive },
  warning: { backgroundColor: colors.warning },
  critical: { backgroundColor: colors.critical },
});
