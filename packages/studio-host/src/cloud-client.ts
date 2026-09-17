import type {
  StudioCloudAccount,
  StudioCloudAccountDeletion,
  StudioCloudInvitation,
  StudioCloudOrganization,
  StudioCloudPublishResult,
  StudioCloudService,
  StudioCloudStatus,
} from "./cloud";
import type { IndexedArtifact, ScenarioArtifactDto, ScenarioDatasetDto } from "./contracts";
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

/**
 * Product messages for the connection and account error codes. A known code
 * gets this copy; anything else keeps the local service's message.
 *
 * `cloud_desktop_api_missing` is deliberately absent: its message names the
 * configured Cloud origin, which fixed copy here cannot, so the service's own
 * wording must reach the screen.
 */
export const STUDIO_CLOUD_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  cloud_disconnected: "Sign in to SimCloud to use cloud maps and storage.",
  cloud_session_expired: "Your SimCloud session has ended. Sign in again to continue.",
  cloud_connect_pending: "A Google or GitHub sign-in is already waiting in your browser.",
  cloud_origin_rejected: "That SimCloud origin is not allowed.",
  cloud_unreachable: "SimCloud could not be reached. Check your connection and try again.",
  invalid_request: "Check the form and try again.",
  invalid_credentials: "That email or password is incorrect.",
  email_taken: "An account with that email already exists.",
  email_unverified: "Verify your email address to continue.",
  invalid_code: "That code is not right. Check the email and try again.",
  code_expired: "That code has expired. Request a new one.",
  weak_password: "Choose a stronger password: at least 8 characters.",
  throttled: "Too many attempts. Wait a moment and try again.",
  account_banned: "This account is not available.",
  invalid_token: "Your session is no longer valid. Sign in again.",
  not_member: "You are not a member of that SimCloud organization.",
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

  /**
   * `preferServerMessage` keeps the local service's message instead of the
   * product copy below. Used by the destructive verbs, whose refusals are
   * specific in a way generic copy cannot be — which organization blocks the
   * deletion and how many members it has, or the fact that a rejected password
   * deleted nothing.
   */
  async function request<T>(path: string, init: RequestInit = {}, preferServerMessage = false): Promise<T> {
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
    const known = preferServerMessage
      ? body?.message ?? STUDIO_CLOUD_ERROR_MESSAGES[code]
      : STUDIO_CLOUD_ERROR_MESSAGES[code] ?? body?.message;
    throw new StudioHostRequestError(
      code,
      response.status,
      known ?? (body?.error ? undefined : `Request failed (${response.status}).`),
    );
  }

  const post = <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), signal });

  return {
    status(signal) {
      return request<StudioCloudStatus>("/status", { signal });
    },
    connect(input, signal) {
      return post<{ authorizationUrl: string }>("/connect", input, signal);
    },
    signIn(input, signal) {
      return post<StudioCloudStatus>("/auth/sign-in", input, signal);
    },
    signUp(input, signal) {
      return post<StudioCloudStatus>("/auth/sign-up", input, signal);
    },
    verifyEmail(input, signal) {
      return post<StudioCloudStatus>("/auth/verify-email", input, signal);
    },
    resendVerification(signal) {
      return post<StudioCloudStatus>("/auth/verify-email/resend", undefined, signal);
    },
    forgotPassword(input, signal) {
      return post<{ ok: true }>("/auth/password/forgot", input, signal);
    },
    resetPassword(input, signal) {
      return post<StudioCloudStatus>("/auth/password/reset", input, signal);
    },
    changePassword(input, signal) {
      return post<{ ok: true }>("/auth/password/change", input, signal);
    },
    account(signal) {
      return request<StudioCloudAccount>("/account", { signal });
    },
    updateAccount(input, signal) {
      return request<StudioCloudAccount>("/account", { method: "PATCH", body: JSON.stringify(input), signal });
    },
    deleteAccount(input, signal) {
      return request<StudioCloudAccountDeletion>(
        "/account",
        { method: "DELETE", body: JSON.stringify(input), signal },
        true,
      );
    },
    revokeSession(id, signal) {
      return request<{ ok: true }>(`/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE", signal });
    },
    async listInvitations(signal) {
      const body = await request<{ invitations: StudioCloudInvitation[] }>("/invitations", { signal });
      return body.invitations;
    },
    acceptInvitation(id, signal) {
      return post<{ organizationId: string }>(`/invitations/${encodeURIComponent(id)}/accept`, undefined, signal);
    },
    declineInvitation(id, signal) {
      return post<{ ok: true }>(`/invitations/${encodeURIComponent(id)}/decline`, undefined, signal);
    },
    acceptInvitationLink(token, signal) {
      return post<{ organizationId: string }>("/invitations/accept-link", { token }, signal);
    },
    setActiveOrganization(organizationId, signal) {
      return post<StudioCloudStatus>("/organizations/active", { organizationId }, signal);
    },
    disconnect(signal) {
      return post<StudioCloudStatus>("/disconnect", undefined, signal);
    },
    async listOrganizations(signal) {
      const body = await request<{ organizations: StudioCloudOrganization[] }>("/organizations", { signal });
      return body.organizations;
    },
    async listDatasets(organizationId, signal) {
      const body = await request<{ datasets: ScenarioDatasetDto[] }>(
        `/datasets?organizationId=${encodeURIComponent(organizationId)}`,
        { signal },
      );
      return body.datasets;
    },
    importDataset(source, signal) {
      return post<ScenarioDatasetDto>("/datasets/import", source, signal);
    },
    publishDataset(input, signal) {
      return post<StudioCloudPublishResult>("/datasets/publish", input, signal);
    },
    async listArtifacts(organizationId, signal) {
      const body = await request<{ artifacts: IndexedArtifact[] }>(
        `/artifacts?organizationId=${encodeURIComponent(organizationId)}`,
        { signal },
      );
      return body.artifacts;
    },
    importArtifact(source, signal) {
      return post<ScenarioArtifactDto>("/artifacts/import", source, signal);
    },
    uploadArtifact(input, signal) {
      return post<{ organizationId: string; artifactId: string }>("/artifacts/upload", input, signal);
    },
  };
}
