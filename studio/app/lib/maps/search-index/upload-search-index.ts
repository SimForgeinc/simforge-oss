/**
 * Upload a `search_index.json` sidecar to S3 and register it as a map asset
 * artifact of type `search_index`.
 *
 * Used by the `complete` and `populate-metadata` endpoints (1st build) and by
 * the enrichment-completion callback (2nd build). Idempotent — the unique
 * constraint on `map_asset_artifacts(map_asset_id, s3_bucket, s3_key)` plus the
 * ON CONFLICT DO UPDATE clause keeps a single row per (map, key) even across
 * repeated uploads.
 */

import { createHash } from "node:crypto";
import type { MapSearchIndex } from "@simforge-oss/studio-shared";
import { putS3ObjectUtf8Gzipped } from "@/app/lib/s3/s3-put-object";
import { execute } from "@/app/lib/db/data-api";

import { S3_BUCKET } from "@/app/lib/s3/s3-config";

const BUCKET = S3_BUCKET;
const MAPS_PREFIX = "maps/";

function artifactRowId(mapAssetId: string, key: string): string {
  return createHash("sha256")
    .update(`${mapAssetId}:${key}`)
    .digest("hex")
    .slice(0, 32);
}

export interface UploadSearchIndexResult {
  bucket: string;
  key: string;
  sha256: string;
  size_bytes: number;
  object_count: number;
}

export async function uploadAndRegisterSearchIndex(
  mapAssetId: string,
  index: MapSearchIndex,
): Promise<UploadSearchIndexResult> {
  const json = JSON.stringify(index);
  const sha256 = createHash("sha256").update(json).digest("hex");
  const key = `${MAPS_PREFIX}${mapAssetId}/${mapAssetId}.search-index.json`;
  const size_bytes = Buffer.byteLength(json, "utf8");
  const object_count = Object.keys(index.objects).length;

  await putS3ObjectUtf8Gzipped(BUCKET, key, json, "application/json");

  await execute(
    // Refresh `created_at` on conflict — for a derived artifact regenerated
    // by every refresh-search-index call, "created_at" is read by the UI as
    // "last refreshed", not "first ingested". Without this, the artifacts
    // panel keeps showing the original ingest date even after the bytes
    // change underneath, which looks like a broken refresh button.
    `
      INSERT INTO map_asset_artifacts (
        id, map_asset_id, artifact_type, s3_bucket, s3_key, checksum_sha256, label, size_bytes, sort_order
      )
      VALUES (
        :id, :map_asset_id, :artifact_type, :s3_bucket, :s3_key, :checksum_sha256, :label, :size_bytes, :sort_order
      )
      ON CONFLICT (map_asset_id, s3_bucket, s3_key)
      DO UPDATE SET
        artifact_type = EXCLUDED.artifact_type,
        checksum_sha256 = EXCLUDED.checksum_sha256,
        label = EXCLUDED.label,
        size_bytes = EXCLUDED.size_bytes,
        sort_order = EXCLUDED.sort_order,
        created_at = NOW()
    `,
    {
      id: artifactRowId(mapAssetId, key),
      map_asset_id: mapAssetId,
      artifact_type: "search_index",
      s3_bucket: BUCKET,
      s3_key: key,
      checksum_sha256: sha256,
      label: "Search index (auto-generated)",
      size_bytes,
      sort_order: 100,
    },
  );

  return { bucket: BUCKET, key, sha256, size_bytes, object_count };
}
