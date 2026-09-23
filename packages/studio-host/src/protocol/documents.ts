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
  type ScenarioRevisionMotionDto,
  type ScenarioRevisionResimulationDto,
  type ScenarioSimulationPreviewDto,
  type ScenarioSimulationResultDto,
  type ScenarioSimulationStatusDto,
  type ScenarioSimulationVerificationDto,
  type ScenarioTagDto,
  type ScenarioEngineChangeDto,
  type ScenarioMapDescriptorDto,
  type ScenarioMapPinStatusDto,
  type ScenarioMapRepinPreviewDto,
  type ScenarioMapMoveResultDto,
  type ScenarioVersionsDto,
  type SimulationComparisonDto,
  type SimulationMotionDiffDto,
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
  tuple,
  union,
} from "./schema";

// ── DTO decoders ─────────────────────────────────────────────────────────────

const ScenarioTransferPreviewSchema = object<ScenarioTransferPreviewDto>({
  viewBox: tuple([number(), number(), number(), number()] as const),
  lanes: array(object({
    kind: oneOf(["drive", "walk", "park"] as const),
    width: number(),
    d: string(),
  })),
  route: nullable(string()),
  actors: array(object({
    id: string(),
    kind: oneOf(["subject", "vehicle", "vru", "object"] as const),
    x: number(),
    y: number(),
    rotateDeg: number(),
    length: number(),
    width: number(),
  })),
});

const ScenarioTransferCandidateSchema = object<ScenarioTransferCandidateDto>({
  siteId: string(),
  rank: number(),
  score: number(),
  verdict: oneOf(["exact", "degraded"] as const),
  summary: string(),
  offRoadActors: number(),
  preview: nullable(ScenarioTransferPreviewSchema),
});

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
  mapSourceMapId: optional(nullable(string())),
  mapXodrSha256: optional(nullable(string())),
  mapClosureSha256: optional(nullable(string())),
  assetCatalogVersionId: optional(nullable(string())),
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
  /** Explicit re-pin to another immutable map version (see `resolveScenarioMap`). */
  mapVersionId?: string;
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
export type TransferOptionsRequest = {
  /** Match only these target maps. Omitted: every published map except the source's. */
  targetMapVersionIds?: string[];
  /**
   * `false` lifts the source and lists the target maps without matching any of
   * them, so a client can show the maps at once and fill each one as its own
   * request returns. Omitted or `true`: every listed map carries candidates.
   */
  candidates?: boolean;
};
export type PortableLiftIssueDto = {
  code: string;
  severity: "error" | "warning" | "info";
  path?: string;
  message: string;
};
/**
 * A 2D schematic of one candidate placement: the target map's lanes around the
 * site and the scenario's actors where the compiler materializes them there.
 *
 * Units are metres in the scene frame (`x` east, `y` = scene `z`, south), so it
 * draws straight into an SVG whose y axis points down. Paths are SVG path data
 * relative to the same frame as `viewBox`.
 */
export type ScenarioTransferPreviewDto = {
  viewBox: [number, number, number, number];
  /** Lane ribbons, one path per lane class and width, stroked at `width` metres. */
  lanes: Array<{ kind: "drive" | "walk" | "park"; width: number; d: string }>;
  /** The subject's route from its start, when the scenario gives it one. */
  route: string | null;
  actors: Array<{
    id: string;
    kind: "subject" | "vehicle" | "vru" | "object";
    x: number;
    y: number;
    /** Heading in degrees, clockwise on screen, 0 = east: an SVG `rotate()` angle. */
    rotateDeg: number;
    length: number;
    width: number;
  }>;
};
/** One vetted place a scenario can be transferred to on one map. */
export type ScenarioTransferCandidateDto = {
  siteId: string;
  /** 1-based rank of this site among the map's candidates, best first. */
  rank: number;
  /** Matcher score, 0..1. */
  score: number;
  /** `exact`: nothing was relaxed; `degraded`: presentation was relaxed, never intent. */
  verdict: "exact" | "degraded";
  /** Plain-language account of what was relaxed, empty when nothing was. */
  summary: string;
  /** Road actors the compiler placed off every lane at this site. */
  offRoadActors: number;
  preview: ScenarioTransferPreviewDto | null;
};
export type ScenarioTransferMapOptionDto = {
  mapVersionId: string;
  sourceMapId: string;
  label: string;
  locality: string | null;
  /** The candidates' site ids, best first. Empty until the map is matched. */
  siteIds: string[];
  /** Present once the map has been matched; absent from a `candidates: false` listing. */
  candidates?: ScenarioTransferCandidateDto[];
  /** Why this map could not be matched; the other maps are unaffected. */
  error?: string | null;
  /**
   * Whose failure `error` is. `scenario`: the scenario itself cannot be placed
   * anywhere (it does not compile), so every other map will say the same and
   * a client can stop asking; `map`: this map only.
   */
  errorScope?: "scenario" | "map" | null;
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

/**
 * A revision commit names only the draft version it freezes; the host binds
 * the authoritative simulation's traffic evidence itself.
 */
export type CreateRevisionRequest = {
  expectedVersion: number;
  idempotencyKey: string;
};

export type ResolveSimulationRequest = { expectedVersion?: number; waitMs?: number };
/**
 * The draft's authoritative simulation. `engineChange` is set when the draft is unchanged but its
 * result moved (an engine upgrade) and the motion differs: the editor offers to keep the old motion.
 */
export type SaveVersionRequest = { expectedVersion: number; label?: string | null };
export type KeepPreviousMotionRequest = { expectedVersion: number; previousSimKey: string; currentSimKey: string };
export type AcceptDraftSimulationRequest = { expectedVersion: number; simKey: string };
export type ResimulateVersionRequest = { waitMs?: number };
export type SetActiveSimulationRequest = { simKey: string };
export type RestoreVersionRequest = { expectedVersion: number };
export type MapRepinPreviewRequest = { targetMapVersionId: string; waitMs?: number };
export type MapMoveRequest = { expectedVersion: number; targetMapVersionId: string };
export type VersionContentDto = { revisionId: string; contentSha256: string; mapVersionId: string | null; content: ScenarioTemplateV2 };
export type ResimulateVersionResultDto = { status: ScenarioSimulationStatusDto; motionDiff: SimulationMotionDiffDto | null };
export type MapPinStatusResponse = ScenarioMapPinStatusDto & { pinnedDescriptor: ScenarioMapDescriptorDto | null };
export type DraftSimulationStatusDto = ScenarioSimulationStatusDto & { draftVersion: number; engineChange?: ScenarioEngineChangeDto | null };
export type SimulationVerificationOutcomeDto = { outcome: "verified" | "mismatch"; authoritativeTraceSha256: string };
/** The native evaluation of one authoritative trace (`TraceEvaluation` from `@simforge-oss/engine`). */
export type SimulationEvaluationDto = { simKey: string; traceSha256: string; evaluation: Record<string, unknown> & { verdict: "accept" | "reject" } };

// ── Endpoints ────────────────────────────────────────────────────────────────

const DOCUMENTS = "/api/simforge/documents" as const;
const TAGS = "/api/simforge/tags" as const;
const SIMULATIONS = "/api/simforge/simulations" as const;
const document = ({ documentId }: { documentId: string }) => `${DOCUMENTS}/${encodeURIComponent(documentId)}` as const;
const tag = ({ tagId }: { tagId: string }) => `${TAGS}/${encodeURIComponent(tagId)}` as const;

/**
 * `documents` group, protocol v1: documents, their organizational tags,
 * ratings, revisions and authoritative simulations. The client uploads nothing
 * for a simulation or a revision: the host computes both.
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
        candidates: optional(array(ScenarioTransferCandidateSchema)),
        error: optional(nullable(string())),
        errorScope: optional(nullable(oneOf(["scenario", "map"] as const))),
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

  /**
   * The authoritative simulation of the document's current draft, resolved by
   * the host (memoized by content, joined when in flight, executed inline or
   * on a CPU runner). The client sends only the draft version it shows.
   */
  resolveSimulation: endpoint<{ documentId: string }, void, ResolveSimulationRequest, DraftSimulationStatusDto>({
    method: "POST",
    path: (params) => `${document(params)}/simulation`,
    response: passthrough<DraftSimulationStatusDto>(),
  }),
  // ── Versions (simulation history) ──────────────────────────────────────────
  /** Every version of the document with its simulations, newest first. */
  listVersions: endpoint<{ documentId: string }, void, void, ScenarioVersionsDto>({
    method: "GET",
    path: (params) => `${document(params)}/versions`,
    response: passthrough<ScenarioVersionsDto>(),
  }),
  /** "Save version": freeze the draft (simulated under the current engine) as a named version. */
  saveVersion: endpoint<{ documentId: string }, void, SaveVersionRequest, CreateScenarioRevisionResultDto>({
    method: "POST",
    path: (params) => `${document(params)}/versions`,
    response: CreateScenarioRevisionResultSchema,
  }),
  /** "Keep the old motion as a version" after an engine change. */
  keepPreviousMotion: endpoint<{ documentId: string }, void, KeepPreviousMotionRequest, CreateScenarioRevisionResultDto>({
    method: "POST",
    path: (params) => `${document(params)}/versions/keep-previous-motion`,
    response: CreateScenarioRevisionResultSchema,
  }),
  /** "Use the new motion": the draft now shows the current engine's result (dismisses the banner). */
  acceptDraftSimulation: endpoint<{ documentId: string }, void, AcceptDraftSimulationRequest, { ok: true }>({
    method: "POST",
    path: (params) => `${document(params)}/simulation/accept`,
    response: passthrough<{ ok: true }>(),
  }),
  resimulateVersion: endpoint<{ documentId: string; revisionId: string }, void, ResimulateVersionRequest, ResimulateVersionResultDto>({
    method: "POST",
    path: ({ documentId, revisionId }) => `${document({ documentId })}/versions/${encodeURIComponent(revisionId)}/resimulate`,
    response: passthrough<ResimulateVersionResultDto>(),
  }),
  /** "Use this simulation": move the version's active simulation (what its renders replay). */
  setVersionActiveSimulation: endpoint<{ documentId: string; revisionId: string }, void, SetActiveSimulationRequest, { ok: true }>({
    method: "PUT",
    path: ({ documentId, revisionId }) => `${document({ documentId })}/versions/${encodeURIComponent(revisionId)}/active-simulation`,
    response: passthrough<{ ok: true }>(),
  }),
  getVersionContent: endpoint<{ documentId: string; revisionId: string }, void, void, VersionContentDto>({
    method: "GET",
    path: ({ documentId, revisionId }) => `${document({ documentId })}/versions/${encodeURIComponent(revisionId)}/content`,
    response: passthrough<VersionContentDto>(),
  }),
  /** Restore a version onto the draft on the server (used when it also moves the draft's map pin). */
  restoreVersion: endpoint<{ documentId: string; revisionId: string }, void, RestoreVersionRequest, ScenarioDocumentDto>({
    method: "POST",
    path: ({ documentId, revisionId }) => `${document({ documentId })}/versions/${encodeURIComponent(revisionId)}/restore`,
    response: passthrough<ScenarioDocumentDto>(),
  }),
  /** Both simulations side by side with their motion diff. */
  compareSimulations: endpoint<void, { base: string; candidate: string }, void, SimulationComparisonDto>({
    method: "GET",
    path: `${SIMULATIONS}/compare`,
    response: passthrough<SimulationComparisonDto>(),
  }),
  /** The draft's map pin, its descriptor, and any newer publication it may explicitly move to. */
  getMapPinStatus: endpoint<{ documentId: string }, void, void, MapPinStatusResponse>({
    method: "GET",
    path: (params) => `${document(params)}/map-pin`,
    response: passthrough<MapPinStatusResponse>(),
  }),
  /** Move the draft to another map version; the state before the move is saved as a version first. */
  moveToMapVersion: endpoint<{ documentId: string }, void, MapMoveRequest, ScenarioMapMoveResultDto>({
    method: "POST",
    path: (params) => `${document(params)}/map-pin/move`,
    response: passthrough<ScenarioMapMoveResultDto>(),
  }),
  /** Simulate the draft on another map version and diff it against what the draft shows now. */
  previewMapRepin: endpoint<{ documentId: string }, void, MapRepinPreviewRequest, ScenarioMapRepinPreviewDto>({
    method: "POST",
    path: (params) => `${document(params)}/map-pin/preview`,
    response: passthrough<ScenarioMapRepinPreviewDto>(),
  }),
  /** One immutable authoritative result by `simKey`. */
  getSimulation: endpoint<{ simKey: string }, void, void, ScenarioSimulationResultDto>({
    method: "GET",
    path: ({ simKey }) => `${SIMULATIONS}/${encodeURIComponent(simKey)}`,
    response: passthrough<ScenarioSimulationResultDto>(),
  }),
  /** Report the editor's local preview digest against the authoritative result (telemetry). */
  verifySimulation: endpoint<{ simKey: string }, void, ScenarioSimulationVerificationDto, SimulationVerificationOutcomeDto>({
    method: "POST",
    path: ({ simKey }) => `${SIMULATIONS}/${encodeURIComponent(simKey)}/verification`,
    response: passthrough<SimulationVerificationOutcomeDto>(),
  }),
  /** Grade the authoritative trace by key with the native evaluator (never re-simulates). */
  evaluateSimulation: endpoint<{ simKey: string }, void, { filters?: Record<string, unknown> }, SimulationEvaluationDto>({
    method: "POST",
    path: ({ simKey }) => `${SIMULATIONS}/${encodeURIComponent(simKey)}/evaluation`,
    response: passthrough<SimulationEvaluationDto>(),
  }),
  /**
   * Which motion a revision's renders replay: its active (original) result
   * under whatever engine produced it, the other stored results and whether
   * the legacy OpenSCENARIO replay exists. Never simulates.
   */
  getRevisionMotion: endpoint<{ revisionId: string }, void, void, ScenarioRevisionMotionDto>({
    method: "GET",
    path: ({ revisionId }) => `/api/simforge/revisions/${encodeURIComponent(revisionId)}/simulation`,
    response: passthrough<ScenarioRevisionMotionDto>(),
  }),
  /**
   * Explicitly re-simulate a revision under the current engine. Adds a result
   * to the revision (it does not change which one renders by default) and
   * reports the motion diff against the active result.
   */
  resimulateRevision: endpoint<{ revisionId: string }, void, { action: "resimulate"; waitMs?: number }, ScenarioRevisionResimulationDto>({
    method: "POST",
    path: ({ revisionId }) => `/api/simforge/revisions/${encodeURIComponent(revisionId)}/simulation`,
    response: passthrough<ScenarioRevisionResimulationDto>(),
  }),
} as const;
