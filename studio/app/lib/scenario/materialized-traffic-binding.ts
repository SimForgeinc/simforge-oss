/**
 * How materialized-traffic bytes are bound to a document.
 *
 * Artifacts are content-addressed: identical traffic from two documents (or
 * two drafts of one) is one `simforge.artifacts` row. The binding of those
 * bytes to a document is therefore NOT a property of the row; it is the
 * reservation's producer job (`artifact_postprocess_jobs`, kind
 * `materialize_traffic`), one per (document, draft version, bytes).
 *
 * A leaf module so `document-store` and `materialized-traffic-store` can both
 * read it without importing each other.
 */

/** One reservation = one producer job per (document, draft version, bytes). */
export function reservationIdempotencyKey(documentId: string, draftVersion: number, sha256: string) {
  return `materialized-traffic:${documentId}:${draftVersion}:${sha256}`;
}

/**
 * SQL predicate: job `j` is a reservation of `:document_id` for `:sha256` that
 * claimed `:source_input_digest` on `:map_asset_id`/`:map_version_id`. Matches
 * jobs written before `request_payload.sha256` existed through their
 * idempotency key, which has always been `reservationIdempotencyKey`.
 */
export const MATERIALIZED_TRAFFIC_RESERVATION_SQL = `(
  j.postprocess_kind = 'materialize_traffic'
  AND j.request_payload->>'documentId' = :document_id
  AND j.idempotency_key = 'materialized-traffic:' || :document_id || ':'
      || (j.request_payload->>'draftVersion') || ':' || :sha256
  AND j.request_payload->>'sourceInputDigest' = :source_input_digest
  AND j.request_payload->>'mapVersionId' = :map_version_id
  AND COALESCE(j.request_payload->>'mapAssetId', :map_asset_id) = :map_asset_id
)`;

