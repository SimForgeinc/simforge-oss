import { describe, expect, it } from "vitest";

import { PARKABLE_MODELS, planParkedCars } from "../../../../src/lib/scenario/parking/fill";
import type { ParkingStall } from "../../../../src/lib/scenario/parking/stalls";

function stalls(count: number, overrides: Partial<ParkingStall> = {}): ParkingStall[] {
  return Array.from({ length: count }, (_unused, index) => ({
    // Zero-padded so id order matches index order; the planner sorts by id.
    id: `stall-${String(index).padStart(3, "0")}`,
    x: index * 3,
    z: 0,
    y: 0,
    headingRad: 0,
    lengthM: 5,
    widthM: 2.6,
    facingKnown: true,
    ...overrides,
  }));
}

const base = {
  occupancy: 1,
  seed: "parked-1",
  facing: "nose_in" as const,
};

describe("PARKABLE_MODELS", () => {
  it("is the catalog's own parkable vehicles, not a second hand-kept list", () => {
    expect(PARKABLE_MODELS.length).toBeGreaterThan(5);
    expect(PARKABLE_MODELS.map((model) => model.catalogId)).toContain("vehicle.sedan");
    // A car cover is scenery an author places, not something a scatter invents.
    expect(PARKABLE_MODELS.map((model) => model.catalogId)).not.toContain("occluder.covered_car");
  });
});

describe("planParkedCars", () => {
  it("is deterministic for one seed", () => {
    const input = { ...base, stalls: stalls(40), occupancy: 0.5 };

    const first = planParkedCars(input);
    const second = planParkedCars(input);

    expect(first.cars).toEqual(second.cars);
    expect(first.cars.length).toBeGreaterThan(0);
  });

  it("gives a different scatter for a different seed", () => {
    const first = planParkedCars({ ...base, stalls: stalls(40), occupancy: 0.5 });
    const second = planParkedCars({
      ...base,
      stalls: stalls(40),
      occupancy: 0.5,
      seed: "parked-2",
    });

    expect(first.cars.map((car) => car.stallId)).not.toEqual(
      second.cars.map((car) => car.stallId),
    );
  });

  it("does not depend on the order stalls arrive in", () => {
    const ordered = stalls(30);
    const shuffled = [...ordered].reverse();

    expect(planParkedCars({ ...base, stalls: shuffled, occupancy: 0.5 }).cars).toEqual(
      planParkedCars({ ...base, stalls: ordered, occupancy: 0.5 }).cars,
    );
  });

  it("fills the requested fraction of eligible stalls", () => {
    const plan = planParkedCars({ ...base, stalls: stalls(100), occupancy: 0.6 });

    expect(plan.eligibleStallCount).toBe(100);
    expect(plan.cars).toHaveLength(60);
  });

  it("places nothing at zero occupancy and every stall at full", () => {
    expect(planParkedCars({ ...base, stalls: stalls(10), occupancy: 0 }).cars).toHaveLength(0);
    expect(planParkedCars({ ...base, stalls: stalls(10), occupancy: 1 }).cars).toHaveLength(10);
  });

  it("clamps a nonsense occupancy instead of throwing", () => {
    expect(planParkedCars({ ...base, stalls: stalls(10), occupancy: 4 }).cars).toHaveLength(10);
    expect(planParkedCars({ ...base, stalls: stalls(10), occupancy: -1 }).cars).toHaveLength(0);
  });

  it("never places a car that does not fit inside its box", () => {
    const plan = planParkedCars({ ...base, stalls: stalls(200) });

    expect(plan.cars.length).toBeGreaterThan(0);
    for (const car of plan.cars) {
      expect(car.lengthM).toBeLessThanOrEqual(5);
      expect(car.widthM).toBeLessThanOrEqual(2.6);
    }
  });

  it("reports stalls no model fits rather than overhanging them", () => {
    const plan = planParkedCars({
      ...base,
      stalls: stalls(10, { lengthM: 1.5, widthM: 1 }),
    });

    expect(plan.cars).toHaveLength(0);
    expect(plan.eligibleStallCount).toBe(0);
    expect(plan.unfittableStallCount).toBe(10);
  });

  it("leaves a stall empty when an authored actor covers it", () => {
    const plan = planParkedCars({
      ...base,
      stalls: stalls(10),
      // stall-003 sits at x = 9.
      exclusions: [{ x: 9, z: 0, radiusM: 2 }],
    });

    expect(plan.excludedStallCount).toBe(1);
    expect(plan.eligibleStallCount).toBe(9);
    expect(plan.cars.map((car) => car.stallId)).not.toContain("stall-003");
  });

  it("honours a narrowed model pool", () => {
    const plan = planParkedCars({
      ...base,
      stalls: stalls(20),
      allowModel: (catalogId) => catalogId === "vehicle.sedan",
    });

    expect(plan.cars).toHaveLength(20);
    expect(new Set(plan.cars.map((car) => car.catalogId))).toEqual(new Set(["vehicle.sedan"]));
  });

  it("reports no eligible stalls when the pool excludes everything", () => {
    const plan = planParkedCars({ ...base, stalls: stalls(10), allowModel: () => false });

    expect(plan.cars).toHaveLength(0);
    expect(plan.unfittableStallCount).toBe(10);
  });

  it("parks nose-in along the stall heading", () => {
    const plan = planParkedCars({
      ...base,
      stalls: stalls(4, { headingRad: 1.25 }),
    });

    for (const car of plan.cars) expect(car.headingRad).toBeCloseTo(1.25, 6);
  });

  it("turns some cars around when facing is mixed", () => {
    const plan = planParkedCars({
      ...base,
      stalls: stalls(60, { headingRad: 0 }),
      facing: "mixed",
    });

    const headings = new Set(plan.cars.map((car) => Math.round(car.headingRad * 100)));
    expect(headings.size).toBe(2);
  });

  it("keeps the car on its stall centre", () => {
    const plan = planParkedCars({ ...base, stalls: stalls(5, { z: -12, y: 3.5 }) });

    for (const car of plan.cars) {
      expect(car.z).toBe(-12);
      expect(car.y).toBe(3.5);
    }
  });
});
