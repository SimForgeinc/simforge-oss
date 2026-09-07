import { connection, NextResponse } from "next/server";
import { listCloudArtifactLinks } from "@/app/lib/cloud/storage";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/**
 * `GET /api/simforge/cloud/artifacts/links` -> `{ links: CloudArtifactLink[] }`:
 * which local artifacts were imported from, or uploaded to, which SimCloud
 * artifacts. Local data only — answers without a connection.
 */
export async function GET() {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    { links: await listCloudArtifactLinks(auth.context) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
