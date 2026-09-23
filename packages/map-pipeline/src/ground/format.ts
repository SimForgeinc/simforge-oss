/**
 * `ground-mesh.bin`: the map's one authoritative ground surface
 * (`simforge.map-ground.v1`). The Rust reader is
 * `native/crates/simforge-core/src/map/ground.rs`; both sides must agree on
 * every byte, so the layout is documented once, there, and mirrored here:
 *
 * ```text
 * magic         8 bytes  "SFGRND01"
 * vertexCount   u32
 * triangleCount u32
 * vertices      vertexCount   x (i32 x_mm, i32 y_mm, i32 z_mm)   xodr-local
 * triangles     triangleCount x (u32 a, u32 b, u32 c)
 * classes       triangleCount x u8 (SurfaceClass)
 * ```
 */

export const GROUND_MESH_MAGIC = 'SFGRND01';
export const GROUND_SCHEMA = 'simforge.map-ground.v1';
export const GROUND_DERIVED_DIR = 'derived/ground';
export const GROUND_MESH_FILE = 'ground-mesh.bin';
export const GROUND_MANIFEST_FILE = 'ground-manifest.json';
export const GROUND_REPORT_FILE = 'ground-report.json';

/** Per-triangle surface class. Values match `SurfaceClass` in ground.rs. */
export const SURFACE_CLASSES = {
  road: 1,
  bridge: 2,
  gutter: 3,
  sidewalk: 4,
  paved: 5,
  terrain: 6,
  curb: 7,
  marking: 8,
} as const;
export type SurfaceClassName = keyof typeof SURFACE_CLASSES;
export const SURFACE_CLASS_NAMES: readonly SurfaceClassName[] = Object.keys(SURFACE_CLASSES) as SurfaceClassName[];

export interface GroundMesh {
  /** Flat `[x, y, z, ...]` integer millimetres, xodr-local. */
  readonly vertices: Int32Array;
  /** Flat `[a, b, c, ...]` vertex indices. */
  readonly triangles: Uint32Array;
  /** One class code per triangle. */
  readonly classes: Uint8Array;
}

const HEADER = 16;

export function encodeGroundMesh(mesh: GroundMesh): Uint8Array {
  const vertexCount = mesh.vertices.length / 3;
  const triangleCount = mesh.triangles.length / 3;
  if (!Number.isInteger(vertexCount) || !Number.isInteger(triangleCount) || mesh.classes.length !== triangleCount) {
    throw new Error('ground mesh arrays are inconsistent');
  }
  const out = new Uint8Array(HEADER + vertexCount * 12 + triangleCount * 13);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) out[i] = GROUND_MESH_MAGIC.charCodeAt(i);
  view.setUint32(8, vertexCount, true);
  view.setUint32(12, triangleCount, true);
  let at = HEADER;
  for (const value of mesh.vertices) { view.setInt32(at, value, true); at += 4; }
  for (const value of mesh.triangles) { view.setUint32(at, value, true); at += 4; }
  out.set(mesh.classes, at);
  return out;
}

export function decodeGroundMesh(bytes: Uint8Array): GroundMesh {
  const text = String.fromCharCode(...bytes.subarray(0, 8));
  if (bytes.length < HEADER || text !== GROUND_MESH_MAGIC) throw new Error('ground mesh: bad magic');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertexCount = view.getUint32(8, true);
  const triangleCount = view.getUint32(12, true);
  if (bytes.length !== HEADER + vertexCount * 12 + triangleCount * 13) throw new Error('ground mesh: bad length');
  const vertices = new Int32Array(vertexCount * 3);
  const triangles = new Uint32Array(triangleCount * 3);
  let at = HEADER;
  for (let i = 0; i < vertices.length; i += 1) { vertices[i] = view.getInt32(at, true); at += 4; }
  for (let i = 0; i < triangles.length; i += 1) { triangles[i] = view.getUint32(at, true); at += 4; }
  const classes = bytes.slice(at, at + triangleCount);
  return { vertices, triangles, classes };
}
