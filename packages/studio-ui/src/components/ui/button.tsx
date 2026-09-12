import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import {
  button as buttonBase,
  buttonSizes,
  buttonVariants as buttonVariantStyles,
} from "./controls.stylex";

type ButtonStyle = stylex.StyleXStyles;
type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon";

/**
 * These descendant selectors remain a deliberately tiny Tailwind bridge:
 * Button accepts arbitrary icon components, so their dimensions cannot be
 * inherited from the parent. All root, state, variant, and size styling is
 * compiled by StyleX.
 */
const ICON_CLASS = "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: ButtonVariant | null;
  size?: ButtonSize | null;
  xstyle?: ButtonStyle;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, xstyle, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const styleProps = stylex.props(
      buttonBase.base,
      variant == null ? (variant === null ? null : buttonVariantStyles.default) : buttonVariantStyles[variant],
      size == null ? (size === null ? null : buttonSizes.default) : buttonSizes[size],
      xstyle,
    );
    return (
      <Comp
        {...mergeStyleProps(styleProps, className ? `${ICON_CLASS} ${className}` : ICON_CLASS)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button };
