"use client";

import type { ReactNode } from "react";
import { StudioHostProvider } from "@simforge-oss/studio-ui/host";
import { CloudConnectorSheet } from "@/app/host";
import { studioHost } from "@/app/lib/host";
import { StudioCloudProvider } from "@/app/lib/host/cloud";

/**
 * Mounts the Studio host services above the shared product tree, plus — on a
 * host that has one — the SimCloud connector beside it and the one account
 * sheet its surfaces can open. The two are independent: the host never changes
 * when an account signs in or out.
 *
 * A cloud host has no connector to mount: it authenticates the person itself,
 * so there is no second account to connect and no vault to keep a credential
 * in. See `app/host/contract.ts`.
 */
export function StudioHostBoundary({ children }: { children: ReactNode }) {
  return (
    <StudioHostProvider host={studioHost}>
      <StudioCloudProvider>
        {children}
        {CloudConnectorSheet ? <CloudConnectorSheet /> : null}
      </StudioCloudProvider>
    </StudioHostProvider>
  );
}
