import polygonClipping, { type Polygon, type Pair } from 'polygon-clipping';
import { buildLanePolygonsLocal } from './build-topology-index.js';

/** Explicit paved cross-section types. Sidewalks, medians and restricted areas are not road. */
const ROAD_SURFACE_TYPES: Record<string, true> = {
  driving: true, bidirectional: true, entry: true, exit: true, onRamp: true, offRamp: true,
  connectingRamp: true, parking: true, shoulder: true, stop: true, biking: true,
};
export const ROAD_BOUNDARY_RECIPE = 'opendrive-road-outline/v1';
export interface RoadBoundaryOutline {
  schema: 'simforge.road-boundary/v1';
  recipe: typeof ROAD_BOUNDARY_RECIPE;
  frame: 'xodr-local';
  boundaries: { id: string; points: Pair[]; drivableSide: 'left' | 'right'; cutStart: boolean; cutEnd: boolean }[];
  /** Finite source support, before artificial map-cut caps are opened. */
  polygons: { id: string; kind: 'drivable' | 'hole'; ring: Pair[] }[];
  coverage: { boundsMinXY: Pair; boundsMaxXY: Pair };
  source: { xodrSha256: string; surfaceTypes: string[]; laneSurfaces: number; precisionM: number };
}

/** Dissolve complete source road cross-sections, preserving islands and open map termini. */
export function buildRoadBoundaryOutline(xodr: string, xodrSha256: string): RoadBoundaryOutline {
  const lanes = buildLanePolygonsLocal(xodr.replace(/>\s*</g, '>\n<')).filter((lane) => ROAD_SURFACE_TYPES[lane.laneType]);
  if (!lanes.length) throw new Error('OpenDRIVE has no explicit road surfaces');
  const snap = (value: number) => Math.round(value * 1000) / 1000;
  const polygons: Polygon[] = lanes.map((lane) => [lane.ring.map((p) => [snap(p.x), snap(p.y)] as Pair)]);
  // Section end caps are sampling limits, not kerbs. Shared/internal caps dissolve
  // in the union; exposed pieces become CUT termini rather than invented road ends.
  const caps = polygons.flatMap(([ring]) => {
    const middle = (ring!.length - 1) / 2;
    return [[ring![0]!, ring![ring!.length - 2]!], [ring![middle - 1]!, ring![middle]!]] as [Pair, Pair][];
  });
  // Millimetre integer inputs avoid representational cracks between decimal
  // copies of the same source vertex before sweep-line intersection arithmetic.
  const integerPolygons: Polygon[] = polygons.map((polygon) => polygon.map((ring) => ring.map(([x, y]) => [Math.round(x * 1000), Math.round(y * 1000)])));
  const dissolved = polygonClipping.union(integerPolygons[0]!, ...integerPolygons.slice(1))
    .map((polygon) => polygon.map((ring) => ring.map(([x, y]) => [x / 1000, y / 1000] as Pair)));
  const boundaries: RoadBoundaryOutline['boundaries'] = [];
  const surfacePolygons: RoadBoundaryOutline['polygons'] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const onCap = (a: Pair, b: Pair): boolean => {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length === 0) return false;
    const intervals: [number, number][] = [];
    for (const [p, q] of caps) {
      if (Math.max(a[0], b[0]) < Math.min(p[0], q[0]) - 0.002 || Math.min(a[0], b[0]) > Math.max(p[0], q[0]) + 0.002 || Math.max(a[1], b[1]) < Math.min(p[1], q[1]) - 0.002 || Math.min(a[1], b[1]) > Math.max(p[1], q[1]) + 0.002) continue;
      if (Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / length > 0.002 || Math.abs(dx * (q[1] - a[1]) - dy * (q[0] - a[0])) / length > 0.002) continue;
      const start = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length;
      const end = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / length;
      intervals.push([Math.min(start, end), Math.max(start, end)]);
    }
    // A dissolved cap may span several adjacent lanes; all of it must be
    // covered by source caps before removing it from the known road boundary.
    intervals.sort(([a], [b]) => a - b);
    let covered = 0;
    for (const [start, end] of intervals) {
      if (start > covered + 0.002) return false;
      covered = Math.max(covered, end);
      if (covered >= length - 0.002) return true;
    }
    return false;
  };
  for (const [polygonIndex, polygon] of dissolved.entries()) for (const [ringIndex, ring] of polygon.entries()) {
    surfacePolygons.push({ id: `surface-${polygonIndex}-${ringIndex}`, kind: ringIndex === 0 ? 'drivable' : 'hole', ring });
    // polygon-clipping normalizes exterior rings CCW and interior rings CW:
    // road is left of both. Verify rather than depending on undocumented input winding.
    let signedArea = 0;
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1]!, b = ring[i]!;
      signedArea += a[0] * b[1] - b[0] * a[1];
      minX = Math.min(minX, a[0]); minY = Math.min(minY, a[1]); maxX = Math.max(maxX, a[0]); maxY = Math.max(maxY, a[1]);
    }
    const drivableSide = (signedArea > 0) === (ringIndex === 0) ? 'left' : 'right';
    const cuts = ring.slice(1).map((point, i) => onCap(ring[i]!, point));
    const firstCut = cuts.indexOf(true);
    if (firstCut === -1) {
      boundaries.push({ id: `road-${polygonIndex}-${ringIndex}`, points: ring, drivableSide, cutStart: false, cutEnd: false });
      continue;
    }
    let points: Pair[] = [];
    for (let offset = 1; offset <= cuts.length; offset++) {
      const i = (firstCut + offset) % cuts.length;
      if (cuts[i]) {
        if (points.length > 1) boundaries.push({ id: `road-${polygonIndex}-${ringIndex}-${i}`, points, drivableSide, cutStart: true, cutEnd: true });
        points = [];
      } else {
        if (!points.length) points.push(ring[i]!);
        points.push(ring[i + 1]!);
      }
    }
  }
  if (!boundaries.length) throw new Error('OpenDRIVE road outline contains no non-cap edges');
  return { schema: 'simforge.road-boundary/v1', recipe: ROAD_BOUNDARY_RECIPE, frame: 'xodr-local', boundaries, polygons: surfacePolygons, coverage: { boundsMinXY: [minX, minY], boundsMaxXY: [maxX, maxY] }, source: { xodrSha256, surfaceTypes: Object.keys(ROAD_SURFACE_TYPES).sort(), laneSurfaces: lanes.length, precisionM: 0.001 } };
}
