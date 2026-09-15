import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { SimCloudPanel } from "@/app/components/simcloud/SimCloudPanel";
import DashboardLoading from "../loading";

/**
 * SimCloud: the account, what it unlocks, and the explicit transfers between
 * this computer and a SimCloud organization. One surface — signing in,
 * signing out, the profile and cloud storage all live here.
 */
async function SimCloudContent() {
  await connection();
  await requireAppContext("/dashboard/simcloud");
  return <SimCloudPanel />;
}

export default function SimCloudPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <SimCloudContent />
    </Suspense>
  );
}
