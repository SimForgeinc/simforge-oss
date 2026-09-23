import type {
  CreateScenarioRevisionResultDto,
  ScenarioConflictDto,
  ScenarioDocumentDto,
  ScenarioMapDescriptorDto,
} from "./contracts";
import { ScenarioNameConflict, ScenarioVersionConflict, StudioHostRequestError } from "./errors";
import {
  STUDIO_HOST_PROTOCOL,
  type AnyEndpoint,
  type EndpointBody,
  type EndpointParams,
  type EndpointQuery,
  type EndpointResponse,
  type QueryValue,
  type UploadReservationDto,
} from "./protocol";
import type {
  StudioArtifactService,
  StudioHostServices,
  StudioJobService,
  StudioMapEntry,
  StudioProjectService,
  StudioRuntimeService,
} from "./services";
import { SharedReads } from "./shared-read";
import { randomUuid } from "@simforge-oss/engine/uuid";

export type HttpStudioHostOptions = {
  /** Origin the `/api/simforge/*` routes live on. Defaults to same-origin relative paths. */
  baseUrl?: string;
  /** Injected for tests and non-browser callers. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Extra headers on every request (bearer tokens for non-cookie callers). */
  headers?: Record<string, string>;
};

type ErrorBody = {
  error?: string;
  message?: string;
  field?: string;
  refetch?: boolean;
  currentDraftVersion?: number;
  current?: ScenarioDocumentDto;
};

/** Per-call inputs; each slot exists only when the endpoint declares it. */
type CallOptions<E extends AnyEndpoint> = (EndpointParams<E> extends void
  ? { params?: undefined }
  : { params: EndpointParams<E> }) &
  (EndpointQuery<E> extends void ? { query?: undefined } : { query: EndpointQuery<E> }) &
  (EndpointBody<E> extends void ? { body?: undefined } : { body: EndpointBody<E> }) & {
    signal?: AbortSignal;
    keepalive?: boolean;
  };

const DATASET_READ_KEY = "datasets";
const TAG_READ_KEY = "tags";
const MAP_READ_KEY = "maps";
const MAP_FOOTPRINT_READ_KEY = "map-footprints";
const CAPABILITIES_READ_KEY = "capabilities";
const MAP_SHARE_MS = 5 * 60_000;
/** Per request the host waits this long on a simulation someone else holds (its route caps at 25 s). */
const SIMULATION_WAIT_MS = 20_000;
/** About five minutes of waiting on a queued simulation before a revision commit gives up. */
const SIMULATION_WAIT_ATTEMPTS = 15;

const { datasets, documents, maps, jobs: jobEndpoints, runtime: runtimeEndpoints } = STUDIO_HOST_PROTOCOL;

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function mapEntry(map: ScenarioMapDescriptorDto): StudioMapEntry {
  return {
    id: map.mapVersionId,
    versionId: map.mapVersionId,
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    label: map.label,
    locality: map.locality ?? "",
    browserAssetRootUrl: map.browserAssetRootUrl,
    browserManifestUrl: map.browserManifestUrl,
    browserClosureSha256: map.browserClosureSha256,
    artifacts: map.artifacts,
    sumoNetworkSha256: map.sumoNetworkSha256,
    sumoStatus: map.sumoStatus ?? null,
    ambientTurnVerdicts: map.ambientTurnVerdicts ?? null,
    ground: map.ground ?? null,
    manifestUrl: map.browserManifestUrl,
    topologyUrl: map.topologyArtifactUrl,
    derivedTopologyUrl: map.derivedTopologyUrl,
    locationsUrl: map.locationsUrl,
    signalsUrl: map.signalsArtifactUrl,
    sumoNetworkUrl: map.sumoNetworkUrl,
    thumbnailUrl: map.thumbnailUrl,
    xodrArtifactId: map.xodr.artifactId,
    coordinateSystemId: map.coordinateSystem.id,
  };
}

/** `null`/`undefined` omit the key; everything else is stringified. */
function searchString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * The one HTTP implementation of the Studio host boundary: a transport over
 * `STUDIO_HOST_PROTOCOL`. Paths, methods and response shapes come from the
 * endpoint declarations; nothing here spells a route string.
 *
 * Both hosts serve the same `/api/simforge/*` wire contract; identity travels
 * as same-origin cookies (fixed local owner, or the cloud account session), so
 * the client never carries product auth. Every read is `no-store`: routes send
 * `private, no-store` and each call takes an `AbortSignal` so a panel that
 * closes cancels its own in-flight request instead of resolving into an
 * unmounted tree.
 *
 * Every JSON response is decoded against the endpoint's schema before it is
 * returned; a host that answers with the wrong shape fails here, naming the
 * field, instead of somewhere in the UI.
 */
export function createHttpStudioHost(options: HttpStudioHostOptions = {}): StudioHostServices {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "";
  const shared = new SharedReads();

  async function call<E extends AnyEndpoint>(endpoint: E, opts: CallOptions<E>): Promise<EndpointResponse<E>> {
    const path = typeof endpoint.path === "function" ? endpoint.path(opts.params) : endpoint.path;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const response = await fetchImpl(`${baseUrl}${path}${searchString(opts.query)}`, {
      method: endpoint.method,
      body,
      cache: "no-store",
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.keepalive ? { keepalive: true } : {}),
    });
    if (response.ok) {
      return endpoint.response.parse(response.status === 204 ? undefined : await response.json(), "response");
    }
    const errorBody = (await response.json().catch(() => null)) as ErrorBody | null;
    if (response.status === 409 && errorBody?.error === "draft_version_conflict") {
      const conflict = errorBody as Partial<ScenarioConflictDto>;
      throw new ScenarioVersionConflict(conflict.currentDraftVersion ?? null, conflict.current ?? null);
    }
    if (response.status === 409 && (errorBody?.error === "dataset_name_taken" || errorBody?.error === "tag_label_taken")) {
      throw new ScenarioNameConflict(errorBody.error, errorBody.field ?? "name");
    }
    const code = errorBody?.error ?? `request_failed_${response.status}`;
    throw new StudioHostRequestError(
      code,
      response.status,
      errorBody?.message ?? (errorBody?.error ? undefined : `Request failed (${response.status}).`),
    );
  }


  const projects: StudioProjectService = {
    async listDatasets(signal) {
      const body = await shared.read(DATASET_READ_KEY, 0, () => call(datasets.list, {}), signal);
      return body.datasets;
    },
    createDataset(input) {
      return shared.invalidateAfter(DATASET_READ_KEY, call(datasets.create, { body: input }));
    },
    updateDataset(datasetId, input) {
      return shared.invalidateAfter(DATASET_READ_KEY, call(datasets.update, { params: { datasetId }, body: input }));
    },
    deleteDataset(datasetId) {
      return shared.invalidateAfter(DATASET_READ_KEY, call(datasets.delete, { params: { datasetId } }));
    },
    getDatasetReadiness(datasetId, signal) {
      return call(datasets.readiness, { params: { datasetId }, signal });
    },

    listDocumentSummaries(input, signal) {
      return call(documents.listSummaries, {
        query: { datasetId: input.datasetId, limit: input.limit ?? 50, ...(input.cursor ? { cursor: input.cursor } : {}) },
        signal,
      });
    },
    async listDocuments(datasetId, signal) {
      return (await call(documents.list, { query: { datasetId }, signal })).documents;
    },
    getDocument(documentId, signal) {
      return call(documents.get, { params: { documentId }, signal });
    },
    createDocument(input, opts = {}) {
      return call(documents.create, { body: input, keepalive: opts.keepalive, signal: opts.signal });
    },
    saveDocument(document, content, opts = {}) {
      return call(documents.update, {
        params: { documentId: document.id },
        body: {
          expectedVersion: document.draftVersion,
          title: opts.title ?? document.title,
          content,
          authoringQualityId: opts.authoringQualityId ?? document.authoringQualityId,
        },
        keepalive: opts.keepalive,
      });
    },
    updateDocument(documentId, input) {
      return call(documents.update, { params: { documentId }, body: input });
    },
    duplicateDocument(documentId, input = {}) {
      return call(documents.duplicate, { params: { documentId }, body: input });
    },
    transferDocument(documentId, input) {
      return call(documents.transfer, { params: { documentId }, body: input });
    },
    getDocumentTransferOptions(documentId, input = {}) {
      return call(documents.transferOptions, { params: { documentId }, body: input });
    },
    startDriverInTheLoop(documentId, input = {}) {
      return call(documents.startDriverInTheLoop, { params: { documentId }, body: input });
    },
    deleteDocument(documentId) {
      return call(documents.delete, { params: { documentId } });
    },

    async listTags(signal) {
      const body = await shared.read(TAG_READ_KEY, 0, () => call(documents.listTags, {}), signal);
      return body.tags;
    },
    createTag(input) {
      return shared.invalidateAfter(TAG_READ_KEY, call(documents.createTag, { body: input }));
    },
    updateTag(tagId, input) {
      return shared.invalidateAfter(TAG_READ_KEY, call(documents.updateTag, { params: { tagId }, body: input }));
    },
    deleteTag(tagId) {
      return shared.invalidateAfter(TAG_READ_KEY, call(documents.deleteTag, { params: { tagId } }));
    },
    async setDocumentTags(documentId, tagIds) {
      return (await call(documents.setTags, { params: { documentId }, body: { tagIds } })).tags;
    },

    async listRatingAggregates(documentIds, signal) {
      return (await call(documents.listRatingAggregates, { body: { documentIds }, signal })).aggregates;
    },
    async setDocumentRating(documentId, input) {
      return (await call(documents.setRating, { params: { documentId }, body: { reviewedVia: "browser", ...input } })).aggregate;
    },
    async clearDocumentRating(documentId) {
      return (await call(documents.clearRating, { params: { documentId } })).aggregate;
    },

    async listRevisions(documentId, signal) {
      return (await call(documents.listRevisions, { params: { documentId }, signal })).revisions;
    },
    createRevision(document, opts = {}) {
      return call(documents.createRevision, {
        params: { documentId: document.id },
        body: { expectedVersion: document.draftVersion, idempotencyKey: opts.idempotencyKey ?? randomUuid() },
        signal: opts.signal,
      });
    },
    async ensureRevision(input): Promise<CreateScenarioRevisionResultDto> {
      const expectedDraftVersion = input.expectedDraftVersion
        ?? (await projects.getDocument(input.documentId, input.signal)).draftVersion;
      const revisions = await projects.listRevisions(input.documentId, input.signal);
      const existing = revisions.find((revision) => revision.sourceDraftVersion === expectedDraftVersion);
      if (existing && existing.export.status !== "failed" && existing.export.status !== "cancelled") {
        return {
          revisionId: existing.id,
          exportId: existing.export.id,
          exportStatus: existing.export.status,
          revision: existing,
        };
      }
      const retrySuffix = existing ? `:retry:${existing.export.id}` : "";
      const draft = { id: input.documentId, draftVersion: expectedDraftVersion };
      // The host simulates the draft (inline, or on a CPU runner when it is
      // queued); nothing is uploaded. Wait for it, then freeze the revision.
      for (let attempt = 0; attempt < SIMULATION_WAIT_ATTEMPTS; attempt += 1) {
        const status = await projects.resolveSimulation(draft, { waitMs: SIMULATION_WAIT_MS, signal: input.signal });
        input.onSimulation?.(status);
        if (status.state === "failed") {
          throw new StudioHostRequestError(status.failureCode, 422, status.message ?? `The scenario could not be simulated (${status.failureCode}).`);
        }
        if (status.state !== "succeeded") continue;
        try {
          return await call(documents.createRevision, {
            params: { documentId: input.documentId },
            body: {
              expectedVersion: expectedDraftVersion,
              idempotencyKey: `ensure-revision:${input.documentId}:${expectedDraftVersion}${retrySuffix}`,
            },
            signal: input.signal,
          });
        } catch (error) {
          if (!(error instanceof StudioHostRequestError) || error.code !== "simulation_pending") throw error;
        }
      }
      throw new StudioHostRequestError("simulation_timeout", 504, "The scenario's simulation did not finish in time; try again.");
    },

    resolveSimulation(document, opts = {}) {
      return call(documents.resolveSimulation, {
        params: { documentId: document.id },
        body: { expectedVersion: document.draftVersion, ...(opts.waitMs === undefined ? {} : { waitMs: opts.waitMs }) },
        signal: opts.signal,
      });
    },
    getSimulation(simKey, signal) {
      return call(documents.getSimulation, { params: { simKey }, signal });
    },
    verifySimulation(simKey, verification, signal) {
      return call(documents.verifySimulation, { params: { simKey }, body: verification, signal });
    },
    evaluateSimulation(simKey, filters, signal) {
      return call(documents.evaluateSimulation, { params: { simKey }, body: filters ? { filters } : {}, signal });
    },
    getRevisionMotion(revisionId, signal) {
      return call(documents.getRevisionMotion, { params: { revisionId }, signal });
    },
    resimulateRevision(revisionId, opts = {}) {
      return call(documents.resimulateRevision, {
        params: { revisionId },
        body: opts.waitMs === undefined ? { action: "resimulate" } : { action: "resimulate", waitMs: opts.waitMs },
        signal: opts.signal,
      });
    },

    listVersions(documentId, signal) {
      return call(documents.listVersions, { params: { documentId }, signal });
    },
    saveVersion(document, opts = {}) {
      return call(documents.saveVersion, {
        params: { documentId: document.id },
        body: { expectedVersion: document.draftVersion, ...(opts.label ? { label: opts.label } : {}) },
        signal: opts.signal,
      });
    },
    keepPreviousMotion(document, change, signal) {
      return call(documents.keepPreviousMotion, {
        params: { documentId: document.id },
        body: { expectedVersion: document.draftVersion, previousSimKey: change.previousSimKey, currentSimKey: change.currentSimKey },
        signal,
      });
    },
    async acceptDraftSimulation(document, simKey, signal) {
      await call(documents.acceptDraftSimulation, {
        params: { documentId: document.id },
        body: { expectedVersion: document.draftVersion, simKey },
        signal,
      });
    },
    resimulateVersion(documentId, revisionId, opts = {}) {
      return call(documents.resimulateVersion, {
        params: { documentId, revisionId },
        body: opts.waitMs === undefined ? {} : { waitMs: opts.waitMs },
        signal: opts.signal,
      });
    },
    async setVersionActiveSimulation(documentId, revisionId, simKey, signal) {
      await call(documents.setVersionActiveSimulation, { params: { documentId, revisionId }, body: { simKey }, signal });
    },
    getVersionContent(documentId, revisionId, signal) {
      return call(documents.getVersionContent, { params: { documentId, revisionId }, signal });
    },
    restoreVersion(document, revisionId, signal) {
      return call(documents.restoreVersion, {
        params: { documentId: document.id, revisionId },
        body: { expectedVersion: document.draftVersion },
        signal,
      });
    },
    compareSimulations(baseSimKey, candidateSimKey, signal) {
      return call(documents.compareSimulations, { query: { base: baseSimKey, candidate: candidateSimKey }, signal });
    },
    async getMapPinStatus(documentId, signal) {
      const status = await call(documents.getMapPinStatus, { params: { documentId }, signal });
      const { pinnedDescriptor, ...rest } = status;
      return { ...rest, pinnedMap: pinnedDescriptor ? mapEntry(pinnedDescriptor) : null };
    },
    previewMapRepin(documentId, request, signal) {
      return call(documents.previewMapRepin, { params: { documentId }, body: request, signal });
    },
    moveToMapVersion(document, targetMapVersionId, signal) {
      return call(documents.moveToMapVersion, {
        params: { documentId: document.id },
        body: { expectedVersion: document.draftVersion, targetMapVersionId },
        signal,
      });
    },
  };

  const artifacts: StudioArtifactService = {
    listMaps(signal, opts) {
      if (opts?.fresh) shared.invalidate(MAP_READ_KEY);
      return shared.read(MAP_READ_KEY, MAP_SHARE_MS, async () => (await call(maps.list, {})).maps.map(mapEntry), signal);
    },
    async getMapVersionIdentity(mapVersionId, signal) {
      try {
        return await call(maps.versionIdentity, { params: { mapVersionId }, signal });
      } catch (error) {
        if (error instanceof StudioHostRequestError && error.status === 404) return null;
        throw error;
      }
    },
    listMapFootprints(signal) {
      return shared.read(MAP_FOOTPRINT_READ_KEY, MAP_SHARE_MS, () => call(maps.footprints, {}), signal);
    },
    getArtifact(artifactId, opts = {}) {
      return call(maps.getArtifact, { params: { artifactId }, query: opts.download ? { download: 1 } : {}, signal: opts.signal });
    },
    async openArtifact(artifactId) {
      const artifact = await artifacts.getArtifact(artifactId);
      const anchor = window.document.createElement("a");
      anchor.href = artifact.downloadUrl;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
    },
    async downloadArtifact(artifactId) {
      const artifact = await artifacts.getArtifact(artifactId, { download: true });
      const anchor = window.document.createElement("a");
      anchor.href = artifact.downloadUrl;
      anchor.download = artifact.kind === "compiled-xosc" ? "scenario.xosc" : artifact.id;
      anchor.click();
    },
    async listArtifactIndex(opts, signal) {
      return (await call(maps.artifactIndex, { query: { artifactKind: opts.artifactKind, limit: opts.limit }, signal })).items;
    },
    async resolveRenderArtifactUrl(renderJobId, artifactId, signal) {
      const items = await jobs.listDownloads(renderJobId, signal);
      return items.find((item) => item.id === artifactId) ?? null;
    },
  };

  const jobs: StudioJobService = {
    submitRenderIntent(input, signal) {
      return call(jobEndpoints.submitRenderIntent, { body: input, signal });
    },
    getRenderJob(jobId, signal) {
      return call(jobEndpoints.getRenderJob, { params: { jobId }, signal });
    },
    cancelRenderJob(jobId) {
      return call(jobEndpoints.cancelRenderJob, { params: { jobId } });
    },
    getRenderJobProvenance(jobId, signal) {
      return call(jobEndpoints.renderJobProvenance, { params: { jobId }, signal });
    },
    getRenderJobDetail(jobId, signal) {
      return call(jobEndpoints.renderJobDetail, { params: { jobId }, signal });
    },
    async listDownloads(jobId, signal) {
      return (await call(jobEndpoints.renderJobDownloads, { params: { jobId }, signal })).items;
    },
    listGallery(opts, signal) {
      return call(jobEndpoints.gallery, {
        query: { revisionId: opts.revisionId, documentId: opts.documentId, jobMode: opts.jobMode, limit: opts.limit },
        signal,
      });
    },
    async listPostprocessChildren(parentRenderJobId, signal) {
      return (await call(jobEndpoints.postprocessChildren, { params: { jobId: parentRenderJobId }, signal })).items;
    },
    createPostprocessJob(input) {
      const { parentRenderJobId, ...body } = input;
      return call(jobEndpoints.createPostprocess, { params: { jobId: parentRenderJobId }, body });
    },
    setRenderJobHidden(jobId, hidden) {
      return call(jobEndpoints.setRenderJobHidden, { params: { jobId }, body: { hidden } });
    },

    prepareExport(revisionId, idempotencyKey, signal) {
      return call(jobEndpoints.prepareExport, { body: { revisionId, idempotencyKey }, signal });
    },
    async listExports(revisionId, signal) {
      return (await call(jobEndpoints.listExports, { query: { revisionId }, signal })).exports;
    },
    getExport(exportId, signal) {
      return call(jobEndpoints.getExport, { params: { exportId }, signal });
    },
    inspectExport(exportId, signal) {
      return call(jobEndpoints.inspectExport, { params: { exportId }, signal });
    },
    async waitForExport(revisionId, exportId, opts = {}) {
      const attempts = opts.attempts ?? 120;
      const intervalMs = opts.intervalMs ?? 1_000;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = (await jobs.listExports(revisionId, opts.signal)).find((item) => item.id === exportId);
        if (!result) throw new Error("The revision export is no longer available");
        if (result.executionPackageId) return result;
        if (result.status === "succeeded") throw new Error("Export finished without an immutable execution package");
        if (result.status === "failed" || result.status === "cancelled") throw new Error(result.errorCode ?? "OpenSCENARIO export failed");
        await delay(intervalMs, opts.signal);
      }
      throw new Error("OpenSCENARIO export did not finish in time");
    },

    async listValidationRuns(revisionId, signal) {
      return (await call(jobEndpoints.listValidationRuns, { query: { revisionId }, signal })).validationRuns;
    },
    createValidationRun(input, signal) {
      return call(jobEndpoints.createValidationRun, { body: input, signal });
    },

    async listOperationalJobs(input = {}, signal) {
      return (await call(jobEndpoints.listOperationalJobs, {
        query: { family: input.family, revisionId: input.revisionId, limit: input.limit },
        signal,
      })).jobs;
    },
    getOperationalJob(jobId, signal) {
      return call(jobEndpoints.getOperationalJob, { params: { jobId }, signal });
    },
    cancelOperationalJob(jobId) {
      return call(jobEndpoints.cancelOperationalJob, { params: { jobId } });
    },
  };

  const runtime: StudioRuntimeService = {
    capabilities(opts = {}) {
      if (opts.fresh) shared.invalidate(CAPABILITIES_READ_KEY);
      return shared.read(CAPABILITIES_READ_KEY, 60_000, () => call(runtimeEndpoints.capabilities, {}), opts.signal);
    },
  };

  return { projects, artifacts, jobs, runtime };
}
