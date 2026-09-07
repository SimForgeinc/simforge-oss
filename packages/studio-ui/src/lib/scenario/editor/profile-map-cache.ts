import type { RenderingPreference } from "../../../components/rendering-preference";
import type { ScenarioMapOption } from "../../../scenario/list/document-map-groups";
import {
  beginMapAssetCacheIndexBatch,
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
/**
 * Below this sustained rate an attempt is treated as stalled. The base timeout
 * alone would abort every multi-hundred-megabyte member on an ordinary link
 * and, on the desktop, restart it from its resumable prefix twice before
 * giving up.
 */
const MIN_ASSET_TRANSFER_BYTES_PER_SECOND = 128 * 1024;
const SUMO_RUNTIME_MAP_VERSION_ID = "sumo-runtime";
const SUMO_NETWORK_PATH = "/browser-assets/derived/sumo/";

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
  /** Members that were not present when this plan was calculated (ungrouped). */
  pendingMembers: ProfileMapAsset[];
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
  /** SUMO runtime files, present only when a planned closure carries a SUMO network. */
  runtimeAssets: ProfileMapAsset[];
  pendingRuntimeAssets: ProfileMapAsset[];
  assets: ProfileMapAsset[];
  /** Unique content blobs that were not already present when this plan was calculated. */
  pendingAssets: ProfileMapAsset[];
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
  assets: readonly ProfileMapAsset[],
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

function attemptTimeoutMs(bytes: number | null) {
  return PROFILE_MAP_ASSET_ATTEMPT_TIMEOUT_MS
    + Math.ceil(((bytes ?? 0) / MIN_ASSET_TRANSFER_BYTES_PER_SECOND) * 1000);
}

async function withAssetAttemptDeadline<T>(
  signal: AbortSignal,
  timeoutMs: number,
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
    }, timeoutMs);
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

function contentKey(asset: ProfileMapAsset) {
  return asset.sha256 ? `sha256:${asset.sha256}` : `url:${asset.url}`;
}

/** One entry per distinct content; every other path to the same bytes becomes an alias. */
function groupByContent(assets: readonly ProfileMapAsset[]): ProfileMapAsset[] {
  const grouped = new Map<string, ProfileMapAsset>();
  for (const asset of assets) {
    const key = contentKey(asset);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...asset, aliases: [...(asset.aliases ?? [])] });
      continue;
    }
    const aliases = existing.aliases!;
    for (const alias of [asset.url, ...(asset.aliases ?? [])]) {
      if (alias !== existing.url && !aliases.includes(alias)) aliases.push(alias);
    }
  }
  return [...grouped.values()];
}

function sumBytes(assets: readonly ProfileMapAsset[]) {
  return assets.reduce((total, asset) => total + (asset.bytes ?? 0), 0);
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
        return { url, bytes, mapVersionId: SUMO_RUNTIME_MAP_VERSION_ID };
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

function needsSumoRuntime(maps: readonly ProfileMapPlanMap[]) {
  return maps.some((map) => map.assets.some((asset) => asset.url.includes(SUMO_NETWORK_PATH)));
}

/** Aggregate totals over a set of planned maps; the runtime joins only when a closure needs it. */
function assemblePlan(
  base: Pick<ProfileMapPlan, "releaseKey" | "profile" | "runtimeAssets" | "pendingRuntimeAssets">,
  maps: ProfileMapPlanMap[],
): ProfileMapPlan {
  const runtimes = needsSumoRuntime(maps) ? base.runtimeAssets : [];
  const pendingRuntimes = needsSumoRuntime(maps) ? base.pendingRuntimeAssets : [];
  const assets = groupByContent([...maps.flatMap((map) => map.assets), ...runtimes]);
  const pendingAssets = groupByContent([
    ...maps.flatMap((map) => map.pendingMembers),
    ...pendingRuntimes,
  ]);
  return {
    releaseKey: base.releaseKey,
    profile: base.profile,
    mapCount: maps.length,
    maps,
    runtimeAssets: base.runtimeAssets,
    pendingRuntimeAssets: base.pendingRuntimeAssets,
    assets,
    pendingAssets,
    totalBytes: sumBytes(assets),
    remainingBytes: sumBytes(pendingAssets),
    remainingAssets: pendingAssets.length,
    unknownSizeAssets: assets.filter((asset) => asset.bytes === null).length,
    fullyCachedMapVersionIds: maps.filter((map) => map.fullyCached).map((map) => map.mapVersionId),
  };
}

/**
 * Narrow a plan to a subset of its maps without touching the network or the
 * cache: the per-map presence data gathered by `createProfileMapPlan` is
 * regrouped, so a selection change in the preparation UI is a pure
 * computation instead of a fresh inventory fetch plus one lookup per member.
 */
export function selectProfileMapPlan(
  plan: ProfileMapPlan,
  mapVersionIds: ReadonlySet<string>,
): ProfileMapPlan {
  return assemblePlan(plan, plan.maps.filter((map) => mapVersionIds.has(map.mapVersionId)));
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
      pendingMembers: [],
      totalBytes: sumBytes(groupByContent(assets)),
      remainingAssets: 0,
      remainingBytes: 0,
      fullyCached: false,
    });
  }

  // The SUMO runtime is only worth the bytes when a selected closure carries a
  // SUMO network for it to run; browser-only maps never load it.
  const runtimes = needsSumoRuntime(planMaps) ? await runtimeAssets(signal) : [];

  beginMapAssetCacheIndexBatch();
  try {
    const memberCached = await mapWithConcurrency(
      memberAssets,
      MAX_CACHE_LOOKUP_CONCURRENCY,
      (asset) => hasCachedMapAsset(asset.url, asset.sha256),
    );
    let memberIndex = 0;
    for (const map of planMaps) {
      map.pendingMembers = map.assets.filter(() => !memberCached[memberIndex++]);
      const uniquePending = groupByContent(map.pendingMembers);
      map.remainingAssets = uniquePending.length;
      map.remainingBytes = sumBytes(uniquePending);
      map.fullyCached = map.remainingAssets === 0;
      if (map.fullyCached) {
        await writeCacheReceipt(
          mapCacheReceiptKey(map.mapVersionId, map.closureSha256),
          map.assets.length,
          map.totalBytes,
        );
      }
    }
    const runtimeCached = await mapWithConcurrency(
      runtimes,
      MAX_CACHE_LOOKUP_CONCURRENCY,
      (asset) => hasCachedMapAsset(asset.url, asset.sha256),
    );
    return assemblePlan({
      releaseKey: inventory.releaseKey,
      profile,
      runtimeAssets: runtimes,
      pendingRuntimeAssets: runtimes.filter((_asset, index) => !runtimeCached[index]),
    }, planMaps);
  } finally {
    flushMapAssetCacheIndex();
  }
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
  const assetsToCache = plan.pendingAssets;
  /** Content made resident by this run, including every alias path. */
  const stored = new Set<string>();
  const report = (mapVersionId: string | null) => onProgress({
    completedAssets,
    totalAssets: assetsToCache.length,
    completedBytes,
    totalBytes: plan.remainingBytes,
    currentMapVersionId: mapVersionId,
  });
  // Signed delivery URLs are resolved per batch, lazily, by whichever worker
  // reaches the batch first: the pool never drains between batches and a URL
  // is at most one batch old when it is used.
  const downloadUrlBatches = new Map<number, Promise<Map<string, string>>>();
  const downloadUrlsFor = (index: number) => {
    const batch = Math.floor(index / DOWNLOAD_URL_BATCH_SIZE);
    let pending = downloadUrlBatches.get(batch);
    if (!pending) {
      const start = batch * DOWNLOAD_URL_BATCH_SIZE;
      pending = resolveBatchDownloadUrls(
        assetsToCache.slice(start, start + DOWNLOAD_URL_BATCH_SIZE),
        signal,
      );
      downloadUrlBatches.set(batch, pending);
    }
    return pending;
  };
  report(null);
  beginMapAssetCacheIndexBatch();
  try {
    await mapWithConcurrency(assetsToCache, profileMapDownloadConcurrency(), async (asset, index) => {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const downloadUrls = await downloadUrlsFor(index);
      const { sha256 } = asset;
      for (let attempt = 0; attempt < MAX_ASSET_DOWNLOAD_ATTEMPTS; attempt += 1) {
        try {
          await withAssetAttemptDeadline(signal, attemptTimeoutMs(asset.bytes), async (attemptSignal) => {
            // Ensure-only: the asset becomes resident in the cache backend
            // without its bytes being read back into this renderer. A retry
            // goes through the canonical route, which never expires.
            await ensureMapAsset(asset.url, {
              sha256,
              networkUrl: attempt === 0 ? downloadUrls.get(asset.url) : undefined,
              sizeBytes: asset.bytes ?? undefined,
              signal: attemptSignal,
              deferIndexWrite: true,
            });
            // Content is deduplicated; teach every alias path its identity so
            // the offline runtime answers by URL alone. Aliases carry no
            // digest-less identity, so they need one to be registered at all.
            if (sha256) {
              await Promise.all((asset.aliases ?? []).map((alias) =>
                ensureMapAsset(alias, { sha256, signal: attemptSignal, deferIndexWrite: true })
              ));
            }
          });
          stored.add(contentKey(asset));
          completedAssets++;
          completedBytes += asset.bytes ?? 0;
          report(asset.mapVersionId);
          return;
        } catch (reason) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          if (attempt + 1 === MAX_ASSET_DOWNLOAD_ATTEMPTS) {
            failedAssets += 1;
            failureReason = reason instanceof Error ? reason.message : String(reason);
          }
        }
      }
    });

    // A closure is complete when every member that was absent at planning
    // time has been verified and published by this run; members present at
    // planning time were verified by the lookup that excluded them. Receipts
    // are written only for closures that became complete here.
    const completedMapVersionIds: string[] = [];
    for (const map of plan.maps) {
      if (map.fullyCached) {
        completedMapVersionIds.push(map.mapVersionId);
        continue;
      }
      if (!map.pendingMembers.every((member) => stored.has(contentKey(member)))) continue;
      await writeCacheReceipt(
        mapCacheReceiptKey(map.mapVersionId, map.closureSha256),
        map.assets.length,
        map.totalBytes,
      );
      completedMapVersionIds.push(map.mapVersionId);
    }
    report(null);
    return { failedAssets, failureReason, completedMapVersionIds };
  } finally {
    flushMapAssetCacheIndex();
  }
}
