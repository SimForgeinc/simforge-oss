import { z } from 'zod';

/**
 * `derived/geometry-lod/manifest.json`: the declared schema of the map
 * geometry derivative (docs/engineering/map-geometry-lod.md). Renderers
 * (LOD selection, shadow proxies) and the sensor scene read only this index
 * plus the files it names; every file is a closure member with its digest.
 */
export const GEOMETRY_LOD_SCHEMA = 'simforge.map-geometry-lod.v1';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const member = z.object({ path: z.string().min(1), sha256: sha }).strict();
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const level = z.object({
  /** 1..n; level 0 is the master mesh itself. */
  level: z.number().int().positive(),
  /** Mesh index in lod.gltf. */
  lodMesh: z.number().int().nonnegative(),
  triangles: z.number().int().nonnegative(),
  method: z.enum(['simplify', 'card-thin']),
  /** Mesh-local metres (times the instance's largest scale in the world). */
  geometricErrorM: z.number().nonnegative(),
  /** At the reference camera, scale 1, `pixelErrorPx`. */
  switchDistanceM: z.number().nonnegative(),
  shadowSwitchDistanceM: z.number().nonnegative(),
  keptFraction: z.number().positive().max(1).optional(),
  cardScale: z.number().positive().optional(),
}).strict();

const impostor = z.object({
  kind: z.literal('cross-cards'),
  lodMesh: z.number().int().nonnegative(),
  /** Material index in lod.gltf. */
  material: z.number().int().nonnegative(),
  triangles: z.number().int().positive(),
  geometricErrorM: z.number().nonnegative(),
  switchDistanceM: z.number().nonnegative(),
  shadowSwitchDistanceM: z.number().nonnegative(),
  coverage: z.array(z.number().min(0).max(1)),
  castsShadow: z.boolean(),
}).strict();

const lodMesh = z.object({
  /** Mesh index in master.gltf. */
  mesh: z.number().int().nonnegative(),
  name: z.string(),
  instances: z.number().int().positive(),
  maxInstanceScale: z.number().nonnegative(),
  triangles: z.number().int().nonnegative(),
  /** Mesh-local bounding sphere (AABB centre). */
  bounds: z.object({ center: vec3, radius: z.number().nonnegative() }).strict(),
  class: z.enum(['foliage', 'opaque']),
  primitives: z.array(z.object({
    primitive: z.number().int().nonnegative(),
    material: z.number().int().nonnegative().optional(),
    alphaMode: z.enum(['OPAQUE', 'MASK', 'BLEND']),
    cardLike: z.boolean(),
    triangles: z.number().int().nonnegative(),
  }).strict()),
  /** Ordered finest to coarsest; geometricErrorM strictly increases (every level has a selection range). */
  levels: z.array(level),
  impostor: impostor.nullable(),
  shadow: z.object({ minLevel: z.number().int().nonnegative() }).strict(),
}).strict();

const sensorPrimitive = z.object({
  mesh: z.number().int().nonnegative(),
  primitive: z.number().int().nonnegative(),
  /** Mesh index in sensor.gltf (one primitive, POSITION only, mesh-local). */
  sensorMesh: z.number().int().nonnegative(),
  method: z.enum(['identity', 'simplify', 'card-aggregate']),
  triangles: z.number().int().nonnegative(),
  sourceTriangles: z.number().int().nonnegative(),
  instances: z.number().int().positive(),
  surfaceErrorM: z.number().nonnegative(),
}).strict();

export const geometryLodManifestSchema = z.object({
  schema: z.literal(GEOMETRY_LOD_SCHEMA),
  /** sha256(canonical {schema, master, buffers, fingerprint}). */
  buildKey: sha,
  builder: z.object({ name: z.string(), revision: z.number().int().positive(), meshoptimizer: z.string(), fingerprint: sha }).strict(),
  source: z.object({ master: member, buffers: z.array(member) }).strict(),
  options: z.record(z.string(), z.unknown()),
  conventions: z.record(z.string(), z.string()),
  thresholds: z.object({
    pixelErrorPx: z.number().positive(),
    shadowPixelErrorPx: z.number().positive(),
    reference: z.object({ verticalPx: z.number().positive(), vfovDeg: z.number().positive(), fPx: z.number().positive() }).strict(),
  }).strict(),
  files: z.object({ lod: member, lodBuffer: member, sensor: member, sensorBuffer: member, images: z.array(member) }).strict(),
  meshes: z.array(lodMesh),
  sensor: z.object({
    options: z.object({ surfaceErrorM: z.number().positive(), vegetationSurfaceErrorM: z.number().positive(), voxelM: z.number().positive() }).strict(),
    primitives: z.array(sensorPrimitive),
    triangles: z.object({ sourceInstanced: z.number().int(), sourceUnique: z.number().int(), instanced: z.number().int(), unique: z.number().int() }).strict(),
    errorBound: z.object({ surfaceM: z.number(), vegetationSurfaceM: z.number(), surfaceMaxEstimateM: z.number(), foliage: z.string() }).strict(),
  }).strict(),
  totals: z.object({
    instancedTriangles: z.number().int(),
    uniqueTriangles: z.number().int(),
    lodMeshes: z.number().int(),
    lodMeshInstancedTriangles: z.number().int(),
    coarsestLevelInstancedTriangles: z.number().int(),
    impostorInstancedTriangles: z.number().int(),
  }).strict(),
}).strict();

export type GeometryLodManifest = z.infer<typeof geometryLodManifestSchema>;
export type LodMeshEntry = z.infer<typeof lodMesh>;
export type LodLevelEntry = z.infer<typeof level>;
export type SensorPrimitiveEntry = z.infer<typeof sensorPrimitive>;

/** Parse and check the invariants zod cannot express. */
export function parseGeometryLodManifest(value: unknown): GeometryLodManifest {
  const manifest = geometryLodManifestSchema.parse(value);
  for (const mesh of manifest.meshes) {
    let error = 0;
    mesh.levels.forEach((entry, index) => {
      if (entry.level !== index + 1) throw new Error(`geometry-lod manifest: mesh ${mesh.mesh} levels are not numbered 1..n`);
      if (index > 0 && entry.geometricErrorM <= error) throw new Error(`geometry-lod manifest: mesh ${mesh.mesh} level ${entry.level} error does not increase (an empty selection range)`);
      error = entry.geometricErrorM;
    });
    if (mesh.impostor && mesh.impostor.geometricErrorM < error) throw new Error(`geometry-lod manifest: mesh ${mesh.mesh} impostor error below its last level`);
    if (mesh.shadow.minLevel > mesh.levels.length) throw new Error(`geometry-lod manifest: mesh ${mesh.mesh} shadow.minLevel out of range`);
  }
  return manifest;
}
