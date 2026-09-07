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
 * Invert a rigid 4x4 transform. Rotation is orthonormal by construction here,
 * so the inverse is the transpose with a re-expressed translation — using a
 * general inverse would only add error.
 */
function invertRigid(matrix: number[][]): { r: number[][]; t: number[] } {
  const r = [
    [matrix[0][0], matrix[1][0], matrix[2][0]],
    [matrix[0][1], matrix[1][1], matrix[2][1]],
    [matrix[0][2], matrix[1][2], matrix[2][2]],
  ];
  const t = [matrix[0][3], matrix[1][3], matrix[2][3]];
  return {
    r,
    t: [
      -(r[0][0] * t[0] + r[0][1] * t[1] + r[0][2] * t[2]),
      -(r[1][0] * t[0] + r[1][1] * t[1] + r[1][2] * t[2]),
      -(r[2][0] * t[0] + r[2][1] * t[1] + r[2][2] * t[2]),
    ],
  };
}

export type Projector = (point: number[]) => ImagePoint | null;

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

  const K = projection.K;
  if (K.length !== 3 || K.some((row) => row.length !== 3)) return null;
  const fx = K[0][0];
  const fy = K[1][1];
  const cx = K[0][2];
  const cy = K[1][2];
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx === 0 || fy === 0) return null;

  const { r, t } = invertRigid(projection.extrinsicsRigFromCamera);
  const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = coeffs;
  const [width, height] = projection.imageSize;

  return (point: number[]) => {
    if (point.length < 3) return null;
    // FLU rig metres -> optical camera metres.
    const x = r[0][0] * point[0] + r[0][1] * point[1] + r[0][2] * point[2] + t[0];
    const y = r[1][0] * point[0] + r[1][1] * point[1] + r[1][2] * point[2] + t[1];
    const z = r[2][0] * point[0] + r[2][1] * point[1] + r[2][2] * point[2] + t[2];
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
