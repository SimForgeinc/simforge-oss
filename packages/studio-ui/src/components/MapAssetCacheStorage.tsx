"use client";

import { FolderOpen, HardDrive, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../lib/utils";
import {
  chooseMapAssetCacheDirectory,
  clearMapAssetCache,
  mapAssetCacheStatus,
  type MapAssetCacheStatus,
} from "../lib/maps/frontend/map-asset-cache";
import { Button } from "./ui/button";

type Busy = "choosing" | "clearing" | null;

export function formatCacheBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Where map bytes live on this device, how much they take, and the explicit
 * controls to move or clear them.
 *
 * Reads the active backend once per mount and again whenever `refreshKey`
 * changes (a preparation phase transition, for instance); there is no polling.
 * Clearing always confirms first: on the desktop this can be a 30 GB library.
 */
export function MapAssetCacheStorage({
  refreshKey,
  allowClear = true,
  onCleared,
  onError,
  className,
}: {
  /** Bump to re-read usage after downloads or clears elsewhere. */
  refreshKey?: unknown;
  /** Hide the clear control where a page already owns its own clear flow. */
  allowClear?: boolean;
  onCleared?: () => void;
  /** Surfaces backend faults to a page-level alert in addition to the inline one. */
  onError?: (message: string) => void;
  className?: string;
}) {
  const [status, setStatus] = useState<MapAssetCacheStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const fail = useCallback((reason: unknown, fallback: string) => {
    const message = reason instanceof Error ? reason.message : fallback;
    setError(message);
    onError?.(message);
  }, [onError]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await mapAssetCacheStatus());
      setError("");
    } catch (reason) {
      fail(reason, "Map cache status is unavailable.");
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refreshKey, refresh]);

  const chooseDirectory = async () => {
    setBusy("choosing");
    try {
      setStatus(await chooseMapAssetCacheDirectory());
      setError("");
    } catch (reason) {
      fail(reason, "The cache location could not be changed.");
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clearing");
    setConfirmClear(false);
    try {
      await clearMapAssetCache();
      await refresh();
      onCleared?.();
    } catch (reason) {
      fail(reason, "The map cache could not be cleared.");
    } finally {
      setBusy(null);
    }
  };

  const filesystem = status?.backend === "filesystem";
  const location = !status
    ? "Reading…"
    : status.backend === "filesystem"
      ? status.directory
      : status.persistent
        ? "This browser's persistent storage"
        : "This browser's storage (may be evicted)";

  return (
    <section
      aria-label="Map cache storage"
      className={cn("border-y border-white/10 py-4 text-white", className)}
      data-testid="map-asset-cache-storage"
      data-cache-backend={status?.backend ?? "unknown"}
    >
      <div className="flex items-start gap-3">
        <HardDrive className="mt-0.5 size-4 shrink-0 text-[#E8E044]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">
            {filesystem ? "Map cache on disk" : "Map cache in browser storage"}
          </p>
          <p
            className="mt-1 truncate font-mono text-xs text-white/75"
            title={location}
            data-testid="map-asset-cache-location"
          >
            {location}
          </p>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-micro uppercase tracking-meta text-white/45">
            <div>
              <dt className="inline">{filesystem ? "Used " : "Site storage used "}</dt>
              <dd className="inline text-white/70" data-testid="map-asset-cache-used">
                {status?.usedBytes == null ? "—" : formatCacheBytes(status.usedBytes)}
              </dd>
            </div>
            <div>
              <dt className="inline">Free </dt>
              <dd className="inline text-white/70" data-testid="map-asset-cache-free">
                {status?.availableBytes == null ? "—" : formatCacheBytes(status.availableBytes)}
              </dd>
            </div>
            {status?.backend === "filesystem" ? (
              <div>
                <dt className="inline">Files </dt>
                <dd className="inline text-white/70">{status.assetCount}</dd>
                {status.activeDownloads > 0 ? (
                  <dd className="ml-3 inline text-[#E8E044]">{status.activeDownloads} downloading</dd>
                ) : null}
              </div>
            ) : null}
          </dl>
        </div>
      </div>

      {(filesystem || allowClear) && !confirmClear ? (
        <div className="mt-3 flex flex-wrap gap-2 pl-7">
          {filesystem ? (
            <Button
              className="h-8 rounded-full border-white/15 bg-transparent px-3 text-[11px] text-white/75 hover:bg-white/5 hover:text-white"
              disabled={busy !== null}
              onClick={() => void chooseDirectory()}
              type="button"
              variant="outline"
            >
              <FolderOpen className="size-3.5" aria-hidden="true" />
              {busy === "choosing" ? "Choosing…" : "Change location…"}
            </Button>
          ) : null}
          {allowClear ? (
            <Button
              className="h-8 rounded-full border-white/15 bg-transparent px-3 text-[11px] text-white/75 hover:bg-white/5 hover:text-white"
              disabled={busy !== null || !status}
              onClick={() => setConfirmClear(true)}
              type="button"
              variant="outline"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {busy === "clearing" ? "Clearing…" : "Clear cache"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {confirmClear ? (
        <div
          className="mt-3 ml-7 border border-white/10 bg-white/5 p-3 text-xs text-white/70"
          role="alertdialog"
          aria-label="Confirm clearing the map cache"
        >
          <p>
            Delete every cached map asset
            {status?.usedBytes ? ` (${formatCacheBytes(status.usedBytes)})` : ""}
            {filesystem ? " from disk" : " from this browser"}? Maps will be downloaded again when needed.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              className="h-8 rounded-full bg-[#E8E044] px-3 text-[11px] text-black hover:bg-[#f1ea55]"
              onClick={() => void clear()}
              type="button"
            >
              Delete cached maps
            </Button>
            <Button
              className="h-8 rounded-full px-3 text-[11px] text-white/60 hover:bg-transparent hover:text-white"
              onClick={() => setConfirmClear(false)}
              type="button"
              variant="ghost"
            >
              Keep
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 ml-7 border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
