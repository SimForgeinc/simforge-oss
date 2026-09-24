import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_WORKSPACE_ID } from "../../auth/session";
import { BUNDLED_MAPS } from "../../cloud/bundled-maps";
import { retiredMapVersionIds } from "../../cloud/maps";
import { execute, shutdownDatabase } from "../../db/data-api";
import { readNewestScenarioMapDescriptorRows, readScenarioMapCatalogCacheKey } from "../document-store";
import { seedPinnedMap, setMembers } from "./pinning-fixtures";

/**
 * Map retirement is written out of band (release and rollout scripts set
 * `map_versions.retired_at` directly), so the editor catalog's cache key is the
 * only thing that can make it visible. The catalog is cached under that key
 * (`"use cache"` keys on the function's arguments); this models exactly that:
 * rows are computed once per key and reused for as long as the key is.
 */

const MAP_VERSION = "usmapv_pin";

async function catalogUnderKeyedCache(cache: Map<string, string[]>): Promise<string[]> {
  const key = await readScenarioMapCatalogCacheKey();
  let ids = cache.get(key);
  if (!ids) {
    ids = (await readNewestScenarioMapDescriptorRows(key)).map((row) => row.id);
    cache.set(key, ids);
  }
  return ids;
}

async function setRetired(id: string, retired: boolean): Promise<void> {
  await execute(
    `UPDATE simforge.map_versions SET retired_at = ${retired ? "NOW()" : "NULL"} WHERE id = :id`,
    { id },
  );
}

before(async () => {
  await migrate();
  await seedPinnedMap();
  // The members the editor catalog requires beyond the simulation closure.
  await setMembers("usbas_pin", {
    "3d/manifest.json": "9".repeat(64),
    "lane-polygons.geojson.gz": "a".repeat(64),
  });
  await execute(
    `UPDATE simforge.browser_asset_members SET role = 'manifest'
      WHERE asset_set_id = 'usbas_pin' AND relative_path = '3d/manifest.json'`,
  );
});

after(async () => {
  await shutdownDatabase();
});

test("retiring a map version removes it from the cached catalog immediately; unretiring brings it back", async () => {
  const cache = new Map<string, string[]>();
  const liveKey = await readScenarioMapCatalogCacheKey();
  assert.deepEqual(await catalogUnderKeyedCache(cache), [MAP_VERSION]);

  await setRetired(MAP_VERSION, true);
  const retiredKey = await readScenarioMapCatalogCacheKey();
  assert.notEqual(retiredKey, liveKey, "retirement must change the catalog cache key");
  assert.deepEqual(await catalogUnderKeyedCache(cache), []);

  await setRetired(MAP_VERSION, false);
  assert.equal(await readScenarioMapCatalogCacheKey(), liveKey, "unretiring restores the previous key");
  assert.deepEqual(await catalogUnderKeyedCache(cache), [MAP_VERSION]);
});

test("the key follows the descriptor fields the catalog reads", async () => {
  const before = await readScenarioMapCatalogCacheKey();
  await execute(
    `UPDATE simforge.map_versions SET descriptor = descriptor || CAST(:patch AS jsonb) WHERE id = :id`,
    { id: MAP_VERSION, patch: { ground: { sha256: "b".repeat(64) } } },
  );
  assert.notEqual(await readScenarioMapCatalogCacheKey(), before);
});

test("a bundled or upstream descriptor never resurrects a version this installation retired", async () => {
  const bundled = BUNDLED_MAPS[0]!.descriptor;
  await execute(
    `INSERT INTO public.map_assets (id, name) VALUES (:id, :name) ON CONFLICT (id) DO NOTHING`,
    { id: bundled.sourceMapId, name: bundled.label },
  );
  await execute(
    `INSERT INTO simforge.map_versions (
       id, workspace_id, source_map_id, source_map_asset_id, label, browser_manifest_url, topology_artifact_url,
       xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256,
       descriptor, asset_catalog_version_id, retired_at
     ) VALUES (:id, :workspace_id, :source, :source, :label, 'local://manifest', 'local://topology',
       'usart_pin_xodr', :xodr, 'epsg:32610', :coordinate, '{}'::jsonb, 'usacv_pin', NOW())
     ON CONFLICT (id) DO NOTHING`,
    {
      id: bundled.mapVersionId,
      workspace_id: LOCAL_WORKSPACE_ID,
      source: bundled.sourceMapId,
      label: bundled.label,
      xodr: "2".repeat(64),
      coordinate: "c".repeat(64),
    },
  );
  assert.deepEqual(
    [...await retiredMapVersionIds([bundled.mapVersionId, MAP_VERSION, "usmapv_unknown"])],
    [bundled.mapVersionId],
  );
  await setRetired(bundled.mapVersionId, false);
  assert.deepEqual([...await retiredMapVersionIds([bundled.mapVersionId])], []);
});
