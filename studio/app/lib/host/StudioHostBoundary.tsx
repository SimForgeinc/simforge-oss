"use client";

import type { ReactNode } from "react";
import { StudioHostProvider } from "@simforge-oss/studio-ui/host";
import { CloudAccountSheet } from "@/app/components/cloud/CloudAccountChip";
import { studioHost } from "@/app/lib/host";
import { StudioCloudProvider } from "@/app/lib/host/cloud";

/**
 * Mounts the local Studio host services above the shared product tree, plus
 * the optional SimCloud connector beside it and the one account sheet every
 * surface can open. The two are independent: the host never changes when an
 * account signs in or out.
 */
export function StudioHostBoundary({ children }: { children: ReactNode }) {
  return (
    <StudioHostProvider host={studioHost}>
      <StudioCloudProvider>
        {children}
        <CloudAccountSheet />
      </StudioCloudProvider>
    </StudioHostProvider>
  );
}
