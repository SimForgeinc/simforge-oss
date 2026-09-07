import {
  Boxes,
  Brain,
  CarFront,
  CloudUpload,
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
  disabled?: boolean;
};

export const DASHBOARD_APPS: NavItem[] = [
  {
    href: "/dashboard/map-assets",
    label: "Maps",
    description: "CARLA map library and bridges",
    icon: Map,
    match: (p) => p.startsWith("/dashboard/map-assets"),
  },
  {
    href: "/dashboard/assets",
    label: "Assets",
    description: "3D models and maps for scenarios",
    icon: Boxes,
    match: (p) => p.startsWith("/dashboard/assets"),
  },
  {
    href: "/dashboard/scenario",
    label: "Datasets",
    description: "Scenario datasets and authoring",
    icon: Database,
    match: (p) => p.startsWith("/dashboard/scenario"),
  },
  {
    href: "/dashboard/evaluation",
    label: "Evaluation",
    description: "Eval campaigns, playback, and promotion",
    icon: FlaskConical,
    match: (p) => p.startsWith("/dashboard/evaluation"),
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
    href: "/dashboard/drive",
    label: "Drive",
    description: "Continuous worlds and live driving",
    icon: CarFront,
    match: (p) => p.startsWith("/dashboard/drive"),
  },
];

/** Utility surfaces reachable from the app switcher footer; not product apps. */
export const DASHBOARD_UTILITIES: NavItem[] = [
  {
    href: "/dashboard/cloud-storage",
    label: "Cloud Storage",
    description: "Import and publish projects with a SimCloud account",
    icon: CloudUpload,
    match: (p) => p.startsWith("/dashboard/cloud-storage"),
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
    description: "This computer, SimCloud account and storage",
    icon: Settings,
    match: (p) => p.startsWith("/dashboard/settings"),
  },
];

export const DASHBOARD_NAV: NavItem[] = [...DASHBOARD_APPS, ...DASHBOARD_UTILITIES];

export function activeNavItem(pathname: string): NavItem | null {
  return DASHBOARD_NAV.find((item) => item.match(pathname)) ?? null;
}
