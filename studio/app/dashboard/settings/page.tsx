import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { SettingsSurface } from "@/app/host";

/**
 * Settings is about the installation's own machine — its data folder, its
 * credential vault, its map cache — so a host that has no machine does not
 * have the page. See `app/host/contract.ts`.
 */
export default async function SettingsPage() {
  if (SettingsSurface === null) notFound();
  await requireAppContext("/dashboard/settings");
  return <SettingsSurface />;
}
