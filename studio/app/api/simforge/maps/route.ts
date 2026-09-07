import { connection } from "next/server";
import { listLocalMapCatalog } from "@/app/lib/cloud/maps";
import { requireScenarioContext, scenarioJsonWithEtag } from "@/app/lib/scenario/http";

/**
 * The map catalog this installation can use: locally registered maps plus what
 * the configured Cloud publishes to it (anonymously only the real RFS; with an
 * active account session every published map). Every URL is a same-origin
 * first-party route on this service, so the body is revalidated, not stored.
 */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return await scenarioJsonWithEtag(request, {
    maps: await listLocalMapCatalog(request.signal),
  });
}
