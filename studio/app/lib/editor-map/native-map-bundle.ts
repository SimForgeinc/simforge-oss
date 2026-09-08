import { z } from "zod";
import type { MapAsset } from "@simforge-oss/studio-shared";
import {
  LaneGraph,
  describeLocation,
  parseLaneRef,
  type DerivedTopology,
  type JunctionDescriptor,
  type LaneNode,
  type LaneRef,
  type LocationCatalog,
  type StudioLocation,
  type TopologyIndex,
} from "@simforge-oss/maps";
import { MapTopologyIndexSchema } from "@simforge-oss/maps/topology";
import { queryOne } from "@/app/lib/db/data-api";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import { primeCloudSession } from "@/app/lib/cloud/connection";
import { resolveAuthorizedMapMember } from "@/app/lib/cloud/access";
import { MAP_CACHE_BUCKET, type RegistryMember } from "@/app/lib/cloud/map-registry";
import { ensureMapAsset, resolveCachedMapAsset } from "@/app/lib/map-cache/service";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";
import { gunzipToUtf8 } from "@/app/lib/s3/gzip";
import type { Bounds, LaneSectionRecord, MapRecord, RoadRecord } from "@/app/lib/runtime/map-data";
import type {
  RuntimeMapResponse,
  RuntimeRoadSegment,
  RuntimeRoadSummary,
  RuntimeWaypointRef,
} from "@/app/lib/runtime/runtime-types";
import type {
  ApproachRoad,
  BridgedMapBundle,
  LocalPoint,
  LocationFeatureFlags,
  MapLocation,
} from "./types";

/**
 * The editor-tool bundle for a native map, built from the immutable published
 * closure the editor itself runs on: the topology index (roads, lanes, gates)
 * and the map-intel catalog (`derived/locations.json.gz`) plus its derived
 * topology (`derived/topology-derived.json.gz`). Those three members are
 * required of every registered map version, so a map that opens in the editor
 * always has an assistant context, on any native map — public, owner-installed
 * or published to an account, through the same registry and access gate the
 * asset routes use.
 *
 * Frames: topology polylines are OpenDRIVE-local metres (x east, y north).
 * The tool contract carries that frame verbatim in `generated.roads` and
 * `runtime.road_segments`; `scenePoseForRoadFraction` lowers it to the y-up
 * scene as `(x, z, -y)`, which is `CoordinateFrame.localToScene` at the zero
 * scene origin every published closure is built with. Catalog anchors arrive
 * in scene metres and are lifted back the same way.
 */

export type NativeMapBundleErrorCode =
  | "map_asset_missing"
  | "map_version_not_found"
  | "map_version_mismatch"
  | "map_member_invalid";

export class NativeMapBundleError extends Error {
  override name = "NativeMapBundleError";
  constructor(readonly code: NativeMapBundleErrorCode, message: string) {
    super(message);
  }
}

const TOPOLOGY_MEMBER = "topology-index.json.gz";
const LOCATIONS_MEMBER = "derived/locations.json.gz";
const DERIVED_MEMBER = "derived/topology-derived.json.gz";

/** The catalog fields this adapter reads; the rest of the record is foreign data. */
const RoadAnchorSchema = z.object({
  rsl: z.string(),
  s: z.number(),
  offsetM: z.number(),
  headingRad: z.number(),
  laneType: z.string(),
  distanceM: z.number(),
  junctionId: z.string().optional(),
  gateId: z.string().optional(),
  speedLimitKph: z.number().optional(),
});
const StudioLocationSchema = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  type: z.string(),
  subtype: z.string().optional(),
  tags: z.array(z.string()),
  anchor: z.object({
    geo: z.object({ lat: z.number(), lng: z.number() }),
    scene: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    road: RoadAnchorSchema.nullable(),
  }),
  extent: z
    .object({
      bboxGeo: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      lengthM: z.number().optional(),
      radiusM: z.number().optional(),
    })
    .optional(),
  affordances: z.array(z.string()),
  facts: z.record(z.string(), z.unknown()),
  provenance: z.array(z.object({ source: z.string(), ref: z.string(), confidence: z.number() })),
  quality: z.object({ anchor: z.string(), confidence: z.number() }),
});
const LocationCatalogSchema = z.object({
  catalogRevision: z.string().min(1),
  mapId: z.string(),
  mapAssetId: z.string(),
  locations: z.array(StudioLocationSchema),
  relations: z.array(
    z.object({ from: z.string(), to: z.string(), kind: z.string(), distanceM: z.number(), bearingDeg: z.number() }),
  ),
});
const DerivedTopologySchema = z.object({
  catalogRevision: z.string().min(1),
  segments: z.array(
    z.object({
      id: z.string(),
      laneRefs: z.array(z.string()),
      junctionLaneRefs: z.array(z.string()),
      roadName: z.string(),
    }),
  ),
  junctions: z.array(
    z.object({
      junctionId: z.string(),
      locationId: z.string(),
      centerXY: z.tuple([z.number(), z.number()]),
      sizeM: z.number(),
      arms: z.array(
        z.object({
          index: z.number(),
          bearingDeg: z.number(),
          roadName: z.string(),
          approachLaneRefs: z.array(z.string()),
          exitLaneRefs: z.array(z.string()),
        }),
      ),
      armCount: z.number(),
      control: z.string(),
      internalLaneRefs: z.array(z.string()),
      crossingLocationIds: z.array(z.string()),
    }),
  ),
});

export type NativeMapBundleSources = {
  asset: MapAsset;
  mapVersionId: string;
  topology: TopologyIndex;
  catalog: LocationCatalog;
  derived: Pick<DerivedTopology, "catalogRevision" | "segments" | "junctions">;
};

// ── Geometry helpers ────────────────────────────────────────────────────────

const EMPTY_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };

function boundsFromPoints(points: readonly LocalPoint[]): Bounds {
  if (points.length === 0) return EMPTY_BOUNDS;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function unionBounds(all: readonly Bounds[]): Bounds {
  if (all.length === 0) return EMPTY_BOUNDS;
  const minX = Math.min(...all.map((b) => b.minX));
  const minY = Math.min(...all.map((b) => b.minY));
  const maxX = Math.max(...all.map((b) => b.maxX));
  const maxY = Math.max(...all.map((b) => b.maxY));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function boundsAround(center: LocalPoint, radiusM: number): Bounds {
  return {
    minX: center.x - radiusM,
    minY: center.y - radiusM,
    maxX: center.x + radiusM,
    maxY: center.y + radiusM,
    width: radiusM * 2,
    height: radiusM * 2,
  };
}

/** Scene (y-up, zero origin) back to OpenDRIVE-local `{x, y}`. */
function sceneToLocal(scene: { x: number; z: number }): LocalPoint {
  return { x: scene.x, y: -scene.z };
}

/** Compass bearing (0 = north, clockwise) to the cardinal words the tools speak. */
function bearingToCardinal(bearingDeg: number): string {
  const normalized = ((bearingDeg % 360) + 360) % 360;
  if (normalized >= 337.5 || normalized < 22.5) return "northbound";
  if (normalized < 67.5) return "north-east";
  if (normalized < 112.5) return "eastbound";
  if (normalized < 157.5) return "south-east";
  if (normalized < 202.5) return "southbound";
  if (normalized < 247.5) return "south-west";
  if (normalized < 292.5) return "westbound";
  return "north-west";
}

function roadIdOf(laneRef: string): string {
  return String(parseLaneRef(laneRef as LaneRef).roadId);
}

// ── Roads and lanes ─────────────────────────────────────────────────────────

type NativeRoad = {
  record: RoadRecord;
  summary: RuntimeRoadSummary;
  lanes: LaneNode[];
};

/**
 * Road names, from the derived topology: a junction arm names its own road
 * stub exactly, so arms are claimed first; a segment chain then names the
 * open-road lanes it runs along, never the junction-internal lanes it passes
 * through (those would inherit the chain's most common name).
 */
function roadNamesFromDerived(derived: NativeMapBundleSources["derived"]): Map<string, string> {
  const names = new Map<string, string>();
  const claim = (laneRef: string, name: string) => {
    if (!name) return;
    const roadId = roadIdOf(laneRef);
    if (!names.has(roadId)) names.set(roadId, name);
  };
  for (const junction of derived.junctions) {
    for (const arm of junction.arms) {
      for (const laneRef of arm.approachLaneRefs) claim(laneRef, arm.roadName);
      for (const laneRef of arm.exitLaneRefs) claim(laneRef, arm.roadName);
    }
  }
  for (const segment of derived.segments) {
    const internal = new Set<string>(segment.junctionLaneRefs);
    for (const laneRef of segment.laneRefs) {
      if (!internal.has(laneRef)) claim(laneRef, segment.roadName);
    }
  }
  return names;
}

/**
 * The lane whose geometry stands for the whole road in `RoadRecord.path`: a
 * driving lane nearest the reference line, in OpenDRIVE `s` order so every
 * road reads the same way regardless of which side is driven.
 */
function referencePolyline(lanes: readonly LaneNode[]): LocalPoint[] {
  const ranked = [...lanes].sort((left, right) => {
    const drivingDelta = Number(right.laneType === "driving") - Number(left.laneType === "driving");
    if (drivingDelta !== 0) return drivingDelta;
    return Math.abs(left.laneId) - Math.abs(right.laneId) || left.laneId - right.laneId;
  });
  const lane = ranked[0];
  if (!lane) return [];
  return lane.raw.polyline.map(({ x, y }) => ({ x, y }));
}

function sectionRecord(lanes: readonly LaneNode[]): LaneSectionRecord {
  const count = (laneType: string, side: 1 | -1) =>
    lanes.filter((lane) => lane.laneType === laneType && Math.sign(lane.laneId) === side).length;
  const drivingLeft = count("driving", 1);
  const drivingRight = count("driving", -1);
  return {
    index: 0,
    label: "Native lane section",
    s: 0,
    drivingLeft,
    drivingRight,
    parkingLeft: count("parking", 1),
    parkingRight: count("parking", -1),
    totalDriving: drivingLeft + drivingRight,
    totalWidth: lanes.reduce((sum, lane) => sum + lane.widthM, 0),
    laneTypes: [...new Set(lanes.map((lane) => lane.laneType))].sort(),
    tags: [],
  };
}

function buildRoads(graph: LaneGraph, roadNames: Map<string, string>): Map<string, NativeRoad> {
  const lanesByRoad = new Map<string, LaneNode[]>();
  for (const lane of graph.allLanes()) {
    const roadId = String(lane.raw.roadId);
    const list = lanesByRoad.get(roadId);
    if (list) list.push(lane);
    else lanesByRoad.set(roadId, [lane]);
  }
  const roads = new Map<string, NativeRoad>();
  for (const [roadId, lanes] of lanesByRoad) {
    const bounds = boundsFromPoints(lanes.flatMap((lane) => lane.points));
    const junctionId = lanes.find((lane) => lane.junctionId != null)?.junctionId ?? null;
    const isIntersection = lanes.some((lane) => lane.isJunction);
    const section = sectionRecord(lanes);
    const name = roadNames.get(roadId) ?? "";
    roads.set(roadId, {
      lanes,
      record: {
        id: roadId,
        name,
        junctionId: junctionId ?? "-1",
        isIntersection,
        length: Math.max(0, ...lanes.map((lane) => lane.lengthM)),
        path: referencePolyline(lanes)
          .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
          .join(" "),
        surface: "",
        drivingSurface: "",
        laneLines: [],
        bounds,
        tags: [],
        sections: [section],
        objects: [],
      },
      summary: {
        id: roadId,
        name,
        is_intersection: isIntersection,
        tags: [],
        lane_types: section.laneTypes,
        has_parking: section.parkingLeft + section.parkingRight > 0,
        has_shoulder: section.laneTypes.includes("shoulder"),
        has_sidewalk: section.laneTypes.includes("sidewalk"),
        section_summaries: [],
      },
    });
  }
  return roads;
}

function waypointRef(graph: LaneGraph, rsl: string): RuntimeWaypointRef | null {
  const lane = graph.get(rsl);
  if (!lane) return null;
  return {
    rsl,
    road_id: lane.raw.roadId,
    section_id: lane.raw.section,
    lane_id: lane.laneId,
    lane_type: lane.laneType,
    lane_width: lane.widthM || null,
    is_junction: lane.isJunction,
    junction_id: lane.junctionId == null ? null : Number(lane.junctionId),
  };
}

/** One runtime lane record per topology lane, centreline in travel order. */
function buildRoadSegments(graph: LaneGraph): RuntimeRoadSegment[] {
  return graph.allLanes().map((lane) => {
    const centerline = lane.points.map((point, index) => {
      const before = lane.points[Math.max(0, index - 1)]!;
      const after = lane.points[Math.min(lane.points.length - 1, index + 1)]!;
      return {
        x: point.x,
        y: point.y,
        z: 0,
        yaw: (Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI,
        s: lane.cum[index]!,
      };
    });
    return {
      // Actors are placed on driving lanes; the editor's own drop resolver
      // snaps to the same lane set.
      runtime_bound: lane.laneType === "driving",
      id: lane.rsl as string,
      road_id: lane.raw.roadId,
      section_id: lane.raw.section,
      lane_id: lane.laneId,
      lane_type: lane.laneType,
      is_junction: lane.isJunction,
      lane_width: lane.widthM || null,
      successors: lane.raw.successors
        .map((rsl) => waypointRef(graph, rsl))
        .filter((ref): ref is RuntimeWaypointRef => ref != null),
      predecessors: lane.raw.predecessors
        .map((rsl) => waypointRef(graph, rsl))
        .filter((ref): ref is RuntimeWaypointRef => ref != null),
      centerline,
    };
  });
}

// ── Locations ───────────────────────────────────────────────────────────────

function featureFlags(location: StudioLocation, junction: JunctionDescriptor | null): LocationFeatureFlags {
  const facts = location.facts;
  const control = String(facts["derived_control"] ?? facts["junction_control"] ?? junction?.control ?? "");
  return {
    has_stop_control: control === "all_way_stop" || control === "minor_stop",
    has_crosswalk: location.type === "crosswalk" || (junction?.crossingLocationIds.length ?? 0) > 0,
    has_traffic_light: control === "signalized",
    has_parking: facts["has_parking_adjacent"] === true || location.type.startsWith("parking_"),
    has_sidewalk:
      facts["has_sidewalk_adjacent"] === true || location.type === "sidewalk" || location.type === "walking_corridor",
    has_bike_lane: facts["has_bike_adjacent"] === true || location.type === "bike_corridor",
    road_markings: [],
    signal_categories: control === "signalized" ? ["traffic_light"] : [],
  };
}

/**
 * Selector tags: the catalog's own scenario tags, the closed type vocabulary
 * in upper case, and the intersection selectors the assistant prompt names
 * (`INTERSECTION`, `INTERSECTION_SIGNALIZED`), each derived from a fact the
 * catalog actually carries.
 */
function locationTags(location: StudioLocation, flags: LocationFeatureFlags): string[] {
  const tags = new Set<string>(location.tags);
  tags.add(location.type.toUpperCase());
  if (location.subtype) tags.add(location.subtype.toUpperCase());
  for (const affordance of location.affordances) {
    tags.add(affordance.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase());
  }
  if (location.type === "junction") {
    tags.add("INTERSECTION");
    if (flags.has_traffic_light) tags.add("INTERSECTION_SIGNALIZED");
    if (flags.has_stop_control) tags.add("INTERSECTION_STOP_CONTROLLED");
  }
  if (flags.has_crosswalk) tags.add("CROSSWALK");
  return [...tags].sort();
}

function classification(location: StudioLocation, junction: JunctionDescriptor | null): string {
  if (location.subtype) return location.subtype;
  if (location.type === "junction") {
    const arms = Number(location.facts["arm_count"] ?? junction?.armCount ?? 0);
    const control = String(location.facts["derived_control"] ?? junction?.control ?? "");
    const shape = arms === 4 ? "four-way" : arms === 3 ? "t-junction" : arms > 4 ? `${arms}-leg` : "junction";
    return control ? `${shape} ${control.replace(/_/g, " ")}` : shape;
  }
  if (location.type === "junction_movement") {
    const turn = location.facts["turn_relation"];
    return typeof turn === "string" ? turn.toLowerCase() : location.type;
  }
  return location.type;
}

/** Roads a location touches, placement anchor first. */
function locationRoadIds(
  location: StudioLocation,
  graph: LaneGraph,
  junction: JunctionDescriptor | null,
): string[] {
  const ids: string[] = [];
  const anchor = location.anchor.road;
  if (anchor) ids.push(roadIdOf(anchor.rsl));
  if (junction) {
    for (const arm of junction.arms) {
      for (const laneRef of [...arm.approachLaneRefs, ...arm.exitLaneRefs]) ids.push(roadIdOf(laneRef));
    }
    for (const laneRef of junction.internalLaneRefs) ids.push(roadIdOf(laneRef));
  } else if (anchor?.gateId) {
    const gate = graph.index.gates.find((candidate) => candidate.id === anchor.gateId);
    if (gate) {
      ids.push(roadIdOf(gate.approachLaneRsl), roadIdOf(gate.connectingLaneRsl));
      for (const exit of gate.exitLaneRsls) ids.push(roadIdOf(exit));
    }
  }
  return [...new Set(ids)];
}

function approaches(
  junction: JunctionDescriptor | null,
  roads: Map<string, NativeRoad>,
): ApproachRoad[] | undefined {
  if (!junction) return undefined;
  const seen = new Set<string>();
  const out: ApproachRoad[] = [];
  for (const arm of junction.arms) {
    for (const laneRef of [...arm.approachLaneRefs, ...arm.exitLaneRefs]) {
      const roadId = roadIdOf(laneRef);
      const road = roads.get(roadId);
      if (!road || road.record.isIntersection || seen.has(roadId)) continue;
      seen.add(roadId);
      const section = road.record.sections[0]!;
      out.push({
        road_id: roadId,
        name: road.record.name,
        bearing: bearingToCardinal(arm.bearingDeg),
        lane_config: `${section.totalDriving} driving lane${section.totalDriving === 1 ? "" : "s"}`,
        lane_types: section.laneTypes,
        length_m: road.record.length,
      });
    }
  }
  return out;
}

function locationCenter(location: StudioLocation, graph: LaneGraph): LocalPoint {
  const anchor = location.anchor.road;
  if (anchor) {
    const pose = graph.poseAt(anchor.rsl, anchor.s);
    if (pose) return { x: pose.point.x, y: pose.point.y };
  }
  return sceneToLocal(location.anchor.scene);
}

function buildLocations(sources: NativeMapBundleSources, graph: LaneGraph, roads: Map<string, NativeRoad>): MapLocation[] {
  const junctionsByLocationId = new Map(
    sources.derived.junctions.map((junction) => [junction.locationId as string, junction as JunctionDescriptor]),
  );
  return sources.catalog.locations.map((location) => {
    const junction = junctionsByLocationId.get(location.id as string) ?? null;
    const center = locationCenter(location, graph);
    const radius = location.extent?.radiusM
      ?? (location.extent?.lengthM != null ? location.extent.lengthM / 2 : null)
      ?? junction?.sizeM
      ?? 6;
    const flags = featureFlags(location, junction);
    const road_ids = locationRoadIds(location, graph, junction);
    const anchorQuality = location.quality.anchor;
    return {
      id: location.handle as string,
      source: "native_catalog",
      kind: location.type,
      classification: classification(location, junction),
      label: location.name,
      description: describeLocation(sources.catalog, location.id as string, { maxRelations: 3 }),
      bridge: anchorQuality === "exact" ? "guid" : anchorQuality === "projected" ? "spatial" : "heuristic",
      road_ids,
      road_count: road_ids.length,
      bounds: boundsAround(center, radius),
      center,
      tags: locationTags(location, flags),
      evidence: [
        {
          location_id: location.id,
          catalog_revision: sources.catalog.catalogRevision,
          anchor_lane: location.anchor.road?.rsl ?? null,
          anchor_quality: anchorQuality,
          confidence: location.quality.confidence,
          provenance: location.provenance,
          facts: location.facts,
        },
      ],
      feature_flags: flags,
      approaches: approaches(junction, roads),
      junction_id: junction?.junctionId ?? location.anchor.road?.junctionId ?? undefined,
      related_lane_guids: location.anchor.road ? [location.anchor.road.rsl as string] : [],
      related_feature_ids: junction ? junction.crossingLocationIds.map(String) : [],
      related_road_names: [
        ...new Set(road_ids.map((roadId) => roads.get(roadId)?.record.name ?? "").filter((name) => name.length > 0)),
      ],
    } satisfies MapLocation;
  });
}

// ── Bundle ──────────────────────────────────────────────────────────────────

/** Pure: the tool bundle from decoded closure members. */
export function buildNativeMapBundle(sources: NativeMapBundleSources): BridgedMapBundle {
  if (sources.derived.catalogRevision !== sources.catalog.catalogRevision) {
    throw new NativeMapBundleError(
      "map_member_invalid",
      `${sources.mapVersionId}: derived topology revision ${sources.derived.catalogRevision} does not match catalog revision ${sources.catalog.catalogRevision}`,
    );
  }
  const graph = new LaneGraph(sources.topology);
  const roads = buildRoads(graph, roadNamesFromDerived(sources.derived));
  const roadRecords = [...roads.values()].map((road) => road.record).sort((a, b) => Number(a.id) - Number(b.id));
  const locations = buildLocations(sources, graph, roads);
  const laneTypes: Record<string, number> = {};
  for (const lane of graph.allLanes()) laneTypes[lane.laneType] = (laneTypes[lane.laneType] ?? 0) + 1;

  const generated: MapRecord = {
    name: sources.topology.mapName,
    fileName: sources.topology.mapName,
    optimized: true,
    bounds: unionBounds(roadRecords.map((road) => road.bounds)),
    stats: {
      roads: roadRecords.length,
      junctionDefinitions: Object.keys(sources.topology.junctions).length,
      laneTypes,
      featureCounts: {
        intersection: locations.filter((location) => location.kind === "junction").length,
        parking: locations.filter((location) => location.kind.startsWith("parking_")).length,
        single_lane_road: 0,
        single_lane_each_way: 0,
        two_lane_one_way: 0,
        two_lane_each_way: 0,
        crosswalk: locations.filter((location) => location.kind === "crosswalk").length,
        stop_control: locations.filter((location) => location.feature_flags.has_stop_control).length,
      },
    },
    roads: roadRecords,
    crosswalks: [],
    stopMarkers: [],
  };
  const runtime: RuntimeMapResponse = {
    schema_version: 1,
    schema: { source: "native_map_closure", coordinates: "xodr_local" },
    map_name: sources.topology.mapName,
    normalized_map_name: sources.topology.mapName,
    map_info: { opendrive_sha256: sources.topology.source?.xodrSha256 ?? null },
    road_segments: buildRoadSegments(graph),
    road_summaries: roadRecords.map((road) => roads.get(road.id)!.summary),
    dataset_augmented: false,
  };

  return {
    asset: sources.asset,
    bundle_version: sources.catalog.catalogRevision,
    runtime_bundle_key: sources.mapVersionId,
    candidate_locations: [],
    enrichment: null,
    geojson: { type: "FeatureCollection", features: [] },
    geojson_url: null,
    signals_geojson: null,
    generated,
    runtime,
    xodr: null,
    street_furniture: null,
    locations,
    bridge_summary: {
      lane_guid_count: graph.lanes.size,
      candidate_location_count: 0,
      derived_location_count: locations.length,
    },
    carla_status: {
      connected: false,
      current_map: null,
      normalized_map_name: null,
      server_version: null,
      client_version: null,
      available_maps: [],
      warnings: [],
    },
    map_match: true,
  };
}

// ── Loading ─────────────────────────────────────────────────────────────────

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

async function readMemberJson(mapVersionId: string, relativePath: string): Promise<unknown> {
  const { member } = await resolveAuthorizedMapMember({
    kind: "map",
    mapVersionId,
    profile: "browser",
    relativePath,
  });
  await makeResident(mapVersionId, relativePath, member);
  const bytes = await getS3ObjectBytes(member.bucket, member.key);
  const text = bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1
    ? await gunzipToUtf8(bytes)
    : Buffer.from(bytes).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new NativeMapBundleError(
      "map_member_invalid",
      `${mapVersionId}/${relativePath} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Downloaded maps live in the content-addressed cache; fetch on a miss, as the asset route does. */
async function makeResident(mapVersionId: string, relativePath: string, member: RegistryMember): Promise<void> {
  if (member.bucket !== MAP_CACHE_BUCKET || (await resolveCachedMapAsset(member.sha256))) return;
  await ensureMapAsset({
    requestId: `assistant:${member.sha256}:${Date.now()}`,
    url: `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/browser-assets/${
      relativePath.split("/").map(encodeURIComponent).join("/")}`,
    sha256: member.sha256,
    sizeBytes: member.byteLength,
  });
}

function parseMember<T>(schema: z.ZodType<T>, payload: unknown, mapVersionId: string, relativePath: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new NativeMapBundleError(
      "map_member_invalid",
      `${mapVersionId}/${relativePath} does not match its schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

/** Decoded closure members, checked against the shapes the builder reads. */
export function decodeNativeMapSources(input: {
  asset: MapAsset;
  mapVersionId: string;
  topology: unknown;
  catalog: unknown;
  derived: unknown;
}): NativeMapBundleSources {
  const { mapVersionId } = input;
  const topology = parseMember(MapTopologyIndexSchema, input.topology, mapVersionId, TOPOLOGY_MEMBER);
  const catalog = parseMember(LocationCatalogSchema, input.catalog, mapVersionId, LOCATIONS_MEMBER);
  const derived = parseMember(DerivedTopologySchema, input.derived, mapVersionId, DERIVED_MEMBER);
  return {
    asset: input.asset,
    mapVersionId,
    // The topology index the closure carries is the very shape map-intel was
    // built over; the two declarations differ only in optionality spelling.
    topology: topology as unknown as TopologyIndex,
    catalog: catalog as unknown as LocationCatalog,
    derived: derived as unknown as NativeMapBundleSources["derived"],
  };
}

async function loadSources(asset: MapAsset, mapVersionId: string): Promise<NativeMapBundleSources> {
  const [topology, catalog, derived] = await Promise.all([
    readMemberJson(mapVersionId, TOPOLOGY_MEMBER),
    readMemberJson(mapVersionId, LOCATIONS_MEMBER),
    readMemberJson(mapVersionId, DERIVED_MEMBER),
  ]);
  return decodeNativeMapSources({ asset, mapVersionId, topology, catalog, derived });
}

const MAX_CACHED_BUNDLES = 4;
const cache = new Map<string, BridgedMapBundle>();
const inFlight = new Map<string, Promise<BridgedMapBundle>>();

function remember(mapVersionId: string, bundle: BridgedMapBundle): void {
  cache.delete(mapVersionId);
  cache.set(mapVersionId, bundle);
  while (cache.size > MAX_CACHED_BUNDLES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export type NativeMapBundleInput = {
  /** `public.map_assets.id` — the source map the editor document names. */
  mapAssetId: string;
  /** The immutable published map version the document is open on. */
  mapVersionId: string;
};

/**
 * The tool bundle for one published native map version. Access is the map
 * registry's own gate: a map published to accounts needs this installation's
 * Cloud session to be active, exactly as serving its bytes does.
 */
export async function getNativeMapBundle(input: NativeMapBundleInput): Promise<BridgedMapBundle> {
  const mapAssetId = input.mapAssetId.trim();
  const mapVersionId = input.mapVersionId.trim();
  const asset = await getMapAssetByIdFromDb(mapAssetId);
  if (!asset) {
    throw new NativeMapBundleError("map_asset_missing", `Unknown map asset: ${mapAssetId}`);
  }
  const version = await queryOne<{ source_map_asset_id: string | null }>(
    `SELECT source_map_asset_id FROM simforge.map_versions
     WHERE id = :map_version_id AND retired_at IS NULL`,
    { map_version_id: mapVersionId },
  );
  if (!version) {
    throw new NativeMapBundleError("map_version_not_found", `Unknown map version: ${mapVersionId}`);
  }
  if (version.source_map_asset_id !== mapAssetId) {
    throw new NativeMapBundleError(
      "map_version_mismatch",
      `Map version ${mapVersionId} belongs to ${version.source_map_asset_id ?? "no map asset"}, not ${mapAssetId}`,
    );
  }

  const cached = cache.get(mapVersionId);
  if (cached) return cached;
  const pending = inFlight.get(mapVersionId);
  if (pending) return pending;
  const load = (async () => {
    await primeCloudSession();
    const bundle = buildNativeMapBundle(await loadSources(asset, mapVersionId));
    remember(mapVersionId, bundle);
    return bundle;
  })();
  inFlight.set(mapVersionId, load);
  try {
    return await load;
  } finally {
    if (inFlight.get(mapVersionId) === load) inFlight.delete(mapVersionId);
  }
}

export function __clearNativeMapBundleCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
