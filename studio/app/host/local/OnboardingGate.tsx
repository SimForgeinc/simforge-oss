"use client";

import * as stylex from "@stylexjs/stylex";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { hasCompletedLocalSetup, markLocalSetupCompleted, readRenderingPreference, renderingPreferenceQuality } from "@simforge-oss/studio-ui/components/rendering-preference";
import { completeStudioSetup, readStudioSetup } from "@/app/lib/host/setup";
import { setup } from "@/app/components/setup-preparation.stylex";
import { decideOnboardingGate } from "./onboarding-gate";

/** Only the local host owns installation onboarding; an auto GPU choice never completes it. */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const decide = async () => {
      // Reading first migrates pre-change browser preferences into the completion marker.
      const quality = renderingPreferenceQuality(readRenderingPreference());
      const decision = decideOnboardingGate({ setup: await readStudioSetup(controller.signal), browserSetupCompleted: hasCompletedLocalSetup(), quality });
      if (controller.signal.aborted) return;
      if (decision.kind === "onboard") {
        router.replace("/onboarding/welcome");
        return;
      }
      if (decision.kind === "adopt") await completeStudioSetup({ mode: "local", quality: decision.quality }, controller.signal);
      if (!controller.signal.aborted) { markLocalSetupCompleted(); setReady(true); }
    };
    void decide().catch(() => {
      // Setup is a first-run convenience, never an access-control boundary.
      if (!controller.signal.aborted) setReady(true);
    });
    return () => controller.abort();
  }, [router]);
  return <div {...stylex.props(setup.gate, !ready && setup.gateHidden)} aria-hidden={!ready || undefined} data-testid="onboarding-gate-content" inert={!ready || undefined}>{ready ? children : null}</div>;
}
