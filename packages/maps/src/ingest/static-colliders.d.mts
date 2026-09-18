import type { Buffer } from "node:buffer";

export const STATIC_COLLIDER_SCHEMA: "simforge.static-map-colliders/v1";

export type StaticColliderClass =
  | "building"
  | "wall"
  | "barrier"
  | "prop"
  | "road-boundary";

export interface StaticColliderObb {
  center: { x: number; z: number };
  lengthM: number;
  widthM: number;
  headingRad: number;
}

export interface StaticCollider {
  id: string;
  class: StaticColliderClass;
  obb: StaticColliderObb;
}

export interface StaticColliderArtifact {
  schema: typeof STATIC_COLLIDER_SCHEMA;
  mapId: string;
  sourceManifestSha256: string;
  sources: Array<{
    id: string;
    file: string;
    declaredBytes: number | null;
  }>;
  colliders: StaticCollider[];
  statistics: {
    sourceTiles: number;
    accepted: number;
    rejectedRoadOverlap: number;
    ignored: number;
    classes: Record<StaticColliderClass, number>;
  };
  digest: string;
}

/**
 * Per-reason counts of the mesh nodes this extractor did not admit. The
 * artifact keeps its single `statistics.ignored` total; producers and tests
 * read this to see *why* a source yielded what it yielded — the opaque total
 * is what kept the old fail-open inclusion list invisible.
 */
export interface StaticColliderExclusions {
  /** Road and ground surface geometry: road, marking, sidewalk, gutter, terrain. */
  surface: number;
  /** Tree, bush and other canopy geometry, trunks included. */
  foliage: number;
  /** Too low to hit: paint, reflectors, covers. */
  flat: number;
  /** Footprint below the minimum extent. */
  tiny: number;
  /** No position bounds, or a non-finite centre. */
  degenerate: number;
  /** A kerb or guardrail network merged into one map-wide mesh. */
  mergedBoundary: number;
}

export function extractGlbColliders(
  buffer: Buffer,
  tileId: string,
): { colliders: StaticCollider[]; ignored: number; exclusions: StaticColliderExclusions };

export function buildStaticColliderArtifact(input: {
  mapId: string;
  sourceManifestSha256: string;
  manifest: {
    tiles: Array<{
      id?: string;
      lods?: Array<{ level: number; file: string; fileSize?: number }>;
    }>;
    staticLayers?: Array<{ id?: string; file: string; fileSize?: number }>;
  };
  topology: {
    lanes?: Record<string, {
      laneType?: string;
      representativeWidthM?: number | null;
      polyline?: Array<[number, number] | { x: number; y: number }>;
    }>;
  };
} & (
  | { readSource(file: string): Buffer; canonicalGltf?: never }
  | { canonicalGltf: { file: string; bytes: Buffer }; readSource?: never }
)): StaticColliderArtifact;

export function serializeStaticColliderArtifact(
  artifact: StaticColliderArtifact,
): string;
