import { requireAppContext } from "@/app/lib/db/app-context";
import { OnboardingNativeRenderClient } from "./OnboardingNativeRenderClient";

export default async function OnboardingNativeRenderPage() {
  await requireAppContext("/onboarding/native-render");
  return <OnboardingNativeRenderClient />;
}
