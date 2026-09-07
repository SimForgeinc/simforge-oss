import { connection, NextResponse } from "next/server";
import { listCloudWorkspaces, transferErrorResponse } from "@/app/lib/cloud/projects";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** `GET /api/simforge/cloud/workspaces` -> `{ workspaces: StudioCloudWorkspace[] }`. */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  try {
    return NextResponse.json(
      { workspaces: await listCloudWorkspaces(request.signal) },
      { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  } catch (error) {
    return transferErrorResponse(error);
  }
}
