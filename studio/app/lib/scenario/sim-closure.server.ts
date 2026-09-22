import "server-only";

import {
  loadSimulationMapClosure,
  type SimulationMapClosure,
} from "@simforge-oss/compiler/node";

import { serveLocalMapAsset } from "@/app/lib/cloud/asset-response";
import { queryOne } from "@/app/lib/db/data-api";

/**
 * The map closure an authoritative simulation runs against, built by the
 * editor's own loader from the same browser asset members the editor loads
 * (`/api/simforge/maps/<mapVersionId>/browser-assets/...`), static colliders
 * included. The members resolve through the route's own implementation, so
 * the bytes are the verified members the editor receives, from wherever this
 * host stores them.
 *
 * One closure per map version is kept per process; a failed load is not
 * cached. The playback collider loader memoizes by URL (failures included),
 * so every load attempt uses its own internal origin.
 */

const MAX_CACHED_CLOSURES = 3;
const closures = new Map<string, Promise<SimulationMapClosure>>();
let loadAttempt = 0;

export class SimulationClosureUnavailableError extends Error {
  constructor(readonly code: "map_version_missing" | "map_browser_closure_missing", message: string) {
    super(message);
    this.name = "SimulationClosureUnavailableError";
  }
}

export type SimulationMapIdentity = {
  mapVersionId: string;
  mapAssetId: string;
  browserClosureSha256: string;
};

/** The immutable identity a closure is built from; readable without loading the closure. */
export async function readSimulationMapIdentity(mapVersionId: string): Promise<SimulationMapIdentity> {
  const row = await queryOne<{ id: string; source_map_asset_id: string | null; closure_sha256: string | null }>(
    `SELECT mv.id, mv.source_map_asset_id, bs.closure_sha256
       FROM simforge.map_versions mv
       LEFT JOIN simforge.browser_asset_sets bs
         ON bs.id = mv.browser_asset_set_id AND bs.map_version_id = mv.id
        AND bs.asset_set_state = 'available'
      WHERE mv.id = :map_version_id
      LIMIT 1`,
    { map_version_id: mapVersionId },
  );
  if (!row?.source_map_asset_id) {
    throw new SimulationClosureUnavailableError("map_version_missing", `map version ${mapVersionId} is not published`);
  }
  if (!row.closure_sha256) {
    throw new SimulationClosureUnavailableError(
      "map_browser_closure_missing",
      `map version ${mapVersionId} has no available browser asset closure to simulate against`,
    );
  }
  return { mapVersionId: row.id, mapAssetId: row.source_map_asset_id, browserClosureSha256: row.closure_sha256 };
}

/** Resolve browser-asset member URLs through the route implementation (and a store redirect). */
export function mapMemberFetcher(origin: string, serve = serveLocalMapAsset): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (!url.pathname.startsWith("/api/simforge/maps/")) {
      throw new Error(`simulation closure member outside the map asset routes: ${url.pathname}`);
    }
    const response = await serve(new Request(url), false);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`map asset redirect without a location: ${url.pathname}`);
      return fetch(new URL(location, url), { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    }
    return response;
  }) as typeof fetch;
}

function memberSources(mapVersionId: string) {
  const root = `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/browser-assets`;
  return {
    manifest: `${root}/3d/manifest.json`,
    topology: `${root}/topology-index.json.gz`,
    derivedTopology: `${root}/derived/topology-derived.json.gz`,
    locations: `${root}/derived/locations.json.gz`,
    xodr: `${root}/map.xodr`,
    signals: `${root}/signals.geojson.gz`,
  };
}

export async function loadServerSimulationClosure(identity: SimulationMapIdentity): Promise<SimulationMapClosure> {
  const cached = closures.get(identity.mapVersionId);
  if (cached) return cached;
  loadAttempt += 1;
  const loading = loadSimulationMapClosure({
    mapVersionId: identity.mapVersionId,
    mapAssetId: identity.mapAssetId,
    browserClosureSha256: identity.browserClosureSha256,
    sources: memberSources(identity.mapVersionId),
    fetcher: mapMemberFetcher(`http://simforge-simulation-closure-${loadAttempt}.internal`),
  });
  if (closures.size >= MAX_CACHED_CLOSURES) closures.delete(closures.keys().next().value!);
  closures.set(identity.mapVersionId, loading);
  try {
    return await loading;
  } catch (error) {
    if (closures.get(identity.mapVersionId) === loading) closures.delete(identity.mapVersionId);
    throw error;
  }
}

/** Test seam: drop every cached closure. */
export function resetSimulationClosuresForTests(): void {
  closures.clear();
}
