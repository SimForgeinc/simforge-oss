import { describe, expect, it } from "vitest";
import type { Environment } from "@simforge-oss/scenario";
import { FRESH_SCENARIO_MINUTES } from "@simforge-oss/scenario/contracts";
import {
  SCENE_TIME_EXTENSION_KEY,
  formatSceneTime,
  localSceneMinutes,
  resolveExactSceneMinutes,
  resolveSceneSliderMinutes,
  sunAnglesForSceneMinutes,
  timeOfDayForSceneMinutes,
  withSceneMinutes,
} from "../../src/scenario/editor/scene-time";

describe("SimForge scene clock", () => {
  const environment = {
    weather: "clear",
    timeOfDay: "noon",
    surfacePatches: [],
    extensions: { "org.example.keep": { enabled: true } },
  } as Environment;

  it("reads the user's local browser clock", () => {
    expect(localSceneMinutes(new Date(2026, 7, 10, 16, 37))).toBe(16 * 60 + 37);
  });

  it("defines the fresh scenario clock as exact 06:25 with matching sun angles", () => {
    expect(FRESH_SCENARIO_MINUTES).toBe(385);
    expect(withSceneMinutes(environment, FRESH_SCENARIO_MINUTES)).toMatchObject({
      timeOfDay: "dawn",
      sunAzimuthDeg: 96.25,
      sunElevationDeg: 7.08,
      extensions: {
        [SCENE_TIME_EXTENSION_KEY]: { minutes: 385 },
      },
    });
  });

  it("stores an exact time with matching portable preset and sun angles", () => {
    const next = withSceneMinutes(environment, 18 * 60 + 30);

    expect(next).toMatchObject({
      timeOfDay: "dusk",
      sunAzimuthDeg: 277.5,
      extensions: {
        "org.example.keep": { enabled: true },
        [SCENE_TIME_EXTENSION_KEY]: { minutes: 18 * 60 + 30 },
      },
    });
    expect(next.sunElevationDeg).toBeLessThan(0);
    expect(resolveExactSceneMinutes(next)).toBe(18 * 60 + 30);
  });

  it("keeps legacy presets usable and formats slider values", () => {
    expect(resolveExactSceneMinutes(environment)).toBeNull();
    expect(resolveSceneSliderMinutes(environment)).toBe(12 * 60);
    expect(formatSceneTime(0)).toBe("12:00 AM");
    expect(formatSceneTime(13 * 60 + 5)).toBe("1:05 PM");
  });

  it("maps the full clock to scene presets and continuous sun angles", () => {
    expect(timeOfDayForSceneMinutes(6 * 60 + 30)).toBe("dawn");
    expect(timeOfDayForSceneMinutes(12 * 60)).toBe("noon");
    expect(timeOfDayForSceneMinutes(22 * 60)).toBe("night_lit");
    expect(sunAnglesForSceneMinutes(6 * 60)).toEqual({ azimuthDeg: 90, elevationDeg: 0 });
    expect(sunAnglesForSceneMinutes(12 * 60)).toEqual({ azimuthDeg: 180, elevationDeg: 65 });
  });
});
