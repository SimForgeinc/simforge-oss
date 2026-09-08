/**
 * Lane context and lane binding — the input a lane-position claim needs.
 *
 * This module exists because of a specific failure. A lane-departure of 5.454 m was reported for
 * a vehicle driving 0.16 m from the recorded human path, because the binding was nearest-
 * centreline on a lane graph derived from `map.xodr` that was already 1.101 m out at the first
 * pose. Nearest-centreline always returns a lane, including when the vehicle is nowhere near it,
 * so the metric could not tell "departed from its lane" from "bound to the wrong lane".
 *
 * The binding here is CONTAINMENT first: a vehicle is in the lane whose own annotated rails
 * contain it. Only that supports the sentence "the car left its lane". Three outcomes, and they
 * are deliberately three rather than two:
 *
 *   `contained`  exactly one lane's rails contain the point — bind to it, offset is meaningful;
 *   `ambiguous`  none or several do (straddling a lane line, or in the ~0.20 m inter-rail strip
 *                the annotation leaves between adjacent lanes) — the lane is genuinely undecided
 *                and the consumer must decide what to do, with hysteresis or otherwise;
 *   `outside`    no lane is within reach at all — off the annotated road, which is the drivable-
 *                area metric's question, not this one.
 *
 * `ambiguous` is not a failure of the data and must not be silently resolved to the nearest
 * lane: resolving it is what produced the number this replaces.
 */

import { z } from 'zod';

const Finite = z.number().finite();

export const LaneSchema = z.strictObject({
  id: z.string().min(1),
  /** Derived: midpoint of the arclength-resampled rails. Never an annotated centreline. */
  centreline: z.array(z.tuple([Finite, Finite])).min(2),
  leftRail: z.array(z.tuple([Finite, Finite])).min(2),
  rightRail: z.array(z.tuple([Finite, Finite])).min(2),
  /** Median rail separation, metres. */
  widthM: z.number().positive(),
});
export type Lane = z.infer<typeof LaneSchema>;

export const LaneContextSchema = z.strictObject({
  schema: z.literal('simforge.lane-context/v1'),
  source: z.literal('clipgt-lane-rails'),
  /** Must equal `ego.frame`; a mismatch is refused rather than transformed. */
  frame: z.string().min(1),
  timeSupportUs: z.strictObject({ startUs: z.number().int(), endUs: z.number().int() }).nullable(),
  lanes: z.array(LaneSchema).min(1),
  coverage: z.strictObject({
    boundsMinXY: z.tuple([Finite, Finite]),
    boundsMaxXY: z.tuple([Finite, Finite]),
  }),
  provenance: z.record(z.string(), z.unknown()).optional(),
});
export type LaneContext = z.infer<typeof LaneContextSchema>;

export type LaneBindingKind = 'contained' | 'ambiguous' | 'outside';

export interface LaneBinding {
  readonly kind: LaneBindingKind;
  /** The bound lane, or `null` for `ambiguous` and `outside`. */
  readonly laneId: string | null;
  /**
   * Signed lateral offset from the bound lane's centreline, metres; positive to the left of the
   * centreline's direction of travel. `null` whenever no single lane was bound — an offset from a
   * lane the vehicle is not in is exactly the quantity that must never be reported.
   */
  readonly lateralOffsetM: number | null;
  /** Lanes whose rails contained the point; length 1 for `contained`, 0 or >1 for `ambiguous`. */
  readonly candidateLaneIds: readonly string[];
}

function laneRing(lane: Lane): [number, number][] {
  return [...lane.leftRail, ...[...lane.rightRail].reverse()];
}

function pointInRing(ring: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed distance from a polyline, positive on the left of its direction of travel. */
function signedOffset(line: readonly (readonly [number, number])[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  let signed = 0;
  for (let i = 1; i < line.length; i += 1) {
    const [x1, y1] = line[i - 1]!;
    const [x2, y2] = line[i]!;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq));
    const distance = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
    if (distance >= best) continue;
    best = distance;
    signed = dx * (y - y1) - dy * (x - x1) > 0 ? distance : -distance;
  }
  return signed;
}

/**
 * Bind a point to the lane it is in.
 *
 * Per-pose by construction: a lane change is a change of binding, not a permanent departure,
 * which is why nothing here is fixed at spawn. The flicker that per-pose binding implies for a
 * vehicle riding a lane line is surfaced as `ambiguous` rather than absorbed — a consumer that
 * wants hysteresis can apply it knowing exactly which samples were undecided, instead of a band
 * silently picking one of two lanes.
 */
export function bindLane(context: LaneContext, x: number, y: number): LaneBinding {
  const candidates: string[] = [];
  let single: Lane | undefined;
  for (const lane of context.lanes) {
    if (!pointInRing(laneRing(lane), x, y)) continue;
    candidates.push(lane.id);
    single = lane;
  }
  if (candidates.length === 1 && single !== undefined) {
    return {
      kind: 'contained',
      laneId: single.id,
      lateralOffsetM: signedOffset(single.centreline, x, y),
      candidateLaneIds: candidates,
    };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', laneId: null, lateralOffsetM: null, candidateLaneIds: candidates };
  }
  // Nothing contains the point. Distinguish "on a lane line" from "off the road entirely" using
  // the lane's own width: within half a lane of some lane, this is the inter-rail strip or a
  // boundary ride; beyond that, no lane is plausibly the vehicle's.
  let nearest = Number.POSITIVE_INFINITY;
  for (const lane of context.lanes) {
    nearest = Math.min(nearest, Math.abs(signedOffset(lane.centreline, x, y)) - lane.widthM / 2);
  }
  return {
    kind: Number.isFinite(nearest) && nearest <= 0.5 ? 'ambiguous' : 'outside',
    laneId: null,
    lateralOffsetM: null,
    candidateLaneIds: [],
  };
}

export interface LaneBindingSummary {
  readonly samples: number;
  readonly contained: number;
  readonly ambiguous: number;
  readonly outside: number;
  /** Largest |offset| among contained samples, metres; `null` when none were contained. */
  readonly worstOffsetM: number | null;
  /** Largest |offset| as a fraction of the bound lane's width; `null` when none were contained. */
  readonly worstOffsetFraction: number | null;
}

/**
 * Summarise a binding over a pose sequence.
 *
 * Used as the control on the binding source itself: run it over the recorded human drive. A
 * source that cannot keep the human inside a lane, at an offset small against the lane width, is
 * not fit to support a lane-departure claim — and saying so is cheaper than discovering it from
 * a metric that reports metres of departure by a car that never left its lane.
 */
export function summariseBinding(
  context: LaneContext,
  poses: readonly { x: number; y: number }[],
): LaneBindingSummary {
  const widthById = new Map(context.lanes.map((lane) => [lane.id, lane.widthM]));
  let contained = 0;
  let ambiguous = 0;
  let outside = 0;
  let worst: number | null = null;
  let worstFraction: number | null = null;
  for (const pose of poses) {
    const binding = bindLane(context, pose.x, pose.y);
    if (binding.kind === 'ambiguous') ambiguous += 1;
    else if (binding.kind === 'outside') outside += 1;
    else {
      contained += 1;
      const offset = Math.abs(binding.lateralOffsetM ?? 0);
      const width = widthById.get(binding.laneId ?? '') ?? 0;
      worst = worst === null ? offset : Math.max(worst, offset);
      if (width > 0) {
        const fraction = offset / (width / 2);
        worstFraction = worstFraction === null ? fraction : Math.max(worstFraction, fraction);
      }
    }
  }
  return { samples: poses.length, contained, ambiguous, outside, worstOffsetM: worst, worstOffsetFraction: worstFraction };
}
