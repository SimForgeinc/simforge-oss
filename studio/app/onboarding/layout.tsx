import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { StudioHostBoundary } from "@/app/lib/host/StudioHostBoundary";
import { mergeStyleProps } from "@simforge-oss/studio-ui/components/stylex";
import { HeroBackdrop } from "@simforge-oss/studio-ui/onboarding";
import { layout } from "./onboarding-layout.stylex";

/**
 * First-run onboarding has no dashboard chrome on purpose: there is nothing to
 * navigate to until the installation is set up, and the top bar would offer
 * pages the gate immediately sends back here. The host boundary still mounts,
 * because the SimCloud connector is what the sign-in step drives.
 *
 * The animated hero lives here rather than in a screen so it survives the
 * step change: moving from Welcome to the map setup swaps the copy and the
 * controls in the same column over the same scene, instead of loading a
 * second page with its own backdrop.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <StudioHostBoundary>
      <div aria-hidden="true" {...mergeStyleProps(stylex.props(layout.dragStrip), "app-topbar-native")} />
      <main {...stylex.props(layout.shell)}>
        <HeroBackdrop />
        <div {...stylex.props(layout.column)}>{children}</div>
      </main>
    </StudioHostBoundary>
  );
}
