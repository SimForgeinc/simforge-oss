"use client";

import type { ReactNode } from "react";
import { OnboardingGateSurface } from "@/app/host";
import { installMapAssetFetchGateway } from "@simforge-oss/studio-ui/lib/maps/frontend/map-asset-cache";

installMapAssetFetchGateway();

/** Cloud composition never imports or mounts local installation setup effects. */
export function OnboardingGate({ children }: { children: ReactNode }) {
  return OnboardingGateSurface ? <OnboardingGateSurface>{children}</OnboardingGateSurface> : children;
}
