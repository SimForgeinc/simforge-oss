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
  ScenarioMapCoverageDto,
  ScenarioOperationalJobDto,
  ScenarioPostprocessInput,
  ScenarioRatingAggregateDto,
  ScenarioRenderIntentSubmission,
  ScenarioRenderJobDetailDto,
  ScenarioRenderJobDto,
  ScenarioRenderJobMode,
  ScenarioRevisionDto,
  ScenarioSimulationResultDto,
  ScenarioSimulationStatusDto,
  ScenarioSimulationVerificationDto,
  ScenarioTagDto,
  ScenarioValidationRunDto,
  IndexedArtifact,
} from "./contracts";
import type {
  ScenarioTransferOptionsDto,
  TransferDocumentRequest,
  TransferOptionsRequest,
} from "./protocol/documents";

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
  transferDocument(documentId: string, input: TransferDocumentRequest): Promise<ScenarioDocumentDto>;
  getDocumentTransferOptions(
    documentId: string,
    input?: TransferOptionsRequest,
  ): Promise<ScenarioTransferOptionsDto>;
  /**
   * Create the variation a human drives, and say which actor they take over.
   *
   * Resolved on the server: an unpinned scenario, one with no drivable vehicle,
   * or one with several and no ego is refused before the variation exists.
   */
  startDriverInTheLoop(
    documentId: string,
    input?: { roleId?: string },
  ): Promise<{ document: ScenarioDocumentDto; roleId: string }>;
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
  /**
   * Freeze one saved draft into an immutable revision. The host binds the
   * authoritative simulation's traffic evidence; the client sends nothing
   * but the draft version.
   */
  createRevision(
    document: Pick<ScenarioDocumentDto, "id" | "draftVersion">,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<CreateScenarioRevisionResultDto>;
  /**
   * Resolve the immutable revision for one saved draft before entering
   * export/render state. The read-before-write finds the revision created for
   * the exact draft version; otherwise the draft's authoritative simulation is
   * awaited (the host runs it) and the revision is created from it. Failed
   * exports get a new stable key so the server can attach a retry export.
   */
  ensureRevision(input: {
    documentId: string;
    expectedDraftVersion?: number | null;
    signal?: AbortSignal;
    /** Progress while the host simulates the draft (queued on a CPU runner, for instance). */
    onSimulation?: (status: ScenarioSimulationStatusDto) => void;
  }): Promise<CreateScenarioRevisionResultDto>;

  /**
   * The authoritative simulation of a document's current draft. `waitMs`
   * bounds how long the host waits on an execution someone else holds.
   */
  resolveSimulation(
    document: Pick<ScenarioDocumentDto, "id" | "draftVersion">,
    options?: { waitMs?: number; signal?: AbortSignal },
  ): Promise<ScenarioSimulationStatusDto & { draftVersion: number }>;
  /** One immutable authoritative result by key. */
  getSimulation(simKey: string, signal?: AbortSignal): Promise<ScenarioSimulationResultDto>;
  /** Report the local preview's digest against the authoritative result; a mismatch is a determinism bug. */
  verifySimulation(
    simKey: string,
    verification: ScenarioSimulationVerificationDto,
    signal?: AbortSignal,
  ): Promise<{ outcome: "verified" | "mismatch"; authoritativeTraceSha256: string }>;
  /** The authoritative simulation a revision renders and is evaluated against. */
  resolveRevisionSimulation(
    revisionId: string,
    options?: { waitMs?: number; signal?: AbortSignal },
  ): Promise<ScenarioSimulationStatusDto>;
}

/** Map catalog and artifact resolution. URLs may be presigned and short-lived. */
export interface StudioArtifactService {
  /** The usable map catalog. Refresh after installation or an authorization change. */
  listMaps(signal?: AbortSignal, options?: { fresh?: boolean }): Promise<StudioMapEntry[]>;
  /**
   * WGS84 footprints of the installed maps, for drawing scenario coverage on
   * a 2D basemap. Immutable per map version, so it shares the map catalog's
   * read window; an installed map that cannot be placed comes back under
   * `unprojected` with its reason rather than vanishing.
   */
  listMapFootprints(signal?: AbortSignal): Promise<ScenarioMapCoverageDto>;
  getArtifact(artifactId: string, options?: { download?: boolean; signal?: AbortSignal }): Promise<ScenarioArtifactDto>;
  /** Resolve and open an artifact in a new tab. */
  openArtifact(artifactId: string): Promise<void>;
  /** Resolve and trigger a browser download of an artifact. */
  downloadArtifact(artifactId: string): Promise<void>;
  /** `artifact-index` — browse the home's artifacts, metadata only. Pair with `jobs.listDownloads` to open one. */
  listArtifactIndex(options: { artifactKind?: string | null; limit?: number }, signal?: AbortSignal): Promise<IndexedArtifact[]>;
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
