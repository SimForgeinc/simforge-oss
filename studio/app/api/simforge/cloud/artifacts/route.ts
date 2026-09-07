import { connection, NextResponse } from "next/server";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { listCloudArtifacts } from "@/app/lib/cloud/storage";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** `GET /api/simforge/cloud/artifacts?workspaceId=` -> `{ artifacts: WorkspaceArtifact[] }` from SimCloud. */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim();
  if (!workspaceId) return NextResponse.json({ error: "workspace_id_required" }, { status: 400 });
  try {
    return NextResponse.json(
      { artifacts: await listCloudArtifacts(workspaceId, request.signal) },
      { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  } catch (error) {
    return transferErrorResponse(error);
  }
}
