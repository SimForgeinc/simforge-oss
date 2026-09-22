import type { AppContext } from "@/app/lib/db/app-context";
import { resolveScenarioMap } from "@simforge-oss/studio-host";
import { listScenarioMapDescriptors } from "./document-store";
import { queryRows, withTransaction } from "@/app/lib/db/data-api";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedPutUrl,
  headS3Object,
} from "@/app/lib/s3/s3-presign";
import type { ScenarioMaterializedTrafficReference } from "./contracts";
import { scenarioId } from "./core";
import {
  createLocalArtifactProducer,
  finalizeLocalArtifactProducer,
} from "./jobs/local-artifact-producer-store";
import { lockScenarioJob, type JobTransaction } from "./jobs/lifecycle-lock";
import {
  MATERIALIZED_TRAFFIC_RESERVATION_SQL,
  reservationIdempotencyKey,
} from "./materialized-traffic-binding";
import { simforgeEnv } from "@/lib/simforge-env";
/** Stored media type of every materialized-traffic artifact; artifact metadata and canonical digests bind to it. */
const MATERIALIZED_TRAFFIC_MEDIA_TYPE = "application/vnd.uniscenarios.materialized-traffic+json";


function artifactBucket() { return simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts"; }

export async function reserveMaterializedTraffic(
  context: AppContext,
  documentId: string,
  input: Omit<ScenarioMaterializedTrafficReference, "artifactId"> & {
    expectedVersion: number;
  },
) {
  const documents = await queryRows<{
    workspace_id: string;
    draft_version: number;
    map_version_id: string | null;
    source_map_asset_id: string | null;
    xodr_sha256: string | null;
  }>(
    `SELECT d.workspace_id, dr.draft_version, dr.map_version_id, mv.source_map_asset_id, mv.xodr_sha256
     FROM simforge.documents d JOIN simforge.drafts dr
       ON dr.document_id = d.id AND dr.workspace_id = d.workspace_id
     JOIN simforge.map_versions mv ON mv.id = dr.map_version_id
     WHERE d.id = :document_id AND d.workspace_id = :workspace_id AND d.deleted_at IS NULL LIMIT 1`,
    { document_id: documentId, workspace_id: context.workspaceId },
  );
  const document = documents[0];
  if (
    !document ||
    Number(document.draft_version) !== input.expectedVersion ||
    document.source_map_asset_id !== input.mapAssetId
  )
    return null;
  const map = resolveScenarioMap({
    mapVersionId: document.map_version_id,
    mapSourceMapId: document.source_map_asset_id,
    mapXodrSha256: document.xodr_sha256,
  }, await listScenarioMapDescriptors(context));
  if (map.mapVersionId !== input.mapVersionId) return null;
  return reserveMaterializedTrafficBytes(context, documentId, input);
}

/**
 * The storage half of a reservation, after the document, draft version and map
 * binding have been checked. Exported for the store's database tests.
 */
export async function reserveMaterializedTrafficBytes(
  context: Pick<AppContext, "workspaceId" | "userId">,
  documentId: string,
  input: Omit<ScenarioMaterializedTrafficReference, "artifactId"> & { expectedVersion: number },
) {
  const bucket = artifactBucket();
  const key = `${context.workspaceId}/materialized-traffic/sha256/${input.sha256}.json`;
  const requestPayload = {
    documentId,
    draftVersion: input.expectedVersion,
    sourceInputDigest: input.sourceInputDigest,
    mapAssetId: input.mapAssetId,
    mapVersionId: input.mapVersionId,
    sha256: input.sha256,
  };
  const idempotencyKey = reservationIdempotencyKey(documentId, input.expectedVersion, input.sha256);

  // Deduplicated bytes: another reservation (this document at an earlier draft,
  // or another document with identical traffic) already published them. There
  // is nothing to produce, so no job may be left `running`, and the shared
  // blob's metadata is not this reservation's to rewrite. The reservation is
  // recorded as an already-succeeded producer job for THIS document, which is
  // what binds the bytes to the document (`createScenarioRevision`).
  const [available] = await queryRows<{ id: string; storage_bucket: string; storage_key: string }>(
    `SELECT id, storage_bucket, storage_key FROM simforge.artifacts
      WHERE workspace_id = :workspace_id AND artifact_kind = 'materialized-traffic'
        AND sha256 = :sha256 AND byte_length = :size_bytes
        AND artifact_state = 'available' AND deleted_at IS NULL
      LIMIT 1`,
    { workspace_id: context.workspaceId, sha256: input.sha256, size_bytes: input.sizeBytes },
  );
  if (available) {
    await createLocalArtifactProducer({
      workspaceId: context.workspaceId,
      requestedByUserId: context.userId,
      operation: "materialize_traffic",
      artifactKind: "materialized-traffic",
      artifactSha256: input.sha256,
      idempotencyKey,
      requestPayload,
      completed: true,
    });
    // A job this document opened earlier for the same bytes (before they were
    // published by someone else) is closed too.
    await withTransaction((tx) => closeReservationJobs(tx, {
      workspaceId: context.workspaceId,
      documentId,
      artifactId: available.id,
      sha256: input.sha256,
    }));
    return {
      artifactId: available.id,
      uploadRequired: false,
      uploadUrl: null,
      headers: checksumBoundPutRequiredHeaders(MATERIALIZED_TRAFFIC_MEDIA_TYPE, input.sha256),
    };
  }

  const artifactId = scenarioId("usart");
  const producerJobId = await createLocalArtifactProducer({
    workspaceId: context.workspaceId,
    requestedByUserId: context.userId,
    operation: "materialize_traffic",
    artifactKind: "materialized-traffic",
    artifactSha256: input.sha256,
    idempotencyKey,
    requestPayload,
  });
  const rows = await queryRows<{
    id: string;
    artifact_state: string;
    storage_bucket: string;
    storage_key: string;
  }>(
    // The conflict target is (workspace_id, sha256, artifact_kind): content, not
    // document, so two reservations of identical bytes share one row. Which
    // DOCUMENT a reservation belongs to lives on its producer job
    // (`request_payload.documentId`), never in the shared row's metadata:
    // rewriting `metadata.documentId` on conflict re-bound a blob another
    // document had already committed to, and that document's next revision
    // was refused as `traffic_binding_invalid`. Only the producer fields move,
    // and only while the row is still `pending`
    // (`uniscenario_artifacts_finalized_provenance_immutable` freezes them
    // after), so finalization runs through a live job. `artifact_state` is
    // deliberately not reset: uploaded bytes stay uploaded.
    `INSERT INTO simforge.artifacts (
       id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
       sha256, byte_length, artifact_state, metadata,
       producer_job_family, producer_job_id, provenance
     ) VALUES (
       :id, :workspace_id, 'materialized-traffic', :media_type, :bucket, :storage_key,
       :sha256, :size_bytes, 'pending', CAST(:metadata AS jsonb),
       'artifact_postprocess', :producer_job_id, CAST(:provenance AS jsonb)
     ) ON CONFLICT (workspace_id, sha256, artifact_kind)
     WHERE artifact_state IN ('pending', 'available') AND deleted_at IS NULL
     DO UPDATE SET
       producer_job_id = CASE WHEN simforge.artifacts.artifact_state = 'pending'
         THEN EXCLUDED.producer_job_id ELSE simforge.artifacts.producer_job_id END,
       provenance = CASE WHEN simforge.artifacts.artifact_state = 'pending'
         THEN EXCLUDED.provenance ELSE simforge.artifacts.provenance END
     RETURNING id, artifact_state, storage_bucket, storage_key`,
    {
      id: artifactId,
      workspace_id: context.workspaceId,
      media_type: MATERIALIZED_TRAFFIC_MEDIA_TYPE,
      bucket,
      storage_key: key,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      metadata: {
        // The first reservation's facts; informational only. Binding and
        // completion read the reservation's producer job instead.
        documentId,
        expectedVersion: input.expectedVersion,
        sourceInputDigest: input.sourceInputDigest,
        mapAssetId: input.mapAssetId,
        mapVersionId: input.mapVersionId,
      },
      producer_job_id: producerJobId,
      provenance: {
        contract: "uniscenario.artifact-provenance/v1",
        producerJobFamily: "artifact_postprocess",
        producerJobId,
        operation: "materialize_traffic",
        documentId,
        draftVersion: input.expectedVersion,
        sourceInputDigest: input.sourceInputDigest,
      },
    },
  );
  const row = rows[0];
  if (!row) throw new Error("materialized_traffic_reservation_failed");
  return {
    artifactId: row.id,
    uploadRequired: row.artifact_state !== "available",
    uploadUrl:
      row.artifact_state === "available"
        ? null
        : await getPresignedPutUrl(row.storage_key, MATERIALIZED_TRAFFIC_MEDIA_TYPE, row.storage_bucket, 900, input.sha256),
    headers: checksumBoundPutRequiredHeaders(MATERIALIZED_TRAFFIC_MEDIA_TYPE, input.sha256),
  };
}

/**
 * Close every still-running reservation job this document opened for these
 * bytes once the bytes are published: the reservation's work is done whether
 * this request uploaded them or another reservation did.
 */
async function closeReservationJobs(
  tx: JobTransaction,
  input: { workspaceId: string; documentId: string; artifactId: string; sha256: string },
) {
  const open = await tx.queryRows<{ id: string }>(
    `SELECT j.id FROM simforge.artifact_postprocess_jobs j
      WHERE j.workspace_id = :workspace_id AND j.postprocess_kind = 'materialize_traffic'
        AND j.state = 'running' AND j.cancel_requested_at IS NULL
        AND j.request_payload->>'documentId' = :document_id
        AND j.idempotency_key = 'materialized-traffic:' || :document_id || ':'
            || (j.request_payload->>'draftVersion') || ':' || :sha256
      ORDER BY j.id`,
    { workspace_id: input.workspaceId, document_id: input.documentId, sha256: input.sha256 },
  );
  for (const job of open) {
    await lockScenarioJob(tx, job.id);
    await tx.execute(
      `UPDATE simforge.artifact_postprocess_jobs job
          SET state = 'succeeded', phase = 'finalized', progress = 1,
              result_payload = jsonb_build_object(
                'artifactId', artifact.id, 'artifactKind', artifact.artifact_kind,
                'sha256', artifact.sha256, 'provenance', artifact.provenance
              ),
              completed_at = COALESCE(job.completed_at, NOW()), updated_at = NOW()
         FROM simforge.artifacts artifact
        WHERE job.id = :job_id AND job.workspace_id = :workspace_id
          AND job.state = 'running' AND job.cancel_requested_at IS NULL
          AND artifact.id = :artifact_id AND artifact.workspace_id = job.workspace_id
          AND artifact.artifact_state = 'available'`,
      { job_id: job.id, workspace_id: input.workspaceId, artifact_id: input.artifactId },
    );
  }
}

export async function completeMaterializedTraffic(
  context: Pick<AppContext, "workspaceId">,
  documentId: string,
  input: ScenarioMaterializedTrafficReference,
) {
  const params = {
    artifact_id: input.artifactId,
    workspace_id: context.workspaceId,
    document_id: documentId,
    sha256: input.sha256,
    source_input_digest: input.sourceInputDigest,
    map_asset_id: input.mapAssetId,
    map_version_id: input.mapVersionId,
  };
  const rows = await queryRows<{
    storage_bucket: string;
    storage_key: string;
    sha256: string;
    byte_length: number;
    artifact_state: string;
  }>(
    // The caller must hold a reservation for these bytes (its producer job),
    // not merely name a shared blob some other document reserved.
    `SELECT a.storage_bucket, a.storage_key, a.sha256, a.byte_length, a.artifact_state
       FROM simforge.artifacts a
      WHERE a.id = :artifact_id AND a.workspace_id = :workspace_id
        AND a.artifact_kind = 'materialized-traffic' AND a.artifact_state IN ('pending', 'available')
        AND a.sha256 = :sha256
        AND EXISTS (
          SELECT 1 FROM simforge.artifact_postprocess_jobs j
           WHERE j.workspace_id = a.workspace_id AND j.state IN ('running', 'succeeded')
             AND ${MATERIALIZED_TRAFFIC_RESERVATION_SQL}
        )
      LIMIT 1`,
    params,
  );
  const row = rows[0];
  if (!row || row.sha256 !== input.sha256 || Number(row.byte_length) !== input.sizeBytes) return null;
  const head = await headS3Object(row.storage_key, row.storage_bucket);
  const checksum = head.checksumSha256 ? Buffer.from(head.checksumSha256, "base64").toString("hex") : null;
  if (head.contentLength !== input.sizeBytes || checksum !== input.sha256)
    throw new Error("materialized_traffic_upload_mismatch");
  const finalized = await withTransaction(async (tx) => {
    if (row.artifact_state !== "available") {
      const finalization = await finalizeLocalArtifactProducer(
        { workspaceId: context.workspaceId, artifactId: input.artifactId },
        tx,
      );
      if (!finalization) return false;
      await tx.execute(
        `UPDATE simforge.artifacts SET artifact_state = 'available', verified_at = NOW()
         WHERE id = :artifact_id AND workspace_id = :workspace_id
           AND artifact_state IN ('pending', 'available')`,
        { artifact_id: input.artifactId, workspace_id: context.workspaceId },
      );
    }
    // Published, by this request or an earlier one: this document's
    // reservation is done. Returning early here used to leave its job
    // `running` forever.
    await closeReservationJobs(tx, {
      workspaceId: context.workspaceId,
      documentId,
      artifactId: input.artifactId,
      sha256: input.sha256,
    });
    return true;
  });
  return finalized ? input : null;
}
