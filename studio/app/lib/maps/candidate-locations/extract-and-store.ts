import type { CandidateLocation, CandidateLocationSource, XodrJunctionMatchInfo, CoordTransform } from "@simforge-oss/studio-shared";
import {
  buildMapSceneGraph,
  generateCandidates,
  runMetadataPhaseOcclusion,
} from "@simforge-oss/studio-shared";
import { candidateLocationRowId } from "@/app/lib/db/ids";
import { upsertCandidateLocations } from "@/app/lib/db/map-candidate-location-store";

/** Sources written by the detector pipeline. Only these are cleared on re-extraction;
 *  Overture/manual candidates are preserved. */
const DETECTOR_SOURCES: CandidateLocationSource[] = [
  "detector_intersection",
  "detector_crosswalk",
  "detector_parking",
  "detector_road",
  "detector_turn",
  // Metadata-phase occlusion detectors (curve / crest / parking-near-conflict).
  // The narrow-corridor / commercial-delivery / bus-stop occlusion sources are
  // owned by the enrichment Lambda and are NOT in this list — they would be
  // wiped here otherwise.
  "detector_occlusion_curve",
  "detector_occlusion_crest",
  "detector_occlusion_parking_conflict",
  // Legacy sources that the old extractors wrote — safe to replace
  "geojson_junction",
  "geojson_street_parking",
];

type ExtractAndStoreOptions = {
  mapAssetId: string;
  geojsonText: string;
  xodrText: string;
  coordTransform: CoordTransform;
  /** Per-junction XODR data for road-degree-based filtering and signalization detection. */
  xodrJunctionInfo?: XodrJunctionMatchInfo[];
};

type ExtractAndStoreResult = {
  count: number;
  warnings: string[];
};

/**
 * Extract candidate locations from map artifact texts using the map intelligence
 * pipeline (scene graph → detectors → candidate engine) and persist them.
 *
 * Called from the `complete` endpoint after metadata computation succeeds.
 */
export async function extractAndStoreCandidateLocations(
  opts: ExtractAndStoreOptions,
): Promise<ExtractAndStoreResult> {
  const { mapAssetId, geojsonText, xodrText, coordTransform, xodrJunctionInfo } = opts;
  const warnings: string[] = [];

  try {
    // Build scene graph from raw map files
    const { sceneGraph, warnings: sgWarnings } = buildMapSceneGraph({
      mapAssetId,
      geojsonText,
      xodrText,
      coordTransform,
      xodrJunctionInfo,
    });
    warnings.push(...sgWarnings);

    // Run detectors and generate ranked candidate locations
    const candidates = generateCandidates(sceneGraph);

    // Layer in metadata-phase occlusion candidates (curve / crest /
    // parking-near-conflict). These keep their own `source` so a re-run
    // delete-and-replaces only its own subtype, leaving siblings untouched.
    let occlusionCandidates: CandidateLocation[] = [];
    try {
      occlusionCandidates = runMetadataPhaseOcclusion({
        mapAssetId,
        xodrText,
        coordTransform,
        sceneGraph,
      });
    } catch (e) {
      warnings.push(
        `occlusion detectors failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    candidates.push(...occlusionCandidates);

    if (candidates.length === 0) {
      // Still clear old detector/legacy sources even when no new candidates are produced
      for (const src of DETECTOR_SOURCES) {
        await upsertCandidateLocations(mapAssetId, src, []);
      }
      return { count: 0, warnings };
    }

    // Group by source for per-source upsert (preserves Overture/manual candidates)
    const bySource = new Map<CandidateLocationSource, CandidateLocation[]>();
    for (const c of candidates) {
      if (!bySource.has(c.source)) bySource.set(c.source, []);
      bySource.get(c.source)!.push(c);
    }

    let totalCount = 0;
    for (const [source, locs] of bySource) {
      const withIds = locs.map((loc, i) => ({
        ...loc,
        id: candidateLocationRowId(mapAssetId, source, i),
        map_asset_id: mapAssetId,
      }));
      await upsertCandidateLocations(mapAssetId, source, withIds);
      totalCount += withIds.length;
    }

    // Clear detector/legacy sources that didn't produce any new candidates
    for (const src of DETECTOR_SOURCES) {
      if (!bySource.has(src)) {
        await upsertCandidateLocations(mapAssetId, src, []);
      }
    }

    return { count: totalCount, warnings };
  } catch (e) {
    warnings.push(`map-intelligence pipeline failed: ${e instanceof Error ? e.message : String(e)}`);
    return { count: 0, warnings };
  }
}
