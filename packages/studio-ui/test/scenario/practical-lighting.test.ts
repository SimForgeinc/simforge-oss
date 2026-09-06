import type { Environment } from "@simforge-oss/scenario";
import { describe, expect, it } from "vitest";
import { resolvePracticalLighting } from "../../src/scenario/editor/practical-lighting";
import { SCENE_TIME_EXTENSION_KEY } from "../../src/scenario/editor/scene-time";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    weather: "clear",
    timeOfDay: "noon",
    surfacePatches: [],
    ...overrides,
  } as Environment;
}

describe("practical lighting policy", () => {
  it("lights streets and vehicles for the lit-night preset", () => {
    expect(resolvePracticalLighting(environment({ timeOfDay: "night_lit" }))).toEqual({
      streetLights: true,
      vehicleHeadlights: true,
      reason: "night-lit-preset",
    });
  });

  it("keeps the deliberately unlit night map dark while vehicles use low beams", () => {
    expect(resolvePracticalLighting(environment({ timeOfDay: "night" }))).toEqual({
      streetLights: false,
      vehicleHeadlights: true,
      reason: "night-preset",
    });
  });

  it.each([
    [5 * 60 + 59, true],
    [6 * 60, false],
    [18 * 60 + 59, false],
    [19 * 60, true],
  ])("uses the authored clock boundary at minute %s", (minutes, expected) => {
    const decision = resolvePracticalLighting(environment({
      extensions: { [SCENE_TIME_EXTENSION_KEY]: { minutes } },
    }));
    expect(decision.streetLights).toBe(expected);
    expect(decision.vehicleHeadlights).toBe(expected);
  });

  it("honours an explicitly dark sun for a non-night preset", () => {
    expect(resolvePracticalLighting(environment({ timeOfDay: "dusk", sunElevationDeg: -4 })))
      .toEqual({
        streetLights: true,
        vehicleHeadlights: true,
        reason: "sun-below-threshold",
      });
  });
});
