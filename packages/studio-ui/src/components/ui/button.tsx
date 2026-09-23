import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import * as stylex from "@stylexjs/stylex";

import { focus, motionRecipe } from "../../stylex/recipes.stylex";
import { mergeStyleProps } from "../stylex/surface";
import {
  button as buttonBase,
  buttonSizes,
  buttonVariants as buttonVariantStyles,
} from "./controls.stylex";

type ButtonStyle = stylex.StyleXStyles;
export type ButtonVariant =
  | "default"
  | "destructive"
  | "outline"
  | "secondary"
  | "ghost"
  | "link"
  | "accent"
  | "plate"
  | "accentOutline"
  | "quiet";
export type ButtonSize = "default" | "xs" | "sm" | "md" | "lg" | "xl" | "icon" | "iconXs" | "iconSm" | "iconMd";

/**
 * These descendant selectors remain a deliberately tiny Tailwind bridge:
 * Button accepts arbitrary icon components, so their dimensions cannot be
 * inherited from the parent. All root, state, variant, and size styling is
 * compiled by StyleX.
 *
 * This is the "descendant selector into DOM this element does not render"
 * residual of the migration doc: the declarations belong on SVGs the caller
 * passes in, and StyleX only styles the element it is applied to.
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
      focus.ring,
      motionRecipe.colors,
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
