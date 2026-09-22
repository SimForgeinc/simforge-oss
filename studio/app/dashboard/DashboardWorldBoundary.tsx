"use client";

import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ScenarioWorldProvider } from "@simforge-oss/studio-ui/scenario/scene/ScenarioWorldProvider";

/**
 * Route knowledge stays in the host; the shared world only understands leases.
 * A drive is played on the world the gallery or the editor was just showing,
 * so the world stays alive across the hop into and out of a drive route.
 */
export function DashboardWorldBoundary({ children }: { children: ReactNode }) {
  const path = usePathname();
  const query = useSearchParams();
  const keepAlive = path === "/dashboard/map-assets"
    || path.startsWith("/dashboard/map-assets/drive")
    || path.startsWith("/dashboard/drive/")
    || (path === "/dashboard/scenario" && Boolean(query.get("dataset") && query.get("document")) && query.get("pane") !== "render");
  return <ScenarioWorldProvider keepAlive={keepAlive}>{children}</ScenarioWorldProvider>;
}
