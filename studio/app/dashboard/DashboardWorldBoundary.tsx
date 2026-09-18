"use client";

import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ScenarioWorldProvider } from "@simforge-oss/studio-ui/scenario/scene/ScenarioWorldProvider";

/** Route knowledge stays in the host; the shared world only understands leases. */
export function DashboardWorldBoundary({ children }: { children: ReactNode }) {
  const path = usePathname();
  const query = useSearchParams();
  const keepAlive = path === "/dashboard/map-assets"
    || (path === "/dashboard/scenario" && Boolean(query.get("dataset") && query.get("document")) && query.get("pane") !== "render");
  return <ScenarioWorldProvider keepAlive={keepAlive}>{children}</ScenarioWorldProvider>;
}
