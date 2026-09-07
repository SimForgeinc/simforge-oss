import { NextRequest, NextResponse } from "next/server";
import { populateMapMetadata } from "@/app/lib/maps/metadata/populate-map-metadata";
import { requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Recompute map_source, map_coordinate_ref, and map_stats from the stored
 * artifacts, then start the local finalize job (detector candidates and the
 * search-index rebuild). Thin HTTP wrapper around `populateMapMetadata`.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  try {
    const { mapAssetId } = await params;
    if (!mapAssetId?.trim()) {
      return NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 });
    }
    const outcome = await populateMapMetadata(mapAssetId);
    if (outcome.status === "not_found") {
      return NextResponse.json({ error: "Map asset not found" }, { status: 404 });
    }
    if (outcome.status === "missing_artifacts") {
      return NextResponse.json(
        {
          error: "Missing required artifacts",
          missing: outcome.missing,
          detail: "Upload geojson, xodr, and rrdata_xml for this map before populating metadata.",
        },
        { status: 400 },
      );
    }
    return NextResponse.json({
      mapAsset: outcome.mapAsset,
      warnings: outcome.warnings,
      ingest_tags: outcome.ingestTags,
      signal_feature_count: outcome.signalFeatureCount,
      lane_polygon_feature_count: outcome.lanePolygonFeatureCount,
      // Candidate extraction + search-index run in the finalize job; their
      // counts land on that job's result.
      candidate_location_count: null,
      search_index_object_count: null,
      enrichment_job_id: outcome.enrichmentJobId,
      enrichment_job_type: outcome.enrichmentJobId ? "local_finalize" : null,
      enrichment_job_error: outcome.enrichmentJobError,
    });
  } catch (error) {
    console.error("populate-metadata error:", error);
    return NextResponse.json(
      { error: "Failed to populate metadata", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
