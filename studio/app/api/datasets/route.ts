import { connection, NextResponse } from "next/server";
import { listExportableDatasets } from "@/app/lib/dataset-export/datasets";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/**
 * Datasets the broad export domain can package: scenario datasets first,
 * then any legacy variation datasets not already represented.
 */
export async function GET() {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const datasets = await listExportableDatasets(auth.context);
  return NextResponse.json(
    { datasets, total: datasets.length },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
