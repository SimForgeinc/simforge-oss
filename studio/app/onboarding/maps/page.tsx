import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { OnboardingMapsSurface } from "@/app/host";

/**
 * Opt the route out of instant-navigation prerendering; see
 * `app/onboarding/welcome/page.tsx` for why every onboarding page does.
 */
export const instant = false;

/**
 * First-run map installation. A cloud host installs nothing and its setup is
 * complete before anyone signs in, so the step does not exist there.
 */
export default async function OnboardingMapsPage() {
  if (OnboardingMapsSurface === null) notFound();
  await requireAppContext("/onboarding/maps");
  return <OnboardingMapsSurface />;
}
