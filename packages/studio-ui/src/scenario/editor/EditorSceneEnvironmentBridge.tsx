"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ActorRenderer, CityViewer, CityViewerLiveQuality } from "@simforge-oss/viewer";
import type { EditorDocument } from "@simforge-oss/editor";
import { editorLightingSignature } from "@simforge-oss/scenario/contracts";
import type { ScenarioAuthoringQuality } from "../../lib/scenario/contracts";
import { AUTHORING_QUALITY } from "./authoring-quality";
import { resolvePracticalLighting } from "./practical-lighting";
import { applyDefaultSceneEnvironment, applyEditorSceneEnvironment } from "./scene-environment";
import { sceneTimeSignature } from "./scene-time";
import { editorWeatherControlSignature } from "./weather-controls";

const EMPTY_UNSUBSCRIBE = () => undefined;

/**
 * Applies a quality preset's renderer fidelity to a mounted viewer.
 *
 * This is the one call that every Studio surface makes, and it must run before
 * any sky is applied: `setLiveQuality` clears the weather appearance,
 * `setAuthoringFidelity` can hide the sun and sky and drops
 * `scene.environment` when cinematic lighting is off. A surface that applied
 * its environment first had that environment silently undone, which is how the
 * drive and map views lost their sun while the editor kept it.
 *
 * `live` lets a host that paces GPU uploads during a map transition hand the
 * viewer its own streaming budget; the lighting-relevant calls are the same.
 */
export function applySceneFidelity(
  viewer: CityViewer,
  quality: ScenarioAuthoringQuality,
  live: Partial<CityViewerLiveQuality> = AUTHORING_QUALITY[quality].live,
): void {
  const preset = AUTHORING_QUALITY[quality];
  viewer.setLiveQuality(live);
  viewer.setRenderingSuspended(false);
  viewer.setAuthoringFidelity({
    cinematicLighting: preset.cinematicLighting,
  });
  viewer.setLayerVisible("vegetation", preset.vegetation);
}

/**
 * The single owner of a viewer's lighting: renderer fidelity for the quality
 * preset, then the sky — the document's authored environment when there is one
 * to follow, otherwise the schema default a fresh scenario opens with. The
 * scenario editor, the drive game and the map viewer all mount this, so they
 * cannot drift apart.
 *
 * `ownsViewer` is false for dashboard surfaces: the persistent world owns
 * fidelity, while this bridge applies the surface's environment only after
 * its map (including the sun light) is ready.
 */
export function EditorSceneEnvironmentBridge({
  active,
  actorRenderer,
  document,
  ownsViewer = true,
  quality,
  viewer,
}: {
  readonly active: boolean;
  readonly actorRenderer?: ActorRenderer | null;
  readonly document: EditorDocument | null;
  readonly ownsViewer?: boolean;
  readonly quality: ScenarioAuthoringQuality;
  readonly viewer: CityViewer | null;
}) {
  const subscribe = useCallback(
    (listener: () => void) => document?.subscribe(listener) ?? EMPTY_UNSUBSCRIBE,
    [document],
  );
  const getSnapshot = useCallback(() => document?.revision ?? 0, [document]);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const weather = document?.data.environment.weather;
  const timeOfDay = document?.data.environment.timeOfDay;
  const weatherControls = document
    ? editorWeatherControlSignature(document.data.environment)
    : null;
  const lighting = document
    ? editorLightingSignature(document.data.environment)
    : null;
  const sceneTime = document
    ? sceneTimeSignature(document.data.environment)
    : null;
  const authored = active && document !== null && Boolean(weather && timeOfDay);

  // Declared before the environment effect so React runs it first on every
  // commit where both are due; the environment is always the last word.
  useEffect(() => {
    if (!viewer || !ownsViewer) return;
    applySceneFidelity(viewer, quality);
  }, [ownsViewer, quality, viewer]);

  useEffect(() => {
    if (!viewer) return;
    if (!authored || !document) {
      return active ? applyDefaultSceneEnvironment(viewer, quality) : undefined;
    }
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ?? false;
    const practical = resolvePracticalLighting(document.data.environment);
    viewer.setStreetLightsEnabled(practical.streetLights);
    actorRenderer?.setHeadlightsEnabled(practical.vehicleHeadlights);
    const restoreEnvironment = applyEditorSceneEnvironment(viewer, document.data.environment, {
      quality,
      reducedMotion,
    });
    return () => {
      restoreEnvironment();
      viewer.setStreetLightsEnabled(false);
      actorRenderer?.setHeadlightsEnabled(false);
    };
  }, [active, actorRenderer, authored, document, lighting, ownsViewer, quality, sceneTime, viewer, weatherControls]);

  return null;
}
