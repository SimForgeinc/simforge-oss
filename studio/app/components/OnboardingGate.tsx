"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  readRenderingPreference,
  saveRenderingPreference,
} from "@simforge-oss/studio-ui/components/rendering-preference"
import { installMapAssetFetchGateway } from "@simforge-oss/studio-ui/lib/maps/frontend/map-asset-cache";
import {
  DEFAULT_SCENARIO_AUTHORING_QUALITY_ID,
  SCENARIO_AUTHORING_QUALITY_IDS,
  type ScenarioAuthoringQuality,
} from "@/app/lib/scenario/contracts";
import { decideOnboardingGate } from "@/app/lib/host/onboarding-gate";
import { completeStudioSetup, readStudioSetup } from "@/app/lib/host/setup";

installMapAssetFetchGateway();

const WELCOME_PATH = "/onboarding/welcome";

/**
 * Keeps the dashboard hidden until this installation has been set up, so no
 * map viewer mounts and starts downloading behind an onboarding screen. The
 * onboarding routes live outside `/dashboard` and are never gated.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const decide = async () => {
      const requested = new URLSearchParams(window.location.search).get("quality");
      const decision = decideOnboardingGate({
        setup: await readStudioSetup(controller.signal),
        preference: readRenderingPreference(),
        requestedQuality: (SCENARIO_AUTHORING_QUALITY_IDS as readonly string[]).includes(requested ?? "")
          ? (requested as ScenarioAuthoringQuality)
          : null,
        fallbackQuality: DEFAULT_SCENARIO_AUTHORING_QUALITY_ID,
      });
      if (controller.signal.aborted) return;
      if (decision.kind === "onboard") {
        setReady(false);
        router.replace(WELCOME_PATH);
        return;
      }
      if (decision.kind === "adopt") {
        if (decision.savePreference) saveRenderingPreference(decision.quality);
        if (decision.recordSetup) {
          await completeStudioSetup({ mode: "local", quality: decision.quality }, controller.signal);
        }
      }
      if (!controller.signal.aborted) setReady(true);
    };
    void decide().catch(() => {
      // The setup state is a first-run convenience, not an access control. A
      // service that cannot answer must not lock the user out of the app.
      if (!controller.signal.aborted) setReady(true);
    });
    return () => controller.abort();
  }, [router]);

  return (
    <div
      aria-hidden={!ready || undefined}
      className={`h-full min-h-0 ${ready ? "" : "invisible"}`}
      data-testid="onboarding-gate-content"
      inert={!ready || undefined}
    >
      {children}
    </div>
  );
}
