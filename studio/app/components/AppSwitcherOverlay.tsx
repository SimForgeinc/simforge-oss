"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { RefObject } from "react";
import type { SwitcherInlineView } from "@/app/lib/dashboard-nav";
import { AppSwitcherPanel } from "@/app/components/AppSwitcherPanel";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { mergeStyleProps } from "@simforge-oss/studio-ui/components/stylex";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";
import { a11y, focus, motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

/**
 * The switcher as a dialog over whatever app is open: the same screen as
 * `/dashboard/apps` (`AppSwitcherPanel`), behind a smoke backdrop, closing on
 * any choice and returning focus to the top-bar trigger.
 */
export function AppSwitcherOverlay({
  open,
  onOpenChange,
  pathname,
  triggerRef,
  initialView = null,
  firstRun = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pathname: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** Open on an inline view instead of the app tabs. */
  initialView?: SwitcherInlineView | null;
  firstRun?: boolean;
}) {
  const close = () => onOpenChange(false);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          {...mergeStyleProps(stylex.props(styles.backdrop), "app-overlay-native")}
          data-testid="app-switcher-backdrop"
        >
          <SkyCloudBackdrop />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          {...stylex.props(styles.dialog)}
          data-testid="app-switcher-dialog"
          data-visual-surface="flat"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogPrimitive.Title {...stylex.props(a11y.srOnly)}>
            Switch app
          </DialogPrimitive.Title>
          <DialogPrimitive.Description {...stylex.props(a11y.srOnly)}>
            Choose a SimForge app or configure local features.
          </DialogPrimitive.Description>
          <DialogPrimitive.Close
            {...stylex.props([focus.ring, motionRecipe.colors, styles.close])}
            aria-label="Close app switcher"
          >
            <X {...stylex.props(styles.closeIcon)} aria-hidden="true" />
          </DialogPrimitive.Close>

          <AppSwitcherPanel pathname={pathname} initialView={initialView} firstRun={firstRun} onNavigate={close} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
