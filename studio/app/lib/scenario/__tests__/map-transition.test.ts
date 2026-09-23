import "../../models/__tests__/test-env";
// Authoritative traces (the saved before's simulation) are local objects signed with the host token.
process.env.SIMFORGE_LOCAL_HOST_TOKEN ??= "map-transition-test-token";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { buildXodrElevationResolver, createMapBundle, liftMapBoundTemplate, matchSites } from "@simforge-oss/compiler/node";
import type { TopologyIndex } from "@simforge-oss/engine";
import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../auth/session";
import type { AppContext } from "../../db/app-context";
import { execute, queryOne, shutdownDatabase } from "../../db/data-api";
import { createScenarioDocument } from "../document-store";
import { listDocumentVersions, moveDraftToMapVersion, restoreVersionToDraft } from "../sim-history";
import { setSimulationExecutorForTests } from "../sim-result-store";
import { fakeAuthoritativeSimulation } from "./sim-fixtures";
import { writeLocalObject } from "../../s3/s3-object";
import type { ScenarioDocumentDto } from "../contracts";
import { KEPT_TOLERANCE_M, LANE_SEARCH_RADIUS_M, MOVE_TOLERANCE_M, planMapTransition } from "../map-transition";
import {
  diffXodrRoads,
  LaneGeometryIndex,
  matchLaneChain,
  nearestLane,
  poseAt,
  projectOntoLane,
} from "../map-transition-geometry";
import { seedPinnedMap, setMembers, SIMULATION_MEMBERS } from "./pinning-fixtures";

/**
 * Moving a scenario to a newer publication of its map (map-transition.ts), on the committed
 * Richmond Field Station closure (fixtures/golden-traces/maps). The newer publications are made
 * from it: B changes only road 68's elevation (same road geometry), C bends road 68 sideways by up
 * to 0.6 m and road 51 by up to 2.5 m, ends kept on their junctions (changed geometry), D moves
 * road 68 30 m away (its lane is gone from where the subject stood).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "../../../../../fixtures/golden-traces/maps/richmond-field-station");
const MAP = "richmond-field-station";
const context = { userId: LOCAL_USER_ID, workspaceId: LOCAL_WORKSPACE_ID, organizationId: LOCAL_ORGANIZATION_ID } as AppContext;

const gz = (file: string) => readFileSync(join(DIR, file));
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const XODR_A = gunzipSync(gz("map.xodr.gz")).toString("utf8");
const TOPOLOGY_A = JSON.parse(gunzipSync(gz("topology-index.json.gz")).toString("utf8")) as TopologyIndex;
const DERIVED_A = JSON.parse(gunzipSync(gz("derived/topology-derived.json.gz")).toString("utf8")) as Record<string, unknown>;
const LOCATIONS = gz("derived/locations.json.gz");
const SIGNALS = gz("signals.geojson.gz");
const LANES_A = new LaneGeometryIndex(TOPOLOGY_A);

/** Unit normal (left of storage direction) at the middle of a lane. */
function normalOf(rsl: string): { x: number; y: number } {
  const lane = LANES_A.lane(rsl)!;
  const mid = poseAt(lane, lane.length / 2);
  // Travel heading; its left normal. For a negative lane id travel runs along storage.
  return { x: -Math.sin(mid.headingRad), y: Math.cos(mid.headingRad) };
}

function roadElement(xodr: string, roadId: string): string {
  const match = new RegExp(`<road\\b[^>]*\\bid="${roadId}"[^>]*>[\\s\\S]*?</road>`).exec(xodr);
  assert.ok(match, `road ${roadId} in the fixture`);
  return match[0];
}

const num = (value: number) => value.toExponential(16);

function shiftRoadXodr(xodr: string, roadId: string, dx: number, dy: number): string {
  const road = roadElement(xodr, roadId);
  const moved = road.replace(/<geometry\b([^>]*)>/g, (tag) =>
    tag
      .replace(/\sx="([^"]+)"/, (_m, x: string) => ` x="${num(Number(x) + dx)}"`)
      .replace(/\sy="([^"]+)"/, (_m, y: string) => ` y="${num(Number(y) + dy)}"`));
  return xodr.replace(road, moved);
}

function raiseRoadXodr(xodr: string, roadId: string, dz: number): string {
  const road = roadElement(xodr, roadId);
  const raised = road.replace(/<elevation\b([^>]*)\/>/g, (tag) => tag.replace(/\sa="([^"]+)"/, (_m, a: string) => ` a="${num(Number(a) + dz)}"`));
  assert.notEqual(raised, road, `road ${roadId} has an elevation profile`);
  return xodr.replace(road, raised);
}

function shiftRoadTopology(topology: TopologyIndex, roadId: number, dx: number, dy: number): TopologyIndex {
  const lanes = Object.fromEntries(Object.entries(topology.lanes).map(([rsl, lane]) => [
    rsl,
    lane.roadId !== roadId ? lane : {
      ...lane,
      polyline: lane.polyline.map((p) => (Array.isArray(p) ? [p[0] + dx, p[1] + dy] : { x: p.x + dx, y: p.y + dy })),
    },
  ]));
  return { ...topology, lanes } as TopologyIndex;
}

/**
 * Realign a road without breaking the network: every lane of it bends sideways by
 * `amplitude * sin(π f)` at fraction `f` of its length, so its ends stay on the junctions.
 */
function bendRoadTopology(topology: TopologyIndex, roadId: number, amplitude: number): TopologyIndex {
  const lanes = Object.fromEntries(Object.entries(topology.lanes).map(([rsl, lane]) => {
    if (lane.roadId !== roadId) return [rsl, lane];
    const points = lane.polyline.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
    const cum = [0];
    for (let i = 1; i < points.length; i += 1) cum.push(cum[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
    const length = cum[cum.length - 1]!;
    const bent = points.map((p, i) => {
      const a = points[Math.max(0, i - 1)]!;
      const b = points[Math.min(points.length - 1, i + 1)]!;
      const h = Math.atan2(b.y - a.y, b.x - a.x);
      const d = amplitude * Math.sin(Math.PI * (cum[i]! / length));
      return { x: p.x - Math.sin(h) * d, y: p.y + Math.cos(h) * d };
    });
    return [rsl, { ...lane, polyline: bent }];
  }));
  return { ...topology, lanes } as TopologyIndex;
}

/** The OpenDRIVE side of a bend: the interior plan-view records move, the first and last stay. */
function bendRoadXodr(xodr: string, roadId: string, amplitude: number): string {
  const road = roadElement(xodr, roadId);
  const records = road.match(/<geometry\b[^>]*>/g) ?? [];
  let index = -1;
  const moved = road.replace(/<geometry\b[^>]*>/g, (tag) => {
    index += 1;
    if (index === 0 || index === records.length - 1) return tag;
    return tag.replace(/\sy="([^"]+)"/, (_m, y: string) => ` y="${num(Number(y) + amplitude)}"`);
  });
  assert.notEqual(moved, road, `road ${roadId} has interior plan-view records`);
  return xodr.replace(road, moved);
}

type Version = { id: string; label: string; xodr: string; topology: TopologyIndex; geometrySha256: string | null };

/** A publication: OpenDRIVE and topology as given; the derived index carries its own topology digest. */
function version(id: string, label: string, xodr: string, topology: TopologyIndex, geometrySha256: string | null = null): Version {
  const xodrSha = sha256(xodr);
  return {
    id,
    label,
    xodr,
    topology: { ...topology, source: { ...topology.source, xodrSha256: id === "usmapv_mt_a" ? topology.source?.xodrSha256 : xodrSha } },
    geometrySha256,
  };
}

const offset = (rsl: string, metres: number) => {
  const n = normalOf(rsl);
  return { dx: n.x * metres, dy: n.y * metres };
};
const BEND_68 = 0.6;
const BEND_51 = 2.5;
const GONE_68 = offset("68:0:-1", 30);

const GEOMETRY_AB = "9".repeat(64);
const A = version("usmapv_mt_a", "Richmond v1", XODR_A, TOPOLOGY_A, GEOMETRY_AB);
const B = version("usmapv_mt_b", "Richmond v2 (heights)", raiseRoadXodr(XODR_A, "68", 0.5), TOPOLOGY_A, GEOMETRY_AB);
const C = version(
  "usmapv_mt_c",
  "Richmond v3 (realigned)",
  bendRoadXodr(bendRoadXodr(XODR_A, "68", BEND_68), "51", BEND_51),
  bendRoadTopology(bendRoadTopology(TOPOLOGY_A, 68, BEND_68), 51, BEND_51),
);
const D = version("usmapv_mt_d", "Richmond v4 (road 68 moved)", shiftRoadXodr(XODR_A, "68", GONE_68.dx, GONE_68.dy), shiftRoadTopology(TOPOLOGY_A, 68, GONE_68.dx, GONE_68.dy));

async function artifact(id: string, kind: string, bytes: Uint8Array): Promise<string> {
  await writeLocalObject("local-artifacts", id, bytes);
  await execute(
    `INSERT INTO simforge.artifacts (
       id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key, sha256, byte_length,
       artifact_state, producer_job_family, producer_job_id, provenance
     ) VALUES (
       :id, :workspace_id, :kind, 'application/octet-stream', 'local-artifacts', :id, :sha256, :bytes,
       'available', 'openscenario_compile', :job, CAST(:provenance AS jsonb)
     ) ON CONFLICT (id) DO NOTHING`,
    {
      id, workspace_id: LOCAL_WORKSPACE_ID, kind, sha256: sha256(bytes), bytes: bytes.byteLength, job: `seed:${id}`,
      provenance: { contract: "uniscenario.artifact-provenance/v1", producerJobFamily: "openscenario_compile", producerJobId: `seed:${id}` },
    },
  );
  return id;
}

let shared: { locations: string; signals: string } | null = null;

async function publish(v: Version, createdAt: string): Promise<void> {
  shared ??= {
    locations: await artifact("usart_mt_locations", "map-locations-v2", LOCATIONS),
    signals: await artifact("usart_mt_signals", "map-signals-v2", SIGNALS),
  };
  const topologyText = JSON.stringify(v.topology);
  const derived = v.id === A.id ? DERIVED_A : { ...DERIVED_A, topologyDigest: sha256(topologyText) };
  const xodr = await artifact(`${v.id}_xodr`, "source-map-xodr", new TextEncoder().encode(v.xodr));
  const topology = await artifact(`${v.id}_topology`, "map-topology-v2", new TextEncoder().encode(topologyText));
  const derivedId = await artifact(`${v.id}_derived`, "map-derived-topology-v2", new TextEncoder().encode(JSON.stringify(derived)));
  await execute(
    `INSERT INTO simforge.map_versions (
       id, workspace_id, source_map_id, source_map_asset_id, label, browser_manifest_url, topology_artifact_url,
       xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256, descriptor, asset_catalog_version_id,
       topology_artifact_id, derived_topology_artifact_id, locations_artifact_id, signals_artifact_id, created_at
     ) VALUES (:id, :workspace_id, :map, :map, :label, 'local://manifest', 'local://topology',
       :xodr, :xodr_sha, 'epsg:32610', :coordinate, CAST(:descriptor AS jsonb), 'usacv_pin',
       :topology, :derived, :locations, :signals, CAST(:created_at AS timestamptz)) ON CONFLICT (id) DO NOTHING`,
    {
      id: v.id, workspace_id: LOCAL_WORKSPACE_ID, map: MAP, label: v.label, xodr, xodr_sha: sha256(v.xodr), coordinate: "c".repeat(64),
      descriptor: v.geometrySha256 ? { xodrGeometrySha256: v.geometrySha256 } : {},
      topology, derived: derivedId, locations: shared.locations, signals: shared.signals, created_at: createdAt,
    },
  );
}

function laneActor(id: string, rsl: string, s: number, options: { label: string; route?: string[] }) {
  const lane = LANES_A.lane(rsl)!;
  const p = poseAt(lane, s);
  const [roadId, section, laneId] = rsl.split(":");
  return {
    id,
    kind: "scene_absolute",
    label: options.label,
    actor: { class: "car", catalogId: "vehicle.sedan" },
    pose: { position: { x: p.x, y: 0, z: -p.y }, headingRad: p.headingRad },
    laneRef: { roadId, section: Number(section), laneId: Number(laneId), s, t: 0, headingOffsetRad: 0 },
    initialSpeedKph: 20,
    ...(options.route ? { initialRoute: { mode: "lanePath", lanes: options.route } } : {}),
  };
}

/** Ego on road 68, a lead car on road 51, a pedestrian standing free near road 68. */
function mapBoundContent(): ScenarioTemplateV2 {
  const ped = poseAt(LANES_A.lane("68:0:-1")!, 60, 8);
  return parseTemplate({
    scenarioVersion: 2,
    meta: {
      name: "Map transition",
      description: "",
      createdAt: "2026-09-22T00:00:00.000Z",
      modifiedAt: "2026-09-22T00:00:00.000Z",
      appVersion: "0.1.0-editor",
      tags: [],
      negativeControl: false,
    },
    sourceMap: { mapId: MAP, mapName: "Richmond Field Station", xodrSha256: sha256(A.xodr) },
    anchor: { pin: { mapId: MAP, topologyDigest: TOPOLOGY_A.source!.xodrSha256! }, features: [] },
    roles: [
      laneActor("ego", "68:0:-1", 120, { label: "Ego", route: ["68:0:-1", TOPOLOGY_A.lanes["68:0:-1"]!.successors[0]!] }),
      laneActor("lead", "51:0:-1", 60, { label: "Lead car" }),
      {
        id: "walker",
        kind: "scene_absolute",
        label: "Walker",
        actor: { class: "pedestrian", catalogId: "pedestrian.adult" },
        pose: { position: { x: ped.x, y: 0, z: -ped.y }, headingRad: ped.headingRad },
        initialSpeedKph: 0,
      },
    ],
    metricSubject: "ego",
    choreography: { clipSeconds: 8, warmupSeconds: 0, interactions: [] },
  });
}

function documentOn(mapVersionId: string, content: ScenarioTemplateV2): ScenarioDocumentDto {
  return {
    id: "usdoc_mt",
    workspaceId: LOCAL_WORKSPACE_ID,
    title: content.meta.name,
    draftVersion: 1,
    schemaVersion: "2",
    contentSha256: "0".repeat(64),
    content,
    mapVersionId,
    datasetId: "usds_pin",
    authoringQualityId: "medium",
    createdAt: "2026-09-22T00:00:00.000Z",
  } as ScenarioDocumentDto;
}

before(async () => {
  await migrate();
  await seedPinnedMap();
  await execute(`INSERT INTO public.map_assets (id, name) VALUES (:id, 'Richmond Field Station') ON CONFLICT (id) DO NOTHING`, { id: MAP });
  await publish(A, "2026-09-01T00:00:00Z");
  await publish(B, "2026-09-02T00:00:00Z");
  await publish(C, "2026-09-03T00:00:00Z");
  await publish(D, "2026-09-04T00:00:00Z");
});

after(async () => {
  await shutdownDatabase();
});

describe("same road geometry", () => {
  test("every actor is kept exactly; only the pin digest and the ground heights follow the new version", async () => {
    const content = mapBoundContent();
    const plan = await planMapTransition(context, documentOn(A.id, content), B.id);
    assert.equal(plan.blocking, null, plan.blocking?.message);
    assert.equal(plan.geometry, "same");
    assert.deepEqual(plan.source, { mapVersionId: A.id, name: A.label, publishedAt: plan.source.publishedAt });
    assert.equal(plan.target.mapVersionId, B.id);
    assert.deepEqual(plan.placements.map((p) => [p.roleId, p.status, p.displacementM]), [
      ["ego", "kept", 0],
      ["lead", "kept", 0],
      ["walker", "kept", 0],
    ]);
    assert.ok(plan.placements.find((p) => p.roleId === "ego")?.isSubject);
    const moved = plan.content!;
    // The executor refuses a pin naming another road network: it names B's.
    assert.equal(moved.anchor.pin?.topologyDigest, sha256(B.xodr));
    assert.equal(moved.sourceMap?.xodrSha256, sha256(B.xodr));
    const heightB = buildXodrElevationResolver(B.xodr, createMapBundle({ mapId: MAP, topology: B.topology }).topology);
    for (const [index, role] of content.roles.entries()) {
      const next = moved.roles[index]!;
      assert.equal(next.kind, "scene_absolute");
      if (role.kind !== "scene_absolute" || next.kind !== "scene_absolute") continue;
      assert.equal(next.pose.position.x, role.pose.position.x);
      assert.equal(next.pose.position.z, role.pose.position.z);
      assert.equal(next.pose.headingRad, role.pose.headingRad);
      assert.deepEqual(next.laneRef, role.laneRef);
      assert.deepEqual(next.initialRoute, role.initialRoute);
      assert.ok(Math.abs(next.pose.position.y - heightB({ x: role.pose.position.x, y: -role.pose.position.z })) < 1e-5, `${role.id} stands on B's ground`);
    }
    // Road 68 was raised by 0.5 m: its actor's ground follows, and the road is drawn as an elevation change.
    const ego = plan.placements.find((p) => p.roleId === "ego")!;
    assert.ok(Math.abs(ego.after!.elevationM! - heightB({ x: ego.before!.x, y: ego.before!.y })) < 1e-5);
    assert.equal(plan.roads.find((road) => road.roadId === "68")?.change, "elevation");
    assert.ok(plan.roads.filter((road) => road.roadId !== "68").every((road) => road.change === "none"));
    assert.deepEqual(plan.roads.find((road) => road.roadId === "68")?.before, plan.roads.find((road) => road.roadId === "68")?.after);
  });
});

describe("changed road geometry", () => {
  test("actors follow their lanes by location: within tolerance moved, beyond it flagged, free actors kept", async () => {
    const plan = await planMapTransition(context, documentOn(A.id, mapBoundContent()), C.id);
    assert.equal(plan.blocking, null, plan.blocking?.message);
    assert.equal(plan.geometry, "changed");
    const byRole = new Map(plan.placements.map((p) => [p.roleId, p]));
    const ego = byRole.get("ego")!;
    assert.equal(ego.status, "moved", ego.reason ?? "");
    // Road 68 bent sideways by 0.6 m · sin(π f): the ego's lane moved that much under it.
    const bendAt = (rsl: string, s: number, amplitude: number) => amplitude * Math.sin(Math.PI * (s / LANES_A.lane(rsl)!.length));
    const across = bendAt("68:0:-1", 120, BEND_68);
    assert.ok(Math.abs(ego.displacementM! - across) < 0.03, `ego moved ${ego.displacementM} m, the lane ${across} m`);
    assert.ok(ego.displacementM! <= MOVE_TOLERANCE_M);
    const lead = byRole.get("lead")!;
    assert.equal(lead.status, "flagged");
    const leadAcross = bendAt("51:0:-1", 60, BEND_51);
    assert.ok(Math.abs(lead.displacementM! - leadAcross) < 0.1, `lead moved ${lead.displacementM} m, the lane ${leadAcross} m`);
    assert.match(lead.reason ?? "", /more than 1 m/);
    const walker = byRole.get("walker")!;
    assert.equal(walker.status, "kept");
    assert.ok(walker.displacementM! <= KEPT_TOLERANCE_M);

    // The content places each car on C's lane at its old spot, lane-relative placement kept.
    const content = plan.content!;
    assert.equal(content.anchor.pin?.topologyDigest, sha256(C.xodr));
    const lanesC = new LaneGeometryIndex(C.topology);
    for (const id of ["ego", "lead"]) {
      const role = content.roles.find((r) => r.id === id)!;
      assert.equal(role.kind, "scene_absolute");
      if (role.kind !== "scene_absolute") continue;
      const rsl = `${role.laneRef!.roadId}:${role.laneRef!.section}:${role.laneRef!.laneId}`;
      const onLane = projectOntoLane(lanesC.lane(rsl)!, role.pose.position.x, -role.pose.position.z);
      assert.ok(onLane.distance < 1e-3, `${id} stands on the centreline of ${rsl}`);
    }
    const ego2 = content.roles.find((r) => r.id === "ego")!;
    // Its route onto the junction is matched onto the same, still connected, lanes.
    assert.deepEqual(ego2.kind === "scene_absolute" ? ego2.initialRoute : null, { mode: "lanePath", lanes: ["68:0:-1", TOPOLOGY_A.lanes["68:0:-1"]!.successors[0]!] });
    assert.ok(ego.routeDeviationM !== null && ego.routeDeviationM <= MOVE_TOLERANCE_M, `route deviation ${ego.routeDeviationM}`);
    if (process.env.MT_DUMP) console.log(JSON.stringify({ ...plan, content: undefined, roads: plan.roads.map((r) => [r.roadId, r.change, r.before.length, r.after.length]) }, null, 1));

    // Roads: the two realigned roads are geometry changes, drawn before and after.
    const road68 = plan.roads.find((road) => road.roadId === "68")!;
    const road51 = plan.roads.find((road) => road.roadId === "51")!;
    assert.equal(road68.change, "geometry");
    assert.equal(road51.change, "geometry");
    assert.notDeepEqual(road68.before, road68.after);
    assert.ok(plan.roads.length <= 300);
    assert.ok(plan.roads.some((road) => road.change === "none"));
  });

  test("a subject with no lane near where it stood blocks the move", async () => {
    // Sanity: nothing on D runs the subject's way within the search radius of its old spot.
    const lanesD = new LaneGeometryIndex(D.topology);
    const start = poseAt(LANES_A.lane("68:0:-1")!, 120);
    assert.equal(nearestLane(lanesD, start, { family: "drive", headingRad: start.headingRad, maxHeadingGapRad: Math.PI / 4, radius: LANE_SEARCH_RADIUS_M }), null);

    const plan = await planMapTransition(context, documentOn(A.id, mapBoundContent()), D.id);
    assert.equal(plan.content, null);
    assert.equal(plan.blocking?.code, "scenario_subject_unplaced");
    assert.match(plan.blocking!.message, /Ego, the actor this scenario measures, has no lane on Richmond v4/);
    const ego = plan.placements.find((p) => p.roleId === "ego")!;
    assert.equal(ego.status, "unplaced");
    // Never snapped away: its planned spot is where it stood.
    assert.equal(ego.displacementM, 0);
    assert.match(ego.reason ?? "", /stays where it was, without a lane/);
  });

  test("a non-subject with no lane stays where it was, unanchored, and is reported unplaced", async () => {
    const content = mapBoundContent();
    const swapped = parseTemplate({ ...content, metricSubject: "lead" });
    const plan = await planMapTransition(context, documentOn(A.id, swapped), D.id);
    assert.equal(plan.blocking, null, plan.blocking?.message);
    const ego = plan.placements.find((p) => p.roleId === "ego")!;
    assert.equal(ego.status, "unplaced");
    const role = plan.content!.roles.find((r) => r.id === "ego")!;
    assert.equal(role.kind, "scene_absolute");
    if (role.kind === "scene_absolute") {
      assert.equal(role.laneRef, undefined);
      assert.equal(role.initialRoute, undefined);
      const original = content.roles.find((r) => r.id === "ego")!;
      if (original.kind === "scene_absolute") {
        assert.equal(role.pose.position.x, original.pose.position.x);
        assert.equal(role.pose.position.z, original.pose.position.z);
      }
    }
  });
});

describe("timeline routes", () => {
  const withRoute = (lanes: string[], at: number) => {
    const content = mapBoundContent();
    return parseTemplate({
      ...content,
      choreography: {
        ...content.choreography,
        interactions: [{ id: "lead-turns", actor: "lead", trigger: { kind: "at", t: at }, verb: "route", target: { mode: "lanePath", lanes } }],
      },
    });
  };
  const leadRoute = ["51:0:-1", TOPOLOGY_A.lanes["51:0:-1"]!.successors[0]!];

  test("a lane route on the timeline is matched onto the new map's lanes", async () => {
    const plan = await planMapTransition(context, documentOn(A.id, withRoute(leadRoute, 0)), C.id);
    assert.equal(plan.blocking, null, plan.blocking?.message);
    const interaction = plan.content!.choreography.interactions[0] as { target: { mode: string; lanes: string[] } };
    assert.deepEqual(interaction.target, { mode: "lanePath", lanes: leadRoute });
  });

  test("a lane route that has no counterpart on the new map blocks the move, saying where", async () => {
    const egoRoute = ["68:0:-1", TOPOLOGY_A.lanes["68:0:-1"]!.successors[0]!];
    const content = withRoute(egoRoute, 2);
    const moved = parseTemplate({
      ...content,
      metricSubject: "lead",
      choreography: { ...content.choreography, interactions: [{ ...content.choreography.interactions[0]!, actor: "ego" }] },
    });
    const plan = await planMapTransition(context, documentOn(A.id, moved), D.id);
    assert.equal(plan.content, null);
    assert.equal(plan.blocking?.code, "scenario_route_unmatched");
    assert.match(plan.blocking!.message, /The route in the timeline step "lead-turns" could not be matched on Richmond v4 \(road 68 moved\) at \(-?\d+\.\d, -?\d+\.\d\)/);
  });
});

describe("portable scenario", () => {
  /** A transferred variation: the map-bound pair lifted to anchor-relative roles and pinned to a matched site of A. */
  function portableOnA(): { content: ScenarioTemplateV2; siteId: string } {
    const bundle = createMapBundle({
      mapId: MAP,
      topology: A.topology,
      derived: DERIVED_A as never,
      locations: JSON.parse(gunzipSync(LOCATIONS).toString("utf8")),
      xodr: A.xodr,
      signalsGeojson: JSON.parse(gunzipSync(SIGNALS).toString("utf8")),
    });
    const bound = parseTemplate({
      ...mapBoundContent(),
      roles: [laneActor("ego", "68:0:-1", 120, { label: "Ego" }), laneActor("lead", "68:0:-1", 150, { label: "Lead car" })],
    });
    const lifted = liftMapBoundTemplate(bound, bundle);
    assert.ok(lifted.template, JSON.stringify(lifted.issues));
    const portable = parseTemplate(lifted.template);
    const site = matchSites(portable, bundle, { maxSites: 24 }).report.sites.find((candidate) => candidate.degradation.intentPreserved);
    assert.ok(site, "the lifted pair matches somewhere on A");
    return {
      siteId: site.siteId,
      content: parseTemplate({ ...portable, anchor: { ...portable.anchor, pin: { mapId: MAP, siteId: site.siteId, topologyDigest: bundle.digest } } }),
    };
  }

  test("is re-resolved at the matcher site of the new road network where it stood", async () => {
    const { content, siteId } = portableOnA();
    assert.ok(content.roles.every((role) => role.kind !== "scene_absolute"));
    const plan = await planMapTransition(context, documentOn(A.id, content), C.id);
    assert.equal(plan.blocking, null, plan.blocking?.message);
    const pin = plan.content!.anchor.pin!;
    // Site ids name a road network: the new network's site at the same place.
    assert.notEqual(pin.siteId, siteId);
    assert.match(pin.siteId ?? "", /^[0-9a-f]{16}$/);
    assert.notEqual(pin.topologyDigest, content.anchor.pin?.topologyDigest);
    assert.deepEqual(plan.content!.roles, content.roles);
    assert.deepEqual(plan.placements.map((p) => p.roleId), ["ego", "lead"]);
    for (const placement of plan.placements) {
      assert.equal(placement.status, "kept", `${placement.roleId}: ${placement.reason}`);
      assert.equal(placement.after?.elevationM, null);
      assert.ok(placement.before && placement.after);
    }
  });
});

describe("requests", () => {
  test("the version it is on, and versions of other maps, are refused", async () => {
    await assert.rejects(planMapTransition(context, documentOn(A.id, mapBoundContent()), A.id), /already on that map version/);
    await assert.rejects(planMapTransition(context, documentOn(A.id, mapBoundContent()), "usmapv_pin"), /not a version of this scenario's map/);
    await assert.rejects(planMapTransition(context, documentOn(A.id, mapBoundContent()), "usmapv_missing"), /retired or does not exist/);
  });
});

describe("road diff", () => {
  const road = (id: string, body: string) => `<road name="r" length="1" id="${id}" junction="-1">${body}</road>`;
  const plan = (x: string) => `<planView><geometry s="0" x="${x}" y="0" hdg="0" length="10"><line/></geometry></planView>`;
  const elevation = (a: string) => `<elevationProfile><elevation s="0" a="${a}" b="0" c="0" d="0"/></elevationProfile>`;
  const lanes = (h: string) => `<lanes><laneSection s="0"><right><lane id="-1" type="driving" level="false"><width sOffset="0" a="3.5" b="0" c="0" d="0"/><height sOffset="0" inner="${h}" outer="${h}"/></lane></right></laneSection></lanes>`;
  const doc = (...roads: string[]) => `<?xml version="1.0"?><OpenDRIVE><header/>${roads.join("\n")}</OpenDRIVE>`;

  test("classifies each road by id: none, elevation, geometry, added, removed", () => {
    const before = doc(
      road("1", plan("0") + elevation("0") + lanes("0")),
      road("2", plan("0") + elevation("0") + lanes("0")),
      road("3", plan("0") + elevation("0") + lanes("0")),
      road("4", plan("0") + `<lateralProfile><superelevation s="0" a="0" b="0" c="0" d="0"/></lateralProfile>` + lanes("0")),
      road("5", plan("0") + lanes("0")),
      road("6", plan("0") + lanes("0")),
    );
    const after = doc(
      road("1", plan("0") + elevation("0") + lanes("0")),
      road("2", plan("0") + elevation("1.5") + lanes("0.2")),
      road("3", plan("0.5") + elevation("0") + lanes("0")),
      road("4", plan("0") + `<lateralProfile><superelevation s="0" a="0.02" b="0" c="0" d="0"/></lateralProfile>` + lanes("0")),
      road("5", plan("0") + lanes("0").replace('a="3.5"', 'a="3.25"')),
      road("7", plan("0") + lanes("0")),
    );
    assert.deepEqual(Object.fromEntries(diffXodrRoads(before, after)), {
      1: "none",
      2: "elevation",
      3: "geometry",
      4: "elevation",
      5: "geometry",
      6: "removed",
      7: "added",
    });
  });

  test("on the fixture: a raised road is an elevation change, a moved road a geometry change", () => {
    assert.equal(diffXodrRoads(A.xodr, B.xodr).get("68"), "elevation");
    const changed = [...diffXodrRoads(A.xodr, C.xodr)].filter(([, change]) => change !== "none").map(([id, change]) => `${id}:${change}`).sort();
    assert.deepEqual(changed, ["51:geometry", "68:geometry"]);
  });
});

describe("lane chains", () => {
  test("a chain through a junction is matched onto the moved road and stays connected", () => {
    const lanesC = new LaneGeometryIndex(C.topology);
    // Road 68 continues into junction lanes at both ends; follow it one lane further.
    const onward = TOPOLOGY_A.lanes["68:0:-1"]!.successors[0]!;
    const matched = matchLaneChain(LANES_A, lanesC, ["68:0:-1", onward], { toleranceM: 3 });
    assert.ok(matched.ok, matched.ok ? "" : matched.reason);
    assert.deepEqual(matched.lanes, ["68:0:-1", onward]);
  });
});

describe("moving the draft", () => {
  /** A and B become pinnable publications (an available browser closure each). */
  async function pinnable(v: Version, setId: string): Promise<void> {
    await execute(
      `INSERT INTO simforge.browser_asset_sets (id, workspace_id, map_version_id, closure_sha256, object_count, byte_length, asset_set_state)
       VALUES (:id, :workspace_id, :map_version_id, :closure, 1, 1, 'available') ON CONFLICT (id) DO NOTHING`,
      { id: setId, workspace_id: LOCAL_WORKSPACE_ID, map_version_id: v.id, closure: sha256(setId) },
    );
    await setMembers(setId, { ...SIMULATION_MEMBERS, "map.xodr": sha256(v.xodr) });
    await execute(`UPDATE simforge.map_versions SET browser_asset_set_id = :set WHERE id = :id`, { set: setId, id: v.id });
  }

  test("the state before the move is saved as a version first; the draft moves; reverting brings it back", async (t) => {
    t.after(() => setSimulationExecutorForTests(null));
    setSimulationExecutorForTests(async (subject) => fakeAuthoritativeSimulation("map-move", { assetId: MAP, versionId: subject.mapVersionId }));
    await pinnable(A, "usbas_mt_a");
    await pinnable(B, "usbas_mt_b");
    const created = await createScenarioDocument(context, {
      title: "Move me",
      schemaVersion: "2",
      content: mapBoundContent(),
      mapVersionId: A.id,
      datasetId: "usds_pin",
      authoringQualityId: "medium",
    });

    const moved = await moveDraftToMapVersion(context, created.id, { expectedVersion: created.draftVersion, targetMapVersionId: B.id });
    assert.equal(moved.kind, "moved");
    if (moved.kind !== "moved") return;
    assert.equal(moved.document.mapVersionId, B.id);
    assert.equal(moved.plan.geometry, "same");
    const before = await queryOne<{ created_for: string; map_version_id: string; label: string; source_draft_version: number }>(
      `SELECT created_for, map_version_id, label, source_draft_version FROM simforge.revisions WHERE id = :id`,
      { id: moved.before.revisionId },
    );
    assert.equal(before?.created_for, "map_move");
    assert.equal(before?.map_version_id, A.id, "the saved before keeps its original map pin");
    assert.match(before?.label ?? "", /^Before moving to Richmond v2 \(heights\)/);
    assert.equal(Number(before?.source_draft_version), created.draftVersion);
    const beforeSim = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM simforge.revision_active_simulation WHERE revision_id = :id`,
      { id: moved.before.revisionId },
    );
    assert.equal(Number(beforeSim?.n), 1, "and its simulation");

    const versions = await listDocumentVersions(context, created.id);
    const listed = versions?.versions.find((version) => version.revisionId === moved.before.revisionId);
    assert.equal(listed?.createdFor, "map_move");
    assert.equal(listed?.map?.mapVersionId, A.id);
    assert.equal(listed?.matchesDraft, false);

    // Revert to the previous map version: content and pin together.
    const reverted = await restoreVersionToDraft(context, created.id, moved.before.revisionId, { expectedVersion: moved.document.draftVersion });
    assert.equal(reverted.kind, "updated");
    if (reverted.kind !== "updated") return;
    assert.equal(reverted.document.mapVersionId, A.id);
    assert.equal(reverted.document.contentSha256, (await queryOne<{ content_sha256: string }>(
      `SELECT content_sha256 FROM simforge.revisions WHERE id = :id`, { id: moved.before.revisionId },
    ))?.content_sha256);
  });

  test("a blocked move changes nothing and saves nothing", async (t) => {
    t.after(() => setSimulationExecutorForTests(null));
    setSimulationExecutorForTests(async (subject) => fakeAuthoritativeSimulation("map-move-blocked", { assetId: MAP, versionId: subject.mapVersionId }));
    const created = await createScenarioDocument(context, {
      title: "Blocked move",
      schemaVersion: "2",
      content: mapBoundContent(),
      mapVersionId: A.id,
      datasetId: "usds_pin",
      authoringQualityId: "medium",
    });
    const blocked = await moveDraftToMapVersion(context, created.id, { expectedVersion: created.draftVersion, targetMapVersionId: D.id });
    assert.equal(blocked.kind, "blocked");
    const revisions = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM simforge.revisions WHERE document_id = :id`, { id: created.id });
    assert.equal(Number(revisions?.n), 0);
    const draft = await queryOne<{ map_version_id: string }>(`SELECT map_version_id FROM simforge.drafts WHERE document_id = :id`, { id: created.id });
    assert.equal(draft?.map_version_id, A.id);
  });
});
