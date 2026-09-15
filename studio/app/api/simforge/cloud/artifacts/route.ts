import { connection, NextResponse } from "next/server";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { listCloudArtifacts } from "@/app/lib/cloud/storage";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** `GET /api/simforge/cloud/artifacts?organizationId=` -> `{ artifacts: IndexedArtifact[] }` from SimCloud. */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const organizationId = new URL(request.url).searchParams.get("organizationId")?.trim();
  if (!organizationId) return NextResponse.json({ error: "organization_id_required" }, { status: 400 });
  try {
    return NextResponse.json(
      { artifacts: await listCloudArtifacts(organizationId, request.signal) },
      { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  } catch (error) {
    return transferErrorResponse(error);
  }
}
