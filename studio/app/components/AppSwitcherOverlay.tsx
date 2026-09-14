"use client";

import Link from "next/link";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Laptop, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { RefObject } from "react";
import { AppSwitcherArt } from "@/app/components/AppSwitcherArt";
import { AppSwitcherGraphicsLevel } from "@/app/components/AppSwitcherGraphicsLevel";
import { CloudAccountChip } from "@/app/components/cloud/CloudAccountCard";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { mergeStyleProps } from "@simforge-oss/studio-ui/components/stylex";
import {
  DASHBOARD_APP_GROUPS,
  DASHBOARD_UTILITIES,
  type NavItem,
} from "@/app/lib/dashboard-nav";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";

/**
 * The switcher is one screen: no scrolling on a desktop viewport. The card
 * groups render as full-width bands that share the height between them, each
 * labelled down its left edge; compact groups drop to the footer as plain
 * buttons beside the cloud account.
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
  const bands = DASHBOARD_APP_GROUPS.filter((group) => !group.compact);
  const compact = DASHBOARD_APP_GROUPS.filter((group) => group.compact);

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
            <div
              aria-hidden="true"
              data-testid="app-switcher-sky-ambience"
              {...stylex.props(styles.ambience)}
            />
            <div {...stylex.props(styles.stage)} aria-label="SimForge apps">
              {bands.map((group, bandIndex) => {
                const offset = bands
                  .slice(0, bandIndex)
                  .reduce((count, previous) => count + previous.apps.length, 0);
                const headingId = `app-switcher-group-${group.id}`;
                return (
                  <section
                    aria-labelledby={headingId}
                    data-testid={`app-switcher-group-${group.id}`}
                    key={group.id}
                    {...stylex.props(styles.band)}
                  >
                    <header {...stylex.props(styles.bandRail)}>
                      <h2 id={headingId} {...stylex.props(styles.bandLabel)}>
                        {group.label}
                      </h2>
                      <span aria-hidden="true" {...stylex.props(styles.bandRule)} />
                      <p {...stylex.props(styles.bandDescription)}>
                        {group.description}
                      </p>
                    </header>
                    <div
                      {...stylex.props(
                        styles.bandGrid,
                        styles.bandColumns(group.apps.length),
                      )}
                    >
                      {group.apps.map((app, appIndex) => (
                        <AppCard
                          active={!app.disabled && app.match(pathname)}
                          app={app}
                          hero={group.apps.length === 1}
                          index={offset + appIndex}
                          key={app.href}
                          onOpen={close}
                        />
                      ))}
                    </div>
                  </section>
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

                {compact.map((group) => (
                  <nav
                    aria-label={group.label}
                    data-testid={`app-switcher-group-${group.id}`}
                    key={group.id}
                    {...stylex.props(
                      styles.utilities,
                      styles.utilityColumns(group.apps.length),
                    )}
                  >
                    {group.apps.map((item) => (
                      <UtilityLink
                        active={!item.disabled && item.match(pathname)}
                        item={item}
                        key={item.href}
                        onOpen={close}
                      />
                    ))}
                  </nav>
                ))}

                <CloudAccountChip onNavigate={close} />

                <nav
                  aria-label="App utilities"
                  {...stylex.props(
                    styles.utilities,
                    styles.utilityColumns(DASHBOARD_UTILITIES.length),
                  )}
                >
                  {DASHBOARD_UTILITIES.map((item) => (
                    <UtilityLink
                      active={item.match(pathname)}
                      item={item}
                      key={item.href}
                      onOpen={close}
                    />
                  ))}
                </nav>
              </div>
              <AppSwitcherGraphicsLevel />
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function AppCard({
  active,
  app,
  hero,
  index,
  onOpen,
}: {
  active: boolean;
  app: NavItem;
  /** The wide lead card of a two-card band; its art tile is larger. */
  hero: boolean;
  index: number;
  onOpen: () => void;
}) {
  const content = (
    <>
      <span {...stylex.props(styles.cardHead)}>
        <span {...stylex.props(styles.cardIndex)}>0{index + 1}</span>
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
          {app.disabled ? "In development" : active ? "Current" : "Available"}
        </span>
      </span>
      <span
        {...stylex.props(
          styles.art,
          hero && styles.artHero,
          active ? styles.artActive : styles.artIdle,
        )}
      >
        <AppSwitcherArt
          href={app.href}
          xstyle={hero ? styles.artImageHero : styles.artImage}
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
        <span {...stylex.props(styles.description)}>{app.description}</span>
      </span>
      <span
        {...stylex.props(
          styles.meta,
          active ? styles.metaActive : styles.metaIdle,
        )}
      >
        <span>
          {app.disabled ? "Coming soon" : active ? "You are here" : "Open app"}
        </span>
        {!app.disabled ? (
          <span aria-hidden="true" {...stylex.props(styles.metaArrow)}>
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
