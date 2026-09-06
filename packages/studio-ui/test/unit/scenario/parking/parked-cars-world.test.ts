import { describe, expect, it } from "vitest";

import { buildSumoAuthoredOccupancies } from "@simforge-oss/engine";

import { planParkedCars } from "../../../../src/lib/scenario/parking/fill";
import {
  PARKED_CARS_LAYER,
  parkedCarOccupancySources,
  parkedCarViews,
} from "../../../../src/lib/scenario/parking/useParkedCars";
import type { ParkingStall } from "../../../../src/lib/scenario/parking/stalls";

/** One stall on the x axis at z, long axis pointing east. */
function stall(id: string, x: number, z: number): ParkingStall {
  return {
    id,
    x,
    z,
    y: 2.5,
    headingRad: 0,
    lengthM: 5,
    widthM: 2.6,
    facingKnown: true,
  };
}

const plan = planParkedCars({
  stalls: [stall("a", 0, 0), stall("b", 6, 0), stall("c", 12, -40)],
  occupancy: 1,
  seed: "parked-1",
  facing: "nose_in",
});

describe("parkedCarViews", () => {
  it("draws in the parked layer, never the editor layer", () => {
    // The layer name is the whole isolation guarantee: EditorController owns
    // `editor`, and a parked car must never become a selectable role.
    expect(PARKED_CARS_LAYER).toBe("parked-cars");
    expect(PARKED_CARS_LAYER).not.toBe("editor");
  });

  it("prefers the sampled scene surface over the stall's own elevation", () => {
    const views = parkedCarViews(plan.cars, () => 7.25);

    expect(views).toHaveLength(3);
    for (const view of views) expect(view.y).toBe(7.25);
  });

  it("falls back to the stall elevation when the surface cannot be sampled", () => {
    const views = parkedCarViews(plan.cars, () => null);

    for (const view of views) expect(view.y).toBe(2.5);
  });

  it("carries the car's own dimensions so the instance matches the model", () => {
    const view = parkedCarViews(plan.cars, null)[0]!;
    const car = plan.cars.find((candidate) => candidate.id === view.id)!;

    expect(view.dims).toEqual({ l: car.lengthM, w: car.widthM, h: car.heightM });
    expect(view.headingRad).toBe(car.headingRad);
  });
});

describe("parkedCarOccupancySources", () => {
  it("reports every parked car as stationary and present", () => {
    const sources = parkedCarOccupancySources(plan.cars);

    expect(sources).toHaveLength(plan.cars.length);
    for (const source of sources) {
      expect(source.speedMps).toBe(0);
      expect(source.static).toBe(true);
      expect(source.present).toBe(true);
    }
  });

  it("is reported to SUMO only where the footprint touches a driveable lane", () => {
    // A lane down z = 0 covers the cars at (0,0) and (6,0); the car at
    // (12,-40) is an off-street lot stall and must not be handed to moveToXY.
    const occupancies = buildSumoAuthoredOccupancies(parkedCarOccupancySources(plan.cars), {
      segments: [{ ax: -20, az: 0, bx: 20, bz: 0, halfWidthM: 2 }],
    });

    const ids = occupancies.map((occupancy) => occupancy.id);
    expect(ids).toContain("parked:a");
    expect(ids).toContain("parked:b");
    expect(ids).not.toContain("parked:c");
  });

  it("hands SUMO nothing when parked cars are off", () => {
    const empty = planParkedCars({
      stalls: [stall("a", 0, 0)],
      occupancy: 0,
      seed: "parked-1",
      facing: "nose_in",
    });

    expect(parkedCarOccupancySources(empty.cars)).toEqual([]);
  });
});
