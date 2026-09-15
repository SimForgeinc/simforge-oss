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
export type SceneLoadProgress = { phase: SceneLoadPhase; percent: number | null; percentExact?: boolean; message: string; detail: string; activity?: number; download?: { transferred: string; total: string | null; stalled: boolean; stalledFor: string | null } };
export type SceneLoadProgressTracker = { peakOutstanding: number; percent: number };
export function initialSceneLoadProgress(label: string): SceneLoadProgress { return { phase: "resolving", percent: 8, message: `Loading ${label}`, detail: "Preparing the map definition…" }; }
export function sceneLoadProgressFromSnapshot(label: string, snapshot: MapModelLoadSnapshot, tracker: SceneLoadProgressTracker): { progress: SceneLoadProgress; tracker: SceneLoadProgressTracker } {
  const outstanding = Math.max(0, snapshot.loading + snapshot.queued + snapshot.uploading);
  const peakOutstanding = Math.max(tracker.peakOutstanding, outstanding, 1);
  const completedFraction = Math.max(0, Math.min(1, 1 - outstanding / peakOutstanding));
  const download = snapshot.downloads && (snapshot.downloads.active > 0 || snapshot.downloads.transferredBytes > 0 || snapshot.downloads.cachedBytes > 0) ? downloadProgress(snapshot.downloads) : undefined;
  const byteFraction = snapshot.downloads?.totalBytes ? Math.max(0, Math.min(1, snapshot.downloads.transferredBytes / snapshot.downloads.totalBytes)) : 0;
  const hasExactByteProgress = Boolean(download && snapshot.downloads?.totalBytes);
  const nextPercent = outstanding === 0 ? 94 : Math.round(55 + (hasExactByteProgress ? byteFraction : completedFraction) * 35);
  const percent = hasExactByteProgress ? Math.min(94, nextPercent) : Math.max(tracker.percent, Math.min(94, nextPercent));
  const trackerPercent = Math.max(tracker.percent, percent);
  if (snapshot.streamingError) return { tracker: { peakOutstanding, percent: trackerPercent }, progress: { phase: "error", percent: null, message: `${label} could not be loaded`, detail: snapshot.streamingError } };
  if (outstanding === 0 && snapshot.roadReady && snapshot.roadVisible) return { tracker: { peakOutstanding, percent: trackerPercent }, progress: { phase: "stabilizing", percent, message: `Finishing ${label}`, detail: "Checking the completed scene and preparing the first frame…", download } };
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
function downloadProgress(downloads: NonNullable<MapModelLoadSnapshot["downloads"]>) {
  // Bytes the browser already held count as read: the cover reports how much
  // of the map the view has, not how much crossed the loopback this time.
  return {
    transferred: formatBytes(downloads.transferredBytes + downloads.cachedBytes),
    total: downloads.totalBytes === null ? null : formatBytes(downloads.totalBytes + downloads.cachedBytes),
    stalled: downloads.stalledForMs >= 5_000,
    stalledFor: downloads.stalledForMs > 0 ? formatDuration(downloads.stalledForMs) : null,
  };
}
export function formatBytes(bytes: number): string { if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"; const units = ["B", "KB", "MB", "GB"]; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); const value = bytes / 1024 ** index; const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2; return `${value.toFixed(digits)} ${units[index]}`; }
function formatDuration(milliseconds: number): string { return `${Math.max(1, Math.round(milliseconds / 1_000))}s`; }
export function failedSceneLoadProgress(label: string, reason: unknown): SceneLoadProgress { return { phase: "error", percent: null, message: `${label} could not be loaded`, detail: reason instanceof Error ? reason.message : "The scene stopped loading unexpectedly." }; }
