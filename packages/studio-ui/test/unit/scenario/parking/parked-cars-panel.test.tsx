// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ParkedCarsPanel } from "../../../../src/lib/scenario/parking/ParkedCarsPanel";
import {
  DEFAULT_PARKED_CARS_SETTINGS,
  type ParkedCarsSettings,
} from "../../../../src/lib/scenario/parking/extension";
import { MAX_PARKED_CARS, planParkedCars } from "../../../../src/lib/scenario/parking/fill";
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

function panel(overrides: Partial<ParkedCarsSettings> = {}, stallCount = 30) {
  const settings: ParkedCarsSettings = {
    ...DEFAULT_PARKED_CARS_SETTINGS,
    enabled: true,
    ...overrides,
  };
  const plan = planParkedCars({
    stalls: stalls(stallCount),
    occupancy: settings.occupancy,
    seed: settings.seed,
    facing: settings.facing,
  });
  const onChange = vi.fn();
  render(
    <ParkedCarsPanel
      bakedCount={settings.baked.length}
      onChange={onChange}
      plan={plan}
      reason={null}
      settings={settings}
      stallCount={stallCount}
      status="ready"
    />,
  );
  return { onChange, plan, settings };
}

afterEach(cleanup);

describe("ParkedCarsPanel", () => {
  it("bakes the planned cars onto the document", () => {
    const { onChange, plan } = panel();

    fireEvent.click(screen.getByTestId("parked-cars-bake"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].baked).toEqual(plan.cars);
    expect(plan.cars.length).toBeGreaterThan(0);
  });

  it("says plainly that an unbaked scene is only a preview", () => {
    panel();

    expect(screen.getByTestId("parked-cars-panel").textContent)
      .toContain("A preview until you bake them");
  });

  it("reports the baked count once committed, not a preview count", () => {
    const cars = planParkedCars({
      stalls: stalls(10),
      occupancy: 1,
      seed: "parked-1",
      facing: "nose_in",
    }).cars;
    panel({ baked: cars });

    expect(screen.getByTestId("parked-cars-panel").textContent).toContain("10 baked in");
    expect(screen.getByTestId("parked-cars-panel").textContent).toContain("export as stationary actors");
  });

  it("offers a way back out of a bake", () => {
    const cars = planParkedCars({
      stalls: stalls(4),
      occupancy: 1,
      seed: "parked-1",
      facing: "nose_in",
    }).cars;
    const { onChange } = panel({ baked: cars });

    fireEvent.click(screen.getByTestId("parked-cars-clear-bake"));

    expect(onChange.mock.calls[0]![0].baked).toEqual([]);
  });

  it("says when the cap cut the scatter back", () => {
    panel({ occupancy: 1 }, MAX_PARKED_CARS + 80);

    expect(screen.getByTestId("parked-cars-capped").textContent)
      .toContain(String(MAX_PARKED_CARS));
  });

  it("stays quiet about the cap when nothing was cut", () => {
    panel({ occupancy: 1 }, 20);

    expect(screen.queryByTestId("parked-cars-capped")).toBeNull();
  });
});
