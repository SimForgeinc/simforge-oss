import { NextResponse } from "next/server";
import { modelStoreView } from "@simforge-oss/model-store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/**
 * The whole model-store view: catalog, per-family install state, per-family
 * execution eligibility on THIS machine, the observed host, vault status and
 * the unresolved licence/gating review gates.
 *
 * Desktop-only. The map-free browser portal must not call this route: it
 * imports the catalog module directly and asks the compute API what the
 * workspace may actually run.
 */
export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(await modelStoreView(), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
