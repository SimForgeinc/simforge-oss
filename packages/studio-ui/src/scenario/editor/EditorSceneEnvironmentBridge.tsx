"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ActorRenderer, CityViewer } from "@simforge-oss/viewer";
import type { EditorDocument } from "@simforge-oss/editor";
import { editorLightingSignature } from "@simforge-oss/scenario/contracts";
import type { ScenarioAuthoringQuality } from "../../lib/scenario/contracts";
import { resolvePracticalLighting } from "./practical-lighting";
import { applyEditorSceneEnvironment } from "./scene-environment";
import { sceneTimeSignature } from "./scene-time";
import { editorWeatherControlSignature } from "./weather-controls";

const EMPTY_UNSUBSCRIBE = () => undefined;

/** Keeps the authored environment and the already-mounted Three.js world in sync. */
export function EditorSceneEnvironmentBridge({
  active,
  actorRenderer,
  document,
  quality,
  viewer,
}: {
  readonly active: boolean;
  readonly actorRenderer: ActorRenderer | null;
  readonly document: EditorDocument | null;
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

  useEffect(() => {
    if (!active || !document || !viewer || !weather || !timeOfDay) return;
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
  }, [active, actorRenderer, document, lighting, quality, sceneTime, timeOfDay, viewer, weather, weatherControls]);

  return null;
}
