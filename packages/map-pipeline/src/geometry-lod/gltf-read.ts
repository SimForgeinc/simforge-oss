import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Minimal, geometry-only reader for a map master (`master.gltf` +
 * `geometry.bin`). The LOD builder never needs the master's images decoded
 * (only a handful of foliage textures, read on demand), so it does not go
 * through glTF-Transform's reader, which loads every image member.
 */

export type Json = Record<string, unknown>;

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
  min?: number[];
  max?: number[];
  sparse?: unknown;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: unknown[];
  extensions?: Json;
}

export interface GltfMesh { name?: string; primitives: GltfPrimitive[]; weights?: number[]; extras?: unknown }

export interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  skin?: number;
  extensions?: Json;
}

export interface GltfMaterial {
  name?: string;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided?: boolean;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: { index: number; texCoord?: number; extensions?: Json };
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: { index: number; texCoord?: number };
  };
  normalTexture?: { index: number; texCoord?: number; scale?: number };
  occlusionTexture?: { index: number; texCoord?: number };
  emissiveTexture?: { index: number; texCoord?: number };
  extensions?: Json;
}

export interface GltfDocument {
  asset: Json;
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  materials?: GltfMaterial[];
  textures?: Array<{ source?: number; sampler?: number; extensions?: { KHR_texture_basisu?: { source: number } } }>;
  images?: Array<{ uri?: string; mimeType?: string; name?: string }>;
  accessors?: GltfAccessor[];
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  buffers?: Array<{ uri?: string; byteLength: number }>;
  extensionsUsed?: string[];
  [key: string]: unknown;
}

const COMPONENTS: Record<GltfAccessor['type'], number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export function componentCount(type: GltfAccessor['type']): number {
  return COMPONENTS[type];
}

export interface MasterGeometry {
  json: GltfDocument;
  /** Buffers by index (the master has exactly one, `geometry.bin`). */
  buffers: Buffer[];
}

export async function readMasterGeometry(masterDir: string, file = 'master.gltf'): Promise<MasterGeometry> {
  const json = JSON.parse(await readFile(path.join(masterDir, file), 'utf8')) as GltfDocument;
  const buffers: Buffer[] = [];
  for (const buffer of json.buffers ?? []) {
    if (!buffer.uri || buffer.uri.startsWith('data:')) throw new Error('geometry-lod: master buffers must be external files');
    const bytes = await readFile(path.join(masterDir, decodeURIComponent(buffer.uri)));
    if (bytes.byteLength < buffer.byteLength) throw new Error(`geometry-lod: ${buffer.uri} is shorter than declared`);
    buffers.push(bytes);
  }
  return { json, buffers };
}

/** Accessor contents as float32 (normalized integers are decoded), tightly packed. */
export function readAccessorFloat(geometry: MasterGeometry, index: number): Float32Array {
  const accessor = geometry.json.accessors![index]!;
  if (accessor.sparse) throw new Error(`geometry-lod: sparse accessor ${index} is not supported`);
  const n = componentCount(accessor.type);
  const out = new Float32Array(accessor.count * n);
  if (accessor.bufferView === undefined) return out;
  const view = geometry.json.bufferViews![accessor.bufferView]!;
  const bytes = COMPONENT_BYTES[accessor.componentType]!;
  const stride = view.byteStride ?? bytes * n;
  const buffer = geometry.buffers[view.buffer]!;
  const base = buffer.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const data = new DataView(buffer.buffer, 0, buffer.buffer.byteLength);
  const read = (offset: number): number => {
    switch (accessor.componentType) {
      case 5126: return data.getFloat32(offset, true);
      case 5125: return data.getUint32(offset, true);
      case 5123: return accessor.normalized ? data.getUint16(offset, true) / 65535 : data.getUint16(offset, true);
      case 5122: return accessor.normalized ? Math.max(data.getInt16(offset, true) / 32767, -1) : data.getInt16(offset, true);
      case 5121: return accessor.normalized ? data.getUint8(offset) / 255 : data.getUint8(offset);
      case 5120: return accessor.normalized ? Math.max(data.getInt8(offset) / 127, -1) : data.getInt8(offset);
      default: throw new Error(`geometry-lod: accessor ${index} has component type ${accessor.componentType}`);
    }
  };
  if (accessor.componentType === 5126 && stride === 4 * n && base % 4 === 0) {
    out.set(new Float32Array(buffer.buffer, base, accessor.count * n));
    return out;
  }
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < n; c++) out[i * n + c] = read(base + i * stride + c * bytes);
  }
  return out;
}

export function readIndices(geometry: MasterGeometry, primitive: GltfPrimitive): Uint32Array {
  if (primitive.indices === undefined) {
    const count = geometry.json.accessors![primitive.attributes['POSITION']!]!.count;
    return Uint32Array.from({ length: count }, (_, i) => i);
  }
  const accessor = geometry.json.accessors![primitive.indices]!;
  const view = geometry.json.bufferViews![accessor.bufferView!]!;
  const buffer = geometry.buffers[view.buffer]!;
  const base = buffer.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  switch (accessor.componentType) {
    case 5125: {
      const bytes = new Uint8Array(accessor.count * 4);
      bytes.set(buffer.subarray(base - buffer.byteOffset, base - buffer.byteOffset + accessor.count * 4));
      return new Uint32Array(bytes.buffer);
    }
    case 5123: {
      const out = new Uint32Array(accessor.count);
      for (let i = 0; i < accessor.count; i++) out[i] = buffer.readUInt16LE(base - buffer.byteOffset + i * 2);
      return out;
    }
    case 5121: {
      const out = new Uint32Array(accessor.count);
      for (let i = 0; i < accessor.count; i++) out[i] = buffer[base - buffer.byteOffset + i]!;
      return out;
    }
    default: throw new Error(`geometry-lod: index accessor type ${accessor.componentType}`);
  }
}

// ---------------------------------------------------------------------------
// Scene traversal
// ---------------------------------------------------------------------------

export type Mat4 = Float64Array;

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function nodeLocalMatrix(node: GltfNode): Mat4 {
  if (node.matrix) return Float64Array.from(node.matrix);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (qy! * qy! + qz! * qz!)) * sx!;
  m[1] = 2 * (qx! * qy! + qz! * qw!) * sx!;
  m[2] = 2 * (qx! * qz! - qy! * qw!) * sx!;
  m[4] = 2 * (qx! * qy! - qz! * qw!) * sy!;
  m[5] = (1 - 2 * (qx! * qx! + qz! * qz!)) * sy!;
  m[6] = 2 * (qy! * qz! + qx! * qw!) * sy!;
  m[8] = 2 * (qx! * qz! + qy! * qw!) * sz!;
  m[9] = 2 * (qy! * qz! - qx! * qw!) * sz!;
  m[10] = (1 - 2 * (qx! * qx! + qy! * qy!)) * sz!;
  m[12] = tx!;
  m[13] = ty!;
  m[14] = tz!;
  m[15] = 1;
  return m;
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/** Largest axis scale of a world matrix (the factor a mesh-local length grows by). */
export function maxScale(m: Mat4): number {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  return Math.max(sx, sy, sz);
}

export interface MeshInstance { node: number; mesh: number; world: Mat4 }

/**
 * Every mesh node of the default scene with its world matrix. Nodes outside
 * every scene are included as roots (the master attaches orphans; a master
 * never has any, but the builder must not silently drop geometry).
 */
export function meshInstances(json: GltfDocument): MeshInstance[] {
  const nodes = json.nodes ?? [];
  const out: MeshInstance[] = [];
  const hasParent = new Uint8Array(nodes.length);
  for (const node of nodes) for (const child of node.children ?? []) hasParent[child] = 1;
  const sceneRoots = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const roots = [...sceneRoots, ...nodes.map((_, i) => i).filter((i) => !hasParent[i] && !sceneRoots.includes(i))];
  const stack: Array<[number, Mat4]> = roots.map((index) => [index, identity()]);
  const seen = new Uint8Array(nodes.length);
  while (stack.length) {
    const [index, parent] = stack.pop()!;
    if (seen[index]) continue;
    seen[index] = 1;
    const node = nodes[index]!;
    const world = multiply(parent, nodeLocalMatrix(node));
    if (node.mesh !== undefined) out.push({ node: index, mesh: node.mesh, world });
    for (const child of node.children ?? []) stack.push([child, world]);
  }
  out.sort((a, b) => a.node - b.node);
  return out;
}
