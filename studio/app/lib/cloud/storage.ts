import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { ScenarioArtifactDto, WorkspaceArtifact } from "@simforge-oss/studio-host";
import type { AppContext } from "@/app/lib/db/app-context";
import { LOCAL_ARTIFACTS_DIR } from "@/app/lib/db/config";
import { execute, queryOne, queryRows, withTransaction } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { localObjectPath, registerLocalFile } from "@/app/lib/s3/s3-object";
import { getFinalizedArtifact } from "@/app/lib/scenario/control-plane-store";
import { scenarioId } from "@/app/lib/scenario/core";
import { CreateArtifactReservationSchema } from "@/app/lib/scenario/contracts";
import {
  createLocalArtifactProducer,
  finalizeLocalArtifactProducer,
} from "@/app/lib/scenario/jobs/local-artifact-producer-store";
import { simforgeEnv } from "@/lib/simforge-env";
import { cloudRequest, getCloudStatus } from "./connection";
import { CloudTransferError, cloudResponseError } from "./projects";

/**
 * SimCloud artifact storage for the local service.
 *
 * Bytes move only on explicit import/upload. Every transfer is verified end to
 * end: an import is hashed while it streams to disk and refused on any digest
 * or length mismatch; an upload is reserved checksum-bound on the server,
 * which re-reads the stored digest before completing, and this side never
 * records a transfer the server did not confirm. Presigned object URLs are
 * fetched without credentials — the signature is the authorization — and the
 * bearer never leaves `cloudRequest`.
 */

const TRANSFER_TIMEOUT_MS = 30 * 60_000;

export async function listCloudArtifacts(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceArtifact[]> {
  const response = await cloudRequest("/api/desktop/storage/artifacts", { method: "GET" }, { workspaceId, signal });
  if (!response.ok) throw await cloudResponseError(response, "cloud_artifacts_unavailable");
  const body = (await response.json()) as { artifacts: WorkspaceArtifact[] };
  return body.artifacts;
}

// ── Local link records ────────────────────────────────────────────────────────

/** Where a local artifact came from, or where it was uploaded to. */
export type CloudArtifactLink = {
  localArtifactId: string;
  origin: string;
  remoteWorkspaceId: string;
  remoteArtifactId: string;
  direction: "import" | "upload";
  sha256: string;
  syncedAt: string;
};

type ArtifactLinkRow = {
  local_artifact_id: string;
  cloud_origin: string;
  remote_workspace_id: string;
  remote_artifact_id: string;
  direction: "import" | "upload";
  sha256: string;
  synced_at: string;
};

function artifactLinkDto(row: ArtifactLinkRow): CloudArtifactLink {
  return {
    localArtifactId: row.local_artifact_id,
    origin: row.cloud_origin,
    remoteWorkspaceId: row.remote_workspace_id,
    remoteArtifactId: row.remote_artifact_id,
    direction: row.direction,
    sha256: row.sha256,
    syncedAt: row.synced_at,
  };
}

export async function listCloudArtifactLinks(context: AppContext): Promise<CloudArtifactLink[]> {
  const rows = await queryRows<ArtifactLinkRow>(
    `SELECT l.local_artifact_id, l.cloud_origin, l.remote_workspace_id, l.remote_artifact_id,
            l.direction, l.sha256, l.synced_at::text AS synced_at
       FROM simforge.cloud_artifact_links l
       JOIN simforge.artifacts a ON a.id = l.local_artifact_id AND a.workspace_id = l.workspace_id
      WHERE l.workspace_id = :workspace_id AND a.deleted_at IS NULL
      ORDER BY l.synced_at DESC`,
    { workspace_id: context.workspaceId },
  );
  return rows.map(artifactLinkDto);
}

async function upsertArtifactLink(
  context: AppContext,
  input: {
    localArtifactId: string;
    origin: string;
    remoteWorkspaceId: string;
    remoteArtifactId: string;
    direction: "import" | "upload";
    sha256: string;
  },
) {
  await execute(
    `INSERT INTO simforge.cloud_artifact_links (
       id, local_artifact_id, workspace_id, cloud_origin, remote_workspace_id, remote_artifact_id,
       direction, sha256, synced_at
     ) VALUES (
       :id, :local_artifact_id, :workspace_id, :origin, :remote_workspace_id, :remote_artifact_id,
       :direction, :sha256, NOW()
     )
     ON CONFLICT (local_artifact_id, cloud_origin, remote_workspace_id) DO UPDATE SET
       remote_artifact_id = EXCLUDED.remote_artifact_id,
       direction = EXCLUDED.direction,
       sha256 = EXCLUDED.sha256,
       synced_at = NOW()`,
    {
      id: scenarioId("uscal"),
      local_artifact_id: input.localArtifactId,
      workspace_id: context.workspaceId,
      origin: input.origin,
      remote_workspace_id: input.remoteWorkspaceId,
      remote_artifact_id: input.remoteArtifactId,
      direction: input.direction,
      sha256: input.sha256,
    },
  );
}

// ── Import ────────────────────────────────────────────────────────────────────

const RemoteArtifactSchema = z.object({
  id: z.string().min(1),
  revisionId: z.string().nullable(),
  kind: CreateArtifactReservationSchema.shape.artifactKind,
  mediaType: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
  downloadUrl: z.string().url(),
  downloadExpiresAt: z.string(),
  createdAt: z.string(),
});

const MAX_REDIRECTS = 5;

/**
 * Open a raw GET stream to a presigned object, following redirects without
 * ever attaching credentials. `node:http(s)` rather than `fetch` on purpose:
 * an artifact's digest identifies its STORED bytes, and `fetch` would
 * transparently decode a `Content-Encoding` object into different ones.
 */
async function openObjectStream(url: string, signal?: AbortSignal): Promise<IncomingMessage> {
  let target = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new CloudTransferError("cloud_artifact_url_rejected", 502, "SimCloud returned an artifact URL with an unsupported scheme.");
    }
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(target, { method: "GET", timeout: TRANSFER_TIMEOUT_MS, signal }, resolve);
      req.on("timeout", () => req.destroy(new CloudTransferError("cloud_artifact_download_failed", 504, "The artifact download timed out.")));
      req.on("error", reject);
      req.end();
    });
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      target = new URL(response.headers.location, target);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new CloudTransferError(
        "cloud_artifact_download_failed",
        502,
        `SimCloud object storage answered ${status} for the artifact download.`,
      );
    }
    return response;
  }
  throw new CloudTransferError("cloud_artifact_download_failed", 502, "The artifact download redirected too many times.");
}

/**
 * Stream a presigned object to a temporary file while hashing it. The URL's
 * signature is the only credential; nothing from the connection is attached.
 * Returns the path only when the length and digest match the declaration.
 */
async function downloadVerified(
  url: string,
  expected: { sha256: string; sizeBytes: number },
  signal?: AbortSignal,
): Promise<string> {
  const incoming = join(LOCAL_ARTIFACTS_DIR, ".incoming");
  await mkdir(incoming, { recursive: true });
  const temporaryPath = join(incoming, `${randomUUID()}.part`);
  const response = await openObjectStream(url, signal);
  const hash = createHash("sha256");
  let received = 0;
  try {
    await pipeline(
      response,
      async function* (source) {
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += bytes.byteLength;
          if (received > expected.sizeBytes) throw new CloudTransferError("cloud_artifact_digest_mismatch", 502, "The downloaded artifact is longer than SimCloud declared.");
          hash.update(bytes);
          yield bytes;
        }
      },
      createWriteStream(temporaryPath, { flags: "wx" }),
      { signal },
    );
    const digest = hash.digest("hex");
    if (received !== expected.sizeBytes || digest !== expected.sha256) {
      throw new CloudTransferError(
        "cloud_artifact_digest_mismatch",
        502,
        "The downloaded artifact does not match the digest SimCloud declared. Nothing was imported.",
        { expectedSha256: expected.sha256, receivedSha256: digest, expectedSizeBytes: expected.sizeBytes, receivedSizeBytes: received },
      );
    }
    return temporaryPath;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Import one SimCloud artifact as a local, verified, content-addressed
 * artifact. Bytes the local store already holds under the same digest and
 * kind are reused rather than downloaded again; either way the result is a
 * regular local artifact with a link naming its upstream identity.
 */
export async function importCloudArtifact(
  context: AppContext,
  source: { workspaceId: string; artifactId: string },
  signal?: AbortSignal,
): Promise<ScenarioArtifactDto> {
  const status = await getCloudStatus();
  const origin = status.origin;
  const response = await cloudRequest(
    `/api/simforge/artifacts/${encodeURIComponent(source.artifactId)}`,
    { method: "GET" },
    { workspaceId: source.workspaceId, signal },
  );
  if (!response.ok) throw await cloudResponseError(response, "cloud_artifact_unavailable");
  const remote = RemoteArtifactSchema.parse(await response.json());

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM simforge.artifacts
      WHERE workspace_id = :workspace_id AND sha256 = :sha256 AND artifact_kind = :kind
        AND artifact_state = 'available' AND deleted_at IS NULL
      LIMIT 1`,
    { workspace_id: context.workspaceId, sha256: remote.sha256, kind: remote.kind },
  );
  const localArtifactId = existing?.id ?? (await materializeImportedArtifact(context, origin, source, remote, signal));
  await upsertArtifactLink(context, {
    localArtifactId,
    origin,
    remoteWorkspaceId: source.workspaceId,
    remoteArtifactId: remote.id,
    direction: "import",
    sha256: remote.sha256,
  });
  const artifact = await getFinalizedArtifact(context, localArtifactId);
  if (!artifact) throw new Error("cloud_import_artifact_missing_after_register");
  return artifact;
}

async function materializeImportedArtifact(
  context: AppContext,
  origin: string,
  source: { workspaceId: string; artifactId: string },
  remote: z.infer<typeof RemoteArtifactSchema>,
  signal?: AbortSignal,
): Promise<string> {
  const temporaryPath = await downloadVerified(remote.downloadUrl, remote, signal);
  try {
    const bucket = simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts";
    const artifactId = scenarioId("usart");
    const key = `${context.workspaceId}/cloud-imports/${artifactId}`;
    const producerJobId = await createLocalArtifactProducer({
      workspaceId: context.workspaceId,
      requestedByUserId: context.userId,
      operation: "simcloud_artifact_import",
      artifactKind: remote.kind,
      artifactSha256: remote.sha256,
      requestPayload: {
        origin,
        remoteWorkspaceId: source.workspaceId,
        remoteArtifactId: remote.id,
        remoteRevisionId: remote.revisionId,
        sizeBytes: remote.sizeBytes,
      },
    });
    const reserved = await queryOne<{ id: string; artifact_state: string; storage_bucket: string; storage_key: string }>(
      // Content identity is the conflict target, as every local reservation does it; a still-pending
      // row from an earlier aborted import is taken over by this producer.
      `INSERT INTO simforge.artifacts (
         id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
         sha256, byte_length, artifact_state, metadata, created_by_user_id,
         verification_method, verification_sha256,
         producer_job_family, producer_job_id, provenance
       ) VALUES (
         :id, :workspace_id, :kind, :media_type, :bucket, :storage_key,
         :sha256, :size_bytes, 'pending', CAST(:metadata AS jsonb), :user_id,
         'stream_sha256', :sha256,
         'artifact_postprocess', :producer_job_id, CAST(:provenance AS jsonb)
       ) ON CONFLICT (workspace_id, sha256, artifact_kind)
       DO UPDATE SET
         producer_job_id = CASE WHEN simforge.artifacts.artifact_state = 'pending'
           THEN EXCLUDED.producer_job_id ELSE simforge.artifacts.producer_job_id END,
         provenance = CASE WHEN simforge.artifacts.artifact_state = 'pending'
           THEN EXCLUDED.provenance ELSE simforge.artifacts.provenance END
       RETURNING id, artifact_state, storage_bucket, storage_key`,
      {
        id: artifactId,
        workspace_id: context.workspaceId,
        kind: remote.kind,
        media_type: remote.mediaType,
        bucket,
        storage_key: key,
        sha256: remote.sha256,
        size_bytes: remote.sizeBytes,
        metadata: {
          ...remote.metadata,
          simcloud: { origin, workspaceId: source.workspaceId, artifactId: remote.id, revisionId: remote.revisionId },
        },
        user_id: context.userId,
        producer_job_id: producerJobId,
        provenance: {
          contract: "uniscenario.artifact-provenance/v1",
          producerJobFamily: "artifact_postprocess",
          producerJobId,
          operation: "simcloud_artifact_import",
          upstream: { origin, workspaceId: source.workspaceId, artifactId: remote.id, revisionId: remote.revisionId },
        },
      },
    );
    if (!reserved) throw new Error("cloud_import_artifact_reservation_failed");
    if (reserved.artifact_state === "available") return reserved.id;
    const stored = await registerLocalFile(reserved.storage_bucket, reserved.storage_key, temporaryPath, remote.mediaType);
    if (stored.checksumSha256Hex !== remote.sha256 || stored.sizeBytes !== remote.sizeBytes) {
      await rm(localObjectPath(reserved.storage_bucket, reserved.storage_key), { force: true });
      throw new CloudTransferError("cloud_artifact_digest_mismatch", 502, "The stored artifact does not match its declared digest.");
    }
    const finalized = await withTransaction(async (tx) => {
      const finalization = await finalizeLocalArtifactProducer(
        { workspaceId: context.workspaceId, artifactId: reserved.id },
        tx,
      );
      if (!finalization) return false;
      await tx.execute(
        `UPDATE simforge.artifacts SET artifact_state = 'available', verified_at = NOW()
          WHERE id = :artifact_id AND workspace_id = :workspace_id
            AND artifact_state IN ('pending', 'available')`,
        { artifact_id: reserved.id, workspace_id: context.workspaceId },
      );
      return true;
    });
    if (!finalized) throw new CloudTransferError("cloud_import_artifact_failed", 500, "The import producer could not be finalized.");
    return reserved.id;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

// ── Upload ────────────────────────────────────────────────────────────────────

type LocalArtifactRow = {
  id: string;
  artifact_kind: string;
  media_type: string;
  storage_bucket: string;
  storage_key: string;
  sha256: string;
  byte_length: number | string;
  metadata: string | Record<string, unknown>;
  render_job_id: string | null;
  revision_content_sha256: string | null;
  map_version_id: string | null;
};

/** One available local artifact with the lineage the upload records as provenance. */
async function readLocalArtifact(context: AppContext, artifactId: string) {
  return queryOne<LocalArtifactRow>(
    `SELECT a.id, a.artifact_kind, a.media_type, a.storage_bucket, a.storage_key, a.sha256, a.byte_length,
            a.metadata::text AS metadata,
            al.render_job_id, r.content_sha256 AS revision_content_sha256, r.map_version_id
       FROM simforge.artifacts a
       LEFT JOIN LATERAL (
         SELECT l.render_job_id FROM simforge.artifact_links l
          WHERE l.artifact_id = a.id AND l.workspace_id = a.workspace_id
          ORDER BY l.created_at, l.id LIMIT 1
       ) al ON TRUE
       LEFT JOIN simforge.render_jobs rj ON rj.id = al.render_job_id AND rj.workspace_id = a.workspace_id
       LEFT JOIN simforge.revisions r
         ON r.id = COALESCE(a.revision_id, rj.revision_id) AND r.workspace_id = a.workspace_id
      WHERE a.workspace_id = :workspace_id AND a.id = :artifact_id
        AND a.artifact_state = 'available' AND a.deleted_at IS NULL
      LIMIT 1`,
    { workspace_id: context.workspaceId, artifact_id: artifactId },
  );
}

const ReservationSchema = z.object({
  transferId: z.string().min(1),
  artifactId: z.string().min(1),
  uploadRequired: z.boolean(),
  uploadUrl: z.string().url().nullable(),
  headers: z.record(z.string(), z.string()),
});

/**
 * PUT a local object to a presigned URL with an exact Content-Length. Object
 * storage rejects chunked uploads, and the checksum headers from the
 * reservation are what bind the signature to these bytes.
 */
async function putLocalObject(
  url: string,
  file: { bucket: string; key: string; sizeBytes: number },
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new CloudTransferError("cloud_artifact_url_rejected", 502, "SimCloud returned an upload URL with an unsupported scheme.");
  }
  const path = localObjectPath(file.bucket, file.key);
  const fileStat = await stat(path);
  if (fileStat.size !== file.sizeBytes) {
    throw new CloudTransferError("cloud_upload_source_mismatch", 500, "The local artifact file no longer matches its recorded length.");
  }
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const req = request(
      target,
      {
        method: "PUT",
        headers: { ...headers, "content-length": String(file.sizeBytes) },
        timeout: TRANSFER_TIMEOUT_MS,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let collected = 0;
        res.on("data", (chunk: Buffer) => {
          if (collected >= 4096) return;
          collected += chunk.byteLength;
          chunks.push(chunk);
        });
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve();
            return;
          }
          reject(
            new CloudTransferError(
              "cloud_artifact_upload_failed",
              502,
              `SimCloud object storage answered ${statusCode} for the artifact upload.`,
              { body: Buffer.concat(chunks).toString("utf8").slice(0, 2048) },
            ),
          );
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new CloudTransferError("cloud_artifact_upload_failed", 504, "The artifact upload timed out.")));
    req.on("error", reject);
    createReadStream(path).on("error", reject).pipe(req);
  });
}

/**
 * Upload one local artifact into a SimCloud workspace. The server tells us
 * whether it already holds these bytes; only missing content is transferred,
 * and the transfer counts as done only after the server verified the stored
 * digest and marked the artifact available. A completion the server refuses
 * (`artifact_upload_pending`) is retried once with a fresh PUT, then surfaced.
 */
export async function uploadCloudArtifact(
  context: AppContext,
  input: { artifactId: string; workspaceId: string },
  signal?: AbortSignal,
): Promise<{ workspaceId: string; artifactId: string }> {
  const status = await getCloudStatus();
  const origin = status.origin;
  const local = await readLocalArtifact(context, input.artifactId);
  if (!local) throw new CloudTransferError("artifact_not_found", 404, "That local artifact is not available.");
  if (!CreateArtifactReservationSchema.shape.artifactKind.safeParse(local.artifact_kind).success) {
    throw new CloudTransferError("cloud_artifact_kind_rejected", 422, `Artifact kind "${local.artifact_kind}" cannot be uploaded.`);
  }
  const sizeBytes = Number(local.byte_length);
  const metadata = parseJsonObject(local.metadata);

  const reserveResponse = await cloudRequest(
    "/api/desktop/storage/artifacts/upload",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceArtifactId: local.id,
        sourceRenderJobId: local.render_job_id,
        sourceRevisionContentSha256: local.revision_content_sha256,
        sourceMapVersionId: local.map_version_id,
        kind: local.artifact_kind,
        mediaType: local.media_type,
        sha256: local.sha256,
        sizeBytes,
        metadata,
      }),
    },
    { workspaceId: input.workspaceId, signal },
  );
  if (!reserveResponse.ok) throw await cloudResponseError(reserveResponse, "cloud_upload_reservation_failed");
  const reservation = ReservationSchema.parse(await reserveResponse.json());

  const file = { bucket: local.storage_bucket, key: local.storage_key, sizeBytes };
  if (reservation.uploadRequired) {
    if (!reservation.uploadUrl) throw new CloudTransferError("cloud_upload_reservation_failed", 502, "SimCloud reserved an upload without a URL.");
    await putLocalObject(reservation.uploadUrl, file, reservation.headers, signal);
  }

  const complete = () =>
    cloudRequest(
      `/api/desktop/storage/artifacts/upload/${encodeURIComponent(reservation.transferId)}/complete`,
      { method: "POST" },
      { workspaceId: input.workspaceId, signal },
    );
  let completion = await complete();
  if (completion.status === 409 && reservation.uploadUrl) {
    const pending = await cloudResponseError(completion.clone(), "cloud_upload_incomplete");
    if (pending.code === "artifact_upload_pending") {
      await putLocalObject(reservation.uploadUrl, file, reservation.headers, signal);
      completion = await complete();
    }
  }
  if (!completion.ok) throw await cloudResponseError(completion, "cloud_upload_incomplete");
  const completed = z.object({ artifactId: z.string().min(1) }).parse(await completion.json());

  await upsertArtifactLink(context, {
    localArtifactId: local.id,
    origin,
    remoteWorkspaceId: input.workspaceId,
    remoteArtifactId: completed.artifactId,
    direction: "upload",
    sha256: local.sha256,
  });
  return { workspaceId: input.workspaceId, artifactId: completed.artifactId };
}
