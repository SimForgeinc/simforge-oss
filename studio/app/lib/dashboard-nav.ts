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
};

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
    // The only surface that installs maps outside first-run onboarding, and
    // the one place that says what this computer already holds. It is a
    // utility rather than a fourth app tab for the same reason Models is:
    // the product is three pages, and this one prepares what they open.
    href: "/dashboard/map-library",
    label: "Map Library",
    description: "Install maps on this computer, and see what is already installed",
    icon: HardDriveDownload,
    highlights: [
      "Every map this installation can use",
      "Download size before you download",
      "Repair an installed map",
    ],
    match: (p) => p.startsWith("/dashboard/map-library"),
  },
  {
    href: "/dashboard/models",
    label: "Models",
    description: "Download, verify and remove model weights",
    icon: Brain,
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
    href: "/dashboard/render-settings",
    label: "Render Settings",
    description: "Rendering profile and map preparation",
    icon: MonitorCog,
    match: (p) => p.startsWith("/dashboard/render-settings"),
  },
  {
    href: "/dashboard/settings",
    label: "Settings",
    description: "This computer, AI providers and storage",
    icon: Settings,
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
 * machine this installation runs on, plus whatever the host itself
 * contributes through the capability document's `navItems`.
 *
 * `null` capabilities — the report has not arrived, or the host could not be
 * reached — render Studio's own set unchanged. That is the set every
 * installation has, and an entry that appears and then withdraws reads better
 * than a navigation that flickers empty while the report is in flight.
 */
export function dashboardUtilities(capabilities: StudioHostCapabilities | null): NavItem[] {
  const cloud = capabilities !== null && isCloudHost(capabilities);
  const own = cloud ? DASHBOARD_UTILITIES.filter((item) => item.localOnly !== true) : DASHBOARD_UTILITIES;
  const contributed = capabilities?.navItems ?? [];
  if (contributed.length === 0) return own;
  return [
    ...own,
    ...contributed.map((item) => ({
      href: item.href,
      label: item.label,
      description: item.description,
      icon: HOST_NAV_ICONS[item.icon],
      match: (pathname: string) => pathname.startsWith(item.matchPrefix),
    })),
  ];
}

/**
 * The navigation as this host presents it: the three apps, the utilities the
 * host offers, and the entry the current path is inside.
 *
 * The host's own report comes back with it — `null` until it arrives — so a
 * consumer that also has to say something about the host (who you are signed
 * in as, say) asks for it once rather than fetching the document twice.
 */
export function useDashboardNav(pathname: string): {
  apps: NavItem[];
  utilities: NavItem[];
  activeItem: NavItem | null;
  capabilities: StudioHostCapabilities | null;
} {
  const capabilities = useStudioHostCapabilities(studioHost);
  const report = capabilities.status === "ready" ? capabilities.capabilities : null;
  return useMemo(() => {
    const utilities = dashboardUtilities(report);
    return {
      apps: DASHBOARD_APPS,
      utilities,
      activeItem: [...DASHBOARD_APPS, ...utilities].find((item) => item.match(pathname)) ?? null,
      capabilities: report,
    };
  }, [report, pathname]);
}
