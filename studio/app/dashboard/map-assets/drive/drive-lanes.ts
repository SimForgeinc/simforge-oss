"use client";

import type { IndexedLane, LaneIndex } from "@simforge-oss/editor";

/** Every driving lane the index holds, in one array the HUD can sample and draw. */
export function drivingLanes(laneIndex: LaneIndex): readonly IndexedLane[] {
  const lanes: IndexedLane[] = [];
  for (const rsl of laneIndex.graph.laneIds) {
    const lane = laneIndex.lane(rsl);
    // The index only holds driving lanes; the graph knows every lane type.
    if (lane) lanes.push(lane);
  }
  return lanes;
}
