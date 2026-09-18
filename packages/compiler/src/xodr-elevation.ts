/**
 * OpenDRIVE road-surface elevation from `<elevation>` profiles projected onto
 * the immutable lane topology. A renderer-side DTO resolver: it reads the
 * topology index a `MapBundle` exposes and never touches the engine.
 */

import { pointOf, type TopologyIndex, type TopologyLane } from '@simforge-oss/engine';

import { laneSectionWidthSamples } from '@simforge-oss/maps/topology';

import { nearestLane, OFF_NETWORK_BOUND_M } from './off-network.js';

interface LaneGeometry {
  readonly lane: TopologyLane;
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly cum: readonly number[];
  readonly lengthM: number;
}

function laneGeometry(lane: TopologyLane): LaneGeometry | null {
  const points = lane.polyline.map(pointOf);
  if (points.length < 2) return null;
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i += 1) cum.push(cum[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  return { lane, points, cum, lengthM: cum[cum.length - 1]! };
}


function widthAt(widths: readonly { readonly s: number; readonly widthM: number }[], s: number, fallbackM: number): number {
  if (widths.length === 0) return fallbackM;
  let before = widths[0]!;
  let after = widths[widths.length - 1]!;
  for (const sample of widths) {
    if (sample.s <= s) before = sample;
    if (sample.s >= s) { after = sample; break; }
  }
  if (after.s === before.s) return before.widthM;
  const t = (s - before.s) / (after.s - before.s);
  return before.widthM + (after.widthM - before.widthM) * t;
}

type Poly3 = { s: number; a: number; b: number; c: number; d: number };
type RoadProfile = { length: number; sectionStarts: number[]; elevations: Poly3[] };

const LANE_EDGE_TOLERANCE_M = 0.15;
const AMBIGUOUS_DISTANCE_EPSILON_M = 0.001;
const DISTINCT_SURFACE_EPSILON_M = 0.05;
const CONTINUOUS_SURFACE_MAX_GAP_M = 1;
const SPATIAL_CELL_M = 25;

function attrs(tag: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2/g)) result[match[1]!] = match[3]!;
  return result;
}

function finite(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`xodr_elevation_invalid:${label}`);
  return parsed;
}

function parseProfiles(xodr: string): Map<number, RoadProfile> {
  const result = new Map<number, RoadProfile>();
  for (const match of xodr.matchAll(/<road\b([^>]*)>([\s\S]*?)<\/road>/g)) {
    const roadAttrs = attrs(match[1]!);
    const id = finite(roadAttrs.id, 'road.id');
    const length = finite(roadAttrs.length, `road.${id}.length`);
    const body = match[2]!;
    const sectionStarts = [...body.matchAll(/<laneSection\b([^>]*)>/g)]
      .map((item) => finite(attrs(item[1]!).s, `road.${id}.laneSection.s`))
      .sort((a, b) => a - b);
    const elevations = [...body.matchAll(/<elevation\b([^>]*)\/?\s*>/g)]
      .map((item): Poly3 => {
        const values = attrs(item[1]!);
        return {
          s: finite(values.s, `road.${id}.elevation.s`),
          a: finite(values.a, `road.${id}.elevation.a`),
          b: finite(values.b, `road.${id}.elevation.b`),
          c: finite(values.c, `road.${id}.elevation.c`),
          d: finite(values.d, `road.${id}.elevation.d`),
        };
      })
      .sort((a, b) => a.s - b.s);
    if (result.has(id)) throw new Error(`xodr_elevation_duplicate_road:${id}`);
    result.set(id, { length, sectionStarts, elevations });
  }
  if (result.size === 0) throw new Error('xodr_elevation_no_roads');
  return result;
}

function evaluate(records: readonly Poly3[], s: number): number {
  if (records.length === 0) return 0;
  let record = records[0]!;
  for (const candidate of records) {
    if (candidate.s > s) break;
    record = candidate;
  }
  const ds = s - record.s;
  return record.a + record.b * ds + record.c * ds ** 2 + record.d * ds ** 3;
}

function projectSampledLane(
  points: readonly { readonly x: number; readonly y: number }[],
  cumulative: readonly number[],
  x: number,
  y: number,
): { arcS: number; sampleFraction: number; d: number } | null {
  if (points.length < 2 || cumulative.length !== points.length) return null;
  let best: { arcS: number; sampleFraction: number; d2: number } | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0;
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (best === null || d2 < best.d2) {
      best = {
        arcS: cumulative[index - 1]! + t * (cumulative[index]! - cumulative[index - 1]!),
        sampleFraction: (index - 1 + t) / (points.length - 1),
        d2,
      };
    }
  }
  return best && { arcS: best.arcS, sampleFraction: best.sampleFraction, d: Math.sqrt(best.d2) };
}

/**
 * Build an absolute OpenDRIVE road-surface resolver from immutable lane
 * topology. XY is accepted only inside concrete lane ribbons (with a bounded
 * off-road projection for parking and plazas). Overlapping surfaces use the
 * actor's authored roads when supplied and otherwise fail closed when distinct
 * unconnected decks are equally plausible.
 */
export function buildXodrElevationResolver(
  xodr: string,
  topology: TopologyIndex,
  preferredRoadsByActor?: ReadonlyMap<string, ReadonlySet<string>>,
): (position: { readonly x: number; readonly y: number; readonly actorId?: string }) => number {
  const profiles = parseProfiles(xodr);
  const laneRecords = new Map<string, {
    geometry: LaneGeometry;
    road: RoadProfile;
    sectionStart: number;
    sectionEnd: number;
    driving: boolean;
    roadId: number;
    /** Width samples inside the lane's own section; see `sectionWidths`. */
    widths: readonly { readonly s: number; readonly widthM: number }[];
    fallbackWidthM: number;
  }>();
  const roadNeighbors = new Map<number, Set<number>>();
  const linkRoads = (a: number, b: number) => {
    if (a === b) return;
    const forward = roadNeighbors.get(a) ?? new Set<number>();
    forward.add(b);
    roadNeighbors.set(a, forward);
    const backward = roadNeighbors.get(b) ?? new Set<number>();
    backward.add(a);
    roadNeighbors.set(b, backward);
  };
  const cells = new Map<string, Set<string>>();
  for (const rsl of Object.keys(topology.lanes).sort()) {
    const geometry = laneGeometry(topology.lanes[rsl]!);
    if (!geometry) continue;
    const driving = geometry.lane.laneType === 'driving';
    const road = profiles.get(geometry.lane.roadId);
    const sectionStart = road?.sectionStarts[geometry.lane.section];
    if (!road || sectionStart === undefined) throw new Error(`xodr_elevation_topology_mismatch:${rsl}`);
    const sectionEnd = road.sectionStarts[geometry.lane.section + 1] ?? road.length;
    if (!(sectionEnd > sectionStart) || !(geometry.lengthM > 0)) throw new Error(`xodr_elevation_degenerate_lane:${rsl}`);
    const widths = laneSectionWidthSamples(geometry.lane.widthSamples, sectionEnd - sectionStart, LANE_EDGE_TOLERANCE_M);
    const fallbackWidthM = widths.length === 0 ? geometry.lane.representativeWidthM ?? 3.5 : widths[0]!.widthM;
    laneRecords.set(rsl, { geometry, road, sectionStart, sectionEnd, driving, roadId: geometry.lane.roadId, widths, fallbackWidthM });
    for (const linked of [...(geometry.lane.predecessors ?? []), ...(geometry.lane.successors ?? [])]) {
      const linkedRoad = Number(linked.split(':')[0]);
      if (Number.isFinite(linkedRoad)) linkRoads(geometry.lane.roadId, linkedRoad);
    }
    const halfWidth = Math.max(fallbackWidthM, ...widths.map((sample) => sample.widthM)) / 2 + LANE_EDGE_TOLERANCE_M;
    /**
     * Stamp the index along the lane's polyline, one short segment at a time.
     *
     * This used to rasterize the lane's axis-aligned bounding box. A bounding
     * box is the area a lane *could* occupy; a long diagonal, curving or ramp
     * lane occupies a sliver of it, and summed over a city-sized map those
     * boxes ran to tens of millions of cells — at which point `Map.set` throws
     * V8's `RangeError: Map maximum size exceeded` and takes the scenario's
     * whole OpenSCENARIO export, and therefore every render of it, with it.
     *
     * The cell set is the same one queries can reach: a position within
     * `halfWidth` of the ribbon is within `halfWidth` of one of these segments,
     * so it falls inside that segment's inflated box.
     */
    for (let index = 1; index < geometry.points.length; index += 1) {
      const from = geometry.points[index - 1]!;
      const to = geometry.points[index]!;
      const minX = Math.floor((Math.min(from.x, to.x) - halfWidth) / SPATIAL_CELL_M);
      const maxX = Math.floor((Math.max(from.x, to.x) + halfWidth) / SPATIAL_CELL_M);
      const minY = Math.floor((Math.min(from.y, to.y) - halfWidth) / SPATIAL_CELL_M);
      const maxY = Math.floor((Math.max(from.y, to.y) + halfWidth) / SPATIAL_CELL_M);
      for (let cellX = minX; cellX <= maxX; cellX += 1) {
        for (let cellY = minY; cellY <= maxY; cellY += 1) {
          const key = `${cellX},${cellY}`;
          const members = cells.get(key) ?? new Set<string>();
          members.add(rsl);
          cells.set(key, members);
        }
      }
    }
  }
  const roadsContinuous = (a: number, b: number): boolean => {
    if (a === b) return true;
    const aNeighbors = roadNeighbors.get(a);
    const bNeighbors = roadNeighbors.get(b);
    if (!aNeighbors || !bNeighbors) return false;
    if (aNeighbors.has(b) || bNeighbors.has(a)) return true;
    const [small, large] = aNeighbors.size <= bNeighbors.size ? [aNeighbors, bNeighbors] : [bNeighbors, aNeighbors];
    for (const road of small) if (large.has(road)) return true;
    return false;
  };
  return ({ x, y, actorId }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('xodr_elevation_non_finite_position');
    const candidates: Array<{ rsl: string; d: number; elevation: number; driving: boolean; roadId: number }> = [];
    const nearby = cells.get(`${Math.floor(x / SPATIAL_CELL_M)},${Math.floor(y / SPATIAL_CELL_M)}`) ?? [];
    for (const rsl of nearby) {
      const { geometry, road, sectionStart, sectionEnd, driving, roadId, widths, fallbackWidthM } = laneRecords.get(rsl)!;
      const projected = projectSampledLane(geometry.points, geometry.cum, x, y);
      if (!projected || projected.d > widthAt(widths, projected.arcS, fallbackWidthM) / 2 + LANE_EDGE_TOLERANCE_M) continue;
      const roadS = sectionStart + projected.sampleFraction * (sectionEnd - sectionStart);
      candidates.push({ rsl, d: projected.d, elevation: evaluate(road.elevations, roadS), driving, roadId });
    }
    let tier = candidates.filter((candidate) => candidate.driving);
    if (tier.length === 0) tier = candidates;
    const preferredRoads = actorId ? preferredRoadsByActor?.get(actorId) : undefined;
    if (preferredRoads && preferredRoads.size > 0) {
      const onRoute = tier.filter((candidate) => preferredRoads.has(candidate.rsl.split(':')[0]!));
      if (onRoute.length > 0) tier = onRoute;
    }
    tier.sort((a, b) => a.d - b.d || a.rsl.localeCompare(b.rsl));
    const best = tier[0];
    const label = actorId ? `:${actorId}` : '';
    if (!best) {
      const cellX = Math.floor(x / SPATIAL_CELL_M);
      const cellY = Math.floor(y / SPATIAL_CELL_M);
      let nearest: { d: number; rsl: string; elevation: number } | null = null;
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const rsl of cells.get(`${cellX + dx},${cellY + dy}`) ?? []) {
            const { geometry, road, sectionStart, sectionEnd } = laneRecords.get(rsl)!;
            const projected = projectSampledLane(geometry.points, geometry.cum, x, y);
            if (!projected) continue;
            const roadS = sectionStart + projected.sampleFraction * (sectionEnd - sectionStart);
            const elevation = evaluate(road.elevations, roadS);
            if (!nearest || projected.d < nearest.d || (projected.d === nearest.d && rsl.localeCompare(nearest.rsl) < 0)) {
              nearest = { d: projected.d, rsl, elevation };
            }
          }
        }
      }
      if (!nearest || nearest.d > OFF_NETWORK_BOUND_M) {
        // Only on the failure path, so an exhaustive search is affordable: the
        // caller is about to abort, and a refusal without a distance in it is
        // what made this failure unreadable in the first place.
        const truth = nearestLane(topology, x, y);
        const distance = truth ? `${truth.distanceM.toFixed(1)}m_from_${truth.rsl}` : 'no_lane_in_map';
        throw new Error(
          `xodr_elevation_unresolvable${label}:x=${x.toFixed(1)}:y=${y.toFixed(1)}:${distance}:bound=${OFF_NETWORK_BOUND_M}m`,
        );
      }
      return nearest.elevation;
    }
    const conflicting = tier.find((candidate) =>
      candidate !== best
      && Math.abs(candidate.d - best.d) <= AMBIGUOUS_DISTANCE_EPSILON_M
      && Math.abs(candidate.elevation - best.elevation) > DISTINCT_SURFACE_EPSILON_M
      && !(Math.abs(candidate.elevation - best.elevation) <= CONTINUOUS_SURFACE_MAX_GAP_M
        && roadsContinuous(best.roadId, candidate.roadId)));
    if (conflicting) throw new Error(`xodr_elevation_ambiguous${label}:${best.rsl}:${conflicting.rsl}`);
    if (!Number.isFinite(best.elevation)) throw new Error(`xodr_elevation_non_finite_surface:${best.rsl}`);
    return best.elevation;
  };
}
