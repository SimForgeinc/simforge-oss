import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { mergeStyleProps } from "../stylex/surface";
import { styles } from "./skeleton.stylex";

/**
 * Loading placeholder. Geometry and tint compose through xstyle; className
 * remains supported for appearance-frozen Tailwind callers.
 */
function Skeleton({
  className,
  style,
  xstyle,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { xstyle?: stylex.StyleXStyles }) {
  return (
    <div
      {...mergeStyleProps(stylex.props(styles.base, xstyle), className, style)}
      {...props}
    />
  );
}

export { Skeleton };
