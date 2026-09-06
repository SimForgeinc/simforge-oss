import { describe, expect, it } from "vitest";
import {
  buildStreetTour,
  cameraLookDelta,
  droneTransferCameraView,
  streetTourCameraView,
  withCameraLookOffset,
  type StreetTourGraph,
} from "../../../../src/scenario/scene/idle-street-tour";

function straightStreetGraph(): StreetTourGraph {
  const lanes = new Map([
    [
      "a",
      {
        lengthM: 100,
        lane: { laneType: "driving", isJunction: false },
        originX: 0,
      },
    ],
    [
      "b",
      {
        lengthM: 80,
        lane: { laneType: "driving", isJunction: false },
        originX: 100,
      },
    ],
  ]);
  return {
    laneIds: [...lanes.keys()],
    laneJson: (rsl) => JSON.stringify({ rsl, ...lanes.get(rsl)!.lane }),
    laneLengthM: (rsl) => lanes.get(rsl)!.lengthM,
    nominalReversed: () => false,
    successors: (rsl) => (rsl === "a" ? [["b", false]] : []),
    sampleLane: (rsl, distance) => Float64Array.of(lanes.get(rsl)!.originX + distance, 0, 0),
  };
}

describe("idle street tour", () => {
  it("walks connected driving lanes and starts inside the first street", () => {
    const tour = buildStreetTour(straightStreetGraph(), () => 0);

    expect(tour?.legs.map((leg) => leg.rsl)).toEqual(["a", "b"]);
    expect(tour?.legs[0]?.startM).toBe(18);
    expect(tour?.lengthM).toBe(162);
  });

  it("creates a low forward-looking camera pose on the road", () => {
    const tour = buildStreetTour(straightStreetGraph(), () => 0)!;
    const view = streetTourCameraView(tour, 0, () => 2);

    expect(view.position).toEqual([18, 5.8, 0]);
    expect(view.target).toEqual([36, 3.7, 0]);
    expect(view.fov).toBe(58);
  });

  it("does not invent a route when the topology has no driving lanes", () => {
    const graph: StreetTourGraph = {
      laneIds: ["walk"],
      laneJson: () => JSON.stringify({ rsl: "walk", laneType: "sidewalk", isJunction: false }),
      laneLengthM: () => 50,
      nominalReversed: () => false,
      successors: () => [],
      sampleLane: () => Float64Array.of(0, 0, 0),
    };

    expect(buildStreetTour(graph, () => 0)).toBeNull();
  });

  it("adds a smooth cinematic pan without changing the underlying road path", () => {
    const tour = buildStreetTour(straightStreetGraph(), () => 0)!;
    const first = streetTourCameraView(tour, 20, () => 2, 1);
    const next = streetTourCameraView(tour, 20, () => 2, 1.01);

    expect(first.position[0]).toBe(38);
    expect(first.position[2]).not.toBe(0);
    expect(Math.abs(next.position[2] - first.position[2])).toBeLessThan(0.02);
  });

  it("rises like a drone between streets and lands exactly on the destination view", () => {
    const from = { position: [0, 4, 0], target: [18, 2, 0], fov: 57 } as const;
    const to = { position: [100, 5, 40], target: [118, 2, 40], fov: 58 } as const;
    const middle = droneTransferCameraView(from, to, 0.5);

    expect(droneTransferCameraView(from, to, 0)).toEqual(from);
    expect(middle.position[1]).toBeGreaterThan(45);
    expect(droneTransferCameraView(from, to, 1)).toEqual(to);
  });

  it("layers look-around rotation without moving or stopping the traveling camera", () => {
    const base = { position: [10, 5, 20], target: [10, 5, 40], fov: 58 } as const;
    const looked = withCameraLookOffset(base, Math.PI / 2, 0.2);
    const delta = cameraLookDelta(base, looked);

    expect(looked.position).toEqual(base.position);
    expect(delta.yaw).toBeCloseTo(Math.PI / 2);
    expect(delta.pitch).toBeCloseTo(0.2);
  });
});
