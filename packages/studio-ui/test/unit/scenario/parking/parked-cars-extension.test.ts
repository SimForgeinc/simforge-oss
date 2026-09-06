import { describe, expect, it } from "vitest";


import {
  DEFAULT_PARKED_CARS_SETTINGS,
  PARKED_CARS_EXTENSION_KEY,
  nextParkedCarsSeed,
  parkedCarsFromExtensions,
} from "../../../../src/lib/scenario/parking/extension";
import { MAX_PARKED_CARS, planParkedCars } from "../../../../src/lib/scenario/parking/fill";
import type { ParkingStall } from "../../../../src/lib/scenario/parking/stalls";

describe("parkedCarsFromExtensions", () => {
  it("defaults to off, so an existing scenario gains nothing until asked", () => {
    expect(parkedCarsFromExtensions(undefined)).toEqual(DEFAULT_PARKED_CARS_SETTINGS);
    expect(parkedCarsFromExtensions({})).toEqual(DEFAULT_PARKED_CARS_SETTINGS);
    expect(DEFAULT_PARKED_CARS_SETTINGS.enabled).toBe(false);
  });

  it("defaults to every parkable model, because the CARLA filter empties stalls for nothing", () => {
    // Filtering to native blueprints left 78 of Belmont's 859 stalls visibly
    // empty to protect a render the cars only reach once baked.
    expect(DEFAULT_PARKED_CARS_SETTINGS.models).toBe("any");
  });

  it("starts with nothing baked, so the generator is a preview until asked", () => {
    expect(DEFAULT_PARKED_CARS_SETTINGS.baked).toEqual([]);
  });

  it("round-trips stored settings", () => {
    const stored = {
      [PARKED_CARS_EXTENSION_KEY]: {
        enabled: true,
        occupancy: 0.35,
        seed: "parked-9",
        facing: "mixed",
        models: "any",
      },
    };

    expect(parkedCarsFromExtensions(stored)).toEqual({
      enabled: true,
      occupancy: 0.35,
      seed: "parked-9",
      facing: "mixed",
      models: "any",
      baked: [],
    });
  });

  it("degrades a malformed extension to defaults instead of breaking the editor", () => {
    // The extension bag is untyped by design, so a hand-edited document is a
    // supported input.
    expect(parkedCarsFromExtensions({ [PARKED_CARS_EXTENSION_KEY]: "nonsense" })).toEqual(
      DEFAULT_PARKED_CARS_SETTINGS,
    );
    expect(
      parkedCarsFromExtensions({
        [PARKED_CARS_EXTENSION_KEY]: { enabled: true, occupancy: "loads", seed: "  ", facing: 7 },
      }),
    ).toEqual({
      enabled: true,
      occupancy: DEFAULT_PARKED_CARS_SETTINGS.occupancy,
      seed: DEFAULT_PARKED_CARS_SETTINGS.seed,
      facing: "nose_in",
      models: "any",
      baked: [],
    });
  });

  it("clamps a stored occupancy into range", () => {
    expect(
      parkedCarsFromExtensions({ [PARKED_CARS_EXTENSION_KEY]: { occupancy: 12 } }).occupancy,
    ).toBe(1);
    expect(
      parkedCarsFromExtensions({ [PARKED_CARS_EXTENSION_KEY]: { occupancy: -3 } }).occupancy,
    ).toBe(0);
  });
});

describe("nextParkedCarsSeed", () => {
  it("advances the counter and recovers from a hand-typed seed", () => {
    expect(nextParkedCarsSeed("parked-1")).toBe("parked-2");
    expect(nextParkedCarsSeed("parked-41")).toBe("parked-42");
    expect(nextParkedCarsSeed("whatever")).toBe("parked-1");
  });
});

describe("large parking plans", () => {
  it("keeps generated parking independent from authored participants", () => {
    const stalls: ParkingStall[] = Array.from({ length: 200 }, (_unused, index) => ({
      id: `stall-${String(index).padStart(3, "0")}`,
      x: index * 3,
      z: 0,
      y: 0,
      headingRad: 0,
      lengthM: 5,
      widthM: 2.6,
      facingKnown: true,
    }));
    const plan = planParkedCars({
      stalls,
      occupancy: 1,
      seed: "parked-1",
      facing: "nose_in",
    });

    expect(plan.cars.length).toBe(200);
    expect(plan.cars.length).toBeLessThanOrEqual(MAX_PARKED_CARS);
  });
});
