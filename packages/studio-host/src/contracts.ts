/**
 * Wire DTOs of the Studio host-service boundary.
 *
 * These are the shapes the `/api/simforge/*` routes return to the shared React
 * workflows, whether the host is local Studio (Next/Node/PGlite/filesystem) or
 * SimCloud (accounts, organizations, managed capacity). The host apps validate
 * inbound request bodies with their own zod schemas; the shared client only
 * needs the response shapes, so they are plain TypeScript here and have no
 * runtime footprint.
 */

import type { RenderSpecV3, ScenarioTemplateV2 } from "@simforge-oss/scenario";

// ── Enumerations shared by request validation and the UI ─────────────────────

export const SCENARIO_AUTHORING_QUALITY_IDS = [
  "roads-only",
  "ultra-low-3d",
  "minimal",
  "high",
] as const;
export type ScenarioAuthoringQuality = (typeof SCENARIO_AUTHORING_QUALITY_IDS)[number];
export const DEFAULT_SCENARIO_AUTHORING_QUALITY_ID = "minimal" satisfies ScenarioAuthoringQuality;

export const SCENARIO_DATASET_VISIBILITIES = ["workspace", "organization", "public"] as const;
export type ScenarioDatasetVisibility = (typeof SCENARIO_DATASET_VISIBILITIES)[number];

export const SCENARIO_RATING_REVIEWED_VIA = ["queue", "browser"] as const;
export type ScenarioRatingReviewedVia = (typeof SCENARIO_RATING_REVIEWED_VIA)[number];

/**
 * Render job modes a row may carry. `full_render` and `browser_render` execute
 * the same immutable render intent through the registered worker lane;
 * `interaction_2d` is the sensor-free control mode.
 */
export const SCENARIO_JOB_MODES = ["interaction_2d", "full_render", "browser_render"] as const;
export type ScenarioJobMode = (typeof SCENARIO_JOB_MODES)[number];

export const OPENSCENARIO_NATIVE_PROFILE = "ASAM OpenSCENARIO XML 1.4";

/** The only product-facing operational job vocabulary. */
export const SCENARIO_JOB_FAMILIES = [
  "openscenario_compile",
  "openscenario_validate",
  "openscenario_render",
  "artifact_postprocess",
] as const;
export type ScenarioJobFamily = (typeof SCENARIO_JOB_FAMILIES)[number];

export const SCENARIO_RENDERER_ENGINES = ["browser", "carla", "native"] as const;
export type ScenarioRendererEngine = (typeof SCENARIO_RENDERER_ENGINES)[number];

// ── Projects: datasets, documents, tags, ratings, revisions ─────────────────

export type ScenarioDocumentDto = {
  id: string;
  workspaceId: string;
  title: string;
  draftVersion: number;
  schemaVersion: string;
  /**
   * Server-computed digest of the draft's canonical content, from the same
   * `canonicalContentSha256` a revision is frozen with. The render tab compares
   * it against a render's `revisionContentSha256` to decide whether that render
   * is outdated; the client's own `contentHash` uses a different serializer and
   * MUST NOT be compared against either.
   */
  contentSha256: string;
  content: ScenarioTemplateV2;
  mapVersionId: string | null;
  datasetId: string;
  authoringQualityId: ScenarioAuthoringQuality;
  createdAt: string;
  updatedAt: string;
  latestRevisionId: string | null;
};

export type ScenarioDatasetDto = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  visibility: ScenarioDatasetVisibility;
  isSystemManaged: boolean;
  systemSlug: string | null;
  isDefault: boolean;
  /** Pinned revision × render-job pairs. Zero until someone pins a revision. */
  itemCount: number;
  /** Live documents in the dataset — the number the list actually wants. */
  documentCount: number;
  renderSubmittedCount: number;
  renderCompletedCount: number;
  exportCompletedCount: number;
  createdByUserName: string | null;
  updatedByUserName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioDatasetReadinessDto = {
  summary: { total: number; rendered: number; cosmosed: number; vlmed: number };
  scenarios: Array<{ id: string; has_render: boolean }>;
};

/**
 * The per-row shape for the document list.
 *
 * Deliberately carries NO `content`. Everything here that comes from the
 * template comes from stored generated projections, so it can never disagree
 * with `content_sha256`. `contentTags` is the template's authored `meta.tags`
 * (hashed content); `tags` is the workspace's organizational catalog.
 */
export type ScenarioDocumentSummaryDto = {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  datasetId: string;
  datasetSortOrder: number;
  mapVersionId: string | null;
  mapLabel: string | null;
  /** Canonical map-assets identity shared by immutable versions of the same source map. */
  mapSourceMapId?: string | null;
  /** Stable first-party preview route for the exact immutable map version used by this document. */
  mapThumbnailUrl?: string | null;
  latestRevisionId: string | null;
  revisionCount: number;
  archetype: string | null;
  author: string | null;
  contentTags: string[];
  tags: Array<{ id: string; label: string; color: string | null }>;
  roleCount: number;
  /** Whether at least one actor has an authored sensor configuration. */
  hasSensorProfile: boolean;
  propCount: number;
  variantCount: number;
  clipSeconds: number | null;
  negativeControl: boolean;
  derivationKind: "copy" | "variation" | "cross_map_variation" | "import" | null;
  derivedFromDocumentId: string | null;
  hasRender: boolean;
  createdByUserName: string | null;
  updatedByUserName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioDocumentSummaryPageDto = {
  documents: ScenarioDocumentSummaryDto[];
  nextCursor: string | null;
};

/**
 * A workspace organizational tag. Strictly separate from the template's
 * authored `meta.tags`; nothing here reaches `canonical_content`, so renaming
 * or recolouring a tag can never change a document digest.
 */
export type ScenarioTagDto = {
  id: string;
  workspaceId: string;
  slug: string;
  label: string;
  color: string | null;
  isSystemDefault: boolean;
  /** Live documents carrying this tag, for the filter dropdown's counts. */
  documentCount: number;
};

export type ScenarioDocumentRatingDto = {
  documentId: string;
  revisionId: string | null;
  renderJobId: string | null;
  raterUserId: string;
  score: number;
  comment: string | null;
  reviewedVia: ScenarioRatingReviewedVia;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioRatingAggregateDto = {
  documentId: string;
  ratingCount: number;
  averageScore: number;
  minimumScore: number | null;
  reviewState: "pending" | "accepted" | "rejected";
  viewerScore: number | null;
};

export type ScenarioSimulationPreviewDto = {
  artifactId: string;
  draftVersion: number;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  downloadUrl: string;
  createdAt: string;
};

export type ScenarioAmbientProvenanceDto =
  | {
      mode: "disabled";
      ambientConfig: Record<string, never>;
      configSha256: string;
      /** SHA-256 of the canonical materialized-traffic artifact, including disabled. */
      resultSha256: string;
    }
  | {
      mode: "native";
      runtimeVersion: string;
      seed: string | number;
      ambientConfig: Record<string, unknown>;
      configSha256: string;
      resultSha256: string;
    }
  | {
      mode: "sumo";
      sumoVersion: string;
      networkSha256: string;
      seed: string | number;
      ambientConfig: Record<string, unknown>;
      configSha256: string;
      resultSha256: string;
    };

export type ScenarioMaterializedTrafficReferenceDto = {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  sourceInputDigest: string;
  mapAssetId: string;
  mapVersionId: string;
};

export type ScenarioRevisionEvidenceDto = {
  ambient: ScenarioAmbientProvenanceDto;
  materializedTraffic: ScenarioMaterializedTrafficReferenceDto;
};

export type ScenarioRevisionDto = {
  id: string;
  workspaceId: string;
  documentId: string;
  revisionNumber: number;
  sourceDraftVersion: number;
  schemaVersion: string;
  contentSha256: string;
  mapVersionId: string | null;
  openScenarioProfile: typeof OPENSCENARIO_NATIVE_PROFILE;
  export: {
    id: string;
    format: "openscenario_xml_1_4";
    status: ScenarioExportStatus;
    artifactId: string | null;
  };
  createdAt: string;
};

export type CreateScenarioRevisionResultDto = {
  revisionId: string;
  exportId: string;
  exportStatus: ScenarioExportStatus;
  revision: ScenarioRevisionDto;
};

export type ScenarioConflictDto = {
  error: "draft_version_conflict";
  refetch: true;
  currentDraftVersion: number;
  current: ScenarioDocumentDto;
};

// ── Artifacts, exports, maps ─────────────────────────────────────────────────

export type ScenarioExportStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ScenarioExportDto = {
  id: string;
  revisionId: string;
  format: "openscenario_xml_1_4";
  status: ScenarioExportStatus;
  artifactId: string | null;
  executionPackageId: string | null;
  compilerVersion: string;
  errorCode: string | null;
  errorDetail: unknown;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

/** Exact compiler evidence for one completed OpenSCENARIO export. */
export type ScenarioExportInspectionDto = {
  exportId: string;
  revisionId: string;
  executionPackageId: string;
  executionPackageSha256: string;
  compilerVersion: string;
  capabilityProfile: string;
  xoscArtifactId: string;
  xoscSha256: string;
  xsdValidation: {
    valid: boolean;
    standard: string;
    xsdSha256: string;
    diagnostics: string[];
  };
  capability: {
    contract: string;
    profile: string;
    intent: string;
    roundTrip: string;
    externalSimulatorValidation: string;
    summary: Record<string, number>;
    warningCount: number;
    /** Plain compiler-authored losses or approximations bound to this exact package. */
    warnings: Array<{ code: string; path: string; reason: string }>;
  };
};

export type ScenarioArtifactDto = {
  id: string;
  revisionId: string | null;
  kind: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  downloadUrl: string;
  downloadExpiresAt: string;
  createdAt: string;
};

export type ScenarioMapDescriptorDto = {
  mapVersionId: string;
  /** FK-backed `map_versions.source_map_asset_id`: full timestamped `public.map_assets.id`, never a logical display slug. */
  sourceMapId: string;
  label: string;
  locality: string | null;
  /** Stable route root for every member of this immutable browser bundle. */
  browserAssetRootUrl: string;
  browserManifestUrl: string;
  /** Identity of the complete published browser member closure. */
  browserClosureSha256: string;
  artifacts: {
    xodrSha256: string;
    topologySha256: string;
    derivedTopologySha256: string;
    locationsSha256: string;
    signalsSha256: string;
    lanePolygonsSha256: string;
  };
  /** Digest of the network bytes referenced by the optional SUMO manifest. */
  sumoNetworkSha256: string | null;
  topologyArtifactUrl: string;
  /** Presigned gzipped derived topology; null when the map version has no available artifact. */
  derivedTopologyUrl: string | null;
  /** Presigned gzipped locations; null when the map version has no available artifact. */
  locationsUrl: string | null;
  /** Presigned SUMO network; null when the map version has no matching available artifact. */
  sumoNetworkUrl: string | null;
  /** Stable first-party route for the independently versioned preview artifact. */
  thumbnailUrl: string | null;
  /**
   * Presigned `signals.geojson`, or null when the map version publishes none.
   * Presigned per request like the other artifact URLs here, never cached
   * beyond the shared-read window.
   */
  signalsArtifactUrl: string | null;
  xodr: { artifactId: string; sha256: string };
  coordinateSystem: { id: string; sha256: string };
};

// ── Jobs: render jobs, validation runs, operational jobs ────────────────────

export type ScenarioRenderJobStatus = "queued" | "leased" | "running" | "succeeded" | "failed" | "cancelled";

export type ScenarioRenderJobDto = {
  id: string;
  revisionId: string;
  executionPackageId: string;
  originRecordingJobId: string | null;
  mode: ScenarioJobMode;
  status: ScenarioRenderJobStatus;
  progress: number;
  billingMode: "free";
  estimatedCost: 0;
  /** The canonical render-spec/v3 the job was submitted with; null for sensor-free interaction jobs. */
  renderSpec: RenderSpecV3 | null;
  telemetry: { gpuSeconds?: number; wallSeconds?: number; storageBytes?: number; outputBytes?: number };
  parityResult: Record<string, unknown> | null;
  parityEvidence: Record<string, unknown> | null;
  resourceRequest: Record<string, unknown> | null;
  /** Sanitized product signal. Raw node, GPU and host attestation stays attempt-internal. */
  workerAttestation: Record<string, unknown> | null;
  failureCode: string | null;
  failureDetail: unknown;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioJobProvenanceDto = {
  documentId: string;
  revisionId: string;
  revisionNumber: number;
  sourceRevisionSha256: string;
  /** Canonical concrete simulation input hash bound into the XOSC and execution evidence. */
  sourceInputDigest: string | null;
  openScenarioProfile: typeof OPENSCENARIO_NATIVE_PROFILE;
  compilerVersion: string;
  validationStatus: string | null;
  xoscArtifactId: string;
  xoscSha256: string;
  executionPackageId: string;
  executionPackageSha256: string;
  mapVersionId: string;
  xodrSha256: string;
  assetCatalogSha256: string | null;
  coordinateSystemId: string;
  coordinateSystemSha256: string;
  ambient: Record<string, unknown>;
  capabilityWarnings: unknown[];
  artifacts: Array<{
    id: string;
    kind: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    metadata: Record<string, unknown>;
  }>;
  events: Array<{ sequence: number; type: string; occurredAt: string; payload: Record<string, unknown> }>;
};

/** One `validation_runs` row, as returned by `/api/simforge/validation-runs`. */
export type ScenarioValidationRunDto = {
  id: string;
  revision_id: string;
  validator_kind: string;
  validator_version: string;
  validation_state: string;
  report_artifact_id: string | null;
  trace_artifact_id: string | null;
  summary: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

/** One row of the product-facing operational job ledger (`/api/simforge/jobs`). */
export type ScenarioOperationalJobDto = {
  id: string;
  family: ScenarioJobFamily;
  revisionId: string;
  type: string;
  status: string;
  priority: number;
  progress: number;
  attemptCount: number;
  maxAttempts: number;
  cancelRequestedAt: string | null;
  failureCode: string | null;
  failureDetail: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

/**
 * The body of `POST /api/simforge/render-jobs`. Each host validates the full
 * submission with its own render-wire schema; the shared client only needs the
 * identity fields to submit it.
 *
 * Identity is the caller's `idempotencyKey`, scoped to the workspace: the host
 * returns the existing job for a repeated key and rejects the key when the
 * revision, execution package, engine or render spec differ. The immutable
 * intent id is minted by the host when it materializes the intent, so it is
 * never part of the submission.
 */
export type ScenarioRenderIntentSubmission = {
  schema: string;
  revisionId: string;
  executionPackageId: string;
  engine: ScenarioRendererEngine;
  idempotencyKey: string;
  [key: string]: unknown;
};

// ── Render gallery, detail, artifacts, postprocess ──────────────────────────

/**
 * Stable artifact tuple identity. Sensor-scoped roles (`video`, `frames`,
 * `sensorArchive`, `sensorData`) carry actor/sensor/modality; global roles
 * (`manifest`, `trace`, `annotations`, `diagnostics`) carry nulls.
 */
export type ScenarioArtifactIdentityDto = {
  role: string;
  actorId: string | null;
  sensorId: string | null;
  modality: string | null;
};

export type ScenarioRenderStage = "downloading" | "preparing" | "rendering" | "encoding" | "uploading" | "finalizing";

type RenderProgressBase = {
  schema: string;
  jobId: string;
  attempt: number;
  sequence: number;
  timestamp: string;
};

/** One worker progress record as the detail route republishes it. */
export type ScenarioRenderProgressDto =
  | (RenderProgressBase & { event: "job.started" })
  | (RenderProgressBase & { event: "stage.started"; stage: ScenarioRenderStage })
  | (RenderProgressBase & {
      event: "stage.progress";
      stage: ScenarioRenderStage;
      completed: number;
      total: number;
      unit: "frames" | "bytes" | "items" | "seconds";
    })
  | (RenderProgressBase & {
      event: "artifact.ready";
      identity: ScenarioArtifactIdentityDto;
      sha256: string;
      sizeBytes: number;
      mediaType: string;
    })
  | (RenderProgressBase & { event: "warning"; code: string; message: string })
  | (RenderProgressBase & { event: "job.canceled"; reason: string });

/** Job states the worker control plane advances. Mirrors `render_jobs.job_state`. */
export type ScenarioRenderJobState = ScenarioRenderJobStatus;

/** `render_jobs.job_mode`. The last two are postprocess modes. */
export type ScenarioRenderJobMode = ScenarioJobMode | "cosmos_augment" | "vlm_annotate";

/** A gallery tile. Deliberately narrow: the list must not carry render specs or telemetry blobs. */
export type ScenarioGalleryItemDto = {
  id: string;
  revisionId: string;
  documentId: string | null;
  jobMode: ScenarioRenderJobMode;
  rendererEngine: ScenarioRendererEngine | null;
  jobState: ScenarioRenderJobState;
  /** 0-100 where the worker reports it, else null. Advanced by the worker; never cached. */
  progressPercent: number | null;
  failureCode: string | null;
  attemptCount: number;
  createdAt: string;
  completedAt: string | null;
  /** Postprocess lineage: set only for `cosmos_augment` / `vlm_annotate`. */
  parentRenderJobId: string | null;
  modelFamily: string | null;
  /**
   * Immutable content digest of the snapshot this render was produced from.
   * Compared against the open draft's digest to mark a tile outdated.
   */
  revisionContentSha256: string | null;
  /** The draft version the render's snapshot was frozen from. */
  revisionSourceDraftVersion: number | null;
  artifactCount: number;
  /** The preview artifact id, if one exists. Presigned separately, per request. */
  previewArtifactId: string | null;
  previewMediaType: string | null;
};

export type ScenarioRenderAttemptDto = {
  id: string;
  attemptNumber: number;
  /** Immutable digest of the exact execution controls issued with this attempt's lease. */
  executionPackageControlSha256: string;
  status: string;
  attemptState: string;
  workerNodeId: string;
  workerClass: string;
  runtimeVersion: string | null;
  rendererEngine: ScenarioRendererEngine | null;
  baseImageDigest: string | null;
  baseImagePlatformDigest: string | null;
  engineCapabilitiesSha256: string | null;
  imageDigest: string | null;
  leasedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type ScenarioJobEventDto = {
  eventOrdinal: number;
  eventKind: string;
  attemptId: string | null;
  /** Public details never include the worker-controlled event payload. */
  detail: null;
  createdAt: string;
};

/** One artifact row. `url` is absent by design — only `[jobId]/downloads` signs. */
export type ScenarioRenderArtifactDto = {
  id: string;
  artifactKind: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  /** `pending` | `available` | `quarantined` | `deleted`. Advanced by the verification worker. */
  artifactState: string;
  relationship: string | null;
  renderAttemptId: string | null;
  identity: ScenarioArtifactIdentityDto | null;
  createdAt: string;
  verifiedAt: string | null;
};

/** An artifact paired with a freshly minted, short-lived URL. Never cached, never persisted. */
export type ScenarioPresignedArtifactDto = ScenarioRenderArtifactDto & {
  url: string;
  /** Seconds until the signature expires, from the moment this object was built. */
  expiresInSeconds: number;
};

export type ScenarioRenderJobDetailDto = {
  id: string;
  revisionId: string;
  executionPackageId: string;
  /** Immutable digest shared by every authoritative attempt issued for this job. */
  executionPackageControlSha256: string;
  renderProfileId: string | null;
  jobMode: ScenarioRenderJobMode;
  jobState: ScenarioRenderJobState;
  progressPercent: number | null;
  progressDetail: ScenarioRenderProgressDto | null;
  rendererEngine: ScenarioRendererEngine | null;
  intentSha256: string | null;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  failureCode: string | null;
  failureDetail: string | null;
  billingMode: string;
  estimatedCostCents: number;
  renderSpecSha256: string;
  hiddenAt: string | null;
  hiddenByUserId: string | null;
  parentRenderJobId: string | null;
  sourceArtifactId: string | null;
  modelFamily: string | null;
  modelConfigSha256: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  attempts: ScenarioRenderAttemptDto[];
  events: ScenarioJobEventDto[];
  artifacts: ScenarioRenderArtifactDto[];
};

export type ScenarioPostprocessInput = {
  parentRenderJobId: string;
  sourceArtifactId: string;
  jobMode: Extract<ScenarioRenderJobMode, "cosmos_augment" | "vlm_annotate">;
  modelFamily: string;
  modelConfig: Record<string, unknown>;
  idempotencyKey: string;
  priority?: number;
};

/** An artifact from `[jobId]/downloads` — the one route that signs. */
export type PresignedArtifact =
  | ScenarioPresignedArtifactDto
  | (ScenarioRenderArtifactDto & { url: null });

/** An artifact from `artifact-index` or `[jobId]/detail` — metadata only, no URL, by design. */
export type ArtifactMetadata = ScenarioRenderArtifactDto & {
  url?: undefined;
  expiresInSeconds?: undefined;
};

export type WorkspaceArtifact = ScenarioRenderArtifactDto & { renderJobId: string | null };

/** Either shape. Components that only display metadata accept both. */
export type DisplayArtifact = PresignedArtifact | ArtifactMetadata | WorkspaceArtifact;
