import { requireAppContext } from "@/app/lib/db/app-context";
import { OnboardingNativeRenderClient } from "./OnboardingNativeRenderClient";

/**
 * Opt the route out of instant-navigation prerendering; see
 * `app/onboarding/welcome/page.tsx` for why every onboarding page does.
 */
export const instant = false;

export default async function OnboardingNativeRenderPage() {
  await requireAppContext("/onboarding/native-render");
  return <OnboardingNativeRenderClient />;
}
