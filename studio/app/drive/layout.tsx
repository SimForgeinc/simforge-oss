import type { ReactNode } from "react";

import { OnboardingGate } from "@/app/components/OnboardingGate";
import { StudioHostBoundary } from "@/app/lib/host/StudioHostBoundary";

export const instant = false;

/**
 * The game's own chrome: no dashboard top bar, no navigation, no scrolling.
 * It keeps only the two things a session genuinely needs from the app shell —
 * the local host services and the first-run gate, which also installs the map
 * asset cache gateway the viewer streams through.
 */
export default function DriveLayout({ children }: { children: ReactNode }) {
  return (
    <StudioHostBoundary>
      <div className="h-svh overflow-hidden bg-[#050607] text-white">
        <OnboardingGate>{children}</OnboardingGate>
      </div>
    </StudioHostBoundary>
  );
}
