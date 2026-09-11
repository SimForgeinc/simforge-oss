import type { ReactNode } from "react";
import { StudioHostBoundary } from "@/app/lib/host/StudioHostBoundary";

/**
 * First-run onboarding has no dashboard chrome on purpose: there is nothing to
 * navigate to until the installation is set up, and the top bar would offer
 * pages the gate immediately sends back here. The host boundary still mounts,
 * because the SimCloud connector is what the sign-in step drives.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <StudioHostBoundary>
      <div className="min-h-svh bg-[#050607] text-white">{children}</div>
    </StudioHostBoundary>
  );
}
