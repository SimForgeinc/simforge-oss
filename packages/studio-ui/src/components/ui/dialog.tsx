"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { a11y, hairline, motionRecipe, surface, typography } from "../../stylex/recipes.stylex";
import { colors, layers, layout, shadows, space } from "../../stylex/tokens.stylex";
import { type PlacementStyle } from "../stylex/surface";
import { IconButton } from "./icon-button";

/**
 * Dialog: Studio's one modal. Radix does focus trapping, `Escape`, outside
 * clicks and `aria-*`; this adds the look (a raised plate on a scrim, in the
 * `dialog`/`dialogTop` stacking pair) and the layout slots.
 *
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent size="md">
 *       <DialogHeader>
 *         <DialogTitle>Rename dataset</DialogTitle>
 *         <DialogDescription>Visible to everyone in the workspace.</DialogDescription>
 *       </DialogHeader>
 *       <DialogBody>…fields…</DialogBody>
 *       <DialogFooter>
 *         <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
 *         <Button variant="accent">Save</Button>
 *       </DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DialogSize = "sm" | "md" | "lg" | "xl";

export interface DialogContentProps
  extends Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "className" | "style"> {
  size?: DialogSize;
  /** Render the close button in the corner. On by default. */
  showClose?: boolean;
  /** Where the dialog sits and how tall it may grow; not its look. */
  xstyle?: PlacementStyle;
}

export const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ size = "md", showClose = true, xstyle, children, ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay {...stylex.props(surface.scrim, motionRecipe.fadeIn, styles.overlay)} />
      <DialogPrimitive.Content
        ref={ref}
        {...stylex.props(surface.raised, hairline.all, motionRecipe.fadeIn, styles.content, sizes[size], xstyle)}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close asChild>
            <IconButton label="Close" size="sm" xstyle={styles.close}>
              <X />
            </IconButton>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  ),
);
DialogContent.displayName = "DialogContent";

type SlotProps = Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "style"> & { xstyle?: PlacementStyle };

/** Title and description, with room for the close button. */
export function DialogHeader({ xstyle, ...props }: SlotProps) {
  return <div {...stylex.props(styles.header, xstyle)} {...props} />;
}

/** The scrolling middle. */
export function DialogBody({ xstyle, ...props }: SlotProps) {
  return <div {...stylex.props(styles.body, xstyle)} {...props} />;
}

/** Actions, right-aligned, primary last. */
export function DialogFooter({ xstyle, ...props }: SlotProps) {
  return <div {...stylex.props(hairline.top, styles.footer, xstyle)} {...props} />;
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>, "className" | "style">
>((props, ref) => <DialogPrimitive.Title ref={ref} {...stylex.props(typography.title, styles.title)} {...props} />);
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>, "className" | "style"> & { hidden?: boolean }
>(({ hidden, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} {...stylex.props(typography.bodySm, styles.description, hidden && a11y.srOnly)} {...props} />
));
DialogDescription.displayName = "DialogDescription";

const styles = stylex.create({
  overlay: { position: "fixed", inset: 0, zIndex: layers.dialog },
  content: {
    position: "fixed",
    zIndex: layers.dialogTop,
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    display: "flex",
    flexDirection: "column",
    width: `calc(100vw - ${layout.gutter})`,
    maxHeight: `calc(100vh - ${layout.gutterWide})`,
    boxShadow: shadows.elevation2xl,
    backgroundColor: colors.panel,
  },
  close: { position: "absolute", top: space.s3, right: space.s3 },
  header: {
    display: "grid",
    gap: space.s1,
    paddingBlock: space.s5,
    paddingInlineStart: space.s5,
    paddingInlineEnd: space.s12,
  },
  title: { margin: 0 },
  description: { margin: 0, color: colors.inkMuted },
  body: {
    display: "grid",
    gap: space.s4,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: space.s5,
    paddingBottom: space.s5,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: space.s2,
    paddingInline: space.s5,
    paddingBlock: space.s3,
  },
});

const sizes = stylex.create({
  sm: { maxWidth: "24rem" },
  md: { maxWidth: "32rem" },
  lg: { maxWidth: "42rem" },
  xl: { maxWidth: "56rem" },
});
