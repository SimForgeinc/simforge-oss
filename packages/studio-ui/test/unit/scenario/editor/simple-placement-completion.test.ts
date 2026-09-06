import { describe, expect, it } from "vitest";

import { shouldFinishActorPlacement } from "../../../../src/scenario/editor/simple-placement-completion";

describe("actor placement completion", () => {
  it("closes any open actor catalog after successful placement", () => {
    expect(shouldFinishActorPlacement({
      experience: "simple",
      activeTool: "vehicles",
      previous: { mode: "placing", actorCount: 1, actorIds: ["car-1"], placementSticky: false },
      current: { mode: "placing", actorCount: 2, actorIds: ["car-1", "car-2"], placementSticky: false },
    })).toBe(true);
    expect(shouldFinishActorPlacement({
      experience: "advanced",
      activeTool: "pedestrians",
      previous: { mode: "idle", actorCount: 1, actorIds: ["car-1"], placementSticky: false },
      current: { mode: "idle", actorCount: 2, actorIds: ["car-1", "person-1"], placementSticky: false },
    })).toBe(true);
  });

  it("keeps the panel open after a failed placement or without an open catalog", () => {
    expect(shouldFinishActorPlacement({
      experience: "simple",
      activeTool: "vehicles",
      previous: { mode: "placing", actorCount: 1, actorIds: ["car-1"], placementSticky: false },
      current: { mode: "placing", actorCount: 1, actorIds: ["car-1"], placementSticky: false },
    })).toBe(false);
    expect(shouldFinishActorPlacement({
      experience: "advanced",
      activeTool: null,
      previous: { mode: "placing", actorCount: 1, actorIds: ["car-1"], placementSticky: false },
      current: { mode: "placing", actorCount: 2, actorIds: ["car-1", "car-2"], placementSticky: false },
    })).toBe(false);
  });

  it("keeps the catalog open after Shift-placement", () => {
    expect(shouldFinishActorPlacement({
      experience: "simple",
      activeTool: "vehicles",
      previous: { mode: "placing", actorCount: 1, actorIds: ["car-1"], placementSticky: false },
      current: { mode: "placing", actorCount: 2, actorIds: ["car-1", "car-2"], placementSticky: true },
    })).toBe(false);
  });
});
