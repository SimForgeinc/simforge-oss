import { describe, expect, it } from "vitest";

import { MAX_PARKED_CARS, planParkedCars } from "../../../../src/lib/scenario/parking/fill";
import {
  DEFAULT_PARKED_CARS_SETTINGS,
  PARKED_CARS_EXTENSION_KEY,
  parkedCarsFromExtensions,
} from "../../../../src/lib/scenario/parking/extension";
import type { ParkingStall } from "../../../../src/lib/scenario/parking/stalls";

function stalls(count: number): ParkingStall[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `stall-${String(index).padStart(4, "0")}`,
    x: index * 3,
    z: 0,
    y: 0,
    headingRad: 0,
    lengthM: 5,
    widthM: 2.6,
    facingKnown: true,
  }));
}

const base = { occupancy: 1, seed: "parked-1", facing: "nose_in" as const };

describe("the export budget cap", () => {
  it("never plans more cars than an execution plan can hold", () => {
    const plan = planParkedCars({ ...base, stalls: stalls(900) });

    expect(plan.cars).toHaveLength(MAX_PARKED_CARS);
    // The honest denominator survives the cap, so the panel can say what it cut.
    expect(plan.eligibleStallCount).toBe(900);
    expect(plan.requestedCarCount).toBe(900);
  });

  it("leaves a plan under the cap untouched", () => {
    const plan = planParkedCars({ ...base, stalls: stalls(40) });

    expect(plan.cars).toHaveLength(40);
    expect(plan.requestedCarCount).toBe(40);
  });

  it("caps deterministically, so the preview equals what gets baked", () => {
    const first = planParkedCars({ ...base, stalls: stalls(900) });
    const second = planParkedCars({ ...base, stalls: stalls(900) });

    expect(first.cars).toEqual(second.cars);
  });

  it("still honours a lower occupancy under the cap", () => {
    const plan = planParkedCars({ ...base, stalls: stalls(900), occupancy: 0.05 });

    expect(plan.cars).toHaveLength(45);
    expect(plan.requestedCarCount).toBe(45);
  });
});

describe("baking", () => {
  it("round-trips the planned cars through the extension", () => {
    const plan = planParkedCars({ ...base, stalls: stalls(12) });
    const stored = {
      [PARKED_CARS_EXTENSION_KEY]: {
        ...DEFAULT_PARKED_CARS_SETTINGS,
        enabled: true,
        baked: plan.cars,
      },
    };

    const read = parkedCarsFromExtensions(stored);
    expect(read.baked).toHaveLength(12);
    expect(read.baked.map((car) => car.id)).toEqual(plan.cars.map((car) => car.id));
    // Every field a simulated actor needs must survive the round trip.
    expect(read.baked[0]).toMatchObject({
      id: plan.cars[0]!.id,
      stallId: plan.cars[0]!.stallId,
      catalogId: plan.cars[0]!.catalogId,
      headingRad: plan.cars[0]!.headingRad,
    });
  });

  it("reads nothing baked as nothing baked, not as an error", () => {
    expect(parkedCarsFromExtensions({}).baked).toEqual([]);
    expect(
      parkedCarsFromExtensions({ [PARKED_CARS_EXTENSION_KEY]: { baked: "nope" } }).baked,
    ).toEqual([]);
  });
});
