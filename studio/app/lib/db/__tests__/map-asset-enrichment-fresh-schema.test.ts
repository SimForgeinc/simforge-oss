import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { test } from "node:test";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_WORKSPACE_ID, LOCAL_USER_ID, LOCAL_ORGANIZATION_ID } from "../../auth/session";
import { execute, queryOne, shutdownDatabase } from "../data-api";
import {
  getMapAssetEnrichmentById,
  getMapAssetEnrichmentManifest,
  getMapAssetRoadSegments,
  upsertMapAssetEnrichment,
} from "../map-asset-enrichment-store";
import { getMapAssetByIdFromDb, upsertMapAsset } from "../map-asset-store";

/**
 * A freshly initialised data root must serve every enrichment reader the
 * map-search and editor paths depend on. Before 20260908130000 the local
 * table was a three-column stub and the very first `SELECT provider ...`
 * failed with `column "provider" does not exist`, taking AI map search down
 * with a 500 on every native map.
 */
const MAP_ASSET_ID = "fresh-schema-map";

async function seedMapAsset() {
  await execute(
    `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
     VALUES (:id, 'Local Owner', 'owner@local.simforge', TRUE, 'owner')
     ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_USER_ID },
  );
  await execute(
    `INSERT INTO public.ba_organization (id, name, slug)
     VALUES (:id, 'Local Workspace', 'local') ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_ORGANIZATION_ID },
  );
  await execute(
    `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
     VALUES (:id, 'personal', 'local', 'Local Workspace', :user_id, :organization_id)
     ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID, organization_id: LOCAL_ORGANIZATION_ID },
  );
  await upsertMapAsset({
    map_asset_id: MAP_ASSET_ID,
    name: "Fresh schema map",
    crs: "OpenDRIVE",
    bbox: { min_lat: 0, min_lng: 0, max_lat: 1, max_lng: 1 },
    center: { lat: 0.5, lng: 0.5 },
    created_at: new Date(0).toISOString(),
    tags: [],
    artifacts: [],
  });
}

test("fresh data root: enrichment readers answer instead of failing on the schema", async (t) => {
  t.after(() => shutdownDatabase());
  await migrate();
  await seedMapAsset();
  assert.ok(await getMapAssetByIdFromDb(MAP_ASSET_ID));

  // No enrichment yet: every reader reports absence, none throws.
  assert.equal(await getMapAssetEnrichmentById(MAP_ASSET_ID), null);
  assert.equal(await getMapAssetEnrichmentManifest(MAP_ASSET_ID), null);
  assert.equal(await getMapAssetRoadSegments(MAP_ASSET_ID), null);

  // The canonical writer round-trips through the same table.
  await upsertMapAssetEnrichment(
    {
      map_asset_id: MAP_ASSET_ID,
      provider: "overture",
      provider_release: "2026-04-15.0",
      computed_at: "2026-09-08T00:00:00.000Z",
      summary: {
        provider: "overture",
        provider_release: "2026-04-15.0",
        computed_at: "2026-09-08T00:00:00.000Z",
      },
      warnings: [],
      overlay_payload: { bbox: null, layers: [] },
      candidate_locations: [],
    },
    [],
  );
  const row = await queryOne<{ provider: string; provider_release: string; road_segments: string }>(
    `SELECT provider, provider_release, road_segments_json::text AS road_segments
     FROM map_asset_enrichments WHERE map_asset_id = :map_asset_id`,
    { map_asset_id: MAP_ASSET_ID },
  );
  assert.deepEqual(row, { provider: "overture", provider_release: "2026-04-15.0", road_segments: "[]" });
  assert.deepEqual(await getMapAssetRoadSegments(MAP_ASSET_ID), []);
});
