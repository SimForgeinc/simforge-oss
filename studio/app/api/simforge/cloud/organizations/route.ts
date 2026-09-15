import { connection, NextResponse } from "next/server";
import { listCloudOrganizations } from "@/app/lib/cloud/connection";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** `GET /api/simforge/cloud/organizations` -> `{ organizations: StudioCloudOrganization[] }`. */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  try {
    return NextResponse.json(
      { organizations: await listCloudOrganizations(request.signal) },
      { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  } catch (error) {
    return transferErrorResponse(error);
  }
}
