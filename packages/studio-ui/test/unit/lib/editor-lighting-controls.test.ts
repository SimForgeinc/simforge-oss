import { describe, expect, it } from "vitest";
import type { Environment } from "@simforge-oss/scenario";
import {
  LIGHTING_EXTENSION_KEY,
  LIGHTING_SCALE_REVISION,
  LIGHTING_RANGES,
  editorLightingSignature,
  resolveEditorLightingOverrides,
  usesPresetLighting,
  withEditorLightingOverrides,
} from "@simforge-oss/scenario/contracts";
import { resolveEditorSceneEnvironment } from "../../../src/scenario/editor/scene-environment";

const SCENE_TIME_KEY = "org.simforge.sceneTime.v1";

function environmentOf(extensions?: Environment["extensions"]): Environment {
  return {
    weather: "clear",
    timeOfDay: "noon",
    surfacePatches: [],
    ...(extensions ? { extensions } : {}),
  } as Environment;
}

describe("authored lighting overrides", () => {
  it("carries nothing until an author takes control", () => {
    const environment = environmentOf();
    expect(usesPresetLighting(environment)).toBe(true);
    expect(resolveEditorLightingOverrides(environment)).toEqual({});
  });

  it("round-trips an authored value", () => {
    const next = withEditorLightingOverrides(environmentOf(), { ambient: 1.8 });
    expect(resolveEditorLightingOverrides(next)).toEqual({ ambient: 1.8 });
    expect(usesPresetLighting(next)).toBe(false);
  });

  it("clamps a value written outside its range", () => {
    const high = withEditorLightingOverrides(environmentOf(), { ambient: 99 });
    expect(resolveEditorLightingOverrides(high).ambient).toBe(LIGHTING_RANGES.ambient.max);
    const low = withEditorLightingOverrides(environmentOf(), { exposure: -5 });
    expect(resolveEditorLightingOverrides(low).exposure).toBe(LIGHTING_RANGES.exposure.min);
  });


  it("drops a non-finite stored value instead of clamping it to black", () => {
    // NaN is a broken write, not a request for zero ambient.
    const environment = environmentOf({
      [LIGHTING_EXTENSION_KEY]: {
        ambient: Number.NaN,
        sun: 2,
        scaleRevision: LIGHTING_SCALE_REVISION,
      },
    });
    expect(resolveEditorLightingOverrides(environment)).toEqual({ sun: 2 });
  });

  it("survives a garbage extension value", () => {
    for (const stored of ["nonsense", 7, null, []]) {
      const environment = environmentOf({ [LIGHTING_EXTENSION_KEY]: stored });
      expect(resolveEditorLightingOverrides(environment)).toEqual({});
    }
  });

  it("clearing the last override removes the block rather than leaving noise", () => {
    const authored = withEditorLightingOverrides(environmentOf(), { ambient: 2 });
    const cleared = withEditorLightingOverrides(authored, { ambient: undefined });
    expect(cleared.extensions?.[LIGHTING_EXTENSION_KEY]).toBeUndefined();
    expect(usesPresetLighting(cleared)).toBe(true);
  });

  it("never disturbs an unrelated extension or an execution field", () => {
    const environment = environmentOf({ [SCENE_TIME_KEY]: { minutes: 610 } });
    const authored = withEditorLightingOverrides(environment, { sun: 0.5 });
    expect(authored.extensions?.[SCENE_TIME_KEY]).toEqual({ minutes: 610 });
    expect(authored.weather).toBe("clear");
    expect(authored.timeOfDay).toBe("noon");

    const cleared = withEditorLightingOverrides(authored, { sun: undefined });
    expect(cleared.extensions?.[SCENE_TIME_KEY]).toEqual({ minutes: 610 });
  });

  it("changes its signature only when a value changes", () => {
    const base = environmentOf();
    const authored = withEditorLightingOverrides(base, { haze: 0.4 });
    expect(editorLightingSignature(authored)).not.toBe(editorLightingSignature(base));
    expect(editorLightingSignature(authored)).toBe(
      editorLightingSignature(withEditorLightingOverrides(base, { haze: 0.4 })),
    );
  });
});

describe("overrides reaching the renderer", () => {
  it("scales the preset rather than replacing it", () => {
    const preset = resolveEditorSceneEnvironment(environmentOf());
    const authored = resolveEditorSceneEnvironment(
      withEditorLightingOverrides(environmentOf(), { ambient: 2, sun: 0.5, exposure: 1.5, sky: 0.25 }),
    );
    expect(authored.environmentIntensityScale).toBeCloseTo(preset.environmentIntensityScale * 2, 6);
    expect(authored.sunIntensityScale).toBeCloseTo(preset.sunIntensityScale * 0.5, 6);
    expect(authored.exposureScale).toBeCloseTo(preset.exposureScale * 1.5, 6);
    expect(authored.backgroundIntensityScale).toBeCloseTo(preset.backgroundIntensityScale * 0.25, 6);
  });

  it("leaves every value untouched when nothing is authored", () => {
    const environment = environmentOf();
    expect(resolveEditorSceneEnvironment(environment)).toEqual(
      resolveEditorSceneEnvironment(withEditorLightingOverrides(environment, {})),
    );
  });


  it("warms and cools the sun away from the preset tint", () => {
    const preset = resolveEditorSceneEnvironment(environmentOf()).sunColor;
    const warm = resolveEditorSceneEnvironment(
      withEditorLightingOverrides(environmentOf(), { sunWarmth: 1 }),
    ).sunColor;
    const cool = resolveEditorSceneEnvironment(
      withEditorLightingOverrides(environmentOf(), { sunWarmth: -1 }),
    ).sunColor;
    const blueness = (hex: number) => (hex & 0xff) - ((hex >> 16) & 0xff);
    expect(blueness(warm)).toBeLessThan(blueness(preset));
    expect(blueness(cool)).toBeGreaterThan(blueness(preset));
  });

  it("keeps a neutral warmth identical to the preset tint", () => {
    const preset = resolveEditorSceneEnvironment(environmentOf()).sunColor;
    const neutral = resolveEditorSceneEnvironment(
      withEditorLightingOverrides(environmentOf(), { sunWarmth: 0 }),
    ).sunColor;
    expect(neutral).toBe(preset);
  });
});
