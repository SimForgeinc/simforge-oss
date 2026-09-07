import { NextResponse } from "next/server";
import { getLatestEnrichmentJobs } from "@/app/lib/db/map-asset-enrichment-job-store";
import { getMapAssetEnrichmentManifest } from "@/app/lib/db/map-asset-enrichment-store";
import { mapAssetExistsInDb } from "@/app/lib/db/map-asset-store";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Latest job per type for a map (local finalize runs and any imported
 * third-party history) plus the enrichment manifest when a snapshot exists.
 * Clients poll this while a job is pending or running.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { mapAssetId } = await params;
  if (!mapAssetId?.trim()) {
    return NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 });
  }
  if (!(await mapAssetExistsInDb(mapAssetId))) {
    return NextResponse.json({ error: "Map asset not found" }, { status: 404 });
  }
  const [jobs, manifest] = await Promise.all([
    getLatestEnrichmentJobs(mapAssetId),
    getMapAssetEnrichmentManifest(mapAssetId),
  ]);
  return NextResponse.json(
    {
      jobs: jobs.map((job) => ({
        id: job.id,
        job_type: job.job_type,
        status: job.status,
        started_at: job.started_at,
        completed_at: job.completed_at,
        error_message: job.error_message,
        result_json: job.result_json,
      })),
      enrichment: manifest ?? null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
