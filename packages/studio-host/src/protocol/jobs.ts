import type { RenderSpecV3 } from "@simforge-oss/scenario";
import {
  OPENSCENARIO_NATIVE_PROFILE,
  SCENARIO_JOB_FAMILIES,
  SCENARIO_JOB_MODES,
  SCENARIO_RENDER_JOB_MODES,
  SCENARIO_RENDERER_ENGINES,
  type PresignedArtifact,
  type ScenarioExportDto,
  type ScenarioExportInspectionDto,
  type ScenarioGalleryItemDto,
  type ScenarioJobEventDto,
  type ScenarioJobFamily,
  type ScenarioJobProvenanceDto,
  type ScenarioOperationalJobBase,
  type ScenarioOperationalJobDto,
  type RevisionBoundJobFamily,
  type ScenarioPostprocessInput,
  type ScenarioPresignedArtifactDto,
  type ScenarioRenderAttemptDto,
  type ScenarioRenderIntentSubmission,
  type ScenarioRenderJobDetailDto,
  type ScenarioRenderJobDto,
  type ScenarioRenderJobMode,
  type ScenarioRenderJobStatus,
  type ScenarioRenderProgressDto,
  type ScenarioValidationRunDto,
} from "../contracts";
import { ScenarioExportStatusSchema } from "./documents";
import { endpoint } from "./endpoint";
import { ScenarioArtifactIdentitySchema, ScenarioRenderArtifactSchema, renderArtifactShape } from "./maps";
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

const RENDER_JOB_STATUSES = ["queued", "leased", "running", "succeeded", "failed", "cancelled"] as const satisfies readonly ScenarioRenderJobStatus[];
const RENDER_JOB_MODES = SCENARIO_RENDER_JOB_MODES;
const RENDER_STAGES = ["downloading", "preparing", "rendering", "encoding", "uploading", "finalizing"] as const;

export const ScenarioRenderJobSchema = object<ScenarioRenderJobDto>({
  id: string(),
  revisionId: string(),
  executionPackageId: string(),
  originRecordingJobId: nullable(string()),
  mode: oneOf(SCENARIO_JOB_MODES),
  status: oneOf(RENDER_JOB_STATUSES),
  progress: number(),
  billingMode: literal("free"),
  estimatedCost: literal(0),
  /** Owned by `@simforge-oss/scenario` (`render-spec/v3`). */
  renderSpec: nullable(passthrough<RenderSpecV3>()),
  telemetry: object({
    gpuSeconds: optional(number()),
    wallSeconds: optional(number()),
    storageBytes: optional(number()),
    outputBytes: optional(number()),
  }),
  parityResult: nullable(record(passthrough<unknown>())),
  parityEvidence: nullable(record(passthrough<unknown>())),
  resourceRequest: nullable(record(passthrough<unknown>())),
  workerAttestation: nullable(record(passthrough<unknown>())),
  failureCode: nullable(string()),
  failureDetail: passthrough<unknown>(),
  createdAt: string(),
  updatedAt: string(),
});

const operationalJobBase = {
  id: string(),
  type: string(),
  status: string(),
  priority: number(),
  progress: number(),
  attemptCount: number(),
  maxAttempts: number(),
  cancelRequestedAt: nullable(string()),
  failureCode: nullable(string()),
  failureDetail: passthrough<unknown>(),
  createdAt: string(),
  updatedAt: string(),
  startedAt: nullable(string()),
  completedAt: nullable(string()),
};

const revisionBoundJob = <F extends RevisionBoundJobFamily>(family: F) =>
  object<ScenarioOperationalJobBase & { family: F; revisionId: string }>({ ...operationalJobBase, family: literal(family), revisionId: string() });

export const ScenarioOperationalJobSchema = discriminated<"family", ScenarioOperationalJobDto>("family", {
  openscenario_compile: revisionBoundJob("openscenario_compile"),
  openscenario_validate: revisionBoundJob("openscenario_validate"),
  openscenario_render: revisionBoundJob("openscenario_render"),
  artifact_postprocess: object({ ...operationalJobBase, family: literal("artifact_postprocess"), revisionId: nullable(string()) }),
});

export const ScenarioJobProvenanceSchema = object<ScenarioJobProvenanceDto>({
  documentId: string(),
  revisionId: string(),
  revisionNumber: number(),
  sourceRevisionSha256: string(),
  sourceInputDigest: nullable(string()),
  openScenarioProfile: literal(OPENSCENARIO_NATIVE_PROFILE),
  compilerVersion: string(),
  validationStatus: nullable(string()),
  xoscArtifactId: string(),
  xoscSha256: string(),
  executionPackageId: string(),
  executionPackageSha256: string(),
  mapVersionId: string(),
  xodrSha256: string(),
  assetCatalogSha256: nullable(string()),
  coordinateSystemId: string(),
  coordinateSystemSha256: string(),
  ambient: record(passthrough<unknown>()),
  capabilityWarnings: array(passthrough<unknown>()),
  artifacts: array(
    object({
      id: string(),
      kind: string(),
      sha256: string(),
      sizeBytes: number(),
      mediaType: string(),
      metadata: record(passthrough<unknown>()),
    }),
  ),
  events: array(object({ sequence: number(), type: string(), occurredAt: string(), payload: record(passthrough<unknown>()) })),
});

const progressBase = {
  schema: string(),
  jobId: string(),
  attempt: number(),
  sequence: number(),
  timestamp: string(),
};

export const ScenarioRenderProgressSchema = discriminated<"event", ScenarioRenderProgressDto>("event", {
  "job.started": object({ ...progressBase, event: literal("job.started") }),
  "stage.started": object({ ...progressBase, event: literal("stage.started"), stage: oneOf(RENDER_STAGES) }),
  "stage.progress": object({
    ...progressBase,
    event: literal("stage.progress"),
    stage: oneOf(RENDER_STAGES),
    completed: number(),
    total: number(),
    unit: oneOf(["frames", "bytes", "items", "seconds"] as const),
    downloadedBytes: optional(number()),
    totalBytes: optional(number()),
  }),
  "artifact.ready": object({
    ...progressBase,
    event: literal("artifact.ready"),
    identity: ScenarioArtifactIdentitySchema,
    sha256: string(),
    sizeBytes: number(),
    mediaType: string(),
  }),
  warning: object({ ...progressBase, event: literal("warning"), code: string(), message: string() }),
  "job.canceled": object({ ...progressBase, event: literal("job.canceled"), reason: string() }),
});

export const ScenarioRenderAttemptSchema = object<ScenarioRenderAttemptDto>({
  id: string(),
  attemptNumber: number(),
  executionPackageControlSha256: string(),
  status: string(),
  attemptState: string(),
  workerNodeId: string(),
  workerClass: string(),
  runtimeVersion: nullable(string()),
  rendererEngine: nullable(oneOf(SCENARIO_RENDERER_ENGINES)),
  baseImageDigest: nullable(string()),
  baseImagePlatformDigest: nullable(string()),
  engineCapabilitiesSha256: nullable(string()),
  imageDigest: nullable(string()),
  leasedAt: string(),
  startedAt: nullable(string()),
  completedAt: nullable(string()),
});

export const ScenarioJobEventSchema = object<ScenarioJobEventDto>({
  eventOrdinal: number(),
  eventKind: string(),
  attemptId: nullable(string()),
  detail: literal(null),
  createdAt: string(),
});

export const ScenarioRenderJobDetailSchema = object<ScenarioRenderJobDetailDto>({
  id: string(),
  revisionId: string(),
  executionPackageId: string(),
  executionPackageControlSha256: string(),
  renderProfileId: nullable(string()),
  jobMode: oneOf(RENDER_JOB_MODES),
  jobState: oneOf(RENDER_JOB_STATUSES),
  progressPercent: nullable(number()),
  progressDetail: nullable(ScenarioRenderProgressSchema),
  progressRecords: optional(array(ScenarioRenderProgressSchema)),
  rendererEngine: nullable(oneOf(SCENARIO_RENDERER_ENGINES)),
  intentSha256: nullable(string()),
  priority: number(),
  attemptCount: number(),
  maxAttempts: number(),
  failureCode: nullable(string()),
  failureDetail: nullable(string()),
  billingMode: string(),
  estimatedCostCents: number(),
  renderSpecSha256: string(),
  hiddenAt: nullable(string()),
  hiddenByUserId: nullable(string()),
  parentRenderJobId: nullable(string()),
  sourceArtifactId: nullable(string()),
  modelFamily: nullable(string()),
  modelConfigSha256: nullable(string()),
  createdAt: string(),
  updatedAt: string(),
  startedAt: nullable(string()),
  completedAt: nullable(string()),
  cancelRequestedAt: nullable(string()),
  attempts: array(ScenarioRenderAttemptSchema),
  events: array(ScenarioJobEventSchema),
  artifacts: array(ScenarioRenderArtifactSchema),
});

/** `url` is a string with a TTL only when the artifact is `available`; every other state ships `url: null`. */
export const PresignedArtifactSchema = union([
  object<ScenarioPresignedArtifactDto>({ ...renderArtifactShape, url: string(), expiresInSeconds: number() }),
  object<ScenarioRenderArtifactSchemaWithNullUrl>({ ...renderArtifactShape, url: literal(null) }),
]);
type ScenarioRenderArtifactSchemaWithNullUrl = Extract<PresignedArtifact, { url: null }>;

export const ScenarioGalleryItemSchema = object<ScenarioGalleryItemDto>({
  id: string(),
  revisionId: string(),
  documentId: nullable(string()),
  jobMode: oneOf(RENDER_JOB_MODES),
  rendererEngine: nullable(oneOf(SCENARIO_RENDERER_ENGINES)),
  jobState: oneOf(RENDER_JOB_STATUSES),
  progressPercent: nullable(number()),
  failureCode: nullable(string()),
  attemptCount: number(),
  createdAt: string(),
  completedAt: nullable(string()),
  parentRenderJobId: nullable(string()),
  modelFamily: nullable(string()),
  revisionContentSha256: nullable(string()),
  revisionSourceDraftVersion: nullable(number()),
  artifactCount: number(),
  previewArtifactId: nullable(string()),
  previewMediaType: nullable(string()),
});

export const ScenarioExportSchema = object<ScenarioExportDto>({
  id: string(),
  revisionId: string(),
  format: literal("openscenario_xml_1_4"),
  status: ScenarioExportStatusSchema,
  artifactId: nullable(string()),
  executionPackageId: nullable(string()),
  compilerVersion: string(),
  errorCode: nullable(string()),
  errorDetail: passthrough<unknown>(),
  createdAt: string(),
  startedAt: nullable(string()),
  completedAt: nullable(string()),
});

export const ScenarioExportInspectionSchema = object<ScenarioExportInspectionDto>({
  exportId: string(),
  revisionId: string(),
  executionPackageId: string(),
  executionPackageSha256: string(),
  compilerVersion: string(),
  capabilityProfile: string(),
  xoscArtifactId: string(),
  xoscSha256: string(),
  xsdValidation: object({ valid: boolean(), standard: string(), xsdSha256: string(), diagnostics: array(string()) }),
  capability: object({
    contract: string(),
    profile: string(),
    intent: string(),
    roundTrip: string(),
    externalSimulatorValidation: string(),
    summary: record(number()),
    warningCount: number(),
    warnings: array(object({ code: string(), path: string(), reason: string() })),
  }),
});

export const ScenarioValidationRunSchema = object<ScenarioValidationRunDto>({
  id: string(),
  revision_id: string(),
  validator_kind: string(),
  validator_version: string(),
  validation_state: string(),
  report_artifact_id: nullable(string()),
  trace_artifact_id: nullable(string()),
  summary: nullable(record(passthrough<unknown>())),
  created_at: string(),
  started_at: nullable(string()),
  completed_at: nullable(string()),
});

// ── Requests ─────────────────────────────────────────────────────────────────

export type ListGalleryQuery = {
  revisionId?: string | null;
  documentId?: string | null;
  jobMode?: ScenarioRenderJobMode | null;
  limit?: number;
};
export type GalleryPageDto = { items: ScenarioGalleryItemDto[]; hiddenCount: number };

/** The parent is the path segment, never part of the body. */
export type CreatePostprocessRequest = Omit<ScenarioPostprocessInput, "parentRenderJobId">;
export type PostprocessCreatedDto = { id: string; created: boolean };

/** `urlTtlSeconds` is the signature lifetime every `url` in `items` was minted with. */
export type RenderJobDownloadsDto = { items: PresignedArtifact[]; urlTtlSeconds: number };

export type SetRenderJobHiddenRequest = { hidden: boolean };
export type RenderJobHiddenDto = { id: string; hiddenAt: string | null; hiddenByUserId: string | null };

export type PrepareExportRequest = { revisionId: string; idempotencyKey: string };

export type CreateValidationRunRequest = {
  revisionId: string;
  validatorKind: string;
  validatorVersion: string;
  idempotencyKey: string;
};

export type ListOperationalJobsQuery = {
  family?: ScenarioJobFamily | null;
  revisionId?: string | null;
  limit?: number;
};

// ── Endpoints ────────────────────────────────────────────────────────────────

const RENDER_JOBS = "/api/simforge/render-jobs" as const;
const EXPORTS = "/api/simforge/exports" as const;
const JOBS = "/api/simforge/jobs" as const;
const renderJob = ({ jobId }: { jobId: string }) => `${RENDER_JOBS}/${encodeURIComponent(jobId)}` as const;

/**
 * `jobs` group, protocol v1: render jobs and their gallery/detail/downloads,
 * postprocess runs, OpenSCENARIO exports, validation runs and the operational
 * job ledger. Artifact bytes are fetched from the URLs `downloads` mints.
 */
export const jobsProtocol = {
  submitRenderIntent: endpoint<void, void, ScenarioRenderIntentSubmission, ScenarioRenderJobDto>({
    method: "POST",
    path: RENDER_JOBS,
    response: ScenarioRenderJobSchema,
  }),
  getRenderJob: endpoint<{ jobId: string }, void, void, ScenarioRenderJobDto>({
    method: "GET",
    path: renderJob,
    response: ScenarioRenderJobSchema,
  }),
  /** Cancels through the operational ledger, so the answer is the ledger row. */
  cancelRenderJob: endpoint<{ jobId: string }, void, void, ScenarioOperationalJobDto>({
    method: "DELETE",
    path: renderJob,
    response: ScenarioOperationalJobSchema,
  }),
  renderJobProvenance: endpoint<{ jobId: string }, void, void, ScenarioJobProvenanceDto>({
    method: "GET",
    path: (params) => `${renderJob(params)}/provenance`,
    response: ScenarioJobProvenanceSchema,
  }),
  renderJobDetail: endpoint<{ jobId: string }, void, void, ScenarioRenderJobDetailDto>({
    method: "GET",
    path: (params) => `${renderJob(params)}/detail`,
    response: ScenarioRenderJobDetailSchema,
  }),
  /** The only route that mints artifact URLs, scoped to one job. */
  renderJobDownloads: endpoint<{ jobId: string }, void, void, RenderJobDownloadsDto>({
    method: "GET",
    path: (params) => `${renderJob(params)}/downloads`,
    response: object({ items: array(PresignedArtifactSchema), urlTtlSeconds: number() }),
  }),
  gallery: endpoint<void, ListGalleryQuery, void, GalleryPageDto>({
    method: "GET",
    path: `${RENDER_JOBS}/gallery`,
    response: object({ items: array(ScenarioGalleryItemSchema), hiddenCount: number() }),
  }),
  postprocessChildren: endpoint<{ jobId: string }, void, void, { items: ScenarioGalleryItemDto[] }>({
    method: "GET",
    path: (params) => `${renderJob(params)}/postprocess`,
    response: object({ items: array(ScenarioGalleryItemSchema) }),
  }),
  createPostprocess: endpoint<{ jobId: string }, void, CreatePostprocessRequest, PostprocessCreatedDto>({
    method: "POST",
    path: (params) => `${renderJob(params)}/postprocess`,
    response: object({ id: string(), created: boolean() }),
  }),
  setRenderJobHidden: endpoint<{ jobId: string }, void, SetRenderJobHiddenRequest, RenderJobHiddenDto>({
    method: "PATCH",
    path: (params) => `${renderJob(params)}/hidden`,
    response: object({ id: string(), hiddenAt: nullable(string()), hiddenByUserId: nullable(string()) }),
  }),

  prepareExport: endpoint<void, void, PrepareExportRequest, ScenarioExportDto>({
    method: "POST",
    path: EXPORTS,
    response: ScenarioExportSchema,
  }),
  listExports: endpoint<void, { revisionId: string }, void, { exports: ScenarioExportDto[] }>({
    method: "GET",
    path: EXPORTS,
    response: object({ exports: array(ScenarioExportSchema) }),
  }),
  getExport: endpoint<{ exportId: string }, void, void, ScenarioExportDto>({
    method: "GET",
    path: ({ exportId }) => `${EXPORTS}/${encodeURIComponent(exportId)}`,
    response: ScenarioExportSchema,
  }),
  inspectExport: endpoint<{ exportId: string }, void, void, ScenarioExportInspectionDto>({
    method: "GET",
    path: ({ exportId }) => `${EXPORTS}/${encodeURIComponent(exportId)}/inspection`,
    response: ScenarioExportInspectionSchema,
  }),

  listValidationRuns: endpoint<void, { revisionId: string }, void, { validationRuns: ScenarioValidationRunDto[] }>({
    method: "GET",
    path: "/api/simforge/validation-runs",
    response: object({ validationRuns: array(ScenarioValidationRunSchema) }),
  }),
  createValidationRun: endpoint<void, void, CreateValidationRunRequest, ScenarioValidationRunDto>({
    method: "POST",
    path: "/api/simforge/validation-runs",
    response: ScenarioValidationRunSchema,
  }),

  listOperationalJobs: endpoint<void, ListOperationalJobsQuery, void, { jobs: ScenarioOperationalJobDto[] }>({
    method: "GET",
    path: JOBS,
    response: object({ jobs: array(ScenarioOperationalJobSchema) }),
  }),
  getOperationalJob: endpoint<{ jobId: string }, void, void, ScenarioOperationalJobDto>({
    method: "GET",
    path: ({ jobId }) => `${JOBS}/${encodeURIComponent(jobId)}`,
    response: ScenarioOperationalJobSchema,
  }),
  cancelOperationalJob: endpoint<{ jobId: string }, void, void, ScenarioOperationalJobDto>({
    method: "DELETE",
    path: ({ jobId }) => `${JOBS}/${encodeURIComponent(jobId)}`,
    response: ScenarioOperationalJobSchema,
  }),
} as const;
