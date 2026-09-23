/**
 * Publish a second version of an installed map on a STOPPED local Studio host whose only change is
 * the OpenDRIVE file (for example an elevation refit): the map version, its artifacts and browser
 * closure are copied from the current version with `map.xodr` replaced, and both versions get
 * `descriptor.xodrGeometrySha256`. Used to exercise "Newer map version available" end to end.
 *
 *   SIMFORGE_CLOUD_ROOT=<host root> node --conditions=development --conditions=react-server --import tsx \
 *     e2e/tools/sim-history-map-v2.mts <sourceMapVersionId> <new map.xodr> <geometry sha256>
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { execute, queryOne, queryRows, shutdownDatabase } from "../../studio/app/lib/db/data-api";
import { writeLocalObject } from "../../studio/app/lib/s3/s3-object";

const [sourceId, xodrPath, geometry] = process.argv.slice(2);
if (!sourceId || !xodrPath || !/^[a-f0-9]{64}$/.test(geometry ?? "")) throw new Error("usage: <sourceMapVersionId> <map.xodr> <geometry sha256>");
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const xodr = readFileSync(xodrPath);
const xodrSha = sha(xodr);
const targetId = `usmap_${sha(`${sourceId}:${xodrSha}`).slice(0, 32)}`;

try {
  const source = await queryOne<Record<string, unknown>>(`SELECT * FROM simforge.map_versions WHERE id = :id`, { id: sourceId });
  if (!source) throw new Error(`map version ${sourceId} not found`);
  const set = await queryOne<Record<string, unknown>>(`SELECT * FROM simforge.browser_asset_sets WHERE id = :id`, { id: source.browser_asset_set_id });
  if (!set) throw new Error("source browser closure not found");
  const oldXodrBlob = await queryOne<{ storage_bucket: string; storage_key: string }>(
    `SELECT b.storage_bucket, b.storage_key FROM simforge.browser_asset_members m JOIN simforge.browser_asset_blobs b ON b.id = m.blob_id
      WHERE m.asset_set_id = :set AND m.relative_path = 'map.xodr'`,
    { set: set.id },
  );
  if (!oldXodrBlob) throw new Error("source closure has no map.xodr");
  // The new bytes, content-addressed next to the old ones.
  const storageKey = oldXodrBlob.storage_key.replace(/[a-f0-9]{64}$/, xodrSha);
  await writeLocalObject(oldXodrBlob.storage_bucket, storageKey, xodr, "application/xml");
  const blobId = `usbab_${xodrSha.slice(0, 24)}`;
  await execute(
    `INSERT INTO simforge.browser_asset_blobs (id, storage_bucket, storage_key, sha256, byte_length, media_type, verification_state, verified_at)
     VALUES (:id, :bucket, :key, :sha, :bytes, 'application/xml', 'verified', NOW()) ON CONFLICT (id) DO NOTHING`,
    { id: blobId, bucket: oldXodrBlob.storage_bucket, key: storageKey, sha: xodrSha, bytes: xodr.byteLength },
  );
  const artifactId = `usart_${xodrSha.slice(0, 24)}`;
  await execute(
    `INSERT INTO simforge.artifacts (id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key, sha256, byte_length,
       artifact_state, producer_job_family, producer_job_id, provenance, verified_at)
     SELECT :id, workspace_id, artifact_kind, media_type, :bucket, :key, :sha, :bytes, 'available', producer_job_family, producer_job_id, provenance, NOW()
       FROM simforge.artifacts WHERE id = :source ON CONFLICT (id) DO NOTHING`,
    { id: artifactId, bucket: oldXodrBlob.storage_bucket, key: storageKey, sha: xodrSha, bytes: xodr.byteLength, source: source.xodr_artifact_id },
  );
  const setId = `usbas_${sha(targetId).slice(0, 24)}`;
  await execute(
    `INSERT INTO simforge.map_versions
     SELECT (jsonb_populate_record(NULL::simforge.map_versions, to_jsonb(mv.*)
       || jsonb_build_object('id', CAST(:target AS text), 'xodr_sha256', CAST(:sha AS text), 'xodr_artifact_id', CAST(:artifact AS text), 'browser_asset_set_id', NULL,
            'derivative_release_id', CAST(:release AS text),
            'created_at', NOW(), 'label', mv.label, 'retired_at', NULL,
            'descriptor', mv.descriptor || jsonb_build_object('xodrGeometrySha256', CAST(:geometry AS text))))).*
       FROM simforge.map_versions mv WHERE mv.id = :source
     ON CONFLICT (id) DO NOTHING`,
    { target: targetId, sha: xodrSha, artifact: artifactId, geometry, source: sourceId, release: sha(`release:${targetId}`) },
  );
  await execute(
    `INSERT INTO simforge.browser_asset_sets
     SELECT (jsonb_populate_record(NULL::simforge.browser_asset_sets, to_jsonb(bs.*)
       || jsonb_build_object('id', CAST(:set AS text), 'map_version_id', CAST(:target AS text), 'closure_sha256', CAST(:closure AS text)))).*
       FROM simforge.browser_asset_sets bs WHERE bs.id = :source_set
     ON CONFLICT (id) DO NOTHING`,
    { set: setId, target: targetId, closure: sha(`${set.closure_sha256}:${xodrSha}`), source_set: set.id },
  );
  await execute(
    `INSERT INTO simforge.browser_asset_members (asset_set_id, relative_path, blob_id, role, required)
     SELECT :set, relative_path, CASE WHEN relative_path = 'map.xodr' THEN :blob ELSE blob_id END, role, required
       FROM simforge.browser_asset_members WHERE asset_set_id = :source_set
     ON CONFLICT (asset_set_id, relative_path) DO NOTHING`,
    { set: setId, blob: blobId, source_set: set.id },
  );
  await execute(`UPDATE simforge.map_versions SET browser_asset_set_id = :set WHERE id = :target`, { set: setId, target: targetId });
  await execute(
    `UPDATE simforge.map_versions SET descriptor = descriptor || jsonb_build_object('xodrGeometrySha256', CAST(:geometry AS text)) WHERE id = :source`,
    { geometry, source: sourceId },
  );
  const members = await queryRows(`SELECT 1 FROM simforge.browser_asset_members WHERE asset_set_id = :set`, { set: setId });
  console.log(JSON.stringify({ source: sourceId, target: targetId, xodrSha256: xodrSha, geometry, members: members.length }));
} finally {
  await shutdownDatabase();
}
