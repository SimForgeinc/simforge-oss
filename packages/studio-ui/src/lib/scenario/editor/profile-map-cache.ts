import type { RenderingPreference } from "../../../components/rendering-preference";
import type { ScenarioMapOption } from "../../../scenario/list/document-map-groups";
import {
  ensureMapAsset,
  flushMapAssetCacheIndex,
  hasCachedMapAsset,
  mapAssetCacheStatus,
  mapCacheReceiptKey,
  prepareMapAssetCache,
  writeCacheReceipt,
} from "../../maps/frontend/map-asset-cache";
import {
  SUMO_RUNTIME_MANIFEST_URL,
  SUMO_RUNTIME_MODULE_URL,
  SUMO_RUNTIME_WASM_URL,
} from "../sumo-runtime";

const MIN_DOWNLOAD_CONCURRENCY = 8;
const MAX_DOWNLOAD_CONCURRENCY = 12;
const DOWNLOAD_URL_BATCH_SIZE = 96;
const MAX_CACHE_LOOKUP_CONCURRENCY = 24;
const MAX_ASSET_DOWNLOAD_ATTEMPTS = 2;
/** A broken response or Cache Storage write must not hold bulk preparation open forever. */
export const PROFILE_MAP_ASSET_ATTEMPT_TIMEOUT_MS = 90_000;

export type ProfileMapAsset = {
  url: string;
  bytes: number | null;
  mapVersionId: string;
  /** Content identity enables one cached response to serve duplicate map paths. */
  sha256?: string;
  /** Other stable paths backed by the same immutable content. */
  aliases?: string[];
};

export type ProfileMapPlanMap = {
  mapVersionId: string;
  closureSha256: string;
  assets: ProfileMapAsset[];
  totalBytes: number;
  remainingAssets: number;
  remainingBytes: number;
  fullyCached: boolean;
};

export type ProfileMapPlan = {
  releaseKey: string;
  profile: RenderingPreference;
  mapCount: number;
  maps: ProfileMapPlanMap[];
  assets: ProfileMapAsset[];
  /** Unique content blobs that were not already present when this plan was calculated. */
  pendingAssets?: ProfileMapAsset[];
  totalBytes: number;
  remainingBytes: number;
  remainingAssets: number;
  unknownSizeAssets: number;
  fullyCachedMapVersionIds: string[];
};

type CacheInventory = {
  releaseKey: string;
  maps: Array<{
    mapVersionId: string;
    closureSha256: string;
    assets: Array<{
      relativePath: string;
      sha256: string;
      byteLength: number;
      mediaType?: string;
      required?: boolean;
    }>;
  }>;
};

export type ProfileMapCacheProgress = {
  completedAssets: number;
  totalAssets: number;
  completedBytes: number;
  totalBytes: number;
  currentMapVersionId: string | null;
};

export type ProfileMapCacheResult = {
  failedAssets: number;
  /** The last verification/storage error, so the UI can say what to fix. */
  failureReason: string | null;
  completedMapVersionIds: string[];
};

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        const value = values[index];
        if (value !== undefined) output[index] = await worker(value, index);
      }
    }),
  );
  return output;
}

export function profileMapDownloadConcurrency(): number {
  if (typeof navigator === "undefined") return MIN_DOWNLOAD_CONCURRENCY;
  const connection = (navigator as Navigator & {
    connection?: { effectiveType?: string; saveData?: boolean };
  }).connection;
  if (connection?.saveData || connection?.effectiveType === "2g") {
    return MIN_DOWNLOAD_CONCURRENCY;
  }
  const cores = navigator.hardwareConcurrency || 4;
  if (connection?.effectiveType === "4g" && cores >= 8) {
    return MAX_DOWNLOAD_CONCURRENCY;
  }
  return cores >= 8 ? 10 : MIN_DOWNLOAD_CONCURRENCY;
}

function batchDownloadRequest(asset: ProfileMapAsset) {
  const url = new URL(asset.url, window.location.origin);
  const match = /^\/api\/simforge\/maps\/([^/]+)\/browser-assets\/(.+)$/.exec(
    url.pathname,
  );
  if (!match?.[1] || !match[2]) return null;
  return {
    mapVersionId: decodeURIComponent(match[1]),
    relativePath: decodeURIComponent(match[2]),
  };
}

async function resolveBatchDownloadUrls(
  assets: ProfileMapAsset[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const requested = assets.flatMap((asset) => {
    const parsed = batchDownloadRequest(asset);
    return parsed ? [{ assetUrl: asset.url, ...parsed }] : [];
  });
  if (requested.length === 0) return new Map();
  try {
    const response = await fetch("/api/simforge/maps/cache-download-urls", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assets: requested.map(({ mapVersionId, relativePath }) => ({
          mapVersionId,
          relativePath,
        })),
      }),
      signal,
    });
    if (!response.ok) return new Map();
    const payload = await response.json() as {
      assets?: Array<{ mapVersionId: string; relativePath: string; url: string }>;
    };
    const canonicalByKey = new Map(
      requested.map(({ assetUrl, mapVersionId, relativePath }) => [
        `${mapVersionId}\n${relativePath}`,
        assetUrl,
      ]),
    );
    return new Map((payload.assets ?? []).flatMap((asset) => {
      const canonical = canonicalByKey.get(
        `${asset.mapVersionId}\n${asset.relativePath}`,
      );
      return canonical && typeof asset.url === "string"
        ? [[canonical, asset.url] as const]
        : [];
    }));
  } catch {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return new Map();
  }
}

async function withAssetAttemptDeadline<T>(
  signal: AbortSignal,
  worker: (attemptSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new DOMException("Asset download timed out", "TimeoutError");
  let rejectDeadline: (reason: DOMException) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
    timeoutId = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, PROFILE_MAP_ASSET_ATTEMPT_TIMEOUT_MS);
  });
  const abortFromParent = () => {
    const abortError = new DOMException("Aborted", "AbortError");
    controller.abort(signal.reason ?? abortError);
    rejectDeadline(abortError);
  };
  signal.addEventListener("abort", abortFromParent, { once: true });
  try {
    return await Promise.race([worker(controller.signal), deadline]);
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortFromParent);
  }
}

function groupByContent(assets: readonly ProfileMapAsset[]): ProfileMapAsset[] {
  const grouped = new Map<string, ProfileMapAsset>();
  for (const asset of assets) {
    const key = asset.sha256 ? `sha256:${asset.sha256}` : `url:${asset.url}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...asset, aliases: [] });
    } else if (asset.url !== existing.url && !existing.aliases?.includes(asset.url)) {
      existing.aliases?.push(asset.url);
    }
  }
  return [...grouped.values()];
}

async function runtimeAssets(signal: AbortSignal): Promise<ProfileMapAsset[]> {
  return Promise.all(
    [SUMO_RUNTIME_MANIFEST_URL, SUMO_RUNTIME_MODULE_URL, SUMO_RUNTIME_WASM_URL]
      .map(async (url): Promise<ProfileMapAsset> => {
        const head = await fetch(url, { method: "HEAD", signal });
        if (!head.ok) throw new Error(`SUMO runtime cache asset is unavailable (${head.status}).`);
        let bytes = Number(head.headers.get("content-length"));
        if (!Number.isSafeInteger(bytes) || bytes <= 0) {
          const range = await fetch(url, {
            headers: { Range: "bytes=0-0" },
            signal,
          });
          if (!range.ok) {
            throw new Error(`SUMO runtime cache asset is unavailable (${range.status}).`);
          }
          const total = /\/(\d+)$/.exec(range.headers.get("content-range") ?? "")?.[1];
          bytes = Number(total ?? (range.status === 200 ? range.headers.get("content-length") : null));
          await range.body?.cancel().catch(() => undefined);
        }
        if (!Number.isSafeInteger(bytes) || bytes <= 0) {
          throw new Error(`SUMO runtime cache asset has no verified size: ${url}`);
        }
        return { url, bytes, mapVersionId: "sumo-runtime" };
      }),
  );
}

function inventoryAssetUrl(mapVersionId: string, relativePath: string) {
  const encodedPath = relativePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/browser-assets/${encodedPath}`;
}

/**
 * Plan the complete published member closure for every selected map.
 *
 * The server inventory is authoritative. Parsing the 3D manifest and choosing
 * only the current profile's visible LODs left lazy viewport members absent,
 * so navigating after a purportedly complete download still streamed bytes.
 */
export async function createProfileMapPlan(
  maps: readonly ScenarioMapOption[],
  profile: RenderingPreference,
  signal: AbortSignal,
): Promise<ProfileMapPlan> {
  const inventoryResponse = await fetch("/api/simforge/maps/cache-plan", { signal });
  if (!inventoryResponse.ok) {
    throw new Error(`Map cache inventory could not be loaded (${inventoryResponse.status}).`);
  }
  const inventory = await inventoryResponse.json() as CacheInventory;
  const inventoryByMap = new Map(inventory.maps.map((entry) => [entry.mapVersionId, entry]));
  const selected = maps.filter((map) => Boolean(map.browserManifestUrl));
  const planMaps: ProfileMapPlanMap[] = [];
  const memberAssets: ProfileMapAsset[] = [];

  for (const map of selected) {
    const closure = inventoryByMap.get(map.mapVersionId);
    if (!closure) {
      throw new Error(`Active browser bundle does not contain map ${map.mapVersionId}`);
    }
    if (map.browserClosureSha256 && closure.closureSha256 !== map.browserClosureSha256) {
      throw new Error(`Map ${map.mapVersionId} changed while its cache plan was being prepared.`);
    }
    const assets = closure.assets.map((asset): ProfileMapAsset => ({
      url: inventoryAssetUrl(map.mapVersionId, asset.relativePath),
      bytes: asset.byteLength,
      sha256: asset.sha256,
      mapVersionId: map.mapVersionId,
    }));
    memberAssets.push(...assets);
    planMaps.push({
      mapVersionId: map.mapVersionId,
      closureSha256: closure.closureSha256,
      assets,
      totalBytes: groupByContent(assets).reduce((total, asset) => total + (asset.bytes ?? 0), 0),
      remainingAssets: 0,
      remainingBytes: 0,
      fullyCached: false,
    });
  }

  const memberCached = await mapWithConcurrency(
    memberAssets,
    MAX_CACHE_LOOKUP_CONCURRENCY,
    (asset) => hasCachedMapAsset(asset.url, asset.sha256),
  );
  let memberIndex = 0;
  for (const map of planMaps) {
    const pendingMembers = map.assets.filter(() => !memberCached[memberIndex++]);
    const uniquePending = groupByContent(pendingMembers);
    map.remainingAssets = uniquePending.length;
    map.remainingBytes = uniquePending.reduce((total, asset) => total + (asset.bytes ?? 0), 0);
    map.fullyCached = map.remainingAssets === 0;
    if (map.fullyCached) {
      await writeCacheReceipt(
        mapCacheReceiptKey(map.mapVersionId, map.closureSha256),
        map.assets.length,
        map.totalBytes,
      );
    }
  }

  // The SUMO runtime is only worth the bytes when a selected closure carries a
  // SUMO network for it to run; browser-only maps never load it.
  const runtimes = memberAssets.some((asset) => asset.url.includes("/browser-assets/derived/sumo/"))
    ? await runtimeAssets(signal)
    : [];
  const runtimeCached = await mapWithConcurrency(
    runtimes,
    MAX_CACHE_LOOKUP_CONCURRENCY,
    (asset) => hasCachedMapAsset(asset.url, asset.sha256),
  );
  const pendingMembers = memberAssets.filter((_asset, index) => !memberCached[index]);
  const pendingRuntimes = runtimes.filter((_asset, index) => !runtimeCached[index]);
  const assets = groupByContent([...memberAssets, ...runtimes]);
  const pendingAssets = groupByContent([...pendingMembers, ...pendingRuntimes]);

  return {
    releaseKey: inventory.releaseKey,
    profile,
    mapCount: planMaps.length,
    maps: planMaps,
    assets,
    pendingAssets,
    totalBytes: assets.reduce((total, asset) => total + (asset.bytes ?? 0), 0),
    remainingBytes: pendingAssets.reduce((total, asset) => total + (asset.bytes ?? 0), 0),
    remainingAssets: pendingAssets.length,
    unknownSizeAssets: assets.filter((asset) => asset.bytes === null).length,
    fullyCachedMapVersionIds: planMaps.filter((map) => map.fullyCached).map((map) => map.mapVersionId),
  };
}

export async function cacheProfileMapPlan(
  plan: ProfileMapPlan,
  signal: AbortSignal,
  onProgress: (progress: ProfileMapCacheProgress) => void,
): Promise<ProfileMapCacheResult> {
  await prepareMapAssetCache();
  const status = await mapAssetCacheStatus();
  const available = status.availableBytes;
  if (available !== null && plan.remainingBytes > available * 0.9) {
    const requiredMb = Math.ceil(plan.remainingBytes / (1024 * 1024));
    const availableMb = Math.floor(available / (1024 * 1024));
    throw new Error(
      status.backend === "filesystem"
        ? `Caching requires ${requiredMb} MB, but only ${availableMb} MB is free at ${status.directory}. Choose another cache location or free up disk space.`
        : `Caching requires ${requiredMb} MB, but this browser has only ${availableMb} MB available.`,
    );
  }
  let completedAssets = 0;
  let completedBytes = 0;
  let failedAssets = 0;
  let failureReason: string | null = null;
  const assetsToCache = plan.pendingAssets ?? plan.assets;
  const report = (mapVersionId: string | null) => onProgress({
    completedAssets,
    totalAssets: assetsToCache.length,
    completedBytes,
    totalBytes: plan.remainingBytes,
    currentMapVersionId: mapVersionId,
  });
  report(null);
  try {
    for (let offset = 0; offset < assetsToCache.length; offset += DOWNLOAD_URL_BATCH_SIZE) {
      const batch = assetsToCache.slice(offset, offset + DOWNLOAD_URL_BATCH_SIZE);
      const downloadUrls = await resolveBatchDownloadUrls(batch, signal);
      await mapWithConcurrency(batch, profileMapDownloadConcurrency(), async (asset) => {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        let stored = false;
        for (let attempt = 0; attempt < MAX_ASSET_DOWNLOAD_ATTEMPTS && !stored; attempt += 1) {
          try {
            // Ensure-only: the asset becomes resident in the cache backend
            // without its bytes being read back into this renderer.
            await withAssetAttemptDeadline(signal, (attemptSignal) => ensureMapAsset(asset.url, {
              sha256: asset.sha256,
              networkUrl: downloadUrls.get(asset.url),
              sizeBytes: asset.bytes ?? undefined,
              signal: attemptSignal,
              deferIndexWrite: true,
            }));
            stored = true;
          } catch (reason) {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            if (attempt + 1 === MAX_ASSET_DOWNLOAD_ATTEMPTS) {
              failedAssets += 1;
              failureReason = reason instanceof Error ? reason.message : String(reason);
            }
          }
        }
        if (stored) {
          // Content is deduplicated; teach every alias path its identity so
          // the offline runtime answers by URL alone.
          if (asset.sha256) {
            const sha256 = asset.sha256;
            await Promise.all((asset.aliases ?? []).map((alias) =>
              ensureMapAsset(alias, { sha256, signal, deferIndexWrite: true })
            ));
          }
          completedAssets++;
          completedBytes += asset.bytes ?? 0;
          report(asset.mapVersionId);
        }
      });
    }
  } finally {
    flushMapAssetCacheIndex();
  }

  const completedMapVersionIds: string[] = [];
  for (const map of plan.maps) {
    const complete = (
      await mapWithConcurrency(
        map.assets,
        MAX_CACHE_LOOKUP_CONCURRENCY,
        (asset) => hasCachedMapAsset(asset.url, asset.sha256),
      )
    ).every(Boolean);
    if (complete) {
      await writeCacheReceipt(
        mapCacheReceiptKey(map.mapVersionId, map.closureSha256),
        map.assets.length,
        map.totalBytes,
      );
      completedMapVersionIds.push(map.mapVersionId);
    }
  }
  flushMapAssetCacheIndex();
  report(null);
  return { failedAssets, failureReason, completedMapVersionIds };
}
