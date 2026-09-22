import { useMemo } from "react";

type CacheEntry = { readonly url: string | null };
type Waiter = { resolve: () => void; reject: (reason: unknown) => void; readonly signal: AbortSignal };

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

export function createDirectMapAssetUrlResolver(mapVersionId: string) {
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Set<Waiter>>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    while (pending.size > 0) {
      const keys = [...pending.keys()].slice(0, MAX_BATCH_KEYS);
      const waiters = keys.flatMap((key) => [...(pending.get(key) ?? [])]);
      for (const key of keys) pending.delete(key);
      void (async () => {
        const assets = keys.map((key) => {
          const parsed = new URL(key);
          return { mapVersionId, relativePath: assetPath(parsed)! };
        });
        let responseAssets: AssetResponse["assets"] = [];
        try {
          const response = await fetch("/api/simforge/maps/cache-download-urls", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assets }),
          });
          if (!response.ok) throw new Error(`URL resolver failed: ${response.status}`);
          responseAssets = (await response.json() as AssetResponse).assets ?? [];
        } catch {
          responseAssets = [];
        }
        const byPath = new Map(responseAssets.map((asset) => [asset.relativePath, asset.url]));
        for (const key of keys) {
          const resolved = byPath.get(assetPath(new URL(key))!);
          cache.set(key, { url: resolved ?? null });
        }
        for (const waiter of waiters) waiter.resolve();
        if (pending.size > 0 && timer === null) timer = setTimeout(flush, BATCH_DELAY_MS);
      })();
    }
  };

  const schedule = () => {
    if (timer === null) timer = setTimeout(flush, BATCH_DELAY_MS);
  };

  return async (urls: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, string>> => {
    const entries = urls.map((url) => ({ original: url, canonical: canonicalUrl(url) }));
    const unresolved = new Set<string>();
    for (const { canonical } of entries) {
      if (assetPath(canonical) !== null && !cache.has(canonical.href)) unresolved.add(canonical.href);
    }
    if (signal.aborted) throw signal.reason;
    if (unresolved.size > 0) {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal };
        for (const key of unresolved) {
          const keyWaiters = pending.get(key) ?? new Set<Waiter>();
          keyWaiters.add(waiter);
          pending.set(key, keyWaiters);
        }
        const abort = () => {
          for (const key of unresolved) pending.get(key)?.delete(waiter);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        waiter.resolve = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        waiter.reject = reject;
        schedule();
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
