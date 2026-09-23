import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { SURFACE_CLASSES, type GroundMesh, type SurfaceClassName } from './format.js';
import { GroundQuery } from './query.js';

/**
 * Extract the ground surface from a map master (`master.gltf` + buffers).
 *
 * The surface is exactly what the renderers draw as road and ground, in the
 * RoadRunner/Unreal asset-layer taxonomy every current export carries on
 * its mesh nodes or their ancestors: `Roads_Road`, `Roads_Bridge`,
 * `Roads_Gutter`, `Roads_Sidewalk`, `Roads_Uncategorized`, `Roads_Curb`,
 * `Roads_Marking`, `Terrain_Ground`, `Terrain_Road`, `Terrain_Marking`
 * (optionally suffixed `_Layer<n>` / `_<n>`), plus `Prop_Marking*` decals.
 * Surveyed on all ten sources: every road/terrain mesh matches, nothing else
 * does (`RoadWorkAhead_US_1_Sign` is a sign, not a road).
 *
 * Only upward-facing triangles are ground (plan-normal `nz > 0.3`, slopes up
 * to ~72 deg). That drops kerb and gutter risers, the undersides and sides of
 * bridge structures (Belmont's `Roads_Bridge` is 0 % upward-facing: its deck
 * is `Roads_Road`) and degenerate slivers.
 *
 * Frame: the master is y-up with no translation relative to OpenDRIVE
 * (`packages/maps/src/coordinate-frame.ts`), so xodr-local is
 * `(x, -z, y)`. Vertices are rounded to integer millimetres and welded.
 */

const LAYER = /^(Roads|Terrain)_(Road|Bridge|Gutter|Sidewalk|Uncategorized|Curb|Marking|Ground)(?:_Layer\d+)?(?:_\d+)*$/i;
const PROP_MARKING = /^Prop_Marking(?:_\d+)*$/i;
/** Upward-facing threshold on the unit normal's z. */
export const MIN_UP_NORMAL_Z = 0.3;

const LAYER_CLASS: Record<string, SurfaceClassName> = {
  road: 'road',
  bridge: 'bridge',
  gutter: 'gutter',
  sidewalk: 'sidewalk',
  uncategorized: 'paved',
  curb: 'curb',
  marking: 'marking',
  ground: 'terrain',
};

/** Surface class of a mesh node from its ancestor chain (nearest wins), or null. */
export function surfaceClassOf(chain: readonly string[]): SurfaceClassName | null {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const name = chain[i] ?? '';
    if (PROP_MARKING.test(name)) return 'marking';
    const match = LAYER.exec(name);
    if (match) {
      const kind = match[2]!.toLowerCase();
      // `Terrain_Road` is terrain-layer paving; it is road surface.
      return LAYER_CLASS[kind] ?? null;
    }
  }
  return null;
}

interface Accessor { bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string }
interface BufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }
interface Primitive { attributes: Record<string, number>; indices?: number; mode?: number; extensions?: Record<string, unknown> }
interface GltfNode { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }
interface Gltf {
  accessors: Accessor[];
  bufferViews: BufferView[];
  buffers: { uri?: string; byteLength: number }[];
  meshes: { name?: string; primitives: Primitive[] }[];
  nodes: GltfNode[];
  scenes: { nodes: number[] }[];
  scene?: number;
  extensionsRequired?: string[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readAccessor(gltf: Gltf, buffers: Buffer[], index: number): Float64Array {
  const accessor = gltf.accessors[index];
  if (!accessor || accessor.bufferView === undefined) throw new Error(`ground: accessor ${index} has no bufferView (sparse accessors are not supported)`);
  const view = gltf.bufferViews[accessor.bufferView]!;
  const buffer = buffers[view.buffer]!;
  const components = COMPONENTS[accessor.type];
  const size = BYTES[accessor.componentType];
  if (!components || !size) throw new Error(`ground: unsupported accessor ${index} (${accessor.type}/${accessor.componentType})`);
  const stride = view.byteStride ?? components * size;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Float64Array(accessor.count * components);
  for (let i = 0; i < accessor.count; i += 1) {
    for (let c = 0; c < components; c += 1) {
      const at = base + i * stride + c * size;
      let value: number;
      switch (accessor.componentType) {
        case 5126: value = buffer.readFloatLE(at); break;
        case 5125: value = buffer.readUInt32LE(at); break;
        case 5123: value = buffer.readUInt16LE(at); break;
        case 5121: value = buffer.readUInt8(at); break;
        case 5122: value = buffer.readInt16LE(at); break;
        default: value = buffer.readInt8(at);
      }
      if (accessor.normalized && accessor.componentType !== 5126) {
        const max = accessor.componentType === 5121 ? 255 : accessor.componentType === 5123 ? 65535 : accessor.componentType === 5122 ? 32767 : 127;
        value = accessor.componentType === 5122 || accessor.componentType === 5120 ? Math.max(value / max, -1) : value / max;
      }
      out[i * components + c] = value;
    }
  }
  return out;
}

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  // Column-major TRS, as glTF stores matrices.
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, (2 * (x! * y! + z! * w!)) * sx!, (2 * (x! * z! - y! * w!)) * sx!, 0,
    (2 * (x! * y! - z! * w!)) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, (2 * (y! * z! + x! * w!)) * sy!, 0,
    (2 * (x! * z! + y! * w!)) * sz!, (2 * (y! * z! - x! * w!)) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export interface ExtractedSurface extends GroundMesh {
  /** Triangles kept per class. */
  readonly classTriangles: Record<SurfaceClassName, number>;
  /** Triangles of classified meshes dropped as not upward-facing. */
  readonly droppedNotUpward: number;
  /** Degenerate triangles (collapsed by the millimetre weld). */
  readonly droppedDegenerate: number;
  /** Classified mesh nodes. */
  readonly meshNodes: number;
  /** Marking decals dropped because they lie on another surface (within {@link DECAL_ON_SURFACE_M}). */
  readonly droppedRedundantDecals: number;
}

/** A marking within this of another surface at every corner is a decal on it, not ground of its own. */
export const DECAL_ON_SURFACE_M = 0.05;

/**
 * Drop marking decals that sit on another surface: paint floats a few
 * millimetres above the asphalt it is painted on and adds nothing a wheel can
 * feel, but it is a third of every map's surface triangles. Markings that
 * cover a hole in the road (RoadRunner cuts the asphalt under some
 * crosswalks) are the visible ground there and are kept.
 */
function pruneRedundantDecals(mesh: GroundMesh): { mesh: GroundMesh; dropped: number } {
  const marking = SURFACE_CLASSES.marking;
  const baseTriangles: number[] = [];
  const baseClasses: number[] = [];
  for (let t = 0; t < mesh.classes.length; t += 1) {
    if (mesh.classes[t] === marking) continue;
    baseTriangles.push(mesh.triangles[t * 3]!, mesh.triangles[t * 3 + 1]!, mesh.triangles[t * 3 + 2]!);
    baseClasses.push(mesh.classes[t]!);
  }
  if (baseTriangles.length === 0 || baseClasses.length === mesh.classes.length) return { mesh, dropped: 0 };
  const base = new GroundQuery({ vertices: mesh.vertices, triangles: Uint32Array.from(baseTriangles), classes: Uint8Array.from(baseClasses) });
  const v = mesh.vertices;
  const onBase = (x: number, y: number, z: number) => base.surfacesAt(x, y).some((hit) => Math.abs(hit.z - z) <= DECAL_ON_SURFACE_M);
  const keep: number[] = [];
  let dropped = 0;
  for (let t = 0; t < mesh.classes.length; t += 1) {
    if (mesh.classes[t] !== marking) { keep.push(t); continue; }
    const corners = [0, 1, 2].map((k) => mesh.triangles[t * 3 + k]! * 3);
    const points = corners.map((i) => [v[i]! / 1000, v[i + 1]! / 1000, v[i + 2]! / 1000] as const);
    const blend = (weights: readonly [number, number, number]) => [0, 1, 2].map((axis) => weights[0] * points[0]![axis]! + weights[1] * points[1]![axis]! + weights[2] * points[2]![axis]!) as [number, number, number];
    // Corners, edge midpoints and centroid: a decal spanning a hole in the
    // asphalt has at least one of these over the hole.
    const probes = [...points, blend([0.5, 0.5, 0]), blend([0, 0.5, 0.5]), blend([0.5, 0, 0.5]), blend([1 / 3, 1 / 3, 1 / 3])];
    if (probes.every(([x, y, z]) => onBase(x, y, z))) dropped += 1;
    else keep.push(t);
  }
  // Compact: renumber the surviving vertices in first-use order.
  const remap = new Int32Array(v.length / 3).fill(-1);
  const vertices: number[] = [];
  const triangles: number[] = [];
  const classes: number[] = [];
  for (const t of keep) {
    for (let k = 0; k < 3; k += 1) {
      const old = mesh.triangles[t * 3 + k]!;
      if (remap[old] === -1) { remap[old] = vertices.length / 3; vertices.push(v[old * 3]!, v[old * 3 + 1]!, v[old * 3 + 2]!); }
      triangles.push(remap[old]!);
    }
    classes.push(mesh.classes[t]!);
  }
  return { mesh: { vertices: Int32Array.from(vertices), triangles: Uint32Array.from(triangles), classes: Uint8Array.from(classes) }, dropped };
}

/** Read `master.gltf` and its buffers from `masterDir` and extract the ground surface. */
export async function extractGroundSurface(masterDir: string, masterFile = 'master.gltf'): Promise<ExtractedSurface> {
  const gltf = JSON.parse(await readFile(path.join(masterDir, masterFile), 'utf8')) as Gltf;
  const unsupported = (gltf.extensionsRequired ?? []).filter((name) => name === 'EXT_meshopt_compression' || name === 'KHR_draco_mesh_compression' || name === 'KHR_mesh_quantization');
  if (unsupported.length > 0) throw new Error(`ground: master requires ${unsupported.join(', ')}; the ground stage reads the uncompressed master only`);
  const buffers = await Promise.all(gltf.buffers.map(async (buffer, index) => {
    if (!buffer.uri || buffer.uri.startsWith('data:')) throw new Error(`ground: buffer ${index} must be an external file`);
    return readFile(path.join(masterDir, decodeURIComponent(buffer.uri)));
  }));
  const weld = new Map<string, number>();
  const vertices: number[] = [];
  const triangles: number[] = [];
  const classes: number[] = [];
  const classTriangles = Object.fromEntries(Object.keys(SURFACE_CLASSES).map((name) => [name, 0])) as Record<SurfaceClassName, number>;
  let droppedNotUpward = 0;
  let droppedDegenerate = 0;
  let meshNodes = 0;
  const vertexIndex = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    let index = weld.get(key);
    if (index === undefined) {
      index = vertices.length / 3;
      weld.set(key, index);
      vertices.push(x, y, z);
    }
    return index;
  };
  const visit = (nodeIndex: number, parent: Mat4, chain: string[]): void => {
    const node = gltf.nodes[nodeIndex]!;
    const world = multiply(parent, localMatrix(node));
    const names = [...chain, node.name ?? ''];
    if (node.mesh !== undefined) {
      const className = surfaceClassOf(names);
      if (className) {
        meshNodes += 1;
        const code = SURFACE_CLASSES[className];
        // A mirroring transform flips the winding; keep "upward" meaning up.
        const det = world[0]! * (world[5]! * world[10]! - world[9]! * world[6]!)
          - world[4]! * (world[1]! * world[10]! - world[9]! * world[2]!)
          + world[8]! * (world[1]! * world[6]! - world[5]! * world[2]!);
        const facing = det < 0 ? -1 : 1;
        for (const primitive of gltf.meshes[node.mesh]!.primitives) {
          if ((primitive.mode ?? 4) !== 4) continue;
          if (primitive.attributes['POSITION'] === undefined) continue;
          const positions = readAccessor(gltf, buffers, primitive.attributes['POSITION']);
          const count = positions.length / 3;
          // Scene (y-up) -> xodr-local (x, -z, y), then integer millimetres.
          const local = new Int32Array(count * 3);
          for (let i = 0; i < count; i += 1) {
            const px = positions[i * 3]!; const py = positions[i * 3 + 1]!; const pz = positions[i * 3 + 2]!;
            const sx = world[0]! * px + world[4]! * py + world[8]! * pz + world[12]!;
            const sy = world[1]! * px + world[5]! * py + world[9]! * pz + world[13]!;
            const sz = world[2]! * px + world[6]! * py + world[10]! * pz + world[14]!;
            local[i * 3] = Math.round(sx * 1000);
            local[i * 3 + 1] = Math.round(-sz * 1000);
            local[i * 3 + 2] = Math.round(sy * 1000);
          }
          // Facing comes from the authored vertex normals when present (an
          // exporter's winding is not a reliable signal), from the winding
          // otherwise. Normals transform by the cofactor of the world matrix.
          const normals = primitive.attributes['NORMAL'] === undefined ? null : readAccessor(gltf, buffers, primitive.attributes['NORMAL']);
          const normalUp = normals ? new Float64Array(count) : null;
          if (normals && normalUp) {
            // Scene-y (= xodr-local up) row of the cofactor matrix of the
            // world 3x3 (column-major m): the normal transform up to a
            // positive scale, times sign(det) for mirroring transforms.
            const m = world;
            const c10 = -(m[4]! * m[10]! - m[8]! * m[6]!);
            const c11 = m[0]! * m[10]! - m[8]! * m[2]!;
            const c12 = -(m[0]! * m[6]! - m[4]! * m[2]!);
            const sign = det < 0 ? -1 : 1;
            for (let i = 0; i < count; i += 1) {
              normalUp[i] = sign * (c10 * normals[i * 3]! + c11 * normals[i * 3 + 1]! + c12 * normals[i * 3 + 2]!);
            }
          }
          const indices = primitive.indices === undefined ? null : readAccessor(gltf, buffers, primitive.indices);
          const n = indices ? indices.length : count;
          for (let t = 0; t + 2 < n; t += 3) {
            const ia = indices ? indices[t]! : t; const ib = indices ? indices[t + 1]! : t + 1; const ic = indices ? indices[t + 2]! : t + 2;
            const ax = local[ia * 3]!; const ay = local[ia * 3 + 1]!; const az = local[ia * 3 + 2]!;
            const bx = local[ib * 3]!; const by = local[ib * 3 + 1]!; const bz = local[ib * 3 + 2]!;
            const cx = local[ic * 3]!; const cy = local[ic * 3 + 1]!; const cz = local[ic * 3 + 2]!;
            const ux = bx - ax; const uy = by - ay; const uz = bz - az;
            const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
            const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
            const length = Math.hypot(nx, ny, nz);
            if (length === 0) { droppedDegenerate += 1; continue; }
            const steepness = Math.abs(nz) / length;
            const up = normalUp ? normalUp[ia]! + normalUp[ib]! + normalUp[ic]! > 0 : facing * nz > 0;
            if (!up || steepness <= MIN_UP_NORMAL_Z) { droppedNotUpward += 1; continue; }
            const a = vertexIndex(ax, ay, az); const b = vertexIndex(bx, by, bz); const c = vertexIndex(cx, cy, cz);
            if (a === b || b === c || a === c) { droppedDegenerate += 1; continue; }
            triangles.push(a, b, c);
            classes.push(code);
            classTriangles[className] += 1;
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world, names);
  };
  const scene = gltf.scenes[gltf.scene ?? 0];
  if (!scene) throw new Error('ground: master has no scene');
  for (const root of scene.nodes) visit(root, IDENTITY, []);
  if (triangles.length === 0) throw new Error('ground: the master has no road or terrain surface (no Roads_*/Terrain_* layer meshes)');
  const pruned = pruneRedundantDecals({ vertices: Int32Array.from(vertices), triangles: Uint32Array.from(triangles), classes: Uint8Array.from(classes) });
  classTriangles.marking -= pruned.dropped;
  return {
    ...pruned.mesh,
    classTriangles,
    droppedNotUpward,
    droppedDegenerate,
    meshNodes,
    droppedRedundantDecals: pruned.dropped,
  };
}
