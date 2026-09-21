import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { listScenarioDatasets } from "@/app/lib/scenario/dataset-store";
import { ScenarioDatasetsMount } from "./ScenarioDatasetsMount";

export default async function ScenarioPage() {
  await connection();
  const context = await requireAppContext("/dashboard/scenario");
  const datasets = await listScenarioDatasets(context);
  return <ScenarioDatasetsMount initialDatasets={datasets} />;
}
