/**
 * Parking-lot speed-limit constraint.
 *
 * The Overture attribution in `street-facts.ts` resolves a street's name to the
 * nearest named Overture road segment and inherits its posted limit. Inside a
 * parking lot this bleeds a neighbouring arterial/freeway limit onto a drive
 * aisle: in San Ramon P1, 55 lot-aisle streets whose lanes lie fully inside a
 * curated parking-lot polygon were named "Donald D Doyle Highway" and tagged
 * 65 mph — while the aisles' own XODR speed is only 35–40 mph. The XODR value is
 * no rescue either: RoadRunner stamps a blanket ~40 mph on every road, lot
 * aisles included, so neither third-party source yields a trustworthy
 * parking-lot limit.
 *
 * Fix: a driving lane whose geometry lies (almost) entirely inside a parking-lot
 * polygon is a lot aisle; clamp its posted limit to a low, locale-appropriate
 * default (US parking lots post ~15 mph). A genuinely-authored XODR limit BELOW
 * that default is honoured. A through-road that merely clips a large office-park
 * lot (its lanes only partly inside) is left untouched — that is why the test is
 * a lane-length containment FRACTION, not a centroid-in-polygon check, which
 * over-catches arterials running alongside the lot (Bollinger Canyon Rd / Bishop
 * Dr both have mainline segments whose centroids fall inside the Bishop Ranch
 * lot footprints).
 */
import { bboxFromCoords, pointInBbox, pointInPolygon, type CandidateLocation, type PolygonRings } from "@simforge-oss/studio-shared";
import { type Bbox } from "@simforge-oss/scenario/contracts";

/**
 * A driving lane whose combined geometry sits at least this fraction inside
 * parking-lot polygons is treated as a lot aisle. 0.9 cleanly separates San
 * Ramon P1 lot aisles (fully enclosed) from arterials that graze a lot edge.
 */
export const PARKING_LOT_LANE_CONTAINMENT_THRESHOLD = 0.9;

/** Only standalone off-street lots gate the constraint (matches the curated
 *  `parking_lot` polygons used by the scenario site-search). `parking_cluster`
 *  and `street_parking` are curb-side and run along real roads, so they are
 *  deliberately excluded to avoid down-clamping through traffic. */
const PARKING_LOT_CANDIDATE_KINDS: ReadonlySet<string> = new Set(["parking_lot"]);

/** Locale-appropriate default posted limit for a parking-lot drive aisle, in
 *  mph. Keyed by ISO 3166-1 alpha-2 country code. US business-park lots post
 *  ~15 mph. Extend as other locales need tuning; the fallback stays low so a
 *  freeway limit can never survive on a lot aisle. */
const PARKING_LOT_DEFAULT_SPEED_MPH_BY_COUNTRY: Readonly<Record<string, number>> = {
  US: 15,
};

const FALLBACK_PARKING_LOT_SPEED_MPH = 15;

/** Default parking-lot posted limit (mph) for a country code. */
export function parkingLotDefaultSpeedMph(countryCode?: string | null): number {
  const code = countryCode?.trim().toUpperCase();
  if (code && code in PARKING_LOT_DEFAULT_SPEED_MPH_BY_COUNTRY) {
    return PARKING_LOT_DEFAULT_SPEED_MPH_BY_COUNTRY[code]!;
  }
  return FALLBACK_PARKING_LOT_SPEED_MPH;
}

/**
 * Speed limit (mph) to post on a parking-lot drive aisle.
 *
 * Prefer a genuinely-authored XODR limit, but only when it is already at or
 * below the locale parking default — a blanket ~40 mph arterial default stamped
 * on a lot aisle is not a real parking-lot limit, so it never survives. When
 * there is no such low XODR value we fall back to the locale default.
 */
export function constrainParkingLotSpeedMph(
  xodrSpeedMph: number | undefined,
  countryCode?: string | null,
): number {
  const cap = parkingLotDefaultSpeedMph(countryCode);
  if (
    typeof xodrSpeedMph === "number" &&
    Number.isFinite(xodrSpeedMph) &&
    xodrSpeedMph > 0 &&
    xodrSpeedMph < cap
  ) {
    return Math.round(xodrSpeedMph);
  }
  return cap;
}

export interface ParkingLotPolygon {
  rings: PolygonRings;
  bbox: Bbox;
}

/** Extract curated parking-lot polygons (outer ring + prefilter bbox) from the
 *  candidate set. Pre-enrichment maps carry no `parking_lot` candidates, so this
 *  returns `[]` and the whole constraint becomes a no-op. */
export function parkingLotPolygonsFromCandidates(
  candidates: readonly CandidateLocation[],
): ParkingLotPolygon[] {
  const lots: ParkingLotPolygon[] = [];
  for (const c of candidates) {
    if (!PARKING_LOT_CANDIDATE_KINDS.has(c.kind)) continue;
    if (c.region.type !== "Polygon") continue;
    const rings = c.region.coordinates as PolygonRings;
    const outer = rings[0];
    if (!outer || outer.length < 3) continue;
    lots.push({ rings, bbox: bboxFromCoords(outer) });
  }
  return lots;
}

/** An ordered driving-lane polyline as `[lng, lat]` vertices. */
export type LanePolyline = ReadonlyArray<readonly [number, number]>;

/** Pull lane polyline(s) out of a GeoJSON geometry (LineString / MultiLineString).
 *  Anything else yields no lines. Duck-typed so callers can pass raw features. */
export function laneCoordsFromGeometry(geometry: unknown): LanePolyline[] {
  if (!geometry || typeof geometry !== "object") return [];
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type === "LineString" && Array.isArray(g.coordinates)) {
    return [g.coordinates as LanePolyline];
  }
  if (g.type === "MultiLineString" && Array.isArray(g.coordinates)) {
    return (g.coordinates as unknown[]).filter(Array.isArray) as LanePolyline[];
  }
  return [];
}

/** Approximate metres between two [lng, lat] points (equirectangular — exact
 *  enough for a within-lot length ratio). */
function approxSegmentMeters(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const latMidRad = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (b[0] - a[0]) * 111_320 * Math.cos(latMidRad);
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}

function pointInAnyParkingLot(
  lng: number,
  lat: number,
  lots: readonly ParkingLotPolygon[],
): boolean {
  for (const lot of lots) {
    if (!pointInBbox(lng, lat, lot.bbox)) continue;
    if (pointInPolygon(lng, lat, lot.rings)) return true;
  }
  return false;
}

/**
 * Fraction (0..1) of the combined lane length whose per-segment midpoints fall
 * inside any parking-lot polygon. 1 = fully inside a lot, 0 = fully outside; a
 * lane straddling a boundary contributes proportionally.
 */
export function laneLengthFractionInsideParkingLots(
  lanes: readonly LanePolyline[],
  lots: readonly ParkingLotPolygon[],
): number {
  if (lots.length === 0) return 0;
  let insideLen = 0;
  let totalLen = 0;
  for (const lane of lanes) {
    for (let i = 1; i < lane.length; i++) {
      const a = lane[i - 1]!;
      const b = lane[i]!;
      const segLen = approxSegmentMeters(a, b);
      if (segLen <= 0) continue;
      totalLen += segLen;
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      if (pointInAnyParkingLot(mx, my, lots)) insideLen += segLen;
    }
  }
  if (totalLen <= 0) return 0;
  return insideLen / totalLen;
}

/** True when a street's driving lanes lie (almost) entirely inside a parking
 *  lot — i.e. it is a lot drive aisle rather than a through-road. */
export function isParkingLotAisle(
  lanes: readonly LanePolyline[],
  lots: readonly ParkingLotPolygon[],
): boolean {
  if (lots.length === 0 || lanes.length === 0) return false;
  return (
    laneLengthFractionInsideParkingLots(lanes, lots) >=
    PARKING_LOT_LANE_CONTAINMENT_THRESHOLD
  );
}
