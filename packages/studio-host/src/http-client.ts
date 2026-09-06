import type { StudioHostCapabilities } from "./capabilities";
import type {
  CreateScenarioRevisionResultDto,
  PresignedArtifact,
  ScenarioArtifactDto,
  ScenarioConflictDto,
  ScenarioDatasetDto,
  ScenarioDocumentDto,
  ScenarioExportDto,
  ScenarioGalleryItemDto,
  ScenarioMapDescriptorDto,
  ScenarioMaterializedTrafficReferenceDto,
  ScenarioOperationalJobDto,
  ScenarioRatingAggregateDto,
  ScenarioRevisionDto,
  ScenarioSimulationPreviewDto,
  ScenarioTagDto,
  ScenarioValidationRunDto,
  WorkspaceArtifact,
} from "./contracts";
import { ScenarioNameConflict, ScenarioVersionConflict, StudioHostRequestError } from "./errors";
import type {
  StudioArtifactService,
  StudioHostServices,
  StudioJobService,
  StudioMapEntry,
  StudioProjectService,
  StudioRuntimeService,
} from "./services";
import { SharedReads } from "./shared-read";

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

type UploadReservation = {
  artifactId: string;
  uploadRequired: boolean;
  uploadUrl: string | null;
  headers: Record<string, string>;
};

const DATASET_READ_KEY = "datasets";
const TAG_READ_KEY = "tags";
const MAP_READ_KEY = "maps";
const CAPABILITIES_READ_KEY = "capabilities";
const MAP_SHARE_MS = 5 * 60_000;
const RENDER_JOBS = "/api/simforge/render-jobs";

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

/**
 * The one HTTP implementation of the Studio host boundary.
 *
 * Both hosts serve the same `/api/simforge/*` wire contract; identity travels
 * as same-origin cookies (fixed local owner, or the cloud account session), so
 * the client never carries product auth. Every read is `no-store`: routes send
 * `private, no-store` and each call takes an `AbortSignal` so a panel that
 * closes cancels its own in-flight request instead of resolving into an
 * unmounted tree.
 */
export function createHttpStudioHost(options: HttpStudioHostOptions = {}): StudioHostServices {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "";
  const shared = new SharedReads();

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (response.ok) {
      return (response.status === 204 ? undefined : await response.json()) as T;
    }
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    if (response.status === 409 && body?.error === "draft_version_conflict") {
      const conflict = body as Partial<ScenarioConflictDto>;
      throw new ScenarioVersionConflict(conflict.currentDraftVersion ?? null, conflict.current ?? null);
    }
    if (response.status === 409 && (body?.error === "dataset_name_taken" || body?.error === "tag_label_taken")) {
      throw new ScenarioNameConflict(body.error, body.field ?? "name");
    }
    const code = body?.error ?? `request_failed_${response.status}`;
    throw new StudioHostRequestError(
      code,
      response.status,
      body?.message ?? (body?.error ? undefined : `Request failed (${response.status}).`),
    );
  }

  async function getArtifact(artifactId: string, opts: { download?: boolean; signal?: AbortSignal } = {}) {
    return request<ScenarioArtifactDto>(
      `/api/simforge/artifacts/${encodeURIComponent(artifactId)}${opts.download ? "?download=1" : ""}`,
      { signal: opts.signal },
    );
  }

  async function uploadReserved(reservation: UploadReservation, bytes: Uint8Array, label: string, signal?: AbortSignal) {
    if (!reservation.uploadRequired) return;
    if (!reservation.uploadUrl) throw new Error(`${label} reservation has no upload URL`);
    const uploaded = await fetchImpl(reservation.uploadUrl, {
      method: "PUT",
      headers: reservation.headers,
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      signal,
    });
    if (!uploaded.ok) throw new Error(`${label} upload failed (${uploaded.status})`);
  }

  const projects: StudioProjectService = {
    async listDatasets(signal) {
      const body = await shared.read(
        DATASET_READ_KEY,
        0,
        () => request<{ datasets: ScenarioDatasetDto[] }>("/api/simforge/datasets"),
        signal,
      );
      return body.datasets;
    },
    createDataset(input) {
      return shared.invalidateAfter(
        DATASET_READ_KEY,
        request<ScenarioDatasetDto>("/api/simforge/datasets", { method: "POST", body: JSON.stringify(input) }),
      );
    },
    updateDataset(datasetId, input) {
      return shared.invalidateAfter(
        DATASET_READ_KEY,
        request<ScenarioDatasetDto>(`/api/simforge/datasets/${encodeURIComponent(datasetId)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      );
    },
    deleteDataset(datasetId) {
      return shared.invalidateAfter(
        DATASET_READ_KEY,
        request<{ ok: true; deletedDocumentCount: number }>(`/api/simforge/datasets/${encodeURIComponent(datasetId)}`, {
          method: "DELETE",
        }),
      );
    },
    getDatasetReadiness(datasetId, signal) {
      return request(`/api/simforge/datasets/${encodeURIComponent(datasetId)}/readiness`, { signal });
    },

    listDocumentSummaries(input, signal) {
      const query = new URLSearchParams({ datasetId: input.datasetId, limit: String(input.limit ?? 50) });
      if (input.cursor) query.set("cursor", input.cursor);
      return request(`/api/simforge/documents/summaries?${query}`, { signal });
    },
    async listDocuments(datasetId, signal) {
      const body = await request<{ documents: ScenarioDocumentDto[] }>(
        `/api/simforge/documents?datasetId=${encodeURIComponent(datasetId)}`,
        { signal },
      );
      return body.documents;
    },
    getDocument(documentId, signal) {
      return request(`/api/simforge/documents/${encodeURIComponent(documentId)}`, { signal });
    },
    createDocument(input, opts = {}) {
      return request("/api/simforge/documents", {
        method: "POST",
        body: JSON.stringify(input),
        keepalive: opts.keepalive,
        signal: opts.signal,
      });
    },
    saveDocument(document, content, opts = {}) {
      return request(`/api/simforge/documents/${encodeURIComponent(document.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedVersion: document.draftVersion,
          title: opts.title ?? document.title,
          content,
          authoringQualityId: opts.authoringQualityId ?? document.authoringQualityId,
        }),
        keepalive: opts.keepalive,
      });
    },
    updateDocument(documentId, input) {
      return request(`/api/simforge/documents/${encodeURIComponent(documentId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
    },
    duplicateDocument(documentId, input = {}) {
      return request(`/api/simforge/documents/${encodeURIComponent(documentId)}/duplicate`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    deleteDocument(documentId) {
      return request(`/api/simforge/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
    },

    async listTags(signal) {
      const body = await shared.read(TAG_READ_KEY, 0, () => request<{ tags: ScenarioTagDto[] }>("/api/simforge/tags"), signal);
      return body.tags;
    },
    createTag(input) {
      return shared.invalidateAfter(
        TAG_READ_KEY,
        request<ScenarioTagDto>("/api/simforge/tags", { method: "POST", body: JSON.stringify(input) }),
      );
    },
    updateTag(tagId, input) {
      return shared.invalidateAfter(
        TAG_READ_KEY,
        request<ScenarioTagDto>(`/api/simforge/tags/${encodeURIComponent(tagId)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      );
    },
    deleteTag(tagId) {
      return shared.invalidateAfter(
        TAG_READ_KEY,
        request<{ ok: true }>(`/api/simforge/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" }),
      );
    },
    async setDocumentTags(documentId, tagIds) {
      const body = await request<{ tags: ScenarioTagDto[] }>(`/api/simforge/documents/${encodeURIComponent(documentId)}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tagIds }),
      });
      return body.tags;
    },

    async listRatingAggregates(documentIds, signal) {
      const body = await request<{ aggregates: ScenarioRatingAggregateDto[] }>("/api/simforge/documents/ratings/batch", {
        method: "POST",
        body: JSON.stringify({ documentIds }),
        signal,
      });
      return body.aggregates;
    },
    async setDocumentRating(documentId, input) {
      const body = await request<{ aggregate: ScenarioRatingAggregateDto | null }>(
        `/api/simforge/documents/${encodeURIComponent(documentId)}/rating`,
        { method: "PUT", body: JSON.stringify({ reviewedVia: "browser", ...input }) },
      );
      return body.aggregate;
    },
    async clearDocumentRating(documentId) {
      const body = await request<{ aggregate: ScenarioRatingAggregateDto | null }>(
        `/api/simforge/documents/${encodeURIComponent(documentId)}/rating`,
        { method: "DELETE" },
      );
      return body.aggregate;
    },

    async listRevisions(documentId, signal) {
      const body = await request<{ revisions: ScenarioRevisionDto[] }>(
        `/api/simforge/documents/${encodeURIComponent(documentId)}/revisions`,
        { signal },
      );
      return body.revisions;
    },
    createRevision(document, evidence, opts = {}) {
      return request(`/api/simforge/documents/${encodeURIComponent(document.id)}/revisions`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: document.draftVersion,
          idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(),
          ...evidence,
        }),
        signal: opts.signal,
      });
    },
    async ensureRevision(input) {
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
      if (!input.evidence) {
        throw new Error(
          "Preparing a new revision requires explicit traffic evidence for this saved draft; opening render history and ordinary playback never create it.",
        );
      }
      const retrySuffix = existing ? `:retry:${existing.export.id}` : "";
      return request<CreateScenarioRevisionResultDto>(`/api/simforge/documents/${encodeURIComponent(input.documentId)}/revisions`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: expectedDraftVersion,
          idempotencyKey: `ensure-revision:${input.documentId}:${expectedDraftVersion}${retrySuffix}`,
          ...input.evidence,
        }),
        signal: input.signal,
      });
    },

    async getSimulationPreview(documentId, signal) {
      const response = await fetchImpl(
        `${baseUrl}/api/simforge/documents/${encodeURIComponent(documentId)}/simulation-preview`,
        { cache: "no-store", headers: options.headers, signal },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new StudioHostRequestError("simulation_preview_lookup_failed", response.status, `Saved simulation lookup failed (${response.status}).`);
      return response.json() as Promise<ScenarioSimulationPreviewDto>;
    },
    async saveSimulationPreview(document, bytes, sha256, signal) {
      const identity = { expectedVersion: document.draftVersion, sha256, sizeBytes: bytes.byteLength };
      const base = `/api/simforge/documents/${encodeURIComponent(document.id)}/simulation-preview`;
      const reservation = await request<UploadReservation>(base, { method: "POST", body: JSON.stringify(identity), signal });
      await uploadReserved(reservation, bytes, "Saved simulation", signal);
      await request<{ ok: true }>(`${base}/complete`, {
        method: "POST",
        body: JSON.stringify({ ...identity, artifactId: reservation.artifactId }),
        signal,
      });
    },
    async uploadMaterializedTraffic(document, upload, sourceInputDigest, signal) {
      const identity = {
        sha256: upload.sha256,
        sizeBytes: upload.sizeBytes,
        sourceInputDigest,
        mapAssetId: upload.mapAssetId,
        mapVersionId: upload.mapVersionId,
      };
      const base = `/api/simforge/documents/${encodeURIComponent(document.id)}/materialized-traffic`;
      const reservation = await request<UploadReservation>(`${base}/reserve`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: document.draftVersion, ...identity }),
        signal,
      });
      await uploadReserved(reservation, upload.bytes, "Materialized traffic", signal);
      return request<ScenarioMaterializedTrafficReferenceDto>(`${base}/complete`, {
        method: "POST",
        body: JSON.stringify({ artifactId: reservation.artifactId, ...identity }),
        signal,
      });
    },
  };

  const artifacts: StudioArtifactService = {
    listMaps(signal) {
      return shared.read(
        MAP_READ_KEY,
        MAP_SHARE_MS,
        async () => (await request<{ maps: ScenarioMapDescriptorDto[] }>("/api/simforge/maps")).maps.map(mapEntry),
        signal,
      );
    },
    getArtifact,
    async openArtifact(artifactId) {
      const artifact = await getArtifact(artifactId);
      const anchor = window.document.createElement("a");
      anchor.href = artifact.downloadUrl;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
    },
    async downloadArtifact(artifactId) {
      const artifact = await getArtifact(artifactId, { download: true });
      const anchor = window.document.createElement("a");
      anchor.href = artifact.downloadUrl;
      anchor.download = artifact.kind === "compiled-xosc" ? "scenario.xosc" : artifact.id;
      anchor.click();
    },
    async listWorkspaceArtifacts(opts, signal) {
      const params = new URLSearchParams();
      if (opts.artifactKind) params.set("artifactKind", opts.artifactKind);
      if (opts.limit != null) params.set("limit", String(opts.limit));
      const query = params.toString();
      const body = await request<{ items: WorkspaceArtifact[] }>(`${RENDER_JOBS}/artifact-index${query ? `?${query}` : ""}`, { signal });
      return body.items;
    },
    async resolveRenderArtifactUrl(renderJobId, artifactId, signal) {
      const items = await jobs.listDownloads(renderJobId, signal);
      return items.find((item) => item.id === artifactId) ?? null;
    },
  };

  const jobs: StudioJobService = {
    submitRenderIntent(input, signal) {
      return request(RENDER_JOBS, { method: "POST", body: JSON.stringify(input), signal });
    },
    getRenderJob(jobId, signal) {
      return request(`${RENDER_JOBS}/${encodeURIComponent(jobId)}`, { signal });
    },
    cancelRenderJob(jobId) {
      return request(`${RENDER_JOBS}/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    },
    getRenderJobProvenance(jobId, signal) {
      return request(`${RENDER_JOBS}/${encodeURIComponent(jobId)}/provenance`, { signal });
    },
    getRenderJobDetail(jobId, signal) {
      return request(`${RENDER_JOBS}/${encodeURIComponent(jobId)}/detail`, { signal });
    },
    async listDownloads(jobId, signal) {
      const body = await request<{ items: PresignedArtifact[] }>(`${RENDER_JOBS}/${encodeURIComponent(jobId)}/downloads`, { signal });
      return body.items;
    },
    listGallery(opts, signal) {
      const params = new URLSearchParams();
      if (opts.revisionId) params.set("revisionId", opts.revisionId);
      if (opts.documentId) params.set("documentId", opts.documentId);
      if (opts.jobMode) params.set("jobMode", opts.jobMode);
      if (opts.limit != null) params.set("limit", String(opts.limit));
      const query = params.toString();
      return request(`${RENDER_JOBS}/gallery${query ? `?${query}` : ""}`, { signal });
    },
    async listPostprocessChildren(parentRenderJobId, signal) {
      const body = await request<{ items: ScenarioGalleryItemDto[] }>(
        `${RENDER_JOBS}/${encodeURIComponent(parentRenderJobId)}/postprocess`,
        { signal },
      );
      return body.items;
    },
    createPostprocessJob(input) {
      const { parentRenderJobId, ...body } = input;
      return request(`${RENDER_JOBS}/${encodeURIComponent(parentRenderJobId)}/postprocess`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    setRenderJobHidden(jobId, hidden) {
      return request(`${RENDER_JOBS}/${encodeURIComponent(jobId)}/hidden`, {
        method: "PATCH",
        body: JSON.stringify({ hidden }),
      });
    },

    prepareExport(revisionId, idempotencyKey, signal) {
      return request("/api/simforge/exports", { method: "POST", body: JSON.stringify({ revisionId, idempotencyKey }), signal });
    },
    async listExports(revisionId, signal) {
      const body = await request<{ exports: ScenarioExportDto[] }>(`/api/simforge/exports?revisionId=${encodeURIComponent(revisionId)}`, { signal });
      return body.exports;
    },
    getExport(exportId, signal) {
      return request(`/api/simforge/exports/${encodeURIComponent(exportId)}`, { signal });
    },
    inspectExport(exportId, signal) {
      return request(`/api/simforge/exports/${encodeURIComponent(exportId)}/inspection`, { signal });
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
      const body = await request<{ validationRuns: ScenarioValidationRunDto[] }>(
        `/api/simforge/validation-runs?revisionId=${encodeURIComponent(revisionId)}`,
        { signal },
      );
      return body.validationRuns;
    },
    createValidationRun(input, signal) {
      return request("/api/simforge/validation-runs", { method: "POST", body: JSON.stringify(input), signal });
    },

    async listOperationalJobs(input = {}, signal) {
      const params = new URLSearchParams();
      if (input.family) params.set("family", input.family);
      if (input.revisionId) params.set("revisionId", input.revisionId);
      if (input.limit != null) params.set("limit", String(input.limit));
      const query = params.toString();
      const body = await request<{ jobs: ScenarioOperationalJobDto[] }>(`/api/simforge/jobs${query ? `?${query}` : ""}`, { signal });
      return body.jobs;
    },
    getOperationalJob(jobId, signal) {
      return request(`/api/simforge/jobs/${encodeURIComponent(jobId)}`, { signal });
    },
    cancelOperationalJob(jobId) {
      return request(`/api/simforge/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    },
  };

  const runtime: StudioRuntimeService = {
    capabilities(opts = {}) {
      if (opts.fresh) shared.invalidate(CAPABILITIES_READ_KEY);
      return shared.read(
        CAPABILITIES_READ_KEY,
        60_000,
        () => request<StudioHostCapabilities>("/api/simforge/host/capabilities"),
        opts.signal,
      );
    },
  };

  return { projects, artifacts, jobs, runtime };
}
