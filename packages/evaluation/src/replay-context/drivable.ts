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

export const OrientedBoundarySchema = z.strictObject({
  id: z.string().min(1),
  /** Open polyline, in order; never implicitly closed. */
  points: z.array(z.tuple([Finite, Finite])).min(2),
  /** Which side of the polyline direction the source says carries traffic. */
  drivableSide: z.enum(['left', 'right']),
  /** True when the terminus is where labelling was cut, not where the road physically ends. */
  cutStart: z.boolean(),
  cutEnd: z.boolean(),
});
export type OrientedBoundary = z.infer<typeof OrientedBoundarySchema>;

export const DrivableAreaSchema = z.strictObject({
  /**
   * Which ingestion produced this geometry. Carried into the score record so the two are
   * separable forever: `clipgt-lane-union` is the instrument whose ground-truth control failed
   * and is retained for reproducibility, `clipgt-road-boundary` is the authoritative outline.
   */
  source: z.enum(['clipgt-road-boundary', 'clipgt-lane-union']),
  geometry: z.enum(['oriented-boundaries', 'polygons']),
  /** Must equal `ego.frame`; a mismatch is refused rather than transformed. */
  frame: z.string().min(1),
  confidence: z.enum(['authoritative', 'low']),
  /** `null` means static for the clip: ClipGT geometry carries no time dimension. */
  timeSupportUs: z.strictObject({ startUs: z.number().int(), endUs: z.number().int() }).nullable(),
  /** Oriented road edges. Populated for `oriented-boundaries`, empty otherwise. */
  boundaries: z.array(OrientedBoundarySchema).default([]),
  /** Rings. For `oriented-boundaries` these are island exclusions only. */
  polygons: z.array(DrivablePolygonSchema).default([]),
  coverage: z.strictObject({
    boundsMinXY: z.tuple([Finite, Finite]),
    boundsMaxXY: z.tuple([Finite, Finite]),
  }),
  provenance: z.record(z.string(), z.unknown()).optional(),
}).refine((area) => (area.geometry === 'oriented-boundaries' ? area.boundaries.length > 0 : area.polygons.some((p) => p.kind === 'drivable')), {
  message: 'declared geometry carries no features of its own kind',
});
export type DrivableArea = z.infer<typeof DrivableAreaSchema>;

/**
 * Metric identity, per instrument. The geometry source is part of the measurement, so a
 * boundary-assembled run must not be comparable to a lane-union run by accident.
 */
export const OFFROAD_METRIC_VERSIONS = {
  'oriented-boundaries': 'simforge.offroad/v3',
  polygons: 'simforge.offroad/v2',
} as const;
export type OffRoadMetricVersion = (typeof OFFROAD_METRIC_VERSIONS)[keyof typeof OFFROAD_METRIC_VERSIONS];

export function offRoadMetricVersion(area: DrivableArea): OffRoadMetricVersion {
  return OFFROAD_METRIC_VERSIONS[area.geometry];
}

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
 * Convenience over {@link classifyPoint} for callers that only need a boolean. Note that an
 * *unavailable* point is not drivable and not off-road either — anything that must distinguish
 * "no" from "unknown" has to use the classifier.
 */
export function pointIsDrivable(area: DrivableArea, x: number, y: number): boolean {
  return classifyPoint(area, x, y).verdict === 'drivable';
}

export type PointVerdict = 'drivable' | 'off-road' | 'unavailable';

export interface PointClassification {
  readonly verdict: PointVerdict;
  /**
   * Distance to the nearest road edge, metres. For `off-road` this is how far out the point is;
   * for `unavailable` it is how far the point is from the terminus that made it unavailable.
   */
  readonly distanceM: number;
}

/**
 * Classify a point against oriented road edges.
 *
 * The source labels which side of each boundary carries traffic, so the nearest boundary decides:
 * the point is on the road if it lies on that boundary's drivable side. No closure is needed and
 * none is invented, which matters because on this corpus the edges never close — they are chains
 * truncated at the clip extent.
 *
 * Where the nearest feature is a `CUT` terminus, labelling stops rather than the road, and the
 * answer is `unavailable`. Reporting off-road there would turn "we stopped annotating" into "the
 * car left the road", which is exactly the class of error the v1 metric made.
 */
function classifyAgainstBoundaries(area: DrivableArea, x: number, y: number): PointClassification {
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestDrivable = false;
  let bestAtCut = false;
  for (const boundary of area.boundaries) {
    const points = boundary.points;
    for (let i = 1; i < points.length; i += 1) {
      const [x1, y1] = points[i - 1]!;
      const [x2, y2] = points[i]!;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq));
      const distance = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      // Sign of the cross product: positive means the point is left of the segment direction.
      const onLeft = dx * (y - y1) - dy * (x - x1) > 0;
      bestDrivable = onLeft === (boundary.drivableSide === 'left');
      // Only a terminus of the whole polyline can be a cut; interior vertices are joins.
      bestAtCut = (t === 0 && i === 1 && boundary.cutStart) || (t === 1 && i === points.length - 1 && boundary.cutEnd);
    }
  }
  if (!Number.isFinite(bestDistance)) return { verdict: 'unavailable', distanceM: 0 };
  if (bestAtCut) return { verdict: 'unavailable', distanceM: bestDistance };
  return { verdict: bestDrivable ? 'drivable' : 'off-road', distanceM: bestDistance };
}

/**
 * Classify a point against whichever geometry the bundle carries.
 *
 * Island exclusions subtract under both geometries: a median is not drivable because it sits
 * inside the road's outline.
 */
export function classifyPoint(area: DrivableArea, x: number, y: number): PointClassification {
  for (const polygon of area.polygons) {
    if (polygon.kind === 'hole' && pointInRing(polygon.ring, x, y)) {
      return { verdict: 'off-road', distanceM: distanceToRing(polygon.ring, x, y) };
    }
  }
  if (area.geometry === 'oriented-boundaries') return classifyAgainstBoundaries(area, x, y);
  let nearest = Number.POSITIVE_INFINITY;
  for (const polygon of area.polygons) {
    if (polygon.kind !== 'drivable') continue;
    if (pointInRing(polygon.ring, x, y)) return { verdict: 'drivable', distanceM: 0 };
    nearest = Math.min(nearest, distanceToRing(polygon.ring, x, y));
  }
  return { verdict: 'off-road', distanceM: Number.isFinite(nearest) ? nearest : 0 };
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
  /** True when every corner is on the drivable surface. False also when the answer is unknown. */
  readonly inside: boolean;
  /** True when at least one corner fell where the source does not state whether road exists. */
  readonly unavailable: boolean;
  /** Corners found outside, 0..4. Zero when the sample is unavailable. */
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
 *
 * Unavailability wins over off-road. If any corner lands where labelling stopped, the sample is
 * unknown rather than an excursion: with part of the box unlabelled we cannot tell a kerb strike
 * from the end of the annotated extent, and guessing would manufacture the finding.
 */
export function footprintContainment(area: DrivableArea, footprint: Footprint): ContainmentResult {
  let outside = 0;
  let worst = 0;
  for (const [x, y] of footprintCorners(footprint)) {
    const classification = classifyPoint(area, x, y);
    if (classification.verdict === 'unavailable') {
      return { inside: false, unavailable: true, cornersOutside: 0, worstOutsideM: 0 };
    }
    if (classification.verdict === 'drivable') continue;
    outside += 1;
    worst = Math.max(worst, classification.distanceM);
  }
  return { inside: outside === 0, unavailable: false, cornersOutside: outside, worstOutsideM: worst };
}

export interface OffRoadEvent {
  readonly tUs: number;
  readonly cornersOutside: number;
  readonly worstOutsideM: number;
}

export interface OffRoadResult {
  /** Instrument identity, including which geometry source produced the answer. */
  readonly metric: OffRoadMetricVersion;
  readonly source: DrivableArea['source'];
  readonly events: readonly OffRoadEvent[];
  /** Poses offered. */
  readonly samples: number;
  /** Poses actually decidable; `samples - assessed` were unavailable. */
  readonly assessed: number;
  readonly unavailable: number;
  /**
   * Worst excursion among assessed samples, metres. `0` on an assessed-and-clean run and `null`
   * when nothing was assessable, so a consumer can tell clean from never-asked.
   */
  readonly worstOutsideM: number | null;
}

/**
 * Score a pose sequence for off-road events.
 *
 * Used both for a replay and for the recorded drive itself — the latter is the control that
 * decides whether the metric is trustworthy at all, since a ground-truth drive its own scene
 * calls off-road falsifies the metric rather than the drive. Passing that control is a necessary
 * condition for the instrument, not evidence that every human trajectory is legal.
 */
export function scoreOffRoad(
  area: DrivableArea,
  poses: readonly { tUs: number; x: number; y: number; headingRad: number }[],
  dims: { lengthM: number; widthM: number },
): OffRoadResult {
  const events: OffRoadEvent[] = [];
  let worst = 0;
  let assessed = 0;
  let unavailable = 0;
  for (const pose of poses) {
    const containment = footprintContainment(area, { ...pose, ...dims });
    if (containment.unavailable) {
      unavailable += 1;
      continue;
    }
    assessed += 1;
    worst = Math.max(worst, containment.worstOutsideM);
    if (!containment.inside) {
      events.push({ tUs: pose.tUs, cornersOutside: containment.cornersOutside, worstOutsideM: containment.worstOutsideM });
    }
  }
  return {
    metric: offRoadMetricVersion(area),
    source: area.source,
    events,
    samples: poses.length,
    assessed,
    unavailable,
    worstOutsideM: assessed === 0 ? null : worst,
  };
}
