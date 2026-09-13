"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { styles } from "./dropdown-menu.stylex";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const CONTENT_ANIMATION_CLASS =
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:duration-100 data-[state=open]:duration-150";
const SUBCONTENT_ANIMATION_CLASS =
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2";
// Radix exposes disabled state as an attribute; this is the narrow selector
// bridge retained for that state because StyleX does not target the element's
// own arbitrary attribute without a marker.
const DISABLED_CLASS = "data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
/**
 * Caller-supplied StyleX for a menu part. Composed after the part's own styles
 * so the caller wins per property — a menu that widens `DropdownMenuContent`
 * or recolours a destructive `DropdownMenuItem` cannot do that through
 * `className`, because the part's atoms outrank a plain utility class.
 */
type DropdownStyle = stylex.StyleXStyles;

const compose = (
  stylesToApply: (stylex.StyleXStyles | null | false)[],
  className?: string,
  xstyle?: DropdownStyle,
) => mergeStyleProps(stylex.props(...stylesToApply, xstyle), className);

const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean; xstyle?: DropdownStyle }
>(({ className, inset, children, xstyle, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    {...compose([styles.subTrigger, inset ? styles.inset : null], className, xstyle)}
    {...props}
  >
    {children}
    <ChevronRight {...stylex.props(styles.icon)} />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent> & { xstyle?: DropdownStyle }
>(({ className, xstyle, ...props }, ref) => (
  <DropdownMenuPrimitive.SubContent ref={ref} {...compose([styles.subContent], className ? `${SUBCONTENT_ANIMATION_CLASS} ${className}` : SUBCONTENT_ANIMATION_CLASS, xstyle)} {...props} />
));
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & { xstyle?: DropdownStyle }
>(({ className, sideOffset = 4, xstyle, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content ref={ref} sideOffset={sideOffset} {...compose([styles.content], className ? `${CONTENT_ANIMATION_CLASS} ${className}` : CONTENT_ANIMATION_CLASS, xstyle)} {...props} />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { inset?: boolean; xstyle?: DropdownStyle }
>(({ className, inset, xstyle, ...props }, ref) => (
  <DropdownMenuPrimitive.Item ref={ref} {...compose([styles.item, inset ? styles.inset : null], className ? `${DISABLED_CLASS} ${className}` : DISABLED_CLASS, xstyle)} {...props} />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem> & { xstyle?: DropdownStyle }
>(({ className, children, checked, xstyle, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem ref={ref} {...compose([styles.checkboxItem], className ? `${DISABLED_CLASS} ${className}` : DISABLED_CLASS, xstyle)} checked={checked} {...props}>
    <span {...stylex.props(styles.indicator)}>
      <DropdownMenuPrimitive.ItemIndicator><Check {...stylex.props(styles.icon)} /></DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem> & { xstyle?: DropdownStyle }
>(({ className, children, xstyle, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem ref={ref} {...compose([styles.radioItem], className ? `${DISABLED_CLASS} ${className}` : DISABLED_CLASS, xstyle)} {...props}>
    <span {...stylex.props(styles.indicator)}>
      <DropdownMenuPrimitive.ItemIndicator><Circle {...stylex.props(styles.radioDot)} /></DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean; xstyle?: DropdownStyle }
>(({ className, inset, xstyle, ...props }, ref) => (
  <DropdownMenuPrimitive.Label ref={ref} {...compose([styles.label, inset ? styles.inset : null], className, xstyle)} {...props} />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator> & { xstyle?: DropdownStyle }
>(({ className, xstyle, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} {...compose([styles.separator], className, xstyle)} {...props} />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

const DropdownMenuShortcut = ({ className, xstyle, ...props }: React.HTMLAttributes<HTMLSpanElement> & { xstyle?: DropdownStyle }) => (
  <span {...compose([styles.shortcut], className, xstyle)} {...props} />
);
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";

export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuRadioItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuGroup,
  DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuRadioGroup,
};
