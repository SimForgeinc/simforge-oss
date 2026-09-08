import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { test } from "node:test";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../auth/session";
import { execute, shutdownDatabase } from "../../db/data-api";
import { upsertMapAsset } from "../../db/map-asset-store";
import { getNativeMapBundle, NativeMapBundleError } from "../native-map-bundle";

/**
 * The assistant names a map by its source asset AND the immutable version the
 * document is open on. Each half is checked against the local registry before
 * any closure member is read, so a wrong or foreign identity is a coded
 * refusal the route can answer with — never a partial bundle.
 */
async function seedIdentity() {
  await execute(
    `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
     VALUES (:id, 'Local Owner', 'owner@local.simforge', TRUE, 'owner') ON CONFLICT (id) DO NOTHING`,
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
}

async function expectCode(input: { mapAssetId: string; mapVersionId: string }, code: NativeMapBundleError["code"]) {
  await assert.rejects(
    getNativeMapBundle(input),
    (error: unknown) => error instanceof NativeMapBundleError && error.code === code,
    `expected ${code}`,
  );
}

test("native bundle identity is verified against the local registry before any member is read", async (t) => {
  t.after(() => shutdownDatabase());
  await migrate();
  await seedIdentity();
  for (const id of ["town-a", "town-b"]) {
    await upsertMapAsset({
      map_asset_id: id,
      name: id,
      crs: "OpenDRIVE",
      bbox: { min_lat: 0, min_lng: 0, max_lat: 1, max_lng: 1 },
      center: { lat: 0.5, lng: 0.5 },
      created_at: new Date(0).toISOString(),
      tags: [],
      artifacts: [],
    });
  }
  // The smallest immutable closure identity the schema admits: a publication
  // draft as producer, one artifact row standing for every member, one signed
  // catalog, one map version.
  const sha = "a".repeat(64);
  await execute(
    `INSERT INTO simforge.map_upload_drafts (
       id, workspace_id, created_by_user_id, label, locality, carla_map_name,
       source_map_id, xodr_sha256, xodr_byte_length, thumbnail_sha256,
       thumbnail_byte_length, layers, preflight, draft_state
     ) VALUES (
       'usmapdraft_0123456789abcdef0123456789abcdef', :workspace_id, :user_id, 'Town A', 'Fixture', NULL,
       'town-a', :sha, 1, :sha, 1, '[]'::jsonb, '{}'::jsonb, 'publishing'
     )`,
    { workspace_id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID, sha },
  );
  await execute(
    `INSERT INTO simforge.artifacts (
       id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
       sha256, byte_length, artifact_state, producer_job_family, producer_job_id
     ) VALUES ('artifact_fixture', :workspace_id, 'source-map-xodr', 'application/xml',
       'fixture', 'fixture/map.xodr', :sha, 1, 'available', 'map_publication', 'usmapdraft_0123456789abcdef0123456789abcdef')`,
    { workspace_id: LOCAL_WORKSPACE_ID, sha },
  );
  await execute(
    `INSERT INTO simforge.asset_catalog_versions (
       id, workspace_id, manifest_artifact_id, manifest_sha256, source_inventory_sha256,
       pipeline_version, toolchain, provenance
     ) VALUES ('catalog_fixture', :workspace_id, 'artifact_fixture', :sha, :sha,
       'fixture', '{}'::jsonb, '{}'::jsonb)`,
    { workspace_id: LOCAL_WORKSPACE_ID, sha },
  );
  await execute(
    `INSERT INTO simforge.map_versions (
       id, workspace_id, source_map_asset_id, source_map_id, label, locality,
       browser_manifest_url, topology_artifact_url, xodr_artifact_id, xodr_sha256,
       coordinate_system_id, coordinate_system_sha256, asset_catalog_version_id
     ) VALUES (
       'usmap_town_a_v1', :workspace_id, 'town-a', 'town-a', 'Town A', 'Fixture',
       'uniscenario-browser:fixture/3d/manifest.json', 'uniscenario-browser:fixture/topology-index.json.gz',
       'artifact_fixture', :sha, 'coordinate-system', :sha, 'catalog_fixture'
     )`,
    { workspace_id: LOCAL_WORKSPACE_ID, sha },
  );

  await expectCode({ mapAssetId: "nowhere", mapVersionId: "usmap_town_a_v1" }, "map_asset_missing");
  await expectCode({ mapAssetId: "town-a", mapVersionId: "usmap_missing" }, "map_version_not_found");
  await expectCode({ mapAssetId: "town-b", mapVersionId: "usmap_town_a_v1" }, "map_version_mismatch");
});
