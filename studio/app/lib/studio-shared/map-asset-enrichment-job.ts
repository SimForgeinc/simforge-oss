import { z } from "zod";

/**
 * Enrichment operations Studio records per map asset.
 *
 * `local_finalize` is the post-ingest pipeline Studio runs itself: detector
 * candidate extraction plus the `search_index.json` rebuild. Third-party
 * (Overture) enrichment needs the managed provider and is never queued locally.
 */
export const EnrichmentJobTypeSchema = z.enum(["third_party_enrichment", "local_finalize"]);
export type EnrichmentJobType = z.infer<typeof EnrichmentJobTypeSchema>;

export const EnrichmentJobStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timeout",
]);
export type EnrichmentJobStatus = z.infer<typeof EnrichmentJobStatusSchema>;

/** Storage- and identity-neutral status for a local enrichment operation. */
export const EnrichmentJobSchema = z.object({
  id: z.string(),
  map_asset_id: z.string(),
  job_type: EnrichmentJobTypeSchema,
  status: EnrichmentJobStatusSchema,
  provider_release: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
  attempt_count: z.number().int(),
  result_json: z.record(z.unknown()).nullable(),
});
export type EnrichmentJob = z.infer<typeof EnrichmentJobSchema>;
