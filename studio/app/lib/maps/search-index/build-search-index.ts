/**
 * Map search-index builder.
 *
 * Produces the per-map `search_index.json` sidecar. Pure function — no I/O. Consumers
 * (the `complete` / `populate-metadata` endpoints and the enrichment-completion
 * callback) are responsible for persisting the result to S3 and registering
 * it as a `search_index` artifact on the map asset.
 *
 * Phase A scope:
 *   - Canonical junction objects (one per XODR `<junction>`) with approach
 *     count, control type, complexity class, connected-road names.
 *   - Canonical street objects (one per GeoJSON `RoadID`) with length, lane
 *     count, resolved name.
 *   - Candidate-backed POI objects (parking lots, crosswalk clusters, bus
 *     stops, schools, hospitals, gas stations, street parking, parking
 *     clusters, road-segment features) with their candidate_id, facts, and
 *     an anchor to the nearest junction or street.
 *   - Source signatures recorded for staleness detection.
 *   - Empty `graph.edges` — Phase C populates traversal edges.
 *
 * Phase B (proximity) and Phase C (topology) lift this output into operators
 * without changing the artifact shape.
 */

import {
  MAP_SEARCH_INDEX_VERSION,
  addressObjectId,
  junctionObjectId,
  poiObjectId,
  streetObjectId,
  type MapSearchIndex,
  type MapSearchIndexAddressObject,
  type MapSearchIndexBbox,
  type MapSearchIndexCentroid,
  type MapSearchIndexFeatureRef,
  type MapSearchIndexGraphEdge,
  type MapSearchIndexJunctionObjectSchema,
  type MapSearchIndexObject,
  type MapSearchIndexSourceSignatures,
  type MapSearchIndexStreetObjectSchema,
} from "@simforge-oss/studio-shared";
import type {
  CandidateLocation,
  CandidateForNaming,
  MapAssetAddress,
  RoadSegmentEntity,
  RoadSegmentForMatching,
  XodrJunctionMatchInfo,
} from "@simforge-oss/studio-shared";
import {
  buildRoadSegments,
  extractGeoReferenceText,
  NAMEABLE_KINDS,
  parseProjOrigin,
  resolveStreetNamesForCandidates,
} from "@simforge-oss/studio-shared";
import {
  JUNCTION_CENTROID_MATCH_M,
  junctionComplexityClass,
  junctionLegLabel,
  junctionSizeClassFromAreaM2,
  roadClassFromFacts,
} from "@/app/lib/maps/search/classification-thresholds";
import {
  JUNCTION_ID_KEYS,
  parseFeatureCollection,
  propString,
  type GeoJSONFeature,
  type GeoJSONFeatureCollection,
} from "@/app/lib/maps/search/geojson-props";
import {
  geometryAreaM2,
  geometryBounds,
  haversineMetres,
} from "@/app/lib/maps/geo-math";
import {
  buildPerRoadFacts,
  collectRoadBodies,
  junctionControlType,
  parseVectorIdMaps,
  type PerRoadFacts,
} from "@/app/lib/maps/search-index/road-facts";
import {
  CANDIDATE_KIND_TO_POI_KIND,
  aggregateStreets,
  buildJunctionStreetEdges,
  buildPoiAnchorEdges,
  candidateBoundaryRing,
  featureRefsForCandidate,
  overtureAttributesForStreet,
  poiFactsFromCandidate,
  poiSlug,
  resolveSearchIndexAnchor,
  type StreetAggregate,
} from "@/app/lib/maps/search-index/street-facts";
import {
  constrainParkingLotSpeedMph,
  isParkingLotAisle,
  laneCoordsFromGeometry,
  parkingLotPolygonsFromCandidates,
  type LanePolyline,
} from "@/app/lib/maps/search-index/parking-lot-speed";
import type { z } from "zod";

// Junction / street object types inferred from the shared schemas so we don't
// drift from the Zod source of truth.
type JunctionObject = z.infer<typeof MapSearchIndexJunctionObjectSchema>;
type StreetObject = z.infer<typeof MapSearchIndexStreetObjectSchema>;

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface BuildMapSearchIndexInput {
  mapAssetId: string;
  geojsonText: string;
  xodrText: string;
  xodrJunctionInfo: XodrJunctionMatchInfo[];
  candidates: CandidateLocation[];
  /** Overture road segments from enrichment. Pass `null` or `[]` pre-enrichment — names fall back to GeoJSON labels. */
  roadSegments?: RoadSegmentForMatching[] | null;
  /**
   * Overture-derived address rows for the map asset. Lifted into the sidecar
   * as `kind: "address"` objects so natural-language queries like
   * "200 Main St" resolve to a known location and so two-hop queries
   * ("3-way junction near 200 Main St") can use the address as a spatial
   * anchor. Pass `null` or `[]` pre-enrichment — addresses arrive only
   * after the Lambda's third-party pass.
   */
  addresses?: MapAssetAddress[] | null;
  /**
   * ISO 3166-1 alpha-2 country code of the map (from `place_context`). Used to
   * pick the locale default posted limit for parking-lot drive aisles. Optional
   * — absent falls back to a low, US-centric default.
   */
  countryCode?: string | null;
  sourceSignatures?: MapSearchIndexSourceSignatures;
}

// ── Junctions ───────────────────────────────────────────────────────────────

interface JunctionGeojsonIndex {
  byCentroid: Array<{
    centroid: MapSearchIndexCentroid;
    feature: GeoJSONFeature;
    /** Array index in the source GeoJSON FeatureCollection. */
    featureIndex: number;
    junctionId?: string;
  }>;
  /** GeoJSON `feature.properties.Id` UUID → matched feature + array index.
   *  Populated when the GeoJSON exposes the property; empty on legacy maps
   *  that don't. */
  byUuid: Map<
    string,
    { feature: GeoJSONFeature; featureIndex: number; junctionId?: string }
  >;
}

function buildJunctionGeojsonIndex(
  fc: GeoJSONFeatureCollection | null,
): JunctionGeojsonIndex {
  const byCentroid: JunctionGeojsonIndex["byCentroid"] = [];
  const byUuid: JunctionGeojsonIndex["byUuid"] = new Map();
  if (!fc) return { byCentroid, byUuid };

  const features = fc.features ?? [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]!;
    const type = feature.properties?.Type ?? feature.properties?.type;
    if (type !== "Junction") continue;
    const bounds = geometryBounds(feature.geometry);
    if (!bounds) continue;
    const junctionId = propString(feature.properties, JUNCTION_ID_KEYS);
    byCentroid.push({
      centroid: bounds.centroid,
      feature,
      featureIndex: i,
      junctionId,
    });
    const uuid = feature.properties?.Id;
    if (typeof uuid === "string" && uuid.length > 0) {
      byUuid.set(uuid, { feature, featureIndex: i, junctionId });
    }
  }
  return { byCentroid, byUuid };
}

function matchGeojsonJunction(
  xodrCentroid: { lat: number; lng: number },
  index: JunctionGeojsonIndex,
  vectorJunctionUuid?: string,
): { feature: GeoJSONFeature; featureIndex: number; junctionId?: string } | undefined {
  // Primary: deterministic UUID lookup. RoadRunner's vectorJunction id is
  // identical between XODR (<vectorJunction junctionId="{UUID}"/>) and the
  // GeoJSON Junction feature's properties.Id, so this resolves the right
  // polygon every time and skirts the stub-junction-claims-the-wrong-poly
  // problem that centroid-only matching had.
  if (vectorJunctionUuid) {
    const exact = index.byUuid.get(vectorJunctionUuid);
    if (exact) return exact;
  }
  // Fallback: centroid distance. Used when a legacy export doesn't expose
  // the vectorJunction UUID on either side, or when an XODR junction lacks
  // the userData block.
  let best:
    | { feature: GeoJSONFeature; featureIndex: number; junctionId?: string; distance: number }
    | undefined;
  for (const entry of index.byCentroid) {
    const distance = haversineMetres(xodrCentroid, {
      lng: entry.centroid[0],
      lat: entry.centroid[1],
    });
    if (distance <= JUNCTION_CENTROID_MATCH_M && (!best || distance < best.distance)) {
      best = {
        feature: entry.feature,
        featureIndex: entry.featureIndex,
        junctionId: entry.junctionId,
        distance,
      };
    }
  }
  return best
    ? { feature: best.feature, featureIndex: best.featureIndex, junctionId: best.junctionId }
    : undefined;
}

// ── Main builder ────────────────────────────────────────────────────────────

export function buildMapSearchIndex(
  input: BuildMapSearchIndexInput,
): MapSearchIndex {
  const {
    mapAssetId,
    geojsonText,
    xodrJunctionInfo,
    candidates,
    roadSegments,
    countryCode,
    sourceSignatures,
  } = input;

  const fc = parseFeatureCollection(geojsonText);
  // Capture every feature's stable RoadRunner UUID (`properties.Id`) in array
  // order. This becomes the sidecar's `geojson_feature_uuids` table, and
  // `feature_refs.geojson_feature_id` stores indices into it. The source
  // GeoJSON is otherwise immutable post-ingest — no `__mapId` injection,
  // no re-upload — so the sidecar is the only artifact that needs to
  // regenerate when we change indexing strategy.
  const geojsonFeatureUuids: string[] = (fc?.features ?? []).map((feature) => {
    const id = feature?.properties?.Id ?? feature?.properties?.id;
    return typeof id === "string" ? id : "";
  });
  const totalFeatures = geojsonFeatureUuids.length;
  // Loud-failure when features are missing the stable Id property. RoadRunner
  // exports always carry it; a non-zero count signals an upstream pipeline
  // change or an unexpected GeoJSON source. Without Ids, the sidecar can
  // still resolve features by array index, but downstream consumers that
  // join by UUID (vector tiles, future stable-id workflows) will degrade.
  const featuresMissingId = geojsonFeatureUuids.filter((u) => u === "").length;
  if (featuresMissingId > 0) {
    console.warn(
      `[search-index] map=${mapAssetId} ${featuresMissingId}/${totalFeatures} ` +
        `features missing properties.Id — non-RoadRunner export? UUID join ` +
        `paths will fall back to array-index identity.`,
    );
  }
  // RoadRunner publishes shared UUIDs across both files — `<vectorLane>` /
  // `<vectorJunction>` user-data in the XODR matches `feature.properties.Id`
  // on the GeoJSON side. We parse the XODR once up front to build two
  // lookup tables and use them to replace the historical proxy heuristics
  // (RoadID property + junction centroid distance) with deterministic id
  // matching.
  const { laneUuidToRoadId, junctionUuidToXodrId } = parseVectorIdMaps(
    input.xodrText,
  );
  const xodrJunctionIdToUuid = new Map<string, string>();
  for (const [uuid, xid] of junctionUuidToXodrId) {
    xodrJunctionIdToUuid.set(xid, uuid);
  }
  const junctionIndex = buildJunctionGeojsonIndex(fc);

  // ── Junctions ────────────────────────────────────────────────────────────
  const junctionObjects: JunctionObject[] = [];
  const junctionIdByXodr = new Map<string, string>();
  // Snapshot of candidate ids that anchor to a junction — used to surface
  // `candidate_id` on the junction object when one exists.
  const junctionCandidateByCentroid = candidates
    .filter((c) => c.kind === "junction")
    .map((c) => ({ candidate: c, center: c.center }));

  // Assign each junction candidate to exactly one XODR junction (the best
  // match). XODR files contain stub/aux junctions (ramp connectors, short
  // transitions) within ~50 m of every real intersection; letting each one
  // claim the nearest candidate produced duplicate search hits and leaked
  // the candidate's scenario tags onto stubs whose own facts contradicted
  // them (e.g. a 2-leg uncontrolled stub inheriting "Intersection Signalized"
  // from the 5-leg junction it was near).
  //
  // Rank by distance first, then higher approach_count as tiebreaker — the
  // real intersection's centroid lines up with the candidate's, and if two
  // XODR junctions match equally the one with more approaches is the real one.
  const candidateIdByXodr = new Map<string, string>();
  {
    type BestMatch = { xodrId: string; distance: number; approachCount: number };
    const bestForCandidate = new Map<string, BestMatch>();
    for (const info of xodrJunctionInfo) {
      for (const c of junctionCandidateByCentroid) {
        const d = haversineMetres(info.centroid, c.center);
        if (d > JUNCTION_CENTROID_MATCH_M) continue;
        const prev = bestForCandidate.get(c.candidate.id);
        const better =
          !prev ||
          d < prev.distance ||
          (d === prev.distance && info.roadDegree > prev.approachCount);
        if (better) {
          bestForCandidate.set(c.candidate.id, {
            xodrId: info.xodrJunctionId,
            distance: d,
            approachCount: info.roadDegree,
          });
        }
      }
    }
    // Two candidates can resolve to the same best XODR junction (e.g. a
    // detector emitting overlapping junction candidates). Keep the closer
    // one instead of last-write-wins so the surfaced `candidate_id` is the
    // best spatial match, deterministically.
    const bestByXodr = new Map<string, { candId: string; distance: number }>();
    for (const [candId, best] of bestForCandidate) {
      const prev = bestByXodr.get(best.xodrId);
      if (!prev || best.distance < prev.distance) {
        bestByXodr.set(best.xodrId, { candId, distance: best.distance });
      }
    }
    for (const [xodrId, { candId }] of bestByXodr) {
      candidateIdByXodr.set(xodrId, candId);
    }
  }

  let junctionFeatureRefsPopulated = 0;

  for (const info of xodrJunctionInfo) {
    const vectorJunctionUuid = xodrJunctionIdToUuid.get(info.xodrJunctionId);
    const match = matchGeojsonJunction(
      info.centroid,
      junctionIndex,
      vectorJunctionUuid,
    );
    const featureId = match ? match.featureIndex : undefined;

    const feature_refs: MapSearchIndexFeatureRef[] = [];
    if (typeof featureId === "number") {
      feature_refs.push({
        role: "junction_polygon",
        geojson_feature_id: featureId,
      });
      junctionFeatureRefsPopulated += 1;
    }

    const candidateId = candidateIdByXodr.get(info.xodrJunctionId);

    const bounds = match ? geometryBounds(match.feature.geometry) : null;
    const areaM2 = match ? geometryAreaM2(match.feature.geometry) : undefined;
    const sizeClass = junctionSizeClassFromAreaM2(areaM2);
    // Prefer the matched GeoJSON polygon's centroid over the XODR-derived
    // one. `bbox` and `feature_refs` already describe that polygon, and the
    // XODR centroid (`info.centroid`) can sit tens-to-hundreds of metres
    // from the RoadRunner polygon — UUID-based matching grabs the right
    // polygon, but the XODR centroid stays put. Using it here made the
    // map-highlight fly-to and `near` proximity hits land on locations that
    // disagreed with the highlighted polygon.
    const centroid: MapSearchIndexCentroid = bounds
      ? bounds.centroid
      : [info.centroid.lng, info.centroid.lat];

    const leg_label = junctionLegLabel(info.roadDegree);
    const control_type = junctionControlType(info);

    const connectedRoadNames: string[] | undefined = (() => {
      // Populated at resolve-names time below; leave undefined here.
      return undefined;
    })();

    const id = junctionObjectId(info.xodrJunctionId);
    junctionIdByXodr.set(info.xodrJunctionId, id);

    // Scenario affordance: an uncontrolled junction with ≥3 approaches is a
    // reasonable unprotected-left candidate. Signalized / all-way-stop /
    // stop-controlled junctions are excluded because their conflict model is
    // different — those are handled by existing semantic categories.
    const unprotectedLeftCandidate =
      control_type === "uncontrolled" && info.roadDegree >= 3;

    const object: JunctionObject = {
      kind: "junction",
      id,
      name: `Junction ${info.xodrJunctionId}`,
      feature_refs,
      centroid,
      ...(bounds ? { bbox: bounds.bbox } : {}),
      ...(candidateId ? { candidate_id: candidateId } : {}),
      facts: {
        approach_count: info.roadDegree,
        ...(leg_label ? { leg_label } : {}),
        control_type,
        complexity_class: junctionComplexityClass(info.roadDegree),
        ...(sizeClass ? { size_class: sizeClass } : {}),
        has_signal: info.hasTrafficLight,
        has_stop_sign: info.hasStopSign,
        is_all_way_stop: info.allWayStop,
        ...(connectedRoadNames ? { connected_road_names: connectedRoadNames } : {}),
        // Every junction is a vehicle spawn point; pedestrian/cyclist spawn
        // are filled in during the POI-anchor post-pass once sidewalks and
        // bike lanes are joined through their adjacent streets.
        vehicle_spawn: true,
        ...(unprotectedLeftCandidate ? { unprotected_left_candidate: true } : {}),
      },
    };
    junctionObjects.push(object);
  }

  // Loud-log when junction polygon resolution drops most of the set — early
  // signal for upstream regressions (e.g. RoadRunner emitting a different
  // GeoJSON shape, or junction features losing their `properties.Id`). A
  // healthy build resolves a polygon for ~every XODR junction; a broken one
  // returns 0 and the UI ends up highlighting raw centroids on `near` /
  // `leads_to` results.
  if (
    junctionFeatureRefsPopulated < xodrJunctionInfo.length / 2 &&
    junctionIndex.byCentroid.length > 0
  ) {
    console.warn(
      `[search-index] map=${mapAssetId} resolved feature_refs for only ` +
        `${junctionFeatureRefsPopulated}/${xodrJunctionInfo.length} junctions ` +
        `(geojson polygons available: ${junctionIndex.byCentroid.length}, ` +
        `with UUIDs: ${junctionIndex.byUuid.size}). Search highlight + fly-to ` +
        `will fall back to centroids.`,
    );
  }

  // ── Streets ──────────────────────────────────────────────────────────────
  //
  // Street objects are sourced from XODR `RoadSegmentEntity` records first
  // — XODR lives in a local Cartesian frame with true centerline lengths
  // in meters, lane counts, and speed/grade, and every road carries an
  // explicit id. GeoJSON lane aggregates are a *decoration* layer: when a
  // road has a matching aggregate by `RoadID` the GeoJSON feature ids and
  // bbox are folded in so the UI's map-highlight layer lights up. Maps
  // whose GeoJSON omits `RoadID` on lane features (observed on Belmont +
  // Page Mill) still get full canonical streets — they just render without
  // per-feature highlights until a future pass wires lane-id → road-id
  // matching.
  //
  // Fallback: when there is no XODR (test fixtures that pass
  // `xodrText: ""`) we degrade to the GeoJSON aggregator as the sole
  // street source. `length_m` is always stored as centerline in meters so
  // downstream `edge weight = length_m / 2` reflects real distance.
  const projString = extractGeoReferenceText(input.xodrText);
  const origin = projString ? parseProjOrigin(projString) : undefined;
  const coordTransform = {
    originLat: origin?.lat ?? 0,
    originLon: origin?.lon ?? 0,
  };
  const roadEntities: RoadSegmentEntity[] = input.xodrText.trim()
    ? buildRoadSegments(input.xodrText, coordTransform).entities
    : [];
  const roadBodies = collectRoadBodies(input.xodrText);
  const perRoadFacts = buildPerRoadFacts(roadEntities, roadBodies);

  const aggregates = aggregateStreets(fc, laneUuidToRoadId);
  const aggregateByRoadId = new Map<string, StreetAggregate>();
  for (const agg of aggregates) {
    if (agg.bounds.points === 0) continue;
    if (agg.roadId) aggregateByRoadId.set(agg.roadId, agg);
  }

  const streetObjects: StreetObject[] = [];
  const streetIdByRoadKey = new Map<string, string>();
  const consumedRoadIds = new Set<string>();

  function bboxFromAggregate(agg: StreetAggregate): MapSearchIndexBbox {
    return [
      agg.bounds.minLng,
      agg.bounds.minLat,
      agg.bounds.maxLng,
      agg.bounds.maxLat,
    ];
  }
  function centroidFromAggregate(agg: StreetAggregate): MapSearchIndexCentroid {
    return [
      agg.bounds.sumLng / agg.bounds.points,
      agg.bounds.sumLat / agg.bounds.points,
    ];
  }
  function bboxFromEntityRegion(
    entity: RoadSegmentEntity,
  ): MapSearchIndexBbox | undefined {
    if (entity.region.type === "BBOX") {
      return [
        entity.region.bbox.min_lng,
        entity.region.bbox.min_lat,
        entity.region.bbox.max_lng,
        entity.region.bbox.max_lat,
      ];
    }
    if (entity.region.type === "Polygon") {
      const ring = entity.region.coordinates[0];
      if (!ring || ring.length === 0) return undefined;
      let minLng = Infinity,
        minLat = Infinity,
        maxLng = -Infinity,
        maxLat = -Infinity;
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
      return Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : undefined;
    }
    return undefined;
  }
  function drivingLaneCount(entity: RoadSegmentEntity): number {
    let count = 0;
    for (const [kind, n] of Object.entries(entity.laneCountByType)) {
      if (kind.toLowerCase() === "driving") count += n;
    }
    return count;
  }

  function emitStreet(args: {
    id: string;
    roadKey: string;
    name: string;
    centroid: MapSearchIndexCentroid;
    bbox: MapSearchIndexBbox | undefined;
    feature_refs: MapSearchIndexFeatureRef[];
    laneCount: number;
    lengthM: number;
    roadFacts: PerRoadFacts | undefined;
  }): void {
    const {
      id,
      roadKey,
      name,
      centroid,
      bbox,
      feature_refs,
      laneCount,
      lengthM,
      roadFacts,
    } = args;

    const laneCountClass: "single-lane" | "multi-lane" | undefined =
      laneCount === 1 ? "single-lane" : laneCount >= 4 ? "multi-lane" : undefined;
    const roadClass = roadClassFromFacts(roadFacts?.speed_class, laneCount);

    streetObjects.push({
      kind: "street",
      id,
      name,
      feature_refs,
      centroid,
      ...(bbox ? { bbox } : {}),
      facts: {
        lane_count: laneCount,
        ...(laneCountClass ? { lane_count_class: laneCountClass } : {}),
        ...(lengthM > 0 ? { length_m: Math.round(lengthM) } : {}),
        ...(roadFacts?.speed_class ? { speed_class: roadFacts.speed_class } : {}),
        ...(roadFacts?.grade_class ? { grade_class: roadFacts.grade_class } : {}),
        ...(roadFacts?.crest_present ? { crest_present: true } : {}),
        ...(roadFacts?.bike_lane_present ? { bike_lane_present: true } : {}),
        ...(roadFacts?.parking_present ? { parking_present: true } : {}),
        ...(roadFacts?.parking_both_sides ? { parking_both_sides: true } : {}),
        ...(roadFacts?.sidewalk_present ? { sidewalk_present: true } : {}),
        ...(roadFacts?.curvature_class
          ? { curvature_class: roadFacts.curvature_class }
          : {}),
        ...(roadFacts?.min_radius_m != null
          ? { min_radius_m: roadFacts.min_radius_m }
          : {}),
        ...(roadFacts?.width_class ? { width_class: roadFacts.width_class } : {}),
        // Scenario affordances — deterministic derivations from the facts
        // above. `parking_lot_egress` is left to the POI-anchor post-pass
        // so it only fires when a parking lot actually resolves here.
        ...(roadClass ? { road_class: roadClass } : {}),
        vehicle_spawn: true,
        ...(roadFacts?.sidewalk_present ? { pedestrian_spawn: true } : {}),
        ...(roadFacts?.bike_lane_present ? { cyclist_spawn: true } : {}),
      },
    });
    streetIdByRoadKey.set(roadKey, id);
  }

  // Primary pass — one street per non-junction-internal XODR entity.
  // Every XODR entity (internal connectors included) is marked consumed so the
  // GeoJSON fallback pass below can't resurrect junction connectors as bogus
  // streets: RoadRunner exports connector driving lanes as GeoJSON Lane
  // features, and before this guard a dense map emitted a spurious "Road N"
  // street per connector (El Camino: 366 of 480 street objects).
  for (const entity of roadEntities) {
    consumedRoadIds.add(entity.roadId);
    if (entity.isJunctionInternal) continue;

    const agg = aggregateByRoadId.get(entity.roadId);
    const laneCount = drivingLaneCount(entity) || agg?.laneCount || 0;
    // XODR centerline length in meters — `buildRoadSegments` reads this
    // straight from the XODR's Cartesian geometry, no projection distortion.
    const lengthM = entity.lengthM;
    const id = streetObjectId(entity.roadId);
    // Prefer GeoJSON centroid/bbox when available (matches what the
    // highlight layer renders); fall back to the entity's own region.
    const centroid = agg
      ? centroidFromAggregate(agg)
      : ([entity.center.lng, entity.center.lat] as MapSearchIndexCentroid);
    const bbox = agg ? bboxFromAggregate(agg) : bboxFromEntityRegion(entity);
    const feature_refs: MapSearchIndexFeatureRef[] = (agg?.featureIds ?? [])
      .slice(0, 50)
      .map((fid) => ({
        role: "driving_lane" as const,
        geojson_feature_id: fid,
      }));

    emitStreet({
      id,
      roadKey: entity.roadId,
      name: agg?.roadName ?? `Road ${entity.roadId}`,
      centroid,
      bbox,
      feature_refs,
      laneCount,
      lengthM,
      roadFacts: perRoadFacts.get(entity.roadId),
    });
  }

  // Fallback pass — GeoJSON-only roads not covered by XODR. Hit when the
  // test harness passes `xodrText: ""` and on the rare real-map case of a
  // road that lives in GeoJSON without an XODR counterpart. `length_m` is
  // normalized to centerline (summed-lane-length divided by lane count) so
  // semantics match the XODR path.
  for (const agg of aggregates) {
    if (agg.bounds.points === 0) continue;
    if (agg.roadId && consumedRoadIds.has(agg.roadId)) continue;

    const centerlineLengthM =
      agg.laneCount > 0 && agg.totalLengthM > 0
        ? agg.totalLengthM / agg.laneCount
        : agg.totalLengthM;
    const xodrFacts = agg.roadId ? perRoadFacts.get(agg.roadId) : undefined;
    const roadFacts =
      xodrFacts && !xodrFacts.is_junction_internal ? xodrFacts : undefined;

    const id = streetObjectId(agg.roadKey);
    const feature_refs: MapSearchIndexFeatureRef[] = agg.featureIds
      .slice(0, 50)
      .map((fid) => ({
        role: "driving_lane" as const,
        geojson_feature_id: fid,
      }));

    emitStreet({
      id,
      roadKey: agg.roadKey,
      name: agg.roadName ?? `Road ${agg.roadId ?? agg.roadKey}`,
      centroid: centroidFromAggregate(agg),
      bbox: bboxFromAggregate(agg),
      feature_refs,
      laneCount: agg.laneCount,
      lengthM: centerlineLengthM,
      roadFacts,
    });
  }

  // ── Resolve street names via Overture road segments ──────────────────────
  if (roadSegments && roadSegments.length > 0) {
    // Junctions are resolved with kind=junction, centroid only.
    const nameables: CandidateForNaming[] = [
      ...junctionObjects.map<CandidateForNaming>((j) => ({
        id: j.id,
        kind: "junction",
        center: { lat: j.centroid[1], lng: j.centroid[0] },
        label: j.name,
      })),
      ...streetObjects.map<CandidateForNaming>((s) => {
        const agg = aggregates.find((a) => streetIdByRoadKey.get(a.roadKey) === s.id);
        const boundary: [number, number][] | undefined = agg
          ? agg.samplePoints.map((p) => [p.lng, p.lat])
          : undefined;
        return {
          id: s.id,
          kind: "road_segment",
          center: { lat: s.centroid[1], lng: s.centroid[0] },
          label: s.name,
          ...(boundary ? { boundary } : {}),
        };
      }),
    ];

    const resolutions = resolveStreetNamesForCandidates(nameables, roadSegments);
    const resolvedById = new Map(resolutions.map((r) => [r.id, r]));

    for (const j of junctionObjects) {
      const r = resolvedById.get(j.id);
      if (!r || r.streetNames.length === 0) continue;
      j.name = r.resolvedLabel;
      j.facts.connected_road_names = r.streetNames;
    }
    for (const s of streetObjects) {
      const r = resolvedById.get(s.id);
      if (!r || r.streetNames.length === 0) continue;
      s.name = r.streetNames[0] ?? s.name;
      s.facts.resolved_name = r.streetNames[0];

      // Overture segment attributes ride the same proximity match. The
      // posted limit lands provenance-prefixed (advisory — third-party data,
      // never feeds speed_class); the OSM road class is canonical and
      // overrides the XODR-derived fallback written at emit time.
      const attrs = overtureAttributesForStreet(r.matchedSegments, r.streetNames[0]);
      if (attrs.speedLimitMph != null) {
        s.facts.overture_speed_limit_mph = attrs.speedLimitMph;
      }
      if (attrs.roadClass) s.facts.road_class = attrs.roadClass;
    }
  }

  // ── Parking-lot speed constraint ─────────────────────────────────────────
  // Proximity/name matching bleeds a neighbouring arterial or freeway posted
  // limit onto parking-lot drive aisles (San Ramon P1: lot aisles named
  // "Donald D Doyle Highway" tagged 65 mph). A driving lane whose geometry lies
  // (almost) entirely inside a curated parking-lot polygon is a lot aisle, not a
  // through-road, so its posted limit is clamped to a low locale default (US
  // ~15 mph), honouring a genuinely lower XODR limit if one exists. Uses a
  // lane-length containment FRACTION rather than a centroid test so an arterial
  // that merely runs alongside a large office-park lot keeps its real limit.
  // No parking_lot candidates (pre-enrichment) ⇒ empty ⇒ no-op.
  const parkingLots = parkingLotPolygonsFromCandidates(candidates);
  if (parkingLots.length > 0) {
    const aggByStreetId = new Map<string, StreetAggregate>();
    for (const a of aggregates) {
      const sid = streetIdByRoadKey.get(a.roadKey);
      if (sid) aggByStreetId.set(sid, a);
    }
    let constrainedCount = 0;
    for (const s of streetObjects) {
      const agg = aggByStreetId.get(s.id);
      if (!agg) continue;
      const lanes: LanePolyline[] = [];
      for (const fid of agg.featureIds) {
        const feature = fc?.features?.[fid];
        for (const line of laneCoordsFromGeometry(feature?.geometry)) {
          lanes.push(line);
        }
      }
      if (!isParkingLotAisle(lanes, parkingLots)) continue;
      const xodrSpeedMph = agg.roadId
        ? perRoadFacts.get(agg.roadId)?.speed_limit_mph
        : undefined;
      s.facts.overture_speed_limit_mph = constrainParkingLotSpeedMph(
        xodrSpeedMph,
        countryCode,
      );
      constrainedCount += 1;
    }
    if (constrainedCount > 0) {
      console.log(
        `[search-index] map=${mapAssetId} parking-lot speed constraint ` +
          `applied to ${constrainedCount} lot-aisle street(s)`,
      );
    }
  }

  // ── POIs ─────────────────────────────────────────────────────────────────
  const poiObjects: MapSearchIndexObject[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "junction") continue; // junctions are their own family
    const poiKind = CANDIDATE_KIND_TO_POI_KIND[candidate.kind];
    if (!poiKind) continue;

    const centroid: MapSearchIndexCentroid = [candidate.center.lng, candidate.center.lat];

    // Tight bbox from the candidate's region, if available.
    let bbox: MapSearchIndexBbox | undefined;
    if (candidate.region.type === "BBOX") {
      bbox = [
        candidate.region.bbox.min_lng,
        candidate.region.bbox.min_lat,
        candidate.region.bbox.max_lng,
        candidate.region.bbox.max_lat,
      ];
    } else if (candidate.region.type === "Polygon") {
      const ring = candidate.region.coordinates[0];
      if (ring && ring.length > 0) {
        let minLng = Infinity,
          minLat = Infinity,
          maxLng = -Infinity,
          maxLat = -Infinity;
        for (const [lng, lat] of ring) {
          if (lng < minLng) minLng = lng;
          if (lat < minLat) minLat = lat;
          if (lng > maxLng) maxLng = lng;
          if (lat > maxLat) maxLat = lat;
        }
        if (Number.isFinite(minLng)) bbox = [minLng, minLat, maxLng, maxLat];
      }
    } else if (candidate.region.type === "LineString") {
      // Polyline (sidewalk_segment) — bbox is the tight envelope of the
      // vertices. Far smaller than expanding a long sidewalk's bbox into a
      // half-map-spanning square as the prior bbox-fallback did.
      let minLng = Infinity,
        minLat = Infinity,
        maxLng = -Infinity,
        maxLat = -Infinity;
      for (const [lng, lat] of candidate.region.coordinates) {
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
      if (Number.isFinite(minLng)) bbox = [minLng, minLat, maxLng, maxLat];
    }

    const anchor = resolveSearchIndexAnchor(candidate.center, junctionObjects, streetObjects);

    const id = poiObjectId(poiKind, poiSlug(candidate));
    const object: MapSearchIndexObject = {
      kind: poiKind,
      id,
      name: candidate.label,
      candidate_id: candidate.id,
      feature_refs: featureRefsForCandidate(candidate),
      centroid,
      ...(bbox ? { bbox } : {}),
      ...(anchor ? { anchor } : {}),
      ...(candidate.tags && candidate.tags.length > 0
        ? { scenario_tags: candidate.tags }
        : {}),
      facts: poiFactsFromCandidate(candidate),
    };
    poiObjects.push(object);

    // If the candidate boundary ring exists and roadSegments are available,
    // the POI inherits a road-aware name when its kind is in NAMEABLE_KINDS
    // (parking_lot, parking_cluster, crosswalk_zone, …). Branded POI kinds —
    // hotels, restaurants, bus stops, etc. — are deliberately excluded
    // because their candidate.label is already the Overture-supplied brand
    // or address ("Hyatt House Belmont Redwood Shores", "600 Clipper Drive")
    // which is more useful as the title than "<street> junction". For those
    // kinds we still resolve nearby roads but fold them into a
    // `connected_road_names` fact so the street context stays searchable
    // through the inspector / facts panel.
    if (roadSegments && roadSegments.length > 0) {
      const boundary = candidateBoundaryRing(candidate);
      const [res] = resolveStreetNamesForCandidates(
        [
          {
            id: id,
            kind: candidate.kind,
            center: candidate.center,
            label: candidate.label,
            description: candidate.description,
            ...(boundary ? { boundary } : {}),
          },
        ],
        roadSegments,
      );
      if (res && res.streetNames.length > 0) {
        if ((NAMEABLE_KINDS as readonly string[]).includes(candidate.kind)) {
          object.name = res.resolvedLabel;
        } else {
          (object.facts as Record<string, unknown>).connected_road_names =
            res.streetNames;
        }
      }
    }
  }

  // ── Addresses ────────────────────────────────────────────────────────────
  // Lift every Overture address into the sidecar as `kind: "address"`. Each
  // address gets:
  //   - centroid = the snapped road-access point if available, else the raw
  //     address point. Using the road-access point as centroid lets queries
  //     "near 200 Main St" fall on the actually-callable spawn position
  //     rather than the rooftop the address sits on.
  //   - bbox = a degenerate point box at the centroid (addresses are
  //     conceptually points; we still emit a bbox so map-bounds maths stays
  //     uniform).
  //   - anchor = nearest junction or street, same resolveAnchor as POIs use,
  //     so topology queries ("junction near 200 Main St") two-hop without
  //     a proximity scan.
  //   - facts = formatted address, component fields, road-access metadata,
  //     and the building backref when the address sits inside a footprint.
  const addressObjects: MapSearchIndexAddressObject[] = [];
  const addressIds = new Set<string>();
  const buildingNameById = new Map<string, string>();
  for (const poi of poiObjects) {
    // Buildings aren't a POI kind today (the buildings layer is "infra"),
    // so this loop is a no-op — left here as the natural place to lift
    // building names if a future change adds them as searchable objects.
    if (typeof (poi.facts as Record<string, unknown>).building_id === "string") {
      buildingNameById.set(
        (poi.facts as Record<string, unknown>).building_id as string,
        (poi.facts as Record<string, unknown>).building_name as string,
      );
    }
  }
  for (const a of input.addresses ?? []) {
    const repLat = a.road_access_lat ?? a.lat;
    const repLng = a.road_access_lng ?? a.lng;
    const anchor = resolveSearchIndexAnchor(
      { lat: repLat, lng: repLng },
      junctionObjects,
      streetObjects,
    );
    // Slug from the row id keeps it stable across rebuilds; re-running the
    // search-index build on the same Aurora rows produces the same object id.
    const slug = a.id;
    const id = addressObjectId(slug);
    if (addressIds.has(id)) continue;
    addressIds.add(id);
    addressObjects.push({
      id,
      kind: "address",
      name: a.formatted,
      centroid: [repLng, repLat] as MapSearchIndexCentroid,
      bbox: [repLng, repLat, repLng, repLat] as MapSearchIndexBbox,
      feature_refs: [],
      ...(anchor ? { anchor } : {}),
      facts: {
        formatted: a.formatted,
        ...(a.number != null ? { number: a.number } : {}),
        ...(a.street != null ? { street: a.street } : {}),
        ...(a.postcode != null ? { postcode: a.postcode } : {}),
        ...(a.road_access_road_name != null
          ? { road_access_road_name: a.road_access_road_name }
          : {}),
        ...(a.road_access_distance_m != null
          ? { road_access_distance_m: Math.round(a.road_access_distance_m) }
          : {}),
        ...(a.building_id != null ? { building_id: a.building_id } : {}),
        ...(buildingNameById.has(a.building_id ?? "")
          ? { building_name: buildingNameById.get(a.building_id ?? "") }
          : {}),
      },
    });
  }

  // ── Assemble ─────────────────────────────────────────────────────────────
  const objects: Record<string, MapSearchIndexObject> = {};
  for (const obj of junctionObjects) objects[obj.id] = obj;
  for (const obj of streetObjects) objects[obj.id] = obj;
  for (const obj of poiObjects) objects[obj.id] = obj;
  for (const obj of addressObjects) objects[obj.id] = obj;

  // Phase C graph edges.
  const junctionStreetEdges = buildJunctionStreetEdges(
    input.xodrText,
    roadBodies,
    streetIdByRoadKey,
    junctionIdByXodr,
  );
  const anchorEdges = buildPoiAnchorEdges(poiObjects);
  const edges: MapSearchIndexGraphEdge[] = [
    ...junctionStreetEdges,
    ...anchorEdges,
  ];

  // One-line diagnostic so an operator can confirm the Phase C builder ran
  // by tailing the populate-metadata logs. Counts are cheap to compute and
  // identify the most common "missing edges" failure modes:
  //   - 0 streets ⇒ aggregateStreets found no driving lanes (GeoJSON
  //     property mismatch) ⇒ junctionStreetEdges = 0
  //   - 0 anchors ⇒ POIs uniformly out of anchor range
  console.log(
    `[search-index] built map=${mapAssetId} ` +
      `objects=${Object.keys(objects).length} ` +
      `(junctions=${junctionObjects.length}, streets=${streetObjects.length}, ` +
      `pois=${poiObjects.length}, addresses=${addressObjects.length}) ` +
      `edges=${edges.length} ` +
      `(approaches=${junctionStreetEdges.length}, anchors=${anchorEdges.length})`,
  );

  // ── Scenario affordance post-pass ────────────────────────────────────────
  // Runs after the graph is assembled so it can walk edges to find each
  // junction's adjacent streets. Three derivations land here:
  //   1. `parking_lot_egress` on the anchor of every parking-lot POI.
  //   2. `pedestrian_spawn` on junctions that touch any sidewalk-bearing
  //      street (or carry a crosswalk POI within anchor range).
  //   3. `cyclist_spawn` on junctions that touch any bike-lane-bearing
  //      street.
  // All three are boolean opt-ins; absent means "not established", not
  // "explicitly false" — consistent with the rest of the sidecar facts.
  for (const poi of poiObjects) {
    if (!poi.anchor) continue;
    const anchor = objects[poi.anchor.object_id];
    if (!anchor) continue;
    if (poi.kind === "parking_lot" || poi.kind === "parking_cluster") {
      if (anchor.kind === "junction" || anchor.kind === "street") {
        (anchor.facts as Record<string, unknown>).parking_lot_egress = true;
      }
    }
    if (poi.kind === "crosswalk_zone" && anchor.kind === "junction") {
      (anchor.facts as Record<string, unknown>).pedestrian_spawn = true;
    }
  }
  // Junction-side spawn propagation from adjacent streets.
  for (const edge of edges) {
    if (edge.relation !== "approaches") continue;
    const junction = objects[edge.from];
    const street = objects[edge.to];
    if (!junction || junction.kind !== "junction") continue;
    if (!street || street.kind !== "street") continue;
    const sFacts = street.facts as {
      sidewalk_present?: boolean;
      bike_lane_present?: boolean;
    };
    const jFacts = junction.facts as Record<string, unknown>;
    if (sFacts.sidewalk_present) jFacts.pedestrian_spawn = true;
    if (sFacts.bike_lane_present) {
      jFacts.cyclist_spawn = true;
      jFacts.bike_lane_adjacent = true;
    }
  }

  return {
    version: MAP_SEARCH_INDEX_VERSION,
    map_asset_id: mapAssetId,
    built_at: new Date().toISOString(),
    source_signatures: sourceSignatures ?? {},
    geojson_feature_uuids: geojsonFeatureUuids,
    objects,
    graph: { edges },
  };
}
