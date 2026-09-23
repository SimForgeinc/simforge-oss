import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import { cleanupRemovedMapAssetObjects } from "../../maps/map-asset-object-cleanup";
import { localObjectPath } from "@/app/lib/s3/s3-object";
import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import { putS3Object } from "@/app/lib/s3/s3-put-object";
import { seedPinnedMap, SIMULATION_MEMBERS } from "../../scenario/__tests__/pinning-fixtures";
import { execute, shutdownDatabase } from "@/app/lib/db/data-api";
import {
  collectReferencedDigests,
  partitionReferencedObjects,
  RETENTION_REFS_SCHEMA,
  retentionRefsDocument,
} from "../retention-refs";

/**
 * Deleting stored bytes must never remove what an immutable record needs. The
 * seeded map version binds an xodr artifact (sha "2"×64 at key
 * `usart_pin_xodr`) and browser members; a saved simulation result names its
 * trace by key and digest. Anything they name must survive a map-asset edit,
 * whether the version is live or retired.
 */
const XODR = "2".repeat(64);
const TRACE = "9".repeat(64);
const UNREFERENCED = "e".repeat(64);

async function seedSimResult(): Promise<void> {
  await execute(
    `INSERT INTO simforge.sim_results (
       workspace_id, sim_key, trace_sha256, authored_trace_sha256, engine_sem_ver, solver_ver, trace_schema,
       resolved_input_digest, map_closure_digest, traffic_provider, map_version_id, producer, storage_bucket,
       trace_storage_key, trace_byte_length, trace_gzip_sha256, resolution_storage_key, resolution_byte_length,
       resolution_sha256
     ) VALUES (
       :workspace_id, :sim_key, :trace, :trace, '0.10.0', '1', 'trace/4', :d, :d, 'off', 'usmapv_pin', 'test',
       :bucket, :trace_key, 10, :d, :resolution_key, 10, :d
     ) ON CONFLICT DO NOTHING`,
    {
      workspace_id: LOCAL_WORKSPACE_ID, sim_key: "f".repeat(64), trace: TRACE, d: "d".repeat(64), bucket: S3_BUCKET,
      trace_key: `${LOCAL_WORKSPACE_ID}/sim/sha256/${TRACE}.trace.json.gz`,
      resolution_key: `${LOCAL_WORKSPACE_ID}/sim/resolution/${"d".repeat(64)}.json`,
    },
  );
}

before(async () => {
  await migrate();
  await seedPinnedMap();
  await seedSimResult();
});
after(() => shutdownDatabase());

test("retention refs: every immutable record's digests and keys are protected", async () => {
  const digests = await collectReferencedDigests();
  for (const digest of [XODR, TRACE, ...Object.values(SIMULATION_MEMBERS)]) assert.ok(digests.has(digest), digest);
  assert.equal(digests.has(UNREFERENCED), false);

  const document = await retentionRefsDocument("studio:test", new Date("2026-09-22T00:00:00.000Z"));
  assert.equal(document.schema, RETENTION_REFS_SCHEMA);
  assert.deepEqual(document.digests, [...document.digests].sort());

  const partition = async () => partitionReferencedObjects(S3_BUCKET, [
    { key: "usart_pin_xodr" },
    { key: "maps/map-pin/copy-of-road.xodr", sha256: XODR },
    { key: `${LOCAL_WORKSPACE_ID}/sim/sha256/${TRACE}.trace.json.gz` },
    { key: "maps/map-pin/flyby.mp4", sha256: UNREFERENCED },
    { key: "maps/map-pin/3d/tile-0.glb" },
  ]);
  const live = await partition();
  assert.deepEqual(live.deletable, ["maps/map-pin/flyby.mp4", "maps/map-pin/3d/tile-0.glb"]);
  assert.deepEqual(live.retained.map((object) => object.key), [
    "usart_pin_xodr",
    "maps/map-pin/copy-of-road.xodr",
    `${LOCAL_WORKSPACE_ID}/sim/sha256/${TRACE}.trace.json.gz`,
  ]);
  assert.ok(live.retained[1]!.reasons.includes("simforge.map_versions.xodr_sha256"));
  assert.ok(live.retained[2]!.reasons.includes("simforge.sim_results.trace_storage_key"));

  // Retiring the map version does not release its bytes: its revisions still simulate on it.
  await execute(`UPDATE simforge.map_versions SET retired_at = NOW() WHERE id = 'usmapv_pin'`);
  assert.deepEqual((await partition()).retained.length, 3);
});

test("map-asset edit cleanup deletes only unreferenced objects of dropped artifacts", async () => {
  const keys = {
    road: "maps/map-pin/map-pin-road.xodr",
    flyby: "maps/map-pin/map-pin-mp4-1.mp4",
    tile: "maps/map-pin/3d/tile-0.glb",
    manifest: "maps/map-pin/3d/manifest.json",
  };
  for (const key of Object.values(keys)) await putS3Object(S3_BUCKET, key, Buffer.from(key), "application/octet-stream");

  const report = await cleanupRemovedMapAssetObjects({
    mapAssetId: "map-pin",
    bucket: S3_BUCKET,
    removedArtifacts: [
      // Same bytes as the published map version's road file: must stay.
      { artifact_type: "xodr", uri: `s3://${S3_BUCKET}/${keys.road}`, sha256: XODR },
      { artifact_type: "mp4", uri: `s3://${S3_BUCKET}/${keys.flyby}`, sha256: UNREFERENCED },
      { artifact_type: "3d_manifest", uri: `s3://${S3_BUCKET}/${keys.manifest}`, sha256: "a1".repeat(32) },
      // Another bucket is never this route's to delete.
      { artifact_type: "image", uri: "s3://someone-elses-bucket/maps/map-pin/x.png", sha256: UNREFERENCED },
    ],
  });
  assert.equal(report.cleanupError, undefined);
  assert.equal(report.deletedS3Objects, 3);
  assert.deepEqual(report.retainedS3Objects.map((object) => object.key).sort(), [
    keys.road,
    "s3://someone-elses-bucket/maps/map-pin/x.png",
  ]);
  assert.equal(existsSync(localObjectPath(S3_BUCKET, keys.road)), true);
  for (const key of [keys.flyby, keys.tile, keys.manifest]) {
    assert.equal(existsSync(localObjectPath(S3_BUCKET, key)), false, key);
  }
});
