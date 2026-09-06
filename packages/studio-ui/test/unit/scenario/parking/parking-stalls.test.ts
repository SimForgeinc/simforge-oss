import { describe, expect, it } from "vitest";

import {
  extractParkingStalls,
  stallFromRing,
  type RuntimeProjection,
} from "../../../../src/lib/scenario/parking/stalls";

/**
 * Metres in, metres out. The real projection is proj4 via `MapProjection`; using
 * identity here keeps these assertions about stall geometry and the scene frame
 * rather than about proj4.
 */
const identity: RuntimeProjection = (lng, lat) => ({ x: lng, y: lat });

/** 5 m x 2.5 m stall centred at runtime (10, 20), long axis along +x (east). */
function stallRing(elevation = 0): number[][] {
  return [
    [7.5, 18.75, elevation],
    [12.5, 18.75, elevation],
    [12.5, 21.25, elevation],
    [7.5, 21.25, elevation],
    [7.5, 18.75, elevation],
  ];
}

describe("stallFromRing", () => {
  it("puts the stall centre in the scene frame, mirroring runtime north to -z", () => {
    const stall = stallFromRing("a", stallRing(), null, identity);

    expect(stall).not.toBeNull();
    expect(stall!.x).toBeCloseTo(10, 6);
    // scene z = -runtime y. Getting this backwards would mirror every lot.
    expect(stall!.z).toBeCloseTo(-20, 6);
  });

  it("reads the long axis as car length and the short axis as car width", () => {
    const stall = stallFromRing("a", stallRing(), null, identity)!;

    expect(stall.lengthM).toBeCloseTo(5, 6);
    expect(stall.widthM).toBeCloseTo(2.5, 6);
  });

  it("faces a nose-in car away from the stall mouth", () => {
    // Entry at the east short edge, so the car's nose points west.
    const stall = stallFromRing("a", stallRing(), [12.5, 20, 0], identity)!;

    expect(stall.headingRad).toBeCloseTo(Math.PI, 6);
    expect(stall.facingKnown).toBe(true);
  });

  it("faces the other way when the mouth is on the other short edge", () => {
    const stall = stallFromRing("a", stallRing(), [7.5, 20, 0], identity)!;

    expect(stall.headingRad).toBeCloseTo(0, 6);
  });

  it("keeps the long axis but admits the nose direction is arbitrary without an entry", () => {
    const stall = stallFromRing("a", stallRing(), null, identity)!;

    expect(stall.headingRad % Math.PI).toBeCloseTo(0, 6);
    expect(stall.facingKnown).toBe(false);
  });

  it("takes ground height from the polygon's own vertices", () => {
    const stall = stallFromRing("a", stallRing(2.75), null, identity)!;

    expect(stall.y).toBeCloseTo(2.75, 6);
  });

  it("refuses anything that is not a quad rather than guessing an axis", () => {
    const triangle = [
      [0, 0, 0],
      [4, 0, 0],
      [2, 2, 0],
      [0, 0, 0],
    ];

    expect(stallFromRing("a", triangle, null, identity)).toBeNull();
  });

  it("refuses a stall the projection cannot place", () => {
    expect(stallFromRing("a", stallRing(), null, () => null)).toBeNull();
  });
});

describe("extractParkingStalls", () => {
  const parkingSpace = {
    type: "Feature" as const,
    properties: { Type: "ParkingSpace", Id: "{22615ba1-a995-437f-b5bc-4f7b595a601a}" },
    geometry: { type: "Polygon", coordinates: [stallRing()] },
  };

  it("takes ParkingSpace polygons and ignores every other road-network feature", () => {
    const { stalls } = extractParkingStalls(
      {
        features: [
          parkingSpace,
          { properties: { Type: "Lane" }, geometry: { type: "LineString", coordinates: [] } },
          { properties: { Type: "Junction" }, geometry: { type: "Polygon", coordinates: [stallRing()] } },
        ],
      },
      identity,
    );

    expect(stalls).toHaveLength(1);
    // RoadRunner brace-wraps its GUIDs; the id is used in car ids and seeds.
    expect(stalls[0]!.id).toBe("22615ba1-a995-437f-b5bc-4f7b595a601a");
  });

  it("counts the stalls it could not reduce to a rectangle", () => {
    const { stalls, skipped } = extractParkingStalls(
      {
        features: [
          parkingSpace,
          { properties: { Type: "ParkingSpace", Id: "bad" }, geometry: { type: "Point", coordinates: [0, 0] } },
        ],
      },
      identity,
    );

    expect(stalls).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("survives a payload that is not a feature collection", () => {
    expect(extractParkingStalls(null, identity)).toEqual({ stalls: [], skipped: 0 });
    expect(extractParkingStalls({ features: "nope" }, identity)).toEqual({ stalls: [], skipped: 0 });
  });
});
