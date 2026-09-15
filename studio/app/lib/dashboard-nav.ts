import {
  Boxes,
  Brain,
  Cloud,
  Database,
  FlaskConical,
  Map,
  MonitorCog,
  PackageCheck,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
  /** What the page is for, in three phrases; shown on the switcher's tabs. */
  highlights?: readonly string[];
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
    href: "/dashboard/simcloud",
    label: "SimCloud",
    description: "Your SimCloud account, and the datasets and artifacts it holds",
    icon: Cloud,
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

export const DASHBOARD_NAV: NavItem[] = [...DASHBOARD_APPS, ...DASHBOARD_UTILITIES];

export function activeNavItem(pathname: string): NavItem | null {
  return DASHBOARD_NAV.find((item) => item.match(pathname)) ?? null;
}
