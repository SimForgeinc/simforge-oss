/**
 * Where a session starts.
 *
 * A spawn has to be somewhere a car could legally be and somewhere the driver
 * can actually drive away from: a 6 m junction connector or the last metre of a
 * slip road is a legal pose and a terrible spawn. So candidates are filtered on
 * runway, the station is placed a fixed distance into the lane, and the heading
 * is the lane's direction of travel — never the polyline's storage direction,
 * which runs backwards on half the lanes of any real map.
 *
 * Pure and deterministic given `random`, so the choice can be replayed.
 */

/** The lane fields a spawn decision needs — a structural subset of the editor's `IndexedLane`. */
export interface SpawnCandidateLane {
  readonly rsl: string;
  readonly laneType: string;
  readonly isJunction: boolean;
  /** Centreline length, metres. */
  readonly length: number;
  /** `true` when travel runs along increasing station. */
  readonly forward: boolean;
  readonly speedLimitKph: number | null;
}

/** A chosen spawn: which lane, and how far along its stored polyline. */
export interface LaneSpawn<TLane extends SpawnCandidateLane> {
  readonly lane: TLane;
  /** Station along the stored polyline, metres — what `LaneIndex.poseAt` expects. */
  readonly s: number;
}

/** Shortest lane worth spawning on: two car lengths of runway plus room to react. */
export const MIN_SPAWN_LANE_LENGTH_M = 45;
/** How far into the lane the car is placed, measured along travel. */
export const SPAWN_ENTRY_OFFSET_M = 12;

/**
 * Is this lane a legal, drivable-away-from spawn?
 *
 * Exported because the picker shows how many spawn points a map has before the
 * world is built, and that count must agree with what {@link selectLaneSpawn}
 * will accept.
 */
export function isSpawnableLane(lane: SpawnCandidateLane): boolean {
  return lane.laneType === 'driving'
    && !lane.isJunction
    && Number.isFinite(lane.length)
    && lane.length >= MIN_SPAWN_LANE_LENGTH_M;
}

/**
 * Pick a random drivable lane and a station on it.
 *
 * The station is measured from the lane's entry in the direction of travel, so
 * a reversed lane spawns near the high-station end and still has the whole lane
 * ahead of it.
 */
export function selectLaneSpawn<TLane extends SpawnCandidateLane>(
  lanes: readonly TLane[],
  random: () => number = Math.random,
): LaneSpawn<TLane> | null {
  const candidates = lanes.filter(isSpawnableLane);
  if (candidates.length === 0) return null;
  const lane = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
  const s = lane.forward ? SPAWN_ENTRY_OFFSET_M : lane.length - SPAWN_ENTRY_OFFSET_M;
  return { lane, s };
}
