import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { OnboardingNativeRenderSurface } from "@/app/host";

/**
 * Opt the route out of instant-navigation prerendering; see
 * `app/onboarding/welcome/page.tsx` for why every onboarding page does.
 */
export const instant = false;

/**
 * First-run install of the native render runtime. A cloud host renders on
 * managed workers and has no runtime to install, so the step does not exist
 * there.
 */
export default async function OnboardingNativeRenderPage() {
  if (OnboardingNativeRenderSurface === null) notFound();
  await requireAppContext("/onboarding/native-render");
  return <OnboardingNativeRenderSurface />;
}
