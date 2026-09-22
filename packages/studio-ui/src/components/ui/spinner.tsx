import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { motionRecipe } from "../../stylex/recipes.stylex";
import { colors, stroke } from "../../stylex/tokens.stylex";
import { type PlacementStyle } from "../stylex/surface";

export type SpinnerSize = "xs" | "sm" | "md" | "lg";
export type SpinnerTone = "accent" | "ink" | "muted";

/**
 * Spinner: a ring with one open quarter, turning. Round (`data-shape`
 * opts out of the global square reset), stops under reduced motion, and
 * announces itself as a status. Use it for "working"; use `Dot` for a state.
 *
 *   <Spinner size="sm" label="Loading scenarios" />
 */
export function Spinner({
  size = "sm",
  tone = "accent",
  label = "Loading",
  xstyle,
}: {
  size?: SpinnerSize;
  tone?: SpinnerTone;
  /** Announced to assistive technology. Pass `null` when a caption beside it already says it. */
  label?: string | null;
  xstyle?: PlacementStyle;
}) {
  return (
    <span
      data-shape="round"
      role={label ? "status" : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      {...stylex.props(motionRecipe.spin, styles.ring, sizes[size], tones[tone], xstyle)}
    />
  );
}

const styles = stylex.create({
  ring: {
    display: "inline-block",
    flexShrink: 0,
    boxSizing: "border-box",
    borderStyle: "solid",
    borderWidth: stroke.thick,
    borderTopColor: "transparent",
  },
});

const sizes = stylex.create({
  xs: { width: "0.75rem", height: "0.75rem", borderWidth: stroke.hairline },
  sm: { width: "1rem", height: "1rem" },
  md: { width: "1.5rem", height: "1.5rem" },
  lg: { width: "2rem", height: "2rem" },
});

const tones = stylex.create({
  accent: { borderColor: colors.accent, borderTopColor: "transparent" },
  ink: { borderColor: colors.ink, borderTopColor: "transparent" },
  muted: { borderColor: colors.inkMuted, borderTopColor: "transparent" },
});
