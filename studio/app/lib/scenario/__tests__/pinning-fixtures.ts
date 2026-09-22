import { createHash } from "node:crypto";

import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../auth/session";
import { execute } from "../../db/data-api";

export const CLOSURE_A = "a".repeat(64);
export const CLOSURE_B = "b".repeat(64);

/** The simulation members of the seeded closure, by path → blob digest. */
export const SIMULATION_MEMBERS: Record<string, string> = {
  "map.xodr": "2".repeat(64),
  "topology-index.json.gz": "3".repeat(64),
  "signals.geojson.gz": "4".repeat(64),
  "derived/topology-derived.json.gz": "5".repeat(64),
  "derived/locations.json.gz": "6".repeat(64),
  "3d/variants/static-colliders-v1.json": "8".repeat(64),
};

/** `simforge.map-pin-closure/v1` of a member map, as the pin query computes it. */
export function simulationClosureSha256(members: Record<string, string>): string {
  const lines = Object.keys(members).sort().map((path) => `${path} ${members[path]}\n`).join("");
  return createHash("sha256").update(lines).digest("hex");
}

/** Put `members` (path → digest) into asset set `setId`, creating blobs as needed. */
export async function setMembers(setId: string, members: Record<string, string>): Promise<void> {
  for (const [path, sha256] of Object.entries(members)) {
    const blobId = `usbab_${sha256.slice(0, 12)}_${path.length}`;
    await execute(
      `INSERT INTO simforge.browser_asset_blobs (id, storage_bucket, storage_key, sha256, byte_length, media_type, verification_state, verified_at)
       VALUES (:id, 'local-assets', :id, :sha256, :bytes, 'application/octet-stream', 'verified', NOW()) ON CONFLICT (id) DO NOTHING`,
      { id: blobId, sha256, bytes: path.length },
    );
    await execute(
      `INSERT INTO simforge.browser_asset_members (asset_set_id, relative_path, blob_id, role, required)
       VALUES (:set, :path, :blob, 'metadata', TRUE)
       ON CONFLICT (asset_set_id, relative_path) DO UPDATE SET blob_id = EXCLUDED.blob_id`,
      { set: setId, path, blob: blobId },
    );
  }
}

/** A workspace, dataset `usds_pin`, and one published map version `usmapv_pin` (closure A, catalog `usacv_pin`). */
export async function seedPinnedMap(): Promise<void> {
  await execute(
    `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
     VALUES (:id, 'Local Owner', 'owner@local.simforge', TRUE, 'owner') ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_USER_ID },
  );
  await execute(
    `INSERT INTO public.ba_organization (id, name, slug) VALUES (:id, 'Local Workspace', 'local') ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_ORGANIZATION_ID },
  );
  await execute(
    `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
     VALUES (:id, 'personal', 'local', 'Local Workspace', :user_id, :organization_id) ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID, organization_id: LOCAL_ORGANIZATION_ID },
  );
  for (const [id, kind, digest] of [["usart_pin_catalog", "asset_catalog_manifest", "1"], ["usart_pin_xodr", "opendrive_xml", "2"]] as const) {
    await execute(
      `INSERT INTO simforge.artifacts (
         id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key, sha256, byte_length,
         artifact_state, producer_job_family, producer_job_id, provenance
       ) VALUES (
         :id, :workspace_id, :kind, 'application/octet-stream', 'local-artifacts', :id, :sha256, 1,
         'available', 'openscenario_compile', :job, CAST(:provenance AS jsonb)
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id, workspace_id: LOCAL_WORKSPACE_ID, kind, sha256: digest.repeat(64), job: `seed:${id}`,
        provenance: { contract: "uniscenario.artifact-provenance/v1", producerJobFamily: "openscenario_compile", producerJobId: `seed:${id}` },
      },
    );
  }
  await execute(
    `INSERT INTO simforge.asset_catalog_versions (
       id, workspace_id, contract_version, manifest_artifact_id, manifest_sha256,
       source_inventory_sha256, pipeline_version, toolchain, provenance
     ) VALUES ('usacv_pin', :workspace_id, 'uniscenario.asset-catalog/v1', 'usart_pin_catalog', :sha256,
       :inventory, 'asset-catalog@1.0.0', '{}'::jsonb, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID, sha256: "1".repeat(64), inventory: "7".repeat(64) },
  );
  await execute(
    `INSERT INTO simforge.map_versions (
       id, workspace_id, source_map_id, label, browser_manifest_url, topology_artifact_url,
       xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256,
       descriptor, asset_catalog_version_id
     ) VALUES ('usmapv_pin', :workspace_id, 'map-pin', 'Pin St', 'local://manifest', 'local://topology',
       'usart_pin_xodr', :xodr, 'epsg:32610', :coordinate, '{}'::jsonb, 'usacv_pin') ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID, xodr: "2".repeat(64), coordinate: "c".repeat(64) },
  );
  await execute(
    `INSERT INTO simforge.browser_asset_sets (id, workspace_id, map_version_id, closure_sha256, object_count, byte_length, asset_set_state)
     VALUES ('usbas_pin', :workspace_id, 'usmapv_pin', :closure, 1, 1, 'available') ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID, closure: CLOSURE_A },
  );
  await setMembers("usbas_pin", SIMULATION_MEMBERS);
  await execute(`UPDATE simforge.map_versions SET browser_asset_set_id = 'usbas_pin' WHERE id = 'usmapv_pin'`);
  await execute(
    `INSERT INTO simforge.datasets (id, workspace_id, name) VALUES ('usds_pin', :workspace_id, 'pinning') ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
}

