import { parseTemplate } from "@simforge-oss/scenario";
import { z } from "zod";
import type {
  ScenarioDatasetDto,
  ScenarioDocumentDto,
  StudioCloudPublishResult,
  StudioCloudWorkspace,
} from "@simforge-oss/studio-host";
import type { AppContext } from "@/app/lib/db/app-context";
import { execute, queryOne, queryRows } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { createScenarioDataset, getScenarioDataset } from "@/app/lib/scenario/dataset-store";
import {
  createScenarioDocument,
  updateScenarioDocument,
} from "@/app/lib/scenario/document-store";
import { NextResponse } from "next/server";
import { CloudConnectionError, cloudRequest, getCloudStatus } from "./connection";
import { ensureLocalMap } from "./maps";

/**
 * SimCloud project transfer for the local service.
 *
 * Cloud content becomes a local working copy only by explicit import, and
 * local work reaches a workspace only by explicit publish. Every transferred
 * document keeps a link naming the upstream document and the exact upstream
 * version (draft version + canonical digest) the local copy last saw; publish
 * fences on that version server-side, so an upstream edit this machine has
 * not seen is a conflict, never an overwrite. Import fences on the local draft
 * version the same way. Nothing here runs on sign-in.
 */

/** A transfer failure the UI can act on; `code` is the wire error, `details` the route's extra fields. */
export class CloudTransferError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CloudTransferError";
  }
}

type ErrorBody = { error?: string; message?: string } & Record<string, unknown>;

/** Turn a non-2xx SimCloud answer into a `CloudTransferError`, keeping the route's extra fields. */
export async function cloudResponseError(response: Response, fallbackCode: string): Promise<CloudTransferError> {
  const body = ((await response.json().catch(() => null)) ?? {}) as ErrorBody;
  const { error, message, ...details } = body;
  const code = typeof error === "string" && error ? error : fallbackCode;
  return new CloudTransferError(
    code,
    response.status,
    typeof message === "string" && message ? message : `SimCloud answered ${response.status} (${code}).`,
    details,
  );
}

const CONNECTION_ERROR_STATUS: Record<string, number> = {
  cloud_disconnected: 401,
  cloud_session_expired: 401,
  cloud_unreachable: 503,
  cloud_invalid_path: 400,
};

/**
 * The local transfer routes' one error answer: a transfer failure keeps its
 * code, status and details (conflicts, map ids) so the storage page can act
 * on them; a connection failure maps to the connector's codes the shared
 * client already knows. Anything else is a real server error.
 */
export function transferErrorResponse(error: unknown): NextResponse {
  if (error instanceof CloudTransferError) {
    return NextResponse.json(
      { ...error.details, error: error.code, message: error.message },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof CloudConnectionError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: CONNECTION_ERROR_STATUS[error.code] ?? 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  throw error;
}

async function cloudJson<T>(
  path: string,
  init: RequestInit,
  options: { workspaceId?: string; signal?: AbortSignal },
  fallbackCode: string,
): Promise<T> {
  const response = await cloudRequest(path, init, options);
  if (!response.ok) throw await cloudResponseError(response, fallbackCode);
  return (await response.json()) as T;
}

export async function listCloudWorkspaces(signal?: AbortSignal): Promise<StudioCloudWorkspace[]> {
  const body = await cloudJson<{ workspaces: StudioCloudWorkspace[] }>(
    "/api/desktop/projects/workspaces",
    { method: "GET" },
    { signal },
    "cloud_workspaces_unavailable",
  );
  return body.workspaces;
}

export async function listCloudDatasets(workspaceId: string, signal?: AbortSignal): Promise<ScenarioDatasetDto[]> {
  const body = await cloudJson<{ datasets: ScenarioDatasetDto[] }>(
    "/api/simforge/datasets",
    { method: "GET" },
    { workspaceId, signal },
    "cloud_datasets_unavailable",
  );
  return body.datasets;
}

// ── Local link records ────────────────────────────────────────────────────────

type DatasetLinkRow = {
  local_dataset_id: string;
  cloud_origin: string;
  remote_workspace_id: string;
  remote_dataset_id: string;
  remote_dataset_name: string;
  last_imported_at: string | null;
  last_published_at: string | null;
};

type DocumentLinkRow = {
  local_document_id: string;
  remote_document_id: string;
  remote_draft_version: number | string;
  remote_content_sha256: string;
  remote_latest_revision_id: string | null;
  local_draft_version: number | string;
};

/** Upstream binding of one local dataset, for the storage page. */
export type CloudDatasetLink = {
  localDatasetId: string;
  origin: string;
  remoteWorkspaceId: string;
  remoteDatasetId: string;
  remoteDatasetName: string;
  lastImportedAt: string | null;
  lastPublishedAt: string | null;
  /** Documents edited locally since the last synchronization. */
  unpublishedDocumentCount: number;
};

export async function listCloudDatasetLinks(context: AppContext): Promise<CloudDatasetLink[]> {
  const rows = await queryRows<DatasetLinkRow & { unpublished_count: number | string }>(
    `SELECT l.local_dataset_id, l.cloud_origin, l.remote_workspace_id, l.remote_dataset_id,
            l.remote_dataset_name,
            l.last_imported_at::text AS last_imported_at, l.last_published_at::text AS last_published_at,
            (SELECT COUNT(*) FROM simforge.documents d
               JOIN simforge.drafts dr ON dr.document_id = d.id AND dr.workspace_id = d.workspace_id
               LEFT JOIN simforge.cloud_document_links dl ON dl.local_document_id = d.id
              WHERE d.workspace_id = l.workspace_id AND d.dataset_id = l.local_dataset_id
                AND d.deleted_at IS NULL
                AND (dl.local_document_id IS NULL OR dr.draft_version <> dl.local_draft_version)
            ) AS unpublished_count
       FROM simforge.cloud_dataset_links l
       JOIN simforge.datasets ds ON ds.id = l.local_dataset_id AND ds.workspace_id = l.workspace_id
      WHERE l.workspace_id = :workspace_id AND ds.deleted_at IS NULL
      ORDER BY l.updated_at DESC`,
    { workspace_id: context.workspaceId },
  );
  return rows.map((row) => ({
    localDatasetId: row.local_dataset_id,
    origin: row.cloud_origin,
    remoteWorkspaceId: row.remote_workspace_id,
    remoteDatasetId: row.remote_dataset_id,
    remoteDatasetName: row.remote_dataset_name,
    lastImportedAt: row.last_imported_at,
    lastPublishedAt: row.last_published_at,
    unpublishedDocumentCount: Number(row.unpublished_count),
  }));
}

async function readDatasetLink(context: AppContext, localDatasetId: string) {
  return queryOne<DatasetLinkRow>(
    `SELECT local_dataset_id, cloud_origin, remote_workspace_id, remote_dataset_id, remote_dataset_name,
            last_imported_at::text AS last_imported_at, last_published_at::text AS last_published_at
       FROM simforge.cloud_dataset_links
      WHERE workspace_id = :workspace_id AND local_dataset_id = :local_dataset_id`,
    { workspace_id: context.workspaceId, local_dataset_id: localDatasetId },
  );
}

/** The most recently synchronized local working copy of one upstream dataset, if any. */
async function findLinkedLocalDataset(
  context: AppContext,
  target: { origin: string; workspaceId: string; datasetId: string },
) {
  return queryOne<DatasetLinkRow>(
    `SELECT l.local_dataset_id, l.cloud_origin, l.remote_workspace_id, l.remote_dataset_id, l.remote_dataset_name,
            l.last_imported_at::text AS last_imported_at, l.last_published_at::text AS last_published_at
       FROM simforge.cloud_dataset_links l
       JOIN simforge.datasets ds ON ds.id = l.local_dataset_id AND ds.workspace_id = l.workspace_id
      WHERE l.workspace_id = :workspace_id AND l.cloud_origin = :origin
        AND l.remote_workspace_id = :remote_workspace_id AND l.remote_dataset_id = :remote_dataset_id
        AND ds.deleted_at IS NULL
      ORDER BY l.updated_at DESC
      LIMIT 1`,
    {
      workspace_id: context.workspaceId,
      origin: target.origin,
      remote_workspace_id: target.workspaceId,
      remote_dataset_id: target.datasetId,
    },
  );
}

async function upsertDatasetLink(
  context: AppContext,
  input: {
    localDatasetId: string;
    origin: string;
    remoteWorkspaceId: string;
    remoteDatasetId: string;
    remoteDatasetName: string;
    stamp: "imported" | "published";
  },
) {
  const column = input.stamp === "imported" ? "last_imported_at" : "last_published_at";
  await execute(
    `INSERT INTO simforge.cloud_dataset_links (
       local_dataset_id, workspace_id, cloud_origin, remote_workspace_id, remote_dataset_id,
       remote_dataset_name, ${column}
     ) VALUES (
       :local_dataset_id, :workspace_id, :origin, :remote_workspace_id, :remote_dataset_id,
       :remote_dataset_name, NOW()
     )
     ON CONFLICT (local_dataset_id) DO UPDATE SET
       cloud_origin = EXCLUDED.cloud_origin,
       remote_workspace_id = EXCLUDED.remote_workspace_id,
       remote_dataset_id = EXCLUDED.remote_dataset_id,
       remote_dataset_name = EXCLUDED.remote_dataset_name,
       ${column} = NOW(),
       updated_at = NOW()`,
    {
      local_dataset_id: input.localDatasetId,
      workspace_id: context.workspaceId,
      origin: input.origin,
      remote_workspace_id: input.remoteWorkspaceId,
      remote_dataset_id: input.remoteDatasetId,
      remote_dataset_name: input.remoteDatasetName,
    },
  );
}

type DocumentLinks = { byRemote: Record<string, DocumentLinkRow>; byLocal: Record<string, DocumentLinkRow> };

async function readDocumentLinks(context: AppContext, localDatasetId: string): Promise<DocumentLinks> {
  const rows = await queryRows<DocumentLinkRow>(
    `SELECT local_document_id, remote_document_id, remote_draft_version, remote_content_sha256,
            remote_latest_revision_id, local_draft_version
       FROM simforge.cloud_document_links
      WHERE workspace_id = :workspace_id AND local_dataset_id = :local_dataset_id`,
    { workspace_id: context.workspaceId, local_dataset_id: localDatasetId },
  );
  const byRemote: Record<string, DocumentLinkRow> = {};
  const byLocal: Record<string, DocumentLinkRow> = {};
  for (const row of rows) {
    byRemote[row.remote_document_id] = row;
    byLocal[row.local_document_id] = row;
  }
  return { byRemote, byLocal };
}

async function upsertDocumentLink(
  context: AppContext,
  input: {
    localDocumentId: string;
    localDatasetId: string;
    remoteDocumentId: string;
    remoteDraftVersion: number;
    remoteContentSha256: string;
    remoteLatestRevisionId: string | null;
    localDraftVersion: number;
  },
) {
  await execute(
    `INSERT INTO simforge.cloud_document_links (
       local_document_id, workspace_id, local_dataset_id, remote_document_id,
       remote_draft_version, remote_content_sha256, remote_latest_revision_id, local_draft_version, synced_at
     ) VALUES (
       :local_document_id, :workspace_id, :local_dataset_id, :remote_document_id,
       :remote_draft_version, :remote_content_sha256, :remote_latest_revision_id, :local_draft_version, NOW()
     )
     ON CONFLICT (local_document_id) DO UPDATE SET
       local_dataset_id = EXCLUDED.local_dataset_id,
       remote_document_id = EXCLUDED.remote_document_id,
       remote_draft_version = EXCLUDED.remote_draft_version,
       remote_content_sha256 = EXCLUDED.remote_content_sha256,
       remote_latest_revision_id = EXCLUDED.remote_latest_revision_id,
       local_draft_version = EXCLUDED.local_draft_version,
       synced_at = NOW()`,
    {
      local_document_id: input.localDocumentId,
      workspace_id: context.workspaceId,
      local_dataset_id: input.localDatasetId,
      remote_document_id: input.remoteDocumentId,
      remote_draft_version: input.remoteDraftVersion,
      remote_content_sha256: input.remoteContentSha256,
      remote_latest_revision_id: input.remoteLatestRevisionId,
      local_draft_version: input.localDraftVersion,
    },
  );
}

// ── Local document reads ──────────────────────────────────────────────────────

type LocalDocumentRow = {
  id: string;
  title: string;
  draft_version: number | string;
  schema_version: string;
  content_sha256: string;
  canonical_content: string | Record<string, unknown>;
  map_version_id: string | null;
  authoring_quality_id: ScenarioDocumentDto["authoringQualityId"];
  latest_revision_id: string | null;
};

type LocalDocument = {
  id: string;
  title: string;
  draftVersion: number;
  schemaVersion: string;
  contentSha256: string;
  content: ScenarioDocumentDto["content"];
  mapVersionId: string | null;
  authoringQualityId: ScenarioDocumentDto["authoringQualityId"];
  latestRevisionId: string | null;
};

/**
 * Every live document of a local dataset with its draft content. The document
 * store's list read is capped and its DTO mapping private, so the same columns
 * are read here for the publish payload.
 */
async function readLocalDocuments(context: AppContext, datasetId: string): Promise<LocalDocument[]> {
  const rows = await queryRows<LocalDocumentRow>(
    `SELECT d.id, d.title, dr.draft_version, dr.schema_version, dr.content_sha256,
            dr.canonical_content::text AS canonical_content, dr.map_version_id,
            dr.authoring_quality_id, d.latest_revision_id
       FROM simforge.documents d
       JOIN simforge.drafts dr ON dr.document_id = d.id AND dr.workspace_id = d.workspace_id
      WHERE d.workspace_id = :workspace_id AND d.dataset_id = :dataset_id AND d.deleted_at IS NULL
      ORDER BY d.created_at, d.id`,
    { workspace_id: context.workspaceId, dataset_id: datasetId },
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    draftVersion: Number(row.draft_version),
    schemaVersion: row.schema_version,
    contentSha256: row.content_sha256,
    content: parseTemplate(parseJsonObject(row.canonical_content)),
    mapVersionId: row.map_version_id,
    authoringQualityId: row.authoring_quality_id,
    latestRevisionId: row.latest_revision_id,
  }));
}

// ── Import ────────────────────────────────────────────────────────────────────

type CloudDatasetSnapshot = { dataset: ScenarioDatasetDto; documents: ScenarioDocumentDto[] };

/** Conflict the import refused to resolve: both sides changed since the last synchronization. */
export type CloudImportConflict = {
  localDocumentId: string;
  remoteDocumentId: string;
  title: string;
};

/**
 * Make sure every map the snapshot references is registered locally. Maps
 * arrive through the one service cache (`ensureLocalMap`), gated on the
 * active connection; a map this session may not read is reported, not
 * substituted.
 */
async function ensureSnapshotMaps(snapshot: CloudDatasetSnapshot, signal?: AbortSignal) {
  const seen: Record<string, true> = {};
  const unavailable: string[] = [];
  for (const document of snapshot.documents) {
    const mapVersionId = document.mapVersionId;
    if (!mapVersionId || seen[mapVersionId]) continue;
    seen[mapVersionId] = true;
    try {
      await ensureLocalMap(mapVersionId, "browser", signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const name = error instanceof Error ? error.name : null;
      if (name === "NotAuthorized" || name === "NotFound") {
        unavailable.push(mapVersionId);
        continue;
      }
      throw error;
    }
  }
  if (unavailable.length > 0) {
    throw new CloudTransferError(
      "cloud_map_unavailable",
      422,
      `Some scenarios use maps this connection cannot download (${listNames(unavailable)}). Prepare those maps first.`,
      { mapVersionIds: unavailable },
    );
  }
}

async function createLocalDatasetForImport(context: AppContext, snapshot: CloudDatasetSnapshot) {
  const base = snapshot.dataset.name.slice(0, 180);
  const candidates = [base, `${base} (SimCloud)`, `${base} (SimCloud 2)`, `${base} (SimCloud 3)`];
  for (const name of candidates) {
    const created = await createScenarioDataset(context, {
      name,
      description: snapshot.dataset.description,
    });
    if (created.kind === "ok") return created.dataset;
    if (created.kind !== "name_conflict") break;
  }
  throw new CloudTransferError(
    "dataset_name_taken",
    409,
    `A local dataset named "${base}" already exists and is not linked to this SimCloud dataset. Rename it first.`,
  );
}

/**
 * Import (or refresh) a local working copy of one SimCloud dataset.
 *
 * First import creates a local dataset and one local document per upstream
 * document, each linked to its upstream version. A later import of the same
 * upstream dataset refreshes that copy: documents unchanged upstream are left
 * alone, documents changed upstream but untouched locally are replaced, and a
 * document changed on both sides is a conflict. Conflicts are detected before
 * anything is written and abort the whole refresh. Upstream documents deleted
 * since the last import are not deleted locally.
 */
export async function importCloudDataset(
  context: AppContext,
  source: { workspaceId: string; datasetId: string },
  signal?: AbortSignal,
): Promise<ScenarioDatasetDto> {
  const status = await getCloudStatus();
  const origin = status.origin;
  const response = await cloudRequest(
    `/api/desktop/projects/datasets/${encodeURIComponent(source.datasetId)}`,
    { method: "GET" },
    { workspaceId: source.workspaceId, signal },
  );
  if (!response.ok) throw await cloudResponseError(response, "cloud_dataset_unavailable");
  const snapshot = (await response.json()) as CloudDatasetSnapshot;
  for (const document of snapshot.documents) parseTemplate(document.content);

  await ensureSnapshotMaps(snapshot, signal);

  const existingLink = await findLinkedLocalDataset(context, {
    origin,
    workspaceId: source.workspaceId,
    datasetId: source.datasetId,
  });
  const localDataset = existingLink
    ? await getScenarioDataset(context, existingLink.local_dataset_id)
    : null;
  const target = localDataset ?? (await createLocalDatasetForImport(context, snapshot));

  const links = await readDocumentLinks(context, target.id);
  const localDocuments = await readLocalDocuments(context, target.id);
  const localById: Record<string, LocalDocument> = {};
  for (const document of localDocuments) localById[document.id] = document;

  type Plan =
    | { kind: "create"; remote: ScenarioDocumentDto }
    | { kind: "replace"; remote: ScenarioDocumentDto; local: LocalDocument }
    | { kind: "keep"; remote: ScenarioDocumentDto; local: LocalDocument; link: DocumentLinkRow };
  const plan: Plan[] = [];
  const conflicts: CloudImportConflict[] = [];
  for (const remote of snapshot.documents) {
    const link = links.byRemote[remote.id];
    const local = link ? localById[link.local_document_id] : undefined;
    if (!link || !local) {
      plan.push({ kind: "create", remote });
      continue;
    }
    const remoteChanged =
      remote.draftVersion !== Number(link.remote_draft_version) ||
      remote.contentSha256 !== link.remote_content_sha256;
    const localChanged = local.draftVersion !== Number(link.local_draft_version);
    if (!remoteChanged) {
      plan.push({ kind: "keep", remote, local, link });
      continue;
    }
    if (localChanged) {
      conflicts.push({ localDocumentId: local.id, remoteDocumentId: remote.id, title: local.title });
      continue;
    }
    plan.push({ kind: "replace", remote, local });
  }
  if (conflicts.length > 0) {
    throw new CloudTransferError(
      "cloud_import_conflict",
      409,
      `${listNames(conflicts.map((conflict) => conflict.title))} changed both locally and in SimCloud since the last import. Publish or discard the local edits first.`,
      { conflicts },
    );
  }
  await upsertDatasetLink(context, {
    localDatasetId: target.id,
    origin,
    remoteWorkspaceId: source.workspaceId,
    remoteDatasetId: snapshot.dataset.id,
    remoteDatasetName: snapshot.dataset.name,
    stamp: "imported",
  });

  for (const step of plan) {
    if (step.kind === "keep") continue;
    if (step.kind === "create") {
      const created = await createScenarioDocument(context, {
        title: step.remote.title,
        schemaVersion: step.remote.schemaVersion,
        content: step.remote.content,
        mapVersionId: step.remote.mapVersionId,
        datasetId: target.id,
        authoringQualityId: step.remote.authoringQualityId,
      });
      assertDigestLineage(created.contentSha256, step.remote);
      await upsertDocumentLink(context, {
        localDocumentId: created.id,
        localDatasetId: target.id,
        remoteDocumentId: step.remote.id,
        remoteDraftVersion: step.remote.draftVersion,
        remoteContentSha256: step.remote.contentSha256,
        remoteLatestRevisionId: step.remote.latestRevisionId,
        localDraftVersion: created.draftVersion,
      });
      continue;
    }
    const updated = await updateScenarioDocument(context, step.local.id, {
      expectedVersion: step.local.draftVersion,
      title: step.remote.title,
      schemaVersion: step.remote.schemaVersion,
      content: step.remote.content,
      mapVersionId: step.remote.mapVersionId,
      authoringQualityId: step.remote.authoringQualityId,
    });
    if (updated.kind !== "updated") {
      throw new CloudTransferError(
        "cloud_import_conflict",
        409,
        `"${step.local.title}" changed locally while the import was running. Run the import again.`,
        { conflicts: [{ localDocumentId: step.local.id, remoteDocumentId: step.remote.id, title: step.local.title }] },
      );
    }
    assertDigestLineage(updated.document.contentSha256, step.remote);
    await upsertDocumentLink(context, {
      localDocumentId: step.local.id,
      localDatasetId: target.id,
      remoteDocumentId: step.remote.id,
      remoteDraftVersion: step.remote.draftVersion,
      remoteContentSha256: step.remote.contentSha256,
      remoteLatestRevisionId: step.remote.latestRevisionId,
      localDraftVersion: updated.document.draftVersion,
    });
  }

  const dataset = await getScenarioDataset(context, target.id);
  if (!dataset) throw new Error("cloud_import_dataset_missing");
  return dataset;
}

/**
 * The local canonical digest of imported content must equal the upstream one:
 * both sides hash the same canonical template serializer. A mismatch means the
 * content was altered on the way (or the serializers diverged), which is a
 * lineage break worth failing loudly on rather than recording a false version.
 */
function assertDigestLineage(localSha256: string, remote: ScenarioDocumentDto) {
  if (localSha256 === remote.contentSha256) return;
  throw new CloudTransferError(
    "cloud_content_digest_mismatch",
    500,
    `Imported "${remote.title}" does not hash to its SimCloud digest; the local copy was kept but not linked.`,
    { remoteDocumentId: remote.id, remoteContentSha256: remote.contentSha256, localContentSha256: localSha256 },
  );
}

// ── Publish ───────────────────────────────────────────────────────────────────

type PublishedDocument = {
  localDocumentId: string;
  remoteDocumentId: string;
  outcome: "created" | "updated" | "unchanged";
  draftVersion: number;
  contentSha256: string;
  latestRevisionId: string | null;
};

type PublishResponse = { dataset: ScenarioDatasetDto; documents: PublishedDocument[] };

/** Conflict the server refused: the upstream document moved past the version this copy last saw. */
export type CloudPublishConflict = {
  localDocumentId: string;
  remoteDocumentId: string | null;
  title: string;
  reason: "remote_changed" | "remote_missing";
  currentDraftVersion: number | null;
};

/**
 * Publish a local dataset to a SimCloud workspace, atomically on the server.
 *
 * Only documents edited since their last synchronization travel; each is
 * fenced on the upstream draft version this copy last saw, and the server
 * writes all of them or none. `remoteDatasetId` targets an existing upstream
 * dataset (the linked one by default); without one and without a link a new
 * upstream dataset is created under the local name. Publishing to a different
 * upstream dataset than the linked one re-links every document as a fresh
 * copy there — the old link is superseded, not merged.
 */
export async function publishCloudDataset(
  context: AppContext,
  input: { datasetId: string; workspaceId: string; remoteDatasetId?: string },
  signal?: AbortSignal,
): Promise<StudioCloudPublishResult> {
  const status = await getCloudStatus();
  const origin = status.origin;
  const dataset = await getScenarioDataset(context, input.datasetId);
  if (!dataset) throw new CloudTransferError("dataset_not_found", 404, "That local dataset no longer exists.");

  const link = await readDatasetLink(context, input.datasetId);
  /** The existing link, only when this publish targets the very dataset it names. */
  const linked =
    link &&
    link.cloud_origin === origin &&
    link.remote_workspace_id === input.workspaceId &&
    (input.remoteDatasetId === undefined || input.remoteDatasetId === link.remote_dataset_id)
      ? link
      : null;
  const sameTarget = linked !== null;
  const remoteDatasetId = input.remoteDatasetId ?? linked?.remote_dataset_id ?? null;
  const links: DocumentLinks = sameTarget
    ? await readDocumentLinks(context, input.datasetId)
    : { byRemote: {}, byLocal: {} };

  const localDocuments = await readLocalDocuments(context, input.datasetId);
  const titles: Record<string, string> = {};
  const payload = localDocuments.flatMap((document) => {
    titles[document.id] = document.title;
    const documentLink = links.byLocal[document.id];
    if (documentLink && document.draftVersion === Number(documentLink.local_draft_version)) return [];
    return [
      {
        localDocumentId: document.id,
        remoteDocumentId: documentLink?.remote_document_id ?? null,
        expectedDraftVersion: documentLink ? Number(documentLink.remote_draft_version) : null,
        title: document.title,
        schemaVersion: document.schemaVersion,
        content: document.content,
        contentSha256: document.contentSha256,
        mapVersionId: document.mapVersionId,
        authoringQualityId: document.authoringQualityId,
      },
    ];
  });

  const response = await cloudRequest(
    "/api/desktop/projects/publish",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        remoteDatasetId,
        dataset: { name: dataset.name, description: dataset.description },
        documents: payload,
      }),
    },
    { workspaceId: input.workspaceId, signal },
  );
  if (!response.ok) {
    const error = await cloudResponseError(response, "cloud_publish_failed");
    if (error.code === "publish_conflict") {
      const parsed = PublishConflictsSchema.safeParse(error.details.conflicts);
      const conflicts: CloudPublishConflict[] = (parsed.success ? parsed.data : []).map((conflict) => ({
        ...conflict,
        title: titles[conflict.localDocumentId] ?? conflict.localDocumentId,
      }));
      throw new CloudTransferError(
        "cloud_publish_conflict",
        409,
        `${listNames(conflicts.map((conflict) => conflict.title))} changed in SimCloud since this copy was last synchronized. Import the latest version, then publish again.`,
        { conflicts },
      );
    }
    throw error;
  }
  const result = (await response.json()) as PublishResponse;

  await upsertDatasetLink(context, {
    localDatasetId: dataset.id,
    origin,
    remoteWorkspaceId: input.workspaceId,
    remoteDatasetId: result.dataset.id,
    remoteDatasetName: result.dataset.name,
    stamp: "published",
  });
  if (!sameTarget) {
    await execute(
      `DELETE FROM simforge.cloud_document_links
        WHERE workspace_id = :workspace_id AND local_dataset_id = :local_dataset_id`,
      { workspace_id: context.workspaceId, local_dataset_id: dataset.id },
    );
  }
  const localById: Record<string, LocalDocument> = {};
  for (const document of localDocuments) localById[document.id] = document;
  for (const published of result.documents) {
    const local = localById[published.localDocumentId];
    if (!local) continue;
    await upsertDocumentLink(context, {
      localDocumentId: local.id,
      localDatasetId: dataset.id,
      remoteDocumentId: published.remoteDocumentId,
      remoteDraftVersion: published.draftVersion,
      remoteContentSha256: published.contentSha256,
      remoteLatestRevisionId: published.latestRevisionId,
      localDraftVersion: local.draftVersion,
    });
  }
  return {
    workspaceId: input.workspaceId,
    datasetId: result.dataset.id,
    documents: result.documents.filter((document) => document.outcome !== "unchanged").length,
    artifacts: 0,
  };
}

const PublishConflictsSchema = z.array(
  z.object({
    localDocumentId: z.string(),
    remoteDocumentId: z.string().nullable(),
    reason: z.enum(["remote_changed", "remote_missing"]),
    currentDraftVersion: z.number().int().nullable(),
  }),
);

/** "A, B, C and 2 more" — enough of a list for a one-line message. */
function listNames(names: string[]): string {
  const shown = names.slice(0, 3).map((name) => `"${name}"`).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}
