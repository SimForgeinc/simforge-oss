import { connection } from "next/server";
import { listLocalMapCatalog } from "@/app/lib/cloud/maps";
import { requireScenarioContext, scenarioJsonWithEtag } from "@/app/lib/scenario/http";

/** Available downloads and installed maps, including explicit account/installation state. */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return scenarioJsonWithEtag(request, { maps: await listLocalMapCatalog(request.signal) });
}
