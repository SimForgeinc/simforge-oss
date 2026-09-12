/**
 * Shared vocabulary for the StyleX primitives in this folder.
 *
 * Two axes run through them:
 *
 *   - `surface` — "technical" chrome (flat, hairline-ruled, instrument type)
 *     versus "expressive" chrome (glass, blur, soft elevation, product type).
 *   - `tone` — a semantic colour role, never a literal colour.
 *
 * Runtime numbers — a progress fraction, an overlay inset — are deliberately
 * not style variants. StyleX compiles `create()` ahead of time, so a variant
 * per value would mean a class per value; they travel instead as CSS custom
 * properties on the element's inline `style`, named once here so a consumer
 * can read or override them.
 */

import type * as React from "react";
import type * as stylex from "@stylexjs/stylex";

/** Character of a surface: instrument chrome versus product chrome. */
export type SurfaceVariant = "technical" | "expressive";

/** Semantic colour role shared by readouts, indicators and progress. */
export type Tone =
  | "neutral"
  | "muted"
  | "accent"
  | "positive"
  | "warning"
  | "critical";

/** Spacing step, mapped onto the foundation's `space` scale. */
export type PadStep = "none" | "xs" | "sm" | "md" | "lg" | "xl";

/**
 * Caller-supplied StyleX styles. Every primitive takes one and applies it
 * last, so a consumer's own `stylex.create()` output wins on conflicts.
 */
export type XStyle = stylex.StyleXStyles;

/** CSS custom properties the primitives read at runtime. */
export const cssVars = {
  /** Progress fill fraction, 0–1, unitless. */
  progress: "--sfx-progress",
  /** Distance a `WorldOverlay` is held off its anchored edges. */
  overlayInset: "--sfx-overlay-inset",
} as const;

/**
 * Merge StyleX output with a caller's `className` / `style`.
 *
 * StyleX owns both slots, and so does the caller while Tailwind is still in
 * the tree. Nothing here runs `twMerge`: StyleX's atomic class names are
 * opaque to it and must not be dropped as phantom conflicts. Tailwind classes
 * come last so the cascade resolves them as the rest of the app expects.
 */
export function mergeStyleProps(
  styleXProps: { className?: string; style?: React.CSSProperties },
  className?: string,
  style?: React.CSSProperties
): { className?: string; style?: React.CSSProperties } {
  const classes = className
    ? styleXProps.className
      ? `${styleXProps.className} ${className}`
      : className
    : styleXProps.className;
  const merged =
    styleXProps.style && style
      ? { ...styleXProps.style, ...style }
      : styleXProps.style ?? style;

  return {
    ...(classes ? { className: classes } : null),
    ...(merged ? { style: merged } : null),
  };
}

/** Clamp a caller-supplied fraction into 0–1, tolerating junk input. */
export function clampFraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}
