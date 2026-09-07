/**
 * The one HTTP client both hosts use to reach the SimCloud compute control
 * plane (`/api/simforge/compute`).
 *
 * The browser portal talks to it same-origin with the session cookie. The
 * desktop app talks to the same routes through its configured cloud origin and
 * must name its workspace explicitly on every scoped write — a desktop write
 * without `X-SimForge-Workspace-Id` is refused with `workspace_required`, by
 * design, so the header is part of this client rather than each caller.
 *
 * The gateway never decides authorization, cost or provider. It surfaces the
 * server's refusal verbatim: {@link ComputeApiError} keeps the machine `code`
 * and the payload so the UI can explain rather than retry blindly.
 */

import type {
  ComputeEstimate,
  ComputeJob,
  ComputeJobKind,
  ComputeJobPage,
  ComputeJobStatus,
  ComputeJobSubmission,
  EvalResultManifest,
  UploadCompletion,
  UploadPurpose,
  UploadReservation,
} from "./contracts";
import { readEvalResultManifest } from "./contracts";

export class ComputeApiError extends Error {
  readonly status: number;
  /** The server's machine-readable `error` field, when it sent one. */
  readonly code: string | null;
  readonly payload: unknown;

  constructor(status: number, code: string | null, message: string, payload: unknown) {
    super(message);
    this.name = "ComputeApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export type ArtifactDownloadGrant = {
  url: string;
  expiresAt: string;
  mediaType: string;
  bytes: number;
};

export type ListJobsQuery = {
  status?: readonly ComputeJobStatus[];
  kind?: ComputeJobKind;
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
};

export type EvaluationGateway = {
  listJobs(query?: ListJobsQuery): Promise<ComputeJobPage>;
  getJob(jobId: string, signal?: AbortSignal): Promise<ComputeJob>;
  /** The durable manifest itself. Rejects with `result_not_available` while non-terminal. */
  getJobResult(jobId: string, signal?: AbortSignal): Promise<EvalResultManifest>;
  /** Short-TTL exact-object GET grant. Never cached, never held in a DTO. */
  artifactDownloadGrant(
    jobId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactDownloadGrant>;
  submitJob(submission: ComputeJobSubmission, signal?: AbortSignal): Promise<ComputeJob>;
  cancelJob(jobId: string, signal?: AbortSignal): Promise<{ id: string; status: ComputeJobStatus }>;
  estimate(
    request: { kind: ComputeJobKind; input: ComputeJobSubmission["input"] },
    signal?: AbortSignal,
  ): Promise<ComputeEstimate>;
  reserveUpload(
    request: {
      purpose: UploadPurpose;
      mediaType: string;
      sha256: string;
      sizeBytes: number;
      filename?: string;
      metadata?: Record<string, string>;
    },
    signal?: AbortSignal,
  ): Promise<UploadReservation>;
  completeUpload(
    uploadId: string,
    body?: { parts?: { partNumber: number; etag: string }[] },
    signal?: AbortSignal,
  ): Promise<UploadCompletion>;
};

export const COMPUTE_API_PATH = "/api/simforge/compute" as const;

/**
 * The desktop renderer holds no cloud credentials — the local service does —
 * so the desktop points this at its own authenticated proxy, which forwards to
 * the same routes under the same contract.
 */
export const DESKTOP_COMPUTE_PROXY_PATH = "/api/simforge/cloud/compute" as const;

export type EvaluationGatewayOptions = {
  /** Origin the compute API lives on. Empty string means same-origin. */
  baseUrl?: string;
  /** Route prefix; defaults to {@link COMPUTE_API_PATH}. */
  basePath?: string;
  /** Required for desktop-scope writes; harmless for browser sessions. */
  workspaceId?: string | null;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
};

const WORKSPACE_HEADER = "X-SimForge-Workspace-Id";

export function createHttpEvaluationGateway(
  options: EvaluationGatewayOptions = {},
): EvaluationGateway {
  const base = `${(options.baseUrl ?? "").replace(/\/+$/, "")}${options.basePath ?? COMPUTE_API_PATH}`;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  function headers(json: boolean): Record<string, string> {
    const result: Record<string, string> = { accept: "application/json", ...options.headers };
    if (json) result["content-type"] = "application/json";
    if (options.workspaceId) result[WORKSPACE_HEADER] = options.workspaceId;
    return result;
  }

  async function request<T>(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method: init.method,
      headers: headers(init.body !== undefined),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const code = typeof record.error === "string" ? record.error : null;
      const detail = typeof record.message === "string" ? record.message : null;
      throw new ComputeApiError(
        response.status,
        code,
        detail ?? code ?? `${init.method} ${path} failed with ${response.status}`,
        payload,
      );
    }
    return payload as T;
  }

  return {
    async listJobs(query = {}) {
      const params = new URLSearchParams();
      if (query.status?.length) params.set("status", query.status.join(","));
      if (query.kind) params.set("kind", query.kind);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor) params.set("cursor", query.cursor);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return request<ComputeJobPage>(`/jobs${suffix}`, { method: "GET", signal: query.signal });
    },

    async getJob(jobId, signal) {
      return request<ComputeJob>(`/jobs/${encodeURIComponent(jobId)}`, { method: "GET", signal });
    },

    async getJobResult(jobId, signal) {
      const payload = await request<unknown>(`/jobs/${encodeURIComponent(jobId)}/result`, {
        method: "GET",
        signal,
      });
      const manifest = readEvalResultManifest(payload);
      if (!manifest) {
        throw new ComputeApiError(
          200,
          "result_unreadable",
          "The stored result does not match simforge.eval-result-manifest/v1 and cannot be displayed.",
          payload,
        );
      }
      return manifest;
    },

    async artifactDownloadGrant(jobId, artifactId, signal) {
      return request<ArtifactDownloadGrant>(
        `/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
        { method: "POST", body: {}, signal },
      );
    },

    async submitJob(submission, signal) {
      return request<ComputeJob>("/jobs", { method: "POST", body: submission, signal });
    },

    async cancelJob(jobId, signal) {
      return request<{ id: string; status: ComputeJobStatus }>(
        `/jobs/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST", body: {}, signal },
      );
    },

    async estimate(estimateRequest, signal) {
      return request<ComputeEstimate>("/estimate", {
        method: "POST",
        body: estimateRequest,
        signal,
      });
    },

    async reserveUpload(reserveRequest, signal) {
      return request<UploadReservation>("/uploads/reserve", {
        method: "POST",
        body: reserveRequest,
        signal,
      });
    },

    async completeUpload(uploadId, body = {}, signal) {
      return request<UploadCompletion>(`/uploads/${encodeURIComponent(uploadId)}/complete`, {
        method: "POST",
        body,
        signal,
      });
    },
  };
}
