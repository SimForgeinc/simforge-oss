import type { ScenarioMapEntry } from "@simforge-oss/editor";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type { StudioHostCapabilities } from "./capabilities";
import type {
  CreateScenarioRevisionResultDto,
  PresignedArtifact,
  ScenarioArtifactDto,
  ScenarioAuthoringQuality,
  ScenarioDatasetDto,
  ScenarioDatasetReadinessDto,
  ScenarioDocumentDto,
  ScenarioDocumentSummaryPageDto,
  ScenarioExportDto,
  ScenarioExportInspectionDto,
  ScenarioGalleryItemDto,
  ScenarioJobFamily,
  ScenarioJobProvenanceDto,
  ScenarioMaterializedTrafficReferenceDto,
  ScenarioOperationalJobDto,
  ScenarioPostprocessInput,
  ScenarioRatingAggregateDto,
  ScenarioRenderIntentSubmission,
  ScenarioRenderJobDetailDto,
  ScenarioRenderJobDto,
  ScenarioRenderJobMode,
  ScenarioRevisionDto,
  ScenarioRevisionEvidenceDto,
  ScenarioSimulationPreviewDto,
  ScenarioTagDto,
  ScenarioValidationRunDto,
  WorkspaceArtifact,
} from "./contracts";

/** A published map as both the editor (`ScenarioMapEntry`) and the list surfaces need it. */
export type StudioMapEntry = ScenarioMapEntry & {
  readonly thumbnailUrl: string | null;
  readonly derivedTopologyUrl: string | null;
  readonly locationsUrl: string | null;
  readonly signalsUrl: string | null;
  readonly sumoNetworkUrl: string | null;
  readonly xodrArtifactId: string;
  readonly coordinateSystemId: string;
};

/** Immutable bytes of one browser-materialized traffic artifact, as the engine produced them. */
export type MaterializedTrafficUpload = {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mapAssetId: string;
  readonly mapVersionId: string;
};

/**
 * Project persistence: datasets, documents, tags, ratings, revisions and the
 * per-document saved-simulation artifacts. Local Studio backs this with
 * PGlite and the filesystem; SimCloud with managed Postgres and object storage.
 */
export interface StudioProjectService {
  listDatasets(signal?: AbortSignal): Promise<ScenarioDatasetDto[]>;
  createDataset(input: { name: string; description?: string | null }): Promise<ScenarioDatasetDto>;
  updateDataset(datasetId: string, input: { name?: string; description?: string | null }): Promise<ScenarioDatasetDto>;
  deleteDataset(datasetId: string): Promise<{ ok: true; deletedDocumentCount: number }>;
  getDatasetReadiness(datasetId: string, signal?: AbortSignal): Promise<ScenarioDatasetReadinessDto>;

  listDocumentSummaries(
    input: { datasetId: string; limit?: number; cursor?: string | null },
    signal?: AbortSignal,
  ): Promise<ScenarioDocumentSummaryPageDto>;
  /** Full documents with content. Prefer `listDocumentSummaries` for list surfaces. */
  listDocuments(datasetId: string, signal?: AbortSignal): Promise<ScenarioDocumentDto[]>;
  getDocument(documentId: string, signal?: AbortSignal): Promise<ScenarioDocumentDto>;
  createDocument(
    input: {
      title: string;
      description?: string;
      schemaVersion: string;
      content: ScenarioTemplateV2;
      mapVersionId: string | null;
      datasetId: string;
      authoringQualityId: ScenarioAuthoringQuality;
    },
    /** The first save of a new document can also be the one racing an unload. */
    options?: { keepalive?: boolean; signal?: AbortSignal },
  ): Promise<ScenarioDocumentDto>;
  /**
   * Save draft content. `keepalive` lets the request outlive the page that
   * started it, which is the only way an autosave flush on `beforeunload` or
   * `visibilitychange` can reach the server.
   */
  saveDocument(
    document: Pick<ScenarioDocumentDto, "id" | "draftVersion" | "title" | "authoringQualityId">,
    content: ScenarioTemplateV2,
    options?: { title?: string; authoringQualityId?: ScenarioAuthoringQuality; keepalive?: boolean },
  ): Promise<ScenarioDocumentDto>;
  /**
   * Patch metadata. `expectedVersion` makes a rename safe without a lock: if the
   * draft moved underneath, the route 409s with a `ScenarioVersionConflict`.
   */
  updateDocument(
    documentId: string,
    input: { expectedVersion: number; title?: string; description?: string },
  ): Promise<ScenarioDocumentDto>;
  duplicateDocument(documentId: string, input?: { title?: string; datasetId?: string }): Promise<ScenarioDocumentDto>;
  deleteDocument(documentId: string): Promise<{ ok: true }>;

  listTags(signal?: AbortSignal): Promise<ScenarioTagDto[]>;
  createTag(input: { label: string; color?: string | null }): Promise<ScenarioTagDto>;
  updateTag(tagId: string, input: { label?: string; color?: string | null }): Promise<ScenarioTagDto>;
  deleteTag(tagId: string): Promise<{ ok: true }>;
  setDocumentTags(documentId: string, tagIds: string[]): Promise<ScenarioTagDto[]>;

  listRatingAggregates(documentIds: string[], signal?: AbortSignal): Promise<ScenarioRatingAggregateDto[]>;
  setDocumentRating(
    documentId: string,
    input: { score: number; revisionId?: string | null; reviewedVia?: "queue" | "browser" },
  ): Promise<ScenarioRatingAggregateDto | null>;
  clearDocumentRating(documentId: string): Promise<ScenarioRatingAggregateDto | null>;

  listRevisions(documentId: string, signal?: AbortSignal): Promise<ScenarioRevisionDto[]>;
  createRevision(
    document: Pick<ScenarioDocumentDto, "id" | "draftVersion">,
    evidence: ScenarioRevisionEvidenceDto,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<CreateScenarioRevisionResultDto>;
  /**
   * Resolve the immutable revision for one saved draft before entering
   * export/render state. The read-before-write finds the revision created for
   * the exact draft version; failed exports get a new stable key so the server
   * can attach a retry export to the same revision.
   */
  ensureRevision(input: {
    documentId: string;
    expectedDraftVersion?: number | null;
    evidence?: ScenarioRevisionEvidenceDto | null;
    signal?: AbortSignal;
  }): Promise<CreateScenarioRevisionResultDto>;

  getSimulationPreview(documentId: string, signal?: AbortSignal): Promise<ScenarioSimulationPreviewDto | null>;
  saveSimulationPreview(
    document: Pick<ScenarioDocumentDto, "id" | "draftVersion">,
    bytes: Uint8Array,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Reserve, upload exact canonical bytes, and complete one immutable browser
   * traffic artifact. `sourceInputDigest` is the digest the host's compiler
   * recomputes and compares against; the caller passes the value its host
   * expects rather than the client guessing which canonicalization applies.
   */
  uploadMaterializedTraffic(
    document: Pick<ScenarioDocumentDto, "id" | "draftVersion">,
    upload: MaterializedTrafficUpload,
    sourceInputDigest: string,
    signal?: AbortSignal,
  ): Promise<ScenarioMaterializedTrafficReferenceDto>;
}

/** Map catalog and artifact resolution. URLs may be presigned and short-lived. */
export interface StudioArtifactService {
  /** The published map catalog. Shared across callers for five minutes. */
  listMaps(signal?: AbortSignal): Promise<StudioMapEntry[]>;
  getArtifact(artifactId: string, options?: { download?: boolean; signal?: AbortSignal }): Promise<ScenarioArtifactDto>;
  /** Resolve and open an artifact in a new tab. */
  openArtifact(artifactId: string): Promise<void>;
  /** Resolve and trigger a browser download of an artifact. */
  downloadArtifact(artifactId: string): Promise<void>;
  /** `artifact-index` — workspace browse, metadata only. Pair with `jobs.listDownloads` to open one. */
  listWorkspaceArtifacts(options: { artifactKind?: string | null; limit?: number }, signal?: AbortSignal): Promise<WorkspaceArtifact[]>;
  /**
   * Resolve one browse-index artifact to a signed URL at the moment the author
   * asks to open it. Not memoised: a signature lives an hour and a cached one
   * could already be dead. Signing again is one round-trip and always correct.
   */
  resolveRenderArtifactUrl(renderJobId: string, artifactId: string, signal?: AbortSignal): Promise<PresignedArtifact | null>;
}

/** Job submission, listing, cancellation and progress. */
export interface StudioJobService {
  submitRenderIntent(input: ScenarioRenderIntentSubmission, signal?: AbortSignal): Promise<ScenarioRenderJobDto>;
  getRenderJob(jobId: string, signal?: AbortSignal): Promise<ScenarioRenderJobDto>;
  /** Requests cancellation through the operational job ledger; 409 when the job is no longer cancellable. */
  cancelRenderJob(jobId: string): Promise<ScenarioOperationalJobDto>;
  getRenderJobProvenance(jobId: string, signal?: AbortSignal): Promise<ScenarioJobProvenanceDto>;
  getRenderJobDetail(jobId: string, signal?: AbortSignal): Promise<ScenarioRenderJobDetailDto>;
  /** `[jobId]/downloads` — the only route that mints URLs, scoped to one job. */
  listDownloads(jobId: string, signal?: AbortSignal): Promise<PresignedArtifact[]>;
  listGallery(
    options: { revisionId?: string | null; documentId?: string | null; jobMode?: ScenarioRenderJobMode | null; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ items: ScenarioGalleryItemDto[]; hiddenCount: number }>;
  listPostprocessChildren(parentRenderJobId: string, signal?: AbortSignal): Promise<ScenarioGalleryItemDto[]>;
  /**
   * Queue a postprocess run. The parent goes in the path and is stripped from
   * the body so it cannot differ from the id the route authorized.
   */
  createPostprocessJob(input: ScenarioPostprocessInput): Promise<{ id: string; created: boolean }>;
  setRenderJobHidden(jobId: string, hidden: boolean): Promise<{ id: string; hiddenAt: string | null; hiddenByUserId: string | null }>;

  prepareExport(revisionId: string, idempotencyKey: string, signal?: AbortSignal): Promise<ScenarioExportDto>;
  listExports(revisionId: string, signal?: AbortSignal): Promise<ScenarioExportDto[]>;
  getExport(exportId: string, signal?: AbortSignal): Promise<ScenarioExportDto>;
  inspectExport(exportId: string, signal?: AbortSignal): Promise<ScenarioExportInspectionDto>;
  /** Poll until the export carries an immutable execution package or terminally fails. */
  waitForExport(
    revisionId: string,
    exportId: string,
    options?: { attempts?: number; intervalMs?: number; signal?: AbortSignal },
  ): Promise<ScenarioExportDto>;

  listValidationRuns(revisionId: string, signal?: AbortSignal): Promise<ScenarioValidationRunDto[]>;
  createValidationRun(
    input: { revisionId: string; validatorKind: string; validatorVersion: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<ScenarioValidationRunDto>;

  listOperationalJobs(
    input?: { family?: ScenarioJobFamily | null; revisionId?: string | null; limit?: number },
    signal?: AbortSignal,
  ): Promise<ScenarioOperationalJobDto[]>;
  getOperationalJob(jobId: string, signal?: AbortSignal): Promise<ScenarioOperationalJobDto>;
  cancelOperationalJob(jobId: string): Promise<ScenarioOperationalJobDto>;
}

/** What this host can execute right now. Read once per session and after installs. */
export interface StudioRuntimeService {
  capabilities(options?: { fresh?: boolean; signal?: AbortSignal }): Promise<StudioHostCapabilities>;
}

export interface StudioHostServices {
  readonly projects: StudioProjectService;
  readonly artifacts: StudioArtifactService;
  readonly jobs: StudioJobService;
  readonly runtime: StudioRuntimeService;
}
