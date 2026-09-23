import type { AssetDownloadStats, CameraView } from "@simforge-oss/viewer";
import { VisibleClock } from "../../lib/visible-clock";

export const MAP_ZOOM_IN_MS = 1_800;
/**
 * No quiet window. It guarded against the old whole-queue test briefly
 * reading zero between decode batches; readiness is now the viewer's required
 * view scope, which does not flap that way, so the first complete poll counts.
 */
export const MAP_MODEL_STABLE_MS = 0;
export const MAP_MODEL_LOAD_TIMEOUT_MS = 90_000;

export type MapModelLoadSnapshot = {
  roadReady: boolean;
  roadVisible: boolean;
  /** At least one non-road scene tile is resident. */
  sceneAssetsReady?: boolean;
  loading: number;
  queued: number;
  uploading: number;
  pendingTextureUploads?: number;
  downloads?: AssetDownloadStats;
  /** Only a failure that makes the map unusable; detail tiles are counted below. */
  streamingError?: string | null;
  /** Optional detail tiles that gave up. A map with these is loaded, not failed. */
  detailFailures?: number;
  /** Tiles resident on the GPU right now, and how many the current view wants. */
  residentTiles?: number;
  wantedTiles?: number;
  /** Estimated GPU bytes held by resident tiles. */
  residentBytes?: number;
  /**
   * Assets the current view requires that are not resident yet (roads, and
   * every city cell on screen or within the block the camera stands in), and
   * on-screen cells showing nothing. When the viewer reports them, loaded
   * means "the view is complete": prefetch beyond it and vegetation keep
   * streaming in behind an interactive scene instead of holding it back.
   */
  requiredPendingAssets?: number;
  missingInViewTiles?: number;
};

export function mapModelsFullyLoaded(snapshot: MapModelLoadSnapshot): boolean {
  const viewComplete = snapshot.requiredPendingAssets !== undefined
    ? snapshot.requiredPendingAssets === 0 && (snapshot.missingInViewTiles ?? 0) === 0
    : snapshot.loading === 0 && snapshot.queued === 0 && snapshot.uploading === 0;
  return Boolean(
    snapshot.roadReady &&
      snapshot.roadVisible &&
      snapshot.sceneAssetsReady !== false &&
      viewComplete &&
      !snapshot.streamingError,
  );
}

/**
 * Require a quiet window rather than trusting one empty queue sample. Tile and
 * model decoders can briefly reach zero between batches, which used to start
 * the zoom-in while destination buildings were still appearing.
 * Quiet and inactivity windows count only visible time: browser occlusion can
 * suspend the animation frames that drain GPU uploads.
 */
export function waitForMapModelsFullyLoaded(
  readSnapshot: () => MapModelLoadSnapshot,
  onComplete: () => void,
  onFailure: (error: Error) => void,
  options: {
    stableMs?: number;
    timeoutMs?: number;
    pollMs?: number;
    onSnapshot?: (snapshot: MapModelLoadSnapshot) => void;
  } = {},
): () => void {
  const stableMs = options.stableMs ?? MAP_MODEL_STABLE_MS;
  const timeoutMs = options.timeoutMs ?? MAP_MODEL_LOAD_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 100;
  let lastActivityAt = 0;
  let previousActivityKey: string | null = null;
  let stableSince: number | null = null;
  let timer: number | NodeJS.Timeout | undefined;
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
    clearTimeout(timer);
    clock.dispose();
  };

  const finish = (callback: () => void) => {
    if (cancelled) return;
    cancel();
    callback();
  };

  const poll = () => {
    if (cancelled) return;
    const now = clock.now();
    let snapshot: MapModelLoadSnapshot;
    try {
      snapshot = readSnapshot();
      options.onSnapshot?.(snapshot);
      const activityKey = snapshotActivityKey(snapshot);
      if (previousActivityKey !== null && activityKey !== previousActivityKey) {
        lastActivityAt = now;
      }
      previousActivityKey = activityKey;
    } catch (reason) {
      finish(() =>
        onFailure(
          reason instanceof Error
            ? reason
            : new Error("Map model readiness could not be read."),
        ),
      );
      return;
    }

    if (snapshot.streamingError) {
      finish(() => onFailure(new Error(snapshot.streamingError!)));
      return;
    }
    if (clock.visible) {
      if (mapModelsFullyLoaded(snapshot)) {
        stableSince ??= now;
        if (now - stableSince >= stableMs) {
          finish(onComplete);
          return;
        }
      } else {
        stableSince = null;
      }
      if (now - lastActivityAt >= timeoutMs) {
        finish(() =>
          onFailure(
            new Error(
              `Map models made no progress for ${timeoutMs} ms ` +
                `(loading ${snapshot.loading}, queued ${snapshot.queued}, uploading ${snapshot.uploading}).`,
            ),
          ),
        );
        return;
      }
    }
    if (!cancelled) timer = setTimeout(poll, pollMs);
  };

  const onVisibilityChange = () => {
    stableSince = null;
    clearTimeout(timer);
    poll();
  };
  const clock = new VisibleClock(onVisibilityChange);
  poll();
  return cancel;
}

function snapshotActivityKey(snapshot: MapModelLoadSnapshot): string {
  return [
    snapshot.roadReady,
    snapshot.roadVisible,
    snapshot.sceneAssetsReady,
    snapshot.loading,
    snapshot.queued,
    snapshot.uploading,
    snapshot.pendingTextureUploads ?? 0,
    snapshot.downloads?.active ?? 0,
    snapshot.downloads?.transferredBytes ?? 0,
    snapshot.downloads?.cachedBytes ?? 0,
    snapshot.downloads?.discoveryComplete,
    snapshot.downloads?.totalBytes ?? "unknown",
    snapshot.requiredPendingAssets ?? "-",
    snapshot.missingInViewTiles ?? "-",
  ].join(":");
}

/** Pull the eye away from its target without changing the view direction. */
export function pulledBackMapView(
  view: CameraView,
  factor = 1.65,
): CameraView {
  const [tx, ty, tz] = view.target;
  const [x, y, z] = view.position;
  return {
    ...view,
    position: [
      tx + (x - tx) * factor,
      ty + (y - ty) * factor,
      tz + (z - tz) * factor,
    ],
  };
}

export function interpolateMapView(
  from: CameraView,
  to: CameraView,
  progress: number,
): CameraView {
  const t = easeInOutCubic(Math.min(1, Math.max(0, progress)));
  const mix = (start: number, end: number) => start + (end - start) * t;
  return {
    position: [
      mix(from.position[0], to.position[0]),
      mix(from.position[1], to.position[1]),
      mix(from.position[2], to.position[2]),
    ],
    target: [
      mix(from.target[0], to.target[0]),
      mix(from.target[1], to.target[1]),
      mix(from.target[2], to.target[2]),
    ],
    fov: mix(from.fov, to.fov),
  };
}

export function animateMapCamera(
  apply: (view: CameraView) => void,
  from: CameraView,
  to: CameraView,
  durationMs: number,
  onComplete: () => void,
): () => void {
  if (durationMs <= 0 || typeof requestAnimationFrame === "undefined") {
    apply(to);
    onComplete();
    return () => undefined;
  }

  let cancelled = false;
  let frame = 0;
  let startedAt: number | null = null;
  const tick = (now: number) => {
    if (cancelled) return;
    startedAt ??= now;
    const progress = Math.min(1, (now - startedAt) / durationMs);
    apply(interpolateMapView(from, to, progress));
    if (progress >= 1) {
      onComplete();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}

/** Input that means the user has taken the camera: any of these ends an intro zoom. */
export const CAMERA_TAKEOVER_EVENTS = ["pointerdown", "wheel", "keydown", "touchstart"] as const;

/**
 * The map intro zoom, played on an already interactive scene. It never gates
 * readiness: the scene is revealed and accepts input when its view is
 * complete, and the first pointer, wheel, key or touch on `surface` ends the
 * zoom where it is and hands the camera to the user. `onEnd` runs once,
 * whether the zoom finished or was interrupted.
 */
export function playInterruptibleMapZoom(
  surface: EventTarget,
  apply: (view: CameraView) => void,
  from: CameraView,
  to: CameraView,
  durationMs: number,
  onEnd: (interrupted: boolean) => void,
): () => void {
  let ended = false;
  let cancelAnimation: () => void = () => undefined;
  const detach = () => {
    for (const type of CAMERA_TAKEOVER_EVENTS) surface.removeEventListener(type, interrupt, true);
  };
  const end = (interrupted: boolean) => {
    if (ended) return;
    ended = true;
    detach();
    onEnd(interrupted);
  };
  const interrupt = () => {
    cancelAnimation();
    end(true);
  };
  for (const type of CAMERA_TAKEOVER_EVENTS) surface.addEventListener(type, interrupt, true);
  apply(from);
  cancelAnimation = animateMapCamera(apply, from, to, durationMs, () => end(false));
  return () => {
    cancelAnimation();
    detach();
    ended = true;
  };
}

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}
