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

/**
 * Scoped availability for the centreline geometry.
 *
 * This says one thing only: for these exact bytes, in this frame, over this support, the
 * geometry was validated against a recorded drive. It is explicitly NOT a claim that a lane
 * position is legal, that the world matches, or that any behaviour measured against it is safe —
 * those need route, marking and rule context this source does not carry.
 */
export const LaneAuthoritySchema = z.strictObject({
  available: z.boolean(),
  /** Frame the validation was performed in; availability does not survive a reframe. */
  validatedFrame: z.string().min(1),
  /** Where the validation holds. Outside it the answer is unavailable, not extrapolated. */
  supportScope: z.strictObject({
    boundsMinXY: z.tuple([Finite, Finite]),
    boundsMaxXY: z.tuple([Finite, Finite]),
    note: z.string().min(1),
  }),
  /** What was actually run, so the claim can be re-checked rather than believed. */
  evidence: z.array(z.string().min(1)).min(1),
  /** Stated plainly so the record cannot be read as more than it is. */
  notCertified: z.array(z.string().min(1)).min(1),
});
export type LaneAuthority = z.infer<typeof LaneAuthoritySchema>;

export const LaneContextSchema = z.strictObject({
  schema: z.literal('simforge.lane-context/v1'),
  source: z.literal('clipgt-lane-rails'),
  /** The exact bytes this geometry and its availability record describe. */
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Absent means the geometry ships unqualified and every binding is unavailable. */
  authority: LaneAuthoritySchema.optional(),
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

export type LaneBindingKind = 'contained' | 'ambiguous' | 'outside' | 'out-of-support';

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
  // Availability is scoped. Outside the region the geometry was validated over, the honest answer
  // is that we do not know — extrapolating validation past its support is how a qualified input
  // silently becomes an unqualified one.
  const scope = context.authority?.supportScope;
  if (scope !== undefined) {
    const [minX, minY] = scope.boundsMinXY;
    const [maxX, maxY] = scope.boundsMaxXY;
    if (x < minX || x > maxX || y < minY || y > maxY) {
      return { kind: 'out-of-support', laneId: null, lateralOffsetM: null, candidateLaneIds: [] };
    }
  }
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
  readonly outOfSupport: number;
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
  let outOfSupport = 0;
  let worst: number | null = null;
  let worstFraction: number | null = null;
  for (const pose of poses) {
    const binding = bindLane(context, pose.x, pose.y);
    if (binding.kind === 'ambiguous') ambiguous += 1;
    else if (binding.kind === 'out-of-support') outOfSupport += 1;
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
  return { samples: poses.length, contained, ambiguous, outside, outOfSupport, worstOffsetM: worst, worstOffsetFraction: worstFraction };
}


export type LaneTransitionKind = 'lane-transition' | 'segment-advance' | 'entered-ambiguous' | 'left-support';

/**
 * Did the polyline still cover this point longitudinally, or had it ended?
 *
 * ClipGT tiles a lane into ~38 m segments, so driving straight changes the bound lane id every
 * few seconds. That is a segment advance, not a lane change, and calling it one would report a
 * manoeuvre roughly every 40 m on a car going perfectly straight. The discriminator is the same
 * interior-versus-terminus test the boundary cuts use: if the old lane had run out beneath the
 * vehicle it was succeeded; if it was still alongside and stopped containing the vehicle, the
 * vehicle moved sideways.
 */
function stillCovers(line: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let best = Number.POSITIVE_INFINITY;
  let atTerminus = true;
  for (let i = 1; i < line.length; i += 1) {
    const [x1, y1] = line[i - 1]!;
    const [x2, y2] = line[i]!;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) continue;
    const raw = ((x - x1) * dx + (y - y1) * dy) / lengthSq;
    const t = Math.max(0, Math.min(1, raw));
    const distance = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
    if (distance >= best) continue;
    best = distance;
    // Interior of the polyline: either a middle segment, or strictly inside the end segments.
    atTerminus = (i === 1 && raw <= 0) || (i === line.length - 1 && raw >= 1);
  }
  return !atTerminus;
}

export interface LaneTransition {
  readonly kind: LaneTransitionKind;
  readonly atIndex: number;
  readonly fromLaneId: string | null;
  readonly toLaneId: string | null;
}

/**
 * Lane transitions along a pose sequence, as DIAGNOSTICS.
 *
 * Crossing a lane boundary is a manoeuvre, not an offence. Deciding whether a given crossing was
 * unsafe needs route intent, marking legality and traffic rules — none of which this geometry
 * carries — so nothing here is an infraction and nothing here is scored. It exists so a consumer
 * can *explain* a run: the 3.7 m traverse in the validation drive is one `lane-transition`, and
 * the large lateral offsets that traverse produces are legible rather than mysterious.
 *
 * `entered-ambiguous` and `left-support` are emitted for the same reason: the samples they mark
 * are unavailable, and a consumer should see why rather than find a gap.
 */
export function detectLaneTransitions(
  context: LaneContext,
  poses: readonly { x: number; y: number }[],
): LaneTransition[] {
  const transitions: LaneTransition[] = [];
  let lastBound: string | null = null;
  let pendingAmbiguous = false;
  poses.forEach((pose, index) => {
    const binding = bindLane(context, pose.x, pose.y);
    if (binding.kind === 'outside' || binding.kind === 'out-of-support') {
      if (lastBound !== null || !pendingAmbiguous) {
        transitions.push({ kind: 'left-support', atIndex: index, fromLaneId: lastBound, toLaneId: null });
      }
      lastBound = null;
      pendingAmbiguous = false;
      return;
    }
    if (binding.kind === 'ambiguous') {
      if (!pendingAmbiguous) {
        transitions.push({ kind: 'entered-ambiguous', atIndex: index, fromLaneId: lastBound, toLaneId: null });
        pendingAmbiguous = true;
      }
      return;
    }
    if (lastBound !== null && binding.laneId !== lastBound) {
      const previous = context.lanes.find((lane) => lane.id === lastBound);
      const next = context.lanes.find((lane) => lane.id === binding.laneId);
      // Two ways to establish that the vehicle moved sideways rather than being handed to the
      // next tile of its own lane. Either the old lane is still alongside and stopped containing
      // it, or the new lane is not the old one's longitudinal successor. The second test matters
      // because a lane change can happen to occur exactly where a segment ends — which is what
      // the validation drive does — and then the first test alone sees only a succession.
      const succeeds = previous !== undefined && next !== undefined
        && Math.hypot(
          next.centreline[0]![0] - previous.centreline.at(-1)![0],
          next.centreline[0]![1] - previous.centreline.at(-1)![1],
        // Scaled by the lane's own width: "continues the same lane" means the next tile starts
        // where this one ended, not a lane over.
        ) < next.widthM / 2;
      const lateral = previous !== undefined
        && (stillCovers(previous.centreline, pose.x, pose.y) || !succeeds);
      transitions.push({
        kind: lateral ? 'lane-transition' : 'segment-advance',
        atIndex: index,
        fromLaneId: lastBound,
        toLaneId: binding.laneId,
      });
    }
    lastBound = binding.laneId;
    pendingAmbiguous = false;
  });
  return transitions;
}
