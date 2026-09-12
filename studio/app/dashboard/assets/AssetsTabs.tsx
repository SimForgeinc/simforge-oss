"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as stylex from "@stylexjs/stylex";
import { shelf } from "./asset-gallery.stylex";

const TABS = [
  { href: "/dashboard/assets", label: "Gallery" },
  { href: "/dashboard/assets/carla", label: "CARLA compatibility" },
] as const;

export function AssetsTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Asset views" {...stylex.props(shelf.tabBar)}>
      <div {...stylex.props(shelf.tabBarInner)}>
        {TABS.map((tab) => {
          const active = tab.href === "/dashboard/assets"
            ? pathname === tab.href
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              {...stylex.props(shelf.tab, active ? shelf.tabActive : shelf.tabIdle)}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
