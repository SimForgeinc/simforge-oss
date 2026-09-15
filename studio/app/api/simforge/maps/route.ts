import { connection } from "next/server";
import { listEditorMapCatalog } from "@/app/lib/cloud/maps";
import { requireScenarioContext, scenarioJsonWithEtag } from "@/app/lib/scenario/http";

/** `GET maps` — protocol `maps.list`. Editor maps must already be installed and authorized on this host. */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return await scenarioJsonWithEtag(request, { maps: await listEditorMapCatalog(request.signal) });
}
