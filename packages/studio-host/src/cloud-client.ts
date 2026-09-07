import type {
  StudioCloudPublishResult,
  StudioCloudService,
  StudioCloudStatus,
  StudioCloudWorkspace,
} from "./cloud";
import type { ScenarioArtifactDto, ScenarioDatasetDto, WorkspaceArtifact } from "./contracts";
import { StudioHostRequestError } from "./errors";

export type HttpStudioCloudServiceOptions = {
  /** Origin the local `/api/simforge/cloud/*` routes live on. Defaults to same-origin relative paths. */
  baseUrl?: string;
  /** Injected for tests and non-browser callers. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

type ErrorBody = {
  error?: string;
  message?: string;
};

const CLOUD = "/api/simforge/cloud";

/** Product messages for the connection route error codes. */
export const STUDIO_CLOUD_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  cloud_disconnected: "Connect to SimCloud to use cloud maps and storage.",
  cloud_session_expired: "Your SimCloud session has expired. Connect again to continue.",
  cloud_connect_pending: "A SimCloud connection is already waiting for approval in your browser.",
  cloud_origin_rejected: "That SimCloud origin is not allowed.",
  cloud_unreachable: "SimCloud could not be reached. Check your connection and try again.",
  cloud_workspace_forbidden: "You are not a member of that SimCloud workspace.",
};

/**
 * The one HTTP implementation of the local Cloud connector.
 *
 * Talks only to the LOCAL service's `/api/simforge/cloud/*` routes; the
 * service owns credentials and speaks to SimCloud on the renderer's behalf, so
 * no token, code or verifier ever reaches this client. It is deliberately not
 * part of `StudioHostServices`: connecting changes account state, never the
 * host that persists local projects or runs local jobs.
 */
export function createHttpStudioCloudService(options: HttpStudioCloudServiceOptions = {}): StudioCloudService {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "";

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${CLOUD}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (response.ok) {
      return (response.status === 204 ? undefined : await response.json()) as T;
    }
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    const code = body?.error ?? `request_failed_${response.status}`;
    throw new StudioHostRequestError(
      code,
      response.status,
      body?.message ?? STUDIO_CLOUD_ERROR_MESSAGES[code] ?? (body?.error ? undefined : `Request failed (${response.status}).`),
    );
  }

  return {
    status(signal) {
      return request<StudioCloudStatus>("/status", { signal });
    },
    connect(input = {}, signal) {
      return request<{ authorizationUrl: string }>("/connect", {
        method: "POST",
        body: JSON.stringify(input.origin ? { origin: input.origin } : {}),
        signal,
      });
    },
    disconnect(signal) {
      return request<StudioCloudStatus>("/disconnect", { method: "POST", signal });
    },
    async listWorkspaces(signal) {
      const body = await request<{ workspaces: StudioCloudWorkspace[] }>("/workspaces", { signal });
      return body.workspaces;
    },
    async listDatasets(workspaceId, signal) {
      const body = await request<{ datasets: ScenarioDatasetDto[] }>(
        `/datasets?workspaceId=${encodeURIComponent(workspaceId)}`,
        { signal },
      );
      return body.datasets;
    },
    importDataset(source, signal) {
      return request<ScenarioDatasetDto>("/datasets/import", {
        method: "POST",
        body: JSON.stringify(source),
        signal,
      });
    },
    publishDataset(input, signal) {
      return request<StudioCloudPublishResult>("/datasets/publish", {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      });
    },
    async listArtifacts(workspaceId, signal) {
      const body = await request<{ artifacts: WorkspaceArtifact[] }>(
        `/artifacts?workspaceId=${encodeURIComponent(workspaceId)}`,
        { signal },
      );
      return body.artifacts;
    },
    importArtifact(source, signal) {
      return request<ScenarioArtifactDto>("/artifacts/import", {
        method: "POST",
        body: JSON.stringify(source),
        signal,
      });
    },
    uploadArtifact(input, signal) {
      return request<{ workspaceId: string; artifactId: string }>("/artifacts/upload", {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      });
    },
  };
}
