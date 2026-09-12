import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { badge as badgeBase, badgeVariants as badgeVariantStyles } from "./controls.stylex";

type BadgeStyle = stylex.StyleXStyles;
type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant | null;
  xstyle?: BadgeStyle;
}

function Badge({ className, variant, xstyle, ...props }: BadgeProps) {
  const styleProps = stylex.props(
    badgeBase.base,
    variant == null ? (variant === null ? null : badgeVariantStyles.default) : badgeVariantStyles[variant],
    xstyle,
  );
  return <div {...mergeStyleProps(styleProps, className)} {...props} />;
}

export { Badge };
