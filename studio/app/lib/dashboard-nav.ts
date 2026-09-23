"use client";

import { useMemo } from "react";
import {
  Boxes,
  Brain,
  Cloud,
  Database,
  FlaskConical,
  HardDriveDownload,
  Map,
  MonitorCog,
  PackageCheck,
  Settings,
  UserRound,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { isCloudHost, type StudioHostCapabilities, type StudioHostNavIcon } from "@simforge-oss/studio-host";
import { useStudioHostCapabilities } from "@simforge-oss/studio-host/react";
import { studioHost } from "@/app/lib/host";

export type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
  /** What the page is for, in three phrases; shown on the switcher's tabs. */
  highlights?: readonly string[];
  /**
   * The surface is about the machine this installation runs on, so a cloud
   * host — which is not that machine — does not offer it at all.
   */
  localOnly?: boolean;
  disabled?: boolean;
  /**
   * A utility the switcher shows inline instead of navigating to: the
   * switcher's content becomes this view and `href` is only its deep link.
   */
  inlineView?: SwitcherInlineView;
};

/** Views the app switcher can show in place of its app tabs. */
export type SwitcherInlineView = "render-settings" | "map-downloads";

export const SWITCHER_INLINE_VIEWS: readonly SwitcherInlineView[] = ["render-settings", "map-downloads"];

export function isSwitcherInlineView(value: string | null | undefined): value is SwitcherInlineView {
  return SWITCHER_INLINE_VIEWS.includes(value as SwitcherInlineView);
}

/**
 * The product is three pages, and the app switcher is those three tabs. Every
 * other surface — assets, model weights, exports, SimCloud, settings — is a
 * utility reached from the switcher's footer, not a page of its own with a
 * card and artwork. Those utilities render in the switcher's own chrome
 * (`AppStage`), so opening one feels like staying in the switcher rather than
 * navigating to a document.
 */
export const DASHBOARD_APPS: NavItem[] = [
  {
    href: "/dashboard/map-assets",
    label: "Maps",
    description: "Maps and exploration",
    icon: Map,
    highlights: [
      "GeoJSON layers",
      "Map semantics",
      "Drive on the map",
    ],
    match: (p) => p.startsWith("/dashboard/map-assets"),
  },
  {
    href: "/dashboard/scenario",
    label: "Datasets",
    description: "Datasets and scenarios",
    icon: Database,
    highlights: [
      "Training-ready scenarios",
      "Simulation-ready scenarios",
      "Render camera, LiDAR and radar",
    ],
    match: (p) => p.startsWith("/dashboard/scenario"),
  },
  {
    href: "/dashboard/evaluation",
    label: "Evaluation",
    description: "Policies and metrics",
    icon: FlaskConical,
    highlights: [
      "AlpaMayo evaluation",
      "Closed-loop model-in-the-loop",
      "Open-loop metrics",
    ],
    match: (p) => p.startsWith("/dashboard/evaluation"),
  },
];

/** Utility surfaces reachable from the app switcher footer; not product apps. */
export const DASHBOARD_UTILITIES: NavItem[] = [
  {
    href: "/dashboard/assets",
    label: "Assets",
    description: "3D models and maps for scenarios",
    icon: Boxes,
    match: (p) => p.startsWith("/dashboard/assets"),
  },
  {
    // Map Downloads (formerly the Map Library page, "Map availability"): the
    // one place that says which maps this device holds and gets more. Like
    // Render Settings it is not a page but a view of the switcher itself, and
    // it is where a person's first sign-in lands.
    //
    // Both hosts have it, and it means a different thing on each: a local
    // installation installs closures on its own disk, a cloud host downloads
    // maps into this browser's map cache at the chosen render setting.
    href: "/dashboard/apps?view=map-downloads",
    label: "Map Downloads",
    description: "Maps on this device and the cache they live in",
    icon: HardDriveDownload,
    inlineView: "map-downloads",
    match: () => false,
  },
  {
    // Local-only: the store downloads weights to this installation's disk and
    // prepares an isolated runtime for them. Cloud runs need neither.
    href: "/dashboard/models",
    label: "Models",
    description: "Download, verify and remove model weights",
    icon: Brain,
    localOnly: true,
    match: (p) => p.startsWith("/dashboard/models"),
  },
  {
    href: "/dashboard/dataset-export",
    label: "Exports",
    description: "Package datasets for download",
    icon: PackageCheck,
    match: (p) => p.startsWith("/dashboard/dataset-export"),
  },
  {
    // One SimCloud surface: the account, what it unlocks, and the explicit
    // dataset and artifact transfers that used to be a "Cloud Storage" tab.
    // Local-only: it connects THIS installation to SimCloud, and a hosted
    // installation already is the thing it would connect to.
    href: "/dashboard/simcloud",
    label: "SimCloud",
    description: "Your SimCloud account, and the datasets and artifacts it holds",
    icon: Cloud,
    localOnly: true,
    match: (p) => p.startsWith("/dashboard/simcloud"),
  },
  {
    href: "/dashboard/apps?view=render-settings",
    label: "Render Settings",
    description: "Graphics level and map cache",
    icon: MonitorCog,
    /** Not a route: the switcher swaps its content to this view in place. */
    inlineView: "render-settings",
    match: () => false,
  },
  {
    // Local-only: everything here is about the machine this installation runs
    // on — its data folder, its credential vault, its map cache.
    href: "/dashboard/settings",
    label: "Settings",
    description: "This computer, storage and account",
    icon: Settings,
    localOnly: true,
    match: (p) => p.startsWith("/dashboard/settings"),
  },
];

/**
 * The icons a host may name, and the components they name.
 *
 * Exhaustive over {@link StudioHostNavIcon} by its type, so the union and the
 * components it refers to cannot drift; named imports keep the rest of lucide
 * out of the bundle, which is why this is a table and not a namespace lookup.
 */
const HOST_NAV_ICONS: Record<StudioHostNavIcon, LucideIcon> = {
  UserRound,
  Users,
};

/**
 * The utilities for one host: Studio's own minus the ones that are about the
 * machine this installation runs on.
 *
 * `null` capabilities — the report has not arrived, or the host could not be
 * reached — render Studio's own set unchanged. That is the set every
 * installation has, and an entry that appears and then withdraws reads better
 * than a navigation that flickers empty while the report is in flight.
 */
export function dashboardUtilities(capabilities: StudioHostCapabilities | null): NavItem[] {
  const cloud = capabilities !== null && isCloudHost(capabilities);
  return cloud ? DASHBOARD_UTILITIES.filter((item) => item.localOnly !== true) : DASHBOARD_UTILITIES;
}

/**
 * The surfaces the host itself contributes through the capability document's
 * `navItems` — an account, a tenant. They are about who you are on this host,
 * so the switcher lists them in the account menu rather than beside Studio's
 * own utilities.
 */
export function hostNavItems(capabilities: StudioHostCapabilities | null): NavItem[] {
  return (capabilities?.navItems ?? []).map((item) => ({
    href: item.href,
    label: item.label,
    description: item.description,
    icon: HOST_NAV_ICONS[item.icon],
    match: (pathname: string) => pathname.startsWith(item.matchPrefix),
  }));
}

/**
 * The navigation as this host presents it: the three apps, the utilities the
 * host offers, the host's own account surfaces, and the entry the current
 * path is inside.
 *
 * The host's own report comes back with it — `null` until it arrives — so a
 * consumer that also has to say something about the host (who you are signed
 * in as, say) asks for it once rather than fetching the document twice.
 */
export function useDashboardNav(pathname: string): {
  apps: NavItem[];
  utilities: NavItem[];
  /** See {@link hostNavItems}. */
  accountItems: NavItem[];
  activeItem: NavItem | null;
  capabilities: StudioHostCapabilities | null;
} {
  const capabilities = useStudioHostCapabilities(studioHost);
  const report = capabilities.status === "ready" ? capabilities.capabilities : null;
  return useMemo(() => {
    const utilities = dashboardUtilities(report);
    const accountItems = hostNavItems(report);
    return {
      apps: DASHBOARD_APPS,
      utilities,
      accountItems,
      activeItem: [...DASHBOARD_APPS, ...utilities, ...accountItems].find((item) => item.match(pathname)) ?? null,
      capabilities: report,
    };
  }, [report, pathname]);
}
