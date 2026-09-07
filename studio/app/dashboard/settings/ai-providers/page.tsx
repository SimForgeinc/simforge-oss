import { requireAppContext } from "@/app/lib/db/app-context";
import { AiProviderSettingsClient } from "./AiProviderSettingsClient";

export default async function AiProviderSettingsPage() {
  await requireAppContext("/dashboard/settings/ai-providers");
  return <AiProviderSettingsClient />;
}
