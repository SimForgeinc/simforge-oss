import { requireAppContext } from "@/app/lib/db/app-context";
import { OnboardingMapsClient } from "./OnboardingMapsClient";

/**
 * Opt the route out of instant-navigation prerendering; see
 * `app/onboarding/welcome/page.tsx` for why every onboarding page does.
 */
export const instant = false;

export default async function OnboardingMapsPage() {
  await requireAppContext("/onboarding/maps");
  return <OnboardingMapsClient />;
}
