import "server-only";

import type { EnrichmentJob, EnrichmentJobType } from "@simforge-oss/studio-shared";
import { enqueueLocalMapFinalize } from "@/app/lib/maps/finalize/local-map-finalize";

export interface EnqueueEnrichmentJobInput {
  mapAssetId: string;
  jobType: EnrichmentJobType;
  providerRelease?: string;
  requestedBy?: string;
}

export interface EnqueueEnrichmentJobResult {
  job: EnrichmentJob;
  reused: boolean;
}

export const THIRD_PARTY_ENRICHMENT_UNAVAILABLE_MESSAGE =
  "Third-party (Overture) map enrichment runs on SimCloud's managed workers and is not available in local Studio.";

/**
 * Start a map enrichment job.
 *
 * `local_finalize` runs Studio's own post-ingest pipeline in-process.
 * `third_party_enrichment` needs the managed Overture provider; it is refused
 * rather than recorded as a job that could never complete.
 */
export async function enqueueEnrichmentJob(
  input: EnqueueEnrichmentJobInput,
): Promise<EnqueueEnrichmentJobResult> {
  if (input.jobType === "local_finalize") {
    return enqueueLocalMapFinalize({
      mapAssetId: input.mapAssetId,
      requestedBy: input.requestedBy ?? null,
    });
  }
  throw new Error(THIRD_PARTY_ENRICHMENT_UNAVAILABLE_MESSAGE);
}
