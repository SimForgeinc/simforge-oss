import { describe, expect, it } from "vitest";

import {
  buildTransferPreview,
  isRoadActorKind,
  laneClass,
  lanePath,
  previewActorKind,
  previewFrame,
  type PreviewActor,
} from "../transfer-preview";
import { chainLanePath, rankCandidates } from "../transfer-rules";

/**
 * The geometry a transfer candidate is shown with, and the rules the server
 * applies between the native compiler and the response. The frames matter:
 * topology lanes are xodr-local (`y` north), compiled actors are scene
 * (`z` = -north), and the preview is drawn in scene metres with `y` down.
 */

const ego: PreviewActor = { id: "ego", kind: "car", x: 0, z: 0, headingRad: 0 };

describe("previewFrame", () => {
  it("centres a 4:3 frame on the subject with room for the road around it", () => {
    const frame = previewFrame([ego], "ego");
    expect(frame.width / frame.height).toBeCloseTo(4 / 3, 2);
    expect(frame.minX + frame.width / 2).toBeCloseTo(0, 0);
    expect(frame.minY + frame.height / 2).toBeCloseTo(0, 0);
    expect(frame.height).toBeGreaterThanOrEqual(64);
  });

  it("fits the actors near the subject and ignores one carried 180 m away", () => {
    const near: PreviewActor = { id: "lead", kind: "car", x: 60, z: 0, headingRad: 0 };
    const far: PreviewActor = { id: "prop", kind: "static_object", x: 180, z: 180, headingRad: 0 };
    const frame = previewFrame([ego, near, far], "ego");
    expect(frame.minX).toBeLessThan(0);
    expect(frame.minX + frame.width).toBeGreaterThan(60);
    expect(frame.minX + frame.width).toBeLessThan(180);
  });
});

describe("lanePath", () => {
  const frame = { minX: -40, minY: -30, width: 80, height: 60 };

  it("flips xodr north into screen south", () => {
    // A lane 10 m north of the origin draws 10 m *up* the screen: y = -10.
    expect(lanePath([{ x: -20, y: 10 }, { x: 20, y: 10 }], frame)).toBe("M-20 -10L20 -10");
  });

  it("keeps a long straight lane that crosses the frame with both ends far outside", () => {
    expect(lanePath([[-500, 0], [500, 0]], frame)).toBe("M-500 0L500 0");
  });

  it("drops a lane that never comes near the frame", () => {
    expect(lanePath([{ x: 300, y: 300 }, { x: 400, y: 300 }], frame)).toBe("");
  });
});

describe("buildTransferPreview", () => {
  it("draws the subject last, in scene coordinates, rotated clockwise on screen", () => {
    const preview = buildTransferPreview({
      lanes: [
        { laneType: "driving", representativeWidthM: 3.4, polyline: [[-100, 0], [100, 0]] },
        { laneType: "sidewalk", representativeWidthM: 2, polyline: [[-100, 6], [100, 6]] },
        { laneType: "border", polyline: [[-100, 9], [100, 9]] },
      ],
      actors: [
        ego,
        { id: "car", kind: "car", x: 10, z: -3.5, headingRad: Math.PI / 2 },
        { id: "ped", kind: "pedestrian", x: 5, z: -6, headingRad: 0 },
      ],
      subjectId: "ego",
      route: [{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 500, z: 0 }],
    });
    expect(preview.actors.map((actor) => `${actor.id}:${actor.kind}`)).toEqual(["car:vehicle", "ped:vru", "ego:subject"]);
    const car = preview.actors.find((actor) => actor.id === "car")!;
    expect(car).toMatchObject({ x: 10, y: -3.5, rotateDeg: -90, length: 4.8, width: 1.9 });
    // Borders are not drawn; walkways sit under the carriageway.
    expect(preview.lanes.map((lane) => `${lane.kind}:${lane.width}`)).toEqual(["walk:2", "drive:3.5"]);
    // The route stops at the frame edge instead of running on across the map.
    expect(preview.route).toBe("M0 0L30 0L500 0");
  });
});

describe("classification", () => {
  it("treats vehicles as the actors a road must be under", () => {
    expect(isRoadActorKind("truck")).toBe(true);
    expect(isRoadActorKind("pedestrian")).toBe(false);
    expect(isRoadActorKind("static_object")).toBe(false);
    expect(previewActorKind("bicycle", false)).toBe("vru");
    expect(previewActorKind("static_object", false)).toBe("object");
    expect(previewActorKind("pedestrian", true)).toBe("subject");
    expect(laneClass("Driving")).toBe("drive");
    expect(laneClass("parking")).toBe("park");
    expect(laneClass("shoulder")).toBeNull();
  });
});

describe("chainLanePath", () => {
  const east = { x: 0, z: 0, headingRad: 0 };

  it("starts on the actor's own lane, not the runway behind it", () => {
    const runway = [{ x: -200, z: 0 }, { x: -60, z: 0 }];
    const own = [{ x: -50, z: 0 }, { x: 50, z: 0 }];
    const next = [{ x: 50, z: 0 }, { x: 90, z: 0 }];
    expect(chainLanePath([runway, own, next], east)).toEqual([
      { x: 0, z: 0 },
      { x: 50, z: 0 },
      { x: 50, z: 0 },
      { x: 90, z: 0 },
    ]);
  });

  it("turns a lane stored against travel so it meets the previous lane's end", () => {
    const own = [{ x: -10, z: 0 }, { x: 20, z: 0 }];
    const reversed = [{ x: 20, z: -40 }, { x: 20, z: 0 }];
    expect(chainLanePath([own, reversed], east)).toEqual([
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: 20, z: 0 },
      { x: 20, z: -40 },
    ]);
  });

  it("ends the drawn route at a lane that does not continue from the last one", () => {
    const own = [{ x: -10, z: 0 }, { x: 20, z: 0 }];
    const elsewhere = [{ x: 300, z: 300 }, { x: 400, z: 300 }];
    expect(chainLanePath([own, elsewhere], east)).toEqual([{ x: 0, z: 0 }, { x: 20, z: 0 }]);
  });
});

describe("rankCandidates", () => {
  it("puts clean placements before ones with actors off the road, then keeps the matcher's order", () => {
    const ranked = rankCandidates(
      [
        { id: "a", offRoadActors: 2, rank: 0 },
        { id: "b", offRoadActors: 0, rank: 0 },
        { id: "c", offRoadActors: 0, rank: 0 },
        { id: "d", offRoadActors: 1, rank: 0 },
      ],
      3,
    );
    expect(ranked.map((candidate) => `${candidate.rank}:${candidate.id}`)).toEqual(["1:b", "2:c", "3:a"]);
  });
});
