"use client";

import type { CatalogId } from "@simforge-oss/asset-catalog";
import { EditorDocument, type IndexedLane, type LaneIndex, type ScenarioMapEntry } from "@simforge-oss/editor";
import { MemoryStorage, WebTemplateFileStore, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

/** The car free drive hands you when nothing else has been chosen. */
export const FREE_DRIVE_VEHICLE = "vehicle.sedan" as CatalogId;

/**
 * Shortest lane worth spawning on, metres. Below this the driver is in a
 * junction or a stub before they have finished reading the HUD.
 */
const MIN_RUNWAY_M = 60;

/** Where along the chosen lane the car starts, as a fraction of its length. */
const SPAWN_FRACTION = 0.15;

/**
 * How far from the point of interest a spawn lane may be, metres. A gallery
 * camera rides the street it is touring, so the lane it means is usually
 * within a carriageway; the radius only has to survive a look across a wide
 * boulevard or a junction.
 */
const NEAR_SPAWN_RADIUS_M = 45;

/** Where a free drive starts: a lane and the arc length along it. */
export interface FreeDriveSpawn {
  readonly lane: IndexedLane;
  readonly s: number;
}

/**
 * Pick where a free drive starts when nothing has been looked at yet.
 *
 * The longest non-junction driving lane is the friendliest spawn on an
 * arbitrary map: it is a real road rather than a connector, and it gives the
 * driver the most road ahead before the first decision. Ties break on the
 * lane's `rsl` so the same map always starts the same place — a free drive
 * that spawns somewhere new on every load is impossible to reason about when
 * something looks wrong.
 */
export function freeDriveSpawnLane(laneIndex: LaneIndex): IndexedLane {
  let best: IndexedLane | null = null;
  let fallback: IndexedLane | null = null;
  for (const lane of laneIndex.all) {
    if (!fallback || lane.length > fallback.length) fallback = lane;
    if (lane.isJunction || lane.length < MIN_RUNWAY_M) continue;
    if (!best || lane.length > best.length || (lane.length === best.length && lane.rsl < best.rsl)) {
      best = lane;
    }
  }
  const lane = best ?? fallback;
  if (!lane) throw new Error("This map has no driving lanes, so there is nowhere to start a drive.");
  return lane;
}

/** The map's default spawn: early on its longest road. */
export function defaultFreeDriveSpawn(laneIndex: LaneIndex): FreeDriveSpawn {
  const lane = freeDriveSpawnLane(laneIndex);
  return { lane, s: lane.length * SPAWN_FRACTION };
}

/**
 * The spawn under a point the driver is already looking at.
 *
 * The lane is the one a placed vehicle would snap to there. When the road runs
 * both ways and that lane travels against the look direction, the oncoming
 * lane is taken instead, so the car starts pointed where the driver was
 * looking rather than making them turn around first. Null when no driving
 * lane is within reach — a rooftop, water, the middle of a park.
 *
 * @param lookHeadingRad Travel-heading convention (CCW about +Y from +X), the
 *   direction the camera faces; null to accept the nearest lane as it is.
 */
export function freeDriveSpawnNear(
  laneIndex: LaneIndex,
  x: number,
  z: number,
  lookHeadingRad: number | null,
): FreeDriveSpawn | null {
  const hit = laneIndex.nearestForVehiclePlacement(x, z, NEAR_SPAWN_RADIUS_M);
  if (!hit) return null;
  if (lookHeadingRad !== null && Math.cos(hit.headingRad - lookHeadingRad) < 0) {
    const oncoming = laneIndex.nearestOpposingForVehiclePlacement(x, z, hit.headingRad, NEAR_SPAWN_RADIUS_M);
    if (oncoming) return { lane: oncoming.lane, s: oncoming.s };
  }
  return { lane: hit.lane, s: hit.s };
}

/**
 * A scenario holding one drivable car and nothing else.
 *
 * Free drive still needs a scenario, because the world runtime is authored:
 * actors come from a template and the ego is one of them. This is the
 * smallest template that produces a car — placed through the editor's own
 * {@link EditorDocument.add}, so the lane anchor, heading and role binding are
 * built exactly as an authored placement would build them rather than by a
 * second, parallel set of rules.
 *
 * The document is scratch: it is given its own in-memory store so a free
 * drive never touches the autosave slot holding the author's real blank
 * scenario for this map.
 */
export async function createFreeDriveScenario(
  map: ScenarioMapEntry,
  laneIndex: LaneIndex,
  catalogId: CatalogId = FREE_DRIVE_VEHICLE,
  spawn: FreeDriveSpawn = defaultFreeDriveSpawn(laneIndex),
): Promise<{ content: ScenarioTemplateV2; roleId: string }> {
  const { lane, s } = spawn;
  const pose = laneIndex.poseAt(lane, s, 0);
  const document = await EditorDocument.openBlank(map, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
  });
  try {
    const [roleId] = document.add([
      {
        catalogId,
        x: pose.x,
        y: 0,
        z: pose.z,
        headingRad: pose.headingRad,
        laneRef: {
          roadId: lane.roadId,
          section: lane.section,
          laneId: lane.laneId,
          s,
          t: 0,
          headingOffsetRad: 0,
        },
        label: "Free drive",
        // Parked at the kerb, not launched into the map.
        initialSpeedKph: 0,
      },
    ]);
    if (!roleId) throw new Error("The free drive vehicle could not be placed on this map.");
    return { content: document.data, roleId };
  } finally {
    document.dispose();
  }
}
