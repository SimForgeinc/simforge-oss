import { compactPrimitive, filterTriangles, simplify, triangleCount } from './mesh-ops.js';
import type { AttributeData, PrimitiveData } from './mesh-ops.js';
import type { PreparedPrimitive } from './levels.js';

/**
 * Simplified sensor collision geometry (lidar/radar raycasts).
 *
 * The sensor scene is a flat BVH over world-space triangles, so its size is
 * the map's instanced triangle count: 266M on Belmont, ~15 GB serialized.
 * Raycasts need shape, not shading, so:
 *
 * - Surfaces (roads, buildings, props) are simplified by meshoptimizer
 *   under an absolute error bound (`surfaceErrorM` in world metres, divided
 *   by the largest instance scale of the mesh), with pruning of disconnected
 *   pieces smaller than the bound. Trunks, branches and twigs of vegetation
 *   use `vegetationSurfaceErrorM`.
 * - Foliage cards (see `analyzeCards`) are aggregated per voxel: every card
 *   whose centroid falls in a `voxelM` cell is replaced by one square card of
 *   the same total one-sided area, at the cards' area-weighted centroid,
 *   oriented along their dominant normal (cells are sized at the mesh's
 *   median instance scale). The exact scene raycasts cards as
 *   solid quads (the BVH has no alpha test), so a ray's chance of being
 *   stopped inside a canopy depends on leaf area per volume, which this
 *   preserves; individual returns move by up to about a voxel.
 */

export interface SensorOptions {
  /** Absolute surface error bound, world metres. */
  surfaceErrorM: number;
  /** The bound for the non-card surfaces of vegetation (trunks, branches, twigs). */
  vegetationSurfaceErrorM: number;
  /** Foliage aggregation cell, world metres. */
  voxelM: number;
}

export const DEFAULT_SENSOR_OPTIONS: SensorOptions = { surfaceErrorM: 0.02, vegetationSurfaceErrorM: 0.1, voxelM: 0.5 };

export type SensorMethod = 'identity' | 'simplify' | 'card-aggregate';

export interface SensorPrimitive {
  data: PrimitiveData;
  method: SensorMethod;
  sourceTriangles: number;
  /** meshoptimizer's error estimate for the surface part, world metres at the largest instance scale. */
  surfaceErrorM: number;
}

function positionsOnly(primitive: PrimitiveData): PrimitiveData {
  return { attributes: new Map([['POSITION', primitive.attributes.get('POSITION')!]]), indices: primitive.indices };
}

/** Largest-eigenvalue eigenvector of a symmetric 3x3 (power iteration, fixed steps: deterministic). */
function principalAxis(m: Float64Array, offset: number): [number, number, number] {
  const a = m[offset]!, b = m[offset + 1]!, c = m[offset + 2]!, d = m[offset + 3]!, e = m[offset + 4]!, f = m[offset + 5]!;
  // [a b c; b d e; c e f]
  let x = 0.577, y = 0.577, z = 0.577;
  // Start from the largest diagonal axis to avoid a start orthogonal to the answer.
  if (a >= d && a >= f) { x = 1; y = 0.1; z = 0.1; } else if (d >= f) { x = 0.1; y = 1; z = 0.1; } else { x = 0.1; y = 0.1; z = 1; }
  for (let i = 0; i < 32; i++) {
    const nx = a * x + b * y + c * z;
    const ny = b * x + d * y + e * z;
    const nz = c * x + e * y + f * z;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) return [0, 1, 0];
    x = nx / len; y = ny / len; z = nz / len;
  }
  return [x, y, z];
}

/**
 * Replace the thinnable cards of `primitive` by one area-equivalent card per
 * `voxel` (mesh-local) cell. Returns POSITION-only geometry.
 */
export function aggregateCards(primitive: PreparedPrimitive, voxel: number): { positions: number[]; indices: number[] } {
  const { components, cards } = primitive;
  const cells = new Map<string, number>();
  const keys: string[] = [];
  const accum: number[][] = [];
  for (let c = 0; c < components.count; c++) {
    if (!cards.thinnable[c] || components.area[c]! <= 0) continue;
    const cx = components.centroid[c * 3]!, cy = components.centroid[c * 3 + 1]!, cz = components.centroid[c * 3 + 2]!;
    const key = `${Math.floor(cx / voxel)},${Math.floor(cy / voxel)},${Math.floor(cz / voxel)}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = accum.length;
      cells.set(key, cell);
      keys.push(key);
      // area, centroid*area (3), normal tensor (6)
      accum.push([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
    const acc = accum[cell]!;
    const area = components.area[c]!;
    acc[0]! += area;
    acc[1]! += cx * area; acc[2]! += cy * area; acc[3]! += cz * area;
    // Unit normal of the card, area-weighted outer product (sign-free: double-sided cards).
    let nx = components.normal[c * 3]!, ny = components.normal[c * 3 + 1]!, nz = components.normal[c * 3 + 2]!;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    acc[4]! += area * nx * nx; acc[5]! += area * nx * ny; acc[6]! += area * nx * nz;
    acc[7]! += area * ny * ny; acc[8]! += area * ny * nz; acc[9]! += area * nz * nz;
  }
  const out = { positions: [] as number[], indices: [] as number[] };
  // Cells in first-seen order (component order): deterministic.
  const tensor = new Float64Array(6);
  for (let cell = 0; cell < accum.length; cell++) {
    const acc = accum[cell]!;
    const area = acc[0]!;
    const center = [acc[1]! / area, acc[2]! / area, acc[3]! / area];
    tensor.set(acc.slice(4, 10));
    const n = principalAxis(tensor, 0);
    // In-plane axes: project world up (or X for near-horizontal cards).
    const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const k = ref[0]! * n[0] + ref[1]! * n[1] + ref[2]! * n[2];
    let ux = ref[0]! - k * n[0], uy = ref[1]! - k * n[1], uz = ref[2]! - k * n[2];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
    const half = Math.sqrt(area) / 2;
    const base = out.positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      out.positions.push(
        center[0]! + (ux * su + vx * sv) * half,
        center[1]! + (uy * su + vy * sv) * half,
        center[2]! + (uz * su + vz * sv) * half,
      );
    }
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return out;
}

/**
 * Sensor geometry for one primitive. The surface bound converts to mesh
 * units at the largest instance scale (a hard bound for every instance);
 * the foliage cell at the median instance scale (a statistical quantity).
 */
export function buildSensorPrimitive(primitive: PreparedPrimitive, scales: { max: number; median: number }, options: SensorOptions = DEFAULT_SENSOR_OPTIONS, vegetation = false): SensorPrimitive {
  const maxInstanceScale = scales.max;
  const source = positionsOnly(primitive.data);
  const sourceTriangles = triangleCount(source);
  const localError = (vegetation ? options.vegetationSurfaceErrorM : options.surfaceErrorM) / Math.max(maxInstanceScale, 1e-6);
  if (!primitive.cards.cardLike) {
    const result = simplify(source, source.indices, 1, localError, { prune: true });
    if (result.indices.length / 3 >= sourceTriangles * 0.9) {
      return { data: compactPrimitive(source, source.indices), method: 'identity', sourceTriangles, surfaceErrorM: 0 };
    }
    return { data: compactPrimitive(source, result.indices), method: 'simplify', sourceTriangles, surfaceErrorM: result.error * maxInstanceScale };
  }
  const { components, cards } = primitive;
  const structural = filterTriangles(source.indices, components, (component) => !cards.thinnable[component]);
  const surface = simplify(source, structural, 1, localError, { prune: true });
  const surfaceData = compactPrimitive(source, surface.indices);
  const aggregated = aggregateCards(primitive, options.voxelM / Math.max(scales.median, 1e-6));
  const surfacePositions = surfaceData.attributes.get('POSITION')!.data;
  const offset = surfacePositions.length / 3;
  const positions = new Float32Array(surfacePositions.length + aggregated.positions.length);
  positions.set(surfacePositions, 0);
  positions.set(aggregated.positions, surfacePositions.length);
  const indices = new Uint32Array(surfaceData.indices.length + aggregated.indices.length);
  indices.set(surfaceData.indices, 0);
  aggregated.indices.forEach((index, i) => { indices[surfaceData.indices.length + i] = index + offset; });
  const position: AttributeData = { data: positions, components: 3, componentType: 5126, normalized: false, type: 'VEC3' };
  return {
    data: { attributes: new Map([['POSITION', position]]), indices },
    method: 'card-aggregate',
    sourceTriangles,
    surfaceErrorM: surface.error * maxInstanceScale,
  };
}
