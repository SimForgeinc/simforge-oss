import { NextResponse } from "next/server";
import type { ScenarioMapVersionIdentityDto } from "@simforge-oss/studio-host";
import { queryOne } from "@/app/lib/db/data-api";
import { readScenarioMapPin } from "@/app/lib/scenario/map-pin";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ mapVersionId: string }> };

/**
 * One map version by id, whether or not it is the newest publication of its
 * source. An import binds a scenario to the exact version it was authored on
 * when that version exists here; the catalog (`GET /maps`) lists only the
 * newest publication of each source.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { mapVersionId } = await route.params;
  const row = await queryOne<{ id: string; source_map_asset_id: string | null; xodr_sha256: string; retired_at: string | null }>(
    `SELECT id, source_map_asset_id, xodr_sha256, retired_at::text AS retired_at
       FROM simforge.map_versions WHERE id = :map_version_id LIMIT 1`,
    { map_version_id: mapVersionId },
  );
  if (!row) return NextResponse.json({ error: "map_version_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  const pin = row.retired_at ? null : await readScenarioMapPin({ queryOne }, row.id);
  const body: ScenarioMapVersionIdentityDto = {
    mapVersionId: row.id,
    sourceMapId: row.source_map_asset_id,
    xodrSha256: row.xodr_sha256,
    retiredAt: row.retired_at,
    pinnable: pin !== null,
  };
  return NextResponse.json(body, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
