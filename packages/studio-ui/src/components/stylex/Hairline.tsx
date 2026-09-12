/**
 * Hairline — a one-pixel rule.
 *
 * Separator chrome is the most-duplicated thing in the tree: a div with a
 * border colour, sometimes vertical, sometimes inset. An expressive rule fades
 * at both ends, because a hard rule across a blurred pane reads as a seam.
 *
 * Presentational by default. Pass `role="separator"` yourself when the
 * division is semantic rather than decorative.
 */

import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { colors, space } from "../../stylex/tokens.stylex";
import { mergeStyleProps, type SurfaceVariant, type XStyle } from "./surface";

const styles = stylex.create({
  base: { flexShrink: 0, border: 0, margin: 0 },
  horizontal: { width: "100%", height: 1, backgroundColor: colors.line },
  vertical: {
    alignSelf: "stretch",
    width: 1,
    minHeight: "100%",
    backgroundColor: colors.line,
  },
  fadeHorizontal: {
    backgroundColor: "transparent",
    backgroundImage: `linear-gradient(to right, transparent, ${colors.line} 12%, ${colors.line} 88%, transparent)`,
  },
  fadeVertical: {
    backgroundColor: "transparent",
    backgroundImage: `linear-gradient(to bottom, transparent, ${colors.line} 12%, ${colors.line} 88%, transparent)`,
  },
  insetHorizontal: { width: "auto", marginInline: space.lg },
  insetVertical: { minHeight: "auto", marginBlock: space.lg },
});

export type HairlineProps = Omit<
  React.ComponentPropsWithRef<"div">,
  "color" | "children"
> & {
  /** Rule direction. Defaults to `horizontal`. */
  orientation?: "horizontal" | "vertical";
  /** Instrument rule versus one that fades into glass. */
  surface?: SurfaceVariant;
  /** Hold the rule off the container's edges. */
  inset?: boolean;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
};

export function Hairline({
  orientation = "horizontal",
  surface = "technical",
  inset = false,
  xstyle,
  className,
  style,
  ...rest
}: HairlineProps) {
  const vertical = orientation === "vertical";
  const props = stylex.props(
    styles.base,
    vertical ? styles.vertical : styles.horizontal,
    surface === "expressive" &&
      (vertical ? styles.fadeVertical : styles.fadeHorizontal),
    inset && (vertical ? styles.insetVertical : styles.insetHorizontal),
    xstyle
  );

  return (
    <div
      aria-hidden={rest.role === undefined ? true : undefined}
      {...rest}
      {...mergeStyleProps(props, className, style)}
    />
  );
}
