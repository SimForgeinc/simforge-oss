"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { StudioHostServices } from "@simforge-oss/studio-host";

/**
 * The one seam between the portable Studio product and the host that runs it.
 *
 * Local Studio (PGlite + filesystem behind same-origin routes) and SimCloud
 * (managed Postgres, object storage, workspace auth) each construct their own
 * `StudioHostServices` and mount it once above the dashboard. Every shared
 * screen, hook and worker client reaches persistence, artifacts, jobs and
 * runtime capabilities through `useStudioHost()`; nothing in this package
 * imports a host module.
 */
const StudioHostContext = createContext<StudioHostServices | null>(null);

export function StudioHostProvider({ host, children }: { host: StudioHostServices; children: ReactNode }) {
  return <StudioHostContext.Provider value={host}>{children}</StudioHostContext.Provider>;
}

export function useStudioHost(): StudioHostServices {
  const host = useContext(StudioHostContext);
  if (!host) {
    throw new Error("useStudioHost() requires a <StudioHostProvider> above the Studio product tree.");
  }
  return host;
}
