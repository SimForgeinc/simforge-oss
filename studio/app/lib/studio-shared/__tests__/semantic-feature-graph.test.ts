import { describe, expect, it } from "vitest";
import {
  SEMANTIC_FEATURE_GRAPH_COMPILER_VERSION,
  SEMANTIC_FEATURE_GRAPH_SCHEMA_VERSION,
  SemanticFeatureGraphSchema,
} from "../index";

const runtimeProvenance = {
  mapAssetId: "map-target",
  runtimeFamily: "carla_ue5" as const,
  runtimeMapName: "TownTarget",
  runtimeCatalogVersion: "catalog-v1",
  bundleVersion: "bundle-v1",
  imageDigest: "sha256:image",
  xodrSha256: "a".repeat(64),
  runtimeRoadGraphSha256: "b".repeat(64),
  projectionIdentitySha256: "c".repeat(64),
  compilerVersion: "runtime-topology-v1",
};

describe("semantic feature graph contract", () => {
  it("represents exact runtime lanes and projected source-fused features together", () => {
    const graph = SemanticFeatureGraphSchema.parse({
      schemaVersion: SEMANTIC_FEATURE_GRAPH_SCHEMA_VERSION,
      compilerVersion: SEMANTIC_FEATURE_GRAPH_COMPILER_VERSION,
      graphRevision: `sha256:${"d".repeat(64)}`,
      generatedAt: "2026-07-11T00:00:00.000Z",
      mapAssetId: "map-target",
      mapName: "TownTarget",
      runtimeProvenance,
      features: [
        {
          id: "lane:1:0:-1",
          kind: "driving_corridor",
          label: "Driving lane",
          geometry: { type: "polyline", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
          sources: [{ source: "opendrive", sourceId: "1:0:-1", confidence: 1, revision: "a".repeat(64) }],
          runtimeBinding: { status: "exact", laneRsls: ["1:0:-1"], gateIds: [], candidateId: null, maximumProjectionErrorM: 0 },
          authoringStatus: "authorable",
          properties: {},
          diagnosticCodes: [],
        },
        {
          id: "candidate:parking-1",
          kind: "parking_area",
          label: "Street parking",
          geometry: { type: "polygon", rings: [[{ x: 0, y: 4 }, { x: 20, y: 4 }, { x: 20, y: 7 }, { x: 0, y: 4 }]] },
          sources: [{ source: "geojson", sourceId: "parking-1", confidence: 0.9, revision: null }],
          runtimeBinding: { status: "projected", laneRsls: ["1:0:-1"], gateIds: [], candidateId: "parking-1", maximumProjectionErrorM: 4 },
          authoringStatus: "authorable",
          properties: {},
          diagnosticCodes: [],
        },
      ],
      relations: [{
        id: "relation:parking:lane",
        kind: "parallel_to",
        fromFeatureId: "candidate:parking-1",
        toFeatureId: "lane:1:0:-1",
        confidence: 0.8,
        distanceM: 4,
        properties: {},
      }],
      stats: {
        featureCount: 2,
        relationCount: 1,
        authorableCount: 2,
        exactRuntimeBoundCount: 1,
        projectedRuntimeBoundCount: 1,
        byKind: { driving_corridor: 1, parking_area: 1 },
      },
    });

    expect(graph.features.map((feature) => feature.sources[0]?.source)).toEqual(["opendrive", "geojson"]);
    expect(graph.features[1]?.runtimeBinding.status).toBe("projected");
  });
});
