import { connection } from "next/server";
import { readLocalMapCatalog } from "@/app/lib/cloud/maps";
import { requireScenarioContext, scenarioJsonWithEtag } from "@/app/lib/scenario/http";

/**
 * The local map catalog plus whether the Cloud answered for it. Consumers
 * that only want the maps ignore `upstream`; first-run onboarding reads it,
 * because with no local maps and no Cloud it has nothing to offer.
 */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return scenarioJsonWithEtag(request, await readLocalMapCatalog(request.signal));
}
