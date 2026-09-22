import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import DashboardLoading from "../loading";
import { DatasetExportPageClient } from "./DatasetExportPageClient";

async function DatasetExportContent() {
  await connection();
  await requireAppContext("/dashboard/dataset-export");
  return <DatasetExportPageClient />;
}

export default function DatasetExportPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <DatasetExportContent />
    </Suspense>
  );
}
