import {
  isPedestrianSpawnCandidate,
  OSM_ROAD_CLASSES,
  type CandidateLocation,
  type CandidateLocationKind,
  type MapSearchIndexAnchor,
  type MapSearchIndexFeatureRef,
  type MapSearchIndexGraphEdge,
  type MapSearchIndexObject,
  type MapSearchIndexPoiKind,
  type MatchedRoadSegment,
  type OsmRoadClass,
} from "@simforge-oss/studio-shared";
import aliasSpec from "@/app/lib/maps/search/map-search-aliases.json";
import {
  JUNCTION_ANCHOR_MAX_M,
  STREET_ANCHOR_MAX_M,
  crestPresentFromPct,
  gradeClassFromPct,
  parkingLotSizeClass,
  speedClassFromMph,
} from "@/app/lib/maps/search/classification-thresholds";
import {
  LANE_LENGTH_KEYS,
  propNumber,
  propString,
  ROAD_ID_KEYS,
  ROAD_NAME_KEYS,
  type GeoJSONFeatureCollection,
} from "@/app/lib/maps/search/geojson-props";
import {
  geometryBounds,
  haversineMetres,
} from "@/app/lib/maps/geo-math";

export interface StreetAggregate {
  roadKey: string; // XODR RoadID if available, else RoadName
  roadId?: string;
  roadName?: string;
  featureIds: number[];
  laneCount: number;
  totalLengthM: number;
  bounds: {
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
    sumLng: number;
    sumLat: number;
    points: number;
  };
  // Used later to get a boundary point for street-name matching.
  samplePoints: Array<{ lat: number; lng: number }>;
}

export function aggregateStreets(
  fc: GeoJSONFeatureCollection | null,
  laneUuidToRoadId: Map<string, string>,
): StreetAggregate[] {
  if (!fc) return [];
  const byRoad = new Map<string, StreetAggregate>();

  const features = fc.features ?? [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]!;
    const props = feature.properties ?? {};
    if (props.Type !== "Lane" && props.type !== "Lane") continue;
    const laneType = String(props.LaneType ?? props.lane_type ?? "").toLowerCase();
    if (laneType && laneType !== "driving") continue;

    // Resolve the parent road id, in priority order:
    //   1. An explicit RoadID/road_id property (legacy maps that expose it).
    //   2. The lane's `Id` UUID, looked up in the XODR `<vectorLane>` map —
    //      RoadRunner's GeoJSON puts the lane UUID in `properties.Id` and
    //      the same UUID lives in the XODR's `<lane><userData><vectorLane
    //      laneId="…">` block, with the parent `<road id>` enclosing it.
    //      This is the path that unblocks Belmont / Page Mill, where lane
    //      features carry no `RoadID` at all.
    let roadId = propString(props, ROAD_ID_KEYS);
    if (!roadId) {
      const laneUuid = typeof props.Id === "string" ? props.Id : undefined;
      if (laneUuid) {
        const mapped = laneUuidToRoadId.get(laneUuid);
        if (mapped) roadId = mapped;
      }
    }
    const roadName = propString(props, ROAD_NAME_KEYS);
    const key = roadId ?? roadName;
    if (!key) continue;

    let agg = byRoad.get(key);
    if (!agg) {
      agg = {
        roadKey: key,
        roadId,
        roadName,
        featureIds: [],
        laneCount: 0,
        totalLengthM: 0,
        bounds: {
          minLng: Infinity,
          minLat: Infinity,
          maxLng: -Infinity,
          maxLat: -Infinity,
          sumLng: 0,
          sumLat: 0,
          points: 0,
        },
        samplePoints: [],
      };
      byRoad.set(key, agg);
    }
    if (!agg.roadName && roadName) agg.roadName = roadName;

    agg.laneCount += 1;
    const length = propNumber(props, LANE_LENGTH_KEYS);
    if (length) agg.totalLengthM += length;

    agg.featureIds.push(i);

    // Fold geometry into bounds + sample points.
    const bounds = geometryBounds(feature.geometry);
    if (bounds) {
      const [minLng, minLat, maxLng, maxLat] = bounds.bbox;
      if (minLng < agg.bounds.minLng) agg.bounds.minLng = minLng;
      if (minLat < agg.bounds.minLat) agg.bounds.minLat = minLat;
      if (maxLng > agg.bounds.maxLng) agg.bounds.maxLng = maxLng;
      if (maxLat > agg.bounds.maxLat) agg.bounds.maxLat = maxLat;
      agg.bounds.sumLng += bounds.centroid[0];
      agg.bounds.sumLat += bounds.centroid[1];
      agg.bounds.points += 1;
      if (agg.samplePoints.length < 8) {
        agg.samplePoints.push({
          lat: bounds.centroid[1],
          lng: bounds.centroid[0],
        });
      }
    }
  }
  return [...byRoad.values()];
}

// ── Overture segment attributes → street facts ─────────────────────────────
//
// Overture carries the posted speed limit and the OSM road class as
// attributes on `transportation/segment`. The proximity match that resolves
// street names already found the nearby segments; this maps their attributes
// onto one street with two guards:
//
//   1. Name agreement — only segments whose name matches the street's
//      resolved primary name contribute, so a parallel arterial inside the
//      15 m match radius can't bleed its 45 mph limit onto a side street.
//   2. Mode with a deterministic tie-break — a street can span segments with
//      different values; the most common one wins. Speed ties break to the
//      HIGHER limit (conservative for scenario design), class ties to the
//      more major class (OSM_ROAD_CLASSES order).

export interface OvertureStreetAttributes {
  speedLimitMph?: number;
  roadClass?: OsmRoadClass;
}

const OSM_ROAD_CLASS_SET = new Set<string>(OSM_ROAD_CLASSES);

function normalizeStreetName(name: string | undefined): string | undefined {
  const n = name?.trim().toLowerCase();
  return n || undefined;
}

/** Most common value; ties broken by `preferred` (earlier wins). */
function modeWithTieBreak<T>(values: T[], preferred: (a: T, b: T) => number): T | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || preferred(a[0], b[0]),
  )[0]![0];
}

export function overtureAttributesForStreet(
  matched: MatchedRoadSegment[],
  resolvedName: string | undefined,
): OvertureStreetAttributes {
  const streetName = normalizeStreetName(resolvedName);
  if (!streetName) return {};

  const sameName = matched.filter(
    (m) => normalizeStreetName(m.segment.name) === streetName,
  );

  const speeds = sameName
    .map((m) => m.segment.speed_limit_mph)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const speedLimitMph = modeWithTieBreak(speeds, (a, b) => b - a);

  const classes = sameName
    .map((m) => m.segment.road_class)
    .filter((c): c is OsmRoadClass => c != null && OSM_ROAD_CLASS_SET.has(c));
  const roadClass = modeWithTieBreak(
    classes,
    (a, b) => OSM_ROAD_CLASSES.indexOf(a) - OSM_ROAD_CLASSES.indexOf(b),
  );

  return {
    ...(speedLimitMph != null ? { speedLimitMph } : {}),
    ...(roadClass ? { roadClass } : {}),
  };
}

// ── POI anchor resolution ───────────────────────────────────────────────────
//
// Each POI attaches to the nearest junction-or-street node so topology queries
// can reach it. Junctions are preferred when within JUNCTION_ANCHOR_MAX_M —
// they map cleanly to XODR and scale with CARLA's scenario model. If no
// junction is close enough, fall back to the nearest street (within
// STREET_ANCHOR_MAX_M). Both thresholds live in classification-thresholds.ts.

export function resolveSearchIndexAnchor(
  poiCentroid: { lat: number; lng: number },
  junctionObjects: Array<{ id: string; centroid: [number, number] }>,
  streetObjects: Array<{ id: string; centroid: [number, number] }>,
): MapSearchIndexAnchor | undefined {
  let bestJunction: { id: string; distance: number } | undefined;
  for (const j of junctionObjects) {
    const dist = haversineMetres(poiCentroid, {
      lng: j.centroid[0],
      lat: j.centroid[1],
    });
    if (!bestJunction || dist < bestJunction.distance) {
      bestJunction = { id: j.id, distance: dist };
    }
  }
  if (bestJunction && bestJunction.distance <= JUNCTION_ANCHOR_MAX_M) {
    return {
      object_id: bestJunction.id,
      distance_m: Math.round(bestJunction.distance),
    };
  }

  let bestStreet: { id: string; distance: number } | undefined;
  for (const s of streetObjects) {
    const dist = haversineMetres(poiCentroid, {
      lng: s.centroid[0],
      lat: s.centroid[1],
    });
    if (!bestStreet || dist < bestStreet.distance) {
      bestStreet = { id: s.id, distance: dist };
    }
  }
  if (bestStreet && bestStreet.distance <= STREET_ANCHOR_MAX_M) {
    return {
      object_id: bestStreet.id,
      distance_m: Math.round(bestStreet.distance),
    };
  }
  return undefined;
}

// ── Candidate kind → sidecar mappings ──────────────────────────────────────
// `candidate_to_poi_kind` picks the sidecar enum member (bus_stop,
// street_parking, road_segment_feature, …); `candidate_to_poi_type` picks
// the `facts.poi_type` scalar (bus_stop, school, gas_station, …). Both come
// from map-search-aliases.json so there's one place to audit the whole
// CandidateLocationKind → sidecar translation.
const ALIAS_SPEC = aliasSpec as {
  candidate_to_poi_kind?: Partial<Record<CandidateLocationKind, MapSearchIndexPoiKind>>;
  candidate_to_poi_type?: Partial<Record<CandidateLocationKind, string>>;
};

export const CANDIDATE_KIND_TO_POI_KIND: Partial<
  Record<CandidateLocationKind, MapSearchIndexPoiKind>
> = ALIAS_SPEC.candidate_to_poi_kind ?? {};

const CANDIDATE_KIND_TO_POI_TYPE: Partial<Record<CandidateLocationKind, string>> =
  ALIAS_SPEC.candidate_to_poi_type ?? {};

export function candidateBoundaryRing(
  candidate: CandidateLocation,
): [number, number][] | undefined {
  if (candidate.region.type === "Polygon") {
    const outer = candidate.region.coordinates[0];
    if (outer && outer.length > 0) return outer;
  }
  if (candidate.region.type === "BBOX") {
    const { bbox } = candidate.region;
    return [
      [bbox.min_lng, bbox.min_lat],
      [bbox.max_lng, bbox.min_lat],
      [bbox.max_lng, bbox.max_lat],
      [bbox.min_lng, bbox.max_lat],
    ];
  }
  return undefined;
}

// ── Collect facts from candidate primitives ─────────────────────────────────
// Scoped strictly to kinds other than the junction/street families — those
// get their facts from XODR/GeoJSON directly via the sidecar builder.

export function poiFactsFromCandidate(
  candidate: CandidateLocation,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const entry of candidate.evidence) {
    for (const [key, value] of Object.entries(entry.primitives)) {
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
        if (facts[key] == null) facts[key] = value;
      }
    }
  }
  const poiType = CANDIDATE_KIND_TO_POI_TYPE[candidate.kind];
  if (poiType) facts.poi_type = poiType;
  if (candidate.kind === "parking_lot") {
    const sizeClass = parkingLotSizeClass(
      typeof facts.space_count === "number" ? facts.space_count : undefined,
    );
    if (sizeClass) facts.size_class = sizeClass;
  }
  // Occlusion candidates encode their structured facts in the standard
  // `evidence[].primitives` vocabulary (occlusion_subtype, severity,
  // crosswalk_nearby, …, supported_scenario_templates_json) so the generic
  // primitives loop above already lifted them into `facts`. The only
  // post-processing left is decoding the JSON-stringified template list back
  // into an array, plus surfacing `confidence` for badge rendering.
  if (candidate.kind === "occlusion") {
    facts.confidence = candidate.confidence;
    const tplJson = facts.supported_scenario_templates_json;
    if (typeof tplJson === "string") {
      try {
        const parsed = JSON.parse(tplJson);
        if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) {
          facts.supported_scenario_templates = parsed;
        }
      } catch {
        // Malformed JSON: drop the field rather than poisoning the sidecar.
      }
      delete facts.supported_scenario_templates_json;
    }
  }
  // Road-segment candidates carry raw detector primitives (grade_pct,
  // has_sidewalk, …) that don't match the vocabulary factsToBadges speaks.
  // Map them onto the same classified keys the street-aggregate path writes
  // so search badges render uniformly across streets and road-segment POIs.
  if (candidate.kind === "road_segment") {
    const gradePct = typeof facts.grade_pct === "number" ? facts.grade_pct : undefined;
    const gradeClass = gradeClassFromPct(gradePct);
    if (gradeClass) facts.grade_class = gradeClass;
    if (crestPresentFromPct(gradePct)) facts.crest_present = true;

    if (facts.has_sidewalk === true) facts.sidewalk_present = true;
    if (facts.has_bike_lane === true) facts.bike_lane_present = true;
    if (facts.has_parking_lane === true) facts.parking_present = true;

    const speedMph =
      typeof facts.speed_limit_mph === "number" ? facts.speed_limit_mph : undefined;
    const speedClass = speedClassFromMph(speedMph);
    if (speedClass) facts.speed_class = speedClass;

    const laneCount =
      typeof facts.driving_lane_count === "number" ? facts.driving_lane_count : undefined;
    if (laneCount === 1) facts.lane_count_class = "single-lane";
    else if (laneCount != null && laneCount >= 4) facts.lane_count_class = "multi-lane";
  }
  // Pedestrian-spawn eligibility — single source of truth lives in
  // `shared/enrichment/pedestrian-spawn`. Setting the boolean here makes
  // POI facts targetable by the existing `semantic: ["pedestrian_spawn"]`
  // alias (the alias catalog maps it to the "pedestrian spawn" badge
  // emitted by `fact_true_badges.pedestrian_spawn`). Junctions and
  // streets get the same flag set elsewhere in this builder via
  // adjacency derivation; this line covers all POI kinds at once so
  // downstream consumers (search ranking, scenario builder, prompt
  // catalog) can read a single boolean.
  if (isPedestrianSpawnCandidate(candidate)) facts.pedestrian_spawn = true;
  return facts;
}

// ── Feature refs for candidate-backed POIs ──────────────────────────────────
// A candidate already references `map_candidate_locations` via `candidate_id`;
// when the candidate's evidence points at source GeoJSON feature ids we can
// also surface those (e.g. crosswalk markings). Parking lots skip this — the
// lot polygon lives on the candidate row; its parking-space lanes are not
// simulation-relevant per the sidecar rule.

export function featureRefsForCandidate(
  candidate: CandidateLocation,
): MapSearchIndexFeatureRef[] {
  // Most candidate kinds don't expose atomic geojson ids in their evidence
  // today; Phase A surfaces only what is durably tied to each candidate via
  // `candidate_id`. Later extractors may populate specific refs (e.g.
  // crosswalk markings → `role: crosswalk_marking`); keep the field present
  // so the schema is stable.
  void candidate;
  return [];
}

// ── Stable POI slug ─────────────────────────────────────────────────────────
// The candidate id itself is opaque (hashed). To produce a stable, descriptive
// `poi:` canonical id we derive a short slug from label + id hash.

function shortHash(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).slice(0, 8);
}

export function poiSlug(candidate: CandidateLocation): string {
  const normalized = candidate.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const h = shortHash(candidate.id);
  return normalized ? `${normalized}-${h}` : h;
}

// ── Graph edges (Phase C) ───────────────────────────────────────────────────
//
// Phase C populates two edge classes straight from already-parsed inputs:
//
//   1. junction ↔ street via XODR `<link>` predecessor/successor elements.
//      A road whose `<link><predecessor elementType="junction" .../>` names
//      junction J1, or whose successor names junction J2, is considered to
//      approach both. Roads marked `junction="N"` (N != "-1") are XODR
//      internal connectors and excluded — they model lane transitions inside
//      a junction, not approach streets.
//
//   2. POI → anchor object via the resolved anchor computed during POI
//      assembly. Relation is `accesses` for parking lots / driveways and
//      `anchors_to` for everything else. Hop distance carries through so the
//      BFS executor can cap traversal correctly.
//
// Direction is always `both` for the MVP — XODR encodes predecessor/successor
// per road but we often don't know actual traffic flow. A future pass can
// specialize direction using lane-group data.

function extractLinkedJunctionId(
  body: string,
  role: "predecessor" | "successor",
): string | undefined {
  const re = new RegExp(`<${role}\\b([^/>]*)\\/?>`, "i");
  const m = body.match(re);
  if (!m) return undefined;
  const attrs = m[1] ?? "";
  const typeMatch = attrs.match(/\belementType\s*=\s*"([^"]+)"/);
  const idMatch = attrs.match(/\belementId\s*=\s*"([^"]+)"/);
  if (typeMatch?.[1] !== "junction" || !idMatch?.[1]) return undefined;
  return idMatch[1];
}

function extractRoadJunctionAttr(
  xodrText: string,
  roadId: string,
): string | undefined {
  // Matches <road ... id="R" ... junction="N" ...> anywhere in the document.
  // Escapes the road id just in case — XODR ids are normally numeric but can
  // include dots in hand-authored fixtures.
  const escaped = roadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<road\\b([^>]*\\bid="${escaped}"[^>]*)>`, "i");
  const m = xodrText.match(re);
  if (!m) return undefined;
  const attrs = m[1] ?? "";
  const jMatch = attrs.match(/\bjunction\s*=\s*"([^"]+)"/);
  return jMatch?.[1];
}

export function buildJunctionStreetEdges(
  xodrText: string,
  roadBodies: Map<string, string>,
  streetIdByRoadKey: Map<string, string>,
  junctionIdByXodr: Map<string, string>,
): MapSearchIndexGraphEdge[] {
  const edges: MapSearchIndexGraphEdge[] = [];
  const seen = new Set<string>();

  for (const [roadId, body] of roadBodies) {
    // Skip XODR-internal connector roads — their `junction` attribute names
    // the parent junction, and every real link from them is to the junction's
    // incoming/outgoing approach roads rather than external streets.
    const roadJunctionAttr = extractRoadJunctionAttr(xodrText, roadId);
    if (roadJunctionAttr && roadJunctionAttr !== "-1") continue;

    const streetId = streetIdByRoadKey.get(roadId);
    if (!streetId) continue;

    for (const role of ["predecessor", "successor"] as const) {
      const xodrJId = extractLinkedJunctionId(body, role);
      if (!xodrJId) continue;
      const junctionId = junctionIdByXodr.get(xodrJId);
      if (!junctionId) continue;
      // Dedup — a road that loops back to the same junction at both ends
      // would otherwise emit two identical edges.
      const key = `${junctionId}→${streetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: junctionId,
        to: streetId,
        relation: "approaches",
        direction: "both",
      });
    }
  }

  return edges;
}

export function buildPoiAnchorEdges(
  poiObjects: MapSearchIndexObject[],
): MapSearchIndexGraphEdge[] {
  const edges: MapSearchIndexGraphEdge[] = [];
  for (const poi of poiObjects) {
    if (!poi.anchor) continue;
    // Parking lots and driveways literally access the street they anchor to
    // — tag that edge distinctly so alias expansion ("exit") can target it.
    const lotLike = poi.kind === "parking_lot" || poi.kind === "parking_cluster";
    const relation: MapSearchIndexGraphEdge["relation"] = lotLike
      ? "accesses"
      : "anchors_to";
    edges.push({
      from: poi.id,
      to: poi.anchor.object_id,
      relation,
      direction: "both",
      distance_m: poi.anchor.distance_m,
    });
  }
  return edges;
}
