import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { control, focus, interactive } from "../../stylex/recipes.stylex";
import { colors, stroke } from "../../stylex/tokens.stylex";
import { mergeStyleProps, type ControlPlacementStyle } from "../stylex/surface";

export type IconButtonSize = "xs" | "sm" | "md" | "lg";
export type IconButtonVariant = "ghost" | "plate" | "accent";

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  /** The accessible name. Required: an icon is not a label. */
  label: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  /** Pressed/current state; renders `aria-pressed` and the accent look. */
  active?: boolean;
  xstyle?: ControlPlacementStyle;
}

/**
 * IconButton: a square button holding one icon. The icon is sized by the
 * button (`size`), so pass it bare: `<IconButton label="Close"><X /></IconButton>`.
 *
 *  - `ghost` (default): no plate until hovered; for toolbars and row actions.
 *  - `plate`: a faint hairline plate; for standalone controls.
 *  - `accent`: solid accent; for the one primary icon action on a surface.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, size = "sm", variant = "ghost", active, xstyle, type = "button", children, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={props.title ?? label}
      aria-pressed={active === undefined ? undefined : active}
      {...stylex.props(
        focus.ring,
        interactive.base,
        styles.root,
        control[ICON_SIZE[size]],
        variants[variant],
        active && variants.active,
        xstyle,
      )}
      {...props}
    >
      <span aria-hidden="true" {...mergeStyleProps(stylex.props(styles.icon, iconSizes[size]), ICON_FILL)}>{children}</span>
    </button>
  ),
);
IconButton.displayName = "IconButton";

const ICON_SIZE = { xs: "iconXs", sm: "iconSm", md: "iconMd", lg: "iconLg" } as const;

/**
 * The icon is whatever SVG the caller passes, with its own width/height
 * attributes; StyleX only styles the element it is applied to, so the SVG is
 * sized to its box through this descendant selector (the same residual
 * bridge `Button` uses for its icons).
 */
const ICON_FILL = "[&>svg]:size-full [&>svg]:shrink-0";

const styles = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderStyle: "solid",
    borderWidth: stroke.hairline,
    borderColor: "transparent",
    backgroundColor: "transparent",
  },
  icon: { display: "inline-flex" },
});

/** The icon's box; an SVG child fills it. */
const iconSizes = stylex.create({
  xs: { width: "0.75rem", height: "0.75rem" },
  sm: { width: "1rem", height: "1rem" },
  md: { width: "1rem", height: "1rem" },
  lg: { width: "1.25rem", height: "1.25rem" },
});

const variants = stylex.create({
  ghost: {
    color: { default: colors.inkMuted, ":hover": colors.ink },
    backgroundColor: { default: "transparent", ":hover": colors.fill },
  },
  plate: {
    color: { default: colors.inkSecondary, ":hover": colors.ink },
    backgroundColor: { default: colors.fillFaint, ":hover": colors.fill },
    borderColor: { default: colors.hairline, ":hover": colors.hairlineStrong },
  },
  accent: {
    color: colors.accentText,
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
  },
  active: {
    color: colors.accent,
    backgroundColor: colors.accentWash,
    borderColor: colors.accentLineSubtle,
  },
});
