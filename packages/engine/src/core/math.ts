/**
 * Small deterministic geometry helpers.
 *
 * Everything here operates in the **xodr-local** frame: `x` east, `y` north,
 * metres, headings measured CCW from `+x`. See `src/frames.ts` for the
 * scene-frame boundary.
 */

/** A 2-D point in xodr-local metres. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export const TWO_PI = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Wrap an angle into `(-PI, PI]`. */
export function normalizeAngle(a: number): number {
  let v = a % TWO_PI;
  if (v <= -Math.PI) v += TWO_PI;
  if (v > Math.PI) v -= TWO_PI;
  return v;
}

/** Shortest signed delta from `from` to `to`, in `(-PI, PI]`. */
export function angleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

/** Interpolate between two headings the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  return normalizeAngle(a + angleDelta(a, b) * t);
}

/**
 * Round to a fixed number of decimals with a deterministic tie rule.
 *
 * Used only for trace serialisation, never inside the integrator: quantising
 * the output keeps the gzipped trace small and keeps byte-comparison stable
 * across platforms that may differ in the last ULP of `Math.hypot` et al.
 */
export function quantize(v: number, decimals: number): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** decimals;
  // `Math.round` on a negative half rounds toward +Infinity; force symmetry so
  // mirrored scenarios quantise identically.
  const scaled = v * f;
  const r = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  // `+ 0` normalises `-0` to `0` so JSON.stringify never emits `-0`.
  return r / f + 0;
}

/** An oriented bounding box in the ground plane. */
export interface Obb {
  /** Centre in xodr-local metres. */
  readonly center: Vec2;
  /** Full length along the heading axis, metres. */
  readonly lengthM: number;
  /** Full width across the heading axis, metres. */
  readonly widthM: number;
  /** Heading in radians, CCW from `+x`. */
  readonly headingRad: number;
}

/** The four corners of an OBB, counter-clockwise from front-left. */
export function obbCorners(obb: Obb): [Vec2, Vec2, Vec2, Vec2] {
  const c = Math.cos(obb.headingRad);
  const s = Math.sin(obb.headingRad);
  const hl = obb.lengthM / 2;
  const hw = obb.widthM / 2;
  const fx = c * hl;
  const fy = s * hl;
  const lx = -s * hw;
  const ly = c * hw;
  return [
    { x: obb.center.x + fx + lx, y: obb.center.y + fy + ly },
    { x: obb.center.x - fx + lx, y: obb.center.y - fy + ly },
    { x: obb.center.x - fx - lx, y: obb.center.y - fy - ly },
    { x: obb.center.x + fx - lx, y: obb.center.y + fy - ly },
  ];
}

function projectExtent(points: readonly Vec2[], ax: number, ay: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const v = p.x * ax + p.y * ay;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Separating-axis test. `true` when the two boxes overlap (touching counts). */
export function obbOverlap(a: Obb, b: Obb): boolean {
  const ca = obbCorners(a);
  const cb = obbCorners(b);
  const axes: Array<[number, number]> = [
    [Math.cos(a.headingRad), Math.sin(a.headingRad)],
    [-Math.sin(a.headingRad), Math.cos(a.headingRad)],
    [Math.cos(b.headingRad), Math.sin(b.headingRad)],
    [-Math.sin(b.headingRad), Math.cos(b.headingRad)],
  ];
  for (const [ax, ay] of axes) {
    const [alo, ahi] = projectExtent(ca, ax, ay);
    const [blo, bhi] = projectExtent(cb, ax, ay);
    if (ahi < blo || bhi < alo) return false;
  }
  return true;
}

/** Exact minimum surface separation between two ground-plane OBBs. */
export function obbSeparation(a: Obb, b: Obb): number {
  if (obbOverlap(a, b)) return 0;
  const ac = obbCorners(a);
  const bc = obbCorners(b);
  let best2 = Infinity;
  for (const p of ac) for (let i = 0; i < 4; i++) best2 = Math.min(best2, pointSegment(p, bc[i]!, bc[(i + 1) % 4]!).d2);
  for (const p of bc) for (let i = 0; i < 4; i++) best2 = Math.min(best2, pointSegment(p, ac[i]!, ac[(i + 1) % 4]!).d2);
  return Math.sqrt(best2);
}

/** Squared distance from a point to a segment, plus the clamped parameter. */
export function pointSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; d2: number; closest: Vec2 } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 <= 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  const closest = { x: a.x + dx * t, y: a.y + dy * t };
  return { t, d2: dist2(p, closest), closest };
}

/** Segment/segment intersection parameter along `p→p2`, or `null`. */
export function segmentIntersection(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2): number | null {
  const rx = p2.x - p.x;
  const ry = p2.y - p.y;
  const sx = q2.x - q.x;
  const sy = q2.y - q.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qpx = q.x - p.x;
  const qpy = q.y - p.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/** Point-in-polygon by ray casting; boundary membership is unspecified. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const xAt = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xAt) inside = !inside;
    }
  }
  return inside;
}

/* ---------------------------------------------------------- swept OBB */

const SWEEP_CONTACT_EPSILON_M = 1e-9;
const SWEEP_MAX_ITERATIONS = 256;

export interface SweptObbResult {
  /** First contact as a fraction of the supplied motion interval. */
  readonly toi: number;
}

function projectionRadius(obb: Obb, ax: number, ay: number): number {
  const c = Math.cos(obb.headingRad);
  const s = Math.sin(obb.headingRad);
  return (
    Math.abs(c * ax + s * ay) * (obb.lengthM / 2) +
    Math.abs(-s * ax + c * ay) * (obb.widthM / 2)
  );
}

/** Exact swept SAT for translating boxes with fixed headings and dimensions. */
function fixedOrientationSweep(a0: Obb, a1: Obb, b0: Obb, b1: Obb): SweptObbResult | null {
  let enter = 0;
  let leave = 1;
  const axes: Array<[number, number]> = [
    [Math.cos(a0.headingRad), Math.sin(a0.headingRad)],
    [-Math.sin(a0.headingRad), Math.cos(a0.headingRad)],
    [Math.cos(b0.headingRad), Math.sin(b0.headingRad)],
    [-Math.sin(b0.headingRad), Math.cos(b0.headingRad)],
  ];
  const rel0 = { x: b0.center.x - a0.center.x, y: b0.center.y - a0.center.y };
  const relDelta = {
    x: (b1.center.x - b0.center.x) - (a1.center.x - a0.center.x),
    y: (b1.center.y - b0.center.y) - (a1.center.y - a0.center.y),
  };
  for (const [ax, ay] of axes) {
    const radius = projectionRadius(a0, ax, ay) + projectionRadius(b0, ax, ay);
    const p = rel0.x * ax + rel0.y * ay;
    const v = relDelta.x * ax + relDelta.y * ay;
    if (Math.abs(v) < 1e-15) {
      if (Math.abs(p) > radius) return null;
      continue;
    }
    const t0 = (-radius - p) / v;
    const t1 = (radius - p) / v;
    const axisEnter = Math.min(t0, t1);
    const axisLeave = Math.max(t0, t1);
    enter = Math.max(enter, axisEnter);
    leave = Math.min(leave, axisLeave);
    if (enter > leave) return null;
  }
  return enter <= 1 && leave >= 0 ? { toi: Math.max(0, enter) } : null;
}

/** The box interpolated a fraction `t` of the way from `from` to `to`. */
export function obbAt(from: Obb, to: Obb, t: number): Obb {
  return {
    center: { x: lerp(from.center.x, to.center.x, t), y: lerp(from.center.y, to.center.y, t) },
    lengthM: lerp(from.lengthM, to.lengthM, t),
    widthM: lerp(from.widthM, to.widthM, t),
    headingRad: lerpAngle(from.headingRad, to.headingRad, t),
  };
}

/**
 * Continuous OBB collision over one motion interval.
 *
 * Translation with fixed headings uses an exact swept SAT. Rotating boxes use
 * deterministic conservative advancement with a bound on corner velocity, so
 * an overlap cannot be stepped over. The result is stable for the same
 * IEEE-754 inputs and does not depend on wall-clock iteration budgets. This is
 * the presentation-side handoff used for external (SUMO) traffic; the engine's
 * own collision detection runs natively.
 */
export function sweptObbTimeOfImpact(a0: Obb, a1: Obb, b0: Obb, b1: Obb): SweptObbResult | null {
  if (obbOverlap(a0, b0)) return { toi: 0 };
  const da = angleDelta(a0.headingRad, a1.headingRad);
  const db = angleDelta(b0.headingRad, b1.headingRad);
  const dimensionsStable =
    Math.abs(a1.lengthM - a0.lengthM) < 1e-12 &&
    Math.abs(a1.widthM - a0.widthM) < 1e-12 &&
    Math.abs(b1.lengthM - b0.lengthM) < 1e-12 &&
    Math.abs(b1.widthM - b0.widthM) < 1e-12;
  if (Math.abs(da) < 1e-12 && Math.abs(db) < 1e-12 && dimensionsStable) {
    return fixedOrientationSweep(a0, a1, b0, b1);
  }

  const relativeTravel = Math.hypot(
    (b1.center.x - b0.center.x) - (a1.center.x - a0.center.x),
    (b1.center.y - b0.center.y) - (a1.center.y - a0.center.y),
  );
  const speedBound =
    relativeTravel +
    Math.abs(da) * Math.hypot(a0.lengthM, a0.widthM) / 2 +
    Math.abs(db) * Math.hypot(b0.lengthM, b0.widthM) / 2 +
    Math.hypot(a1.lengthM - a0.lengthM, a1.widthM - a0.widthM) / 2 +
    Math.hypot(b1.lengthM - b0.lengthM, b1.widthM - b0.widthM) / 2;
  if (speedBound <= 0) return null;

  let t = 0;
  for (let iteration = 0; iteration < SWEEP_MAX_ITERATIONS && t <= 1; iteration++) {
    const a = obbAt(a0, a1, t);
    const b = obbAt(b0, b1, t);
    const separation = obbSeparation(a, b);
    if (separation <= SWEEP_CONTACT_EPSILON_M || obbOverlap(a, b)) return { toi: t };
    const step = separation / speedBound;
    if (step <= 1e-14) return { toi: t };
    t += step;
  }
  if (t <= 1 && obbOverlap(obbAt(a0, a1, t), obbAt(b0, b1, t))) return { toi: t };
  return null;
}
