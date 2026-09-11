import { formatBytes } from "../scenario/scene/map-load-progress";

/**
 * Whether a map selection may start downloading.
 *
 * The map cache already refuses a member transfer that would fill the volume,
 * but discovering that after ten minutes of downloading is a bad experience —
 * this moves the same failure to before the click, with the number that
 * explains it. The reserve keeps the volume usable (the same closure is also
 * materialized into a per-map directory for native rendering) instead of
 * letting a download stop exactly at zero free bytes.
 */
export const MAP_DOWNLOAD_DISK_RESERVE_BYTES = 2 * 1024 ** 3;

export type MapDownloadGuard = {
  blocked: boolean;
  /** Why the download cannot start, for the disabled button's explanation. */
  reason: string | null;
};

export function evaluateMapDownloadGuard(input: {
  selectedBytes: number;
  selectedCount: number;
  /** Free bytes on the map cache volume, or null when the host cannot report it. */
  freeBytes: number | null;
}): MapDownloadGuard {
  if (input.selectedCount === 0) return { blocked: true, reason: "Select at least one map to download." };
  // An unknown volume is not a full volume: let the cache enforce its own
  // limit rather than blocking on a missing number.
  if (input.freeBytes === null) return { blocked: false, reason: null };
  const budget = input.freeBytes - MAP_DOWNLOAD_DISK_RESERVE_BYTES;
  if (input.selectedBytes <= budget) return { blocked: false, reason: null };
  return {
    blocked: true,
    reason:
      `This selection needs ${formatBytes(input.selectedBytes)} and keeps `
      + `${formatBytes(MAP_DOWNLOAD_DISK_RESERVE_BYTES)} free, but only `
      + `${formatBytes(input.freeBytes)} is available. Select fewer maps, or move the map cache in Settings.`,
  };
}
