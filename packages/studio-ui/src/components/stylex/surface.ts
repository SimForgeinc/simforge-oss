/**
 * Shared vocabulary for the StyleX primitives: the `tone` a primitive is
 * coloured by (a semantic role, never a literal colour), the `xstyle` types
 * that let a caller place a primitive without reskinning it, and the helper
 * that merges StyleX output with a caller's `className`/`style`.
 */

import type * as React from "react";
import type * as stylex from "@stylexjs/stylex";

/** Semantic colour role shared by readouts, indicators and progress. */
export type Tone =
  | "neutral"
  | "muted"
  | "accent"
  | "positive"
  | "warning"
  | "critical";

/**
 * Caller-supplied StyleX styles. Every primitive takes one and applies it
 * last, so a consumer's own `stylex.create()` output wins on conflicts.
 */
export type XStyle = stylex.StyleXStyles;

/**
 * The properties that make up a primitive's *look*. A caller changes those
 * through the primitive's `variant`, `tone` or `size`, never through
 * `xstyle`; see docs/engineering/studio-style-guide.md.
 */
type SkinProperties = {
  color: string;
  backgroundColor: string;
  backgroundImage: string;
  borderColor: string;
  borderTopColor: string;
  borderBottomColor: string;
  borderInlineStartColor: string;
  borderInlineEndColor: string;
  borderWidth: string;
  borderStyle: string;
  borderRadius: string;
  outlineColor: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineOffset: string;
  boxShadow: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  textTransform: string;
  opacity: string;
  transitionProperty: string;
  transitionDuration: string;
  transitionTimingFunction: string;
  animationName: string;
  backdropFilter: string;
  filter: string;
};

/**
 * `xstyle` for a primitive that owns its look: where it sits and how much
 * room it takes (margin, position, flex/grid placement, width), but not its
 * colours, type, borders, shadows or motion.
 */
export type PlacementStyle = stylex.StyleXStylesWithout<SkinProperties>;

/**
 * `xstyle` for a control, which also owns its geometry through `size`: no
 * height or padding either, so every control on a row keeps one height.
 */
export type ControlPlacementStyle = stylex.StyleXStylesWithout<
  SkinProperties & {
    height: string;
    minHeight: string;
    padding: string;
    paddingInline: string;
    paddingBlock: string;
    paddingLeft: string;
    paddingRight: string;
    paddingTop: string;
    paddingBottom: string;
    gap: string;
  }
>;

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
