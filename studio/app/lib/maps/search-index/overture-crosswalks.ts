/**
 * Synthesize `crosswalk_zone` CandidateLocations from an enrichment snapshot's
 * Overture crosswalks layer, deduped against the in-house crosswalk_zone
 * candidates that come from RoadRunner GeoJSON / detector output.
 *
 * Per-junction aggregation: when multiple Overture crosswalks fall within
 * `junctionProximityM` (default 50 m) of the same XODR junction centroid,
 * they collapse into a single `crosswalk_zone` candidate anchored to that
 * junction. Mid-block crosswalks (no nearby junction) emit one candidate
 * per feature. This mirrors the user expectation that "this intersection
 * has crosswalks" is a single result, not 4–8 duplicates.
 *
 * Confidence is intentionally lower than the detector-sourced in-house path
 * because Overture data is third-party and unverified — junction-aggregated
 * candidates land at 0.55, midblock at 0.5.
 *
 * Why this lives here, not in the Lambda: dedupe needs both sources visible.
 * The Lambda has only Overture; the corpus builder is the first place that
 * sees the in-house GeoJSON Crosswalk features (via `crosswalk_zone`
 * candidates from the detector pipeline) AND the Overture overlay payload
 * pulled from `map_asset_enrichments`. So the corpus refresh path is where
 * the merge happens — Overture fills the gap on the 5/7 maps that have zero
 * in-house crosswalks,
 * and steps aside whenever in-house data already covers the same intersection.
 */

import type {
  CandidateLocation,
  MapOverlayLayer,
} from "@simforge-oss/studio-shared";

const DEFAULT_DEDUPE_THRESHOLD_M = 15;
const DEFAULT_JUNCTION_PROXIMITY_M = 50;
const OVERTURE_JUNCTION_CONFIDENCE = 0.55;
const OVERTURE_MIDBLOCK_CONFIDENCE = 0.5;
const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

function haversineMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * DEG2RAD);
  const dx = (b.lng - a.lng) * M_PER_DEG_LAT * cosLat;
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

interface OverlayFeature {
  id?: string | number;
  properties?: {
    bbox?: { min_lng: number; min_lat: number; max_lng: number; max_lat: number };
    name?: string | null;
  };
  geometry?: { coordinates?: unknown };
}

function featureCenter(feature: OverlayFeature): { lat: number; lng: number } | null {
  const bbox = feature.properties?.bbox;
  if (
    bbox &&
    Number.isFinite(bbox.min_lng) &&
    Number.isFinite(bbox.min_lat) &&
    Number.isFinite(bbox.max_lng) &&
    Number.isFinite(bbox.max_lat)
  ) {
    return {
      lng: (bbox.min_lng + bbox.max_lng) / 2,
      lat: (bbox.min_lat + bbox.max_lat) / 2,
    };
  }
  // Fall back to the first coordinate pair on the geometry — covers Point /
  // LineString. Polygon's first ring's first vertex is also reasonable since
  // crosswalk geometries are short.
  const coords = feature.geometry?.coordinates as unknown;
  const visit = (node: unknown): { lat: number; lng: number } | null => {
    if (!Array.isArray(node)) return null;
    if (
      node.length >= 2 &&
      typeof node[0] === "number" &&
      typeof node[1] === "number"
    ) {
      return { lng: node[0] as number, lat: node[1] as number };
    }
    for (const child of node) {
      const r = visit(child);
      if (r) return r;
    }
    return null;
  };
  return visit(coords);
}

export interface JunctionAnchor {
  /** Stable id used to namespace the aggregated candidate's id. */
  junctionId: string;
  center: { lat: number; lng: number };
}

export interface BuildOvertureCrosswalkCandidatesOptions {
  /** Centers within this radius of an in-house crosswalk_zone are considered duplicates. */
  dedupeThresholdM?: number;
  /** Overture crosswalks within this radius of a junction centroid roll up into one candidate. */
  junctionProximityM?: number;
}

/**
 * Build `crosswalk_zone` candidates from the Overture crosswalks overlay
 * layer.
 *
 * Pipeline per feature:
 *   1. Drop if within `dedupeThresholdM` (default 15 m) of an in-house
 *      `crosswalk_zone` candidate — in-house data is authoritative.
 *   2. Find the nearest junction within `junctionProximityM` (default 50 m).
 *      All Overture crosswalks at the same junction collapse into one
 *      aggregated candidate (anchored at the junction center).
 *   3. Mid-block crosswalks (no nearby junction) emit per-feature.
 *
 * Returns an empty array when the snapshot has no `crosswalks` overlay layer
 * (pre-widening enrichment) or the layer is empty.
 */
export function buildOvertureCrosswalkCandidates(
  mapAssetId: string,
  overlayLayer: MapOverlayLayer | undefined,
  inHouseCandidates: readonly CandidateLocation[],
  junctions: readonly JunctionAnchor[] = [],
  options: BuildOvertureCrosswalkCandidatesOptions = {},
): CandidateLocation[] {
  if (!overlayLayer || overlayLayer.layer_id !== "crosswalks") return [];
  const features = (overlayLayer.data?.features ?? []) as OverlayFeature[];
  if (features.length === 0) return [];

  const dedupeThreshold = options.dedupeThresholdM ?? DEFAULT_DEDUPE_THRESHOLD_M;
  const junctionRadius = options.junctionProximityM ?? DEFAULT_JUNCTION_PROXIMITY_M;
  const inHouseCenters = inHouseCandidates
    .filter((c) => c.kind === "crosswalk_zone")
    .map((c) => c.center);

  // Bucket survivors by either junctionId (aggregated) or feature index (midblock).
  interface SurvivingFeature {
    feature: OverlayFeature;
    featureIndex: number;
    center: { lat: number; lng: number };
  }
  const byJunction = new Map<string, { junction: JunctionAnchor; features: SurvivingFeature[] }>();
  const midblock: SurvivingFeature[] = [];

  for (let i = 0; i < features.length; i++) {
    const feature = features[i]!;
    const center = featureCenter(feature);
    if (!center) continue;

    // Dedupe against in-house first.
    if (inHouseCenters.some((c) => haversineMetres(c, center) < dedupeThreshold)) {
      continue;
    }

    // Find the nearest junction within junctionRadius.
    let bestJunction: JunctionAnchor | undefined;
    let bestDistance = Infinity;
    for (const j of junctions) {
      const d = haversineMetres(j.center, center);
      if (d <= junctionRadius && d < bestDistance) {
        bestDistance = d;
        bestJunction = j;
      }
    }

    if (bestJunction) {
      const existing = byJunction.get(bestJunction.junctionId);
      if (existing) {
        existing.features.push({ feature, featureIndex: i, center });
      } else {
        byJunction.set(bestJunction.junctionId, {
          junction: bestJunction,
          features: [{ feature, featureIndex: i, center }],
        });
      }
    } else {
      midblock.push({ feature, featureIndex: i, center });
    }
  }

  const out: CandidateLocation[] = [];

  // Junction-aggregated candidates — one per junction with at least one Overture crosswalk.
  for (const [junctionId, group] of byJunction) {
    const sourceFeatureIds = group.features.map((f) =>
      typeof f.feature.id === "string" || typeof f.feature.id === "number"
        ? String(f.feature.id)
        : `idx-${f.featureIndex}`,
    );
    const count = group.features.length;
    out.push({
      id: `overture-crosswalk-${mapAssetId}-junction-${junctionId}`,
      map_asset_id: mapAssetId,
      kind: "crosswalk_zone",
      source: "overture_crosswalk",
      label:
        count === 1
          ? "Overture crosswalk near intersection"
          : `Overture crosswalks at intersection (${count})`,
      reason:
        "Crosswalk segment(s) from Overture aggregated to the nearest XODR junction. Third-party data, unverified — confidence is reduced relative to in-house detector results.",
      confidence: OVERTURE_JUNCTION_CONFIDENCE,
      tags: ["CROSSWALK", "OVERTURE"],
      evidence: [],
      region: {
        type: "Point",
        coordinates: [group.junction.center.lng, group.junction.center.lat],
      },
      center: group.junction.center,
      explanation: `Aggregated from ${count} Overture crosswalk segment${count === 1 ? "" : "s"} (${sourceFeatureIds.join(", ")}).`,
    });
  }

  // Mid-block candidates — one per feature, no nearby junction to anchor to.
  for (const m of midblock) {
    const featureId =
      typeof m.feature.id === "string" || typeof m.feature.id === "number"
        ? String(m.feature.id)
        : `idx-${m.featureIndex}`;
    const bbox = m.feature.properties?.bbox;
    const region: CandidateLocation["region"] = bbox
      ? { type: "BBOX", bbox }
      : { type: "Point", coordinates: [m.center.lng, m.center.lat] };
    const label =
      typeof m.feature.properties?.name === "string" && m.feature.properties.name.length > 0
        ? m.feature.properties.name
        : "Overture mid-block crosswalk";
    out.push({
      id: `overture-crosswalk-${mapAssetId}-midblock-${featureId}`,
      map_asset_id: mapAssetId,
      kind: "crosswalk_zone",
      source: "overture_crosswalk",
      label,
      reason:
        "Mid-block crosswalk from Overture transportation theme — no nearby XODR junction to anchor against.",
      confidence: OVERTURE_MIDBLOCK_CONFIDENCE,
      tags: ["CROSSWALK", "OVERTURE", "MIDBLOCK"],
      evidence: [],
      region,
      center: m.center,
    });
  }

  return out;
}
