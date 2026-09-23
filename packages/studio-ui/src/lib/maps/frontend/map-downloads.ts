"use client";

import { useSyncExternalStore } from "react";
import {
  ensureMapAsset,
  hasCachedMapAsset,
  mapAssetCacheStatus,
  mapAssetDigestResident,
} from "./map-asset-cache";
import { loadMapDownloadPlans } from "./map-download-loader";
import { MapDownloadManager, type MapDownloadSnapshot } from "./map-download-manager";
import type { PlannedDownloadAsset } from "./map-download-plan";
import {
  attemptTimeoutMs,
  profileMapDownloadConcurrency,
  resolveBatchDownloadUrls,
  withAssetAttemptDeadline,
} from "../../scenario/editor/profile-map-cache";

/**
 * The page's map download job, wired to the real cache, planner and network.
 * One per page, created on first use; see {@link MapDownloadManager}.
 */

const MAX_ATTEMPTS = 2;
let manager: MapDownloadManager | null = null;

async function ensure(asset: PlannedDownloadAsset, signal: AbortSignal, networkUrl?: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await withAssetAttemptDeadline(signal, attemptTimeoutMs(asset.bytes), (attemptSignal) => ensureMapAsset(asset.url, {
        sha256: asset.sha256,
        // A retry goes through the first-party route, which never expires.
        networkUrl: attempt === 0 ? networkUrl : undefined,
        sizeBytes: asset.bytes,
        signal: attemptSignal,
      }));
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function getMapDownloadManager(): MapDownloadManager {
  manager ??= new MapDownloadManager({
    plan: (ids, preference, signal) => loadMapDownloadPlans(ids, preference, { signal }),
    ensure,
    resolveUrls: (assets, signal) => resolveBatchDownloadUrls(
      assets.map((asset) => ({ url: asset.url, bytes: asset.bytes, sha256: asset.sha256, mapVersionId: "" })),
      signal,
    ),
    isResident: (asset) => mapAssetDigestResident(asset.sha256, asset.url) ?? hasCachedMapAsset(asset.url, asset.sha256),
    capacity: async () => {
      const status = await mapAssetCacheStatus();
      if (status.backend === "filesystem") {
        return { ceilingBytes: Number.MAX_SAFE_INTEGER, originFreeBytes: status.availableBytes };
      }
      if (status.unavailable) throw new Error(`Maps cannot be downloaded in this browser: ${status.unavailable}`);
      const originFree = status.quotaBytes !== null && status.usedBytes !== null
        ? Math.max(0, status.quotaBytes - status.usedBytes)
        : null;
      return { ceilingBytes: status.budgetBytes, originFreeBytes: originFree };
    },
    storage: typeof window === "undefined" ? null : window.localStorage,
    concurrency: profileMapDownloadConcurrency(),
  });
  return manager;
}

const SERVER_SNAPSHOT = (): MapDownloadSnapshot | null => null;

/** The live job, re-rendering at most every ~120 ms while bytes move. Null during server render. */
export function useMapDownloads(): MapDownloadSnapshot | null {
  const store = typeof window === "undefined" ? null : getMapDownloadManager();
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.getSnapshot ?? SERVER_SNAPSHOT,
    SERVER_SNAPSHOT,
  );
}

/** Test seam. */
export function resetMapDownloadsForTests(): void {
  manager = null;
}
