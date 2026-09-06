import "server-only";

import { createHash } from "node:crypto";

import { createMapBundle } from "@simforge-oss/compiler/node";
import type { CollisionDraftMapBinding } from "@simforge-oss/studio-host/node";

import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows } from "@/app/lib/db/data-api";
import { gunzipToUtf8 } from "@/app/lib/s3/gzip";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";

import { listScenarioMapDescriptors } from "./document-store";

/**
 * The immutable map a generated collision draft is planned on, executed on
 * and persisted against: the current published map version of the map asset,
 * loaded as the native compiler's `MapBundle` from the same five artifacts the
 * compiler worker downloads for an execution claim. `xodrSha256` is the
 * verified digest of the OpenDRIVE artifact itself, which the lowered
 * template's `sourceMap` records.
 */

export class CollisionDraftMapUnavailableError extends Error {
  constructor(
    readonly code: "map_version_missing" | "map_closure_incomplete",
    readonly mapAssetId: string,
    message: string,
  ) {
    super(message);
    this.name = "CollisionDraftMapUnavailableError";
  }
}

type ArtifactKind = "map-xodr" | "map-topology" | "map-derived-topology" | "map-locations" | "map-signals";

type ArtifactRow = {
  kind: ArtifactKind;
  storage_bucket: string;
  storage_key: string;
  sha256: string;
  byte_length: number | string;
};

const GZIP_MAGIC = [0x1f, 0x8b] as const;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

/**
 * Download one closure artifact and verify it against the row's recorded
 * size and sha256 before anything decompresses or parses it - the same
 * verified-artifact contract the compiler worker applies to its claim.
 */
async function readArtifactText(row: ArtifactRow): Promise<string> {
  const expectedBytes = Number(row.byte_length);
  if (!Number.isFinite(expectedBytes) || expectedBytes > MAX_ARTIFACT_BYTES) throw new Error("map_artifact_too_large");
  const bytes = await getS3ObjectBytes(row.storage_bucket, row.storage_key);
  if (bytes.length !== expectedBytes) throw new Error("map_artifact_size_mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error("map_artifact_digest_mismatch");
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]
    ? gunzipToUtf8(bytes)
    : Buffer.from(bytes).toString("utf8");
}

const MAX_CACHED_BUNDLES = 4;
const cache = new Map<string, Promise<CollisionDraftMapBinding>>();

async function loadBundle(mapVersionId: string, mapAssetId: string, mapName: string): Promise<CollisionDraftMapBinding> {
  const rows = await queryRows<ArtifactRow>(
    `SELECT ids.kind, a.storage_bucket, a.storage_key, a.sha256, a.byte_length
     FROM simforge.map_versions mv
     CROSS JOIN LATERAL unnest(
       ARRAY[mv.xodr_artifact_id, mv.topology_artifact_id, mv.derived_topology_artifact_id, mv.locations_artifact_id, mv.signals_artifact_id],
       ARRAY['map-xodr', 'map-topology', 'map-derived-topology', 'map-locations', 'map-signals']
     ) ids(id, kind)
     JOIN simforge.artifacts a ON a.id = ids.id
       AND a.workspace_id = mv.workspace_id AND a.artifact_state = 'available'
     WHERE mv.id = :map_version_id`,
    { map_version_id: mapVersionId },
  );
  if (rows.length !== 5) {
    throw new CollisionDraftMapUnavailableError(
      "map_closure_incomplete",
      mapAssetId,
      `map version ${mapVersionId} publishes ${rows.length}/5 of the artifacts the native compiler needs`,
    );
  }
  const text: Partial<Record<ArtifactKind, string>> = {};
  await Promise.all(rows.map(async (row) => {
    text[row.kind] = await readArtifactText(row);
  }));
  const bundle = createMapBundle({
    mapId: mapAssetId,
    topology: new TextEncoder().encode(text["map-topology"]!),
    derived: JSON.parse(text["map-derived-topology"]!),
    locations: JSON.parse(text["map-locations"]!),
    xodr: text["map-xodr"]!,
    signalsGeojson: JSON.parse(text["map-signals"]!),
  });
  return { mapVersionId, mapId: bundle.mapId, mapName, xodrSha256: rows.find((row) => row.kind === "map-xodr")!.sha256, bundle };
}

/** The current published map version of `mapAssetId` as a native map binding; cached per version. */
export async function loadCollisionDraftMap(context: AppContext, mapAssetId: string): Promise<CollisionDraftMapBinding> {
  const descriptor = (await listScenarioMapDescriptors(context)).find((map) => map.sourceMapId === mapAssetId);
  if (!descriptor) {
    throw new CollisionDraftMapUnavailableError(
      "map_version_missing",
      mapAssetId,
      `map asset ${mapAssetId} has no published map version to execute scenarios on`,
    );
  }
  const cached = cache.get(descriptor.mapVersionId);
  if (cached) return cached;
  const loading = loadBundle(descriptor.mapVersionId, descriptor.sourceMapId, descriptor.label);
  if (cache.size >= MAX_CACHED_BUNDLES) cache.delete(cache.keys().next().value!);
  cache.set(descriptor.mapVersionId, loading);
  try {
    return await loading;
  } catch (error) {
    if (cache.get(descriptor.mapVersionId) === loading) cache.delete(descriptor.mapVersionId);
    throw error;
  }
}
