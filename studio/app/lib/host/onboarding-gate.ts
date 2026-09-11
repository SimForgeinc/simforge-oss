import type { ScenarioAuthoringQuality } from "@simforge-oss/studio-host";
import type { StudioSetup } from "./setup";

/**
 * The first-run decision, as a pure rule so both the gate and its test agree
 * on it.
 *
 * Setup state lives in the data root (`simforge.local_studio_setup`) while the
 * rendering preference lives in localStorage, so the two can disagree in both
 * directions and each disagreement has one right answer:
 *
 * - Setup finished but this browser profile has no preference (a second
 *   profile, or cleared storage): adopt the level setup recorded. Viewers need
 *   a preference to stream at all, and asking again would be a regression.
 * - A preference exists but there is no setup row: an installation from before
 *   onboarding existed. It is already set up — record the row and let it
 *   through instead of onboarding a working installation.
 * - Neither: a genuine first run, show onboarding.
 */
export type OnboardingGateDecision =
  | { kind: "allow" }
  | {
      kind: "adopt";
      quality: ScenarioAuthoringQuality;
      /** Write the level into this browser profile's localStorage. */
      savePreference: boolean;
      /** Complete the host-side setup row for an installation that predates onboarding. */
      recordSetup: boolean;
    }
  | { kind: "onboard" };

export function decideOnboardingGate(input: {
  setup: StudioSetup;
  /** The rendering preference of this browser profile, if any. */
  preference: ScenarioAuthoringQuality | null;
  /** An explicit level named by the incoming link (`?quality=high`). */
  requestedQuality: ScenarioAuthoringQuality | null;
  /** Level to adopt when a completed setup recorded none. */
  fallbackQuality: ScenarioAuthoringQuality;
}): OnboardingGateDecision {
  const { setup, preference, requestedQuality, fallbackQuality } = input;
  if (setup.completedAt !== null) {
    if (preference) return { kind: "allow" };
    return {
      kind: "adopt",
      quality: setup.quality ?? fallbackQuality,
      savePreference: true,
      recordSetup: false,
    };
  }
  // An explicit choice from whoever built the link is as valid as a clicked
  // one, and honouring it matters because onboarding redirects away and never
  // returns to the destination — a shared link would otherwise strand its
  // recipient in setup.
  const quality = preference ?? requestedQuality;
  if (!quality) return { kind: "onboard" };
  return { kind: "adopt", quality, savePreference: preference === null, recordSetup: true };
}
