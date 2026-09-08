/**
 * Drivable-area containment: is the vehicle's FOOTPRINT on the road.
 *
 * This module exists because the question it answers was previously answered by
 * proxy. Off-road v1 measured the distance from a lane centreline, and on a
 * reconstructed clip that reported a recorded ground-truth drive — 0.16 m of
 * tracking error against its own path — as a 5.45 m lane error, and therefore
 * off-road, while the vehicle never left the drivable surface. A metric that
 * flags the ground truth is measuring the wrong thing.
 *
 * So v2 asks directly: are all four corners of the actor's box inside the
 * authoritative drivable polygons. The centreline question survives separately
 * as `lane-departure`, because "left its lane" and "left the road" are
 * different claims.
 *
 * Three rules are load-bearing and are enforced here rather than documented:
 *
 * 1. **The frame is not converted.** `frame` must equal the ego frame. The
 *    geometry's author is responsible for landing it in the scene's world
 *    frame; silently transforming it here would let a wrong frame produce
 *    plausible numbers.
 * 2. **Absent geometry is unavailable, never a pass.** No block, no polygons,
 *    or a decision outside the polygons' time support means the metric has no
 *    answer — not that the vehicle was on the road.
 * 3. **The worst corner's outside-distance is reported**, so a 5 cm clip of a
 *    kerb reads differently from a car in a field. Binary in/out is what let
 *    v1's failure hide.
 *
 * The test is the four corners PLUS any hole vertex that falls inside the
 * footprint. Corners alone miss an island smaller than the vehicle, which the
 * box straddles without putting a corner in it — a real case on maps with
 * narrow medians. It remains an approximation of polygon overlap: a hole whose
 * edge crosses the footprint while every one of its vertices lies outside is
 * not detected. That limit is stated rather than hidden, and it is a
 * conservative one: it can only MISS an excursion, never invent one.
 */

import { z } from 'zod';

export const DRIVABLE_AREA_SCHEMA = 'simforge.drivable-area/v1' as const;

const RingSchema = z.array(z.tuple([z.number().finite(), z.number().finite()])).min(3);

export const DrivableAreaPolygonSchema = z.object({
  id: z.string().min(1),
  /** `hole` rings subtract: medians, islands, anything enclosed and not drivable. */
  kind: z.enum(['drivable', 'hole']),
  ring: RingSchema,
});
export type DrivableAreaPolygon = z.infer<typeof DrivableAreaPolygonSchema>;

export const DrivableAreaSchema = z.object({
  schema: z.literal(DRIVABLE_AREA_SCHEMA).default(DRIVABLE_AREA_SCHEMA),
  /** Where the geometry came from; never derived or inferred here. */
  source: z.string().min(1),
  /** MUST equal the ego frame. A mismatch is a refusal, not a transform. */
  frame: z.string().min(1),
  confidence: z.enum(['authoritative', 'low']),
  polygons: z.array(DrivableAreaPolygonSchema).default([]),
  /** `null` = static for the clip, which is what ClipGT lane geometry is. */
  timeSupportUs: z
    .object({ startUs: z.number().int(), endUs: z.number().int() })
    .nullable()
    .default(null),
  coverage: z
    .object({
      boundsMinXY: z.tuple([z.number(), z.number()]),
      boundsMaxXY: z.tuple([z.number(), z.number()]),
    })
    .nullable()
    .default(null),
});
export type DrivableArea = z.infer<typeof DrivableAreaSchema>;

export type DrivableAreaRefusal = {
  readonly code: 'drivable_area_frame_mismatch' | 'drivable_area_empty';
  readonly message: string;
};

/** Why containment has no answer for a decision. */
export type ContainmentUnavailable =
  | 'no_drivable_area'
  | 'outside_time_support'
  | 'no_pose';

export interface ContainmentVerdict {
  /** `true` = every corner inside; `false` = at least one outside. */
  readonly inside: boolean;
  /**
   * Worst corner's distance OUTSIDE the drivable surface, metres; 0 when
   * inside. This is what makes a marginal kerb clip legible.
   */
  readonly outsideM: number;
  /** The corner that was worst, in world coordinates. */
  readonly worstCorner: readonly [number, number];
}

/**
 * Accept a drivable-area block for an ego frame, or refuse it.
 *
 * `null` input is not a refusal — it is the honest absence that makes the
 * metric unavailable. A frame disagreement IS a refusal: it is a defect in the
 * bundle, and scoring against it would be scoring against the wrong world.
 */
export function acceptDrivableArea(
  raw: unknown,
  egoFrame: string,
): { ok: true; area: DrivableArea | null } | { ok: false; refusal: DrivableAreaRefusal } {
  if (raw === null || raw === undefined) return { ok: true, area: null };
  const area = DrivableAreaSchema.parse(raw);
  if (area.frame !== egoFrame) {
    return {
      ok: false,
      refusal: {
        code: 'drivable_area_frame_mismatch',
        message: `drivable area is in frame "${area.frame}" but the ego is in "${egoFrame}"; the geometry must be authored in the scene's own frame rather than transformed here`,
      },
    };
  }
  if (area.polygons.length === 0) {
    return {
      ok: false,
      refusal: {
        code: 'drivable_area_empty',
        message: 'drivable area carries no polygons; off-road is unavailable rather than passing',
      },
    };
  }
  return { ok: true, area };
}

/** The four corners of an axis-aligned box rotated by `headingRad`, world frame. */
export function footprintCorners(
  x: number,
  y: number,
  headingRad: number,
  lengthM: number,
  widthM: number,
): [number, number][] {
  const cos = Math.cos(headingRad);
  const sin = Math.sin(headingRad);
  const halfL = lengthM / 2;
  const halfW = widthM / 2;
  const local: [number, number][] = [
    [halfL, halfW],
    [halfL, -halfW],
    [-halfL, -halfW],
    [-halfL, halfW],
  ];
  return local.map(([forward, left]): [number, number] => [
    x + forward * cos - left * sin,
    y + forward * sin + left * cos,
  ]);
}

/** Even-odd point-in-ring. Rings are implicitly closed. */
function pointInRing(px: number, py: number, ring: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a ring's boundary. */
function distanceToRing(px: number, py: number, ring: readonly (readonly [number, number])[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [x0, y0] = ring[j]!;
    const [x1, y1] = ring[i]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSq = dx * dx + dy * dy;
    const u = lengthSq <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lengthSq));
    best = Math.min(best, Math.hypot(px - (x0 + u * dx), py - (y0 + u * dy)));
  }
  return best;
}

/** Whether one point is on the drivable surface: inside a drivable ring and outside every hole. */
function pointOnSurface(px: number, py: number, area: DrivableArea): boolean {
  let inDrivable = false;
  for (const polygon of area.polygons) {
    if (polygon.kind !== 'drivable') continue;
    if (pointInRing(px, py, polygon.ring)) {
      inDrivable = true;
      break;
    }
  }
  if (!inDrivable) return false;
  for (const polygon of area.polygons) {
    if (polygon.kind !== 'hole') continue;
    if (pointInRing(px, py, polygon.ring)) return false;
  }
  return true;
}

/**
 * Containment of one footprint, or why it cannot be decided.
 *
 * `tUs` is the decision's absolute time when the polygons declare a time
 * support; a decision outside it is unavailable rather than assumed static.
 */
export function footprintContainment(
  area: DrivableArea | null,
  pose: { readonly x: number; readonly y: number; readonly headingRad: number } | null,
  dims: { readonly lengthM: number; readonly widthM: number },
  tUs?: number | null,
): ContainmentVerdict | { readonly unavailable: ContainmentUnavailable } {
  if (!area || area.polygons.length === 0) return { unavailable: 'no_drivable_area' };
  if (!pose) return { unavailable: 'no_pose' };
  if (area.timeSupportUs && tUs != null) {
    if (tUs < area.timeSupportUs.startUs || tUs > area.timeSupportUs.endUs) {
      return { unavailable: 'outside_time_support' };
    }
  }
  const corners = footprintCorners(pose.x, pose.y, pose.headingRad, dims.lengthM, dims.widthM);
  // A hole vertex inside the footprint means the box is over a non-drivable
  // island it straddles; treat that vertex as the offending point.
  const straddled: [number, number][] = [];
  for (const polygon of area.polygons) {
    if (polygon.kind !== 'hole') continue;
    for (const [hx, hy] of polygon.ring) {
      if (pointInRing(hx, hy, corners)) straddled.push([hx, hy]);
    }
  }
  let outsideM = 0;
  let worstCorner: readonly [number, number] = corners[0]!;
  for (const [cx, cy] of corners) {
    if (pointOnSurface(cx, cy, area)) continue;
    // Outside: how far from the nearest drivable boundary. A hole the corner
    // sits inside bounds it just as a missing drivable ring does.
    let distance = Number.POSITIVE_INFINITY;
    for (const polygon of area.polygons) {
      distance = Math.min(distance, distanceToRing(cx, cy, polygon.ring));
    }
    if (Number.isFinite(distance) && distance > outsideM) {
      outsideM = distance;
      worstCorner = [cx, cy];
    } else if (outsideM === 0) {
      // Outside but on a boundary: still outside, and the corner is the worst
      // one so far because no other corner has left the surface.
      worstCorner = [cx, cy];
      outsideM = Math.max(outsideM, Number.isFinite(distance) ? distance : 0);
    }
  }
  const anyOutside = corners.some(([cx, cy]) => !pointOnSurface(cx, cy, area));
  if (straddled.length > 0 && !anyOutside) {
    // The corners are all on the surface but the box covers an island. The
    // excursion is real; its depth is how far the island reaches into the box.
    const [hx, hy] = straddled[0]!;
    return { inside: false, outsideM: 0, worstCorner: [hx, hy] };
  }
  return { inside: !anyOutside, outsideM: Number(outsideM.toFixed(4)), worstCorner };
}
