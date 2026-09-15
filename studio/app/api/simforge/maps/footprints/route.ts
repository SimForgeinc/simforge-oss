import { connection } from "next/server";
import { listMapFootprints } from "@/app/lib/maps/footprints";
import { requireScenarioContext, scenarioJsonWithEtag } from "@/app/lib/scenario/http";

/** WGS84 footprints of the maps installed on this host, for the coverage map. */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return await scenarioJsonWithEtag(request, await listMapFootprints(request.signal));
}
