import type { ScenarioAuthoringQuality } from "@simforge-oss/studio-host";
import type { StudioSetup } from "@/app/lib/host/setup";

export type OnboardingGateDecision = { kind: "allow" } | { kind: "onboard" } | { kind: "adopt"; quality: ScenarioAuthoringQuality };

/** Only completed setup or the explicit pre-onboarding migration bypasses first run. */
export function decideOnboardingGate({ setup, browserSetupCompleted, quality }: {
  setup: StudioSetup;
  browserSetupCompleted: boolean;
  quality: ScenarioAuthoringQuality;
}): OnboardingGateDecision {
  if (setup.completedAt !== null) return { kind: "allow" };
  return browserSetupCompleted ? { kind: "adopt", quality } : { kind: "onboard" };
}
