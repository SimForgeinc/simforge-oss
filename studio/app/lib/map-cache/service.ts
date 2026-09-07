// The host process's one map cache service, wired to the real map access
// policy, plus the server-side entry points native jobs and map routes use.
// Route handlers under /api/simforge/map-cache/** call `getMapCacheService()`.

import { join } from "node:path";

import type {
  DesktopMapCacheEnsureRequest,
  DesktopMapCacheEnsureResult,
  DesktopMapCacheStatus,
} from "@simforge-oss/studio-host";
import { localHostStateDir } from "@simforge-oss/studio-host/node";

import { authorizeLocalMapAssetUrl, resolveMapAssetSource } from "@/app/lib/cloud/access";
import { MapCacheService, type MaterializeMapAssetsInput } from "./cache";

export { MapCacheError } from "./store";
export { MAP_CACHE_STREAM_PATH, MATERIALIZED_SIDECAR, type MaterializeMapAssetsInput } from "./cache";

/** `${SIMFORGE_MAP_CACHE_ROOT:-<local data root>/map-cache}`: the default cache root of this installation. */
export function defaultMapCacheRoot(env: NodeJS.ProcessEnv = process.env) {
  return env.SIMFORGE_MAP_CACHE_ROOT?.trim() || join(localHostStateDir(env), "map-cache");
}

const serviceKey = Symbol.for("simforge.local.map-cache");
const globalState = globalThis as typeof globalThis & { [serviceKey]?: Promise<MapCacheService> };

/** Opened on first use; one per host process, surviving Next dev reloads. */
export function getMapCacheService(): Promise<MapCacheService> {
  globalState[serviceKey] ??= MapCacheService.open({
    controlDir: defaultMapCacheRoot(),
    access: {
      authorize: (url) => authorizeLocalMapAssetUrl(url),
      resolveSource: (url, signal) => resolveMapAssetSource(url, signal),
    },
  }).catch((error: unknown) => {
    delete globalState[serviceKey];
    throw error;
  });
  return globalState[serviceKey];
}

export async function getMapCacheStatus(): Promise<DesktopMapCacheStatus> {
  return (await getMapCacheService()).status();
}

/** Make one authorized asset resident; `signal` cancels this subscriber only. */
export async function ensureMapAsset(request: DesktopMapCacheEnsureRequest, signal?: AbortSignal): Promise<DesktopMapCacheEnsureResult> {
  return (await getMapCacheService()).ensure(request, signal);
}

/** Server-only: the caller authorized its map before asking for the bytes. */
export async function resolveCachedMapAsset(sha256: string): Promise<{ path: string; sizeBytes: number } | null> {
  return (await getMapCacheService()).resolveCached(sha256);
}

/** Lay verified members out under `directory` for a native job (hardlink or bounded copy). */
export async function materializeMapAssets(input: MaterializeMapAssetsInput, signal?: AbortSignal): Promise<void> {
  return (await getMapCacheService()).materialize(input, signal);
}
