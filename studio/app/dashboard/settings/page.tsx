import { requireAppContext } from "@/app/lib/db/app-context";
import { SettingsPageClient } from "./SettingsPageClient";

export default async function SettingsPage() {
  await requireAppContext("/dashboard/settings");
  return <SettingsPageClient />;
}
