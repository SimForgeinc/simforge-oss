import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import type { MapAsset } from "@simforge-oss/studio-shared";
import { executeEditorTool } from "../../editor-tools/registry";
import type { EditorToolContext } from "../../editor-tools/types";
import { buildNativeMapBundle, NativeMapBundleError, type NativeMapBundleSources } from "../native-map-bundle";

const LocationMatches = z.object({
  total_matches: z.number(),
  items: z.array(
    z.object({
      id: z.string(),
      road_ids: z.array(z.string()),
      classification: z.string(),
      feature_flags: z.object({ has_traffic_light: z.boolean() }),
    }),
  ),
});
const RoadSelection = z.object({
  selected_road_ids: z.array(z.string()),
  roads: z.array(
    z.object({ road_id: z.string(), name: z.string(), lane_types: z.array(z.string()), is_intersection: z.boolean() }),
  ),
});
const ToolMessage = z.object({ message: z.string() });

/**
 * A two-road map with one signalised junction, in the shapes the published
 * closure carries: topology index lanes/gates, a map-intel catalog and its
 * derived topology. Main St runs east along y = 0 into junction J1, whose
 * connecting lane turns left onto First Ave, which runs north along x = 60.
 */
const REVISION = "sha256:catalog-fixture";
const JUNCTION_LOCATION = "loc_0123456789abcdef01234567";
const MOVEMENT_LOCATION = "loc_89abcdef0123456789abcdef";
const MIDBLOCK_LOCATION = "loc_fedcba9876543210fedcba98";
const ENTRANCE_LOCATION = "loc_00112233445566778899aabb";

function line(from: [number, number], to: [number, number], steps = 5) {
  return Array.from({ length: steps + 1 }, (_, index) => ({
    x: from[0] + ((to[0] - from[0]) * index) / steps,
    y: from[1] + ((to[1] - from[1]) * index) / steps,
  }));
}

const lane = (
  rsl: string,
  laneType: string,
  polyline: Array<{ x: number; y: number }>,
  extra: Partial<NativeMapBundleSources["topology"]["lanes"][string]> = {},
) => {
  const [roadId, section, laneId] = rsl.split(":").map(Number) as [number, number, number];
  return {
    rsl,
    roadId,
    section,
    laneId,
    laneType,
    isJunction: false,
    junctionId: null,
    predecessors: [],
    successors: [],
    speedLimitKph: 40,
    representativeWidthM: 3.5,
    polyline,
    ...extra,
  };
};

const ASSET: MapAsset = {
  map_asset_id: "fixture-town",
  name: "Fixture Town",
  crs: "OpenDRIVE",
  bbox: { min_lat: 0, min_lng: 0, max_lat: 1, max_lng: 1 },
  center: { lat: 0.5, lng: 0.5 },
  created_at: new Date(0).toISOString(),
  artifacts: [],
};

function fixtureSources(): NativeMapBundleSources {
  return {
    asset: ASSET,
    mapVersionId: "usmap_fixture",
    topology: {
      schemaVersion: 3,
      mapName: "fixture-town",
      source: { xodrSha256: "a".repeat(64) },
      lanes: {
        "1:0:-1": lane("1:0:-1", "driving", line([0, 0], [50, 0]), { successors: ["2:0:-1"] }),
        "1:0:1": lane("1:0:1", "driving", line([0, 0], [50, 0])),
        "1:0:-2": lane("1:0:-2", "sidewalk", line([0, -4], [50, -4])),
        "2:0:-1": lane("2:0:-1", "driving", line([50, 0], [60, 10]), {
          isJunction: true,
          junctionId: "J1",
          predecessors: ["1:0:-1"],
          successors: ["3:0:-1"],
        }),
        "3:0:-1": lane("3:0:-1", "driving", line([60, 10], [60, 60]), { predecessors: ["2:0:-1"] }),
      },
      gates: [
        {
          id: "J1:0:-1--1",
          junctionId: "J1",
          turnRelation: "Left",
          headingChangeRad: Math.PI / 2,
          connectingLaneRsl: "2:0:-1",
          approachLaneRsl: "1:0:-1",
          exitLaneRsls: ["3:0:-1"],
        },
      ],
      junctions: {
        J1: { junctionId: "J1", gateIds: ["J1:0:-1--1"], internalLaneRsls: ["2:0:-1"], approachLaneRsls: ["1:0:-1"] },
      },
    },
    catalog: {
      catalogVersion: 1,
      catalogRevision: REVISION,
      mapId: "fixture-town",
      mapAssetId: "fixture-town",
      builtAt: "2026-09-08T00:00:00.000Z",
      sourceHashes: {},
      locations: [
        {
          id: JUNCTION_LOCATION,
          handle: "junction/main-st-at-first-ave",
          name: "Main St @ First Ave",
          type: "junction",
          tags: [],
          anchor: {
            geo: { lat: 0, lng: 0 },
            scene: { x: 55, y: 0, z: -5 },
            road: { rsl: "2:0:-1", s: 7, offsetM: 0, headingRad: Math.PI / 4, laneType: "driving", distanceM: 0, junctionId: "J1" },
          },
          affordances: ["conflictPoint", "route"],
          facts: { derived_control: "signalized", arm_count: 2 },
          provenance: [{ source: "topology-index", ref: "J1", confidence: 1 }],
          quality: { anchor: "exact", confidence: 1 },
        },
        {
          id: MOVEMENT_LOCATION,
          handle: "junction_movement/main-st-left-at-first-ave",
          name: "Main St left onto First Ave",
          type: "junction_movement",
          tags: [],
          anchor: {
            geo: { lat: 0, lng: 0 },
            scene: { x: 55, y: 0, z: -5 },
            road: { rsl: "2:0:-1", s: 7, offsetM: 0, headingRad: Math.PI / 4, laneType: "driving", distanceM: 0, junctionId: "J1", gateId: "J1:0:-1--1" },
          },
          affordances: ["route", "vehicleSpawn"],
          facts: { turn_relation: "Left", junction_control: "signalized" },
          provenance: [{ source: "topology-index", ref: "J1:0:-1--1", confidence: 1 }],
          quality: { anchor: "exact", confidence: 1 },
        },
        {
          id: MIDBLOCK_LOCATION,
          handle: "midblock_segment/main-st-e",
          name: "Main St eastbound midblock",
          type: "midblock_segment",
          tags: ["PARKED_CAR_PULLOUT"],
          anchor: {
            geo: { lat: 0, lng: 0 },
            scene: { x: 25, y: 0, z: 0 },
            road: { rsl: "1:0:-1", s: 25, offsetM: 0, headingRad: 0, laneType: "driving", distanceM: 0 },
          },
          extent: { bboxGeo: [0, 0, 0, 0], lengthM: 40 },
          affordances: ["vehicleSpawn", "parkedVehicle"],
          facts: { has_parking_adjacent: true, road_name: "Main St" },
          provenance: [{ source: "topology-index", ref: "1:0:-1", confidence: 1 }],
          quality: { anchor: "exact", confidence: 0.9 },
        },
        {
          id: ENTRANCE_LOCATION,
          handle: "building_entrance/12-main-st",
          name: "12 Main St",
          type: "building_entrance",
          tags: [],
          anchor: { geo: { lat: 0, lng: 0 }, scene: { x: 20, y: 0, z: 30 }, road: null },
          affordances: ["pedestrianSpawn"],
          facts: { address_formatted: "12 Main St" },
          provenance: [{ source: "map-geojson", ref: "b-12", confidence: 0.8 }],
          quality: { anchor: "unanchored", confidence: 0.6 },
        },
      ] as unknown as NativeMapBundleSources["catalog"]["locations"],
      relations: [],
      stats: {} as NativeMapBundleSources["catalog"]["stats"],
    } as NativeMapBundleSources["catalog"],
    derived: {
      catalogRevision: REVISION,
      segments: [
        {
          id: "seg_0123456789abcdef",
          laneRefs: ["1:0:-1", "2:0:-1", "3:0:-1"],
          junctionLaneRefs: ["2:0:-1"],
          roadName: "Main St",
        },
      ] as unknown as NativeMapBundleSources["derived"]["segments"],
      junctions: [
        {
          junctionId: "J1",
          locationId: JUNCTION_LOCATION,
          centerXY: [55, 5],
          sizeM: 12,
          arms: [
            { index: 0, bearingDeg: 270, roadName: "Main St", approachLaneRefs: ["1:0:-1"], exitLaneRefs: [], inboundLaneCount: 1, outboundLaneCount: 0 },
            { index: 1, bearingDeg: 0, roadName: "First Ave", approachLaneRefs: [], exitLaneRefs: ["3:0:-1"], inboundLaneCount: 0, outboundLaneCount: 1 },
          ],
          armCount: 2,
          approaches: [],
          control: "signalized",
          controlEvidence: [],
          internalLaneRefs: ["2:0:-1"],
          crossingLocationIds: [],
          conflictPairs: [],
        },
      ] as unknown as NativeMapBundleSources["derived"]["junctions"],
    },
  };
}

function toolContext(overrides: Partial<EditorToolContext> = {}): EditorToolContext {
  return {
    mapAssetId: ASSET.map_asset_id,
    bundle: buildNativeMapBundle(fixtureSources()),
    selectedRoadIds: [],
    selectedLocation: null,
    ...overrides,
  };
}

test("the assistant's catalog exposes the intersection selectors the prompt names", async () => {
  const catalog = await executeEditorTool("get_location_catalog", {}, toolContext());
  const selectors = z.array(z.string()).parse(catalog.result);
  assert.ok(selectors.includes("tag:INTERSECTION"), selectors.join(", "));
  assert.ok(selectors.includes("tag:INTERSECTION_SIGNALIZED"));
  assert.ok(selectors.includes("tag:PARKED_CAR_PULLOUT"), "catalog scenario tags survive");
});

test("get_location resolves a signalised junction to the roads that meet there", async () => {
  const execution = await executeEditorTool(
    "get_location",
    { selectors: ["tag:INTERSECTION_SIGNALIZED"] },
    toolContext(),
  );
  const result = LocationMatches.parse(execution.result);
  assert.equal(result.total_matches, 1);
  const junction = result.items[0]!;
  assert.equal(junction.id, "junction/main-st-at-first-ave");
  assert.deepEqual([...junction.road_ids].sort(), ["1", "2", "3"]);
  assert.equal(junction.classification, "junction signalized");
  assert.equal(junction.feature_flags.has_traffic_light, true);
});

test("a junction movement is classified by its turn and bridged through its gate", () => {
  const bundle = buildNativeMapBundle(fixtureSources());
  const movement = bundle.locations.find((location) => location.id === "junction_movement/main-st-left-at-first-ave")!;
  assert.equal(movement.classification, "left");
  assert.deepEqual([...movement.road_ids].sort(), ["1", "2", "3"]);
  assert.equal(movement.junction_id, "J1");
});

test("an unanchored catalog record is searchable but names no road", () => {
  const bundle = buildNativeMapBundle(fixtureSources());
  const entrance = bundle.locations.find((location) => location.id === "building_entrance/12-main-st")!;
  assert.deepEqual(entrance.road_ids, []);
  // Scene (y-up) lifted back to OpenDRIVE-local: (x, -z).
  assert.deepEqual(entrance.center, { x: 20, y: -30 });
  assert.equal(entrance.bridge, "heuristic");
});

test("road records carry the derived road names and lane make-up the selection tools read", async () => {
  const execution = await executeEditorTool(
    "manage_selected_roads",
    { action: "replace", source: "manual", manualRoadIds: ["1", "3"] },
    toolContext(),
  );
  const result = RoadSelection.parse(execution.result);
  assert.deepEqual(result.selected_road_ids, ["1", "3"]);
  const main = result.roads.find((road) => road.road_id === "1")!;
  assert.equal(main.name, "Main St");
  assert.deepEqual(main.lane_types, ["driving", "sidewalk"]);
  assert.equal(main.is_intersection, false);
  // The exit stub is named by its junction arm, not by the chain running through it.
  assert.equal(result.roads.find((road) => road.road_id === "3")?.name, "First Ave");
  const bundle = buildNativeMapBundle(fixtureSources());
  const connector = bundle.generated?.roads.find((road) => road.id === "2");
  assert.equal(connector?.isIntersection, true);
  assert.equal(connector?.junctionId, "J1");
  assert.equal(connector?.name, "", "a junction-internal road takes no chain name");
});

test("an actor placed by road fraction lands on the lane centreline in the editor's scene frame", async () => {
  const execution = await executeEditorTool(
    "manage_actors",
    { action: "add", actorToolId: "car", roadId: "1", fraction: 0.5 },
    toolContext({ selectedRoadIds: ["1"] }),
  );
  assert.equal(execution.ok, true);
  const action = execution.uiActions.find((candidate) => candidate.type === "add_actor");
  assert.ok(action && action.type === "add_actor");
  // Lane 1:0:-1 travels east along y = 0; midpoint (25, 0) in OpenDRIVE-local is
  // scene (25, 0, -0) with heading 0.
  assert.deepEqual(action.scenePose, { x: 25, y: 0, z: -0, headingRad: 0 });
});

test("a placement on a road that has no lane geometry is refused, not invented", async () => {
  const sources = fixtureSources();
  sources.topology.lanes["9:0:-1"] = lane("9:0:-1", "driving", []);
  const execution = await executeEditorTool(
    "manage_actors",
    { action: "add", actorToolId: "car", roadId: "9", fraction: 0.5 },
    { ...toolContext({ selectedRoadIds: ["9"] }), bundle: buildNativeMapBundle(sources) },
  );
  assert.equal(execution.ok, false);
  assert.match(ToolMessage.parse(execution.result).message, /not available in the loaded map bundle/);
});

test("catalog and derived topology from different builds are refused", () => {
  const sources = fixtureSources();
  sources.derived = { ...sources.derived, catalogRevision: "sha256:other" };
  assert.throws(
    () => buildNativeMapBundle(sources),
    (error: unknown) => error instanceof NativeMapBundleError && error.code === "map_member_invalid",
  );
});
