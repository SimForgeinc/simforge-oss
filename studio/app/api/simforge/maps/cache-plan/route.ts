import { connection, NextResponse } from "next/server";
import { primeCloudSession } from "@/app/lib/cloud/connection";
import { getRegisteredMap } from "@/app/lib/cloud/map-registry";
import { assertMapUsable } from "@/app/lib/cloud/access";
import { listScenarioBrowserCacheInventory } from "@/app/lib/scenario/document-store";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

/** Browser-asset inventory of the registered maps this installation may use right now. */
export async function GET() {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  await primeCloudSession();
  const inventory = await listScenarioBrowserCacheInventory(auth.context);
  const maps = [];
  for (const map of inventory.maps) {
    const registered = await getRegisteredMap(map.mapVersionId);
    if (!registered) continue;
    try {
      assertMapUsable(registered);
    } catch {
      continue;
    }
    maps.push(map);
  }
  return NextResponse.json(
    { releaseKey: inventory.releaseKey, maps },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
