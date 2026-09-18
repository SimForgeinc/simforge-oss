import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import {
  OPENSCENARIO_NATIVE_PROFILE,
  SCENARIO_AUTHORING_QUALITY_IDS,
  SCENARIO_RATING_REVIEWED_VIA,
  type CreateScenarioRevisionResultDto,
  type ScenarioAmbientProvenanceDto,
  type ScenarioAuthoringQuality,
  type ScenarioDocumentDto,
  type ScenarioDocumentRatingDto,
  type ScenarioDocumentSummaryDto,
  type ScenarioDocumentSummaryPageDto,
  type ScenarioExportStatus,
  type ScenarioMaterializedTrafficReferenceDto,
  type ScenarioRatingAggregateDto,
  type ScenarioRevisionDto,
  type ScenarioRevisionEvidenceDto,
  type ScenarioSimulationPreviewDto,
  type ScenarioTagDto,
} from "../contracts";
import { endpoint } from "./endpoint";
import {
  array,
  boolean,
  discriminated,
  literal,
  nullable,
  number,
  object,
  oneOf,
  optional,
  passthrough,
  record,
  string,
  union,
} from "./schema";

// ── DTO decoders ─────────────────────────────────────────────────────────────

export const ScenarioDocumentSchema = object<ScenarioDocumentDto>({
  id: string(),
  workspaceId: string(),
  title: string(),
  draftVersion: number(),
  schemaVersion: string(),
  contentSha256: string(),
  /** Owned by `@simforge-oss/scenario`; the editor validates it on load. */
  content: passthrough<ScenarioTemplateV2>(),
  mapVersionId: nullable(string()),
  datasetId: string(),
  authoringQualityId: oneOf(SCENARIO_AUTHORING_QUALITY_IDS),
  createdAt: string(),
  updatedAt: string(),
  latestRevisionId: nullable(string()),
});

export const ScenarioDocumentSummarySchema = object<ScenarioDocumentSummaryDto>({
  id: string(),
  workspaceId: string(),
  title: string(),
  description: nullable(string()),
  datasetId: string(),
  datasetSortOrder: number(),
  mapVersionId: nullable(string()),
  mapLabel: nullable(string()),
  mapSourceMapId: optional(nullable(string())),
  mapThumbnailUrl: optional(nullable(string())),
  latestRevisionId: nullable(string()),
  revisionCount: number(),
  archetype: nullable(string()),
  author: nullable(string()),
  contentTags: array(string()),
  tags: array(object({ id: string(), label: string(), color: nullable(string()) })),
  roleCount: number(),
  hasSensorProfile: boolean(),
  propCount: number(),
  variantCount: number(),
  clipSeconds: nullable(number()),
  negativeControl: boolean(),
  derivationKind: nullable(oneOf(["copy", "variation", "cross_map_variation", "import"] as const)),
  derivedFromDocumentId: nullable(string()),
  hasRender: boolean(),
  createdByUserName: nullable(string()),
  updatedByUserName: nullable(string()),
  createdAt: string(),
  updatedAt: string(),
});

export const ScenarioDocumentSummaryPageSchema = object<ScenarioDocumentSummaryPageDto>({
  documents: array(ScenarioDocumentSummarySchema),
  nextCursor: nullable(string()),
});

export const ScenarioTagSchema = object<ScenarioTagDto>({
  id: string(),
  workspaceId: string(),
  slug: string(),
  label: string(),
  color: nullable(string()),
  isSystemDefault: boolean(),
  documentCount: number(),
});

export const ScenarioDocumentRatingSchema = object<ScenarioDocumentRatingDto>({
  documentId: string(),
  revisionId: nullable(string()),
  renderJobId: nullable(string()),
  raterUserId: string(),
  score: number(),
  comment: nullable(string()),
  reviewedVia: oneOf(SCENARIO_RATING_REVIEWED_VIA),
  createdAt: string(),
  updatedAt: string(),
});

export const ScenarioRatingAggregateSchema = object<ScenarioRatingAggregateDto>({
  documentId: string(),
  ratingCount: number(),
  averageScore: number(),
  minimumScore: nullable(number()),
  reviewState: oneOf(["pending", "accepted", "rejected"] as const),
  viewerScore: nullable(number()),
});

export const ScenarioExportStatusSchema = oneOf<readonly ScenarioExportStatus[]>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const ScenarioRevisionSchema = object<ScenarioRevisionDto>({
  id: string(),
  workspaceId: string(),
  documentId: string(),
  revisionNumber: number(),
  sourceDraftVersion: number(),
  schemaVersion: string(),
  contentSha256: string(),
  mapVersionId: nullable(string()),
  openScenarioProfile: literal(OPENSCENARIO_NATIVE_PROFILE),
  export: object({
    id: string(),
    format: literal("openscenario_xml_1_4"),
    status: ScenarioExportStatusSchema,
    artifactId: nullable(string()),
  }),
  createdAt: string(),
});

export const CreateScenarioRevisionResultSchema = object<CreateScenarioRevisionResultDto>({
  revisionId: string(),
  exportId: string(),
  exportStatus: ScenarioExportStatusSchema,
  revision: ScenarioRevisionSchema,
});

export const ScenarioMaterializedTrafficReferenceSchema = object<ScenarioMaterializedTrafficReferenceDto>({
  artifactId: string(),
  sha256: string(),
  sizeBytes: number(),
  sourceInputDigest: string(),
  mapAssetId: string(),
  mapVersionId: string(),
});

const seed = union([string(), number()]);
export const ScenarioAmbientProvenanceSchema = discriminated<"mode", ScenarioAmbientProvenanceDto>("mode", {
  disabled: object({
    mode: literal("disabled"),
    ambientConfig: passthrough<Record<string, never>>(),
    configSha256: string(),
    resultSha256: string(),
  }),
  native: object({
    mode: literal("native"),
    runtimeVersion: string(),
    seed,
    ambientConfig: record(passthrough<unknown>()),
    configSha256: string(),
    resultSha256: string(),
  }),
  sumo: object({
    mode: literal("sumo"),
    sumoVersion: string(),
    networkSha256: string(),
    seed,
    ambientConfig: record(passthrough<unknown>()),
    configSha256: string(),
    resultSha256: string(),
  }),
});

export const ScenarioSimulationPreviewSchema = object<ScenarioSimulationPreviewDto>({
  artifactId: string(),
  draftVersion: number(),
  sha256: string(),
  sizeBytes: number(),
  mediaType: string(),
  downloadUrl: string(),
  createdAt: string(),
});

/**
 * A reserved upload slot. `uploadUrl` is either absolute (presigned object
 * storage) or same-origin relative (`/api/local-objects/...`): the transport
 * resolves a relative one against the base it is already talking to.
 */
export type UploadReservationDto = {
  artifactId: string;
  uploadRequired: boolean;
  uploadUrl: string | null;
  headers: Record<string, string>;
};

export const UploadReservationSchema = object<UploadReservationDto>({
  artifactId: string(),
  uploadRequired: boolean(),
  uploadUrl: nullable(string()),
  headers: record(string()),
});

// ── Request bodies ───────────────────────────────────────────────────────────

export type ListDocumentSummariesQuery = { datasetId: string; limit: number; cursor?: string };

export type CreateDocumentRequest = {
  title: string;
  description?: string;
  schemaVersion: string;
  content: ScenarioTemplateV2;
  mapVersionId: string | null;
  datasetId: string;
  authoringQualityId: ScenarioAuthoringQuality;
};

/** `PATCH documents/:id` — content and metadata share one route, gated on `expectedVersion`. */
export type UpdateDocumentRequest = {
  expectedVersion: number;
  title?: string;
  description?: string;
  content?: ScenarioTemplateV2;
  authoringQualityId?: ScenarioAuthoringQuality;
};

export type DuplicateDocumentRequest = { title?: string; datasetId?: string };
export type DriverInTheLoopRequest = { roleId?: string };
export type DriverInTheLoopResponse = { document: ScenarioDocumentDto; roleId: string };

export type TransferDocumentRequest = {
  targetMapVersionId: string;
  siteId: string;
  title?: string;
  signalPlanDecision?: "remove" | "accept-proposal";
};
export type TransferOptionsRequest = { targetMapVersionIds?: string[] };
export type PortableLiftIssueDto = {
  code: string;
  severity: "error" | "warning" | "info";
  path?: string;
  message: string;
};
export type ScenarioTransferMapOptionDto = {
  mapVersionId: string;
  sourceMapId: string;
  label: string;
  locality: string | null;
  siteIds: string[];
};
export type ScenarioTransferOptionsDto = {
  sourceMapVersionId: string | null;
  sourceSiteId: string | null;
  lift: { ok: boolean; issues: PortableLiftIssueDto[] };
  maps: ScenarioTransferMapOptionDto[];
};

export type CreateTagRequest = { label: string; color?: string | null };
export type UpdateTagRequest = { label?: string; color?: string | null };
export type SetDocumentTagsRequest = { tagIds: string[] };

export type UpsertDocumentRatingRequest = {
  score: number;
  revisionId?: string | null;
  reviewedVia?: "queue" | "browser";
};
export type ListRatingAggregatesRequest = { documentIds: string[] };

export type CreateRevisionRequest = ScenarioRevisionEvidenceDto & {
  expectedVersion: number;
  idempotencyKey: string;
};

export type ReserveSimulationPreviewRequest = { expectedVersion: number; sha256: string; sizeBytes: number };
export type CompleteSimulationPreviewRequest = ReserveSimulationPreviewRequest & { artifactId: string };

export type ReserveMaterializedTrafficRequest = Omit<ScenarioMaterializedTrafficReferenceDto, "artifactId"> & {
  expectedVersion: number;
};
export type CompleteMaterializedTrafficRequest = ScenarioMaterializedTrafficReferenceDto;

// ── Endpoints ────────────────────────────────────────────────────────────────

const DOCUMENTS = "/api/simforge/documents" as const;
const TAGS = "/api/simforge/tags" as const;
const document = ({ documentId }: { documentId: string }) => `${DOCUMENTS}/${encodeURIComponent(documentId)}` as const;
const tag = ({ tagId }: { tagId: string }) => `${TAGS}/${encodeURIComponent(tagId)}` as const;

/**
 * `documents` group, protocol v1: documents, their organizational tags,
 * ratings, revisions and the two reserve/complete upload handshakes. The byte
 * upload itself is a `PUT` to the reservation's `uploadUrl`, not an endpoint here.
 */
export const documentsProtocol = {
  listSummaries: endpoint<void, ListDocumentSummariesQuery, void, ScenarioDocumentSummaryPageDto>({
    method: "GET",
    path: `${DOCUMENTS}/summaries`,
    response: ScenarioDocumentSummaryPageSchema,
  }),
  list: endpoint<void, { datasetId: string }, void, { documents: ScenarioDocumentDto[] }>({
    method: "GET",
    path: DOCUMENTS,
    response: object({ documents: array(ScenarioDocumentSchema) }),
  }),
  get: endpoint<{ documentId: string }, void, void, ScenarioDocumentDto>({
    method: "GET",
    path: document,
    response: ScenarioDocumentSchema,
  }),
  create: endpoint<void, void, CreateDocumentRequest, ScenarioDocumentDto>({
    method: "POST",
    path: DOCUMENTS,
    response: ScenarioDocumentSchema,
  }),
  update: endpoint<{ documentId: string }, void, UpdateDocumentRequest, ScenarioDocumentDto>({
    method: "PATCH",
    path: document,
    response: ScenarioDocumentSchema,
  }),
  delete: endpoint<{ documentId: string }, void, void, { ok: true }>({
    method: "DELETE",
    path: document,
    response: object({ ok: literal(true) }),
  }),
  duplicate: endpoint<{ documentId: string }, void, DuplicateDocumentRequest, ScenarioDocumentDto>({
    method: "POST",
    path: (params) => `${document(params)}/duplicate`,
    response: ScenarioDocumentSchema,
  }),
  transfer: endpoint<{ documentId: string }, void, TransferDocumentRequest, ScenarioDocumentDto>({
    method: "POST",
    path: (params) => `${document(params)}/transfer`,
    response: ScenarioDocumentSchema,
  }),
  transferOptions: endpoint<
    { documentId: string },
    void,
    TransferOptionsRequest,
    ScenarioTransferOptionsDto
  >({
    method: "POST",
    path: (params) => `${document(params)}/transfer-options`,
    response: object({
      sourceMapVersionId: nullable(string()),
      sourceSiteId: nullable(string()),
      lift: object({
        ok: boolean(),
        issues: array(object({
          code: string(),
          severity: oneOf(["error", "warning", "info"] as const),
          path: optional(string()),
          message: string(),
        })),
      }),
      maps: array(object({
        mapVersionId: string(),
        sourceMapId: string(),
        label: string(),
        locality: nullable(string()),
        siteIds: array(string()),
      })),
    }),
  }),
  startDriverInTheLoop: endpoint<{ documentId: string }, void, DriverInTheLoopRequest, DriverInTheLoopResponse>({
    method: "POST",
    path: (params) => `${document(params)}/driver-in-the-loop`,
    response: object({ document: ScenarioDocumentSchema, roleId: string() }),
  }),

  listTags: endpoint<void, void, void, { tags: ScenarioTagDto[] }>({
    method: "GET",
    path: TAGS,
    response: object({ tags: array(ScenarioTagSchema) }),
  }),
  createTag: endpoint<void, void, CreateTagRequest, ScenarioTagDto>({
    method: "POST",
    path: TAGS,
    response: ScenarioTagSchema,
  }),
  updateTag: endpoint<{ tagId: string }, void, UpdateTagRequest, ScenarioTagDto>({
    method: "PATCH",
    path: tag,
    response: ScenarioTagSchema,
  }),
  deleteTag: endpoint<{ tagId: string }, void, void, { ok: true }>({
    method: "DELETE",
    path: tag,
    response: object({ ok: literal(true) }),
  }),
  setTags: endpoint<{ documentId: string }, void, SetDocumentTagsRequest, { tags: ScenarioTagDto[] }>({
    method: "PUT",
    path: (params) => `${document(params)}/tags`,
    response: object({ tags: array(ScenarioTagSchema) }),
  }),

  listRatingAggregates: endpoint<void, void, ListRatingAggregatesRequest, { aggregates: ScenarioRatingAggregateDto[] }>({
    method: "POST",
    path: `${DOCUMENTS}/ratings/batch`,
    response: object({ aggregates: array(ScenarioRatingAggregateSchema) }),
  }),
  setRating: endpoint<
    { documentId: string },
    void,
    UpsertDocumentRatingRequest,
    { rating: ScenarioDocumentRatingDto; aggregate: ScenarioRatingAggregateDto | null }
  >({
    method: "PUT",
    path: (params) => `${document(params)}/rating`,
    response: object({ rating: ScenarioDocumentRatingSchema, aggregate: nullable(ScenarioRatingAggregateSchema) }),
  }),
  clearRating: endpoint<{ documentId: string }, void, void, { ok: true; aggregate: ScenarioRatingAggregateDto | null }>({
    method: "DELETE",
    path: (params) => `${document(params)}/rating`,
    response: object({ ok: literal(true), aggregate: nullable(ScenarioRatingAggregateSchema) }),
  }),

  listRevisions: endpoint<{ documentId: string }, void, void, { revisions: ScenarioRevisionDto[] }>({
    method: "GET",
    path: (params) => `${document(params)}/revisions`,
    response: object({ revisions: array(ScenarioRevisionSchema) }),
  }),
  createRevision: endpoint<{ documentId: string }, void, CreateRevisionRequest, CreateScenarioRevisionResultDto>({
    method: "POST",
    path: (params) => `${document(params)}/revisions`,
    response: CreateScenarioRevisionResultSchema,
  }),

  /** A readable document with no current generated preview answers JSON null. */
  getSimulationPreview: endpoint<{ documentId: string }, void, void, ScenarioSimulationPreviewDto | null>({
    method: "GET",
    path: (params) => `${document(params)}/simulation-preview`,
    response: nullable(ScenarioSimulationPreviewSchema),
  }),
  reserveSimulationPreview: endpoint<{ documentId: string }, void, ReserveSimulationPreviewRequest, UploadReservationDto>({
    method: "POST",
    path: (params) => `${document(params)}/simulation-preview`,
    response: UploadReservationSchema,
  }),
  completeSimulationPreview: endpoint<{ documentId: string }, void, CompleteSimulationPreviewRequest, { ok: true }>({
    method: "POST",
    path: (params) => `${document(params)}/simulation-preview/complete`,
    response: object({ ok: literal(true) }),
  }),

  reserveMaterializedTraffic: endpoint<
    { documentId: string },
    void,
    ReserveMaterializedTrafficRequest,
    UploadReservationDto
  >({
    method: "POST",
    path: (params) => `${document(params)}/materialized-traffic/reserve`,
    response: UploadReservationSchema,
  }),
  completeMaterializedTraffic: endpoint<
    { documentId: string },
    void,
    CompleteMaterializedTrafficRequest,
    ScenarioMaterializedTrafficReferenceDto
  >({
    method: "POST",
    path: (params) => `${document(params)}/materialized-traffic/complete`,
    response: ScenarioMaterializedTrafficReferenceSchema,
  }),
} as const;
