import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { StudioHostBoundary } from "@/app/lib/host/StudioHostBoundary";
import { mergeStyleProps } from "@simforge-oss/studio-ui/components/stylex";
import { layout } from "./onboarding-layout.stylex";

/**
 * First-run onboarding has no dashboard chrome on purpose: there is nothing to
 * navigate to until the installation is set up, and the top bar would offer
 * pages the gate immediately sends back here. The host boundary still mounts,
 * because the SimCloud connector is what the sign-in step drives.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <StudioHostBoundary>
      <div aria-hidden="true" {...mergeStyleProps(stylex.props(layout.dragStrip), "app-topbar-native")} />
      <div {...stylex.props(layout.shell)}>{children}</div>
    </StudioHostBoundary>
  );
}
