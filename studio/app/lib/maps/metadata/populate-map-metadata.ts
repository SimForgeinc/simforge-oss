import type { MapAsset } from "@simforge-oss/studio-shared";
import { getMapAssetByIdFromDb, upsertMapAsset } from "@/app/lib/db/map-asset-store";
import { enqueueEnrichmentJob } from "@/app/lib/enrichment/enqueue-job";
import { computeMapMetadataBundle, mergeMapTags } from "./compute-map-metadata";
import { fetchRequiredMapArtifactTexts } from "./fetch-map-artifacts-from-s3";
import { uploadAndRegisterSignalOverlay } from "./upload-signal-overlay";
import { uploadAndRegisterLanePolygonOverlay } from "./upload-lane-polygon-overlay";

export type PopulateMapMetadataOutcome =
  | {
      status: "ok";
      mapAsset: MapAsset;
      warnings: string[];
      ingestTags: string[];
      signalFeatureCount: number;
      lanePolygonFeatureCount: number;
      enrichmentJobId: string | null;
      enrichmentJobError: string | null;
    }
  | { status: "not_found" }
  | { status: "missing_artifacts"; missing: string[] };

/**
 * Recompute map_source, map_coordinate_ref, place_context, and map_stats from
 * the asset's stored artifacts, regenerate the signal and lane-polygon
 * overlays, then start the local finalize job (detector candidates + search
 * index). This is the orchestration behind the dashboard's "Re-extract
 * Metadata" action.
 */
export async function populateMapMetadata(
  mapAssetId: string,
): Promise<PopulateMapMetadataOutcome> {
  const existing = await getMapAssetByIdFromDb(mapAssetId);
  if (!existing) return { status: "not_found" };

  const fetched = await fetchRequiredMapArtifactTexts(mapAssetId);
  if (!fetched.ok) return { status: "missing_artifacts", missing: fetched.missing };

  const bundle = computeMapMetadataBundle({ mapAssetId, ...fetched.data });
  const tags = mergeMapTags(existing.tags, bundle.ingest_tags);

  const updated: MapAsset = {
    ...existing,
    map_source: bundle.map_source,
    map_coordinate_ref: {
      ...bundle.map_coordinate_ref,
      editor_offset_m:
        existing.map_coordinate_ref?.editor_offset_m ??
        bundle.map_coordinate_ref.editor_offset_m,
    },
    place_context:
      existing.place_context?.geocoder === "manual"
        ? existing.place_context
        : // A re-run whose XODR origin couldn't be parsed yields no
          // place_context — keep the previous one instead of erasing it.
          bundle.place_context ?? existing.place_context,
    metadata_last_populated_at: bundle.map_stats.computed_at,
    map_stats: bundle.map_stats,
    tags: tags.length > 0 ? tags : undefined,
  };
  await upsertMapAsset(updated);

  // Overlay regeneration is non-critical: a failure must not block the
  // metadata recompute.
  let signalFeatureCount = 0;
  try {
    signalFeatureCount = (await uploadAndRegisterSignalOverlay(mapAssetId, bundle.signal_features)).featureCount;
  } catch (error) {
    console.warn("signal overlay upload failed (non-critical):", error);
  }
  let lanePolygonFeatureCount = 0;
  try {
    lanePolygonFeatureCount = (
      await uploadAndRegisterLanePolygonOverlay(mapAssetId, bundle.lane_polygon_features)
    ).featureCount;
  } catch (error) {
    console.warn("lane polygon overlay upload failed (non-critical):", error);
  }

  let enrichmentJobId: string | null = null;
  let enrichmentJobError: string | null = null;
  try {
    enrichmentJobId = (await enqueueEnrichmentJob({ mapAssetId, jobType: "local_finalize" })).job.id;
  } catch (error) {
    enrichmentJobError = error instanceof Error ? error.message : String(error);
  }

  return {
    status: "ok",
    mapAsset: updated,
    warnings: bundle.warnings,
    ingestTags: bundle.ingest_tags,
    signalFeatureCount,
    lanePolygonFeatureCount,
    enrichmentJobId,
    enrichmentJobError,
  };
}
