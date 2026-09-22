import { useMemo } from "react";
import {
  isMapAssetLikelyCached,
  mapAssetCacheBackend,
  registerMapAssetDownloadUrls,
  setMapAssetDownloadUrlResolver,
} from "../../lib/maps/frontend/map-asset-cache";

type AssetResponse = { assets?: Array<{ mapVersionId?: string; relativePath: string; url: string }> };

const BATCH_DELAY_MS = 25;
const MAX_BATCH_KEYS = 256;
const ASSET_PATH = /^\/api\/simforge\/maps\/([^/]+)\/browser-assets\/(.+)$/;

function canonicalUrl(url: string): URL {
  const parsed = new URL(url, window.location.origin);
  parsed.pathname = parsed.pathname.split("/").map((part) => {
    try {
      return encodeURIComponent(decodeURIComponent(part));
    } catch {
      return part;
    }
  }).join("/");
  return parsed;
}

function assetRef(url: URL): { mapVersionId: string; relativePath: string } | null {
  if (url.origin !== window.location.origin) return null;
  const match = ASSET_PATH.exec(url.pathname);
  if (!match) return null;
  return {
    mapVersionId: decodeURIComponent(match[1]!),
    relativePath: match[2]!.split("/").map((part) => decodeURIComponent(part)).join("/"),
  };
}

/**
 * One page-wide batcher for signed delivery URLs.
 *
 * Requests arriving within {@link BATCH_DELAY_MS} share one POST of up to
 * {@link MAX_BATCH_KEYS} members, across map versions; a key already asked for
 * is never asked for again while its answer is pending. A member the host does
 * not issue a URL for, or a failed batch, resolves to nothing, and the
 * first-party route serves it instead.
 */
const pending = new Map<string, Promise<string | null>>();
const queued = new Map<string, (url: string | null) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  while (queued.size > 0) {
    const batch = [...queued.entries()].slice(0, MAX_BATCH_KEYS);
    for (const [key] of batch) queued.delete(key);
    void (async () => {
      const refs = batch.map(([key]) => ({ key, ref: assetRef(new URL(key))! }));
      let issued: NonNullable<AssetResponse["assets"]> = [];
      try {
        const response = await fetch("/api/simforge/maps/cache-download-urls", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ assets: refs.map(({ ref }) => ref) }),
        });
        if (!response.ok) throw new Error(`URL resolver failed: ${response.status}`);
        issued = (await response.json() as AssetResponse).assets ?? [];
      } catch {
        issued = [];
      }
      const byRef = new Map(issued.map((asset) => [`${asset.mapVersionId ?? ""}\n${asset.relativePath}`, asset.url]));
      const byPath = new Map(issued.map((asset) => [asset.relativePath, asset.url]));
      const registered = new Map<string, string>();
      for (const [index, [key, settle]] of batch.entries()) {
        const { ref } = refs[index]!;
        const url = byRef.get(`${ref.mapVersionId}\n${ref.relativePath}`) ?? byPath.get(ref.relativePath) ?? null;
        if (url) registered.set(key, url);
        pending.delete(key);
        settle(url);
      }
      if (registered.size > 0) registerMapAssetDownloadUrls(registered);
    })();
  }
}

function requestDownloadUrl(key: string): Promise<string | null> {
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = new Promise<string | null>((resolve) => queued.set(key, resolve));
  pending.set(key, promise);
  if (timer === null) timer = setTimeout(flush, BATCH_DELAY_MS);
  return promise;
}

/** The gateway's miss path: issue signed URLs only for what the cache lacks. */
async function resolveDownloadUrls(urls: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  await Promise.all(urls.map(async (url) => {
    const canonical = canonicalUrl(url);
    if (!assetRef(canonical)) return;
    const issued = await requestDownloadUrl(canonical.href);
    if (issued) result.set(url, issued);
  }));
  return result;
}

if (typeof window !== "undefined") setMapAssetDownloadUrlResolver(resolveDownloadUrls);

/**
 * Prepares first-party `browser-assets` URLs of one map version for loading
 * and hands them back unchanged.
 *
 * The viewer keeps canonical URLs so every fetch goes through the installed
 * map asset gateway: a resident member is answered from the cache with no
 * request of any kind, and a missing one is transferred straight from the
 * object store (signed URLs issued here, ahead of the fetch, in shared
 * batches) and streamed to the loader while its copy is stored. Handing the
 * loader the signed URL itself, as this used to, made every load transfer
 * the whole map again: the gateway cannot recognise a cross-origin URL, and a
 * fresh signature per load defeats the HTTP cache.
 *
 * On the desktop filesystem backend the host route is the verified disk
 * store, so nothing is resolved at all.
 */
export function createDirectMapAssetUrlResolver(_mapVersionId: string) {
  return async (urls: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, string>> => {
    if (signal.aborted) throw signal.reason;
    const result = new Map<string, string>();
    for (const url of urls) result.set(url, url);
    if (mapAssetCacheBackend() === "filesystem") return result;
    for (const url of urls) {
      const canonical = canonicalUrl(url);
      if (!assetRef(canonical) || isMapAssetLikelyCached(canonical.href)) continue;
      // Issued ahead of the fetch so the signature is usually ready by the
      // time the loader asks; the gateway awaits the same pending batch.
      void requestDownloadUrl(canonical.href);
    }
    return result;
  };
}

export function useDirectMapAssetUrlResolver(mapVersionId: string | null) {
  return useMemo(
    () => mapVersionId === null ? undefined : createDirectMapAssetUrlResolver(mapVersionId),
    [mapVersionId],
  );
}

/** Test seam: drop batches and pending answers between cases. */
export function resetDirectMapAssetUrlsForTests() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending.clear();
  queued.clear();
  setMapAssetDownloadUrlResolver(resolveDownloadUrls);
}
