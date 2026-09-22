import { requireAppContext } from "@/app/lib/db/app-context";
import { Suspense } from "react";
import { AppSwitcherPage } from "./AppSwitcherPage";

/**
 * Where a sign-in lands: the app switcher as its own route. Choosing an app
 * costs nothing here, whereas landing inside Maps meant waiting for a map to
 * load before the first choice could be made.
 */
export default async function DashboardAppsPage() {
  await requireAppContext("/dashboard/apps");
  // `useSearchParams` in the client page needs a Suspense boundary for the static shell.
  return <Suspense fallback={null}><AppSwitcherPage /></Suspense>;
}
