import { requireAppContext } from "@/app/lib/db/app-context";
import { OnboardingMapsClient } from "./OnboardingMapsClient";

export default async function OnboardingMapsPage() {
  await requireAppContext("/onboarding/maps");
  return <OnboardingMapsClient />;
}
