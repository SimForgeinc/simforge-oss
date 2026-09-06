"use client";

import type { ReactNode } from "react";
import { StudioHostProvider } from "@simforge-oss/studio-ui/host";
import { studioHost } from "@/app/lib/host";

/** Mounts the local Studio host services above the shared product tree. */
export function StudioHostBoundary({ children }: { children: ReactNode }) {
  return <StudioHostProvider host={studioHost}>{children}</StudioHostProvider>;
}
