/**
 * Geometry for moving a scenario to another publication of its map
 * (`map-transition.ts`): lane lookup and projection by world position, lane
 * chains matched by shape, and the per-road OpenDRIVE diff.
 *
 * Frames: everything here is xodr-local metres (`x` east, `y` north), the frame
 * the topology index stores. A scene pose converts as `(x, z) -> (x, -z)`, and
 * a heading is the same number in both (radians CCW from +x).
 *
 * Lane conventions are the editor's (`packages/editor/src/laneIndex.ts`), so a
 * lane anchor written here is the one the editor would have written for the
 * same drop: `s` is the arc length along the stored polyline, travel runs along
 * storage order for a negative OpenDRIVE lane id and against it for a positive
 * one, and `t` is the lateral offset in metres, positive to the left of travel.
 *
 * Pure: no server imports, so it is tested directly.
 */

import { createHash } from "node:crypto";

import type { TopologyIndex, TopologyLane } from "@simforge-oss/engine";

import { laneClass } from "./transfer-preview";

export type Point = { x: number; y: number };

export type GeoLane = {
  readonly rsl: string;
  readonly roadId: string;
  readonly section: number;
  readonly laneId: number;
  readonly laneType: string;
  /** `laneClass` of the type, or the type itself for lanes nothing places actors on. */
  readonly family: string;
  /** Travel runs along storage order (negative OpenDRIVE lane id). */
  readonly forward: boolean;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Arc length at each vertex; `cum[0] === 0`. */
  readonly cum: Float64Array;
  readonly length: number;
  readonly widthM: number;
  /** Lanes the topology links to either end (storage-order successors and predecessors). */
  readonly neighbours: readonly string[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

export type LaneProjection = {
  readonly lane: GeoLane;
  /** Storage arc length of the foot point. */
  readonly s: number;
  /** Signed lateral offset of the query point, metres, positive left of travel. */
  readonly t: number;
  /** Distance from the query point to the centreline. */
  readonly distance: number;
  /** Foot point on the centreline. */
  readonly x: number;
  readonly y: number;
  /** Travel heading at the foot point. */
  readonly headingRad: number;
};

const TAU = Math.PI * 2;

export function normalizeHeading(rad: number): number {
  let out = rad % TAU;
  if (out > Math.PI) out -= TAU;
  if (out <= -Math.PI) out += TAU;
  return out;
}

/** Absolute angle between two headings, radians in `[0, π]`. */
export function headingGap(a: number, b: number): number {
  return Math.abs(normalizeHeading(a - b));
}

function vertex(point: TopologyLane["polyline"][number]): Point {
  return Array.isArray(point) ? { x: point[0], y: point[1] } : (point as Point);
}

/** The family a lane belongs to for placement: drive / walk / park, else its own type. */
export function laneFamily(laneType: string): string {
  return laneClass(laneType) ?? laneType.toLowerCase();
}

function geoLane(rsl: string, record: TopologyLane): GeoLane | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const raw of record.polyline ?? []) {
    const point = vertex(raw);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const lastX = xs[xs.length - 1];
    const lastY = ys[ys.length - 1];
    if (lastX !== undefined && Math.abs(lastX - point.x) < 1e-9 && Math.abs(lastY! - point.y) < 1e-9) continue;
    xs.push(point.x);
    ys.push(point.y);
  }
  if (xs.length < 2) return null;
  const cum = new Float64Array(xs.length);
  for (let i = 1; i < xs.length; i += 1) cum[i] = cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!);
  const width = record.representativeWidthM;
  return {
    rsl,
    roadId: String(record.roadId),
    section: record.section,
    laneId: record.laneId,
    laneType: record.laneType,
    family: laneFamily(record.laneType),
    forward: record.laneId < 0,
    xs: Float64Array.from(xs),
    ys: Float64Array.from(ys),
    cum,
    length: cum[cum.length - 1]!,
    widthM: width && width > 0 ? width : 3.5,
    neighbours: [...new Set([...(record.successors ?? []), ...(record.predecessors ?? [])])],
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

const CELL_M = 16;

/** Every lane of one map, with a coarse grid over their extents for nearby-lane queries. */
export class LaneGeometryIndex {
  private readonly byRsl = new Map<string, GeoLane>();
  private readonly cells = new Map<string, GeoLane[]>();

  constructor(topology: Pick<TopologyIndex, "lanes">) {
    for (const rsl of Object.keys(topology.lanes).sort()) {
      const lane = geoLane(rsl, topology.lanes[rsl]!);
      if (!lane) continue;
      this.byRsl.set(rsl, lane);
      for (let i = Math.floor(lane.minX / CELL_M); i <= Math.floor(lane.maxX / CELL_M); i += 1) {
        for (let j = Math.floor(lane.minY / CELL_M); j <= Math.floor(lane.maxY / CELL_M); j += 1) {
          const key = `${i},${j}`;
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(lane);
          else this.cells.set(key, [lane]);
        }
      }
    }
  }

  get lanes(): IterableIterator<GeoLane> {
    return this.byRsl.values();
  }

  lane(rsl: string): GeoLane | undefined {
    return this.byRsl.get(rsl);
  }

  /** Lanes whose extent comes within `radius` of the point (a superset of those whose centreline does). */
  lanesNear(x: number, y: number, radius: number): GeoLane[] {
    const found = new Set<GeoLane>();
    for (let i = Math.floor((x - radius) / CELL_M); i <= Math.floor((x + radius) / CELL_M); i += 1) {
      for (let j = Math.floor((y - radius) / CELL_M); j <= Math.floor((y + radius) / CELL_M); j += 1) {
        for (const lane of this.cells.get(`${i},${j}`) ?? []) {
          if (x < lane.minX - radius || x > lane.maxX + radius || y < lane.minY - radius || y > lane.maxY + radius) continue;
          found.add(lane);
        }
      }
    }
    return [...found].sort((a, b) => a.rsl.localeCompare(b.rsl));
  }
}

function segmentAt(lane: GeoLane, s: number): number {
  let lo = 0;
  let hi = lane.cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (lane.cum[mid]! <= s) lo = mid;
    else hi = mid;
  }
  return Math.min(lo, lane.xs.length - 2);
}

/** Travel heading and foot point at storage arc length `s` (clamped), offset `t` to the left of travel. */
export function poseAt(lane: GeoLane, s: number, t = 0): { x: number; y: number; headingRad: number } {
  const clamped = Math.min(lane.length, Math.max(0, s));
  const i = segmentAt(lane, clamped);
  const ax = lane.xs[i]!;
  const ay = lane.ys[i]!;
  const bx = lane.xs[i + 1]!;
  const by = lane.ys[i + 1]!;
  const segLength = lane.cum[i + 1]! - lane.cum[i]!;
  const f = segLength > 0 ? (clamped - lane.cum[i]!) / segLength : 0;
  const stored = Math.atan2(by - ay, bx - ax);
  const headingRad = normalizeHeading(lane.forward ? stored : stored + Math.PI);
  // Left of travel: the travel direction turned +90°.
  return {
    x: ax + (bx - ax) * f - Math.sin(headingRad) * t,
    y: ay + (by - ay) * f + Math.cos(headingRad) * t,
    headingRad,
  };
}

/** Project a point onto one lane's centreline. */
export function projectOntoLane(lane: GeoLane, x: number, y: number): LaneProjection {
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i < lane.xs.length - 1; i += 1) {
    const ax = lane.xs[i]!;
    const ay = lane.ys[i]!;
    const dx = lane.xs[i + 1]! - ax;
    const dy = lane.ys[i + 1]! - ay;
    const length2 = dx * dx + dy * dy;
    const f = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2)) : 0;
    const d2 = (ax + f * dx - x) ** 2 + (ay + f * dy - y) ** 2;
    if (d2 < best) {
      best = d2;
      bestS = lane.cum[i]! + f * Math.sqrt(length2);
    }
  }
  const foot = poseAt(lane, bestS);
  const t = (x - foot.x) * -Math.sin(foot.headingRad) + (y - foot.y) * Math.cos(foot.headingRad);
  return { lane, s: bestS, t, distance: Math.sqrt(best), x: foot.x, y: foot.y, headingRad: foot.headingRad };
}

/**
 * The lane of `family` nearest to a point whose travel heading is within
 * `maxHeadingGapRad` of `headingRad`, within `radius`. A lane named `preferRsl`
 * wins over a nearer one by less than `preferSlackM`: publications of one map
 * usually keep their lane ids, and two overlapping junction connectors are the
 * same place to a query point.
 */
export function nearestLane(
  index: LaneGeometryIndex,
  point: Point,
  options: { family: string; headingRad: number; maxHeadingGapRad: number; radius: number; preferRsl?: string; preferSlackM?: number },
): LaneProjection | null {
  let best: LaneProjection | null = null;
  let preferred: LaneProjection | null = null;
  for (const lane of index.lanesNear(point.x, point.y, options.radius)) {
    if (lane.family !== options.family) continue;
    const hit = projectOntoLane(lane, point.x, point.y);
    if (hit.distance > options.radius) continue;
    if (headingGap(hit.headingRad, options.headingRad) > options.maxHeadingGapRad) continue;
    if (!best || hit.distance < best.distance - 1e-9) best = hit;
    if (lane.rsl === options.preferRsl) preferred = hit;
  }
  if (preferred && best && preferred.distance <= best.distance + (options.preferSlackM ?? 0)) return preferred;
  return best;
}

// ── Lane chains ──────────────────────────────────────────────────────────────────────────

/** A lane's centreline in travel order. */
function travelPoints(lane: GeoLane, reversed: boolean): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < lane.xs.length; i += 1) points.push({ x: lane.xs[i]!, y: lane.ys[i]! });
  return reversed ? points.reverse() : points;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * A lane chain as one travel-ordered polyline. Each lane is turned to continue
 * from the previous one's end (lane polylines are stored in reference-line
 * order, against travel for half of them); the first is turned to meet the
 * second, or by its lane id when it is alone.
 */
export function chainPolyline(index: LaneGeometryIndex, rsls: readonly string[]): Point[] | null {
  const lanes = rsls.map((rsl) => index.lane(rsl));
  if (lanes.length === 0 || lanes.some((lane) => !lane)) return null;
  const out: Point[] = [];
  for (const [position, lane] of (lanes as GeoLane[]).entries()) {
    let points = travelPoints(lane, false);
    if (position === 0) {
      const next = lanes[1];
      if (next) {
        const nextEnds = [{ x: next.xs[0]!, y: next.ys[0]! }, { x: next.xs[next.xs.length - 1]!, y: next.ys[next.ys.length - 1]! }];
        const toNext = (p: Point) => Math.min(...nextEnds.map((end) => distance(end, p)));
        if (toNext(points[0]!) < toNext(points[points.length - 1]!)) points.reverse();
      } else if (!lane.forward) {
        points.reverse();
      }
    } else {
      const last = out[out.length - 1]!;
      if (distance(points[points.length - 1]!, last) < distance(points[0]!, last)) points.reverse();
      if (distance(points[0]!, last) < 1e-6) points = points.slice(1);
    }
    out.push(...points);
  }
  return out.length >= 2 ? out : null;
}

type Sample = Point & { headingRad: number; along: number };

/** Points every `stepM` along a polyline, with the travel heading there. */
export function samplePolyline(points: readonly Point[], stepM: number): Sample[] {
  const out: Sample[] = [];
  let along = 0;
  let next = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = distance(a, b);
    if (length <= 0) continue;
    const headingRad = Math.atan2(b.y - a.y, b.x - a.x);
    while (next <= along + length) {
      const f = (next - along) / length;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, headingRad, along: next });
      next += stepM;
    }
    along += length;
  }
  const last = points[points.length - 1]!;
  const tail = out[out.length - 1];
  if (points.length >= 2 && (!tail || along - tail.along > 1e-6)) {
    const before = points[points.length - 2]!;
    out.push({ ...last, headingRad: Math.atan2(last.y - before.y, last.x - before.x), along });
  }
  return out;
}

/** Distance from a point to a polyline. */
export function distanceToPolyline(points: readonly Point[], p: Point): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const f = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
    best = Math.min(best, Math.hypot(a.x + f * dx - p.x, a.y + f * dy - p.y));
  }
  return best;
}

export type ChainMatch =
  | { ok: true; lanes: string[] }
  | { ok: false; lanes: string[]; at: Point; reason: string };

/** Samples this far apart are matched along a lane chain. */
const CHAIN_STEP_M = 2;
/** Lanes whose ends are further apart than this do not connect (the engine's own lane-path tolerance). */
const CONNECT_M = 0.5;
/** Samples scored ahead when choosing between two continuations (a junction's straight and turning connectors). */
const LOOKAHEAD_SAMPLES = 6;

/**
 * Match a lane chain of one map onto another by shape: walk the target lane
 * graph along the source chain's centreline, staying on a lane while the line
 * runs along it and, at its end, continuing onto the connected lane that
 * follows the line best. Every sample must lie within `toleranceM` of the lane
 * it is matched to, so the result is connected by construction; where that
 * fails the match stops and says where.
 */
export function matchLaneChain(
  source: LaneGeometryIndex,
  target: LaneGeometryIndex,
  rsls: readonly string[],
  options: { toleranceM: number; startRsl?: string },
): ChainMatch {
  const line = chainPolyline(source, rsls);
  if (!line) {
    return { ok: false, lanes: [], at: { x: 0, y: 0 }, reason: `the route names lanes the current map version does not have (${rsls.join(", ")})` };
  }
  const family = source.lane(rsls[0]!)!.family;
  const samples = samplePolyline(line, CHAIN_STEP_M);
  const first = samples[0]!;
  const start = options.startRsl ? target.lane(options.startRsl) ?? null : null;
  const startHit = start
    ? projectOntoLane(start, first.x, first.y)
    : nearestLane(target, first, {
      family,
      headingRad: first.headingRad,
      maxHeadingGapRad: Math.PI / 4,
      radius: options.toleranceM,
      preferRsl: rsls[0]!,
      preferSlackM: 0.75,
    });
  if (!startHit || startHit.distance > options.toleranceM) {
    return { ok: false, lanes: [], at: { x: first.x, y: first.y }, reason: "no lane on the new map where the route starts" };
  }
  let current = startHit.lane;
  // Travel orientation of the current lane: which storage direction the line runs along it.
  let reversed = headingGap(poseAt(current, startHit.s).headingRad, first.headingRad) > Math.PI / 2
    ? current.forward
    : !current.forward;
  const lanes = [current.rsl];
  const travelEnd = (lane: GeoLane, rev: boolean): Point =>
    rev ? { x: lane.xs[0]!, y: lane.ys[0]! } : { x: lane.xs[lane.xs.length - 1]!, y: lane.ys[lane.ys.length - 1]! };
  const travelStart = (lane: GeoLane, rev: boolean): Point => travelEnd(lane, !rev);
  for (let k = 1; k < samples.length; k += 1) {
    const sample = samples[k]!;
    const onCurrent = projectOntoLane(current, sample.x, sample.y);
    const endS = reversed ? 0 : current.length;
    const atEnd = Math.abs(onCurrent.s - endS) < 0.25;
    // The line's own last point may sit on the lane's end: that ends the route, it does not continue it.
    if (onCurrent.distance <= options.toleranceM && (!atEnd || k === samples.length - 1)) continue;
    // Continue onto a lane joined to the current one's travel end.
    const end = travelEnd(current, reversed);
    let bestNext: { lane: GeoLane; reversed: boolean; score: number } | null = null;
    for (const rsl of current.neighbours) {
      const lane = target.lane(rsl);
      if (!lane || lane.family !== current.family || lanes.includes(rsl)) continue;
      for (const rev of [false, true]) {
        if (distance(travelStart(lane, rev), end) > CONNECT_M) continue;
        const ahead = samples.slice(k, k + LOOKAHEAD_SAMPLES);
        const fits = ahead.map((point) => distanceToPolyline(travelPoints(lane, rev), point));
        if (fits[0]! > options.toleranceM) continue;
        const score = fits.reduce((sum, value) => sum + value, 0) / fits.length;
        if (!bestNext || score < bestNext.score) bestNext = { lane, reversed: rev, score };
      }
    }
    if (bestNext) {
      current = bestNext.lane;
      reversed = bestNext.reversed;
      lanes.push(current.rsl);
      continue;
    }
    // At the end of a lane with no continuation, a sample still on it is the route's own end.
    if (onCurrent.distance <= options.toleranceM) continue;
    return { ok: false, lanes, at: { x: sample.x, y: sample.y }, reason: "the new map has no connected lane where the route continues" };
  }
  return { ok: true, lanes };
}

/** One lane in travel order: turned to meet `next` (or leave `previous`), else by its lane id. */
export function laneTravelPolyline(index: LaneGeometryIndex, rsl: string, previous?: string, next?: string): Point[] | null {
  const lane = index.lane(rsl);
  if (!lane) return null;
  const points = travelPoints(lane, false);
  const ends = (other: GeoLane | undefined) =>
    other ? [{ x: other.xs[0]!, y: other.ys[0]! }, { x: other.xs[other.xs.length - 1]!, y: other.ys[other.ys.length - 1]! }] : null;
  const near = (targets: Point[], p: Point) => Math.min(...targets.map((end) => distance(end, p)));
  const after = ends(next ? index.lane(next) : undefined);
  const before = ends(previous ? index.lane(previous) : undefined);
  if (after) {
    if (near(after, points[0]!) < near(after, points[points.length - 1]!)) points.reverse();
  } else if (before) {
    if (near(before, points[points.length - 1]!) < near(before, points[0]!)) points.reverse();
  } else if (!lane.forward) {
    points.reverse();
  }
  return points;
}

/** The point `along` metres down a polyline (clamped) and the heading there. */
export function pointAlong(points: readonly Point[], along: number): Point & { headingRad: number } {
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = distance(a, b);
    if (length <= 0) continue;
    if (walked + length >= along || i === points.length - 1) {
      const f = Math.max(0, Math.min(1, (along - walked) / length));
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, headingRad: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    walked += length;
  }
  const only = points[0]!;
  return { ...only, headingRad: 0 };
}

/** The polyline from the point nearest `start` onward, beginning at that foot point. */
export function polylineFrom(points: readonly Point[], start: Point): Point[] {
  let bestIndex = 0;
  let best = Infinity;
  let foot: Point = points[0]!;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const f = length2 > 0 ? Math.max(0, Math.min(1, ((start.x - a.x) * dx + (start.y - a.y) * dy) / length2)) : 0;
    const p = { x: a.x + f * dx, y: a.y + f * dy };
    const d = distance(p, start);
    if (d < best - 1e-9) {
      best = d;
      bestIndex = i;
      foot = p;
    }
  }
  return [foot, ...points.slice(bestIndex)];
}

/**
 * How far two routes run apart over their first `reachM` metres: the largest
 * distance from a point on either one to the other.
 */
export function routeDeviation(a: readonly Point[], b: readonly Point[], reachM: number, stepM = 2): number {
  const head = (points: readonly Point[]) => samplePolyline(points, stepM).filter((sample) => sample.along <= reachM);
  let worst = 0;
  for (const sample of head(a)) worst = Math.max(worst, distanceToPolyline(b, sample));
  for (const sample of head(b)) worst = Math.max(worst, distanceToPolyline(a, sample));
  return worst;
}

// ── Road diff ────────────────────────────────────────────────────────────────────────────

export type RoadChange = "none" | "elevation" | "geometry" | "added" | "removed";

type RoadDigest = { raw: string; plan: string };

const ROAD_ELEMENT = /<road\b[^>]*?(?:\/>|>[\s\S]*?<\/road\s*>)/g;
const ROAD_ID = /^<road\b[^>]*?\sid\s*=\s*(["'])(.*?)\1/;
/** What a height-only refit may change: road elevation, superelevation/shape, lane heights. */
const HEIGHT_ELEMENTS = [
  /<elevationProfile\b[^>]*?(?:\/>|>[\s\S]*?<\/elevationProfile\s*>)/g,
  /<lateralProfile\b[^>]*?(?:\/>|>[\s\S]*?<\/lateralProfile\s*>)/g,
  /<height\b[^>]*?(?:\/>|>[\s\S]*?<\/height\s*>)/g,
];

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Each `<road>` of an OpenDRIVE document by id: its digest, and the digest without its height data. */
export function xodrRoadDigests(xodr: string): Map<string, RoadDigest> {
  const roads = new Map<string, RoadDigest>();
  for (const match of xodr.matchAll(ROAD_ELEMENT)) {
    const element = match[0];
    const id = ROAD_ID.exec(element)?.[2];
    if (id === undefined) throw new Error("map_xodr_road_without_id");
    if (roads.has(id)) throw new Error(`map_xodr_duplicate_road_id:${id}`);
    let plan = element;
    for (const pattern of HEIGHT_ELEMENTS) plan = plan.replace(pattern, "");
    // Whitespace between tokens is formatting, not road data.
    roads.set(id, { raw: digest(element.replace(/\s+/g, " ")), plan: digest(plan.replace(/\s+/g, " ")) });
  }
  return roads;
}

/** How each road differs between two OpenDRIVE documents, by road id. */
export function diffXodrRoads(before: string, after: string): Map<string, RoadChange> {
  const a = xodrRoadDigests(before);
  const b = xodrRoadDigests(after);
  const out = new Map<string, RoadChange>();
  for (const [id, road] of a) {
    const next = b.get(id);
    out.set(id, !next ? "removed" : next.raw === road.raw ? "none" : next.plan === road.plan ? "elevation" : "geometry");
  }
  for (const id of b.keys()) if (!a.has(id)) out.set(id, "added");
  return out;
}

/** Lane centrelines grouped by road id. */
export function roadPolylines(index: LaneGeometryIndex): Map<string, GeoLane[]> {
  const out = new Map<string, GeoLane[]>();
  for (const lane of index.lanes) {
    const lanes = out.get(lane.roadId);
    if (lanes) lanes.push(lane);
    else out.set(lane.roadId, [lane]);
  }
  return out;
}

export type Box = { minX: number; minY: number; maxX: number; maxY: number };

export function boxOf(points: readonly Point[], marginM: number): Box | null {
  if (points.length === 0) return null;
  return {
    minX: Math.min(...points.map((p) => p.x)) - marginM,
    minY: Math.min(...points.map((p) => p.y)) - marginM,
    maxX: Math.max(...points.map((p) => p.x)) + marginM,
    maxY: Math.max(...points.map((p) => p.y)) + marginM,
  };
}

export function lanesTouchBox(lanes: readonly GeoLane[], box: Box): boolean {
  return lanes.some((lane) => lane.maxX >= box.minX && lane.minX <= box.maxX && lane.maxY >= box.minY && lane.minY <= box.maxY);
}

/** A lane centreline for drawing: vertices closer than `stepM` to the last kept one dropped, centimetre precision. */
export function drawablePolyline(lane: GeoLane, stepM: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const round = (value: number) => Math.round(value * 100) / 100;
  let lastX = Infinity;
  let lastY = Infinity;
  for (let i = 0; i < lane.xs.length; i += 1) {
    const x = lane.xs[i]!;
    const y = lane.ys[i]!;
    const isLast = i === lane.xs.length - 1;
    if (!isLast && Math.hypot(x - lastX, y - lastY) < stepM) continue;
    out.push([round(x), round(y)]);
    lastX = x;
    lastY = y;
  }
  return out;
}
