import { useMemo } from "react";

type CacheEntry = { readonly url: string | null };
type Waiter = { readonly keys: ReadonlySet<string>; settle: () => void };

type AssetResponse = { assets?: Array<{ relativePath: string; url: string }> };

const BATCH_DELAY_MS = 25;
const MAX_BATCH_KEYS = 256;
const ASSET_PATH = /^\/api\/simforge\/maps\/[^/]+\/browser-assets\/(.+)$/;

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

function assetPath(url: URL): string | null {
  const match = ASSET_PATH.exec(url.pathname);
  return match ? match[1]!.split("/").map((part) => decodeURIComponent(part)).join("/") : null;
}

/**
 * Resolves first-party `browser-assets` URLs of one map version to the direct
 * object-store URLs the host issues from `cache-download-urls`, so the browser
 * fetches each member once instead of paying a redirect through the host per
 * member.
 *
 * Requests arriving within {@link BATCH_DELAY_MS} share one POST of up to
 * {@link MAX_BATCH_KEYS} members; a key already in flight is never asked for
 * again. A member the host does not issue a URL for, or a failed batch, resolves
 * to the original URL and is remembered as such, so the first-party route still
 * serves it and nobody waits on it twice. The shared POST carries no caller
 * signal: an aborted caller stops waiting, the batch still completes for the
 * others.
 */
export function createDirectMapAssetUrlResolver(mapVersionId: string) {
  const cache = new Map<string, CacheEntry>();
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  const waiters = new Set<Waiter>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const settleReady = () => {
    for (const waiter of waiters) {
      let ready = true;
      for (const key of waiter.keys) if (!cache.has(key)) { ready = false; break; }
      if (ready) {
        waiters.delete(waiter);
        waiter.settle();
      }
    }
  };

  const flush = () => {
    timer = null;
    while (queued.size > 0) {
      const keys = [...queued].slice(0, MAX_BATCH_KEYS);
      for (const key of keys) {
        queued.delete(key);
        inFlight.add(key);
      }
      void (async () => {
        const assets = keys.map((key) => ({ mapVersionId, relativePath: assetPath(new URL(key))! }));
        let issued: AssetResponse["assets"] = [];
        try {
          const response = await fetch("/api/simforge/maps/cache-download-urls", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assets }),
          });
          if (!response.ok) throw new Error(`URL resolver failed: ${response.status}`);
          issued = (await response.json() as AssetResponse).assets ?? [];
        } catch {
          issued = [];
        }
        const byPath = new Map(issued.map((asset) => [asset.relativePath, asset.url]));
        for (const key of keys) {
          inFlight.delete(key);
          cache.set(key, { url: byPath.get(assetPath(new URL(key))!) ?? null });
        }
        settleReady();
      })();
    }
  };

  return async (urls: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, string>> => {
    if (signal.aborted) throw signal.reason;
    const entries = urls.map((url) => ({ original: url, canonical: canonicalUrl(url) }));
    const wanted = new Set<string>();
    for (const { canonical } of entries) {
      if (assetPath(canonical) === null || cache.has(canonical.href)) continue;
      wanted.add(canonical.href);
      if (!inFlight.has(canonical.href)) queued.add(canonical.href);
    }
    if (wanted.size > 0) {
      if (queued.size > 0 && timer === null) timer = setTimeout(flush, BATCH_DELAY_MS);
      // Executor form: this package compiles against the ES2022 lib, which has no Promise.withResolvers.
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { keys: wanted, settle: resolve };
        const abort = () => {
          waiters.delete(waiter);
          reject(signal.reason);
        };
        waiter.settle = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        waiters.add(waiter);
      });
    }
    const result = new Map<string, string>();
    for (const { original, canonical } of entries) {
      const entry = cache.get(canonical.href);
      if (entry) result.set(original, entry.url ?? original);
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
