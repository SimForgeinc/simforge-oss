import { describe, expect, it } from "vitest";

import {
  MIN_SPAWN_LANE_LENGTH_M,
  SPAWN_ENTRY_OFFSET_M,
  isSpawnableLane,
  selectLaneSpawn,
  type SpawnCandidateLane,
} from "./spawn";

function lane(overrides: Partial<SpawnCandidateLane> & { rsl: string }): SpawnCandidateLane {
  return {
    laneType: "driving",
    isJunction: false,
    length: 120,
    forward: true,
    speedLimitKph: 40,
    ...overrides,
  };
}

describe("spawn lane selection", () => {
  it("refuses lanes a car cannot start on", () => {
    expect(isSpawnableLane(lane({ rsl: "1:0:-1" }))).toBe(true);
    expect(isSpawnableLane(lane({ rsl: "1:0:1", laneType: "sidewalk" }))).toBe(false);
    expect(isSpawnableLane(lane({ rsl: "1:0:1", isJunction: true }))).toBe(false);
    expect(isSpawnableLane(lane({ rsl: "1:0:1", length: MIN_SPAWN_LANE_LENGTH_M - 1 }))).toBe(false);
    expect(isSpawnableLane(lane({ rsl: "1:0:1", length: Number.NaN }))).toBe(false);
  });

  it("only ever returns a spawnable lane", () => {
    const lanes = [
      lane({ rsl: "walk", laneType: "sidewalk" }),
      lane({ rsl: "junction", isJunction: true }),
      lane({ rsl: "stub", length: 12 }),
      lane({ rsl: "good" }),
    ];
    for (let draw = 0; draw < 50; draw += 1) {
      const spawn = selectLaneSpawn(lanes, () => draw / 50);
      expect(spawn?.lane.rsl).toBe("good");
    }
  });

  it("leaves the whole lane ahead whichever way travel runs", () => {
    const forward = selectLaneSpawn([lane({ rsl: "f", forward: true, length: 100 })], () => 0);
    expect(forward?.s).toBe(SPAWN_ENTRY_OFFSET_M);
    const reversed = selectLaneSpawn([lane({ rsl: "r", forward: false, length: 100 })], () => 0);
    // Travel runs towards decreasing station, so the entry is at the far end.
    expect(reversed?.s).toBe(100 - SPAWN_ENTRY_OFFSET_M);
  });

  it("spreads across the candidates and stays inside the list at random() === 1", () => {
    const lanes = [lane({ rsl: "a" }), lane({ rsl: "b" }), lane({ rsl: "c" })];
    expect(selectLaneSpawn(lanes, () => 0)?.lane.rsl).toBe("a");
    expect(selectLaneSpawn(lanes, () => 0.5)?.lane.rsl).toBe("b");
    expect(selectLaneSpawn(lanes, () => 0.99)?.lane.rsl).toBe("c");
    expect(selectLaneSpawn(lanes, () => 1)?.lane.rsl).toBe("c");
  });

  it("reports no spawn for a map with no drivable runway", () => {
    expect(selectLaneSpawn([], () => 0)).toBeNull();
    expect(selectLaneSpawn([lane({ rsl: "only", laneType: "parking" })], () => 0)).toBeNull();
  });
});
