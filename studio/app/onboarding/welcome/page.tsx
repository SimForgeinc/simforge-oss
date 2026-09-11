import { requireAppContext } from "@/app/lib/db/app-context";
import { OnboardingWelcomeClient } from "./OnboardingWelcomeClient";

export default async function OnboardingWelcomePage() {
  await requireAppContext("/onboarding/welcome");
  return <OnboardingWelcomeClient />;
}
