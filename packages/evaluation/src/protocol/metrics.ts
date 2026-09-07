/**
 * Open-loop trajectory metrics: real ADE/FDE definitions with explicit
 * horizon, sample count, reference and coordinate convention.
 *
 * A prediction is a set of `S` sampled trajectories, each a polyline of
 * waypoints at a fixed cadence (`dtS`, 10 Hz for the Alpamayo families) in
 * the ego frame at t0 (FLU: x forward, y left, z up), with the first waypoint
 * one `dtS` in the future. A reference future has the same cadence and frame.
 *
 * For horizon `H` seconds, `n = round(H / dtS)` waypoints are compared:
 *
 *   ADE_s(H)     = (1/n) Σ_{i<n} ‖P_s[i] − R[i]‖₂
 *   FDE_s(H)     =            ‖P_s[n−1] − R[n−1]‖₂
 *   minADE_K(H)  = min_{s<K} ADE_s(H)
 *   minFDE_K(H)  = min_{s<K} FDE_s(H)
 *
 * Distances are planar (x, y) by default because the executor and the
 * reference frames are planar; `dimensions: 3` opts into full xyz. `K` is the
 * number of samples actually predicted — it is reported, never assumed.
 *
 * A horizon whose reference is shorter than `n` waypoints yields `null` for
 * that horizon. It is never silently shortened, and a missing reference never
 * produces a score: prediction without a reference future is not evaluation.
 */

import { OPENLOOP_HORIZONS_S } from './params.js';

/** Horizon key as it appears in result documents (`'1'`, `'3'`, `'6.4'`). */
export type HorizonKey = string;
export type Waypoint = readonly number[];
export type Trajectory = readonly Waypoint[];

export interface MetricOptions {
  /** Waypoint cadence in seconds (Alpamayo: 0.1). */
  readonly dtS: number;
  /** Horizons to report, seconds. */
  readonly horizonsS?: readonly number[];
  /** 2 = planar (default), 3 = include z. */
  readonly dimensions?: 2 | 3;
}

export interface HorizonMetric {
  readonly horizonS: number;
  /** Waypoints compared at this horizon. */
  readonly points: number;
  readonly minAdeM: number;
  readonly minFdeM: number;
  /** Index of the sample that achieved `minAdeM`. */
  readonly bestSampleIndex: number;
  /** ADE of every sample, in sample order. */
  readonly adePerSampleM: readonly number[];
  /** Absolute heading error at the horizon end, radians, for the best sample. */
  readonly headingErrorRad: number;
}

export interface TrajectoryMetrics {
  /** K — samples actually predicted and scored. */
  readonly samples: number;
  readonly dtS: number;
  readonly dimensions: 2 | 3;
  /** Per-horizon metrics; a horizon the reference cannot cover is absent. */
  readonly horizons: Readonly<Record<HorizonKey, HorizonMetric>>;
  /** Horizons requested but not computable, with the reason. */
  readonly unavailable: Readonly<Record<HorizonKey, string>>;
}

function distance(a: Waypoint, b: Waypoint, dimensions: 2 | 3): number {
  let sum = 0;
  for (let axis = 0; axis < dimensions; axis += 1) {
    const delta = (a[axis] ?? 0) - (b[axis] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

/** Heading of the last segment of `points[0..n-1]`, from the ego origin. */
function terminalHeading(points: Trajectory, n: number): number {
  const last = points[n - 1]!;
  const previous = n >= 2 ? points[n - 2]! : ([0, 0, 0] as const);
  return Math.atan2((last[1] ?? 0) - (previous[1] ?? 0), (last[0] ?? 0) - (previous[0] ?? 0));
}

function angleDelta(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

/**
 * Score `samples` (K predicted trajectories) against `reference`.
 *
 * Throws only on structurally impossible input (no samples, non-positive
 * `dtS`); an insufficient reference is reported per horizon in `unavailable`.
 */
export function trajectoryMetrics(
  samples: readonly Trajectory[],
  reference: Trajectory,
  options: MetricOptions,
): TrajectoryMetrics {
  const dtS = options.dtS;
  if (!(dtS > 0)) throw new Error(`dtS must be positive, got ${String(dtS)}`);
  if (samples.length === 0) throw new Error('no predicted trajectory samples to score');
  const dimensions = options.dimensions ?? 2;
  const horizonsS = options.horizonsS ?? OPENLOOP_HORIZONS_S;

  const horizons: Record<HorizonKey, HorizonMetric> = {};
  const unavailable: Record<HorizonKey, string> = {};

  for (const horizonS of horizonsS) {
    const key = String(horizonS);
    const n = Math.round(horizonS / dtS);
    if (n < 1) {
      unavailable[key] = `horizon ${horizonS}s is shorter than one ${dtS}s step`;
      continue;
    }
    if (reference.length < n) {
      unavailable[key] = `reference has ${reference.length} waypoints, horizon ${horizonS}s needs ${n}`;
      continue;
    }
    const shortSample = samples.findIndex((sample) => sample.length < n);
    if (shortSample >= 0) {
      unavailable[key] =
        `sample ${shortSample} has ${samples[shortSample]!.length} waypoints, horizon ${horizonS}s needs ${n}`;
      continue;
    }
    const adePerSampleM: number[] = [];
    let bestSampleIndex = 0;
    let minAdeM = Number.POSITIVE_INFINITY;
    let minFdeM = Number.POSITIVE_INFINITY;
    for (let s = 0; s < samples.length; s += 1) {
      const sample = samples[s]!;
      let sum = 0;
      for (let i = 0; i < n; i += 1) sum += distance(sample[i]!, reference[i]!, dimensions);
      const ade = sum / n;
      adePerSampleM.push(ade);
      if (ade < minAdeM) {
        minAdeM = ade;
        bestSampleIndex = s;
      }
      minFdeM = Math.min(minFdeM, distance(sample[n - 1]!, reference[n - 1]!, dimensions));
    }
    horizons[key] = {
      horizonS,
      points: n,
      minAdeM,
      minFdeM,
      bestSampleIndex,
      adePerSampleM,
      headingErrorRad: angleDelta(terminalHeading(samples[bestSampleIndex]!, n), terminalHeading(reference, n)),
    };
  }

  return { samples: samples.length, dtS, dimensions, horizons, unavailable };
}
