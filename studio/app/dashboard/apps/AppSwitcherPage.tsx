"use client";

import { usePathname, useSearchParams } from "next/navigation";
import * as stylex from "@stylexjs/stylex";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { useRouteHeader } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { AppSwitcherPanel } from "@/app/components/AppSwitcherPanel";
import type { SwitcherInlineView } from "@/app/lib/dashboard-nav";
import { styles } from "./AppSwitcherPage.stylex";

/**
 * The switcher screen as a page: the same panel the top-bar overlay shows,
 * over the same backdrop. `?view=render-settings` opens it on that inline view.
 */
export function AppSwitcherPage() {
  const pathname = usePathname();
  const view = useSearchParams().get("view");
  useRouteHeader({ title: "Apps" });

  return (
    <div {...stylex.props(styles.page)} data-testid="app-switcher-page" data-visual-surface="flat">
      <SkyCloudBackdrop />
      <AppSwitcherPanel pathname={pathname} initialView={view === "render-settings" ? (view as SwitcherInlineView) : null} onNavigate={() => {}} />
    </div>
  );
}
