import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";

import { OnboardingGate } from "@/app/components/OnboardingGate";
import { StudioHostBoundary } from "@/app/lib/host/StudioHostBoundary";
import { route } from "./drive-route.stylex";

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
      <div {...stylex.props(route.shell)}>
        <OnboardingGate>{children}</OnboardingGate>
      </div>
    </StudioHostBoundary>
  );
}
