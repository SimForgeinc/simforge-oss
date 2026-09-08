/**
 * Validity-envelope enforcement and the trajectory-side measurements (G3, G4, G5).
 *
 * A replayed scene is only a world where we measured it to be one. Outside that region the
 * renderer is extrapolating unobserved surface and the recorded actors are reacting to a
 * drive that did not happen, so a render there is not evidence. The contract is therefore:
 * leaving the envelope **truncates** the episode (`term: envelope_exceeded`), the part that
 * ran is scored, and the result is marked incomplete. It is never a model failure, never a
 * driver crash, and never silently continued.
 *
 * Three deviations are tracked, because a scene can be valid in one and not another:
 *
 *   lateral       perpendicular distance from the recorded path (m)
 *   longitudinal  schedule offset — how far ahead of or behind the recorded drive the ego
 *                 is at this instant (s). Actors replay on the recorded clock, so being
 *                 early or late is exactly what desynchronises them.
 *   heading       absolute heading difference from the recorded heading (rad)
 *
 * All of this is pure geometry over `ego.recordedPath`, so it runs without a GPU, without
 * the renderer and without a model — which is what makes the negative case cheap to prove.
 */

import { cameraTimestamps } from './cameras.js';
import {
  DEFAULT_GATE_THRESHOLDS,
  gateG3,
  gateG4,
  gateG5,
  type DynamicsConsistency,
  type EgoHistoryParity,
  type GateThresholds,
  type StockReplayMeasurement,
} from './gates.js';
import type { EgoPose, GateVerdict, ReplayContext } from './schema.js';

/** Wrap an angle difference into (-π, π]. */
function wrapPi(angle: number): number {
  const wrapped = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

export interface Deviation {
  /** Perpendicular distance from the recorded path, metres (unsigned). */
  readonly lateralM: number;
  /** Signed schedule offset in seconds: positive means ahead of the recorded drive. */
  readonly longitudinalS: number;
  /** Absolute heading difference from the recorded heading at the closest point, radians. */
  readonly headingRad: number;
  /** Interpolated recorded time at the closest point on the path. */
  readonly closestTUs: number;
  /** Arc-length position of the closest point, metres from the start of the path. */
  readonly arcM: number;
}

export interface PoseSample {
  readonly tUs: number;
  readonly x: number;
  readonly y: number;
  readonly headingRad: number;
}

/**
 * Closest point on the recorded polyline, and the deviations from it.
 *
 * The projection is onto the polyline rather than onto the nearest vertex: at 10 Hz and
 * highway speed consecutive poses are ~3 m apart, so vertex-snapping would report metres of
 * phantom lateral error and truncate valid episodes.
 */
export function deviationFrom(path: readonly EgoPose[], sample: PoseSample): Deviation {
  let best = {
    distance: Number.POSITIVE_INFINITY,
    tUs: path[0]!.tUs,
    heading: path[0]!.headingRad,
    arcM: 0,
  };
  let arcBefore = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segmentLength = Math.hypot(dx, dy);
    if (segmentLength === 0) continue;
    const raw = ((sample.x - a.x) * dx + (sample.y - a.y) * dy) / (segmentLength * segmentLength);
    const t = Math.min(1, Math.max(0, raw));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const distance = Math.hypot(sample.x - px, sample.y - py);
    if (distance < best.distance) {
      best = {
        distance,
        tUs: a.tUs + t * (b.tUs - a.tUs),
        heading: a.headingRad + wrapPi(b.headingRad - a.headingRad) * t,
        arcM: arcBefore + t * segmentLength,
      };
    }
    arcBefore += segmentLength;
  }
  return {
    lateralM: best.distance,
    longitudinalS: (sample.tUs - best.tUs) / 1e6,
    headingRad: Math.abs(wrapPi(sample.headingRad - best.heading)),
    closestTUs: Math.round(best.tUs),
    arcM: best.arcM,
  };
}

export interface EnvelopeCheck {
  readonly inside: boolean;
  readonly deviation: Deviation;
  /** Set when `inside` is false; the termination reason the episode records. */
  readonly term?: 'envelope_exceeded';
  /** Which limit was breached first, for the event record. */
  readonly breached?: readonly ('lateral' | 'longitudinal' | 'heading' | 'time-support')[];
  readonly limits: ReplayContext['validity']['envelope'];
}

export interface EnvelopeMonitor {
  /** Evaluate one pose against the bundle's measured envelope. */
  check(sample: PoseSample): EnvelopeCheck;
  /** The limits being enforced, as recorded in the bundle. */
  readonly limits: ReplayContext['validity']['envelope'];
}

/**
 * Envelope monitor for a bundle.
 *
 * Also enforces the recorded time support: once the ego runs past `ego.endUs` there are no
 * recorded actor poses left to replay, so continuing would mean driving through an empty
 * world. That is a truncation for the same reason as a lateral breach.
 */
export function createEnvelopeMonitor(bundle: ReplayContext): EnvelopeMonitor {
  const limits = bundle.validity.envelope;
  const path = bundle.ego.recordedPath;
  // Renders outside the reconstruction's support do not exist, so the enforceable window is
  // the intersection of the episode and the reconstruction — not the episode alone.
  const support = bundle.geometry.timeSupportUs;
  const originUs = Math.max(bundle.ego.originUs, support?.startUs ?? bundle.ego.originUs);
  const endUs = Math.min(bundle.ego.endUs, support?.endUs ?? bundle.ego.endUs);
  return {
    limits,
    check(sample: PoseSample): EnvelopeCheck {
      const deviation = deviationFrom(path, sample);
      const breached: ('lateral' | 'longitudinal' | 'heading' | 'time-support')[] = [];
      if (deviation.lateralM > limits.lateralM) breached.push('lateral');
      if (Math.abs(deviation.longitudinalS) > limits.longitudinalS) breached.push('longitudinal');
      if (deviation.headingRad > limits.headingRad) breached.push('heading');
      if (sample.tUs < originUs || sample.tUs > endUs) breached.push('time-support');
      if (breached.length === 0) return { inside: true, deviation, limits };
      return { inside: false, deviation, term: 'envelope_exceeded', breached, limits };
    },
  };
}

/* ------------------------------------------------------------------ G3 / G4 */

/** The 16-step, 10 Hz ego history the Alpamayo families condition on. */
export const EGO_HISTORY_STEPS = 16;
export const EGO_HISTORY_PERIOD_US = 100_000;

/**
 * Sample the recorded path at an exact time by linear interpolation, or `undefined` when the
 * time is outside the recorded support. Extrapolation is deliberately not offered: an
 * invented pose before the clip starts is exactly the fabricated history the product
 * promises not to produce.
 */
export function poseAt(path: readonly EgoPose[], tUs: number): EgoPose | undefined {
  const first = path[0]!;
  const last = path[path.length - 1]!;
  if (tUs < first.tUs || tUs > last.tUs) return undefined;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (tUs > b.tUs) continue;
    const span = b.tUs - a.tUs;
    const t = span === 0 ? 0 : (tUs - a.tUs) / span;
    return {
      tUs,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      headingRad: a.headingRad + wrapPi(b.headingRad - a.headingRad) * t,
    };
  }
  return last;
}

/**
 * G3 measurement: re-derive the 16-step history ending at `t0Us` and compare it against the
 * recorded path. Both sides come from the same source, so this catches derivation and
 * frame-conversion defects, not scene quality.
 */
export function measureEgoHistoryParity(bundle: ReplayContext, t0Us?: number): EgoHistoryParity {
  const path = bundle.ego.recordedPath;
  const anchor = t0Us ?? path[path.length - 1]!.tUs;
  let maxPosition = 0;
  let maxHeading = 0;
  let compared = 0;
  for (let step = 0; step < EGO_HISTORY_STEPS; step += 1) {
    const tUs = anchor - step * EGO_HISTORY_PERIOD_US;
    const derived = poseAt(path, tUs);
    if (derived === undefined) continue;
    const deviation = deviationFrom(path, { tUs, x: derived.x, y: derived.y, headingRad: derived.headingRad });
    maxPosition = Math.max(maxPosition, deviation.lateralM);
    maxHeading = Math.max(maxHeading, deviation.headingRad);
    compared += 1;
  }
  return { maxPositionErrorM: maxPosition, maxHeadingErrorRad: maxHeading, samplesCompared: compared };
}

/**
 * Do two oriented rectangles overlap? Separating-axis test on the four face normals, which
 * is exact for convex boxes and cheap enough to run over every track sample.
 */
function boxesOverlap(
  a: { x: number; y: number; headingRad: number; l: number; w: number },
  b: { x: number; y: number; headingRad: number; l: number; w: number },
): boolean {
  const axes = [
    { x: Math.cos(a.headingRad), y: Math.sin(a.headingRad) },
    { x: -Math.sin(a.headingRad), y: Math.cos(a.headingRad) },
    { x: Math.cos(b.headingRad), y: Math.sin(b.headingRad) },
    { x: -Math.sin(b.headingRad), y: Math.cos(b.headingRad) },
  ];
  const corners = (box: typeof a): { x: number; y: number }[] => {
    const fx = Math.cos(box.headingRad);
    const fy = Math.sin(box.headingRad);
    const hl = box.l / 2;
    const hw = box.w / 2;
    return [
      { x: box.x + fx * hl - fy * hw, y: box.y + fy * hl + fx * hw },
      { x: box.x + fx * hl + fy * hw, y: box.y + fy * hl - fx * hw },
      { x: box.x - fx * hl - fy * hw, y: box.y - fy * hl + fx * hw },
      { x: box.x - fx * hl + fy * hw, y: box.y - fy * hl - fx * hw },
    ];
  };
  const ca = corners(a);
  const cb = corners(b);
  for (const axis of axes) {
    let aMin = Number.POSITIVE_INFINITY;
    let aMax = Number.NEGATIVE_INFINITY;
    let bMin = Number.POSITIVE_INFINITY;
    let bMax = Number.NEGATIVE_INFINITY;
    for (const corner of ca) {
      const projection = corner.x * axis.x + corner.y * axis.y;
      aMin = Math.min(aMin, projection);
      aMax = Math.max(aMax, projection);
    }
    for (const corner of cb) {
      const projection = corner.x * axis.x + corner.y * axis.y;
      bMin = Math.min(bMin, projection);
      bMax = Math.max(bMax, projection);
    }
    if (aMax < bMin || bMax < aMin) return false;
  }
  return true;
}

/** Ego footprint used for the G4 intersection test when the bundle does not carry one. */
const DEFAULT_EGO_FOOTPRINT = { l: 4.8, w: 2.0 };

/**
 * G4 measurement: are the recorded actor tracks usable as a replayed world?
 *
 * Two properties, and neither is "the track sample lands on a clock tick". Rendering places a
 * recorded actor by INTERPOLATING its trajectory at the render instant
 * (`providers/nurec.Traj.at`, position lerp + quaternion nlerp), so exact coincidence with any
 * clock is irrelevant — what matters is that the samples are dense enough for that
 * interpolation to be faithful, and that the tracks describe the same drive as the ego.
 *
 *   `maxTrackSampleGapUs`  the coarsest sampling interval in any track. Interpolation error
 *                          for a turning vehicle grows as v·Δt²·ω/8, so the gap bounds how
 *                          wrong a replayed actor's pose can be between samples.
 *   `egoPathIntersections` recorded actors overlapping the recorded ego footprint at the same
 *                          instant — impossible in a real recording, so it means the tracks and
 *                          the ego pose are not in the same frame or the same clock.
 *   `framesOutsideWindow`  published camera reference instants outside the recorded window,
 *                          which would mean the frames and the trajectory are different drives.
 *
 * This replaced a nearest-tick skew measurement, which was doubly wrong on real data: it
 * failed a genuine NuRec release by ~20 s for publishing one reference frame per camera, and
 * even against the rig clock it could only ever measure half the clock period (~50 ms at
 * 10 Hz), i.e. a property of the sampling grid rather than of the scene.
 */
export function measureDynamicsConsistency(bundle: ReplayContext): DynamicsConsistency {
  let maxGap = 0;
  let intersections = 0;
  let framesOutsideWindow = 0;

  // Frames are checked against the RECONSTRUCTION's support, not the episode window. A
  // published reference frame a few seconds before the evaluated episode still belongs to the
  // same drive; one outside the reconstruction does not.
  const support = bundle.geometry.timeSupportUs;
  const windowStart = support?.startUs ?? bundle.ego.originUs;
  const windowEnd = support?.endUs ?? bundle.ego.endUs;
  for (const camera of bundle.cameras) {
    for (const tUs of cameraTimestamps(camera)) {
      if (tUs < windowStart || tUs > windowEnd) framesOutsideWindow += 1;
    }
  }
  // How far the evaluated episode runs past what the reconstruction can render at all.
  const egoBeyondSupportUs = support === undefined ? 0 : Math.max(0, bundle.ego.endUs - support.endUs);

  for (const track of bundle.dynamics.tracks) {
    for (let i = 1; i < track.samples.length; i += 1) {
      maxGap = Math.max(maxGap, track.samples[i]!.tUs - track.samples[i - 1]!.tUs);
    }
    for (const sample of track.samples) {
      const ego = poseAt(bundle.ego.recordedPath, sample.tUs);
      if (ego === undefined) continue;
      const overlap = boxesOverlap(
        { x: ego.x, y: ego.y, headingRad: ego.headingRad, ...DEFAULT_EGO_FOOTPRINT },
        { x: sample.x, y: sample.y, headingRad: sample.headingRad, l: track.dims.l, w: track.dims.w },
      );
      if (overlap) intersections += 1;
    }
  }
  return {
    maxTrackSampleGapUs: maxGap,
    egoPathIntersections: intersections,
    tracksChecked: bundle.dynamics.tracks.length,
    framesOutsideWindow,
    egoBeyondSupportUs,
  };
}

/* ----------------------------------------------------------------------- G5 */

/**
 * G5 measurement: how well a forced-recorded-trajectory replay reproduced the recorded path.
 *
 * `replayed` is the ego path the sim/executor actually produced with the policy pinned to
 * the recorded trajectory, so any deviation is our chain's error. `infractions` comes from
 * the episode's own scoring; a stock replay that collides or leaves the road disqualifies
 * the scene, because the same chain would blame a model for it later.
 */
export function measureStockReplay(
  bundle: ReplayContext,
  replayed: readonly PoseSample[],
  infractions: number,
): StockReplayMeasurement {
  const lateral = replayed.map((sample) => deviationFrom(bundle.ego.recordedPath, sample).lateralM).sort((a, b) => a - b);
  if (lateral.length === 0) {
    return { maxLateralM: Number.POSITIVE_INFINITY, p95LateralM: Number.POSITIVE_INFINITY, infractions, stepsCompared: 0 };
  }
  const p95Index = Math.min(lateral.length - 1, Math.ceil(0.95 * lateral.length) - 1);
  return {
    maxLateralM: lateral[lateral.length - 1]!,
    p95LateralM: lateral[Math.max(0, p95Index)]!,
    infractions,
    stepsCompared: lateral.length,
  };
}

/**
 * G5 verdict for a bundle from a recorded replay. This is the precondition the campaign
 * runner checks before letting a model drive the scene.
 */
export function stockReplayGate(
  bundle: ReplayContext,
  replayed: readonly PoseSample[],
  infractions: number,
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
): GateVerdict {
  return gateG5(measureStockReplay(bundle, replayed, infractions), thresholds);
}

/** G3 + G4 in one call — the two gates that need no renderer at all. */
export function trajectoryGates(
  bundle: ReplayContext,
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
): { readonly G3: GateVerdict; readonly G4: GateVerdict } {
  return {
    G3: gateG3(measureEgoHistoryParity(bundle), thresholds),
    G4: gateG4(measureDynamicsConsistency(bundle), thresholds),
  };
}
