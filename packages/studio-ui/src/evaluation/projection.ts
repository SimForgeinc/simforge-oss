/**
 * Metric-to-image projection for frame overlays.
 *
 * An overlay drawn on a camera frame asserts a correspondence between a
 * predicted path and the world the camera saw. That assertion is only allowed
 * when the clip carried the calibration to support it, so this module refuses
 * rather than approximates: an unrecognized distortion model with non-zero
 * coefficients yields null, and the caller falls back to the bird's-eye plot.
 */

import type { TrajectoryProjection } from "./contracts";

/** Distortion models whose coefficient order this implementation actually knows. */
const KNOWN_DISTORTION_MODELS = ["none", "pinhole", "plumb_bob", "radtan", "opencv", "rational_polynomial"];

export type ImagePoint = { x: number; y: number; depth: number };

/**
 * Flatten a square matrix of `size` rows into row-major numbers, or null when
 * it is not that shape or carries a non-finite entry.
 *
 * Validating once here is what lets the projector below read fixed offsets
 * without a guard per element, and it is also the honest place to refuse: a
 * calibration with a missing or NaN entry cannot be projected with, and the
 * caller falls back to the metric plot.
 */
function flattenSquare(
  rows: readonly (readonly number[])[],
  size: number,
): Float64Array | null {
  if (rows.length !== size) return null;
  const flat = new Float64Array(size * size);
  for (let row = 0; row < size; row += 1) {
    const entries = rows[row];
    if (!entries || entries.length < size) return null;
    for (let column = 0; column < size; column += 1) {
      const value = entries[column];
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      flat[row * size + column] = value;
    }
  }
  return flat;
}

/**
 * Read a validated matrix entry.
 *
 * `flattenSquare` has already proved every index below `size * size` holds a
 * finite number, so the fallback is unreachable — it exists only because the
 * index signature cannot express that proof.
 */
function at(matrix: Float64Array, index: number): number {
  return matrix[index] ?? 0;
}

export type Projector = (point: readonly number[]) => ImagePoint | null;

/**
 * Build a projector for one camera, or null when the calibration is not one
 * this code can honour.
 *
 * Input points are rig/ego-frame metres in FLU (x forward, y left, z up); the
 * camera frame is optical (x right, y down, z forward), which is the convention
 * the extrinsics and intrinsics are expressed in.
 */
export function createProjector(projection: TrajectoryProjection): Projector | null {
  const distortion = projection.distortion;
  const coeffs = distortion?.coeffs ?? [];
  const model = (distortion?.model ?? "none").toLowerCase();
  const distorted = coeffs.some((value) => value !== 0);
  if (distorted && !KNOWN_DISTORTION_MODELS.includes(model)) return null;

  const k = flattenSquare(projection.K, 3);
  if (!k) return null;
  const fx = at(k, 0);
  const cx = at(k, 2);
  const fy = at(k, 4);
  const cy = at(k, 5);
  if (fx === 0 || fy === 0) return null;

  // Rigid inverse: the rotation is orthonormal by construction, so the inverse
  // is its transpose with a re-expressed translation. A general inverse would
  // only add error. Every entry is hoisted into a scalar here so the per-point
  // path below does no indexing at all.
  const e = flattenSquare(projection.extrinsicsRigFromCamera, 4);
  if (!e) return null;
  const r00 = at(e, 0);
  const r01 = at(e, 4);
  const r02 = at(e, 8);
  const r10 = at(e, 1);
  const r11 = at(e, 5);
  const r12 = at(e, 9);
  const r20 = at(e, 2);
  const r21 = at(e, 6);
  const r22 = at(e, 10);
  const tx = at(e, 3);
  const ty = at(e, 7);
  const tz = at(e, 11);
  const t0 = -(r00 * tx + r01 * ty + r02 * tz);
  const t1 = -(r10 * tx + r11 * ty + r12 * tz);
  const t2 = -(r20 * tx + r21 * ty + r22 * tz);

  const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = coeffs;
  const [width = 0, height = 0] = projection.imageSize;

  return (point: readonly number[]) => {
    const [px, py, pz] = point;
    if (px === undefined || py === undefined || pz === undefined) return null;
    // FLU rig metres -> optical camera metres.
    const x = r00 * px + r01 * py + r02 * pz + t0;
    const y = r10 * px + r11 * py + r12 * pz + t1;
    const z = r20 * px + r21 * py + r22 * pz + t2;
    if (z <= 0.05) return null; // Behind or on the image plane: nothing to draw.

    const nx = x / z;
    const ny = y / z;
    const r2 = nx * nx + ny * ny;
    const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    const dx = nx * radial + 2 * p1 * nx * ny + p2 * (r2 + 2 * nx * nx);
    const dy = ny * radial + p1 * (r2 + 2 * ny * ny) + 2 * p2 * nx * ny;

    const u = fx * dx + cx;
    const v = fy * dy + cy;
    if (u < -width || u > 2 * width || v < -height || v > 2 * height) return null;
    return { x: u, y: v, depth: z };
  };
}

/** Project a polyline, dropping points the camera could not have seen. */
export function projectPolyline(projector: Projector, line: number[][]): ImagePoint[] {
  const projected: ImagePoint[] = [];
  for (const point of line) {
    const image = projector(point);
    if (image) projected.push(image);
  }
  return projected;
}
