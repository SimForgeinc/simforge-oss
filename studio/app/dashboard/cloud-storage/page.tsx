import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { CloudStoragePanel } from "@/app/components/cloud-storage/CloudStoragePanel";
import DashboardLoading from "../loading";

/**
 * Cloud storage: browse a SimCloud workspace's datasets and artifacts, import
 * them as local working copies, and publish/upload local work explicitly.
 * Everything on this page is a user action; connecting alone moves nothing.
 */
async function CloudStorageContent() {
  await connection();
  await requireAppContext("/dashboard/cloud-storage");
  return <CloudStoragePanel />;
}

export default function CloudStoragePage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <CloudStorageContent />
    </Suspense>
  );
}
