import { Suspense } from "react";
import { connection } from "next/server";
import { isCloudHost } from "@simforge-oss/studio-host";
import { requireAppContext } from "@/app/lib/db/app-context";
import { getLocalHostCapabilities } from "@/app/lib/host/capabilities";
import { SimCloudPanel } from "@/app/components/simcloud/SimCloudPanel";
import { SimCloudNotApplicable } from "@/app/components/simcloud/SimCloudNotApplicable";
import DashboardLoading from "../loading";

/**
 * SimCloud: the account, what it unlocks, and the explicit transfers between
 * this computer and a SimCloud organization. One surface — signing in,
 * signing out, the profile and cloud storage all live here.
 *
 * On a cloud host the surface has nothing to do — connecting a hosted
 * installation to the service it is part of is not an operation — so the
 * route explains that instead. The host says which it is; the page never
 * reads the environment to guess.
 */
async function SimCloudContent() {
  await connection();
  const context = await requireAppContext("/dashboard/simcloud");
  const capabilities = await getLocalHostCapabilities(context);
  if (isCloudHost(capabilities)) {
    return <SimCloudNotApplicable hostLabel={capabilities.host.label} />;
  }
  return <SimCloudPanel />;
}

export default function SimCloudPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <SimCloudContent />
    </Suspense>
  );
}
