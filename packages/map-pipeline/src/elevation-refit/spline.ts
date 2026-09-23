/**
 * C1 cubic Hermite splines fitted by (robust) least squares, and their
 * conversion to OpenDRIVE cubic records.
 *
 * A road surface near the reference line is modelled as
 *
 *     z(s, t) = E(s) + t * G(s)
 *
 * with E the elevation and G = tan(superelevation). Both are cubic Hermite
 * splines on one knot vector; the unknowns at knot k are
 * `[E_k, E'_k, G_k, G'_k]`. A Hermite spline is C1 by construction, so the
 * emitted OpenDRIVE `<elevation>`/`<superelevation>` records are C1 at every
 * record boundary. Endpoint values and slopes can be pinned (continuity with
 * neighbouring roads). The normal matrix is banded (half-bandwidth 7), so
 * the solve is linear in the number of knots.
 */

export const UNKNOWNS_PER_KNOT = 4;
const HALF_BAND = 2 * UNKNOWNS_PER_KNOT - 1;

export type Component = 0 | 1; // 0 = E (elevation), 1 = G (tan superelevation)

/** Hermite basis on interval [s0, s0 + h] at s: weights of (v0, m0, v1, m1). */
export function hermiteBasis(u: number, h: number): [number, number, number, number] {
  const u2 = u * u; const u3 = u2 * u;
  return [2 * u3 - 3 * u2 + 1, (u3 - 2 * u2 + u) * h, -2 * u3 + 3 * u2, (u3 - u2) * h];
}

export function hermiteBasisDerivative(u: number, h: number): [number, number, number, number] {
  const u2 = u * u;
  return [(6 * u2 - 6 * u) / h, 3 * u2 - 4 * u + 1, (-6 * u2 + 6 * u) / h, 3 * u2 - 2 * u];
}

export function intervalOf(knots: Float64Array, s: number): number {
  let lo = 0; let hi = knots.length - 2;
  if (s <= knots[0]!) return 0;
  if (s >= knots[hi]!) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (knots[mid]! <= s) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export interface Spline2 {
  knots: Float64Array;
  /** Length `4 * knots.length`: [E, E', G, G'] per knot. */
  coef: Float64Array;
}

export function evalComponent(spline: Spline2, component: Component, s: number): { value: number; slope: number } {
  const k = intervalOf(spline.knots, s);
  const s0 = spline.knots[k]!; const h = spline.knots[k + 1]! - s0;
  const u = h > 0 ? Math.min(1, Math.max(0, (s - s0) / h)) : 0;
  const b = hermiteBasis(u, h); const d = hermiteBasisDerivative(u, h);
  const i0 = k * UNKNOWNS_PER_KNOT + 2 * component; const i1 = i0 + UNKNOWNS_PER_KNOT;
  const x = [spline.coef[i0]!, spline.coef[i0 + 1]!, spline.coef[i1]!, spline.coef[i1 + 1]!];
  return { value: b[0] * x[0]! + b[1] * x[1]! + b[2] * x[2]! + b[3] * x[3]!, slope: d[0] * x[0]! + d[1] * x[1]! + d[2] * x[2]! + d[3] * x[3]! };
}

/** One observation: z at (s, t) with weight w. `lateral=false` observes E alone (t is ignored). */
export interface Observation { s: number; t: number; z: number; w: number }

export interface Pin { index: number; value: number }

export interface FitOptions {
  /** Weight of the integrated squared second derivative of E. */
  smoothE: number;
  /** Weight of the integrated squared second derivative of G. */
  smoothG: number;
  /** Ridge on G values (pulls an unidentified cross-slope to 0). */
  ridgeG: number;
  /** Fit G at all (false: G is pinned to its constraints or 0). */
  fitLateral: boolean;
}

/** Index of an unknown: knot k, component c, derivative order d (0 value, 1 slope). */
export const unknownIndex = (k: number, c: Component, d: 0 | 1): number => k * UNKNOWNS_PER_KNOT + 2 * c + d;

/** Integrated squared second derivative of one Hermite piece as a 4x4 quadratic form in (v0, m0, v1, m1). */
function curvatureForm(h: number): number[][] {
  // p(s) = a + b s + c s^2 + d s^3;  c = (3(v1-v0)/h - 2m0 - m1)/h,  d = (m0 + m1 - 2(v1-v0)/h)/h^2
  const cv = [-3 / (h * h), -2 / h, 3 / (h * h), -1 / h];
  const dv = [2 / (h * h * h), 1 / (h * h), -2 / (h * h * h), 1 / (h * h)];
  // int_0^h (2c + 6 d s)^2 ds = 4 c^2 h + 12 c d h^2 + 12 d^2 h^3
  const m: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    m.push([]);
    for (let j = 0; j < 4; j += 1) m[i]!.push(4 * h * cv[i]! * cv[j]! + 6 * h * h * (cv[i]! * dv[j]! + dv[i]! * cv[j]!) + 12 * h * h * h * dv[i]! * dv[j]!);
  }
  return m;
}

/** Symmetric banded matrix (lower band stored) with a band Cholesky solve. */
class BandSystem {
  readonly a: Float64Array;
  readonly b: Float64Array;
  constructor(readonly n: number) {
    this.a = new Float64Array(n * (HALF_BAND + 1));
    this.b = new Float64Array(n);
  }
  /** Add v to A[i][j] (|i-j| <= HALF_BAND). */
  add(i: number, j: number, v: number): void {
    if (i < j) [i, j] = [j, i];
    const off = i - j;
    if (off > HALF_BAND) throw new Error(`band overflow ${i},${j}`);
    this.a[i * (HALF_BAND + 1) + off]! += v;
  }
  get(i: number, j: number): number {
    if (i < j) [i, j] = [j, i];
    const off = i - j;
    return off > HALF_BAND ? 0 : this.a[i * (HALF_BAND + 1) + off]!;
  }
  set(i: number, j: number, v: number): void {
    if (i < j) [i, j] = [j, i];
    const off = i - j;
    if (off > HALF_BAND) { if (v !== 0) throw new Error('band overflow'); return; }
    this.a[i * (HALF_BAND + 1) + off] = v;
  }
  solve(): Float64Array {
    const n = this.n; const w = HALF_BAND;
    const L = new Float64Array(this.a);
    const at = (i: number, j: number) => i * (w + 1) + (i - j);
    for (let i = 0; i < n; i += 1) {
      for (let j = Math.max(0, i - w); j <= i; j += 1) {
        let sum = L[at(i, j)]!;
        for (let k = Math.max(0, i - w, j - w); k < j; k += 1) sum -= L[at(i, k)]! * L[at(j, k)]!;
        if (i === j) {
          if (!(sum > 0)) throw new Error(`spline fit: normal matrix not positive definite at unknown ${i} (${sum})`);
          L[at(i, i)] = Math.sqrt(sum);
        } else {
          L[at(i, j)] = sum / L[at(j, j)]!;
        }
      }
    }
    const y = new Float64Array(this.b);
    for (let i = 0; i < n; i += 1) {
      let sum = y[i]!;
      for (let k = Math.max(0, i - w); k < i; k += 1) sum -= L[at(i, k)]! * y[k]!;
      y[i] = sum / L[at(i, i)]!;
    }
    for (let i = n - 1; i >= 0; i -= 1) {
      let sum = y[i]!;
      for (let k = i + 1; k <= Math.min(n - 1, i + w); k += 1) sum -= L[at(k, i)]! * y[k]!;
      y[i] = sum / L[at(i, i)]!;
    }
    return y;
  }
}

/**
 * Weighted least squares for E and G on `knots`, with pinned unknowns.
 * Observation rows are `E(s) + t G(s) = z`.
 */
export function fitSpline2(knots: Float64Array, observations: readonly Observation[], pins: readonly Pin[], options: FitOptions): Spline2 {
  const K = knots.length;
  if (K < 2) throw new Error('spline fit: need at least two knots');
  const n = K * UNKNOWNS_PER_KNOT;
  const sys = new BandSystem(n);
  const idx = new Int32Array(8);
  const row = new Float64Array(8);
  for (const o of observations) {
    if (!(o.w > 0)) continue;
    const k = intervalOf(knots, o.s);
    const s0 = knots[k]!; const h = knots[k + 1]! - s0;
    const u = Math.min(1, Math.max(0, (o.s - s0) / h));
    const b = hermiteBasis(u, h);
    let m = 0;
    for (let c = 0; c < 2; c += 1) {
      if (c === 1 && !options.fitLateral) continue;
      const scale = c === 0 ? 1 : o.t;
      for (let q = 0; q < 4; q += 1) {
        const knot = k + (q >> 1);
        idx[m] = knot * UNKNOWNS_PER_KNOT + 2 * c + (q & 1);
        row[m] = b[q]! * scale;
        m += 1;
      }
    }
    for (let i = 0; i < m; i += 1) {
      sys.b[idx[i]!]! += o.w * row[i]! * o.z;
      for (let j = 0; j <= i; j += 1) sys.add(idx[i]!, idx[j]!, o.w * row[i]! * row[j]!);
    }
  }
  for (let k = 0; k + 1 < K; k += 1) {
    const h = knots[k + 1]! - knots[k]!;
    const form = curvatureForm(h);
    for (let c = 0; c < 2; c += 1) {
      const lambda = c === 0 ? options.smoothE : options.smoothG;
      if (lambda <= 0) continue;
      const ids = [unknownIndex(k, c as Component, 0), unknownIndex(k, c as Component, 1), unknownIndex(k + 1, c as Component, 0), unknownIndex(k + 1, c as Component, 1)];
      for (let i = 0; i < 4; i += 1) for (let j = 0; j <= i; j += 1) sys.add(ids[i]!, ids[j]!, lambda * form[i]![j]!);
    }
  }
  for (let k = 0; k < K; k += 1) {
    // Tiny ridge keeps every unknown identified (slopes on data-free spans).
    for (let d = 0; d < UNKNOWNS_PER_KNOT; d += 1) sys.add(k * UNKNOWNS_PER_KNOT + d, k * UNKNOWNS_PER_KNOT + d, 1e-9);
    sys.add(unknownIndex(k, 1, 0), unknownIndex(k, 1, 0), options.fitLateral ? options.ridgeG : 1);
    sys.add(unknownIndex(k, 1, 1), unknownIndex(k, 1, 1), options.fitLateral ? options.ridgeG : 1);
  }
  // Pins: eliminate by replacing the row/column with the identity.
  const pinned = new Map<number, number>();
  for (const p of pins) pinned.set(p.index, p.value);
  for (const [i, value] of pinned) {
    for (let j = Math.max(0, i - HALF_BAND); j <= Math.min(n - 1, i + HALF_BAND); j += 1) {
      if (j === i || pinned.has(j)) continue;
      sys.b[j]! -= sys.get(j, i) * value;
      sys.set(j, i, 0);
    }
  }
  for (const [i, value] of pinned) {
    for (let j = Math.max(0, i - HALF_BAND); j <= Math.min(n - 1, i + HALF_BAND); j += 1) if (j !== i) sys.set(i, j, 0);
    sys.set(i, i, 1);
    sys.b[i] = value;
  }
  const coef = sys.solve();
  return { knots: Float64Array.from(knots), coef };
}

/** OpenDRIVE cubic record `(s, a, b, c, d)`. */
export type CubicRecord = [s: number, a: number, b: number, c: number, d: number];

/** Hermite piece -> OpenDRIVE record. */
function toRecord(s0: number, h: number, v0: number, m0: number, v1: number, m1: number): CubicRecord {
  const dv = v1 - v0;
  return [s0, v0, m0, (3 * dv / h - 2 * m0 - m1) / h, (m0 + m1 - 2 * dv / h) / (h * h)];
}

/**
 * Elevation records from the fitted E, merging consecutive pieces that are
 * the same cubic (within `mergeTolM` over the merged span).
 */
export function elevationRecords(spline: Spline2): CubicRecord[] {
  const out: CubicRecord[] = [];
  const K = spline.knots.length;
  for (let k = 0; k + 1 < K; k += 1) {
    const s0 = spline.knots[k]!; const h = spline.knots[k + 1]! - s0;
    const c = spline.coef;
    out.push(toRecord(s0, h, c[unknownIndex(k, 0, 0)]!, c[unknownIndex(k, 0, 1)]!, c[unknownIndex(k + 1, 0, 0)]!, c[unknownIndex(k + 1, 0, 1)]!));
  }
  return out;
}

/**
 * Superelevation records: phi = atan(G) at every knot, phi' = G' / (1 + G^2),
 * Hermite in phi. For road cross-slopes (|G| < 0.2) the difference from
 * atan of the G spline is far below a millimetre across a carriageway.
 */
export function superelevationRecords(spline: Spline2): CubicRecord[] {
  const out: CubicRecord[] = [];
  const K = spline.knots.length;
  const c = spline.coef;
  const phi = (k: number) => Math.atan(c[unknownIndex(k, 1, 0)]!);
  const dphi = (k: number) => c[unknownIndex(k, 1, 1)]! / (1 + c[unknownIndex(k, 1, 0)]! ** 2);
  for (let k = 0; k + 1 < K; k += 1) {
    const s0 = spline.knots[k]!; const h = spline.knots[k + 1]! - s0;
    out.push(toRecord(s0, h, phi(k), dphi(k), phi(k + 1), dphi(k + 1)));
  }
  return out;
}

export function evalRecords(records: readonly CubicRecord[], s: number): { value: number; slope: number } {
  if (records.length === 0) return { value: 0, slope: 0 };
  let r = records[0]!;
  for (const candidate of records) { if (candidate[0] > s) break; r = candidate; }
  const ds = s - r[0];
  return { value: r[1] + r[2] * ds + r[3] * ds * ds + r[4] * ds * ds * ds, slope: r[2] + 2 * r[3] * ds + 3 * r[4] * ds * ds };
}

/** Merge adjacent records whose cubics are identical to within `tol` (collinear linear pieces etc.). */
export function mergeRecords(records: readonly CubicRecord[], length: number, tol = 1e-4): CubicRecord[] {
  const out: CubicRecord[] = [];
  for (const r of records) {
    const prev = out[out.length - 1];
    if (prev) {
      const next = records[records.indexOf(r) + 1];
      const end = next ? next[0] : length;
      // Does prev's cubic reproduce r over [r.s, end]?
      let same = true;
      for (let i = 0; i <= 8 && same; i += 1) {
        const s = r[0] + ((end - r[0]) * i) / 8;
        const ds = s - prev[0];
        const pv = prev[1] + prev[2] * ds + prev[3] * ds * ds + prev[4] * ds * ds * ds;
        const q = s - r[0];
        const rv = r[1] + r[2] * q + r[3] * q * q + r[4] * q * q * q;
        if (Math.abs(pv - rv) > tol) same = false;
      }
      if (same) continue;
    }
    out.push(r);
  }
  return out;
}
