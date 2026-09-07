import { connection, NextResponse } from "next/server";
import { listCloudDatasets, transferErrorResponse } from "@/app/lib/cloud/projects";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** `GET /api/simforge/cloud/datasets?workspaceId=` -> `{ datasets: ScenarioDatasetDto[] }` from SimCloud. */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim();
  if (!workspaceId) return NextResponse.json({ error: "workspace_id_required" }, { status: 400 });
  try {
    return NextResponse.json(
      { datasets: await listCloudDatasets(workspaceId, request.signal) },
      { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  } catch (error) {
    return transferErrorResponse(error);
  }
}
