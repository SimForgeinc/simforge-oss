/**
 * Where on Earth each installed map is: the WGS84 footprint of every map this
 * installation can open, for the scenario coverage map.
 *
 * The bytes are the map's own `map.xodr` member, authorized and resolved the
 * way the browser-asset route resolves it, and only its first kilobytes are
 * read — the `<header>` is all georeferencing needs, and a RoadRunner export
 * is megabytes. Footprints are memoized per `xodr.sha256`, which is immutable
 * for a map version, so a map is projected once per host process.
 *
 * A map whose header has no `<geoReference>` (or no usable extents) is
 * reported as unprojected rather than dropped: the coverage map lists it so
 * an author can see the map exists and why it is not on the map.
 */

import type { ScenarioMapCoverageDto, ScenarioMapFootprintDto } from "@simforge-oss/studio-host";

import { queryRows } from "@/app/lib/db/data-api";
import { MapAccessError, resolveAuthorizedMapMember } from "@/app/lib/cloud/access";
import { listLocalMapCatalog } from "@/app/lib/cloud/maps";
import { MAP_CACHE_BUCKET } from "@/app/lib/cloud/map-registry";
import { ensureMapAsset, resolveCachedMapAsset } from "@/app/lib/map-cache/service";
import { streamLocalObject } from "@/app/lib/s3/s3-object";
import { mapFootprintGeometry, type MapFootprintGeometry } from "./footprint-geometry";

/** The `.xodr` member every map closure carries. */
const XODR_MEMBER = "map.xodr";
/** RoadRunner headers fit comfortably; `fetchXodrHeader` uses the same budget. */
const HEADER_PREFIX_BYTES = 16_384;

const CACHE_KEY = Symbol.for("simforge.map-footprints");
type FootprintCache = Map<string, { geometry: MapFootprintGeometry } | { reason: string }>;
const cache: FootprintCache = ((globalThis as Record<symbol, unknown>)[CACHE_KEY] ??= new Map()) as FootprintCache;

/**
 * The first `limit` bytes of a stream, as text. The stream is destroyed once
 * the budget is met so a multi-megabyte object is not read past its header.
 */
async function readPrefix(stream: Readable, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).byteLength;
    if (size >= limit) {
      stream.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

/**
 * The first `HEADER_PREFIX_BYTES` of the map's `.xodr`, as text.
 *
 * A member in the map cache's own bucket is ensured resident and read from
 * the cache file; a member whose row names a real object store is read
 * through the object seam, which is the only way a host without local
 * object files can reach it.
 */
async function readXodrHeaderText(mapVersionId: string, signal?: AbortSignal): Promise<string> {
  const { member } = await resolveAuthorizedMapMember({
    kind: "map",
    mapVersionId,
    profile: "browser",
    relativePath: XODR_MEMBER,
  });
  if (member.bucket !== MAP_CACHE_BUCKET) {
    return readPrefix(streamLocalObject(member.bucket, member.key), HEADER_PREFIX_BYTES);
  }
  let cached = await resolveCachedMapAsset(member.sha256);
  if (!cached) {
    await ensureMapAsset({
      requestId: `footprint:${member.sha256}`,
      url: `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/browser-assets/${XODR_MEMBER}`,
      sha256: member.sha256,
      sizeBytes: member.byteLength,
    }, signal);
    cached = await resolveCachedMapAsset(member.sha256);
  }
  if (!cached) throw new MapAccessError("MapCacheError", "map_asset_unavailable", `${XODR_MEMBER} is not resident`);
  return readPrefix(createReadStream(cached.path, { start: 0, end: HEADER_PREFIX_BYTES - 1 }), HEADER_PREFIX_BYTES);
}

/**
 * Persisted footprint metadata is served in one small query.
 */
type PersistedFootprintRow = {
  id: string;
  source_map_id: string;
  footprint: unknown;
};
/**
 * Footprints are immutable map-version metadata. Keep this read deliberately
 * independent of the catalog: the catalog also verifies every closure member
 * and performs remote discovery, neither of which is needed by this endpoint.
 */
async function readPersistedFootprints(): Promise<ScenarioMapFootprintDto[]> {
  const rows = await queryRows<PersistedFootprintRow>(
    `SELECT DISTINCT ON (mv.source_map_asset_id)
       mv.id, mv.source_map_asset_id AS source_map_id,
       mv.descriptor->'footprint' AS footprint
     FROM simforge.map_versions mv
     JOIN simforge.browser_asset_sets bas
       ON bas.id = mv.browser_asset_set_id
      AND bas.workspace_id = mv.workspace_id
      AND bas.asset_set_state = 'available'
     WHERE mv.retired_at IS NULL
       AND NULLIF(BTRIM(mv.source_map_asset_id), '') IS NOT NULL
     ORDER BY mv.source_map_asset_id, mv.created_at DESC, mv.id DESC`,
    {},
  );
  const result: ScenarioMapFootprintDto[] = [];
  for (const row of rows) {
    const value = row.footprint as { polygon?: unknown; center?: unknown } | null;
    if (!Array.isArray(value?.polygon) || !Array.isArray(value?.center)) continue;
    result.push({
      mapVersionId: row.id,
      sourceMapId: row.source_map_id,
      polygon: value.polygon as Array<[number, number]>,
      center: value.center as [number, number],
    });
  }
  return result;
}

 * Footprints of every map installed for the browser on this host.
 *
 * One map that cannot be placed never fails the request — the coverage map
 * needs the maps it can draw plus an honest list of the ones it cannot, with
 * the reason, so an installed map is never silently missing from the world.
 *
 * A locked map (published to an account, no session right now) is installed
 * but not readable, and is reported as such rather than opened behind the
 * access gate's back.
export async function listMapFootprints(signal?: AbortSignal): Promise<ScenarioMapCoverageDto> {
  const persisted = await readPersistedFootprints();
  if (persisted.length > 0) {
    return { footprints: persisted, unprojected: [] };
  }
  // Compatibility path for maps published before descriptor footprints were
  // introduced. It is intentionally retained as a one-time backfill path;
  // newly published versions are expected to carry immutable geometry.
  const maps = (await listLocalMapCatalog(signal)).filter((map) => map.ready.browser);
  const footprints: ScenarioMapFootprintDto[] = [];
  const unprojected: ScenarioMapCoverageDto["unprojected"] = [];
  for (const map of maps) {
    const identity = { mapVersionId: map.mapVersionId, sourceMapId: map.sourceMapId };
    if (map.locked) {
      unprojected.push({ ...identity, reason: "needs a SimCloud connection" });
      continue;
    }
    let entry = cache.get(map.xodr.sha256);
    if (!entry) {
      try {
        entry = { geometry: mapFootprintGeometry(await readXodrHeaderText(map.mapVersionId, signal)) };
      } catch (error) {
        entry = {
          reason: error instanceof MapAccessError ? "map bytes unavailable" : "no georeference",
        };
      }
      cache.set(map.xodr.sha256, entry);
    }
    if ("geometry" in entry) {
      footprints.push({ ...identity, polygon: entry.geometry.polygon, center: entry.geometry.center });
    } else {
      unprojected.push({ ...identity, reason: entry.reason });
    }
  }
  return { footprints, unprojected };
}
