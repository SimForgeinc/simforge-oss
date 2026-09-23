import { MeshoptSimplifier } from 'meshoptimizer';

import type { GltfAccessor } from './gltf-read.js';

/**
 * Pure geometry operations of the LOD builder. Everything here is
 * deterministic: no RNG, stable orders, and meshoptimizer (itself
 * deterministic for identical input) as the only simplifier.
 */

export interface AttributeData {
  /** Decoded values, `components` floats per vertex. */
  data: Float32Array;
  components: number;
  /** The source accessor's encoding, reproduced exactly when written. */
  componentType: number;
  normalized: boolean;
  type: GltfAccessor['type'];
}

export interface PrimitiveData {
  /** Attribute semantic -> data, in the source primitive's order. */
  attributes: Map<string, AttributeData>;
  indices: Uint32Array;
}

export function vertexCount(primitive: PrimitiveData): number {
  const position = primitive.attributes.get('POSITION')!;
  return position.data.length / 3;
}

export function positions(primitive: PrimitiveData): Float32Array {
  return primitive.attributes.get('POSITION')!.data;
}

export function triangleCount(primitive: PrimitiveData): number {
  return primitive.indices.length / 3;
}

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

export interface Components {
  /** Component id per triangle (0..count-1, numbered by first triangle). */
  ofTriangle: Int32Array;
  /** Component id per vertex (-1 for vertices no triangle uses). */
  ofVertex: Int32Array;
  count: number;
  triangles: Int32Array;
  /** One-sided surface area per component (mesh-local m^2). */
  area: Float64Array;
  /** Area-weighted centroid per component. */
  centroid: Float64Array;
  /** Bounding-box diagonal per component. */
  diagonal: Float64Array;
  /** Area-weighted mean normal per component (not normalized; |n| / area = planarity). */
  normal: Float64Array;
}

/**
 * Connected components over index connectivity plus exact position
 * welding (an attribute seam splits vertices, not surfaces).
 */
export function connectedComponents(primitive: PrimitiveData): Components {
  const P = positions(primitive);
  const indices = primitive.indices;
  const n = P.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  const remap = MeshoptSimplifier.generatePositionRemap(P, 3);
  for (let v = 0; v < n; v++) if (remap[v] !== v) union(v, remap[v]!);
  for (let t = 0; t < indices.length; t += 3) {
    union(indices[t]!, indices[t + 1]!);
    union(indices[t]!, indices[t + 2]!);
  }
  const triCount = indices.length / 3;
  const ofTriangle = new Int32Array(triCount);
  const idOfRoot = new Map<number, number>();
  for (let t = 0; t < triCount; t++) {
    const root = find(indices[t * 3]!);
    let id = idOfRoot.get(root);
    if (id === undefined) {
      id = idOfRoot.size;
      idOfRoot.set(root, id);
    }
    ofTriangle[t] = id;
  }
  const count = idOfRoot.size;
  const ofVertex = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    const id = idOfRoot.get(find(v));
    if (id !== undefined) ofVertex[v] = id;
  }
  const triangles = new Int32Array(count);
  const area = new Float64Array(count);
  const centroid = new Float64Array(count * 3);
  const normal = new Float64Array(count * 3);
  const lo = new Float64Array(count * 3).fill(Infinity);
  const hi = new Float64Array(count * 3).fill(-Infinity);
  for (let t = 0; t < triCount; t++) {
    const c = ofTriangle[t]!;
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const d = indices[t * 3 + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[d]! - P[a]!, vy = P[d + 1]! - P[a + 1]!, vz = P[d + 2]! - P[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const doubled = Math.hypot(nx, ny, nz);
    triangles[c]! += 1;
    area[c]! += doubled / 2;
    normal[c * 3]! += nx / 2;
    normal[c * 3 + 1]! += ny / 2;
    normal[c * 3 + 2]! += nz / 2;
    for (let k = 0; k < 3; k++) {
      const cx = (P[a + k]! + P[b + k]! + P[d + k]!) / 3;
      centroid[c * 3 + k]! += cx * doubled / 2;
      for (const vertex of [a, b, d]) {
        lo[c * 3 + k] = Math.min(lo[c * 3 + k]!, P[vertex + k]!);
        hi[c * 3 + k] = Math.max(hi[c * 3 + k]!, P[vertex + k]!);
      }
    }
  }
  const diagonal = new Float64Array(count);
  for (let c = 0; c < count; c++) {
    for (let k = 0; k < 3; k++) {
      centroid[c * 3 + k] = area[c]! > 0 ? centroid[c * 3 + k]! / area[c]! : (lo[c * 3 + k]! + hi[c * 3 + k]!) / 2;
    }
    diagonal[c] = Math.hypot(hi[c * 3]! - lo[c * 3]!, hi[c * 3 + 1]! - lo[c * 3 + 1]!, hi[c * 3 + 2]! - lo[c * 3 + 2]!);
  }
  return { ofTriangle, ofVertex, count, triangles, area, centroid, diagonal, normal };
}

export function quantile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!;
}

/**
 * A primitive made of many small disconnected pieces (leaf cards, twig
 * clusters): the shape of foliage. Simplification alone collapses such
 * pieces one by one and the canopy goes bald; these primitives are thinned
 * by whole piece instead. Structural pieces (a trunk, a main branch) are
 * excluded from thinning and simplified normally.
 */
export interface CardAnalysis {
  cardLike: boolean;
  /** Per component: true when it is a thinnable card (not structural). */
  thinnable: Uint8Array;
  cardTriangles: number;
  cardArea: number;
  medianCardDiagonal: number;
}

export const CARD_MIN_COMPONENTS = 16;
export const CARD_MAX_MEDIAN_TRIANGLES = 256;

export function analyzeCards(primitive: PrimitiveData, components: Components, alphaMasked: boolean): CardAnalysis {
  const total = triangleCount(primitive);
  const structuralMin = Math.max(2000, Math.ceil(total * 0.05));
  const thinnable = new Uint8Array(components.count);
  let cardTriangles = 0;
  let cardArea = 0;
  const diagonals: number[] = [];
  for (let c = 0; c < components.count; c++) {
    if (components.triangles[c]! < structuralMin) {
      thinnable[c] = 1;
      cardTriangles += components.triangles[c]!;
      cardArea += components.area[c]!;
      diagonals.push(components.diagonal[c]!);
    }
  }
  const medianTriangles = quantile(components.triangles, 0.5);
  const cardLike = alphaMasked
    && components.count >= CARD_MIN_COMPONENTS
    && medianTriangles <= CARD_MAX_MEDIAN_TRIANGLES
    && cardTriangles >= total * 0.3;
  return { cardLike, thinnable, cardTriangles, cardArea, medianCardDiagonal: quantile(diagonals, 0.5) };
}

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

/** Per-attribute weights for `simplifyWithAttributes` (normals only; UV seams are kept topologically). */
const NORMAL_WEIGHT = 0.5;

export interface SimplifyResult {
  indices: Uint32Array;
  /** meshoptimizer's error estimate, mesh-local metres. */
  error: number;
}

/**
 * meshoptimizer simplification of `indices` (a subset of the primitive's
 * triangles) toward `targetTriangles`, never beyond `maxError` (mesh-local
 * metres). Attribute seams are preserved; normals are weighted so shading
 * creases survive.
 */
export function simplify(primitive: PrimitiveData, indices: Uint32Array, targetTriangles: number, maxError: number, options: { lockBorder?: boolean; prune?: boolean } = {}): SimplifyResult {
  if (indices.length === 0 || targetTriangles * 3 >= indices.length) return { indices: indices.slice(), error: 0 };
  const P = positions(primitive);
  const flags: Array<'LockBorder' | 'ErrorAbsolute' | 'Prune'> = ['ErrorAbsolute'];
  if (options.lockBorder) flags.push('LockBorder');
  if (options.prune) flags.push('Prune');
  const normal = primitive.attributes.get('NORMAL');
  const target = Math.max(3, Math.floor(targetTriangles) * 3);
  const [result, error] = normal && normal.components === 3
    ? MeshoptSimplifier.simplifyWithAttributes(indices, P, 3, normal.data, 3, [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT], null, target, maxError, flags)
    : MeshoptSimplifier.simplify(indices, P, 3, target, maxError, flags);
  return { indices: result, error };
}

// ---------------------------------------------------------------------------
// Card thinning
// ---------------------------------------------------------------------------

function spread10(v: number): number {
  let x = v & 0x3ff;
  x = (x | (x << 16)) & 0x030000ff;
  x = (x | (x << 8)) & 0x0300f00f;
  x = (x | (x << 4)) & 0x030c30c3;
  x = (x | (x << 2)) & 0x09249249;
  return x >>> 0;
}

/** Components in 3D Morton order of their centroids (ties by id): a spatially uniform walk. */
export function mortonOrder(components: Components, ids: readonly number[]): number[] {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const c of ids) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, components.centroid[c * 3 + k]!);
      hi[k] = Math.max(hi[k]!, components.centroid[c * 3 + k]!);
    }
  }
  const code = (c: number): number => {
    let m = 0;
    for (let k = 0; k < 3; k++) {
      const span = hi[k]! - lo[k]! || 1;
      const q = Math.min(1023, Math.max(0, Math.floor(((components.centroid[c * 3 + k]! - lo[k]!) / span) * 1024)));
      m |= spread10(q) << k;
    }
    return m >>> 0;
  };
  return ids.map((c) => [code(c), c] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, c]) => c);
}

export interface ThinResult {
  /** Kept component ids. */
  kept: Set<number>;
  /** Uniform scale applied to every kept card about its centroid. */
  scale: number;
  keptArea: number;
}

/**
 * Keep a spatially uniform `fraction` of the thinnable components (error
 * diffusion along the Morton walk, so kept cards are evenly spread) and
 * scale each kept card about its centroid so the total leaf area is
 * preserved: a canopy keeps its coverage (and its lidar transmission)
 * instead of going bald. The scale is capped at `maxScale`.
 */
export function thinCards(components: Components, thinnable: Uint8Array, fraction: number, maxScale: number): ThinResult {
  const ids: number[] = [];
  let totalArea = 0;
  for (let c = 0; c < components.count; c++) {
    if (thinnable[c]) {
      ids.push(c);
      totalArea += components.area[c]!;
    }
  }
  const kept = new Set<number>();
  let keptArea = 0;
  if (fraction >= 1) {
    for (const c of ids) kept.add(c);
    return { kept, scale: 1, keptArea: totalArea };
  }
  const order = mortonOrder(components, ids);
  order.forEach((c, i) => {
    if (Math.floor((i + 1) * fraction) > Math.floor(i * fraction)) {
      kept.add(c);
      keptArea += components.area[c]!;
    }
  });
  const scale = keptArea > 0 ? Math.min(maxScale, Math.sqrt(totalArea / keptArea)) : 1;
  return { kept, scale, keptArea };
}

// ---------------------------------------------------------------------------
// Building a primitive from an index subset
// ---------------------------------------------------------------------------

/**
 * A new primitive holding only the vertices `indices` reference, in first-use
 * order (deterministic), with every source attribute carried over. `scaleOf`
 * optionally scales a vertex about its component's centroid (card thinning).
 */
export function compactPrimitive(
  primitive: PrimitiveData,
  indices: Uint32Array,
  transform?: { components: Components; scale: number; scaled: (component: number) => boolean },
): PrimitiveData {
  const n = vertexCount(primitive);
  const remap = new Int32Array(n).fill(-1);
  const order: number[] = [];
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!;
    if (remap[v] === -1) {
      remap[v] = order.length;
      order.push(v);
    }
    out[i] = remap[v]!;
  }
  const attributes = new Map<string, AttributeData>();
  for (const [semantic, attribute] of primitive.attributes) {
    const k = attribute.components;
    const data = new Float32Array(order.length * k);
    order.forEach((v, i) => {
      for (let c = 0; c < k; c++) data[i * k + c] = attribute.data[v * k + c]!;
    });
    if (semantic === 'POSITION' && transform && transform.scale !== 1) {
      order.forEach((v, i) => {
        const component = transform.components.ofVertex[v]!;
        if (component < 0 || !transform.scaled(component)) return;
        for (let c = 0; c < 3; c++) {
          const center = transform.components.centroid[component * 3 + c]!;
          data[i * 3 + c] = center + (data[i * 3 + c]! - center) * transform.scale;
        }
      });
    }
    attributes.set(semantic, { ...attribute, data });
  }
  return { attributes, indices: out };
}

/** Triangles of `indices` whose component passes `keep`. */
export function filterTriangles(indices: Uint32Array, components: Components, keep: (component: number, triangle: number) => boolean, triangleOf?: Int32Array): Uint32Array {
  const out: number[] = [];
  for (let t = 0; t < indices.length / 3; t++) {
    const source = triangleOf ? triangleOf[t]! : t;
    if (keep(components.ofTriangle[source]!, source)) out.push(indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!);
  }
  return Uint32Array.from(out);
}

/** Component id of each triangle of a (simplified) index list, via its first vertex. */
export function componentsOfIndices(indices: Uint32Array, components: Components): Int32Array {
  const out = new Int32Array(indices.length / 3);
  for (let t = 0; t < out.length; t++) out[t] = components.ofVertex[indices[t * 3]!]!;
  return out;
}

/** Bounding sphere (AABB centre, max distance) of a primitive set's positions. */
export function boundingSphere(primitives: readonly PrimitiveData[]): { center: [number, number, number]; radius: number } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const primitive of primitives) {
    const P = positions(primitive);
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, P[i + k]!);
        hi[k] = Math.max(hi[k]!, P[i + k]!);
      }
    }
  }
  const center: [number, number, number] = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
  let radius = 0;
  for (const primitive of primitives) {
    const P = positions(primitive);
    for (let i = 0; i < P.length; i += 3) radius = Math.max(radius, Math.hypot(P[i]! - center[0], P[i + 1]! - center[1], P[i + 2]! - center[2]));
  }
  return { center, radius };
}
