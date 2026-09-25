export {
  bboxFromCoords,
  bboxIntersects,
  bboxToLine,
  bboxToPoint,
  bboxToPolygon,
  clipBbox,
  expandBbox,
  featureBbox,
} from "./bbox-utils";
export type { Bbox } from "./bbox-utils";
export { deriveEnrichmentTags } from "./derive-enrichment-tags";
export {
  isPedestrianSpawnCandidate,
  PEDESTRIAN_SPAWN_KINDS,
  PEDESTRIAN_SPAWN_OCCLUSION_SUBTYPES,
} from "./pedestrian-spawn";
export { simplifyPolygon } from "./simplify-polygon";
export { bufferLineString } from "./buffer-line-string";
export { extractJunctionCandidates } from "./extractors/geojson-junction-extractor";
export type { XodrJunctionMatchInfo } from "./extractors/geojson-junction-extractor";
export {
  pointInPolygon,
  pointInBbox,
  parsePolygonRings,
} from "./point-in-polygon";
export type { Ring, PolygonRings } from "./point-in-polygon";

// ── XODR geometry & projection utilities ───────────────────────────────────
export {
  localToLonLat,
  sampleGeometry,
  resolveSTtoXY,
  resolveSTtoXYWithHeading,
  parseGeometrySegments,
  parseElevationProfile,
  sampleElevation,
  sampleRoadReferenceLineToLonLat,
} from "./xodr-geometry";
export type {
  XY,
  GeometrySegment,
  CoordTransform,
  ElevationEntry,
} from "./xodr-geometry";
export { MapProjection, synthesizeTmercProjString } from "./proj";
export { attr, stripXmlComments, extractGeoReferenceText } from "./xodr-utils";
export {
  parseProjOrigin,
  projProjectionType,
  utmZoneFromLonLat,
  parseDatum,
  parseHorizontalUnits,
  parseVerticalUnits,
} from "./parse-proj";

// ── Scene graph builders ───────────────────────────────────────────────────
export { buildMapSceneGraph } from "./build-scene-graph";
export type { BuildSceneGraphOptions, BuildSceneGraphResult } from "./build-scene-graph";
export { buildParkingClusters } from "./builders/parking-builder";
export type { BuildParkingClustersResult, OvertureParkingLot } from "./builders/parking-builder";
export { buildRoadSegments } from "./builders/road-segment-builder";
export type { BuildRoadSegmentsResult } from "./builders/road-segment-builder";

// ── Detectors ──────────────────────────────────────────────────────────────
export { runAllDetectors, DETECTOR_REGISTRY } from "./detectors";

// ── Candidate engine ───────────────────────────────────────────────────────
export { generateCandidates, selectTopK, poolCandidates } from "./candidate-engine";
export type { GenerateCandidatesOptions, RankingStrategy } from "./candidate-engine";

// ── Convex hull (standalone geometry utility) ─────────────────────────────
export { convexHull } from "./convex-hull";
export type { LngLat } from "./convex-hull";

// ── Street name resolver ──────────────────────────────────────────────────
export { resolveStreetNamesForCandidates, NAMEABLE_KINDS } from "./street-name-resolver";
export type { CandidateForNaming, RoadSegmentForMatching, StreetNameResolution, MatchedRoadSegment, ResolveOptions } from "./street-name-resolver";

// ── Occlusion-likelihood candidate generation ──────────────────────────────
export {
  runMetadataPhaseOcclusion,
  runEnrichmentPhaseOcclusion,
  OCCLUSION_DETECTOR_VERSION,
} from "./occlusion";
export type {
  OcclusionMetadataPhaseInput,
  OcclusionEnrichmentPhaseInput,
  OcclusionBuilding,
  OcclusionPoi,
  OcclusionLatLng,
} from "./occlusion";
