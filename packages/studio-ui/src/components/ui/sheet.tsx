"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { styles } from "./sheet.stylex";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

type SheetSide = "top" | "bottom" | "left" | "right";

/** Caller-supplied StyleX styles, composed after the part's own so the caller wins per property. */
type SheetStyle = stylex.StyleXStyles;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay ref={ref} {...mergeStyleProps(stylex.props(styles.overlay), className)} {...props} />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> {
  side?: SheetSide;
  xstyle?: SheetStyle;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, xstyle, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <SheetPrimitive.Content
      ref={ref}
      {...mergeStyleProps(stylex.props(styles.content, styles[side], xstyle), className)}
      {...props}
    >
      {children}
      <SheetPrimitive.Close {...mergeStyleProps(stylex.props(styles.close))}>
        <X aria-hidden="true" {...stylex.props(styles.closeIcon)} />
        <span {...stylex.props(styles.srOnly)}>Close</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({ className, xstyle, ...props }: React.HTMLAttributes<HTMLDivElement> & { xstyle?: SheetStyle }) => (
  <div {...mergeStyleProps(stylex.props(styles.header, xstyle), className)} {...props} />
);
SheetHeader.displayName = "SheetHeader";

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div {...mergeStyleProps(stylex.props(styles.footer), className)} {...props} />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title> & { xstyle?: SheetStyle }
>(({ className, xstyle, ...props }, ref) => (
  <SheetPrimitive.Title ref={ref} {...mergeStyleProps(stylex.props(styles.title, xstyle), className)} {...props} />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description> & { xstyle?: SheetStyle }
>(({ className, xstyle, ...props }, ref) => (
  <SheetPrimitive.Description ref={ref} {...mergeStyleProps(stylex.props(styles.description, xstyle), className)} {...props} />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
