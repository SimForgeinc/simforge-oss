import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { listScenarioDatasets } from "@/app/lib/scenario/dataset-store";
import { ScenarioDatasetsPageClient } from "./ScenarioDatasetsPageClient";

export default async function ScenarioPage() {
  await connection();
  const context = await requireAppContext("/dashboard/scenario");
  const datasets = await listScenarioDatasets(context);
  return <ScenarioDatasetsPageClient initialDatasets={datasets} />;
}
