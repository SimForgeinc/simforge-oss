"use client";

import Link from "next/link";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Laptop, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { RefObject } from "react";
import { AppSwitcherArt } from "@/app/components/AppSwitcherArt";
import { CloudConnectionChip } from "@/app/components/cloud/CloudConnectionCard";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { DASHBOARD_APPS, DASHBOARD_UTILITIES } from "@/app/lib/dashboard-nav";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";

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

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          {...stylex.props(styles.backdrop)}
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
            <div
              aria-hidden="true"
              data-testid="app-switcher-sky-ambience"
              {...stylex.props(styles.ambience)}
            />
            <div {...stylex.props(styles.grid)} aria-label="SimForge apps">
              {DASHBOARD_APPS.map((app, index) => {
                const active = !app.disabled && app.match(pathname);
                const content = (
                  <>
                    <span {...stylex.props(styles.cardHead)}>
                      <span {...stylex.props(styles.cardIndex)}>
                        0{index + 1}
                      </span>
                      <span
                        {...stylex.props(
                          styles.badge,
                          app.disabled
                            ? styles.badgeDisabled
                            : active
                              ? styles.badgeActive
                              : styles.badgeIdle,
                        )}
                      >
                        {app.disabled
                          ? "In development"
                          : active
                            ? "Current"
                            : "Available"}
                      </span>
                    </span>
                    <span
                      {...stylex.props(
                        styles.art,
                        active ? styles.artActive : styles.artIdle,
                      )}
                    >
                      <AppSwitcherArt
                        href={app.href}
                        xstyle={styles.artImage}
                      />
                    </span>
                    <span {...stylex.props(styles.copy)}>
                      <span
                        {...stylex.props(
                          styles.title,
                          active ? styles.titleActive : styles.titleIdle,
                        )}
                      >
                        {app.label}
                      </span>
                      <span {...stylex.props(styles.description)}>
                        {app.description}
                      </span>
                    </span>
                    <span
                      {...stylex.props(
                        styles.meta,
                        active ? styles.metaActive : styles.metaIdle,
                      )}
                    >
                      <span>
                        {app.disabled
                          ? "Coming soon"
                          : active
                            ? "You are here"
                            : "Open app"}
                      </span>
                      {!app.disabled ? (
                        <span
                          aria-hidden="true"
                          {...stylex.props(styles.metaArrow)}
                        >
                          ↗
                        </span>
                      ) : null}
                    </span>
                  </>
                );
                const cardProps = stylex.props(
                  styles.card,
                  app.disabled
                    ? styles.cardDisabled
                    : active
                      ? styles.cardActive
                      : styles.cardIdle,
                );

                return app.disabled ? (
                  <button
                    aria-label={`${app.label} — Coming soon`}
                    {...cardProps}
                    data-visual-treatment="disabled"
                    disabled
                    key={app.href}
                    type="button"
                  >
                    {content}
                  </button>
                ) : (
                  <Link
                    aria-current={active ? "page" : undefined}
                    {...cardProps}
                    data-visual-treatment="open"
                    href={app.href}
                    key={app.href}
                    onClick={close}
                  >
                    {content}
                  </Link>
                );
              })}
            </div>

            <div data-testid="app-switcher-footer">
              <div {...stylex.props(styles.footerGrid)}>
                <div {...stylex.props(styles.workspace)}>
                  <Laptop
                    {...stylex.props(styles.workspaceIcon)}
                    aria-hidden="true"
                  />
                  <div {...stylex.props(styles.workspaceBody)}>
                    <p {...stylex.props(styles.workspaceLabel)}>Workspace</p>
                    <p {...stylex.props(styles.workspaceName)}>This computer</p>
                    <p {...stylex.props(styles.workspaceHint)}>
                      Projects, jobs and renders stay local
                    </p>
                  </div>
                </div>

                <CloudConnectionChip onNavigate={close} />

                <nav
                  aria-label="App utilities"
                  {...stylex.props(
                    styles.utilities,
                    styles.utilityColumns(DASHBOARD_UTILITIES.length),
                  )}
                >
                  {DASHBOARD_UTILITIES.map((item) => {
                    const active = item.match(pathname);
                    const Icon = item.icon;
                    return (
                      <Link
                        aria-current={active ? "page" : undefined}
                        {...stylex.props(
                          styles.utility,
                          active ? styles.utilityActive : styles.utilityIdle,
                        )}
                        href={item.href}
                        key={item.href}
                        onClick={close}
                      >
                        <Icon
                          {...stylex.props(styles.utilityIcon)}
                          aria-hidden="true"
                        />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </nav>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
