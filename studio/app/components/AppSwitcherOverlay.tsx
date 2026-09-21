"use client";

import Link from "next/link";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { RefObject } from "react";
import { AppSwitcherGraphicsLevel } from "@/app/components/AppSwitcherGraphicsLevel";
import { SwitcherAccount } from "@/app/components/SwitcherAccount";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { mergeStyleProps } from "@simforge-oss/studio-ui/components/stylex";
import { useDashboardNav, type NavItem } from "@/app/lib/dashboard-nav";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";

/**
 * The switcher is one screen with three tabs — Maps, Datasets, Evaluation —
 * and nothing else above the fold: no artwork, no card index, no per-app
 * badges. Each tab carries its name, what the page is, and the three things it
 * does. Utilities, the cloud account and the graphics level sit on one footer
 * line under them.
 */
export function AppSwitcherOverlay({
  open,
  onOpenChange,
  pathname,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pathname: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const close = () => onOpenChange(false);
  const { apps, utilities, capabilities } = useDashboardNav(pathname);

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
          <DialogPrimitive.Title {...stylex.props(styles.srOnly)}>
            Switch app
          </DialogPrimitive.Title>
          <DialogPrimitive.Description {...stylex.props(styles.srOnly)}>
            Choose a SimForge app or configure local features.
          </DialogPrimitive.Description>
          <DialogPrimitive.Close
            {...stylex.props(styles.close)}
            aria-label="Close app switcher"
          >
            <X {...stylex.props(styles.closeIcon)} aria-hidden="true" />
          </DialogPrimitive.Close>

          <div {...stylex.props(styles.container)}>
            <nav
              {...stylex.props(styles.tabs)}
              aria-label="SimForge apps"
              data-testid="app-switcher-tabs"
            >
              {apps.map((app) => (
                <AppTab
                  active={!app.disabled && app.match(pathname)}
                  app={app}
                  key={app.href}
                  onOpen={close}
                />
              ))}
            </nav>

            <div {...stylex.props(styles.footer)} data-testid="app-switcher-footer">
              <nav
                aria-label="App utilities"
                {...stylex.props(styles.utilities)}
              >
                {utilities.map((item) => (
                  <UtilityLink
                    active={item.match(pathname)}
                    item={item}
                    key={item.href}
                    onOpen={close}
                  />
                ))}
              </nav>
              <div {...stylex.props(styles.footerAside)}>
                <SwitcherAccount capabilities={capabilities} onNavigate={close} />
                <AppSwitcherGraphicsLevel />
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function AppTab({
  active,
  app,
  onOpen,
}: {
  active: boolean;
  app: NavItem;
  onOpen: () => void;
}) {
  const Icon = app.icon;
  const content = (
    <>
      <span {...stylex.props(styles.tabHead)}>
        <Icon
          {...stylex.props(styles.tabIcon, active && styles.tabIconActive)}
          aria-hidden="true"
        />
        <span
          {...stylex.props(styles.tabTitle, active ? styles.tabTitleActive : styles.tabTitleIdle)}
        >
          {app.label}
        </span>
      </span>
      <span {...stylex.props(styles.tabDescription)}>{app.description}</span>
      {app.highlights !== undefined ? (
        <span {...stylex.props(styles.tabHighlights)}>
          {app.highlights.map((highlight) => (
            <span key={highlight} {...stylex.props(styles.tabHighlight)}>
              {highlight}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
  const tabProps = stylex.props(
    styles.tab,
    app.disabled ? styles.tabDisabled : active ? styles.tabActive : styles.tabIdle,
  );

  return app.disabled ? (
    <button
      aria-label={`${app.label} — Coming soon`}
      {...tabProps}
      data-app={app.label}
      data-visual-treatment="disabled"
      disabled
      type="button"
    >
      {content}
    </button>
  ) : (
    <Link
      aria-current={active ? "page" : undefined}
      {...tabProps}
      data-app={app.label}
      data-visual-treatment="open"
      href={app.href}
      onClick={onOpen}
    >
      {content}
    </Link>
  );
}

function UtilityLink({
  active,
  item,
  onOpen,
}: {
  active: boolean;
  item: NavItem;
  onOpen: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      aria-current={active ? "page" : undefined}
      {...stylex.props(
        styles.utility,
        active ? styles.utilityActive : styles.utilityIdle,
      )}
      href={item.href}
      onClick={onOpen}
    >
      <Icon {...stylex.props(styles.utilityIcon)} aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}
