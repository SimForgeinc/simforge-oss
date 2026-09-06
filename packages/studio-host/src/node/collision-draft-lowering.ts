/**
 * Generated collision draft → authored `ScenarioTemplateV2`: the one lowering
 * both Studio hosts and the autogen service run before a candidate is executed
 * natively (`validateCollisionDraft`) and, unchanged, persisted.
 *
 * The input is the host editor's actor draft as the generators assemble it —
 * catalog identity, captured world pose (with elevation), lane anchors,
 * timed/path routes, behaviour program, reaction profile, sensors with their
 * capture configuration — typed here structurally so both hosts'
 * `ScenarioEditorActorDraft` assign without this package importing either
 * host. Every field with a canonical carrier is carried exactly:
 *
 * - motion: timed/path routes as `initialRoute`; a lane-following baseline
 *   (`autopilot`, `cruise`, or a routeless road actor) as the placed lane
 *   (`laneRef`) plus `initialSpeedKph`, which the native compiler turns into
 *   the lane-follow driver route;
 * - driver rules: `stop_at_stop_line` and the reaction profile as the role's
 *   `driverProfile` and `set rules.*` interactions at t = 0, which the native
 *   compiler folds into the actor's initial rules;
 * - sensors: the physical device as an actor sensor, and its authored capture
 *   configuration (resolution, frame rate, lidar channel/point/rotation rates,
 *   radar point rate, capture modality) once, in the template's
 *   `simforge.render-defaults` extension as a validated `RenderSpecV3`;
 *   a spring-arm trailing camera as the platform's presentation chase view
 *   (`PRONTO_CHASE_CAMERA_SENSOR_ID`), an explicit RGB render view that no
 *   consumer mistakes for a rigid rig mount.
 *
 * Anything the template cannot express exactly rejects the candidate with a
 * `CollisionDraftCandidateError` naming every loss. Nothing is approximated
 * and nothing is substituted: a blueprint is the catalog id it names or the
 * candidate is unresolvable.
 *
 * Frames: the draft is xodr-local metres (`x` east, `y` north, `z` up, yaw
 * degrees CCW from +x); the template's scene frame is y-up
 * (`{x, y: up, z: -north}`, heading radians CCW about +y).
 */

import { actorClassForCatalogEntry, getEntry, resolveCatalogId } from "@simforge-oss/asset-catalog/metadata";
import { STUDIO_BODY_COLOR_EXTENSION_KEY, normalizeStudioBodyColor, type MapBundle } from "@simforge-oss/compiler/node";
import {
  PRONTO_CHASE_CAMERA_SENSOR_ID,
  RENDER_DEFAULTS_EXTENSION_KEY,
  RENDER_SPEC_V3_SCHEMA,
  parseRenderSpecV3,
  parseTemplate,
  type ActorSensor,
  type RenderSourceV3,
  type RenderSpecV3,
  type ScenarioTemplateV2,
} from "@simforge-oss/scenario";
import { EnvironmentPresetSchema } from "@simforge-oss/scenario/contracts";

// ── Draft input (structural contract of a host's ScenarioEditorActorDraft) ──

export interface CollisionDraftPoint {
  readonly x: number;
  readonly y: number;
  /** Intended elevation, world metres, when the author captured one. */
  readonly z?: number | null;
}

export interface CollisionDraftTimedPoint extends CollisionDraftPoint {
  readonly time: number;
}

/** Captured world pose of a road anchor: xodr-local metres, yaw degrees. */
export interface CollisionDraftWorldAnchor {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export interface CollisionDraftRoadAnchor {
  readonly road_id?: string | null;
  readonly s_fraction?: number | null;
  readonly lane_id?: number | null;
  readonly section_id?: number | null;
  readonly world_anchor?: CollisionDraftWorldAnchor | null;
}

/** A host editor sensor (`Sensor` in `@simforge-oss/scenario/contracts`), the fields the lowering reads. */
export interface CollisionDraftSensor {
  readonly id: string;
  readonly label?: string | null;
  readonly sensorCategory: string;
  readonly outputModality: string;
  readonly attachTo?: string | null;
  readonly attachmentType?: string | null;
  readonly pose: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly roll: number;
    readonly pitch: number;
    readonly yaw: number;
  };
  /** Capture frequency, Hz. */
  readonly updateRate?: number | null;
  readonly fov?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly clipNear?: number | null;
  readonly clipFar?: number | null;
  readonly enablePostprocessEffects?: boolean | null;
  readonly channels?: number | null;
  readonly range?: number | null;
  readonly pointsPerSecond?: number | null;
  readonly rotationFrequency?: number | null;
  readonly horizontalFov?: number | null;
  readonly verticalFov?: number | null;
  readonly upperFov?: number | null;
  readonly lowerFov?: number | null;
  readonly radarRange?: number | null;
  readonly trackingTarget?: string | null;
  readonly configJson?: string | null;
}

export interface CollisionDraftBehaviorClip {
  readonly id: string;
  readonly label?: string | null;
  readonly enabled?: boolean | null;
  readonly role?: string | null;
  readonly trigger?: unknown;
  readonly end?: unknown;
  readonly action: { readonly kind: string };
}

export interface CollisionDraftBehaviorProgram {
  readonly clips: readonly CollisionDraftBehaviorClip[];
}

/** The actor-level reactive layer (`ReactionProfile` in `@simforge-oss/scenario/contracts`). */
export interface CollisionDraftReactionProfile {
  readonly mode: string;
  readonly aggressiveness?: number | null;
  readonly exempt_actor_ids?: readonly string[] | null;
  readonly obstacle_filter?: string | null;
}

/**
 * The host editor actor draft as the generators assemble it. Both hosts'
 * `ScenarioEditorActorDraft` satisfy this structurally.
 */
export interface CollisionDraftActor {
  readonly id: string;
  readonly label: string;
  /** The draft's scenario role vocabulary (`subject`, `traffic`, `pedestrian`, `prop`). */
  readonly role: string;
  readonly kind: "vehicle" | "walker" | "prop";
  /** Exact catalog identity (or one of the catalog's own aliases). */
  readonly blueprint: string;
  readonly is_static?: boolean | null;
  readonly placement_mode?: string | null;
  readonly spawn?: CollisionDraftRoadAnchor | null;
  readonly spawn_point?: CollisionDraftPoint | null;
  readonly spawn_yaw?: number | null;
  readonly route?: readonly CollisionDraftRoadAnchor[] | null;
  readonly route_direction?: string | null;
  readonly lane_facing?: string | null;
  readonly destination?: CollisionDraftRoadAnchor | null;
  readonly destination_point?: CollisionDraftPoint | null;
  readonly speed_kph?: number | null;
  readonly stop_at_stop_line?: boolean | null;
  readonly expected_maneuver?: string | null;
  readonly color?: string | null;
  readonly behavior?: CollisionDraftBehaviorProgram | null;
  readonly reaction_profile?: CollisionDraftReactionProfile | null;
  readonly intended_conflict_actor_id?: string | null;
  readonly timed_waypoints?: readonly CollisionDraftTimedPoint[] | null;
  readonly parking_maneuver?: unknown;
  readonly path_timing?: string | null;
  readonly path_placement?: readonly CollisionDraftPoint[] | null;
  readonly sensors?: readonly CollisionDraftSensor[] | null;
  readonly behaviorMetadata?: unknown;
}

/** The immutable map the draft was planned on, executes on and is persisted against. */
export interface CollisionDraftMapBinding {
  /** The compiler's map id (`bundle.mapId`); the template's `sourceMap`/`pin` bind to it. */
  readonly mapId: string;
  readonly mapName: string;
  /** The published map version the host persists the candidate against. */
  readonly mapVersionId: string;
  /** sha256 of the verified OpenDRIVE artifact the bundle was built from (`sourceMap.xodrSha256`). */
  readonly xodrSha256: string;
  readonly bundle: MapBundle;
}

export interface LowerCollisionDraftCandidateInput {
  readonly name: string;
  /** Generator identity stamped as the document's `meta.appVersion`. */
  readonly appVersion: string;
  /** The assembled editor draft actors: identity, spawn, elevation, sensors, behaviour clips. */
  readonly actors: readonly CollisionDraftActor[];
  readonly map: CollisionDraftMapBinding;
  readonly durationS: number;
  /** The family's environment preset struct (`EnvironmentPreset` in `@simforge-oss/scenario/contracts`). */
  readonly environmentPreset: unknown;
  readonly notes: string;
  /** Absent for a planning probe, which is executed but never persisted. */
  readonly scenarioIntention?: unknown;
  /** Document-level extensions (generator provenance). */
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
}

export interface LoweredCollisionDraft {
  /** The full authored candidate (sensors, elevation, behaviour clips, environment, capture defaults) the host persists. */
  readonly template: ScenarioTemplateV2;
  /** Draft actor id → role id (the actor id in the executed input and trace). */
  readonly roleIdByActorId: ReadonlyMap<string, string>;
}

/** One authored fact the template cannot carry exactly. */
export interface CollisionDraftConversionLoss {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * The generated candidate could not be lowered to the canonical template
 * without dropping or approximating authored content. A generated draft is
 * never persisted or judged in a form that differs from what its author
 * assembled, so every loss is a hard failure rather than a receipt entry.
 */
export class CollisionDraftCandidateError extends Error {
  constructor(
    readonly code: "candidate_unresolved" | "candidate_lossy" | "unresolvable_blueprint",
    readonly losses: readonly CollisionDraftConversionLoss[],
    message: string,
  ) {
    super(message);
    this.name = "CollisionDraftCandidateError";
  }
}

/** Role extension carrying the draft's identity facts that have no template field. */
export const COLLISION_DRAFT_ROLE_EXTENSION = "simforge.collision-draft" as const;
/** Document extension carrying the generator's scenario intention. */
export const COLLISION_DRAFT_INTENTION_EXTENSION = "simforge.scenario-intention" as const;

/** A routeless road actor without a lane anchor is placed on the nearest drivable lane within this distance. */
const LANE_SNAP_MAX_M = 3;

// ── Helpers ─────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

const record = (value: unknown): Raw =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonempty = (value: unknown): boolean => {
  if (value == null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
};
const radians = (degrees: number) => (degrees * Math.PI) / 180;
/** xodr-local `{x east, y north}` → scene `{x, z: -north}`. */
const scenePoint = (point: CollisionDraftPoint) => ({ x: point.x, z: -point.y });

function idAllocator(maxLength = 64) {
  const used = new Set<string>();
  return (source: string, prefix: string): string => {
    const stem =
      (source || prefix)
        .replace(/[^A-Za-z0-9_-]+/g, "_")
        .replace(/^[^A-Za-z]+/, "")
        .slice(0, maxLength - 8) || prefix;
    let candidate = stem;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${stem.slice(0, maxLength - 6)}_${suffix++}`;
    used.add(candidate);
    return candidate;
  };
}

class Losses {
  readonly items: CollisionDraftConversionLoss[] = [];
  add(code: string, path: string, message: string): void {
    this.items.push({ code, path, message });
  }
}

// ── Identity ────────────────────────────────────────────────────────────────

const VEHICLE_CLASSES: Readonly<Record<string, true>> = { car: true, truck: true, bus: true, van: true, motorcycle: true, bicycle: true, scooter: true };

/**
 * The catalog model a draft actor executes as: the id it names, exactly. The
 * catalog owns dimensions and appearance, so the role carries no `dims`; a
 * blueprint that is not a catalog id (a CARLA blueprint, a typo) has no model
 * and rejects the candidate rather than standing in as a class default.
 */
function catalogIdentity(
  actor: CollisionDraftActor,
  path: string,
  losses: Losses,
): { catalogId: string; actorClass: string } | null {
  const catalogId = resolveCatalogId(actor.blueprint);
  if (!catalogId) {
    losses.add(
      "actor_catalog_unresolved",
      `${path}.blueprint`,
      `actor "${actor.label}" (${actor.id}) names "${actor.blueprint}", which is not a catalog model`,
    );
    return null;
  }
  const actorClass = actorClassForCatalogEntry(getEntry(catalogId));
  const kindMatches =
    actor.kind === "walker"
      ? actorClass === "pedestrian"
      : actor.kind === "vehicle"
        ? VEHICLE_CLASSES[actorClass] === true
        : true;
  if (!kindMatches) {
    losses.add(
      "actor_catalog_kind_mismatch",
      `${path}.blueprint`,
      `actor "${actor.label}" (${actor.id}) is a ${actor.kind} but "${catalogId}" is a ${actorClass} model`,
    );
    return null;
  }
  return { catalogId, actorClass };
}

// ── Pose ────────────────────────────────────────────────────────────────────

interface ScenePose {
  position: { x: number; y: number; z: number };
  headingRad: number;
}

/**
 * Scene pose from the captured world anchor (position incl. elevation and yaw),
 * else the world-space spawn point (with its elevation when captured), else
 * the first timed waypoint. Heading: the anchor yaw, else `spawn_yaw`, else
 * the direction of the first timed segment.
 */
function actorPose(actor: CollisionDraftActor): ScenePose | null {
  const world = actor.spawn?.world_anchor ?? null;
  const point = actor.spawn_point ?? null;
  const timed = actor.timed_waypoints ?? [];
  const origin =
    world && finite(world.x) && finite(world.y)
      ? { x: world.x, y: finite(world.z) ? world.z : 0, z: -world.y }
      : point && finite(point.x) && finite(point.y)
        ? { x: point.x, y: finite(point.z) ? point.z : 0, z: -point.y }
        : timed[0] && finite(timed[0].x) && finite(timed[0].y)
          ? { x: timed[0].x, y: 0, z: -timed[0].y }
          : null;
  if (!origin) return null;
  const yawDegrees = world && finite(world.yaw) ? world.yaw : finite(actor.spawn_yaw) ? actor.spawn_yaw : null;
  let headingRad = yawDegrees == null ? 0 : radians(yawDegrees);
  if (yawDegrees == null && timed.length) {
    const next = timed.find(
      (candidate) => finite(candidate.x) && finite(candidate.y) && Math.hypot(candidate.x - origin.x, candidate.y + origin.z) > 1e-6,
    );
    if (next) headingRad = Math.atan2(next.y + origin.z, next.x - origin.x);
  }
  return { position: origin, headingRad };
}

// ── Route ───────────────────────────────────────────────────────────────────

type DraftRoute =
  | { mode: "customTimedRoute"; points: { timeS: number; x: number; z: number }[] }
  | { mode: "customRoute"; points: { x: number; z: number }[] };

const worldPoint = (anchor: CollisionDraftRoadAnchor | null | undefined): CollisionDraftPoint | null => {
  const world = anchor?.world_anchor;
  return world && finite(world.x) && finite(world.y) ? { x: world.x, y: world.y } : null;
};

/**
 * The exact map-bound route the role owns from t = 0, in the draft's own
 * precedence: timed waypoints (a walker's, or a `schedule`-timed vehicle's,
 * arrival times are the clip clock; an `ordering`-timed vehicle's are a
 * polyline driven at its speed), else the base clip's authored waypoints,
 * else the placed path/destination points, else the anchors' captured world
 * positions. Lane anchors without world positions have no exact native
 * geometry and are reported by the caller.
 */
function routeFor(actor: CollisionDraftActor): DraftRoute | null {
  const timed = (actor.timed_waypoints ?? []).filter((point) => finite(point.x) && finite(point.y));
  const spawn = actor.spawn_point && finite(actor.spawn_point.x) && finite(actor.spawn_point.y) ? actor.spawn_point : null;
  const destination =
    actor.destination_point && finite(actor.destination_point.x) && finite(actor.destination_point.y)
      ? actor.destination_point
      : null;
  if (timed.length) {
    const points = [
      ...(spawn && (!finite(timed[0]?.time) || timed[0]!.time > 0) ? [{ timeS: 0, ...scenePoint(spawn) }] : []),
      ...timed.map((point, index) => ({ timeS: finite(point.time) ? point.time : index, ...scenePoint(point) })),
    ];
    return actor.path_timing === "schedule" || actor.kind === "walker"
      ? { mode: "customTimedRoute", points }
      : { mode: "customRoute", points: points.map(({ x, z }) => ({ x, z })) };
  }
  const baseAction = record(actor.behavior?.clips.find((clip) => clip.role === "base")?.action);
  const baseWaypoints =
    (baseAction.kind === "follow_path" || baseAction.kind === "walk_path") && Array.isArray(baseAction.waypoints)
      ? (baseAction.waypoints as Raw[]).filter((point) => finite(point.x) && finite(point.y))
      : [];
  if (baseWaypoints.length) {
    const scheduled = baseAction.kind === "walk_path" || (baseAction.kind === "follow_path" && baseAction.timed === true);
    return scheduled
      ? {
          mode: "customTimedRoute",
          points: baseWaypoints.map((point, index) => ({
            timeS: finite(point.time) ? point.time : index,
            ...scenePoint(point as unknown as CollisionDraftPoint),
          })),
        }
      : { mode: "customRoute", points: baseWaypoints.map((point) => scenePoint(point as unknown as CollisionDraftPoint)) };
  }
  const placed = (actor.path_placement ?? []).filter((point) => finite(point.x) && finite(point.y));
  if (placed.length || (spawn && destination)) {
    const points = [
      ...(spawn ? [scenePoint(spawn)] : []),
      ...placed.map(scenePoint),
      ...(destination ? [scenePoint(destination)] : []),
    ];
    if (points.length) return { mode: "customRoute", points };
  }
  const worldRoute = [worldPoint(actor.spawn), ...(actor.route ?? []).map(worldPoint), worldPoint(actor.destination)].filter(
    (point): point is CollisionDraftPoint => point !== null,
  );
  if (worldRoute.length >= 2) return { mode: "customRoute", points: worldRoute.map(scenePoint) };
  return null;
}

/** Authored route or destination data exists beyond the spawn placement itself. */
function hasAuthoredRoute(actor: CollisionDraftActor): boolean {
  return (
    (actor.route?.length ?? 0) > 0 ||
    actor.destination != null ||
    actor.destination_point != null ||
    (actor.timed_waypoints?.length ?? 0) > 0 ||
    (actor.path_placement?.length ?? 0) > 0
  );
}

// ── Lane anchor ─────────────────────────────────────────────────────────────

interface LaneRef {
  roadId: string;
  section: number;
  laneId: number;
  s: number;
  t: number;
}

/**
 * The placed lane of a lane-following actor, for the native compiler's
 * lane-follow driver route. The draft's lane anchor, when it names a lane of
 * the execution map; else the nearest drivable lane to the pose. `s` is the
 * lane's own storage arc length at the pose (the graph's projection), which
 * is what the engine reads; the authored pose stays authoritative.
 */
function laneAnchorFor(
  actor: CollisionDraftActor,
  pose: ScenePose,
  map: CollisionDraftMapBinding,
  path: string,
  losses: Losses,
): LaneRef | null {
  const graph = map.bundle.graph;
  const x = pose.position.x;
  const y = -pose.position.z;
  const anchor = actor.spawn;
  const anchored =
    anchor && nonempty(anchor.road_id) && finite(anchor.lane_id) && anchor.lane_id !== 0 && finite(anchor.section_id);
  if (anchored) {
    const rsl = `${anchor.road_id}:${anchor.section_id}:${anchor.lane_id}`;
    let projected: Float64Array;
    try {
      projected = graph.projectOntoLane(rsl, x, y);
    } catch {
      losses.add(
        "actor_lane_unresolved",
        `${path}.spawn`,
        `actor "${actor.label}" (${actor.id}) is anchored to lane ${rsl}, which is not a lane of map ${map.mapId}`,
      );
      return null;
    }
    const s = projected[0]!;
    const offM = Math.abs(projected[1]!);
    const halfWidthM = graph.laneWidthAt(rsl, s) / 2;
    if (offM > halfWidthM) {
      losses.add(
        "actor_lane_anchor_off_lane",
        `${path}.spawn`,
        `actor "${actor.label}" (${actor.id}) is anchored to lane ${rsl} but its captured pose is ${offM.toFixed(2)} m from that lane`,
      );
      return null;
    }
    return { roadId: String(anchor.road_id), section: anchor.section_id!, laneId: anchor.lane_id!, s, t: 0 };
  }
  const nearest = graph.nearestLane(x, y, LANE_SNAP_MAX_M);
  if (!nearest) {
    losses.add(
      "actor_lane_unresolved",
      `${path}.spawn`,
      `actor "${actor.label}" (${actor.id}) follows its lane but has no lane anchor and no drivable lane within ${LANE_SNAP_MAX_M} m of its pose`,
    );
    return null;
  }
  const [rsl, s] = nearest;
  const [roadId, section, laneId] = rsl.split(":");
  return { roadId: roadId!, section: Number(section), laneId: Number(laneId), s, t: 0 };
}

// ── Behaviour clips ─────────────────────────────────────────────────────────

const BASE_CLIP_KINDS: Readonly<Record<string, true>> = {
  cruise: true,
  hold: true,
  follow_route: true,
  follow_path: true,
  walk_path: true,
  autopilot: true,
};

function actorRef(value: unknown, owner: string, ids: ReadonlyMap<string, string>): string | null {
  if (value === "self") return owner;
  const source = record(value).actor_id;
  return typeof source === "string" ? ids.get(source) ?? null : null;
}

function convertTrigger(
  triggerValue: unknown,
  owner: string,
  ids: ReadonlyMap<string, string>,
  clipIds: ReadonlyMap<string, string>,
  clipSeconds: number,
): Raw | null {
  const trigger = record(triggerValue);
  switch (trigger.kind) {
    case "at_time":
      return finite(trigger.t) && trigger.t <= clipSeconds ? { kind: "at", t: trigger.t } : null;
    case "after_clip": {
      const of = typeof trigger.clip_id === "string" ? clipIds.get(`${owner}\u0000${trigger.clip_id}`) : null;
      return of ? { kind: "after", of, event: "end", ...(finite(trigger.delay_s) ? { delayS: trigger.delay_s } : {}) } : null;
    }
    case "proximity": {
      const from = actorRef(trigger.actor, owner, ids);
      const other = actorRef(trigger.other, owner, ids);
      return from && other && finite(trigger.distance_m)
        ? {
            kind: "when",
            byLatest: clipSeconds,
            condition: {
              kind: "distance",
              from,
              to: { role: other },
              measure: "euclidean",
              op: trigger.mode === "farther" ? ">" : "<",
              valueM: trigger.distance_m,
            },
          }
        : null;
    }
    case "ttc": {
      const of = actorRef(trigger.actor, owner, ids);
      const to = actorRef(trigger.other, owner, ids);
      return of && to && finite(trigger.seconds)
        ? { kind: "when", byLatest: clipSeconds, condition: { kind: "ttc", of, to, op: "<", valueS: trigger.seconds } }
        : null;
    }
    case "headway": {
      const of = actorRef(trigger.actor, owner, ids);
      const to = actorRef(trigger.other, owner, ids);
      return of && to && finite(trigger.seconds)
        ? { kind: "when", byLatest: clipSeconds, condition: { kind: "headway", of, to, op: "<", valueS: trigger.seconds } }
        : null;
    }
    case "speed": {
      const of = actorRef(trigger.actor, owner, ids);
      return of && finite(trigger.kph)
        ? {
            kind: "when",
            byLatest: clipSeconds,
            condition: { kind: "speed", of, op: trigger.rule === "above" ? ">" : "<", valueKph: trigger.kph },
          }
        : null;
    }
    case "signal_state": {
      const signal = record(trigger.signal);
      return typeof signal.signal_id === "string"
        ? { kind: "when", byLatest: clipSeconds, condition: { kind: "signal", signal: { handle: signal.signal_id }, phase: trigger.state } }
        : null;
    }
    default:
      return null;
  }
}

function interactionFor(actionValue: unknown, owner: string, ids: ReadonlyMap<string, string>): Raw | null {
  const action = record(actionValue);
  const linear = (seconds = 1) => ({ shape: "linear", constraint: "time", value: seconds });
  switch (action.kind) {
    case "cruise":
    case "creep":
      return finite(action.speed_kph)
        ? { verb: "speed", target: { mode: "absolute", valueKph: action.speed_kph }, dynamics: linear() }
        : null;
    case "stop":
      return { verb: "speed", target: { mode: "stop" }, dynamics: linear(finite(action.decel_window_s) ? action.decel_window_s : 1) };
    case "hold":
      return { verb: "speed", target: { mode: "stop" }, dynamics: { shape: "step", constraint: "time", value: 0 } };
    case "lane_change":
      return {
        verb: "changeLane",
        target: { mode: "relative", dk: action.direction === "left" ? 1 : -1 },
        dynamics: finite(action.transition_m) ? { shape: "linear", constraint: "distance", value: action.transition_m } : linear(),
      };
    case "turn_at_next_intersection":
      return typeof action.direction === "string" && ["left", "right", "straight"].includes(action.direction)
        ? { verb: "route", target: { mode: "nextJunction", turn: action.direction } }
        : null;
    case "go_to": {
      const point = record(action.point);
      return finite(point.x) && finite(point.y)
        ? { verb: "route", target: { mode: "customRoute", points: [scenePoint({ x: point.x, y: point.y })] } }
        : null;
    }
    case "divert_path": {
      const points = Array.isArray(action.waypoints)
        ? (action.waypoints as Raw[])
            .filter((point) => finite(point.x) && finite(point.y))
            .map((point) => scenePoint({ x: point.x as number, y: point.y as number }))
        : [];
      return points.length ? { verb: "route", target: { mode: "customRoute", points } } : null;
    }
    case "yield_to":
    case "follow_actor": {
      const role = actorRef(action.actor, owner, ids);
      if (!role) return null;
      if (finite(action.headway_s)) return { verb: "gap", target: { role, value: action.headway_s, unit: "time" }, dynamics: linear() };
      const gap = finite(action.distance_m) ? action.distance_m : finite(action.gap_m) ? action.gap_m : null;
      if (gap != null) return { verb: "gap", target: { role, value: gap, unit: "distance" }, dynamics: linear() };
      return null;
    }
    default:
      return null;
  }
}

// ── Driver rules ────────────────────────────────────────────────────────────

/**
 * The draft's standing driver rules as the native rule contract: the lawful
 * profile (obeys signals, yields, avoids collisions) narrowed by `set rules.*`
 * at t = 0, which the native compiler folds into the actor's initial rules.
 *
 * - `stop_at_stop_line`: the lawful profile's `obeySignals`.
 * - reaction `brake` over every obstacle: the lawful profile's collision
 *   avoidance and right-of-way yields.
 * - reaction `brake` over stopped vehicles only: collision avoidance keeps
 *   the car-following term (it never drives into a stopped leader) and drops
 *   both right-of-way yields, so the actor stays assertive through the
 *   crossing conflict it exists to stage.
 * - reaction `none`: `collisionAvoidance` off — the actor commits.
 *
 * A Traffic-Manager per-pair exemption on a lane-following actor and a
 * lateral swerve reaction have no native rule and reject.
 */
function driverRulesFor(
  actor: CollisionDraftActor,
  laneFollowing: boolean,
  path: string,
  losses: Losses,
): { driverProfile: "lawful" | null; sets: { key: string; value: boolean }[] } {
  const sets: { key: string; value: boolean }[] = [];
  let asserted = actor.stop_at_stop_line === true;
  const profile = actor.reaction_profile;
  if (profile) {
    asserted = true;
    const exemptions = profile.exempt_actor_ids ?? [];
    switch (profile.mode) {
      case "brake":
        if (profile.obstacle_filter === "stopped_vehicles") {
          sets.push({ key: "rules.yieldToVehicles", value: false }, { key: "rules.yieldToPedestrians", value: false });
        } else if (profile.obstacle_filter && profile.obstacle_filter !== "all") {
          losses.add(
            "actor_reaction_filter_unsupported",
            `${path}.reaction_profile.obstacle_filter`,
            `actor "${actor.label}" (${actor.id}) reacts to obstacle class ${profile.obstacle_filter}, which has no native rule`,
          );
        }
        if (exemptions.length > 0 && laneFollowing) {
          losses.add(
            "actor_reaction_exemption_unsupported",
            `${path}.reaction_profile.exempt_actor_ids`,
            `actor "${actor.label}" (${actor.id}) exempts ${exemptions.join(", ")} from its lane-following collision avoidance; the native rules have no per-pair exemption`,
          );
        }
        break;
      case "none":
        sets.push({ key: "rules.collisionAvoidance", value: false });
        if (exemptions.length > 0 && laneFollowing) {
          losses.add(
            "actor_reaction_exemption_unsupported",
            `${path}.reaction_profile.exempt_actor_ids`,
            `actor "${actor.label}" (${actor.id}) hands lane following to the Traffic Manager with a per-pair exemption for ${exemptions.join(", ")}, which the native rules cannot scope`,
          );
        }
        break;
      default:
        losses.add(
          "actor_reaction_mode_unsupported",
          `${path}.reaction_profile.mode`,
          `actor "${actor.label}" (${actor.id}) reaction ${profile.mode} has no native rule; only braking reactions are representable`,
        );
    }
  }
  return { driverProfile: asserted && actor.kind === "vehicle" ? "lawful" : null, sets };
}

// ── Sensors ─────────────────────────────────────────────────────────────────

/** The authored capture configuration of one sensor, carried in the render-defaults spec. */
type CaptureDefaults =
  | { modality: "rgb" | "depth" | "semantic" | "instance"; width: number; height: number; fps: number }
  | { modality: "lidar"; channels: number; pointsPerSecond: number; rotationFrequencyHz: number }
  | { modality: "radar"; pointsPerSecond: number };

interface LoweredSensor {
  sensor: Raw;
  capture: CaptureDefaults | null;
  /** The presentation chase view, not a rig sensor. */
  presentation: boolean;
}

type CameraCaptureModality = Extract<CaptureDefaults, { width: number }>["modality"];

const CAMERA_MODALITIES: Readonly<Record<string, CameraCaptureModality>> = {
  rgb: "rgb",
  depth: "depth",
  semantic_segmentation: "semantic",
  instance_segmentation: "instance",
};

/**
 * A mounted sensor, exactly: identity, mount pose and the modality's
 * angular/range envelope as the actor sensor (the physical device), plus its
 * authored capture configuration for the render-defaults carrier. Output-
 * modality menus and mount naming are editor presentation and are not carried.
 * A spring-arm mount is the platform's trailing presentation camera and is
 * carried under its canonical id. Anything else that changes what the sensor
 * physically is or captures without a carrier (a tracking target, a non-
 * imaging camera modality, an unrepresentable category, a radar capture rate,
 * a post-process switch, opaque legacy config) rejects.
 */
function sensorFor(sensor: CollisionDraftSensor, path: string, losses: Losses): LoweredSensor | null {
  const category = sensor.sensorCategory;
  if (category !== "camera" && category !== "lidar" && category !== "radar") {
    losses.add("sensor_modality_unsupported", path, `sensor ${sensor.id} category ${category} is not representable by an actor sensor`);
    return null;
  }
  if (sensor.attachTo === "world") {
    losses.add("sensor_world_placed_unsupported", `${path}.attachTo`, `sensor ${sensor.id} is world-placed; actor sensors are mounted to their actor`);
    return null;
  }
  const presentation = sensor.attachmentType === "spring_arm" || sensor.attachmentType === "spring_arm_ghost";
  if (sensor.attachmentType && sensor.attachmentType !== "rigid" && !presentation) {
    losses.add(
      "sensor_mount_unsupported",
      `${path}.attachmentType`,
      `sensor ${sensor.id} uses a ${sensor.attachmentType} mount; only a rigid mount or a spring-arm chase view has an exact carrier`,
    );
    return null;
  }
  if (presentation && category !== "camera") {
    losses.add("sensor_mount_unsupported", `${path}.attachmentType`, `sensor ${sensor.id} is a spring-arm ${category}; only a camera can be the chase view`);
    return null;
  }
  if (nonempty(sensor.trackingTarget) || nonempty(sensor.configJson)) {
    losses.add("sensor_fields_unsupported", path, `sensor ${sensor.id} carries tracking or opaque legacy configuration with no actor-sensor field`);
    return null;
  }
  if (typeof sensor.enablePostprocessEffects === "boolean") {
    losses.add("sensor_capture_unsupported", `${path}.enablePostprocessEffects`, `sensor ${sensor.id} authors a post-process switch; the renderer decides post-processing by capture modality`);
    return null;
  }
  const cameraModality = category === "camera" ? CAMERA_MODALITIES[sensor.outputModality] : undefined;
  const supportedOutput =
    category === "camera"
      ? cameraModality !== undefined && (!presentation || cameraModality === "rgb")
      : category === "lidar"
        ? sensor.outputModality === "point_cloud"
        : sensor.outputModality === "radar_data";
  if (!supportedOutput) {
    losses.add(
      "sensor_output_unsupported",
      `${path}.outputModality`,
      `sensor ${sensor.id} output ${sensor.outputModality} has no ${presentation ? "chase-view" : category} capture modality`,
    );
    return null;
  }
  const pose = sensor.pose;
  if (!finite(pose?.x) || !finite(pose?.y) || !finite(pose?.z) || !finite(pose?.yaw) || !finite(pose?.pitch) || !finite(pose?.roll)) {
    losses.add("sensor_pose_invalid", `${path}.pose`, `sensor ${sensor.id} has a non-finite mount pose`);
    return null;
  }
  // An asymmetric lidar vertical field ([lowerFov, upperFov] about the mount
  // axis) is the symmetric v2 field re-centred: same rays, mount pitched by
  // the band's centre.
  const verticalBand =
    category === "lidar" && finite(sensor.upperFov) && finite(sensor.lowerFov) && sensor.upperFov > sensor.lowerFov
      ? { spanDeg: sensor.upperFov - sensor.lowerFov, centreDeg: (sensor.upperFov + sensor.lowerFov) / 2 }
      : null;
  const mount = {
    position: { x: pose.x, y: pose.z, z: -pose.y },
    rotation: {
      yawRad: -radians(pose.yaw),
      pitchRad: radians(pose.pitch + (verticalBand?.centreDeg ?? 0)),
      rollRad: -radians(pose.roll),
    },
  };
  const id = presentation ? PRONTO_CHASE_CAMERA_SENSOR_ID : sensor.id;
  const base = { id, ...(sensor.label ? { label: sensor.label } : {}), enabled: true, mount };
  const authoredRate = sensor.updateRate != null;
  if (authoredRate && (!finite(sensor.updateRate) || sensor.updateRate <= 0)) {
    losses.add("sensor_capture_invalid", `${path}.updateRate`, `sensor ${sensor.id} capture rate ${String(sensor.updateRate)} Hz is not a positive rate`);
    return null;
  }
  if (category === "camera") {
    const authoredSize = sensor.width != null || sensor.height != null;
    let capture: CaptureDefaults | null = null;
    if (authoredSize || authoredRate) {
      if (!finite(sensor.width) || !finite(sensor.height) || !finite(sensor.updateRate)) {
        losses.add(
          "sensor_capture_incomplete",
          path,
          `sensor ${sensor.id} authors part of a camera capture (width, height, updateRate); the render carrier needs all three`,
        );
        return null;
      }
      capture = { modality: cameraModality!, width: sensor.width, height: sensor.height, fps: sensor.updateRate };
    }
    return {
      presentation,
      capture,
      sensor: {
        ...base,
        type: "dash_camera",
        camera: {
          ...(finite(sensor.fov) ? { horizontalFovDeg: sensor.fov } : {}),
          ...(finite(sensor.verticalFov) ? { verticalFovDeg: sensor.verticalFov } : {}),
          ...(finite(sensor.clipNear) ? { nearM: sensor.clipNear } : {}),
          ...(finite(sensor.clipFar) ? { farM: sensor.clipFar } : {}),
          ...(finite(sensor.width) && finite(sensor.height) && sensor.height > 0 ? { aspectRatio: sensor.width / sensor.height } : {}),
        },
      },
    };
  }
  const farM = category === "lidar" ? sensor.range : sensor.radarRange;
  const field = {
    ...(finite(sensor.horizontalFov) ? { horizontalFovDeg: sensor.horizontalFov } : {}),
    ...(verticalBand
      ? { verticalFovDeg: verticalBand.spanDeg }
      : finite(sensor.verticalFov)
        ? { verticalFovDeg: sensor.verticalFov }
        : {}),
    ...(finite(farM) ? { farM } : {}),
  };
  if (category === "lidar") {
    let capture: CaptureDefaults | null = null;
    if (sensor.channels != null || sensor.pointsPerSecond != null || sensor.rotationFrequency != null || authoredRate) {
      if (!finite(sensor.channels) || !finite(sensor.pointsPerSecond) || !finite(sensor.rotationFrequency)) {
        losses.add(
          "sensor_capture_incomplete",
          path,
          `sensor ${sensor.id} authors part of a lidar capture (channels, pointsPerSecond, rotationFrequency); the render carrier needs all three`,
        );
        return null;
      }
      if (authoredRate && sensor.updateRate !== sensor.rotationFrequency) {
        losses.add(
          "sensor_capture_conflict",
          `${path}.updateRate`,
          `sensor ${sensor.id} captures at ${sensor.updateRate} Hz but rotates at ${sensor.rotationFrequency} Hz; a lidar scan is one rotation, so the render carrier holds one rate`,
        );
        return null;
      }
      capture = { modality: "lidar", channels: sensor.channels, pointsPerSecond: sensor.pointsPerSecond, rotationFrequencyHz: sensor.rotationFrequency };
    }
    return { presentation: false, capture, sensor: { ...base, type: "lidar", field } };
  }
  if (authoredRate) {
    losses.add("sensor_capture_unsupported", `${path}.updateRate`, `sensor ${sensor.id} authors a radar capture rate; the render carrier samples radar at the capture schedule`);
    return null;
  }
  return {
    presentation: false,
    capture: finite(sensor.pointsPerSecond) ? { modality: "radar", pointsPerSecond: sensor.pointsPerSecond } : null,
    sensor: { ...base, type: "radar", field },
  };
}

// ── Render defaults ─────────────────────────────────────────────────────────

interface CaptureSource {
  roleId: string;
  sensorId: string;
  capture: CaptureDefaults;
  presentation: boolean;
}

/**
 * The authored capture configuration of every lowered sensor as one
 * `RenderSpecV3`: a source per sensor (its parsed physical envelope plus its
 * authored capture attributes), the full clip, the template's own
 * environment, and derived artifacts — a review video sized by the chase view
 * (else the first camera), a sensor archive when an active sensor captures.
 * Fidelity is `dataset` when a rig sensor captures and `review` when only the
 * chase view does. `undefined` when no sensor authored capture configuration.
 */
function renderDefaultsFor(template: ScenarioTemplateV2, captures: readonly CaptureSource[]): RenderSpecV3 | undefined {
  if (captures.length === 0) return undefined;
  const allocateOutputName = idAllocator(64);
  const sources: RenderSourceV3[] = captures.map(({ roleId, sensorId, capture }) => {
    const role = template.roles.find((candidate) => candidate.id === roleId)!;
    const sensor: ActorSensor = role.actor.sensors.find((candidate) => candidate.id === sensorId)!;
    const common = {
      actorId: roleId,
      sensorId,
      outputName: allocateOutputName(`${roleId}-${sensorId}-${capture.modality}`, "source"),
      transform: { position: sensor.mount.position, rotation: sensor.mount.rotation },
    };
    if (capture.modality === "lidar") {
      if (sensor.type !== "lidar") throw new Error(`sensor ${sensorId} is not a lidar`);
      return {
        ...common,
        modality: "lidar",
        attributes: {
          channels: capture.channels,
          rangeM: sensor.field.farM,
          pointsPerSecond: capture.pointsPerSecond,
          rotationFrequencyHz: capture.rotationFrequencyHz,
          upperFovDeg: sensor.field.verticalFovDeg / 2,
          lowerFovDeg: -sensor.field.verticalFovDeg / 2,
        },
      };
    }
    if (capture.modality === "radar") {
      if (sensor.type !== "radar") throw new Error(`sensor ${sensorId} is not a radar`);
      return {
        ...common,
        modality: "radar",
        attributes: {
          horizontalFovDeg: sensor.field.horizontalFovDeg,
          verticalFovDeg: sensor.field.verticalFovDeg,
          rangeM: sensor.field.farM,
          pointsPerSecond: capture.pointsPerSecond,
        },
      };
    }
    if (sensor.type !== "dash_camera") throw new Error(`sensor ${sensorId} is not a camera`);
    return {
      ...common,
      modality: capture.modality,
      attributes: {
        width: capture.width,
        height: capture.height,
        fps: capture.fps,
        horizontalFovDeg: sensor.camera.horizontalFovDeg,
        nearM: sensor.camera.nearM,
        farM: sensor.camera.farM,
      },
    };
  });
  const cameraIndex = captures.findIndex((capture) => capture.presentation);
  const videoSource =
    (cameraIndex >= 0 ? sources[cameraIndex] : undefined) ??
    sources.find((source) => source.modality !== "lidar" && source.modality !== "radar");
  const video =
    videoSource && videoSource.modality !== "lidar" && videoSource.modality !== "radar"
      ? {
          width: videoSource.attributes.width,
          height: videoSource.attributes.height,
          fps: videoSource.attributes.fps,
          container: "mp4" as const,
          codec: "h264" as const,
          quality: "standard" as const,
        }
      : undefined;
  const artifacts = [
    ...(video ? ["video" as const] : []),
    "manifest" as const,
    ...(sources.some((source) => source.modality === "lidar" || source.modality === "radar") ? ["sensorArchive" as const] : []),
    "trace" as const,
  ];
  const required = [
    ...new Set([
      ...sources.map((source) => `sensor.${source.modality}`),
      ...artifacts.map((artifact) => (artifact === "sensorArchive" ? "artifact.sensor_archive" : `artifact.${artifact}`)),
      "environment.authored",
      "timing.fixed_step",
    ]),
  ];
  return parseRenderSpecV3({
    schema: RENDER_SPEC_V3_SCHEMA,
    sources,
    clip: { startSeconds: 0, endSeconds: template.choreography.clipSeconds },
    ...(video ? { video } : {}),
    artifacts,
    capabilityIntent: {
      required,
      preferred: [],
      fidelity: captures.some((capture) => !capture.presentation) ? "dataset" : "review",
    },
    authoredEnvironment: template.environment,
  });
}

// ── Environment ─────────────────────────────────────────────────────────────

/** Studio preset tokens with an exact v2 preset. The rest have none and reject. */
const WEATHER_PRESETS: Readonly<Record<string, string>> = { CLEAR_SKY: "clear", OVERCAST: "overcast", SNOW_FALLING: "snow" };
const TIME_OF_DAY_PRESETS: Readonly<Record<string, string>> = {
  SUNRISE: "dawn",
  SUNSET: "dusk",
  MID_MORNING: "morning",
  AFTERNOON: "afternoon",
  ZENITH: "noon",
  NIGHT: "night",
};

function environmentFor(presetValue: unknown, losses: Losses): Raw {
  const parsed = EnvironmentPresetSchema.safeParse(presetValue);
  if (!parsed.success) {
    losses.add("environment_preset_invalid", "environmentPreset", `the environment preset is not a recognised preset struct: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return {};
  }
  const preset = parsed.data;
  const environment: Raw = {};
  if (preset.weather !== undefined) {
    const weather = WEATHER_PRESETS[preset.weather];
    if (weather) environment.weather = weather;
    else losses.add("environment_weather_unsupported", "environmentPreset.weather", `${preset.weather} has no exact ScenarioTemplateV2 weather preset`);
  }
  if (preset.lighting !== undefined) {
    const timeOfDay = TIME_OF_DAY_PRESETS[preset.lighting];
    if (timeOfDay) environment.timeOfDay = timeOfDay;
    else losses.add("environment_lighting_unsupported", "environmentPreset.lighting", `${preset.lighting} has no exact ScenarioTemplateV2 time-of-day preset`);
  }
  if (preset.roadSurface !== undefined && preset.roadSurface !== "DRY_ROAD") {
    losses.add("environment_road_surface_unsupported", "environmentPreset.roadSurface", `global road surface ${preset.roadSurface} has no ScenarioTemplateV2 equivalent`);
  }
  if (nonempty(preset.intentPrompt)) {
    losses.add("environment_intent_prompt_unsupported", "environmentPreset.intentPrompt", "a free-text environment prompt has no ScenarioTemplateV2 carrier");
  }
  return environment;
}

// ── Lowering ────────────────────────────────────────────────────────────────

function parseCandidate(document: unknown): ScenarioTemplateV2 {
  try {
    return parseTemplate(document);
  } catch (error) {
    throw new CollisionDraftCandidateError(
      "candidate_unresolved",
      [],
      `lowered candidate is not a valid ScenarioTemplateV2: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Lower the assembled draft to the map-bound `ScenarioTemplateV2` the host
 * persists and the native runtime executes. Every authored field with a
 * canonical carrier survives exactly — catalog identity, captured world pose
 * incl. elevation, placed lane, timed/path routes, driver rules, behaviour
 * clips with their triggers and timings, sensors and their capture
 * configuration, body colour, environment — and the draft actor id ↔ role id
 * mapping is returned for trace reading. Anything the template cannot carry
 * exactly throws `CollisionDraftCandidateError` naming every loss.
 */
export function lowerCollisionDraftCandidate(input: LowerCollisionDraftCandidateInput): LoweredCollisionDraft {
  if (input.actors.length === 0) {
    throw new CollisionDraftCandidateError("candidate_unresolved", [], "the generated draft has no actors");
  }
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const losses = new Losses();
  const clipSeconds = input.durationS;

  const allocateRoleId = idAllocator();
  const ids = new Map<string, string>();
  for (const actor of input.actors) ids.set(actor.id, allocateRoleId(actor.id, "actor"));
  const allocateInteractionId = idAllocator();
  const clipIds = new Map<string, string>();
  for (const actor of input.actors) {
    const owner = ids.get(actor.id)!;
    for (const clip of actor.behavior?.clips ?? []) {
      clipIds.set(`${owner}\u0000${clip.id}`, allocateInteractionId(`${owner}_${clip.id}`, "action"));
    }
  }

  const roles: Raw[] = [];
  const interactions: Raw[] = [];
  const captures: CaptureSource[] = [];
  const roleIdByActorId = new Map<string, string>();
  for (const [index, actor] of input.actors.entries()) {
    const path = `actors[${index}]`;
    const id = ids.get(actor.id)!;
    const identity = catalogIdentity(actor, path, losses);
    const pose = actorPose(actor);
    if (!pose) {
      losses.add("actor_pose_unresolved", `${path}.spawn`, `actor "${actor.label}" (${actor.id}) has neither a captured world pose nor a world-space spawn point`);
    }
    const sensors: Raw[] = [];
    const sensorCaptures: CaptureSource[] = [];
    let chaseViews = 0;
    for (const [sensorIndex, sensor] of (actor.sensors ?? []).entries()) {
      const sensorPath = `${path}.sensors[${sensorIndex}]`;
      const lowered = sensorFor(sensor, sensorPath, losses);
      if (!lowered) continue;
      if (lowered.presentation && ++chaseViews > 1) {
        losses.add("sensor_chase_view_duplicate", sensorPath, `actor "${actor.label}" (${actor.id}) carries more than one spring-arm chase camera; the platform has one trailing presentation view per actor`);
        continue;
      }
      sensors.push(lowered.sensor);
      if (lowered.capture) {
        sensorCaptures.push({ roleId: id, sensorId: lowered.sensor.id as string, capture: lowered.capture, presentation: lowered.presentation });
      }
    }
    const isStatic = actor.is_static === true || actor.kind === "prop";
    const route = routeFor(actor);
    if (!route && hasAuthoredRoute(actor)) {
      losses.add("actor_route_unresolved", `${path}.route`, `actor "${actor.label}" (${actor.id}) carries route or destination data without world-space geometry`);
    }
    if (isStatic && route) {
      losses.add("static_actor_route_unsupported", `${path}.route`, `static actor "${actor.label}" (${actor.id}) carries route data the canonical static role does not execute`);
    }
    if (actor.route_direction === "reverse" || actor.lane_facing === "against_lane") {
      losses.add("actor_direction_unsupported", path, `actor "${actor.label}" (${actor.id}) uses ${actor.route_direction === "reverse" ? "reverse route direction" : "against-lane facing"}, which has no exact canonical spawn state`);
    }
    if (nonempty(actor.parking_maneuver)) {
      losses.add("actor_parking_maneuver_unsupported", `${path}.parking_maneuver`, `actor "${actor.label}" (${actor.id}) carries a rear-axle parking maneuver with gear cusps, which the template cannot represent`);
    }
    const color = actor.color ? normalizeStudioBodyColor(actor.color) : null;
    if (actor.color && !color) {
      losses.add("actor_color_unsupported", `${path}.color`, `actor "${actor.label}" (${actor.id}) colour "${actor.color}" is not an rgb or hex colour`);
    }
    const conflictRoleId = actor.intended_conflict_actor_id ? ids.get(actor.intended_conflict_actor_id) ?? null : null;
    if (actor.intended_conflict_actor_id && !conflictRoleId) {
      losses.add("actor_conflict_target_unknown", `${path}.intended_conflict_actor_id`, `actor "${actor.label}" (${actor.id}) names conflict actor ${actor.intended_conflict_actor_id}, which is not in the draft`);
    }

    const clips = actor.behavior?.clips ?? [];
    const baseClip = clips.find((clip) => clip.role === "base");
    const baseAction = record(baseClip?.action);
    if (baseClip && BASE_CLIP_KINDS[baseClip.action.kind] !== true) {
      losses.add("base_behavior_unsupported", `${path}.behavior`, `actor "${actor.label}" (${actor.id}) base behavior ${baseClip.action.kind} cannot be represented by canonical spawn state and route`);
    }
    // A Traffic-Manager baseline is lane following at the authored speed; one
    // that hands control back holds the actor where it spawned.
    const autopilot = baseAction.kind === "autopilot" ? baseAction.enabled === true : null;
    const holds = isStatic || baseAction.kind === "hold" || autopilot === false;
    const initialSpeedKph = holds
      ? 0
      : finite(baseAction.speed_kph)
        ? baseAction.speed_kph
        : finite(actor.speed_kph)
          ? actor.speed_kph
          : undefined;
    // A moving road actor with no authored geometry drives its placed lane at
    // its authored speed.
    const laneFollowing = !holds && !route && actor.kind === "vehicle";
    if (laneFollowing && initialSpeedKph === undefined) {
      losses.add("actor_speed_unresolved", `${path}.speed_kph`, `actor "${actor.label}" (${actor.id}) follows its lane with no authored speed; the native driver has no map speed-limit fallback`);
    }
    const laneRef = laneFollowing && pose ? laneAnchorFor(actor, pose, input.map, path, losses) : null;
    const rules = driverRulesFor(actor, laneFollowing, path, losses);
    for (const set of rules.sets) {
      interactions.push({
        id: allocateInteractionId(`${id}_${set.key.replace(/^rules\./, "")}`, "rule"),
        actor: id,
        trigger: { kind: "at", t: 0 },
        verb: "set",
        target: { key: set.key, value: set.value },
      });
    }
    for (const [clipIndex, clip] of clips.entries()) {
      if (clip.enabled === false || clip.role === "base") continue;
      const clipPath = `${path}.behavior.clips[${clipIndex}]`;
      const trigger = convertTrigger(clip.trigger, id, ids, clipIds, clipSeconds);
      const converted = interactionFor(clip.action, id, ids);
      if (!trigger || !converted) {
        losses.add("behavior_unsupported", clipPath, `behavior ${clip.id} (${clip.action.kind}, trigger ${String(record(clip.trigger).kind)}) has no exact ScenarioTemplateV2 translation`);
        continue;
      }
      const interaction: Raw = { id: clipIds.get(`${id}\u0000${clip.id}`)!, actor: id, trigger, ...(clip.label ? { label: clip.label } : {}), ...converted };
      const end = record(clip.end);
      if (end.kind === "until_trigger") {
        const until = convertTrigger(end.trigger, id, ids, clipIds, clipSeconds);
        if (until) interaction.until = until;
        else losses.add("behavior_end_unsupported", `${clipPath}.end`, `behavior ${clip.id} end trigger cannot be translated`);
      } else if (end.kind === "duration") {
        const endAt = trigger.kind === "at" && finite(end.seconds) ? Number(trigger.t) + end.seconds : null;
        if (endAt != null && endAt <= clipSeconds) interaction.until = { kind: "at", t: endAt };
        else losses.add("behavior_duration_unsupported", `${clipPath}.end`, `behavior ${clip.id} has a trigger-relative duration outside the canonical absolute clip window`);
      }
      interactions.push(interaction);
    }

    if (!identity || !pose) continue;
    roleIdByActorId.set(actor.id, id);
    captures.push(...sensorCaptures);
    const behaviorMetadata = nonempty(actor.behaviorMetadata) ? actor.behaviorMetadata : undefined;
    roles.push({
      id,
      kind: "scene_absolute",
      label: actor.label,
      actor: { class: identity.actorClass, catalogId: identity.catalogId, static: isStatic, sensors },
      pose,
      ...(laneRef ? { laneRef } : {}),
      ...(initialSpeedKph === undefined ? {} : { initialSpeedKph }),
      ...(rules.driverProfile ? { driverProfile: rules.driverProfile } : {}),
      ...(route && !isStatic ? { initialRoute: route } : {}),
      essentiality: actor.kind === "prop" ? "preferred" : "required",
      extensions: {
        [COLLISION_DRAFT_ROLE_EXTENSION]: {
          sourceActorId: actor.id,
          role: actor.role,
          ...(behaviorMetadata === undefined ? {} : { behaviorMetadata }),
          ...(conflictRoleId ? { intendedConflictRoleId: conflictRoleId } : {}),
          ...(actor.expected_maneuver ? { expectedManeuver: actor.expected_maneuver } : {}),
        },
        ...(color ? { [STUDIO_BODY_COLOR_EXTENSION_KEY]: color } : {}),
      },
    });
  }

  const environment = environmentFor(input.environmentPreset, losses);
  const subjects = input.actors.filter((actor) => actor.role === "subject" && roleIdByActorId.has(actor.id));
  if (subjects.length > 1) {
    losses.add("multiple_subject_roles", "actors", `${subjects.length} actors are marked subject; only one can be the metric subject`);
  }

  if (losses.items.length > 0) {
    const onlyIdentity = losses.items.every((loss) => loss.code === "actor_catalog_unresolved" || loss.code === "actor_catalog_kind_mismatch");
    throw new CollisionDraftCandidateError(
      onlyIdentity ? "unresolvable_blueprint" : "candidate_lossy",
      losses.items,
      `generated draft cannot be lowered exactly: ${losses.items.map((loss) => `${loss.code} at ${loss.path}`).join("; ")}`,
    );
  }

  const extensions: Raw = {
    ...input.extensions,
    ...(input.scenarioIntention === undefined ? {} : { [COLLISION_DRAFT_INTENTION_EXTENSION]: input.scenarioIntention }),
  };
  const document = {
    scenarioVersion: 2,
    meta: {
      name: input.name,
      description: input.notes,
      createdAt,
      modifiedAt: createdAt,
      appVersion: input.appVersion,
      tags: ["generated-collision"],
    },
    sourceMap: { mapId: input.map.mapId, mapName: input.map.mapName, xodrSha256: input.map.xodrSha256 },
    environment,
    anchor: { id: "collision_scene", pin: { mapId: input.map.mapId } },
    roles,
    choreography: { clipSeconds, warmupSeconds: 0, interactions },
    ...(subjects[0] ? { metricSubject: roleIdByActorId.get(subjects[0].id) } : {}),
    extensions,
  };
  // The capture defaults are derived from the parsed candidate (sensor
  // envelopes and environment with their schema defaults applied), then
  // carried on it.
  const parsed = parseCandidate(document);
  let renderDefaults: RenderSpecV3 | undefined;
  try {
    renderDefaults = renderDefaultsFor(parsed, captures);
  } catch (error) {
    throw new CollisionDraftCandidateError(
      "candidate_unresolved",
      [],
      `authored capture configuration is not a valid ${RENDER_SPEC_V3_SCHEMA} document: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const template = renderDefaults
    ? parseCandidate({ ...document, extensions: { ...extensions, [RENDER_DEFAULTS_EXTENSION_KEY]: renderDefaults } })
    : parsed;
  return { template, roleIdByActorId };
}
