"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CityViewer, CityViewerStats, TierSelection } from "@simforge-oss/viewer";
import { ActorRenderer } from "@simforge-oss/viewer";
import { CityView, waitForCanvasPresentation } from "@simforge-oss/viewer/react";
import { cn } from "../../lib/utils";
import { readRenderingPreference,
RENDERING_PREFERENCE_CHANGE_EVENT,
type RenderingPreference, renderingPreferenceQuality, RENDERING_PREFERENCE_CHOICES } from "../../components/rendering-preference"
import { applySceneFidelity } from "../editor/EditorSceneEnvironmentBridge";
import { AUTHORING_QUALITY, sceneViewerOptions } from "../editor/authoring-quality";
import { applyDefaultSceneEnvironment } from "../editor/scene-environment";
import {
  animateMapCamera,
  type MapModelLoadSnapshot,
  MAP_ZOOM_IN_MS,
  pulledBackMapView,
  waitForMapModelsFullyLoaded,
} from "./map-camera-transition";
import {
  failedSceneLoadProgress,
  initialSceneLoadProgress,
  mapMetadataLoadProgress,
  sceneLoadProgressFromSnapshot,
  type SceneLoadProgress,
  type SceneLoadProgressTracker,
} from "./map-load-progress";
import { useDirectMapAssetUrlResolver } from "./direct-map-asset-urls";
import { useSceneLoadingSurfaceProps } from "./scene-loading";
import { CloudLoadingSurface } from "../../components/CloudLoadingSurface";
import { MapLoadDebugPanel } from "./MapLoadDebugPanel";
import { authoringRuntimeReady } from "@simforge-oss/editor";

/**
 * GPU upload pacing while the loading overlay is up.
 *
 * The per-preset `uploadBudgetMs` / `uploadPixelsPerFrame` exist to keep the
 * frame rate smooth while tiles stream in mid-session — a real concern once
 * someone is panning around the map. During the initial load they protect the
 * smoothness of a scene nobody can see: the scene's `CloudLoadingSurface` is an
 * opaque cover until the prepared scene enters `revealing`.
 *
 * Measured on Belmont with the former reduced pacing (0.5 ms / 256k pixels per frame),
 * a warm reload finished downloading and decoding every tile 4.5 s in, then sat
 * on "1 uploading" for a further 16 s feeding one asset to the GPU. Half a
 * millisecond is less than a single large `texImage2D`, so the budget was spent
 * on roughly one texture per frame regardless of the pixel allowance.
 *
 * These are the ceilings `setLiveQuality` clamps to, deliberately: while the
 * cover is up there is no frame rate worth protecting, and the pacer's own
 * adaptive gate (`dt <= max(14, median * 2)`) still keeps a pathological frame
 * from starving the next one. Restored to the preset's values the moment the
 * cover lifts, which is also the moment smoothness starts to matter.
 */
const BOOT_UPLOAD_BUDGET = { uploadBudgetMs: 20, uploadPixelsPerFrame: 168e5 } as const;

/**
 * How often the cover re-reads the viewer while the map's own definition is
 * still downloading. Fast enough that the overlay's stall watchdog always
 * sees a live load move, cheap enough to run beside the boot upload budget.
 */
const METADATA_PROGRESS_POLL_MS = 500;

export type ScenarioWorldTarget = {
  mapId?: string | null;
  installedMaps?: ReadonlyArray<{ sourceMapId: string; mapVersionId: string }>;
  mapVersionId: string;
  manifestUrl: string;
  label: string;
  locality?: string | null;
};

export type ScenarioWorldState = {
  target: ScenarioWorldTarget | null;
  loadedMapVersionId: string | null;
  /** Resources bound to the current canvas; safe to reveal, not yet announced ready. */
  preparedMapVersionId: string | null;
  streaming: boolean;
  error: unknown | null;
  /** Camera/loading choreography currently owning the shared viewer. */
  transitionPhase?: MapTransitionPhase;
};

export type MapTransitionPhase =
  | "idle"
  | "loading"
  | "zooming-in"
  | "revealing"
  | "error";

/**
 * The canvas and CityViewer owned by the dashboard's ScenarioWorldProvider.
 *
 * Surfaces lease its stable viewport across page boundaries. Changing a map
 * calls `CityViewer.loadMap` through `CityView`, never replaces the context.
 * A transient null target retains the usable map while the next surface
 * resolves; the provider fences visibility and releases non-world routes.
 */
/** Tiles the current view asks for across layers; the cover shows resident vs wanted. */
function wantedTiles(stats: CityViewerStats): number | undefined {
  const layers = [stats.coverage.roads, stats.coverage.city, stats.coverage.vegetation];
  const known = layers.filter((layer): layer is NonNullable<typeof layer> => layer !== null);
  return known.length === 0 ? undefined : known.reduce((sum, layer) => sum + layer.wantedTiles, 0);
}

export function ScenarioWorldHost({
  target,
  pendingTarget = false,
  interactive = true,
  onViewerChange,
  onActorRendererChange,
  onStateChange,
  className,
}: {
  target: ScenarioWorldTarget | null;
  /** Keep the first paint covered while the async map catalog resolves. */
  pendingTarget?: boolean;
  /** Whether the user may directly steer the persistent world camera. */
  interactive?: boolean;
  onViewerChange: (viewer: CityViewer | null) => void;
  onActorRendererChange: (renderer: ActorRenderer | null) => void;
  onStateChange: (state: ScenarioWorldState) => void;
  className?: string;
}) {
  const [retainedTarget, setRetainedTarget] = useState<ScenarioWorldTarget | null>(null);
  const [loadedMapVersionId, setLoadedMapVersionId] = useState<string | null>(
    null,
  );
  const [preparedMapVersionId, setPreparedMapVersionId] = useState<string | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [transitionPhase, setTransitionPhase] =
    useState<MapTransitionPhase>(target || pendingTarget ? "loading" : "idle");
  const [loadProgress, setLoadProgress] = useState<SceneLoadProgress>(() =>
    initialSceneLoadProgress(target?.label ?? "scene"),
  );
  const [retryNonce, setRetryNonce] = useState(0);
  const resolveMapAssetUrls = useDirectMapAssetUrlResolver(retainedTarget?.mapVersionId ?? null);
  const [tierSelection, setTierSelection] = useState<TierSelection | null>(null);
  const [preference, setPreference] = useState<RenderingPreference>(
    () => readRenderingPreference(),
  );
  const quality = AUTHORING_QUALITY[renderingPreferenceQuality(preference)];
  const uploadBudget = transitionPhase === "idle" || transitionPhase === "revealing" ? null : BOOT_UPLOAD_BUDGET;
  const uploadBudgetRef = useRef(uploadBudget);
  uploadBudgetRef.current = uploadBudget;
  const reactId = useId();
  const instanceIdRef = useRef(`world-${reactId}`);
  const targetRef = useRef(target);
  const retainedTargetRef = useRef(retainedTarget);
  const loadedMapVersionIdRef = useRef(loadedMapVersionId);
  const viewerRef = useRef<CityViewer | null>(null);
  const interactiveRef = useRef(interactive);
  const transitionPhaseRef = useRef<MapTransitionPhase>(
    target || pendingTarget ? "loading" : "idle",
  );
  const progressTrackerRef = useRef<SceneLoadProgressTracker>({
    peakOutstanding: 0,
    percent: 8,
  });
  const appliedPreferenceRef = useRef(preference);
  const transitionGenerationRef = useRef(0);
  const cancelCameraAnimationRef = useRef<(() => void) | null>(null);
  const cancelModelSettleRef = useRef<(() => void) | null>(null);
  const cancelMetadataProgressRef = useRef<(() => void) | null>(null);
  const presentationRef = useRef<{ target: ScenarioWorldTarget; detail: string; generation: number } | null>(null);
  const actorRendererRef = useRef<ActorRenderer | null>(null);
  const onViewerChangeRef = useRef(onViewerChange);
  const onActorRendererChangeRef = useRef(onActorRendererChange);
  // A map version is immutable. Preview and editor endpoints may return
  // different URL forms for it, but changing modes must not make CityView
  // reload the same world or invalidate an in-flight completion callback.
  const stableTarget =
    target && retainedTarget?.mapVersionId === target.mapVersionId
      ? retainedTarget
      : target;
  targetRef.current = stableTarget;
  useEffect(() => {
    const timer = window.setInterval(() => {
      const viewer = viewerRef.current;
      if (!viewer || !supportsMapModelReadiness(viewer)) return;
      const selection = viewer.getStats().tierSelection;
      setTierSelection((previous) => previous?.requested === selection.requested && previous.actual === selection.actual && previous.codec === selection.codec && previous.longestEdgePx === selection.longestEdgePx && previous.variantId === selection.variantId && previous.downgradeReason === selection.downgradeReason ? previous : selection);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  retainedTargetRef.current = retainedTarget;
  loadedMapVersionIdRef.current = loadedMapVersionId;
  interactiveRef.current = interactive;
  onViewerChangeRef.current = onViewerChange;
  onActorRendererChangeRef.current = onActorRendererChange;

  useEffect(() => {
    const updatePreference = (event: Event) => {
      setPreference((event as CustomEvent<RenderingPreference>).detail);
    };
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, updatePreference);
    return () =>
      window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, updatePreference);
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!supportsMapCameraTransition(viewer) || transitionPhaseRef.current !== "idle") return;
    viewer.setCameraPoseConstraintsEnabled(true);
    viewer.controls.setEnabled(interactive);
  }, [interactive]);

  const updateTransitionPhase = (phase: MapTransitionPhase) => {
    transitionPhaseRef.current = phase;
    setTransitionPhase(phase);
  };

  const updateLoadProgress = (progress: SceneLoadProgress) => {
    setLoadProgress((current) => {
      if (progress.phase === "error" || progress.percent == null) return progress;
      if (progress.percentExact) return progress;
      const percent = Math.max(current.percent ?? 0, progress.percent);
      return { ...progress, percent };
    });
  };

  /**
   * Publish the viewer's real byte telemetry between `onReady` and
   * `onMapLoaded`. Without it the cover holds one unchanging source for the
   * whole of a large map's definition download and the host's 45 s stall
   * watchdog replaces a healthy load with a "taking longer than expected"
   * error.
   */
  const startMetadataProgress = (viewer: CityViewer, label: string) => {
    cancelMetadataProgressRef.current?.();
    const publish = () => {
      let downloads: MapModelLoadSnapshot["downloads"];
      try {
        downloads = supportsMapModelReadiness(viewer) ? viewer.getStats().downloads : undefined;
      } catch {
        downloads = undefined;
      }
      updateLoadProgress(mapMetadataLoadProgress(label, downloads));
    };
    publish();
    const timer = setInterval(publish, METADATA_PROGRESS_POLL_MS);
    cancelMetadataProgressRef.current = () => {
      clearInterval(timer);
      cancelMetadataProgressRef.current = null;
    };
  };

  const finishCameraTransition = (viewer: CityViewer | null) => {
    cancelMetadataProgressRef.current?.();
    cancelCameraAnimationRef.current?.();
    cancelCameraAnimationRef.current = null;
    cancelModelSettleRef.current?.();
    cancelModelSettleRef.current = null;
    if (supportsMapCameraTransition(viewer)) {
      viewer.setCameraPoseConstraintsEnabled(true);
      viewer.controls.setEnabled(interactiveRef.current);
    }
    updateTransitionPhase("idle");
  };

  const revealPreparedMap = (current: ScenarioWorldTarget, detail: string) => {
    presentationRef.current = { target: current, detail, generation: transitionGenerationRef.current };
    setPreparedMapVersionId(current.mapVersionId);
    updateTransitionPhase("revealing");
  };

  useEffect(() => {
    if (transitionPhase !== "revealing") return;
    const presentation = presentationRef.current;
    const viewer = viewerRef.current;
    if (!presentation || !viewer) return;
    return waitForCanvasPresentation(viewer.renderer.domElement, () => {
      const latest = targetRef.current ?? retainedTargetRef.current;
      if (presentation.generation !== transitionGenerationRef.current
        || latest?.mapVersionId !== presentation.target.mapVersionId
        || viewerRef.current !== viewer) return;
      presentationRef.current = null;
      setLoadedMapVersionId(presentation.target.mapVersionId);
      setError(null);
      updateLoadProgress({
        phase: "ready",
        percent: 100,
        message: `${presentation.target.label} is ready`,
        detail: presentation.detail,
      });
      finishCameraTransition(viewer);
    });
  }, [preparedMapVersionId, transitionPhase]);

  // Hand the GPU uploader its boot budget while the cover is up and the
  // preset's own pacing back the moment it lifts. See BOOT_UPLOAD_BUDGET.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.setLiveQuality({ ...quality.live, ...(uploadBudget ?? {}) });
  }, [quality, uploadBudget]);

  useEffect(() => {
    if (stableTarget || retainedTargetRef.current) return;
    if (pendingTarget) {
      if (transitionPhaseRef.current === "idle") {
        setLoadProgress({
          phase: "resolving",
          percent: 5,
          message: "Preparing map workspace",
          detail: "Resolving the map and its local assets…",
        });
        updateTransitionPhase("loading");
      }
      return;
    }
    if (transitionPhaseRef.current === "loading") {
      finishCameraTransition(viewerRef.current);
    }
    // This bridges async target resolution into the imperative world state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTarget, stableTarget]);

  // No document here, so the browsing sky is the schema's default
  // environment - the same one a fresh scenario opens with.
  const restoreEnvironmentRef = useRef<() => void>(() => undefined);
  const applyEnvironment = useCallback((viewer: CityViewer) => {
    restoreEnvironmentRef.current();
    restoreEnvironmentRef.current = applyDefaultSceneEnvironment(viewer, renderingPreferenceQuality(preference));
  }, [preference]);
  useEffect(() => () => restoreEnvironmentRef.current(), []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const changed = appliedPreferenceRef.current !== preference;
    appliedPreferenceRef.current = preference;
    // Fidelity first, sky second: the fidelity switch hides the sun and sky
    // the browsing environment installs. The live budget is the one the upload
    // effect above holds at this moment, read through its own dependencies.
    applySceneFidelity(viewer, preference, { ...quality.live, ...(uploadBudgetRef.current ?? {}) });
    if (changed) applyEnvironment(viewer);
    // A preset switch turns the real shadow map on or off, so the painted
    // stand-in blobs have to change with it.
    if (supportsRealtimeShadowQuery(viewer) && actorRendererRef.current) {
      actorRendererRef.current.setContactShadows(!viewer.castsRealtimeShadows());
    }
    const current = targetRef.current ?? retainedTargetRef.current;
    const tierChange = changed && supportsMapModelReadiness(viewer) ? viewer.setMapTextureTier(renderingPreferenceQuality(preference)) : null;
    if (
      !changed ||
      !current ||
      loadedMapVersionIdRef.current !== current.mapVersionId ||
      transitionPhaseRef.current !== "idle" ||
      !supportsMapModelReadiness(viewer)
    ) {
      void tierChange?.catch((reason: unknown) => {
        if (viewerRef.current !== viewer) return;
        setError(reason);
        if (current) updateLoadProgress(failedSceneLoadProgress(current.label, reason));
        updateTransitionPhase("error");
      });
      return;
    }

    const generation = ++transitionGenerationRef.current;
    setLoadedMapVersionId(null);
    setPreparedMapVersionId(null);
    setError(null);
    progressTrackerRef.current = { peakOutstanding: 0, percent: 55 };
    setLoadProgress({
      phase: "assets",
      percent: 55,
      message: `Applying ${renderingPreferenceLabel(preference)}`,
      detail: `Preparing ${current.label} for the selected rendering profile…`,
    });
    updateTransitionPhase("loading");
    viewer.controls.setEnabled(false);
    cancelModelSettleRef.current?.();
    void tierChange!.then(() => {
      if (generation !== transitionGenerationRef.current) return;
    cancelModelSettleRef.current = waitForMapModelsFullyLoaded(
      () => {
        const stats = viewer.getStats();
        return {
          roadReady: viewer.roadReady,
          roadVisible: stats.roadVisible,
          sceneAssetsReady:
            stats.residentTiles > 0 &&
            authoringRuntimeReady(current.mapVersionId),
          loading: stats.loading,
          queued: stats.queued,
          uploading: stats.uploading,
          pendingTextureUploads: stats.pendingTextureUploads,
          // Only a required failure fails the load; missing detail tiles are
          // reported as reduced detail once the map is up.
          streamingError: stats.requiredError ?? null,
          detailFailures: stats.detailFailures ?? 0,
          downloads: stats.downloads,
          residentTiles: stats.residentTiles,
          wantedTiles: wantedTiles(stats),
          residentBytes: stats.residentBytes,
        };
      },
      () => {
        if (
          generation !== transitionGenerationRef.current ||
          targetRef.current?.mapVersionId !== current.mapVersionId
        ) {
          return;
        }
        revealPreparedMap(current, "The new rendering profile is fully prepared.");
      },
      (reason) => {
        if (generation !== transitionGenerationRef.current) return;
        setError(reason);
        updateLoadProgress(failedSceneLoadProgress(current.label, reason));
        updateTransitionPhase("error");
      },
      {
        onSnapshot: (snapshot) => {
          if (generation !== transitionGenerationRef.current) return;
          const next = sceneLoadProgressFromSnapshot(
            current.label,
            snapshot,
            progressTrackerRef.current,
          );
          progressTrackerRef.current = next.tracker;
          updateLoadProgress(next.progress);
        },
      },
    );
    }).catch((reason: unknown) => {
      if (generation !== transitionGenerationRef.current) return;
      setError(reason);
      updateLoadProgress(failedSceneLoadProgress(current.label, reason));
      updateTransitionPhase("error");
    });
    // This effect owns the imperative renderer response to a saved profile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyEnvironment, preference, quality]);

  // A new immutable map replaces the old map's resources through this one
  // viewer. Page handoffs on the same identity do not replay loading or framing.
  useEffect(() => {
    if (!stableTarget) return;
    if (retainedTargetRef.current?.mapVersionId === stableTarget.mapVersionId) return;

    transitionGenerationRef.current += 1;
    setError(null);
    setLoadedMapVersionId(null);
    setPreparedMapVersionId(null);
    progressTrackerRef.current = { peakOutstanding: 0, percent: 8 };
    cancelCameraAnimationRef.current?.();
    cancelModelSettleRef.current?.();
    cancelMetadataProgressRef.current?.();
    cancelModelSettleRef.current = null;
    retainedTargetRef.current = stableTarget;
    setRetainedTarget(stableTarget);
    setLoadProgress(initialSceneLoadProgress(stableTarget.label));
    updateTransitionPhase("loading");
  }, [stableTarget]);

  useEffect(
    () => () => {
      actorRendererRef.current?.dispose();
      cancelCameraAnimationRef.current?.();
      cancelModelSettleRef.current?.();
      cancelMetadataProgressRef.current?.();
      actorRendererRef.current = null;
      onActorRendererChangeRef.current(null);
      onViewerChangeRef.current(null);
    },
    [],
  );

  const effectiveTarget = stableTarget ?? retainedTarget;
  const streaming = Boolean(
    effectiveTarget && loadedMapVersionId !== effectiveTarget.mapVersionId,
  );
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    onStateChangeRef.current({
      target: effectiveTarget,
      loadedMapVersionId,
      preparedMapVersionId,
      streaming,
      error,
      transitionPhase,
    });
  }, [effectiveTarget, error, loadedMapVersionId, preparedMapVersionId, streaming, transitionPhase]);

  const sceneLoading = useSceneLoadingSurfaceProps(
    loadProgress,
    transitionPhase === "error"
      ? () => {
          const current = targetRef.current ?? retainedTargetRef.current;
          if (!current) return;
          transitionGenerationRef.current += 1;
          setError(null);
          setLoadedMapVersionId(null);
          setPreparedMapVersionId(null);
          progressTrackerRef.current = { peakOutstanding: 0, percent: 8 };
          setLoadProgress(initialSceneLoadProgress(current.label));
          updateTransitionPhase("loading");
          setRetryNonce((value) => value + 1);
        }
      : null,
    <MapLoadDebugPanel source={{
      getViewer: () => viewerRef.current,
      mapId: effectiveTarget?.mapId,
      installedMaps: effectiveTarget?.installedMaps,
      mapVersionId: effectiveTarget?.mapVersionId,
      manifestUrl: effectiveTarget?.manifestUrl,
      readinessAnnounced: Boolean(effectiveTarget && loadedMapVersionId === effectiveTarget.mapVersionId),
      requestedTier: renderingPreferenceQuality(preference),
      phase: transitionPhase,
      error,
    }} />,
  );

  return (
    <div
      className={cn("relative overflow-hidden bg-background", className)}
      data-testid="scenario-world-host"
      data-world-instance-id={instanceIdRef.current}
      data-world-map-version-id={effectiveTarget?.mapVersionId ?? ""}
      data-world-manifest-url={effectiveTarget?.manifestUrl ?? ""}
      data-world-loaded-map-version-id={loadedMapVersionId ?? ""}
      data-world-load-percent={loadProgress.percent ?? ""}
      data-world-prepared-map-version-id={preparedMapVersionId ?? ""}
      data-world-transition={transitionPhase}
      data-world-interactive={String(interactive)}
    >
      {tierSelection?.downgradeReason ? (
        <div role="status" className="absolute bottom-3 left-3 z-10 rounded bg-background/90 px-3 py-2 text-xs">
          Actual texture tier: {tierSelection.actual}. {tierSelection.downgradeReason}
        </div>
      ) : null}
      {retainedTarget ? (
        <CityView
          key={`world-viewer:${retryNonce}`}
          manifestUrl={retainedTarget.manifestUrl}
          initialOptions={{ ...sceneViewerOptions(preference), resolveMapAssetUrls, resolveAssetUrls: resolveMapAssetUrls }}
          onReady={(viewer) => {
            viewerRef.current = viewer;
            startMetadataProgress(viewer, retainedTarget.label);
            applySceneFidelity(viewer, preference, { ...quality.live, ...BOOT_UPLOAD_BUDGET });
            applyEnvironment(viewer);
            if (supportsMapCameraTransition(viewer)) {
              viewer.controls.setEnabled(
                transitionPhaseRef.current === "idle" && interactiveRef.current,
              );
            }
            actorRendererRef.current?.dispose();
            const actorRenderer = new ActorRenderer();
            actorRenderer.group.name = "scenario-world-actors";
            viewer.scene.add(actorRenderer.group);
            actorRendererRef.current = actorRenderer;
            onViewerChange(viewer);
            onActorRendererChange(actorRenderer);
          }}
          onDisposed={(disposed) => {
            if (viewerRef.current !== disposed) return;
            viewerRef.current = null;
            ++transitionGenerationRef.current;
            cancelCameraAnimationRef.current?.();
            cancelCameraAnimationRef.current = null;
            cancelModelSettleRef.current?.();
            cancelModelSettleRef.current = null;
            cancelMetadataProgressRef.current?.();
            loadedMapVersionIdRef.current = null;
            setLoadedMapVersionId(null);
            setPreparedMapVersionId(null);
            setTierSelection(null);
            actorRendererRef.current = null;
            onViewerChangeRef.current(null);
            onActorRendererChangeRef.current(null);
          }}
          onMapLoaded={(manifestUrl) => {
            const current = targetRef.current ?? retainedTarget;
            if (manifestUrl !== current.manifestUrl) return;
            cancelMetadataProgressRef.current?.();
            const viewer = viewerRef.current;
            // The renderer casts a real sun shadow once a map is loaded, so the
            // painted blobs under each actor would be a second, wrongly-angled
            // shadow. Actors still cast into the real map either way.
            if (supportsRealtimeShadowQuery(viewer) && actorRendererRef.current) {
              actorRendererRef.current.setContactShadows(!viewer.castsRealtimeShadows());
            }
            setError(null);
            updateLoadProgress({
              phase: "assets",
              percent: 55,
              message: `Loading ${current.label} assets`,
              detail: "Loading roads, buildings, and map objects…",
            });
            const destinationView =
              supportsMapCameraTransition(viewer) && !prefersReducedMotion()
                ? viewer.controls.getView()
                : null;
            const pulledBackDestination = destinationView
              ? pulledBackMapView(destinationView)
              : null;
            const prepareReveal = () => {
              const latest = targetRef.current ?? retainedTargetRef.current;
              if (
                !latest ||
                latest.mapVersionId !== current.mapVersionId ||
                latest.manifestUrl !== manifestUrl
              ) {
                return;
              }
              cancelModelSettleRef.current = null;
              revealPreparedMap(current, "Scene assets are loaded and ready to use.");
            };
            const completeMapLoad = () => {
              const latest = targetRef.current ?? retainedTargetRef.current;
              if (
                !latest ||
                latest.mapVersionId !== current.mapVersionId ||
                latest.manifestUrl !== manifestUrl
              ) {
                return;
              }
              cancelModelSettleRef.current = null;
              if (
                supportsMapCameraTransition(viewer) &&
                destinationView &&
                pulledBackDestination &&
                transitionPhaseRef.current === "loading" &&
                !prefersReducedMotion()
              ) {
                viewer.setCameraPoseConstraintsEnabled(false);
                viewer.controls.setEnabled(false);
                updateTransitionPhase("zooming-in");
                cancelCameraAnimationRef.current = animateMapCamera(
                  (view) => viewer.controls.applyView(view),
                  pulledBackDestination,
                  destinationView,
                  MAP_ZOOM_IN_MS,
                  prepareReveal,
                );
              } else {
                prepareReveal();
              }
            };

            if (supportsMapModelReadiness(viewer)) {
              if (pulledBackDestination) {
                viewer.setCameraPoseConstraintsEnabled(false);
                viewer.controls.setEnabled(false);
                viewer.controls.applyView(pulledBackDestination);
              }
              updateTransitionPhase("loading");
              cancelModelSettleRef.current?.();
              cancelModelSettleRef.current = waitForMapModelsFullyLoaded(
                () => {
                  const stats = viewer.getStats();
                  return {
                    roadReady: viewer.roadReady,
                    roadVisible: stats.roadVisible,
                    sceneAssetsReady:
            stats.residentTiles > 0 &&
            authoringRuntimeReady(current.mapVersionId),
                    loading: stats.loading,
                    queued: stats.queued,
                    uploading: stats.uploading,
                    pendingTextureUploads: stats.pendingTextureUploads,
                    downloads: stats.downloads,
                    streamingError: stats.streamingError,
                    residentTiles: stats.residentTiles,
                    wantedTiles: wantedTiles(stats),
                    residentBytes: stats.residentBytes,
                  };
                },
                completeMapLoad,
                (reason) => {
                  const latest = targetRef.current ?? retainedTargetRef.current;
                  if (latest?.mapVersionId !== current.mapVersionId) return;
                  setError(reason);
                  updateLoadProgress(failedSceneLoadProgress(current.label, reason));
                  updateTransitionPhase("error");
                  if (supportsMapCameraTransition(viewer)) {
                    viewer.controls.setEnabled(false);
                  }
                },
                {
                  onSnapshot: (snapshot) => {
                    const next = sceneLoadProgressFromSnapshot(
                      current.label,
                      snapshot,
                      progressTrackerRef.current,
                    );
                    progressTrackerRef.current = next.tracker;
                    updateLoadProgress(next.progress);
                  },
                },
              );
            } else {
              completeMapLoad();
            }
          }}
          onError={(reason, manifestUrl) => {
            const current = targetRef.current ?? retainedTarget;
            if (current.manifestUrl !== manifestUrl) return;
            cancelMetadataProgressRef.current?.();
            setError(reason);
            updateLoadProgress(failedSceneLoadProgress(current.label, reason));
            updateTransitionPhase("error");
            if (supportsMapCameraTransition(viewerRef.current)) {
              viewerRef.current.controls.setEnabled(false);
            }
          }}
          className={cn(
            "h-full w-full transition-[opacity,filter] duration-500 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
            !interactive && "pointer-events-none",
            preparedMapVersionId !== effectiveTarget?.mapVersionId || transitionPhase === "loading" || transitionPhase === "error"
              ? "opacity-0"
              : "opacity-100 saturate-100 blur-0",
          )}
          ariaLabel={`${effectiveTarget?.label ?? retainedTarget.label} 3D world`}
          role={interactive ? "application" : "img"}
          tabIndex={interactive ? 0 : -1}
        />
      ) : null}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_42%,rgba(0,0,0,0.48)_100%)] transition-opacity duration-500 motion-reduce:hidden",
          transitionPhase === "idle" || transitionPhase === "revealing" ? "opacity-0" : "opacity-100",
        )}
      />
      {transitionPhase !== "idle" && transitionPhase !== "revealing" ? (
        <CloudLoadingSurface scope="screen" {...sceneLoading} />
      ) : null}
    </div>
  );
}


function renderingPreferenceLabel(preference: RenderingPreference): string {
  return RENDERING_PREFERENCE_CHOICES.find(choice => choice.id === preference)!.label;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function supportsMapCameraTransition(
  viewer: CityViewer | null,
): viewer is CityViewer {
  if (!viewer) return false;
  const candidate = viewer as CityViewer & {
    controls?: Partial<CityViewer["controls"]>;
    setCameraPoseConstraintsEnabled?: unknown;
  };
  return Boolean(
    candidate.controls &&
      typeof candidate.controls.getView === "function" &&
      typeof candidate.controls.applyView === "function" &&
      typeof candidate.controls.setEnabled === "function" &&
      typeof candidate.setCameraPoseConstraintsEnabled === "function",
  );
}

function supportsRealtimeShadowQuery(
  viewer: CityViewer | null,
): viewer is CityViewer {
  if (!viewer) return false;
  const candidate = viewer as CityViewer & { castsRealtimeShadows?: unknown };
  return typeof candidate.castsRealtimeShadows === "function";
}

function supportsMapModelReadiness(
  viewer: CityViewer | null,
): viewer is CityViewer {
  return Boolean(
    supportsMapCameraTransition(viewer) &&
      typeof (viewer as CityViewer & { getStats?: unknown }).getStats === "function",
  );
}
