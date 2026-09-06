import { describe, expect, it } from "vitest";
import type { Environment } from "../schema/v2/environment.js";
import {
  DEFAULT_AMBIENT_RENDER_SCALE,
  DEFAULT_SUN_RENDER_SCALE,
  DEFAULT_VISIBILITY_M,
  FRESH_SCENARIO_MINUTES,
  LIGHTING_EXTENSION_KEY,
  LIGHTING_SCALE_REVISION,
  resolveEditorLightingOverrides,
  resolveEditorLightingRenderScales,
  withEditorLightingOverrides,
  withFreshEditorEnvironmentDefaults,
} from "../studio-contracts/editor-environment-policy.js";

const BASE_ENVIRONMENT: Environment = {
  weather: "clear",
  timeOfDay: "noon",
  surfacePatches: [],
};

describe("editor environment policy", () => {
  it("defines the requested fresh authoring defaults", () => {
    const fresh = withFreshEditorEnvironmentDefaults(BASE_ENVIRONMENT);

    expect(FRESH_SCENARIO_MINUTES).toBe(385);
    expect(fresh.weather).toBe("clear");
    expect(resolveEditorLightingOverrides(fresh)).toEqual({
      ambient: 1,
      sun: 1,
      visibilityM: 80_000,
    });
    expect(fresh.extensions?.[LIGHTING_EXTENSION_KEY]).toMatchObject({
      ambient: 1,
      sun: 1,
      visibilityM: DEFAULT_VISIBILITY_M,
      scaleRevision: LIGHTING_SCALE_REVISION,
    });
  });

  it("applies the 80 km visibility default on initial resolution", () => {
    expect(resolveEditorLightingRenderScales(BASE_ENVIRONMENT)).toMatchObject({
      ambient: DEFAULT_AMBIENT_RENDER_SCALE,
      sun: DEFAULT_SUN_RENDER_SCALE,
      visibilityM: DEFAULT_VISIBILITY_M,
    });
  });

  it("converts normalized authored values into the calibrated render multipliers", () => {
    const authored = withEditorLightingOverrides(BASE_ENVIRONMENT, {
      ambient: 1.5,
      sun: 0.5,
      visibilityM: 340,
    });
    expect(authored.extensions?.[LIGHTING_EXTENSION_KEY]).toEqual({
      ambient: 1.5,
      sun: 0.5,
      visibilityM: 340,
      scaleRevision: LIGHTING_SCALE_REVISION,
    });
    expect(resolveEditorLightingRenderScales(authored)).toMatchObject({
      ambient: 1.5 * DEFAULT_AMBIENT_RENDER_SCALE,
      sun: 0.5 * DEFAULT_SUN_RENDER_SCALE,
      visibilityM: 340,
    });
  });

  it("reads a block without the current scale marker as preset lighting", () => {
    const unmarked: Environment = {
      ...BASE_ENVIRONMENT,
      extensions: {
        [LIGHTING_EXTENSION_KEY]: { ambient: 0.8, sun: 3, visibilityM: 340 },
      },
    };
    expect(resolveEditorLightingOverrides(unmarked)).toEqual({});
    expect(resolveEditorLightingRenderScales(unmarked)).toMatchObject({
      ambient: DEFAULT_AMBIENT_RENDER_SCALE,
      sun: DEFAULT_SUN_RENDER_SCALE,
      visibilityM: DEFAULT_VISIBILITY_M,
    });
  });
});
