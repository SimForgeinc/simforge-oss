/**
 * The per-sensor trace channel and the perception episode metrics.
 *
 * Columnar, like every other channel: one array per quantity, index-aligned
 * with `ticks.t`. Statuses and reasons are small integers with an exported
 * legend rather than strings, because a 30 s clip at 50 Hz is 1500 samples per
 * target and a run of identical integers is what gzip is good at.
 *
 * This is a *first-class* channel, not a derived report: a scenario can be
 * graded on it, and `metrics.perception` is what the tier-2 invariant checker
 * reads. Precision is fixed here so two runs of the same input hash serialise
 * bit-identically — a raw floating-point confidence product would not.
 */

import type { MapDivergenceKind } from '../perception/schema.js';

/** Decimal places for the perception channels (the native recorder quantises with these). */
export const SENSOR_TRACE_PRECISION = {
  confidence: 4,
  range: 3,
} as const;

/**
 * Detection status, ordered so that a larger number is strictly more
 * perception. The trace records the number; this is the legend.
 */
export const SENSOR_TRACE_STATUS_LEGEND = {
  absent: 0,
  missed: 1,
  degraded: 2,
  detected: 3,
} as const;
export type DetectionStatusName = keyof typeof SENSOR_TRACE_STATUS_LEGEND;
export type DetectionStatusCode = (typeof SENSOR_TRACE_STATUS_LEGEND)[DetectionStatusName];

/** Reason names indexed by the integer stored in the `reason` channel. */
export const SENSOR_TRACE_REASON_LEGEND = [
  'detected',
  'absent',
  'disabled',
  'out_of_range',
  'out_of_fov',
  'occluded',
  'atmospheric_attenuation',
  'below_angular_resolution',
  'low_light',
  'glare',
] as const;
export type DetectionReason = (typeof SENSOR_TRACE_REASON_LEGEND)[number];

/** One sensor's opinion about one other actor, over the whole clip. */
export interface SensorTargetTrack {
  /** `SENSOR_TRACE_STATUS_LEGEND` codes. */
  readonly status: number[];
  /** Index into `SENSOR_TRACE_REASON_LEGEND`. */
  readonly reason: number[];
  readonly confidence: number[];
  readonly rangeM: number[];
  /** 1 while geometric line of sight to the target is clear. */
  readonly lineOfSight: number[];
}

/** One declared sensor's whole channel. */
export interface SensorTrack {
  readonly observer: string;
  readonly sensorId: string;
  readonly type: string;
  /** Keyed by target actor id, in sorted order. */
  readonly targets: Record<string, SensorTargetTrack>;
}

/** Per-tick exposure of one observer to one declared map/percept divergence. */
export interface MapDivergenceTrack {
  readonly id: string;
  readonly kind: MapDivergenceKind;
  readonly observer: string;
  /** 1 while the observer is inside the divergent extent. */
  readonly active: number[];
}

/** A maximal run in which an observable target was not reported. */
export interface DetectionGap {
  readonly startS: number;
  readonly endS: number;
  readonly durationS: number;
  /** The reason that dominated the run. */
  readonly reason: string;
  /** `true` when the gap was still open at the end of the clip. */
  readonly openAtClipEnd: boolean;
}

/** Everything the perception layer concluded about one sensor/target pair. */
export interface SensorPerceptionMetric {
  readonly observer: string;
  readonly sensorId: string;
  readonly target: string;
  /** First tick at which the geometric line of sight was clear and in aperture. */
  readonly firstLineOfSightT: number | null;
  /** First tick at which the sensor reported the target. */
  readonly firstDetectionT: number | null;
  /** Clip time of first detection; `null` when it was never detected. */
  readonly timeToFirstDetectionS: number | null;
  /**
   * Seconds between the world making the target available and the sensor
   * admitting it exists. This is the number that says "the danger was the
   * perception failure, not the dynamics".
   */
  readonly perceptionLagS: number | null;
  readonly detectedS: number;
  readonly degradedS: number;
  readonly missedS: number;
  /** Longest dropout while the target was geometrically available. */
  readonly longestGapS: number;
  readonly totalGapS: number;
  /** Bounded evidence; the longest gaps first, then in time order. */
  readonly gaps: DetectionGap[];
}

export interface MapDivergenceMetric {
  readonly id: string;
  readonly kind: MapDivergenceKind;
  readonly observer: string;
  readonly severity: number;
  readonly lateralErrorM: number | null;
  readonly firstActiveT: number | null;
  readonly activeS: number;
}

/**
 * The perception episode summary.
 *
 * `mapDivergence` records *exposure* only. The engine has no lane-keeping
 * perception controller, so a declared divergence deliberately does NOT feed
 * back into control — pretending a faded line steers the car would be a
 * fiction. It is recorded so a scenario can require it; it is not a closed loop.
 */
export interface PerceptionMetrics {
  readonly sensors: SensorPerceptionMetric[];
  readonly mapDivergence: MapDivergenceMetric[];
}


/** Stable channel key. `observer/sensorId` is unique by construction. */
export function sensorChannelKey(observerId: string, sensorId: string): string {
  return `${observerId}/${sensorId}`;
}
