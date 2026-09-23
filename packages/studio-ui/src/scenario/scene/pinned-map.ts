import type { StudioHostServices, StudioMapEntry } from "@simforge-oss/studio-host";

/**
 * The installed map catalog lists the newest publication of each map. A draft pinned to an older
 * (superseded or retired) publication still opens and simulates on exactly its pinned version:
 * this adds that version's exact descriptor to `maps` so map resolution finds it, and never swaps
 * in the newer publication (moving is the author's explicit, diffed re-pin; see NewerMapBanner).
 * Returns `maps` unchanged when the pin is already listed or the host has no descriptor for it
 * (resolution then fails loudly as before).
 */
export async function mapsIncludingPinnedVersion<T extends { readonly mapVersionId?: string | null }>(
  studioHost: Pick<StudioHostServices, "projects">,
  maps: readonly T[],
  document: { id: string; mapVersionId: string | null },
  signal?: AbortSignal,
): Promise<readonly (T | StudioMapEntry)[]> {
  if (!document.mapVersionId || maps.some((map) => map.mapVersionId === document.mapVersionId)) return maps;
  const status = await studioHost.projects.getMapPinStatus(document.id, signal);
  if (!status.pinnedMap || status.pinnedMap.mapVersionId !== document.mapVersionId) return maps;
  return [...maps, status.pinnedMap];
}
