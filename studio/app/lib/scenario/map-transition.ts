import "server-only";

import {
  collectGalleryCatalogIds,
  galleryCatalogEntry,
} from "@simforge-oss/studio-ui/lib/asset-gallery/catalog-entry";
import {
  buildXodrElevationResolver,
  compileTemplateAtSite,
  materializationSemanticLosses,
  matchSites,
  resolveExecutionInput,
  resolveSite,
  type CompiledTemplate,
  type MapBundle,
  type MatchedSite,
  type MaterializeOptions,
} from "@simforge-oss/compiler/node";
import type { SimScenarioInput } from "@simforge-oss/engine";
import { parseTemplate, roundFloat, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type {
  ScenarioMapTransitionPlacementDto,
  ScenarioMapTransitionPlanDto,
  ScenarioMapTransitionPoseDto,
  ScenarioMapTransitionRoadDto,
} from "@simforge-oss/studio-host";
import type { CollisionDraftMapBinding } from "@simforge-oss/studio-host/node";

import { GalleryCatalogResolutionError, requireGalleryCatalogEntries } from "@/app/lib/asset-gallery/store";
import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne } from "@/app/lib/db/data-api";

import {
  CollisionDraftMapUnavailableError,
  loadMapVersionBundle,
  readMapVersionXodr,
} from "./collision-draft-map.server";
import type { ScenarioDocumentDto } from "./contracts";
import {
  boxOf,
  chainPolyline,
  diffXodrRoads,
  drawablePolyline,
  headingGap,
  LaneGeometryIndex,
  lanesTouchBox,
  laneTravelPolyline,
  matchLaneChain,
  nearestLane,
  normalizeHeading,
  pointAlong,
  polylineFrom,
  poseAt,
  roadPolylines,
  routeDeviation,
  type GeoLane,
  type Point,
  type RoadChange,
} from "./map-transition-geometry";
import { SimulationHistoryError } from "./sim-diff";
import { sameRoadGeometry } from "./sim-history";

/**
 * "Move to new map version": what happens to a scenario when its draft moves from the map version
 * it is pinned to onto a newer publication of the same map. The plan is computed on the server,
 * shown in the transition view (before/after placements, changed roads), and its `content` is what
 * the draft is saved with on the target version; nothing here writes.
 *
 * Two cases, decided by the published geometry identity (`sameRoadGeometry`):
 *
 * - **Same road geometry** (byte-identical OpenDRIVE, or equal `xodrGeometrySha256`: only
 *   elevation/lateral profiles and lane heights changed). Every actor keeps its exact x/y, lane and
 *   `s`; only what the target itself requires changes (the pin's topology digest and the recorded
 *   OpenDRIVE digest when present, and each map-bound actor's ground height, taken from the new
 *   ground).
 *
 * - **Changed road geometry.** A location-based transfer: every actor is mapped by its world
 *   position to the nearest lane of the same kind and direction on the new map, keeping its
 *   lateral offset and heading relative to the lane; every lane route is matched by shape onto a
 *   connected lane chain of the new map. Nothing is snapped further than {@link LANE_SEARCH_RADIUS_M};
 *   an actor with no lane there stays exactly where it was, without a lane, and is reported
 *   `unplaced`. A portable (anchor-placed) scenario is re-resolved at the matcher site of the new
 *   map nearest to where it stood.
 *
 * Both cases then compile the planned content on the target exactly as the authoritative
 * simulation resolves it (`resolveExecutionInput`; for a portable document, the editor's pinned-site
 * compile) and compare each actor's compiled start pose and route with the current version's.
 * A failed compile, or a subject that cannot be placed, blocks the move with the reason.
 */

/** An actor that moved less than this was kept where it was. */
export const KEPT_TOLERANCE_M = 0.05;
/** Placements that move (or whose route shifts) more than this are flagged for review. */
export const MOVE_TOLERANCE_M = 1.0;
/** How far from its old spot an actor's lane may be found on the new map. */
export const LANE_SEARCH_RADIUS_M = 6;
/** How far a lane route's centreline may lie from the new map's lane it is matched to. */
export const ROUTE_MATCH_TOLERANCE_M = 3;
/** How far a portable scenario's site may move and still be the same place. */
export const SITE_MATCH_TOLERANCE_M = 15;
/** Metres of route compared between the two versions. */
const ROUTE_COMPARE_M = 60;
/** A vehicle further than this from every drivable centreline is off the road. */
const OFF_ROAD_M = 3;
/** Roads within this of the placements are drawn. */
const ROAD_MARGIN_M = 40;
const MAX_ROADS = 300;
/** Drawn centreline vertices closer than this are dropped. */
const DRAW_STEP_M = 1.5;
/** A lane is matched only to a lane running within this of its direction. */
const MAX_LANE_HEADING_GAP_RAD = Math.PI / 4;
/** Sites the matcher is asked for when re-resolving a portable scenario. */
const SITE_POOL = 200;

const VEHICLE_CLASSES = new Set(["car", "truck", "bus", "van", "motorcycle"]);

type VersionRow = {
  id: string;
  label: string;
  created_at: string;
  source_map_asset_id: string | null;
  xodr_sha256: string;
  geometry_sha256: string | null;
  retired: boolean;
};

async function readVersion(mapVersionId: string): Promise<VersionRow | null> {
  return queryOne<VersionRow>(
    `SELECT id, label, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, source_map_asset_id, xodr_sha256,
            descriptor->>'xodrGeometrySha256' AS geometry_sha256, retired_at IS NOT NULL AS retired
       FROM simforge.map_versions WHERE id = :id`,
    { id: mapVersionId },
  );
}

type Role = ScenarioTemplateV2["roles"][number];
type SceneRole = Extract<Role, { kind: "scene_absolute" }>;
type CompiledActor = SimScenarioInput["actors"][number];

type Blocking = { code: string; message: string };

type Side = {
  version: VersionRow;
  binding: CollisionDraftMapBinding;
  bundle: MapBundle;
  lanes: LaneGeometryIndex;
  xodr: string;
};

const laneIndexes = new WeakMap<MapBundle, LaneGeometryIndex>();

function laneIndex(bundle: MapBundle): LaneGeometryIndex {
  let index = laneIndexes.get(bundle);
  if (!index) {
    index = new LaneGeometryIndex(bundle.topology);
    laneIndexes.set(bundle, index);
  }
  return index;
}

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const at = (point: Point) => `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`;
const labelOf = (role: Role) => role.label?.trim() || role.id;

/** The native error's first line, without the source excerpt a dev overlay appends. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.slice(0, 400);
}

/** A compile failure in words, with the compiler's own line kept for support. */
function compileFailure(error: unknown): string {
  const raw = firstLine(error);
  const plain: Array<[RegExp, string]> = [
    [/route_disconnected/, "an actor's route no longer connects on this map version"],
    [/route_lane_missing/, "a lane the scenario uses does not exist on this map version"],
    [/map_bound_topology_digest_mismatch/, "the scenario is pinned to a different road network"],
    [/map_bound_(source|pin)_mismatch/, "the scenario is bound to a different map"],
    [/materialization_infeasible|not feasible/, "the scenario cannot be played there as authored"],
    [/semantic_loss/, "the scenario could not be represented exactly there"],
    [/runtime_asset_identity/, "an actor has no catalog model"],
    [/actor_catalog_entry_missing/, "an imported actor model is no longer available"],
    [/site_mismatch|No intent-preserving site/i, "the scenario's place could not be found there"],
  ];
  const words = plain.find(([pattern]) => pattern.test(raw))?.[1];
  return words ? `${words} (${raw})` : raw;
}

async function catalogEntriesFor(content: ScenarioTemplateV2): Promise<MaterializeOptions["catalogEntries"]> {
  const entries = await requireGalleryCatalogEntries(collectGalleryCatalogIds(content as unknown as Record<string, unknown>));
  return entries.map(galleryCatalogEntry);
}

// ── Compiled start poses ─────────────────────────────────────────────────────────────────

type Start = {
  pose: { x: number; y: number; headingRad: number };
  /** The route from the start, xodr-local; null when the actor has none to compare. */
  route: Point[] | null;
};

function routeOf(actor: CompiledActor, lanes: LaneGeometryIndex): Point[] | null {
  const start = { x: actor.initial.pose.x, y: -actor.initial.pose.z };
  const route = actor.behavior.route;
  let points: Point[] | null = null;
  if (route.kind === "lanePath") points = chainPolyline(lanes, route.lanes);
  else if (route.kind === "polyline" || route.kind === "timedPolyline") points = route.points.map((p) => ({ x: p.x, y: -p.z }));
  else if (route.kind === "recordedTrack") points = route.samples.map((p) => ({ x: p.x, y: -p.z }));
  if (!points) return null;
  const distinct = points.filter((p, i) => i === 0 || Math.hypot(p.x - points![i - 1]!.x, p.y - points![i - 1]!.y) > 1e-6);
  if (distinct.length < 2) return null;
  return polylineFrom(distinct, start);
}

function startsOf(input: SimScenarioInput, lanes: LaneGeometryIndex): Map<string, Start> {
  const out = new Map<string, Start>();
  for (const actor of input.actors) {
    out.set(actor.id, {
      pose: { x: actor.initial.pose.x, y: -actor.initial.pose.z, headingRad: actor.initial.pose.headingRad },
      route: routeOf(actor, lanes),
    });
  }
  return out;
}

// ── Map identity carried by the content ─────────────────────────────────────────────────

/** The content with the map identities it records moved to the target (only fields already present). */
function retargetIdentity(
  content: ScenarioTemplateV2,
  target: Side,
  pinDigest: string,
  siteId?: string,
): ScenarioTemplateV2 {
  const pin = content.anchor.pin;
  return parseTemplate({
    ...content,
    ...(content.sourceMap
      ? {
          sourceMap: {
            ...content.sourceMap,
            ...(content.sourceMap.xodrSha256 ? { xodrSha256: target.version.xodr_sha256 } : {}),
          },
        }
      : {}),
    anchor: {
      ...content.anchor,
      ...(pin
        ? {
            pin: {
              ...pin,
              ...(siteId ? { siteId } : {}),
              ...(pin.topologyDigest ? { topologyDigest: pinDigest } : {}),
            },
          }
        : {}),
    },
  });
}

// ── Heights ─────────────────────────────────────────────────────────────────────────────

type Grounding = { content: ScenarioTemplateV2; notes: Map<string, string> };

/** Each map-bound actor's ground height taken from the target's OpenDRIVE. */
function groundOnTarget(content: ScenarioTemplateV2, target: Side): Grounding {
  const notes = new Map<string, string>();
  let elevation: ReturnType<typeof buildXodrElevationResolver> | null = null;
  const roles = content.roles.map((role) => {
    if (role.kind !== "scene_absolute") return role;
    elevation ??= buildXodrElevationResolver(target.xodr, target.bundle.topology);
    const position = role.pose.position;
    try {
      const y = elevation({ x: position.x, y: -position.z, actorId: role.id });
      return { ...role, pose: { ...role.pose, position: { ...position, y: roundFloat(y) } } };
    } catch (error) {
      notes.set(role.id, `Its height could not be read from the new map's ground here, so it keeps its authored height (${firstLine(error)}).`);
      return role;
    }
  });
  return { content: parseTemplate({ ...content, roles }), notes };
}

// ── Location-based transfer of a map-bound document ─────────────────────────────────────

type RoleTransfer = {
  role: Role;
  /** `unplaced`: no lane on the new map; the actor stays where it was without one. */
  unplaced: boolean;
  reasons: string[];
};

function sceneLaneRsl(role: SceneRole): string | null {
  return role.laneRef ? `${role.laneRef.roadId}:${role.laneRef.section}:${role.laneRef.laneId}` : null;
}

function transferSceneRole(role: SceneRole, source: Side, target: Side): RoleTransfer {
  const position = { x: role.pose.position.x, y: -role.pose.position.z };
  const laneRef = role.laneRef;
  const reasons: string[] = [];
  if (!laneRef) {
    // A free actor keeps its world position; a vehicle the new road moved away from is flagged.
    if (VEHICLE_CLASSES.has(role.actor.class) && !role.actor.static) {
      const near = (lanes: LaneGeometryIndex) => nearestLane(lanes, position, {
        family: "drive", headingRad: 0, maxHeadingGapRad: Math.PI, radius: 30,
      })?.distance ?? Infinity;
      const before = near(source.lanes);
      const after = near(target.lanes);
      if (before <= OFF_ROAD_M && after > OFF_ROAD_M) {
        reasons.push(`It is now ${Number.isFinite(after) ? `${after.toFixed(1)} m` : "far"} from the nearest drivable lane at ${at(position)}.`);
      }
    }
    return { role, unplaced: false, reasons };
  }
  const sourceRsl = sceneLaneRsl(role)!;
  const sourceLane = source.lanes.lane(sourceRsl);
  const laneHeading = normalizeHeading(role.pose.headingRad - laneRef.headingOffsetRad);
  const hit = nearestLane(target.lanes, position, {
    family: sourceLane?.family ?? "drive",
    headingRad: laneHeading,
    maxHeadingGapRad: MAX_LANE_HEADING_GAP_RAD,
    radius: LANE_SEARCH_RADIUS_M,
    preferRsl: sourceRsl,
    preferSlackM: 0.75,
  });
  if (!hit) {
    // Never snapped far away and never dropped: it stays exactly where it was, without a lane.
    const { laneRef: _laneRef, ...free } = role;
    const route = role.initialRoute?.mode === "lanePath" ? undefined : role.initialRoute;
    const { initialRoute: _route, ...rest } = free;
    return {
      role: { ...rest, ...(route ? { initialRoute: route } : {}) } as Role,
      unplaced: true,
      reasons: [
        `No lane of the same kind and direction on the new map within ${LANE_SEARCH_RADIUS_M} m of ${at(position)}; it stays where it was, without a lane`
        + (role.actor.static ? "." : ", and heads straight on from there until it is given one."),
      ],
    };
  }
  const half = hit.lane.widthM / 2;
  const t = Math.max(-half, Math.min(half, laneRef.t));
  const placed = poseAt(hit.lane, hit.s, t);
  const headingRad = normalizeHeading(placed.headingRad + laneRef.headingOffsetRad);
  let initialRoute = role.initialRoute;
  if (initialRoute?.mode === "lanePath") {
    const matched = matchLaneChain(source.lanes, target.lanes, initialRoute.lanes, {
      toleranceM: ROUTE_MATCH_TOLERANCE_M,
      startRsl: hit.lane.rsl,
    });
    if (matched.ok) {
      initialRoute = { mode: "lanePath", lanes: matched.lanes };
    } else {
      initialRoute = undefined;
      reasons.push(`Its route could not be matched on the new map at ${at(matched.at)} (${matched.reason}); it now follows its lane from the start.`);
    }
  }
  const { initialRoute: _previous, ...base } = role;
  const moved: SceneRole = {
    ...base,
    pose: {
      ...role.pose,
      position: { ...role.pose.position, x: roundFloat(placed.x), z: roundFloat(-placed.y) },
      headingRad: roundFloat(headingRad),
    },
    laneRef: {
      roadId: hit.lane.roadId,
      section: hit.lane.section,
      laneId: hit.lane.laneId,
      s: roundFloat(Math.max(0, hit.s)),
      t: roundFloat(t),
      headingOffsetRad: laneRef.headingOffsetRad,
    },
    ...(initialRoute ? { initialRoute } : {}),
  };
  return { role: moved, unplaced: false, reasons };
}

type Remapped = { value: unknown; failure: { path: string; at: Point; reason: string } | null };

/**
 * Lane routes and lane ids outside the roles (timeline route changes, signal plan movements),
 * matched onto the new map by shape. A chain that starts on a lane an actor was placed on starts
 * on that actor's new lane.
 */
function remapLaneReferences(value: unknown, source: Side, target: Side, placedLanes: ReadonlyMap<string, string>, path: string): Remapped {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const next = remapLaneReferences(item, source, target, placedLanes, `${path}[${index}]`);
      if (next.failure) return next;
      out.push(next.value);
    }
    return { value: out, failure: null };
  }
  if (!value || typeof value !== "object") return { value, failure: null };
  const record = value as Record<string, unknown>;
  if (record.mode === "lanePath" && Array.isArray(record.lanes)) {
    const lanes = record.lanes as string[];
    const matched = matchLaneChain(source.lanes, target.lanes, lanes, {
      toleranceM: ROUTE_MATCH_TOLERANCE_M,
      ...(placedLanes.has(lanes[0]!) ? { startRsl: placedLanes.get(lanes[0]!)! } : {}),
    });
    if (!matched.ok) return { value, failure: { path, at: matched.at, reason: matched.reason } };
    return { value: { ...record, lanes: matched.lanes }, failure: null };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if ((key === "approachLaneRsl" || key === "connectingLaneRsl") && typeof item === "string") {
      const matched = matchLaneChain(source.lanes, target.lanes, [item], { toleranceM: ROUTE_MATCH_TOLERANCE_M });
      if (!matched.ok || matched.lanes.length !== 1) {
        return {
          value,
          failure: { path: `${path}.${key}`, at: matched.ok ? { x: 0, y: 0 } : matched.at, reason: "the signal movement's lane has no single counterpart on the new map" },
        };
      }
      out[key] = matched.lanes[0];
      continue;
    }
    const next = remapLaneReferences(item, source, target, placedLanes, `${path}.${key}`);
    if (next.failure) return next;
    out[key] = next.value;
  }
  return { value: out, failure: null };
}

function interactionName(content: ScenarioTemplateV2, path: string): string {
  const match = /^choreography\.interactions\[(\d+)\]/.exec(path);
  const interaction = match ? content.choreography.interactions[Number(match[1])] : undefined;
  return interaction ? `the timeline step "${(interaction as { id?: string }).id ?? match![1]}"` : path;
}

const startAt = (starts: ReadonlyMap<string, Start>, roleId: string) => {
  const start = starts.get(roleId);
  return start ? ` ${at(start.pose)}` : "";
};

// ── Placements ──────────────────────────────────────────────────────────────────────────

function pose(start: Start | undefined, elevationM: number | null): ScenarioMapTransitionPoseDto | null {
  if (!start) return null;
  return { x: round(start.pose.x), y: round(start.pose.y), headingRad: round(start.pose.headingRad, 4), elevationM };
}

function placementsOf(input: {
  content: ScenarioTemplateV2;
  /** The planned roles (for their new ground height), when planned. */
  planned: { readonly roles: readonly Role[] } | null;
  before: Map<string, Start> | null;
  after: Map<string, Start> | null;
  subjectId: string | null;
  unplaced: ReadonlySet<string>;
  /** Reasons that flag a placement for review whatever its displacement. */
  flags: ReadonlyMap<string, string[]>;
  /** Informational lines (e.g. a height kept as authored). */
  notes: ReadonlyMap<string, string[]>;
}): ScenarioMapTransitionPlacementDto[] {
  return input.content.roles.map((role) => {
    const plannedRole = input.planned?.roles.find((candidate) => candidate.id === role.id);
    const before = input.before?.get(role.id);
    const after = input.after?.get(role.id);
    const elevation = (r: Role | undefined) => (r?.kind === "scene_absolute" ? roundFloat(r.pose.position.y) : null);
    const displacementM = before && after ? round(Math.hypot(after.pose.x - before.pose.x, after.pose.y - before.pose.y)) : null;
    const routeDeviationM = before?.route && after?.route ? round(routeDeviation(before.route, after.route, ROUTE_COMPARE_M)) : null;
    const flags = input.flags.get(role.id) ?? [];
    const reasons = [...flags];
    let status: ScenarioMapTransitionPlacementDto["status"];
    if (input.unplaced.has(role.id)) {
      status = "unplaced";
    } else if (!after) {
      status = "unplaced";
      if (reasons.length === 0) reasons.push(input.after ? "The new map has no place for it: the compiled scenario has no such actor there." : "Not compiled on the new map.");
    } else {
      const shift = Math.max(displacementM ?? 0, routeDeviationM ?? 0);
      const turned = before ? headingGap(after.pose.headingRad, before.pose.headingRad) : 0;
      if (shift > MOVE_TOLERANCE_M || flags.length > 0) {
        status = "flagged";
        if (displacementM !== null && displacementM > MOVE_TOLERANCE_M) reasons.unshift(`It moved ${displacementM.toFixed(2)} m, more than ${MOVE_TOLERANCE_M} m.`);
        else if (routeDeviationM !== null && routeDeviationM > MOVE_TOLERANCE_M) reasons.unshift(`Its route shifted by up to ${routeDeviationM.toFixed(2)} m, more than ${MOVE_TOLERANCE_M} m.`);
      } else if (shift > KEPT_TOLERANCE_M || turned > 0.01) {
        status = "moved";
        reasons.unshift(`It moved ${(displacementM ?? 0).toFixed(2)} m${routeDeviationM !== null && routeDeviationM > KEPT_TOLERANCE_M ? ` and its route shifted by up to ${routeDeviationM.toFixed(2)} m` : ""} to stay on its lane.`);
      } else {
        status = "kept";
      }
    }
    reasons.push(...(input.notes.get(role.id) ?? []));
    return {
      roleId: role.id,
      label: labelOf(role),
      kind: role.actor.class,
      isSubject: role.id === input.subjectId,
      before: pose(before, elevation(role)),
      after: pose(after, elevation(plannedRole)),
      displacementM,
      routeDeviationM,
      status,
      reason: reasons.length > 0 ? reasons.join(" ") : null,
    };
  });
}

/** Map-bound start poses straight from the content, for when there is no compile to read them from. */
function authoredStarts(content: { readonly roles: readonly Role[] }): Map<string, Start> {
  const out = new Map<string, Start>();
  for (const role of content.roles) {
    if (role.kind !== "scene_absolute") continue;
    out.set(role.id, { pose: { x: role.pose.position.x, y: -role.pose.position.z, headingRad: role.pose.headingRad }, route: null });
  }
  return out;
}

// ── Roads ───────────────────────────────────────────────────────────────────────────────

function roadsNear(source: Side, target: Side, placements: readonly ScenarioMapTransitionPlacementDto[]): { roads: ScenarioMapTransitionRoadDto[]; truncated: boolean } {
  const points = placements.flatMap((placement) => [placement.before, placement.after].filter((p): p is ScenarioMapTransitionPoseDto => p !== null));
  const box = boxOf(points, ROAD_MARGIN_M);
  if (!box) return { roads: [], truncated: false };
  const changes: Map<string, RoadChange> = diffXodrRoads(source.xodr, target.xodr);
  const before = roadPolylines(source.lanes);
  const after = roadPolylines(target.lanes);
  const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const reach = (lanes: readonly GeoLane[]) => Math.min(...lanes.map((lane) => {
    const x = Math.max(lane.minX, Math.min(centre.x, lane.maxX));
    const y = Math.max(lane.minY, Math.min(centre.y, lane.maxY));
    return Math.hypot(x - centre.x, y - centre.y);
  }));
  const near: Array<{ roadId: string; distance: number; before: GeoLane[]; after: GeoLane[] }> = [];
  for (const roadId of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(roadId) ?? [];
    const b = after.get(roadId) ?? [];
    if (!lanesTouchBox(a, box) && !lanesTouchBox(b, box)) continue;
    near.push({ roadId, distance: reach([...a, ...b]), before: a, after: b });
  }
  near.sort((x, y) => x.distance - y.distance || x.roadId.localeCompare(y.roadId, "en", { numeric: true }));
  const draw = (lanes: GeoLane[]) => lanes.map((lane) => drawablePolyline(lane, DRAW_STEP_M));
  return {
    roads: near.slice(0, MAX_ROADS).map((road) => ({
      roadId: road.roadId,
      // A road the topology draws but the OpenDRIVE diff does not list cannot be classified: say so.
      change: changes.get(road.roadId) ?? (road.before.length === 0 ? "added" : road.after.length === 0 ? "removed" : "geometry"),
      before: draw(road.before),
      after: draw(road.after),
    })),
    truncated: near.length > MAX_ROADS,
  };
}

// ── Portable documents ──────────────────────────────────────────────────────────────────

/** Where a matched site stands: the point `s = 0` of its reference path, and the heading there. */
function siteOrigin(site: MatchedSite, lanes: LaneGeometryIndex): (Point & { headingRad: number }) | null {
  const spans = site.frame.referencePath;
  const index = spans.findIndex((span) => span.sStart <= 0 && span.sEnd >= 0);
  const span = spans[index];
  if (!span) return null;
  const points = laneTravelPolyline(lanes, span.laneRsl, spans[index - 1]?.laneRsl, spans[index + 1]?.laneRsl);
  if (!points) return null;
  const extent = span.sEnd - span.sStart;
  const length = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y), 0);
  return pointAlong(points, extent > 0 ? ((0 - span.sStart) / extent) * length : 0);
}

type PortableCompile = { site: MatchedSite; compiled: CompiledTemplate };

function playable(compiled: CompiledTemplate): CompiledTemplate {
  const losses = materializationSemanticLosses(compiled.manifest.notes);
  if (losses.length > 0) throw new Error(`semantic_loss: ${losses.map((note) => `${note.path}: ${note.reason}`).join(" · ")}`);
  if (!compiled.manifest.feasible) {
    throw new Error(`materialization_infeasible: ${compiled.manifest.issues.filter((issue) => issue.severity === "error").map((issue) => issue.reason).join(" · ")}`);
  }
  return compiled;
}

/** Compile a portable document the way the editor does: at its pinned site, else the first playable matched site. */
function compilePortable(content: ScenarioTemplateV2, bundle: MapBundle, catalogEntries: MaterializeOptions["catalogEntries"]): PortableCompile {
  const options = { drawIndex: -1, ...(catalogEntries ? { catalogEntries } : {}) };
  const pin = content.anchor.pin;
  if (pin?.siteId && pin.mapId === bundle.mapId) {
    const resolved = resolveSite(content, bundle, pin.siteId);
    return { site: resolved.site, compiled: playable(compileTemplateAtSite(content, bundle, resolved, options)) };
  }
  const { report } = matchSites(content, bundle);
  let lastError: unknown = new Error(`No intent-preserving site matches this scenario${report.failureSummary ? ` (${report.failureSummary})` : ""}`);
  for (const site of report.sites) {
    if (!site.degradation.intentPreserved) continue;
    try {
      const resolved = resolveSite(content, bundle, site.siteId);
      return { site, compiled: playable(compileTemplateAtSite(content, bundle, resolved, options)) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** The intent-preserving site of the target nearest to where the source site stands, within tolerance. */
function siteAtSameLocation(content: ScenarioTemplateV2, origin: Point & { headingRad: number }, target: Side): MatchedSite | null {
  // Site ids are never reused across road networks, so the search is by location. It ignores
  // diversity, which would otherwise keep only one site per junction and could hide this one.
  const search = parseTemplate({
    ...content,
    anchor: {
      ...content.anchor,
      policy: { ...content.anchor.policy, diversity: "off", maxSitesPerMap: 1000 },
      ...(content.anchor.pin ? { pin: { mapId: content.anchor.pin.mapId } } : {}),
    },
  });
  const { report } = matchSites(search, target.bundle, { maxSites: SITE_POOL });
  let best: { site: MatchedSite; distance: number } | null = null;
  for (const site of report.sites) {
    if (!site.degradation.intentPreserved) continue;
    const here = siteOrigin(site, target.lanes);
    if (!here || headingGap(here.headingRad, origin.headingRad) > MAX_LANE_HEADING_GAP_RAD) continue;
    const distance = Math.hypot(here.x - origin.x, here.y - origin.y);
    if (distance <= SITE_MATCH_TOLERANCE_M && (!best || distance < best.distance)) best = { site, distance };
  }
  return best?.site ?? null;
}

// ── The plan ────────────────────────────────────────────────────────────────────────────

type Outcome = {
  content: ScenarioTemplateV2 | null;
  placements: ScenarioMapTransitionPlacementDto[];
  blocking: Blocking | null;
};

async function planMapBound(content: ScenarioTemplateV2, source: Side, target: Side, geometry: "same" | "changed"): Promise<Outcome> {
  const subjectId = content.metricSubject ?? content.roles[0]?.id ?? null;
  const subject = content.roles.find((role) => role.id === subjectId);
  let catalogEntries: MaterializeOptions["catalogEntries"];
  try {
    catalogEntries = await catalogEntriesFor(content);
  } catch (error) {
    if (!(error instanceof GalleryCatalogResolutionError)) throw error;
    return { content: null, placements: [], blocking: { code: "actor_catalog_entry_missing", message: error.message } };
  }
  const unplaced = new Set<string>();
  const flags = new Map<string, string[]>();
  const notes = new Map<string, string[]>();
  const placements = (planned: { readonly roles: readonly Role[] } | null, before: Map<string, Start> | null, after: Map<string, Start> | null) =>
    placementsOf({ content, planned, before, after, subjectId, unplaced, flags, notes });

  let before: Map<string, Start>;
  try {
    before = startsOf(resolveExecutionInput(content, source.bundle, "disabled", catalogEntries).concrete.input, source.lanes);
  } catch (error) {
    return {
      content: null,
      placements: placements(null, authoredStarts(content), null),
      blocking: {
        code: "scenario_source_compile_failed",
        message: `The scenario does not compile on its current map version (${source.version.label}), so the move cannot be checked: ${compileFailure(error)}.`,
      },
    };
  }

  const identical = source.version.xodr_sha256 === target.version.xodr_sha256;
  let planned: ScenarioTemplateV2;
  if (geometry === "same") {
    // The road network is the same: positions, lanes and routes carry over exactly.
    planned = retargetIdentity(content, target, target.bundle.graph.digest);
  } else {
    const placedLanes = new Map<string, string>();
    const roles = content.roles.map((role) => {
      if (role.kind !== "scene_absolute") return role;
      const moved = transferSceneRole(role, source, target);
      if (moved.unplaced) unplaced.add(role.id);
      if (moved.reasons.length > 0) flags.set(role.id, moved.reasons);
      const from = sceneLaneRsl(role);
      const to = moved.role.kind === "scene_absolute" ? sceneLaneRsl(moved.role) : null;
      if (from && to) placedLanes.set(from, to);
      return moved.role;
    });
    const { roles: _roles, ...rest } = content;
    const remapped = remapLaneReferences(rest, source, target, placedLanes, "");
    if (remapped.failure) {
      const path = remapped.failure.path.replace(/^\./, "");
      return {
        content: null,
        placements: placements({ roles }, before, authoredStarts({ roles })),
        blocking: {
          code: "scenario_route_unmatched",
          message: `The route in ${interactionName(content, path)} could not be matched on ${target.version.label} at ${at(remapped.failure.at)}: ${remapped.failure.reason}.`,
        },
      };
    }
    planned = retargetIdentity(parseTemplate({ ...(remapped.value as object), roles }), target, target.bundle.graph.digest);
  }
  if (!identical) {
    const grounded = groundOnTarget(planned, target);
    planned = grounded.content;
    for (const [roleId, note] of grounded.notes) notes.set(roleId, [note]);
  }

  if (subject && unplaced.has(subject.id)) {
    return {
      content: null,
      placements: placements(planned, before, authoredStarts(planned)),
      blocking: {
        code: "scenario_subject_unplaced",
        message: `${labelOf(subject)}, the actor this scenario measures, has no lane on ${target.version.label} near where it starts${startAt(before, subject.id)}, so the scenario cannot move there.`,
      },
    };
  }

  let after: Map<string, Start>;
  try {
    after = startsOf(resolveExecutionInput(planned, target.bundle, "disabled", catalogEntries).concrete.input, target.lanes);
  } catch (error) {
    return {
      content: null,
      placements: placements(planned, before, authoredStarts(planned)),
      blocking: {
        code: "scenario_target_compile_failed",
        message: `The scenario does not compile on ${target.version.label}: ${compileFailure(error)}.`,
      },
    };
  }
  return { content: planned, placements: placements(planned, before, after), blocking: null };
}

async function planPortable(content: ScenarioTemplateV2, source: Side, target: Side): Promise<Outcome> {
  const subjectId = content.metricSubject ?? content.roles[0]?.id ?? null;
  const subject = content.roles.find((role) => role.id === subjectId);
  let catalogEntries: MaterializeOptions["catalogEntries"];
  try {
    catalogEntries = await catalogEntriesFor(content);
  } catch (error) {
    if (!(error instanceof GalleryCatalogResolutionError)) throw error;
    return { content: null, placements: [], blocking: { code: "actor_catalog_entry_missing", message: error.message } };
  }
  const unplaced = new Set<string>();
  const flags = new Map<string, string[]>();
  const notes = new Map<string, string[]>();
  const placements = (planned: ScenarioTemplateV2 | null, before: Map<string, Start> | null, after: Map<string, Start> | null) =>
    placementsOf({ content, planned, before, after, subjectId, unplaced, flags, notes });

  let sourceCompile: PortableCompile;
  try {
    sourceCompile = compilePortable(content, source.bundle, catalogEntries);
  } catch (error) {
    return {
      content: null,
      placements: placements(null, null, null),
      blocking: {
        code: "scenario_source_compile_failed",
        message: `The scenario does not compile on its current map version (${source.version.label}), so the move cannot be checked: ${compileFailure(error)}.`,
      },
    };
  }
  const before = startsOf(sourceCompile.compiled.input, source.lanes);
  const pin = content.anchor.pin;
  let planned: ScenarioTemplateV2;
  if (!pin?.siteId || source.bundle.digest === target.bundle.digest) {
    // Unpinned: the matcher places it on any version; same network: its site id still names the place.
    planned = retargetIdentity(content, target, target.bundle.digest);
  } else {
    const origin = siteOrigin(sourceCompile.site, source.lanes);
    const site = origin ? siteAtSameLocation(content, origin, target) : null;
    if (!site) {
      return {
        content: null,
        placements: placements(null, before, null),
        blocking: {
          code: "scenario_site_not_found",
          message: `The place this scenario is set at${origin ? ` ${at(origin)}` : ""} was not found on ${target.version.label} within ${SITE_MATCH_TOLERANCE_M} m, so the scenario cannot move there.`,
        },
      };
    }
    planned = retargetIdentity(content, target, target.bundle.digest, site.siteId);
  }
  let targetCompile: PortableCompile;
  try {
    targetCompile = compilePortable(planned, target.bundle, catalogEntries);
  } catch (error) {
    return {
      content: null,
      placements: placements(planned, before, null),
      blocking: { code: "scenario_target_compile_failed", message: `The scenario does not compile on ${target.version.label}: ${compileFailure(error)}.` },
    };
  }
  const after = startsOf(targetCompile.compiled.input, target.lanes);
  if (subject && !after.has(subject.id)) {
    unplaced.add(subject.id);
    flags.set(subject.id, ["The new map has no place for it at this site."]);
    return {
      content: null,
      placements: placements(planned, before, after),
      blocking: {
        code: "scenario_subject_unplaced",
        message: `${labelOf(subject)}, the actor this scenario measures, could not be placed on ${target.version.label}, so the scenario cannot move there.`,
      },
    };
  }
  return { content: planned, placements: placements(planned, before, after), blocking: null };
}

async function loadSide(version: VersionRow): Promise<Side | Blocking> {
  try {
    const binding = await loadMapVersionBundle(version.id);
    const xodr = await readMapVersionXodr(version.id);
    return { version, binding, bundle: binding.bundle as unknown as MapBundle, lanes: laneIndex(binding.bundle as unknown as MapBundle), xodr };
  } catch (error) {
    if (!(error instanceof CollisionDraftMapUnavailableError)) throw error;
    return { code: "scenario_map_data_unavailable", message: `The map data of ${version.label} is not fully published yet (${error.message}).` };
  }
}

/**
 * Plan moving `document`'s draft from its pinned map version to `targetMapVersionId`, a newer
 * publication of the same map. Refuses (throws {@link SimulationHistoryError}) when the request
 * itself is wrong: an unpinned draft, a target that is not a live version of the same map, or the
 * version it is already on. Anything about the scenario that prevents the move is `blocking`.
 */
export async function planMapTransition(
  context: AppContext,
  document: ScenarioDocumentDto,
  targetMapVersionId: string,
): Promise<ScenarioMapTransitionPlanDto> {
  void context;
  if (!document.mapVersionId) {
    throw new SimulationHistoryError("scenario_map_unpinned", "the scenario is not pinned to a map version", 409);
  }
  if (document.mapVersionId === targetMapVersionId) {
    throw new SimulationHistoryError("scenario_map_transition_same_version", "the scenario is already on that map version", 400);
  }
  const [sourceRow, targetRow] = await Promise.all([readVersion(document.mapVersionId), readVersion(targetMapVersionId)]);
  if (!sourceRow) throw new SimulationHistoryError("scenario_map_version_unavailable", `map version ${document.mapVersionId} does not exist`, 404);
  if (!targetRow || targetRow.retired) {
    throw new SimulationHistoryError("scenario_map_version_unavailable", `map version ${targetMapVersionId} is retired or does not exist`, 404);
  }
  if (!sourceRow.source_map_asset_id || sourceRow.source_map_asset_id !== targetRow.source_map_asset_id) {
    throw new SimulationHistoryError("scenario_map_transition_other_map", `map version ${targetMapVersionId} is not a version of this scenario's map`, 400);
  }
  const geometry = sameRoadGeometry({
    xodr_sha256: targetRow.xodr_sha256,
    pinned_xodr_sha256: sourceRow.xodr_sha256,
    geometry_sha256: targetRow.geometry_sha256,
    pinned_geometry_sha256: sourceRow.geometry_sha256,
  }) ? "same" as const : "changed" as const;
  const base = {
    geometry,
    source: { mapVersionId: sourceRow.id, name: sourceRow.label, publishedAt: sourceRow.created_at },
    target: { mapVersionId: targetRow.id, name: targetRow.label, publishedAt: targetRow.created_at },
    tolerances: {
      keptM: KEPT_TOLERANCE_M,
      movedM: MOVE_TOLERANCE_M,
      laneSearchM: LANE_SEARCH_RADIUS_M,
      routeMatchM: ROUTE_MATCH_TOLERANCE_M,
      siteMatchM: SITE_MATCH_TOLERANCE_M,
    },
  };
  const blocked = (blocking: Blocking): ScenarioMapTransitionPlanDto => ({
    ...base, content: null, placements: [], roads: [], roadsTruncated: false, blocking,
  });

  const source = await loadSide(sourceRow);
  if (!("bundle" in source)) return blocked(source);
  const target = await loadSide(targetRow);
  if (!("bundle" in target)) return blocked(target);

  const content = parseTemplate(document.content);
  const kinds = new Set(content.roles.map((role) => (role.kind === "scene_absolute" ? "bound" : "portable")));
  let outcome: Outcome;
  if (kinds.size > 1) {
    outcome = {
      content: null,
      placements: [],
      blocking: {
        code: "scenario_mixed_placement",
        message: "This scenario mixes actors placed at map positions with actors placed relative to the road layout, so it cannot be moved automatically.",
      },
    };
  } else if (kinds.has("portable")) {
    outcome = await planPortable(content, source, target);
  } else if (content.roles.length === 0) {
    // Nothing placed: only the map identity moves.
    outcome = { content: retargetIdentity(content, target, target.bundle.graph.digest), placements: [], blocking: null };
  } else {
    outcome = await planMapBound(content, source, target, geometry);
  }
  const { roads, truncated } = roadsNear(source, target, outcome.placements);
  return { ...base, ...outcome, roads, roadsTruncated: truncated };
}
