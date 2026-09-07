import { NextResponse } from "next/server";
import { disconnectCloud } from "@/app/lib/cloud/connection";
import { invalidateUpstreamCatalog } from "@/app/lib/cloud/maps";
import { requireScenarioMutationOrigin, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** Revoke upstream when reachable, clear local credentials regardless; account maps lock immediately. */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const status = await disconnectCloud();
  invalidateUpstreamCatalog();
  return NextResponse.json(status, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
