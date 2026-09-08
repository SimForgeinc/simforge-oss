/**
 * Drivable area and footprint containment — the off-road metric, v2.
 *
 * Off-road means the vehicle's **footprint** left the **drivable surface**. It does not mean
 * the vehicle is far from some pre-bound lane centreline: that is lane departure, a different
 * claim, and conflating the two is what made v1 flag a recorded human drive as off-road while
 * it sat 16 cm from the path the human actually drove.
 *
 * Two consequences shape this module:
 *
 *   - Containment is tested on the four corners of the oriented footprint, not on the centre.
 *     A centre test says nothing about a vehicle straddling a kerb.
 *   - The result carries the worst corner's distance outside, so a marginal exit is legible
 *     rather than a bare boolean. A metric that can only say "off-road: true" cannot be
 *     debugged, which is how v1 survived as long as it did.
 *
 * Polygons come from the scene's own authoritative annotations (`clipgt_drivable.py`) in the
 * scene's own frame. Nothing here transforms coordinates: a frame mismatch is a refusal,
 * because silently re-deriving geometry into another frame is precisely the error class that
 * produced the v1 bug.
 */

import { z } from 'zod';

const Finite = z.number().finite();

export const DrivablePolygonSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['drivable', 'hole']),
  /** Implicitly closed ring; winding is not required to be consistent. */
  ring: z.array(z.tuple([Finite, Finite])).min(3),
});
export type DrivablePolygon = z.infer<typeof DrivablePolygonSchema>;

export const DrivableAreaSchema = z.strictObject({
  source: z.literal('clipgt'),
  /** Must equal `ego.frame`; a mismatch is refused rather than transformed. */
  frame: z.string().min(1),
  confidence: z.enum(['authoritative', 'low']),
  /** `null` means static for the clip: ClipGT lane geometry carries no time dimension. */
  timeSupportUs: z.strictObject({ startUs: z.number().int(), endUs: z.number().int() }).nullable(),
  polygons: z.array(DrivablePolygonSchema).min(1),
  coverage: z.strictObject({
    boundsMinXY: z.tuple([Finite, Finite]),
    boundsMaxXY: z.tuple([Finite, Finite]),
  }),
  provenance: z.record(z.string(), z.unknown()).optional(),
});
export type DrivableArea = z.infer<typeof DrivableAreaSchema>;

/** Metric identity stamped into any result computed here. */
export const OFFROAD_METRIC_VERSION = 'simforge.offroad/v2' as const;

function pointInRing(ring: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    // Ray cast along +x; the half-open y test keeps a vertex from being counted twice.
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToRing(ring: readonly (readonly [number, number])[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const dx = xi - xj;
    const dy = yi - yj;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - xj) * dx + (y - yj) * dy) / lengthSq));
    best = Math.min(best, Math.hypot(x - (xj + t * dx), y - (yj + t * dy)));
  }
  return best;
}

/**
 * Is a point on the drivable surface?
 *
 * Inside any `drivable` ring and inside no `hole` ring. Holes subtract unconditionally: a
 * median sitting inside a lane polygon is not drivable just because the lane says so.
 */
export function pointIsDrivable(area: DrivableArea, x: number, y: number): boolean {
  let drivable = false;
  for (const polygon of area.polygons) {
    if (polygon.kind !== 'drivable') continue;
    if (pointInRing(polygon.ring, x, y)) {
      drivable = true;
      break;
    }
  }
  if (!drivable) return false;
  for (const polygon of area.polygons) {
    if (polygon.kind === 'hole' && pointInRing(polygon.ring, x, y)) return false;
  }
  return true;
}

export interface Footprint {
  readonly x: number;
  readonly y: number;
  readonly headingRad: number;
  /** Along-heading extent, metres. */
  readonly lengthM: number;
  /** Across-heading extent, metres. */
  readonly widthM: number;
}

/** The four corners of an oriented footprint, front-left first, going around. */
export function footprintCorners(footprint: Footprint): [number, number][] {
  const fx = Math.cos(footprint.headingRad);
  const fy = Math.sin(footprint.headingRad);
  const hl = footprint.lengthM / 2;
  const hw = footprint.widthM / 2;
  return [
    [footprint.x + fx * hl - fy * hw, footprint.y + fy * hl + fx * hw],
    [footprint.x + fx * hl + fy * hw, footprint.y + fy * hl - fx * hw],
    [footprint.x - fx * hl + fy * hw, footprint.y - fy * hl - fx * hw],
    [footprint.x - fx * hl - fy * hw, footprint.y - fy * hl + fx * hw],
  ];
}

export interface ContainmentResult {
  /** True when every corner is on the drivable surface. */
  readonly inside: boolean;
  /** Corners found outside, 0..4. */
  readonly cornersOutside: number;
  /**
   * Distance from the drivable surface for the worst corner, metres; 0 when fully inside.
   * Reported so a marginal exit is legible instead of a bare boolean.
   */
  readonly worstOutsideM: number;
}

/**
 * Footprint containment.
 *
 * A footprint counts as off-road when ANY corner leaves the drivable surface — a vehicle with
 * two wheels over the kerb has left the road, and requiring all four corners out would only
 * report the cases nobody needed a metric to notice.
 */
export function footprintContainment(area: DrivableArea, footprint: Footprint): ContainmentResult {
  const corners = footprintCorners(footprint);
  let outside = 0;
  let worst = 0;
  for (const [x, y] of corners) {
    if (pointIsDrivable(area, x, y)) continue;
    outside += 1;
    // Distance to the nearest drivable boundary: how far out this corner actually is.
    let nearest = Number.POSITIVE_INFINITY;
    for (const polygon of area.polygons) {
      if (polygon.kind !== 'drivable') continue;
      nearest = Math.min(nearest, distanceToRing(polygon.ring, x, y));
    }
    if (Number.isFinite(nearest)) worst = Math.max(worst, nearest);
  }
  return { inside: outside === 0, cornersOutside: outside, worstOutsideM: worst };
}

export interface OffRoadEvent {
  readonly tUs: number;
  readonly cornersOutside: number;
  readonly worstOutsideM: number;
}

export interface OffRoadResult {
  readonly metric: typeof OFFROAD_METRIC_VERSION;
  readonly events: readonly OffRoadEvent[];
  readonly samples: number;
  readonly worstOutsideM: number;
}

/**
 * Score a pose sequence for off-road events.
 *
 * Used both for a replay and for the recorded drive itself — the latter is the control that
 * decides whether the metric is trustworthy at all, since a ground-truth drive its own scene
 * calls off-road falsifies the metric rather than the drive.
 */
export function scoreOffRoad(
  area: DrivableArea,
  poses: readonly { tUs: number; x: number; y: number; headingRad: number }[],
  dims: { lengthM: number; widthM: number },
): OffRoadResult {
  const events: OffRoadEvent[] = [];
  let worst = 0;
  for (const pose of poses) {
    const containment = footprintContainment(area, { ...pose, ...dims });
    worst = Math.max(worst, containment.worstOutsideM);
    if (!containment.inside) {
      events.push({ tUs: pose.tUs, cornersOutside: containment.cornersOutside, worstOutsideM: containment.worstOutsideM });
    }
  }
  return { metric: OFFROAD_METRIC_VERSION, events, samples: poses.length, worstOutsideM: worst };
}
