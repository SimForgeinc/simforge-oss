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

import { open } from "node:fs/promises";

import type { ScenarioMapCoverageDto, ScenarioMapFootprintDto } from "@simforge-oss/studio-host";

import { MapAccessError, resolveAuthorizedMapMember } from "@/app/lib/cloud/access";
import { listLocalMapCatalog } from "@/app/lib/cloud/maps";
import { MAP_CACHE_BUCKET } from "@/app/lib/cloud/map-registry";
import { ensureMapAsset, resolveCachedMapAsset } from "@/app/lib/map-cache/service";
import { localObjectPath } from "@/app/lib/s3/s3-object";
import { mapFootprintGeometry, type MapFootprintGeometry } from "./footprint-geometry";

/** The `.xodr` member every map closure carries. */
const XODR_MEMBER = "map.xodr";
/** RoadRunner headers fit comfortably; `fetchXodrHeader` uses the same budget. */
const HEADER_PREFIX_BYTES = 16_384;

const CACHE_KEY = Symbol.for("simforge.map-footprints");
type FootprintCache = Map<string, { geometry: MapFootprintGeometry } | { reason: string }>;
const cache: FootprintCache = ((globalThis as Record<symbol, unknown>)[CACHE_KEY] ??= new Map()) as FootprintCache;

/** The first `HEADER_PREFIX_BYTES` of the map's `.xodr`, as text. */
async function readXodrHeaderText(mapVersionId: string, signal?: AbortSignal): Promise<string> {
  const { member } = await resolveAuthorizedMapMember({
    kind: "map",
    mapVersionId,
    profile: "browser",
    relativePath: XODR_MEMBER,
  });
  let path: string;
  if (member.bucket === MAP_CACHE_BUCKET) {
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
    path = cached.path;
  } else {
    path = localObjectPath(member.bucket, member.key);
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(HEADER_PREFIX_BYTES, member.byteLength));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Footprints of every map installed for the browser on this host.
 *
 * One map that cannot be placed never fails the request — the coverage map
 * needs the maps it can draw plus an honest list of the ones it cannot, with
 * the reason, so an installed map is never silently missing from the world.
 *
 * A locked map (published to an account, no session right now) is installed
 * but not readable, and is reported as such rather than opened behind the
 * access gate's back.
 */
export async function listMapFootprints(signal?: AbortSignal): Promise<ScenarioMapCoverageDto> {
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
