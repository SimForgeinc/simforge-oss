import { connection, NextResponse } from "next/server";
import { primeCloudSession } from "@/app/lib/cloud/connection";
import { getRegisteredMap } from "@/app/lib/cloud/map-registry";
import { assertMapUsable } from "@/app/lib/cloud/access";
import { listScenarioBrowserDownloadInventory, type ScenarioBrowserCacheMap } from "@/app/lib/scenario/document-store";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

const MAX_MAPS = 64;

/**
 * The non-texture browser members of the requested maps: the base a browser
 * builds a render-profile download plan from (the chosen texture tier's
 * objects come from that tier's own index, see `map-download-plan.ts`).
 *
 * Every requested map is answered. A map this installation may not use, or
 * one with no verified browser asset set, comes back under `unavailable` with
 * the reason, so the client can say which map it cannot download instead of
 * dropping it from the selection.
 */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const ids = [...new Set(new URL(request.url).searchParams.getAll("mapVersionId").map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_MAPS) {
    return NextResponse.json({ error: "invalid_download_plan_request" }, { status: 400 });
  }
  await primeCloudSession();
  const maps: ScenarioBrowserCacheMap[] = [];
  const unavailable: Array<{ mapVersionId: string; reason: string }> = [];
  await Promise.all(ids.map(async (mapVersionId) => {
    const registered = await getRegisteredMap(mapVersionId);
    if (!registered) {
      unavailable.push({ mapVersionId, reason: "This map is not registered on this installation." });
      return;
    }
    try {
      assertMapUsable(registered);
    } catch {
      unavailable.push({ mapVersionId, reason: "This map needs an active SimCloud connection." });
      return;
    }
    const inventory = await listScenarioBrowserDownloadInventory(auth.context, mapVersionId);
    if (!inventory) {
      unavailable.push({ mapVersionId, reason: "This map has no verified browser assets to download." });
      return;
    }
    maps.push(inventory);
  }));
  return NextResponse.json({ maps, unavailable }, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
