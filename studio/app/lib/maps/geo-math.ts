import type {
  MapSearchIndexBbox,
  MapSearchIndexCentroid,
} from "@simforge-oss/studio-shared";
import type { GeoJSONFeature } from "@/app/lib/maps/search/geojson-props";

/** Extract the bbox from a GeoJSON geometry (recursively handles MultiPolygon). */
export function geometryBounds(geom: GeoJSONFeature["geometry"]): {
  bbox: MapSearchIndexBbox;
  centroid: MapSearchIndexCentroid;
} | null {
  if (!geom) return null;
  const coords = geom.coordinates;
  if (!coords) return null;

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let sumLng = 0;
  let sumLat = 0;
  let count = 0;

  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    // GeoJSON coordinate positions are `[lng, lat]` or `[lng, lat, alt]`
    // (RFC 7946 allows the optional altitude). Match length>=2 with two
    // leading numbers so 3D exports — including RoadRunner GeoJSONs whose
    // junction polygons carry an altitude — get treated as leaf positions
    // instead of being recursed into.
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      const lng = node[0] as number;
      const lat = node[1] as number;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
      sumLng += lng;
      sumLat += lat;
      count += 1;
      return;
    }
    // Closed rings (first position === last, standard for GeoJSON Polygon
    // rings) would double-count the shared endpoint in the centroid average,
    // biasing it toward that vertex — skip the duplicate closing position.
    const isPos = (n: unknown): n is number[] =>
      Array.isArray(n) && typeof n[0] === "number" && typeof n[1] === "number";
    let end = node.length;
    const first = node[0];
    const last = node[end - 1];
    if (
      end >= 4 &&
      isPos(first) &&
      isPos(last) &&
      first[0] === last[0] &&
      first[1] === last[1]
    ) {
      end -= 1;
    }
    for (let i = 0; i < end; i++) visit(node[i]);
  };

  visit(coords);
  if (count === 0 || !Number.isFinite(minLng)) return null;

  return {
    bbox: [minLng, minLat, maxLng, maxLat],
    centroid: [sumLng / count, sumLat / count],
  };
}

// ── Distance (flat-earth, metres) ───────────────────────────────────────────

const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

/**
 * Polygon area in square metres via shoelace, applied to the first ring of
 * a `Polygon` or `MultiPolygon`. Coordinates are converted to metres at the
 * polygon's mean latitude (flat-earth approximation, fine for junction-scale
 * polygons typically <100 m across).
 *
 * Returns `undefined` for non-polygons or empty rings. Holes (subsequent
 * rings) are not subtracted — junction polygons exported by RoadRunner are
 * single-ring solids in practice.
 */
export function geometryAreaM2(geom: GeoJSONFeature["geometry"]): number | undefined {
  if (!geom) return undefined;
  const type = geom.type;
  if (type !== "Polygon" && type !== "MultiPolygon") return undefined;

  const ring: unknown =
    type === "Polygon"
      ? (geom.coordinates as unknown[])[0]
      : ((geom.coordinates as unknown[])[0] as unknown[] | undefined)?.[0];
  if (!Array.isArray(ring) || ring.length < 3) return undefined;

  // Mean latitude of the ring (skip the closing point if duplicated).
  const points: Array<{ lng: number; lat: number }> = [];
  for (const node of ring) {
    if (
      Array.isArray(node) &&
      typeof node[0] === "number" &&
      typeof node[1] === "number"
    ) {
      points.push({ lng: node[0] as number, lat: node[1] as number });
    }
  }
  if (points.length < 3) return undefined;
  const meanLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const cosMeanLat = Math.cos(meanLat * DEG2RAD);

  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const ax = a.lng * M_PER_DEG_LAT * cosMeanLat;
    const ay = a.lat * M_PER_DEG_LAT;
    const bx = b.lng * M_PER_DEG_LAT * cosMeanLat;
    const by = b.lat * M_PER_DEG_LAT;
    sum += ax * by - bx * ay;
  }
  const area = Math.abs(sum) / 2;
  return Number.isFinite(area) && area > 0 ? area : undefined;
}

export function haversineMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * DEG2RAD);
  const dx = (b.lng - a.lng) * M_PER_DEG_LAT * cosLat;
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}
