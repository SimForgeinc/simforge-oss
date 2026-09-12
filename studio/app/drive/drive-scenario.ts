"use client";

import type { CatalogId } from "@simforge-oss/asset-catalog";
import {
  EditorDocument,
  type IndexedLane,
  type LaneAnchor,
  type LaneIndex,
  type ScenarioMapEntry,
} from "@simforge-oss/editor";
import type { TemplateFileStore, TemplateLike } from "@simforge-oss/scenario";
import { selectLaneSpawn } from "@simforge-oss/studio-ui/drive";

/**
 * Clip length declared on the session document.
 *
 * A driving session has no end, but a scenario document must declare a clip
 * and the v2 template caps it at 120 s. So the document says the maximum and
 * the live world is started `endless`, which runs past it and never parks.
 */
export const DRIVE_CLIP_SECONDS = 120;
/** Route runway asked of the topology at spawn. Long enough that the ego never runs out of mapped road. */
const SPAWN_ROUTE_DOWNSTREAM_M = 2000;
/** Spawn draws to try before giving up; a map where this fails has no connected drivable road. */
const SPAWN_ATTEMPTS = 24;

/** A resolved place to start: a pose on a lane plus the mapped road ahead of it. */
export interface DriveSpawn {
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly laneRef: LaneAnchor;
  readonly routeLaneRsls: readonly string[];
  readonly speedLimitKph: number | null;
}

/** Every driving lane the index holds, in one array the game can sample and draw. */
export function drivingLanes(laneIndex: LaneIndex): readonly IndexedLane[] {
  const lanes: IndexedLane[] = [];
  for (const rsl of laneIndex.graph.laneIds) {
    const lane = laneIndex.lane(rsl);
    // The index only holds driving lanes; the graph knows every lane type.
    if (lane) lanes.push(lane);
  }
  return lanes;
}

/**
 * Choose a spawn.
 *
 * Lane choice is the pure, tested part; what it cannot know is whether the
 * topology can actually route out of that lane, and a lane with no connected
 * continuation puts the player on a road that ends. So a rejected draw is
 * retried rather than accepted, and only a map with no through road fails.
 */
export function pickDriveSpawn(
  laneIndex: LaneIndex,
  lanes: readonly IndexedLane[],
  random: () => number = Math.random,
): DriveSpawn | null {
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt += 1) {
    const chosen = selectLaneSpawn(lanes, random);
    if (!chosen) return null;
    const { lane, s } = chosen;
    const laneRef: LaneAnchor = {
      roadId: lane.roadId,
      section: lane.section,
      laneId: lane.laneId,
      s,
      t: 0,
      headingOffsetRad: 0,
    };
    const route = laneIndex.graph.defaultPlacementRoute(lane.rsl, s, SPAWN_ROUTE_DOWNSTREAM_M);
    if (!route || route.lanes.length === 0) continue;
    const pose = laneIndex.poseAt(lane, s, 0);
    return {
      x: pose.x,
      z: pose.z,
      headingRad: pose.headingRad,
      laneRef,
      routeLaneRsls: route.lanes,
      speedLimitKph: lane.speedLimitKph,
    };
  }
  return null;
}

/**
 * Build the one-car scenario a session drives.
 *
 * `/drive` has no authoring surface, but the live world it runs is the same
 * authored world the editor compiles, so the session's state is expressed as a
 * scenario document with exactly one vehicle on it. Persistence is thrown away
 * deliberately: a drive session must never overwrite the map's editor autosave.
 */
export async function createDriveScenario(options: {
  map: ScenarioMapEntry;
  catalogId: CatalogId;
  /** Body paint, as the picker chose it. */
  color: string;
  spawn: DriveSpawn;
}): Promise<{ document: EditorDocument; roleId: string }> {
  const document = await EditorDocument.openBlank(options.map, { store: new EphemeralTemplateStore() });
  document.rename("Drive session");
  document.setClip({ clipSeconds: DRIVE_CLIP_SECONDS, warmupSeconds: 0 });
  const [roleId] = document.add([{
    catalogId: options.catalogId,
    x: options.spawn.x,
    y: 0,
    z: options.spawn.z,
    headingRad: options.spawn.headingRad,
    laneRef: options.spawn.laneRef,
    routeLaneRsls: options.spawn.routeLaneRsls,
    // The driver owns the car from the first tick; the compiled route exists so
    // the world can place it on a lane and so releasing control leaves it on a
    // legal path rather than stranded.
    initialSpeedKph: 0,
    bodyColor: options.color,
    label: "You",
  }]);
  if (!roleId) throw new Error("Drive could not place the player vehicle in the session scenario");
  return { document, roleId };
}

/** A store that answers "nothing saved" and discards writes. */
class EphemeralTemplateStore implements TemplateFileStore {
  async list(): Promise<[]> {
    return [];
  }

  async read(name: string): Promise<unknown> {
    throw new Error(`Drive sessions are not persisted (${name})`);
  }

  async write(_name: string, _doc: TemplateLike): Promise<void> {
    // Intentionally nothing: see `createDriveScenario`.
  }

  async delete(): Promise<boolean> {
    return false;
  }
}
