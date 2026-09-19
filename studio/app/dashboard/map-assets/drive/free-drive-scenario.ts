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
 * Pick where a free drive starts.
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
): Promise<{ content: ScenarioTemplateV2; roleId: string }> {
  const lane = freeDriveSpawnLane(laneIndex);
  const s = lane.length * SPAWN_FRACTION;
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
