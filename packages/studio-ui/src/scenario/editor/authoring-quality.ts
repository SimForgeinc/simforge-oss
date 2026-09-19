import type { CityViewerOptions } from "@simforge-oss/viewer";
import type { ScenarioAuthoringQuality } from "../../lib/scenario/contracts";
import { readRenderingPreference } from "../../components/rendering-preference";

const MB = 1024 * 1024;

export function defaultAuthoringQuality(): ScenarioAuthoringQuality {
  return readRenderingPreference() ?? "medium";
}

/**
 * Streaming budgets per authoring-quality choice.
 *
 * These live outside the surface component because three regions read them: the
 * canvas host (pixel ratio and antialias, which are construction-time viewer
 * options), the `onReady` callback (live quality, fidelity and layer
 * visibility), and the header's quality selector.
 */
// Browser tiers show the same world: sky, lighting, vegetation, geometry and
// viewport quality are shared. Only texture resolution and residency differ.
const BROWSER_SCENE_QUALITY = {
  maxPixelRatio: 2,
  antialias: true,
  vegetation: true,
  cinematicLighting: true,
  live: {
    maxPixelRatio: 2,
    maxScreenSpaceError: 210,
    vegetationScreenSpaceError: 1500,
    uploadBudgetMs: 5,
    uploadPixelsPerFrame: 4.2e6,
    vegetationMaxDistance: 340,
    exposure: 1,
  },
} as const;

export const AUTHORING_QUALITY = {
  low: {
    ...BROWSER_SCENE_QUALITY,
    live: { ...BROWSER_SCENE_QUALITY.live, byteBudget: 640 * MB },
  },
  medium: {
    ...BROWSER_SCENE_QUALITY,
    live: { ...BROWSER_SCENE_QUALITY.live, byteBudget: 1.5 * 1024 * MB },
  },
} as const satisfies Record<ScenarioAuthoringQuality, unknown>;

/**
 * Corner points of every actor's bounding box, for `resetCamera` to fit.
 *
 * Two points per actor (min and max corner) rather than eight: the camera fit
 * only needs the extremes, and an eight-point expansion of a 100-actor scene is
 * 800 allocations per reset.
 */
export function actorFitPoints(
  actors: readonly {
    x: number;
    y: number;
    z: number;
    dims: { l: number; w: number; h: number };
  }[],
) {
  return actors.flatMap((actor) => {
    const halfL = actor.dims.l * 0.5;
    const halfW = actor.dims.w * 0.5;
    return [
      [actor.x - halfL, actor.y, actor.z - halfW] as const,
      [actor.x + halfL, actor.y + actor.dims.h, actor.z + halfW] as const,
    ];
  });
}

/**
 * Construction-time `CityView` options for a quality preset. Every Studio
 * surface that mounts its own viewer builds its options here, so the editor,
 * the drive game and the map viewer are the same renderer configuration;
 * `extra` is for surface-specific asset plumbing (transcoder paths), never
 * for lighting.
 */
export function sceneViewerOptions(
  quality: ScenarioAuthoringQuality,
  extra?: CityViewerOptions,
): CityViewerOptions {
  const preset = AUTHORING_QUALITY[quality];
  return {
    maxPixelRatio: preset.maxPixelRatio,
    antialias: preset.antialias,
    cinematicLighting: preset.cinematicLighting,
    byteBudget: preset.live.byteBudget,
    vegetationMaxDistance: preset.live.vegetationMaxDistance,
    ...extra,
    mapTextureTier: quality,
  };
}
