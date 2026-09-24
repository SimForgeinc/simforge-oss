import type { Buffer } from "node:buffer";

export const STATIC_COLLIDER_SCHEMA: "simforge.static-map-colliders/v2";
export const STATIC_COLLIDER_SCHEMA_VERSION: 2;
export const STATIC_COLLIDER_FILE: "static-colliders-v2.json";
/** Clearance above every ground surface under a fixture at which ingest drops it as overhead. */
export const OVERHEAD_CLEARANCE_M: number;

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

/** Scene-frame vertical extent (y up; the ground surface's datum). */
export interface StaticColliderVertical {
  minY: number;
  maxY: number;
}

export interface StaticCollider {
  id: string;
  class: StaticColliderClass;
  obb: StaticColliderObb;
  vertical: StaticColliderVertical;
}

/**
 * The map's ground surface as the builder samples it: every surface height
 * under an xodr-local plan point (x east, y north; scene z = -y).
 */
export interface StaticColliderGround {
  surfacesAt(x: number, y: number): readonly number[];
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
  /** {@link OVERHEAD_CLEARANCE_M} when the map's ground surface classified overhead fixtures; null without one. */
  overheadClearanceM: number | null;
  statistics: {
    sourceTiles: number;
    accepted: number;
    rejectedRoadOverlap: number;
    /** Fixtures no body on the ground under them can reach (mast arms, signal heads, luminaires, bridge soffits). */
    rejectedOverhead: number;
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
  /** The map's ground surface (`derived/ground`), or null for a map without one: then nothing is classified overhead. */
  ground: StaticColliderGround | null;
} & (
  | { readSource(file: string): Buffer; canonicalGltf?: never }
  | { canonicalGltf: { file: string; bytes: Buffer }; readSource?: never }
)): StaticColliderArtifact;

export function serializeStaticColliderArtifact(
  artifact: StaticColliderArtifact,
): string;
