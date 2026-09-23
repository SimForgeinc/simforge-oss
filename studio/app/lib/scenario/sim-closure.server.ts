import "server-only";

import { tmpdir } from "node:os";
import path from "node:path";

import {
  GROUND_MESH_MEMBER,
  loadSimulationMapClosure,
  simulationMemberSources,
  stagedSumoRuntime,
  SUMO_RUNTIME_OBJECT_PREFIX,
  type SimulationMapClosure,
} from "@simforge-oss/compiler/node";
import { PINNED_SUMO_RUNTIME_VERSION, type SumoRuntime } from "@simforge-oss/engine/node";

import { serveLocalMapAsset } from "@/app/lib/cloud/asset-response";
import { localObjectGetResponse } from "@/app/lib/s3/local-object-response";
import { queryOne } from "@/app/lib/db/data-api";
import { SUMO_RUNTIME_BUCKET } from "@/app/lib/s3/s3-config";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";

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
  /** `map_versions.sumo_network_sha256`: the SUMO network a SUMO document's traffic runs on. */
  sumoNetworkSha256: string | null;
  /** The published closure carries `derived/ground/ground-mesh.bin` (engine 0.11 ground contact). */
  hasGround: boolean;
};

/** The immutable identity a closure is built from; readable without loading the closure. */
export async function readSimulationMapIdentity(mapVersionId: string): Promise<SimulationMapIdentity> {
  const row = await queryOne<{ id: string; source_map_asset_id: string | null; closure_sha256: string | null; sumo_network_sha256: string | null; has_ground: boolean | null }>(
    `SELECT mv.id, mv.source_map_asset_id, bs.closure_sha256, mv.sumo_network_sha256,
            EXISTS (SELECT 1 FROM simforge.browser_asset_members gm
                     WHERE gm.asset_set_id = bs.id AND gm.relative_path = :ground_member) AS has_ground
       FROM simforge.map_versions mv
       LEFT JOIN simforge.browser_asset_sets bs
         ON bs.id = mv.browser_asset_set_id AND bs.map_version_id = mv.id
        AND bs.asset_set_state = 'available'
      WHERE mv.id = :map_version_id
      LIMIT 1`,
    { map_version_id: mapVersionId, ground_member: GROUND_MESH_MEMBER },
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
  return {
    mapVersionId: row.id,
    mapAssetId: row.source_map_asset_id,
    browserClosureSha256: row.closure_sha256,
    sumoNetworkSha256: row.sumo_network_sha256,
    hasGround: row.has_ground === true,
  };
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
      const target = new URL(location, url);
      // A local host redirects to its own signed object route (a same-origin path); this process
      // is that host, so the object is served here rather than over a network it has no name for.
      const local = target.origin === url.origin ? target.pathname.match(/^\/api\/local-objects\/([^/]+)\/(.+)$/) : null;
      if (local) {
        return localObjectGetResponse(
          new Request(target),
          decodeURIComponent(local[1]!),
          local[2]!.split("/").map((part) => decodeURIComponent(part)),
        );
      }
      return fetch(target, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    }
    return response;
  }) as typeof fetch;
}

function memberSources(mapVersionId: string, ground: boolean) {
  return simulationMemberSources(`/api/simforge/maps/${encodeURIComponent(mapVersionId)}/browser-assets`, { ground });
}

export async function loadServerSimulationClosure(identity: SimulationMapIdentity): Promise<SimulationMapClosure> {
  const cached = closures.get(identity.mapVersionId);
  if (cached) return cached;
  loadAttempt += 1;
  const loading = loadSimulationMapClosure({
    mapVersionId: identity.mapVersionId,
    mapAssetId: identity.mapAssetId,
    browserClosureSha256: identity.browserClosureSha256,
    sources: memberSources(identity.mapVersionId, identity.hasGround),
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

/** One browser asset member of a map version, through the same verified route the editor loads it from. */
export async function readServerMapMember(mapVersionId: string, relativePath: string): Promise<Uint8Array> {
  loadAttempt += 1;
  const fetcher = mapMemberFetcher(`http://simforge-simulation-closure-${loadAttempt}.internal`);
  const response = await fetcher(`/api/simforge/maps/${encodeURIComponent(mapVersionId)}/browser-assets/${relativePath}`);
  if (!response.ok) throw new Error(`map_member_unavailable: ${relativePath} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The pinned SUMO runtime the editor loads (`/api/simforge/sumo-runtime`),
 * staged from the runtime bucket into this process's temp directory once and
 * verified against the pin on load.
 */
export function serverSumoRuntime(): Promise<SumoRuntime> {
  return stagedSumoRuntime(
    path.join(tmpdir(), "simforge-sumo-runtime", PINNED_SUMO_RUNTIME_VERSION),
    (file) => getS3ObjectBytes(SUMO_RUNTIME_BUCKET, `${SUMO_RUNTIME_OBJECT_PREFIX}${file}`),
  );
}

/** Test seam: drop every cached closure. */
export function resetSimulationClosuresForTests(): void {
  closures.clear();
}
