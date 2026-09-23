"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import * as stylex from "@stylexjs/stylex";
import * as Dialog from "@radix-ui/react-dialog";
import { MoreHorizontal, X } from "lucide-react";
import { AppSwitcherOverlay } from "./AppSwitcherOverlay";
import SimForgeLogo from "./landing/SimForgeLogo";
import { useTopBarSlotContext } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { mergeStyleProps } from "@simforge-oss/studio-ui/components/stylex";
import { layout } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
import { useDashboardNav } from "@/app/lib/dashboard-nav";
import { cloudPlate, styles } from "./AppTopBar.stylex";
import { textLayout } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

export function AppTopBar() {
  const pathname = usePathname();
  const switcherTriggerRef = useRef<HTMLButtonElement>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const slotCtx = useTopBarSlotContext();
  const { activeItem } = useDashboardNav(pathname);
  const routePageTitle = pathname.startsWith("/dashboard/scenario") ? "Dataset" : activeItem?.label ?? null;
  const header = hasMounted ? slotCtx?.header : null;
  const title = (header?.title || routePageTitle)?.replace(/^SIMFORGE\s*[-—:]\s*/i, "").trim();
  useEffect(() => {
    setHasMounted(true);
    const query = window.matchMedia(layout.bpLg.replace("@media ", ""));
    const update = () => { setWide(query.matches); setOverflowOpen(false); };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => setOverflowOpen(false), [pathname]);
  const actions = <>
    {header?.actions}
    <div ref={slotCtx?.registerActionsSlot} {...stylex.props(styles.actions, slotCtx?.actionsAlignment === "start" ? styles.actionsStart : styles.actionsEnd)} data-topbar-slot="actions" />
    <div ref={slotCtx?.registerTrailingSlot} {...stylex.props(styles.trailing)} data-topbar-slot="trailing" />
  </>;
  return <>
    {/* The global no-drag hook keeps all interactive descendants usable in the native titlebar. */}
    <header {...mergeStyleProps(stylex.props(styles.header), "app-topbar-native")} data-testid="app-topbar">
      <div aria-hidden="true" {...stylex.props(styles.clouds, cloudPlate.plate)} data-testid="app-topbar-clouds" />
      <div {...stylex.props(styles.row)}>
        <button ref={switcherTriggerRef} type="button" onClick={() => setSwitcherOpen(true)} aria-label="Open app switcher" aria-haspopup="dialog" aria-expanded={switcherOpen} {...stylex.props(styles.trigger)}>
          <span {...stylex.props(styles.logo)} data-testid="app-topbar-logo"><SimForgeLogo size={30} /></span>
        </button>
        <div {...stylex.props(styles.content)}>
          <div {...stylex.props(styles.titleRow)} data-topbar-slot="title">
            <span {...stylex.props(styles.brand)} data-topbar-slot="brand">SIMFORGE</span>
            <span aria-hidden="true" {...stylex.props(styles.separator)}>—</span>
            {title ? <h1 {...stylex.props([textLayout.truncate, styles.pageTitle])}>{title}</h1> : null}
            {header?.context ? <span {...stylex.props(styles.context)}>{header.context}</span> : null}
          </div>
          {wide ? <div {...stylex.props(styles.actionGroup)}>{actions}</div> : null}
          {!wide || header?.overflow ? <Dialog.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
            <Dialog.Trigger asChild><button type="button" aria-label="Route actions" {...stylex.props(styles.overflowTrigger)}><MoreHorizontal size={22} /></button></Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay {...stylex.props(styles.menuOverlay)} />
              <Dialog.Content {...stylex.props(styles.menu)} aria-describedby={undefined}>
                <div {...stylex.props(styles.menuHeading)}><Dialog.Title>Route actions</Dialog.Title><Dialog.Close asChild><button type="button" aria-label="Close route actions" {...stylex.props(styles.overflowTrigger)}><X size={20} /></button></Dialog.Close></div>
                <div {...stylex.props(styles.menuActions)}>{!wide ? actions : null}{header?.overflow}</div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root> : null}
        </div>
      </div>
    </header>
    <AppSwitcherOverlay open={switcherOpen} onOpenChange={setSwitcherOpen} pathname={pathname} triggerRef={switcherTriggerRef} />
  </>;
}
