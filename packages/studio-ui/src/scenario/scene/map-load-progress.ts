import type { MapModelLoadSnapshot } from "./map-camera-transition";

export type SceneLoadPhase = "covering" | "resolving" | "assets" | "stabilizing" | "ready" | "error";
/**
 * What the scene cover shows while a map loads.
 *
 * `download` is the byte view of the load: what the viewer has read so far
 * against what it still expects. It is deliberately not a network panel - in
 * Studio the map is served by the local host from an installed closure, so a
 * rate or an ETA would describe disk and the host, not a connection, and read
 * as if something were being fetched again. `activity` changes whenever bytes
 * arrive, so a slow but live load never trips the stall watchdog.
 */
export type SceneLoadProgress = { phase: SceneLoadPhase; percent: number | null; percentExact?: boolean; message: string; detail: string; activity?: number; download?: { transferred: string; total: string | null; speed: string | null; stalled: boolean; stalledFor: string | null; metrics: ReadonlyArray<{ label: string; value: string }> } };
export type SceneLoadProgressTracker = { peakOutstanding: number; percent: number };
export function initialSceneLoadProgress(label: string): SceneLoadProgress { return { phase: "resolving", percent: 8, message: `Loading ${label}`, detail: "Preparing the map definition…" }; }
export function sceneLoadProgressFromSnapshot(label: string, snapshot: MapModelLoadSnapshot, tracker: SceneLoadProgressTracker): { progress: SceneLoadProgress; tracker: SceneLoadProgressTracker } {
  const outstanding = Math.max(0, snapshot.loading + snapshot.queued + snapshot.uploading);
  const peakOutstanding = Math.max(tracker.peakOutstanding, outstanding, 1);
  const completedFraction = Math.max(0, Math.min(1, 1 - outstanding / peakOutstanding));
  const download = snapshot.downloads && (snapshot.downloads.active > 0 || snapshot.downloads.transferredBytes > 0 || snapshot.downloads.cachedBytes > 0) ? downloadProgress(snapshot.downloads, snapshot) : undefined;
  const byteFraction = snapshot.downloads?.totalBytes ? Math.max(0, Math.min(1, snapshot.downloads.transferredBytes / snapshot.downloads.totalBytes)) : 0;
  const hasExactByteProgress = Boolean(download && snapshot.downloads?.totalBytes);
  const nextPercent = outstanding === 0 ? 94 : Math.round(55 + (hasExactByteProgress ? byteFraction : completedFraction) * 35);
  const percent = hasExactByteProgress ? Math.min(94, nextPercent) : Math.max(tracker.percent, Math.min(94, nextPercent));
  const trackerPercent = Math.max(tracker.percent, percent);
  if (snapshot.streamingError) return { tracker: { peakOutstanding, percent: trackerPercent }, progress: { phase: "error", percent: null, message: `${label} could not be loaded`, detail: snapshot.streamingError } };
  const missingDetail = snapshot.detailFailures && snapshot.detailFailures > 0
    ? ` ${snapshot.detailFailures} detail ${snapshot.detailFailures === 1 ? "tile" : "tiles"} could not be read and will be missing from the view.`
    : "";
  if (outstanding === 0 && snapshot.roadReady && snapshot.roadVisible) return { tracker: { peakOutstanding, percent: trackerPercent }, progress: { phase: "stabilizing", percent, message: `Finishing ${label}`, detail: `Checking the completed scene and preparing the first frame…${missingDetail}`, download } };
  const detail = download?.stalled
    ? `No map data has arrived for ${download.stalledFor}. The local host may be busy; the load resumes on its own when it answers.`
    : snapshot.loading === 0 && snapshot.queued === 0 && snapshot.uploading > 0
      ? `Uploading ${snapshot.uploading} ${snapshot.uploading === 1 ? "file" : "files"} to the GPU…`
      : outstanding > 0
        ? `${outstanding} ${outstanding === 1 ? "file" : "files"} to go…`
        : snapshot.downloads && !snapshot.downloads.discoveryComplete
          ? "Working out which files this view needs…"
          : "Loading roads, buildings, and map objects…";
  const activity = snapshot.downloads ? snapshot.downloads.transferredBytes + snapshot.downloads.cachedBytes : undefined;
  return { tracker: { peakOutstanding, percent: trackerPercent }, progress: { phase: "assets", percent, percentExact: hasExactByteProgress, message: `Loading ${label}`, detail, activity, download } };
}
/**
 * The window between the renderer being ready and the map's own load
 * resolving: manifest, static semantics, variant manifest, shadow atlas and
 * vegetation sidecars. On a multi-gigabyte closure that is minutes long, and
 * one byte-identical source across it reads as a dead load to the overlay's
 * stall watchdog, so this reports the same byte telemetry and activity token
 * the asset phase does.
 */
export function mapMetadataLoadProgress(label: string, downloads: MapModelLoadSnapshot["downloads"]): SceneLoadProgress {
  const read = downloads ? downloads.transferredBytes + downloads.cachedBytes : 0;
  const download = downloads && (downloads.active > 0 || read > 0) ? downloadProgress(downloads, null) : undefined;
  const detail = download
    ? download.stalled
      ? `No map data has arrived for ${download.stalledFor}. The local host may be busy; the load resumes on its own when it answers.`
      : `Reading the map definition \u2014 ${download.transferred} so far\u2026`
    : "Starting the renderer and loading map metadata\u2026";
  return { phase: "resolving", percent: 20, message: `Preparing ${label}`, detail, activity: read, download };
}
/**
 * The byte view plus the figures that say what the loader is doing with the
 * bytes: what is still on the wire, what is being decoded, what is on its way
 * to the GPU, and how much of the view is already on screen. Reading "296 MB"
 * alone says nothing about whether the load is near done; these do.
 */
function downloadProgress(downloads: NonNullable<MapModelLoadSnapshot["downloads"]>, snapshot: MapModelLoadSnapshot | null) {
  // Bytes the browser already held count as read: the cover reports how much
  // of the map the view has, not how much crossed the loopback this time.
  const metrics: Array<{ label: string; value: string }> = [];
  if (downloads.cachedBytes > 0) metrics.push({ label: "From cache", value: formatBytes(downloads.cachedBytes) });
  // Before the map's tiles exist there is exactly one file on the wire — the
  // definition — and the tracker's active count does not include it, so a
  // bare "0 files" while bytes climb would contradict the byte figure.
  metrics.push({
    label: "Downloading",
    value: snapshot === null && downloads.active === 0 ? "map definition" : `${downloads.active} ${downloads.active === 1 ? "file" : "files"}`,
  });
  if (snapshot) {
    metrics.push({ label: "Decoding", value: `${snapshot.loading} ${snapshot.loading === 1 ? "file" : "files"}` });
    metrics.push({ label: "Queued", value: `${snapshot.queued} ${snapshot.queued === 1 ? "file" : "files"}` });
    const uploads = snapshot.uploading + (snapshot.pendingTextureUploads ?? 0);
    metrics.push({ label: "To GPU", value: `${uploads} ${uploads === 1 ? "file" : "files"}` });
    if (snapshot.residentTiles !== undefined) {
      metrics.push({ label: "Tiles on screen", value: snapshot.wantedTiles ? `${snapshot.residentTiles} of ${snapshot.wantedTiles}` : String(snapshot.residentTiles) });
    }
    if (snapshot.residentBytes !== undefined && snapshot.residentBytes > 0) metrics.push({ label: "GPU memory", value: formatBytes(snapshot.residentBytes) });
  }
  return {
    transferred: formatBytes(downloads.transferredBytes + downloads.cachedBytes),
    total: downloads.totalBytes === null ? null : formatBytes(downloads.totalBytes + downloads.cachedBytes),
    speed: downloads.bytesPerSecond !== null && downloads.bytesPerSecond > 0 ? `${formatBytes(downloads.bytesPerSecond)}/s` : null,
    stalled: downloads.stalledForMs >= 5_000,
    stalledFor: downloads.stalledForMs > 0 ? formatDuration(downloads.stalledForMs) : null,
    metrics,
  };
}
export function formatBytes(bytes: number): string { if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"; const units = ["B", "KB", "MB", "GB"]; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); const value = bytes / 1024 ** index; const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2; return `${value.toFixed(digits)} ${units[index]}`; }
function formatDuration(milliseconds: number): string { return `${Math.max(1, Math.round(milliseconds / 1_000))}s`; }
export function failedSceneLoadProgress(label: string, reason: unknown): SceneLoadProgress { return { phase: "error", percent: null, message: `${label} could not be loaded`, detail: reason instanceof Error ? reason.message : "The scene stopped loading unexpectedly." }; }
