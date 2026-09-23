import type { CityViewerOptions } from "@simforge-oss/viewer";
import type { ScenarioAuthoringQuality } from "../../lib/scenario/contracts";
import { readRenderingPreference, renderingPreferenceQuality, type RenderingPreference } from "../../components/rendering-preference";
import { loadViewportSettings, viewportVegetationVisible } from "./regions/slots/viewport-settings";

const MB = 1024 * 1024;

export function defaultAuthoringQuality(): ScenarioAuthoringQuality {
  return renderingPreferenceQuality(readRenderingPreference());
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
    // Vegetation cells carry geometry-derivative levels whose geometric error
    // is in metres (docs/engineering/map-geometry-lod.md); this is the largest
    // projected error, in device pixels, a level may show. 1 px is the native
    // renderer's image-gate setting; each tier below trades a little of that.
    vegetationScreenSpaceError: 2,
    uploadBudgetMs: 5,
    uploadPixelsPerFrame: 4.2e6,
    vegetationMaxDistance: 340,
    exposure: 1,
  },
} as const;

export const AUTHORING_QUALITY = {
  low: {
    ...BROWSER_SCENE_QUALITY,
    live: { ...BROWSER_SCENE_QUALITY.live, byteBudget: 640 * MB, vegetationScreenSpaceError: 4 },
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
  preference: RenderingPreference,
  extra?: CityViewerOptions,
): CityViewerOptions {
  const quality = renderingPreferenceQuality(preference);
  const preset = AUTHORING_QUALITY[quality];
  return {
    maxPixelRatio: preset.maxPixelRatio,
    antialias: preset.antialias,
    cinematicLighting: preset.cinematicLighting,
    byteBudget: preset.live.byteBudget,
    vegetationMaxDistance: preset.live.vegetationMaxDistance,
    ...extra,
    vegetation: preference !== "low-no-foliage" && viewportVegetationVisible(loadViewportSettings()),
    mapTextureTier: quality,
  };
}
