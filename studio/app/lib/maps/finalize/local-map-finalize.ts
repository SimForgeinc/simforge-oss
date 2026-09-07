import "server-only";

import type { EnrichmentJob } from "@simforge-oss/studio-shared";
import { enrichmentJobId } from "@/app/lib/db/ids";
import {
  getActiveEnrichmentJob,
  getEnrichmentJobById,
  insertEnrichmentJob,
  markEnrichmentJobFailed,
  markEnrichmentJobRunning,
  markEnrichmentJobSucceeded,
} from "@/app/lib/db/map-asset-enrichment-job-store";
import { getMapArtifactRevision } from "@/app/lib/db/map-asset-store";
import { extractAndStoreCandidateLocations } from "@/app/lib/maps/candidate-locations/extract-and-store";
import { computeMapMetadataBundle } from "@/app/lib/maps/metadata/compute-map-metadata";
import { fetchRequiredMapArtifactTexts } from "@/app/lib/maps/metadata/fetch-map-artifacts-from-s3";
import { extractPerJunctionInfo } from "@/app/lib/maps/metadata/xodr";
import { refreshMapSearchIndexWithTexts } from "@/app/lib/maps/search-index/refresh-search-index";

/**
 * The post-ingest map pipeline Studio runs itself.
 *
 * SimCloud performs this off-request in the `third_party_enrichment` worker:
 * detector candidate extraction, Overture themes, then a search-index rebuild.
 * Locally the two deterministic steps run in-process from the map's own
 * artifacts; the third-party pass needs the managed provider and is not part
 * of this job. Progress is recorded in `map_asset_enrichment_jobs` under the
 * `local_finalize` type so the detail page's status poll sees the same shape
 * as a managed run.
 */

export type LocalMapFinalizeResult = {
  candidate_location_count: number;
  search_index_object_count: number;
  search_index_edge_count: number;
  warnings: string[];
};

async function runLocalMapFinalize(mapAssetId: string): Promise<LocalMapFinalizeResult> {
  const fetched = await fetchRequiredMapArtifactTexts(mapAssetId);
  if (!fetched.ok) {
    throw new Error(`Missing required map artifacts: ${fetched.missing.join(", ")}`);
  }
  const bundle = computeMapMetadataBundle({ mapAssetId, ...fetched.data });
  const xodrJunctionInfo = extractPerJunctionInfo(fetched.data.xodrText);
  // Prefer the XODR-declared PROJ string; fall back to a vanilla TMerc from
  // the origin when only origin_lat/lon is known — identical to the managed
  // extract endpoint.
  const coordTransform = {
    originLat: bundle.map_coordinate_ref.origin_lat ?? 0,
    originLon: bundle.map_coordinate_ref.origin_lon ?? 0,
    ...(bundle.map_coordinate_ref.proj_string
      ? { projString: bundle.map_coordinate_ref.proj_string }
      : {}),
  };
  const candidates = await extractAndStoreCandidateLocations({
    mapAssetId,
    geojsonText: fetched.data.geojsonText,
    xodrText: fetched.data.xodrText,
    coordTransform,
    xodrJunctionInfo,
  });
  const [geojsonArtifact, xodrArtifact, rrdataArtifact] = await Promise.all([
    getMapArtifactRevision(mapAssetId, "geojson"),
    getMapArtifactRevision(mapAssetId, "xodr"),
    getMapArtifactRevision(mapAssetId, "rrdata_xml"),
  ]);
  const searchIndex = await refreshMapSearchIndexWithTexts({
    mapAssetId,
    geojsonText: fetched.data.geojsonText,
    xodrText: fetched.data.xodrText,
    rrdataXmlText: fetched.data.rrdataXmlText,
    geojsonSha256: geojsonArtifact?.sha256 ?? null,
    xodrSha256: xodrArtifact?.sha256 ?? null,
    rrdataSha256: rrdataArtifact?.sha256 ?? null,
  });
  return {
    candidate_location_count: candidates.count,
    search_index_object_count: searchIndex.object_count,
    search_index_edge_count: searchIndex.edge_count,
    warnings: [...bundle.warnings, ...candidates.warnings],
  };
}

/**
 * Record and start a finalize run for a map. Returns the job row immediately;
 * the pipeline continues in the background and closes the row when done. A
 * second request while one is active returns the active job instead of
 * starting another.
 */
export async function enqueueLocalMapFinalize(input: {
  mapAssetId: string;
  requestedBy?: string | null;
}): Promise<{ job: EnrichmentJob; reused: boolean }> {
  const active = await getActiveEnrichmentJob(input.mapAssetId, "local_finalize");
  if (active) return { job: active, reused: true };
  const id = enrichmentJobId();
  const inserted = await insertEnrichmentJob({
    id,
    mapAssetId: input.mapAssetId,
    jobType: "local_finalize",
    requestedBy: input.requestedBy ?? null,
  });
  if (!inserted) {
    const raced = await getActiveEnrichmentJob(input.mapAssetId, "local_finalize");
    if (raced) return { job: raced, reused: true };
    throw new Error("Map finalize job could not be recorded.");
  }
  const job = await getEnrichmentJobById(id);
  if (!job) throw new Error("Map finalize job could not be read back.");

  // The active-job unique index is the dedupe boundary; the run detaches here
  // and closes its own row, so callers never await pipeline time.
  void (async () => {
    await markEnrichmentJobRunning(id);
    try {
      const result = await runLocalMapFinalize(input.mapAssetId);
      await markEnrichmentJobSucceeded(id, result);
    } catch (error) {
      await markEnrichmentJobFailed(id, error instanceof Error ? error.message : String(error));
    }
  })();
  return { job, reused: false };
}
