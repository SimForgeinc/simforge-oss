"use client";

import { FolderInput, FolderOpen, HardDrive, Trash2 } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { useCallback, useEffect, useState } from "react";
import { mergeStyleProps, type XStyle } from "./stylex/surface";
import { styles } from "./MapAssetCacheStorage.stylex";
import {
  chooseMapAssetCacheDirectory,
  clearMapAssetCache,
  mapAssetCacheStatus,
  onMapAssetCacheChange,
  type MapAssetCacheStatus,
} from "../lib/maps/frontend/map-asset-cache";
import { Button } from "./ui/button";

type Busy = "choosing" | "moving" | "clearing" | null;

export function formatCacheBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Where map bytes live on this device, how much they take, and the explicit
 * controls to point the cache elsewhere, move it there, or clear it.
 *
 * Reads the active backend once per mount and again whenever `refreshKey`
 * changes (a preparation phase transition, for instance); there is no polling.
 * Clearing always confirms first: on the desktop this can be a 30 GB library.
 */
export function MapAssetCacheStorage({
  refreshKey,
  allowClear = true,
  compact = false,
  onCleared,
  onError,
  className,
  xstyle,
}: {
  /** Bump to re-read usage after downloads or clears elsewhere. */
  refreshKey?: unknown;
  /** Hide the clear control where a page already owns its own clear flow. */
  allowClear?: boolean;
  /** Compact readout for the single-screen render preference cards. */
  compact?: boolean;
  onCleared?: () => void;
  /** Surfaces backend faults to a page-level alert in addition to the inline one. */
  onError?: (message: string) => void;
  className?: string;
  /** Caller StyleX styles, composed after this component's own so they win. */
  xstyle?: XStyle;
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

  // Follow downloads live on the browser backend; the readout is otherwise
  // stale the moment a map finishes loading in another part of the page.
  useEffect(() => {
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onMapAssetCacheChange(() => {
      if (scheduled !== null) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        void refresh();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (scheduled !== null) clearTimeout(scheduled);
    };
  }, [refresh]);

  const chooseDirectory = async (move: boolean) => {
    setBusy(move ? "moving" : "choosing");
    try {
      setStatus(await chooseMapAssetCacheDirectory({ move }));
      setError("");
    } catch (reason) {
      fail(reason, move ? "The map cache could not be moved." : "The cache location could not be changed.");
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
  const unavailable = status?.backend === "filesystem" ? status.unavailable : null;
  const browserUnavailable = status?.backend === "browser" ? status.unavailable : null;
  const downloading = status?.backend === "filesystem" && status.activeDownloads > 0;
  const location = !status
    ? "Reading…"
    : status.backend === "filesystem"
      ? status.directory
      : status.unavailable
        ? "Not cached on this page"
        : status.persistent
        ? "This browser's persistent storage"
        : "This browser's storage (may be evicted)";

  return (
    <section
      aria-label="Map cache storage"
      {...mergeStyleProps(stylex.props(styles.root, compact && styles.compact, xstyle), className)}
      data-testid="map-asset-cache-storage"
      data-cache-backend={status?.backend ?? "unknown"}
    >
      <div {...stylex.props(styles.head)}>
        <HardDrive {...stylex.props(styles.headIcon)} aria-hidden="true" />
        <div {...stylex.props(styles.headText)}>
          <p {...stylex.props(styles.eyebrow, compact && styles.compactLabel)}>
            {filesystem ? "Map cache on disk" : "Browser cache"}
          </p>
          <p
            {...stylex.props(styles.location, compact && styles.compactLocation)}
            title={location}
            data-testid="map-asset-cache-location"
          >
            {location}
          </p>
          {browserUnavailable ? (
            <p
              {...stylex.props(styles.unavailable)}
              role="status"
              data-testid="map-asset-cache-unavailable"
            >
              Browser caching unavailable: {browserUnavailable}
            </p>
          ) : null}
          {browserUnavailable ? null : (
          <dl {...stylex.props(styles.stats, compact && styles.compactStats)}>
            {status?.backend === "browser" && !browserUnavailable ? (
              <div>
                <dt {...stylex.props(styles.statLabel)}>Maps cached </dt>
                <dd {...stylex.props(styles.statValue)} data-testid="map-asset-cache-map-bytes">
                  {formatCacheBytes(status.mapBytes)} of {formatCacheBytes(status.budgetBytes)}
                </dd>
              </div>
            ) : null}
            <div>
              <dt {...stylex.props(styles.statLabel)}>{filesystem ? "Used " : "Site usage "}</dt>
              <dd {...stylex.props(styles.statValue)} data-testid="map-asset-cache-used">
                {status?.usedBytes == null ? "—" : formatCacheBytes(status.usedBytes)}
              </dd>
            </div>
            <div>
              <dt {...stylex.props(styles.statLabel)}>{filesystem ? "Free disk " : "Browser quota available "}</dt>
              <dd {...stylex.props(styles.statValue)} data-testid="map-asset-cache-free">
                {status?.availableBytes == null ? "—" : formatCacheBytes(status.availableBytes)}
              </dd>
            </div>
            {status?.backend === "filesystem" ? (
              <div>
                <dt {...stylex.props(styles.statLabel)}>Files </dt>
                <dd {...stylex.props(styles.statValue)}>{status.assetCount}</dd>
                {status.activeDownloads > 0 ? (
                  <dd {...stylex.props(styles.statAccent)}>{status.activeDownloads} downloading</dd>
                ) : null}
              </div>
            ) : null}
          </dl>
          )}
        </div>
      </div>

      {(filesystem || allowClear) && !confirmClear ? (
        <div {...stylex.props(styles.actions, compact && styles.compactActions)}>
          {filesystem ? (
            <>
              <Button
                xstyle={styles.control}
                disabled={busy !== null || downloading}
                onClick={() => void chooseDirectory(true)}
                type="button"
                variant="outline"
                title="Pick an empty folder; every cached map is carried over so nothing downloads again."
              >
                <FolderInput aria-hidden="true" />
                {busy === "moving" ? "Moving…" : "Move cache…"}
              </Button>
              <Button
                xstyle={styles.control}
                disabled={busy !== null}
                onClick={() => void chooseDirectory(false)}
                type="button"
                variant="outline"
                title="Point the cache at another folder and leave the current files where they are."
              >
                <FolderOpen aria-hidden="true" />
                {busy === "choosing" ? "Choosing…" : compact ? "Change folder…" : "Use another folder…"}
              </Button>
            </>
          ) : null}
          {allowClear && !browserUnavailable ? (
            <Button
              xstyle={styles.control}
              disabled={busy !== null || !status || unavailable !== null}
              onClick={() => setConfirmClear(true)}
              type="button"
              variant="outline"
            >
              <Trash2 aria-hidden="true" />
              {busy === "clearing" ? "Clearing…" : "Clear cache"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {filesystem && downloading && !confirmClear ? (
        <p {...stylex.props(styles.hint)}>Moving waits until the current downloads finish.</p>
      ) : null}

      {confirmClear ? (
        <div
          {...stylex.props(styles.confirm)}
          role="alertdialog"
          aria-label="Confirm clearing the map cache"
        >
          <p>
            Delete every cached map asset
            {status?.backend === "browser"
              ? status.mapBytes ? ` (${formatCacheBytes(status.mapBytes)})` : ""
              : status?.usedBytes ? ` (${formatCacheBytes(status.usedBytes)})` : ""}
            {filesystem ? " from disk" : " from this browser"}? Maps will be downloaded again when needed.
          </p>
          <div {...stylex.props(styles.confirmActions)}>
            <Button xstyle={styles.controlConfirm} onClick={() => void clear()} type="button">
              Delete cached maps
            </Button>
            <Button
              xstyle={styles.controlDismiss}
              onClick={() => setConfirmClear(false)}
              type="button"
              variant="ghost"
            >
              Keep
            </Button>
          </div>
        </div>
      ) : null}

      {unavailable ? (
        <p {...stylex.props(styles.unavailable)} role="status" data-testid="map-asset-cache-unavailable">
          The map cache location is unavailable ({unavailable}). Maps are not downloaded to another disk;
          reconnect the drive or choose another location.
        </p>
      ) : null}

      {error ? (
        <p {...stylex.props(styles.error, compact && styles.compactMessage)} role="alert" title={error}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
