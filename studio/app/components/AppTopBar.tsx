"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import * as stylex from "@stylexjs/stylex";
import { AppSwitcherOverlay } from "@/app/components/AppSwitcherOverlay";
import SimForgeLogo from "@/app/components/landing/SimForgeLogo";
import { useTopBarSlotContext } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { activeNavItem } from "@/app/lib/dashboard-nav";
import { cloudPlate, styles } from "@/app/components/AppTopBar.stylex";

export function AppTopBar() {
  const pathname = usePathname();
  const switcherTriggerRef = useRef<HTMLButtonElement>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);

  const slotCtx = useTopBarSlotContext();
  const activeItem = activeNavItem(pathname);
  const routePageTitle = pathname.startsWith("/dashboard/scenario")
    ? "Dataset"
    : activeItem?.label ?? null;
  // Page-level title effects can commit before this Suspense boundary hydrates.
  // Keep the server snapshot for the hydration render, then accept contextual
  // titles after this component's first client commit.
  const displayPageTitle = hasMounted
    ? slotCtx?.customTitle ?? routePageTitle
    : routePageTitle;
  const unbrandedPageTitle = displayPageTitle
    ?.replace(/^SIMFORGE\s*[-—:]\s*/i, "")
    .trim();

  useEffect(() => {
    setHasMounted(true);
  }, []);



  return (
    <>
      <header
        {...stylex.props(styles.header)}
        data-testid="app-topbar"
      >
        <div
          aria-hidden="true"
          {...stylex.props(styles.clouds, cloudPlate.plate)}
          data-testid="app-topbar-clouds"
        />
        <div {...stylex.props(styles.row)}>
          <button
            ref={switcherTriggerRef}
            type="button"
            onClick={() => setSwitcherOpen(true)}
            aria-label="Open app switcher"
            aria-haspopup="dialog"
            aria-expanded={switcherOpen}
            {...stylex.props(styles.trigger)}
          >
            <span
              {...stylex.props(styles.logo)}
              data-testid="app-topbar-logo"
            >
              <SimForgeLogo size={30} />
            </span>
          </button>

          <div {...stylex.props(styles.content)}>
            {unbrandedPageTitle ? (
              <span
                suppressHydrationWarning
                {...stylex.props(styles.titleRow)}
                data-topbar-slot="title"
                aria-label={`SIMFORGE - ${unbrandedPageTitle}`}
              >
                <span
                  {...stylex.props(styles.brand)}
                  data-topbar-slot="brand"
                >
                  SIMFORGE
                </span>
                <span aria-hidden="true" {...stylex.props(styles.separator)}>
                  -
                </span>
                <span {...stylex.props(styles.pageTitle)}>
                  {unbrandedPageTitle}
                </span>
              </span>
            ) : null}
            <div
              ref={(element) => slotCtx?.registerActionsSlot(element)}
              {...stylex.props(
                styles.actions,
                slotCtx?.actionsAlignment === "start"
                  ? styles.actionsStart
                  : styles.actionsEnd,
              )}
              data-topbar-slot="actions"
            />
            <div
              ref={(element) => slotCtx?.registerTrailingSlot(element)}
              {...stylex.props(styles.trailing)}
              data-topbar-slot="trailing"
            />
          </div>
        </div>
      </header>

      <AppSwitcherOverlay
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        pathname={pathname}
        triggerRef={switcherTriggerRef}
      />
    </>
  );
}
