import type { Environment } from "@simforge-oss/scenario";
import { resolveExactSceneMinutes } from "./scene-time";

const STREET_LIGHTS_ON_MINUTE = 19 * 60;
const STREET_LIGHTS_OFF_MINUTE = 6 * 60;
const DARK_SUN_ELEVATION_DEG = -4;

export type PracticalLightingReason =
  | "clock-dark"
  | "night-lit-preset"
  | "night-preset"
  | "sun-below-threshold"
  | "daylight";

export interface PracticalLightingDecision {
  readonly streetLights: boolean;
  readonly vehicleHeadlights: boolean;
  readonly reason: PracticalLightingReason;
}

/**
 * Deterministic practical-light policy derived only from authored environment.
 *
 * `night` remains a deliberately unlit map preset, while vehicles still use
 * low beams. `night_lit` enables both. An exact scene clock behaves like a real
 * automatic timer, and an explicitly authored sun below civil twilight wins
 * for every non-night preset.
 */
export function resolvePracticalLighting(environment: Environment): PracticalLightingDecision {
  const exactMinutes = resolveExactSceneMinutes(environment);
  if (exactMinutes !== null) {
    const dark = exactMinutes >= STREET_LIGHTS_ON_MINUTE
      || exactMinutes < STREET_LIGHTS_OFF_MINUTE;
    return {
      streetLights: dark,
      vehicleHeadlights: dark,
      reason: dark ? "clock-dark" : "daylight",
    };
  }
  if (environment.timeOfDay === "night_lit") {
    return { streetLights: true, vehicleHeadlights: true, reason: "night-lit-preset" };
  }
  if (environment.timeOfDay === "night") {
    return { streetLights: false, vehicleHeadlights: true, reason: "night-preset" };
  }
  if (
    typeof environment.sunElevationDeg === "number"
    && environment.sunElevationDeg <= DARK_SUN_ELEVATION_DEG
  ) {
    return {
      streetLights: true,
      vehicleHeadlights: true,
      reason: "sun-below-threshold",
    };
  }
  return { streetLights: false, vehicleHeadlights: false, reason: "daylight" };
}
