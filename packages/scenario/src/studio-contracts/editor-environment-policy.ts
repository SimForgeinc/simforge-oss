import { z } from "zod";
import type { Environment } from "../schema/v2/environment.js";

export const SCENE_TIME_EXTENSION_KEY = "org.simforge.sceneTime.v1" as const;
export const LIGHTING_EXTENSION_KEY = "org.simforge.lighting.v1" as const;

/** Canonical clock time for every newly-authored scenario: 6:25 AM. */
export const FRESH_SCENARIO_MINUTES = 6 * 60 + 25;
/**
 * Canonical authored visibility for every newly-authored scenario: the
 * Lookdev Lab's clear-air default. Under the physical atmosphere this is a
 * real Koschmieder range, so 200 m (the pre-rev23 default) is dense fog.
 */
export const DEFAULT_VISIBILITY_M = 80_000;
/** Above this the atmosphere's own ~250 km Rayleigh visibility takes over. */
export const MAX_VISIBILITY_M = 120_000;

/**
 * Authored lighting is stored in the normalized scale where 1 is the calibrated
 * direct-sun / sky-fill level. `scaleRevision` is the schema marker for that
 * scale; a block carrying any other revision is not a current lighting block.
 */
export const LIGHTING_SCALE_REVISION = 2 as const;
export const DEFAULT_SUN_RENDER_SCALE = 3;
export const DEFAULT_AMBIENT_RENDER_SCALE = 0.8;

export const LIGHTING_RANGES = {
  ambient: { min: 0, max: 5, neutral: 1, step: 0.05 },
  sun: { min: 0, max: 4, neutral: 1, step: 0.05 },
  sunWarmth: { min: -1, max: 1, neutral: 0, step: 0.02 },
  exposure: { min: 0.1, max: 3, neutral: 1, step: 0.02 },
  sky: { min: 0, max: 3, neutral: 1, step: 0.05 },
  visibilityM: { min: 20, max: MAX_VISIBILITY_M, neutral: DEFAULT_VISIBILITY_M, step: 10 },
  haze: { min: 0, max: 1, neutral: 0, step: 0.02 },
} as const;

export type LightingField = keyof typeof LIGHTING_RANGES;

export const LIGHTING_FIELDS = [
  "ambient",
  "sun",
  "sunWarmth",
  "exposure",
  "sky",
  "visibilityM",
  "haze",
] as const satisfies readonly LightingField[];

const LightingBlockSchema = z
  .object({
    ambient: z.number().finite().optional().catch(undefined),
    sun: z.number().finite().optional().catch(undefined),
    sunWarmth: z.number().finite().optional().catch(undefined),
    exposure: z.number().finite().optional().catch(undefined),
    sky: z.number().finite().optional().catch(undefined),
    visibilityM: z.number().finite().optional().catch(undefined),
    haze: z.number().finite().optional().catch(undefined),
    scaleRevision: z.literal(LIGHTING_SCALE_REVISION),
  })
  .passthrough();

export type EditorLightingOverrides = Readonly<{
  [Field in LightingField]?: number;
}>;

function clampField(field: LightingField, value: number): number {
  const { min, max } = LIGHTING_RANGES[field];
  return Math.min(max, Math.max(min, value));
}

/**
 * Read authored lighting in the normalized scale. Anything that is not a
 * current-revision block (malformed, or missing the marker) reads as preset
 * lighting; individual non-finite fields are dropped.
 */
export function resolveEditorLightingOverrides(
  environment: Environment,
): EditorLightingOverrides {
  const parsed = LightingBlockSchema.safeParse(
    environment.extensions?.[LIGHTING_EXTENSION_KEY],
  );
  if (!parsed.success) return {};
  const resolved: Partial<Record<LightingField, number>> = {};
  for (const field of LIGHTING_FIELDS) {
    const stored = parsed.data[field];
    if (typeof stored !== "number") continue;
    resolved[field] = clampField(field, stored);
  }
  return resolved;
}

/**
 * Why a render refuses an environment extension block: a renderer that
 * honours authored lighting may not read a malformed block as "no block"
 * (docs/engineering/no-silent-fallbacks.md). The editor keeps its lenient
 * reading above for display; renders use {@link parseRenderLightingOverrides}
 * and {@link parseRenderSceneMinutes}.
 */
export class EnvironmentExtensionError extends Error {
  readonly code = "environment_extension_invalid" as const;
  constructor(readonly extension: string, reason: string) {
    super(`${extension}: ${reason}`);
    this.name = "EnvironmentExtensionError";
  }
}

/**
 * The authored lighting block exactly as a renderer must honour it. Absent
 * reads as preset lighting. Present, it must be a current-revision block
 * (`scaleRevision: 2`) whose fields are known, finite and inside
 * `LIGHTING_RANGES`: an older revision, an unknown field, a non-number or an
 * out-of-range value is refused, never dropped or clamped.
 */
export function parseRenderLightingOverrides(environment: Environment): EditorLightingOverrides {
  const block = environment.extensions?.[LIGHTING_EXTENSION_KEY];
  if (block === undefined) return {};
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new EnvironmentExtensionError(LIGHTING_EXTENSION_KEY, "is not an object");
  }
  const record = block as Record<string, unknown>;
  if (record.scaleRevision !== LIGHTING_SCALE_REVISION) {
    throw new EnvironmentExtensionError(
      LIGHTING_EXTENSION_KEY,
      `scaleRevision ${JSON.stringify(record.scaleRevision)} is not the current lighting scale (${LIGHTING_SCALE_REVISION}); re-save the scenario's lighting`,
    );
  }
  const resolved: Partial<Record<LightingField, number>> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "scaleRevision") continue;
    if (!(LIGHTING_FIELDS as readonly string[]).includes(key)) {
      throw new EnvironmentExtensionError(LIGHTING_EXTENSION_KEY, `unknown field ${key}`);
    }
    const field = key as LightingField;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EnvironmentExtensionError(LIGHTING_EXTENSION_KEY, `${field} is not a finite number`);
    }
    const { min, max } = LIGHTING_RANGES[field];
    if (value < min || value > max) {
      throw new EnvironmentExtensionError(LIGHTING_EXTENSION_KEY, `${field} ${value} is outside [${min}, ${max}]`);
    }
    resolved[field] = value;
  }
  return resolved;
}

/**
 * The exact authored scene clock (`org.simforge.sceneTime.v1`), minutes past
 * midnight in [0, 1440), or `null` when the scenario authored none (the
 * time-of-day preset then decides). A present block without a finite
 * `minutes` is refused.
 */
export function parseRenderSceneMinutes(environment: Environment): number | null {
  const block = environment.extensions?.[SCENE_TIME_EXTENSION_KEY];
  if (block === undefined) return null;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new EnvironmentExtensionError(SCENE_TIME_EXTENSION_KEY, "is not an object");
  }
  const minutes = (block as Record<string, unknown>).minutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
    throw new EnvironmentExtensionError(SCENE_TIME_EXTENSION_KEY, "has no finite minutes");
  }
  return ((minutes % 1440) + 1440) % 1440;
}

/**
 * The sun angles Studio writes beside an exact scene clock
 * (`withSceneMinutes`: a display sinusoid for exports, not an authored sun).
 * A renderer that places the sun from the clock's solar model recognises
 * them by this derivation; any other authored angles are an explicit sun.
 * Must stay equal to studio-ui `sunAnglesForSceneMinutes`.
 */
export function sceneClockSunAngles(minutes: number): { readonly azimuthDeg: number; readonly elevationDeg: number } {
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const daylightProgress = (value - 6 * 60) / (12 * 60);
  const elevationDeg = Math.max(-12, 65 * Math.sin(Math.PI * daylightProgress));
  return {
    azimuthDeg: value / 4,
    elevationDeg: Math.round(elevationDeg * 100) / 100,
  };
}

export type EditorLightingRenderScales = EditorLightingOverrides & Readonly<{
  ambient: number;
  sun: number;
  visibilityM: number;
}>;

/** Resolve normalized authoring values into the renderer's calibrated scale. */
export function resolveEditorLightingRenderScales(
  environment: Environment,
): EditorLightingRenderScales {
  const overrides = resolveEditorLightingOverrides(environment);
  return {
    ...overrides,
    ambient: (overrides.ambient ?? 1) * DEFAULT_AMBIENT_RENDER_SCALE,
    sun: (overrides.sun ?? 1) * DEFAULT_SUN_RENDER_SCALE,
    // The visible slider default is physical state, not a lazy UI placeholder.
    // Applying it here ensures the initial mount and later slider changes agree.
    visibilityM: overrides.visibilityM ?? DEFAULT_VISIBILITY_M,
  };
}

/** Write normalized lighting while retaining unrelated extension data. */
export function withEditorLightingOverrides(
  environment: Environment,
  patch: Readonly<Partial<Record<LightingField, number | undefined>>>,
): Environment {
  const next: Partial<Record<LightingField, number>> = {
    ...resolveEditorLightingOverrides(environment),
  };
  for (const field of LIGHTING_FIELDS) {
    if (!(field in patch)) continue;
    const requested = patch[field];
    if (requested === undefined) {
      delete next[field];
      continue;
    }
    if (!Number.isFinite(requested)) continue;
    next[field] = clampField(field, requested);
  }

  const priorExtensions = environment.extensions ?? {};
  if (Object.keys(next).length === 0) {
    const { [LIGHTING_EXTENSION_KEY]: _dropped, ...rest } = priorExtensions;
    return Object.keys(rest).length === 0
      ? { ...environment, extensions: undefined }
      : { ...environment, extensions: rest };
  }

  return {
    ...environment,
    extensions: {
      ...priorExtensions,
      [LIGHTING_EXTENSION_KEY]: {
        ...next,
        scaleRevision: LIGHTING_SCALE_REVISION,
      },
    },
  };
}

export function usesPresetLighting(environment: Environment): boolean {
  return Object.keys(resolveEditorLightingOverrides(environment)).length === 0;
}

export function editorLightingSignature(environment: Environment): string {
  const overrides = resolveEditorLightingOverrides(environment);
  return LIGHTING_FIELDS
    .map((field) => {
      const value = overrides[field];
      return value === undefined ? "" : value.toFixed(4);
    })
    .join(":");
}

/** Canonical weather for every newly-authored scenario. */
export const FRESH_SCENARIO_WEATHER = "clear" as const;

/**
 * Canonical environment for every newly-authored scenario: clear air at
 * 80 km, neutral sun and ambient — the Lookdev Lab's default look. The
 * clock is set separately (`FRESH_SCENARIO_MINUTES`).
 */
export function withFreshEditorEnvironmentDefaults(environment: Environment): Environment {
  return withEditorLightingOverrides(
    { ...environment, weather: FRESH_SCENARIO_WEATHER },
    {
      ambient: 1,
      sun: 1,
      visibilityM: DEFAULT_VISIBILITY_M,
    },
  );
}
