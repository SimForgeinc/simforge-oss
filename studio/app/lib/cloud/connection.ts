import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import type {
  StudioCloudAccount,
  StudioCloudInvitation,
  StudioCloudOrganization,
  StudioCloudProvider,
  StudioCloudStatus,
  StudioCloudUser,
} from "@simforge-oss/studio-host";
import { z } from "zod";
import { openSecretVault, type SecretVault } from "./vault";
import { discardResponseBody } from "@/app/lib/cloud/drain";

/**
 * The installed Studio's connection to SimCloud.
 *
 * Privileged, server-only state of the local service: the server-issued
 * native session (short-lived access token, rotated refresh token), the
 * account it belongs to, and — for the Google/GitHub hop only — the pending
 * PKCE state. Every other account flow (password sign-in, sign-up, email
 * verification, password reset, devices, invitations) is a
 * direct call from this module to the Cloud's native desktop API. Tokens live
 * in the OS vault (or the reported session-only vault) and never reach the
 * renderer, receipts, artifacts or logs; the renderer sees
 * {@link StudioCloudStatus} and the account payloads only. Signing in changes
 * nothing about local projects or compute — it makes {@link cloudRequest}
 * usable for the modules that need the account.
 */

export const CLOUD_CLIENT_ID = "simforge-desktop";
/** The repository's production application origin; overridable for isolated qualification. */
export const DEFAULT_CLOUD_ORIGIN = "https://simforge.ai";
const VAULT_SERVICE = "simforge-studio";
/** v1 entries (consent-flow sessions without `emailVerified`) fail the parse and are dropped: one fresh sign-in. */
const CREDENTIAL_SCHEMA = "simforge.cloud-credential/v2";
const PENDING_TTL_MS = 10 * 60_000;
/** Refresh ahead of expiry so an in-flight request never carries a token about to lapse. */
const ACCESS_REFRESH_SKEW_MS = 60_000;
const MAX_REDIRECTS = 5;
const TOKEN_TIMEOUT_MS = 30_000;
/** The provider list is cosmetic (which social buttons to show); never let it slow status down for long. */
const PROVIDERS_TIMEOUT_MS = 5_000;
const PROVIDERS_RETRY_MS = 60_000;
const DEVICE_LABEL_MAX = 80;

/** Local connector failures, plus the Cloud's native auth error codes passed through as-is. */
export type CloudConnectionErrorCode =
  | "cloud_disconnected"
  | "cloud_session_expired"
  | "cloud_unreachable"
  | "cloud_invalid_path"
  | "cloud_invalid_origin"
  | "cloud_invalid_response"
  | "cloud_callback_rejected"
  | "invalid_request"
  | "invalid_credentials"
  | "email_taken"
  | "email_unverified"
  | "invalid_code"
  | "code_expired"
  | "weak_password"
  | "throttled"
  | "account_banned"
  | "invalid_token"
  | "not_member"
  | (string & {});

export class CloudConnectionError extends Error {
  /** The Cloud's HTTP status when the error mirrors one of its answers; 0 for local failures. */
  constructor(readonly code: CloudConnectionErrorCode, message: string = code, readonly status = 0) {
    super(message);
    this.name = "CloudConnectionError";
  }
}

const CredentialSchema = z.object({
  schema: z.literal(CREDENTIAL_SCHEMA),
  origin: z.string().url(),
  /** Rotates on every sign-in; part of the asset authorization scope. */
  connectionId: z.string().min(16),
  accessToken: z.string().min(1),
  accessExpiresAt: z.number().int(),
  refreshToken: z.string().min(1),
  sessionExpiresAt: z.number().int(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().nullable(),
    name: z.string().nullable(),
    emailVerified: z.boolean(),
  }),
  activeOrganizationId: z.string().min(1).nullable().default(null),
});
type Credential = z.infer<typeof CredentialSchema>;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_expires_in: z.number().int().positive(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    email_verified: z.boolean().default(false),
  }),
});
type TokenResponse = z.infer<typeof TokenResponseSchema>;

const ProviderSchema = z.enum(["google", "github"]);
const ProvidersResponseSchema = z.object({ providers: z.array(z.string()) });

const AccountResponseSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    email_verified: z.boolean().default(false),
  }),
  active_organization_id: z.string().min(1).nullable().default(null),
  sessions: z.array(z.object({
    id: z.string().min(1),
    label: z.string().nullable().default(null),
    user_agent: z.string().nullable().default(null),
    created_at: z.string(),
    last_used_at: z.string().nullable().default(null),
    active: z.boolean().default(true),
    current: z.boolean().default(false),
  })),
});

const InvitationsResponseSchema = z.object({
  invitations: z.array(z.object({
    id: z.string().min(1),
    organization_id: z.string().min(1),
    organization_name: z.string(),
    role: z.string(),
    inviter_email: z.string().nullable().default(null),
    expires_at: z.string(),
  })),
});

const OrganizationResponseSchema = z.object({ organization_id: z.string().min(1) });
const ActiveOrganizationResponseSchema = z.object({ active_organization_id: z.string().min(1).nullable() });

type Pending = {
  state: string;
  verifier: string;
  origin: string;
  redirectUri: string;
  createdAt: number;
};

type ConnectionState = {
  loaded: Promise<void> | null;
  /** Pre-seeded by tests; otherwise opened on first load. */
  vault: SecretVault | null;
  credential: Credential | null;
  pending: Pending | null;
  /** Set when the server refused the refresh token; cleared by sign-in/out. */
  expiredMessage: string | null;
  message: string | null;
  refreshing: Promise<Credential> | null;
  /** Configured social providers; `null` until fetched once, `[]` while the Cloud cannot say. */
  providers: StudioCloudProvider[] | null;
  providersFetch: Promise<StudioCloudProvider[]> | null;
  /** Earliest time a failed provider fetch is retried. */
  providersRetryAt: number;
};

// One state per process regardless of how many module instances a dev server
// evaluates; the vault is the durable store, this is its working copy.
const STATE_KEY = Symbol.for("simforge.cloud-connection");
const state: ConnectionState = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= {
  loaded: null,
  vault: null,
  credential: null,
  pending: null,
  expiredMessage: null,
  message: null,
  refreshing: null,
  providers: null,
  providersFetch: null,
  providersRetryAt: 0,
} satisfies ConnectionState) as ConnectionState;

function isLoopbackHost(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/** HTTPS everywhere; literal loopback HTTP only for isolated qualification against a local Cloud. */
export function normalizeCloudOrigin(candidate: string | undefined): string {
  const raw = candidate?.trim() || process.env.SIMFORGE_CLOUD_ORIGIN?.trim() || DEFAULT_CLOUD_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudConnectionError("cloud_invalid_origin", `invalid Cloud origin: ${raw}`);
  }
  const loopbackHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password
    || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new CloudConnectionError("cloud_invalid_origin", `Cloud origin must be an https origin: ${raw}`);
  }
  return url.origin;
}

/** The local service's own loopback origin, where the system browser is sent back to after a social sign-in. */
export function localServiceOrigin(): string {
  const port = Number(process.env.PORT?.trim() || "5199");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("invalid_local_port");
  return `http://127.0.0.1:${port}`;
}

function vaultAccount(origin: string) {
  return `cloud:${origin}`;
}

async function ensureLoaded(): Promise<void> {
  state.loaded ??= (async () => {
    state.vault ??= await openSecretVault(VAULT_SERVICE);
    const origin = normalizeCloudOrigin(undefined);
    const raw = await state.vault.get(vaultAccount(origin));
    if (!raw) return;
    const parsed = CredentialSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.origin === origin) {
      state.credential = parsed.data;
    } else {
      // Unreadable, outdated or foreign-origin entry: not ours to keep.
      await state.vault.delete(vaultAccount(origin));
    }
  })().catch((error) => {
    state.message = error instanceof Error ? error.message : String(error);
    state.vault ??= null;
  });
  await state.loaded;
}

async function storeCredential(credential: Credential | null, origin: string) {
  const vault = state.vault ?? (state.vault = await openSecretVault(VAULT_SERVICE));
  state.credential = credential;
  if (credential) await vault.set(vaultAccount(origin), JSON.stringify(credential));
  else await vault.delete(vaultAccount(origin));
}

function sessionActive(credential: Credential | null, now = Date.now()): credential is Credential {
  return credential !== null && credential.sessionExpiresAt > now && state.expiredMessage === null;
}

function toUser(credential: Credential): StudioCloudUser {
  return {
    id: credential.user.id,
    email: credential.user.email,
    name: credential.user.name,
    emailVerified: credential.user.emailVerified,
  };
}

/**
 * The social providers the Cloud has configured. Fetched once per process and
 * kept; a failed fetch answers `[]` and is retried after a cool-down, in the
 * background, so status never waits on the Cloud more than once.
 */
export async function listCloudProviders(signal?: AbortSignal): Promise<StudioCloudProvider[]> {
  const cached = state.providers ?? null;
  if (cached !== null && (cached.length > 0 || Date.now() < state.providersRetryAt)) return cached;
  state.providersFetch ??= (async () => {
    try {
      const body = await cloudAuthRequest("/api/desktop/auth/providers", {
        method: "GET",
        timeoutMs: PROVIDERS_TIMEOUT_MS,
        signal,
      });
      const providers = ProvidersResponseSchema.parse(body).providers
        .filter((provider): provider is StudioCloudProvider => ProviderSchema.safeParse(provider).success);
      state.providers = providers;
      state.providersRetryAt = providers.length > 0 ? Number.POSITIVE_INFINITY : Date.now() + PROVIDERS_RETRY_MS;
      return providers;
    } catch {
      state.providers = [];
      state.providersRetryAt = Date.now() + PROVIDERS_RETRY_MS;
      return [];
    } finally {
      state.providersFetch = null;
    }
  })();
  // First answer is awaited (bounded by the short timeout); retries refresh silently.
  if (cached === null) return state.providersFetch;
  return cached;
}

export async function getCloudStatus(): Promise<StudioCloudStatus> {
  await ensureLoaded();
  const origin = normalizeCloudOrigin(undefined);
  const persistence = state.vault?.persistence ?? "session";
  const providers = await listCloudProviders();
  const now = Date.now();
  if (state.pending && now - state.pending.createdAt > PENDING_TTL_MS) {
    state.pending = null;
    state.message = "The browser sign-in timed out. Start again from Studio.";
  }
  if (state.pending) {
    return {
      state: "connecting",
      origin,
      user: null,
      activeOrganizationId: null,
      providers,
      credentialPersistence: persistence,
      sessionExpiresAt: null,
      message: null,
    };
  }
  const credential = state.credential;
  if (credential && (state.expiredMessage !== null || credential.sessionExpiresAt <= now)) {
    return {
      state: "expired",
      origin,
      user: toUser(credential),
      activeOrganizationId: credential.activeOrganizationId,
      providers,
      credentialPersistence: persistence,
      sessionExpiresAt: new Date(credential.sessionExpiresAt).toISOString(),
      message: state.expiredMessage ?? "Your SimCloud session has ended. Sign in again.",
    };
  }
  if (credential) {
    return {
      state: "connected",
      origin,
      user: toUser(credential),
      activeOrganizationId: credential.activeOrganizationId,
      providers,
      credentialPersistence: persistence,
      sessionExpiresAt: new Date(credential.sessionExpiresAt).toISOString(),
      message: persistence === "session"
        ? "The OS credential vault is unavailable; this sign-in lasts until Studio closes."
        : null,
    };
  }
  return {
    state: state.message ? "error" : "disconnected",
    origin,
    user: null,
    activeOrganizationId: null,
    providers,
    credentialPersistence: persistence,
    sessionExpiresAt: null,
    message: state.message,
  };
}

/**
 * Synchronous view for asset authorization: no vault or network work. The
 * scope names the authority (origin), account and this sign-in, so a
 * sign-out/sign-in cycle yields a different scope and earlier grants lapse.
 */
export function cloudSessionScope(): { active: boolean; origin: string; scope: string | null } {
  const origin = normalizeCloudOrigin(undefined);
  const credential = state.credential;
  if (!sessionActive(credential)) return { active: false, origin, scope: null };
  return { active: true, origin, scope: `cloud:${origin}:${credential.user.id}:${credential.connectionId}` };
}

/** Whether the vault has been read at least once, so {@link cloudSessionScope} is meaningful. */
export async function primeCloudSession(): Promise<void> {
  await ensureLoaded();
}

// ── Native auth API ───────────────────────────────────────────────────────────

type AuthRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Record<string, string>;
  /** Send the session's access token; refresh once and retry on a rejected token. */
  bearer?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

async function sendAuthRequest(url: URL, init: AuthRequestOptions, token: string | null): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TOKEN_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    return await fetch(url, {
      method: init.method ?? "POST",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new CloudConnectionError(
      "cloud_unreachable",
      `SimCloud at ${url.origin} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

/** A non-2xx native API answer, in the contract's `{error, error_description}` shape. */
async function authResponseError(response: Response): Promise<CloudConnectionError> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown; error_description?: unknown } | null;
  const code = typeof payload?.error === "string" && payload.error
    ? payload.error
    : response.status === 429 ? "throttled" : `cloud_request_failed_${response.status}`;
  const description = typeof payload?.error_description === "string" && payload.error_description
    ? payload.error_description
    : `SimCloud answered ${response.status} (${code}).`;
  return new CloudConnectionError(code, description, response.status);
}

/**
 * One call to the Cloud's native desktop API (`/api/desktop/**`). Unauthenticated
 * unless `bearer`, in which case the current access token is sent and a
 * rejected token (`401 invalid_token`) is refreshed once before one retry; a
 * second rejection marks the session expired. Errors keep the Cloud's code
 * and status so routes can mirror them. Never logs the body.
 */
export async function cloudAuthRequest(path: string, options: AuthRequestOptions = {}): Promise<unknown> {
  await ensureLoaded();
  const origin = normalizeCloudOrigin(undefined);
  const url = resolveCloudPath(path, origin);
  let response: Response;
  if (options.bearer) {
    let credential = await validAccessToken(options.signal);
    response = await sendAuthRequest(url, options, credential.accessToken);
    if (response.status === 401) {
      await discardResponseBody(response);
      credential = await validAccessToken(options.signal, true);
      response = await sendAuthRequest(url, options, credential.accessToken);
      if (response.status === 401) {
        state.expiredMessage = "SimCloud rejected the current session. Sign in again.";
        await discardResponseBody(response);
        throw new CloudConnectionError("cloud_session_expired", state.expiredMessage, 401);
      }
    }
  } else {
    response = await sendAuthRequest(url, options, null);
  }
  if (!response.ok) throw await authResponseError(response);
  if (response.status === 204) return null;
  return response.json().catch(() => {
    throw new CloudConnectionError("cloud_invalid_response", "SimCloud answered with a body that is not JSON.", 502);
  });
}

function parseOrInvalid<S extends z.ZodTypeAny>(schema: S, payload: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new CloudConnectionError("cloud_invalid_response", `SimCloud answered with an unexpected ${what} payload.`, 502);
  }
  return parsed.data as z.output<S>;
}

/** A user-facing name for this computer, as the Cloud lists it under Devices. */
function deviceLabel(): string {
  const name = hostname().trim();
  return (name || "SimForge Studio").slice(0, DEVICE_LABEL_MAX);
}

async function adoptToken(token: TokenResponse, origin: string): Promise<Credential> {
  const credential = credentialFromToken(token, origin, randomBytes(16).toString("base64url"));
  state.pending = null;
  state.expiredMessage = null;
  state.message = null;
  await storeCredential(credential, origin);
  return credential;
}

async function patchCredential(patch: (current: Credential) => Credential): Promise<void> {
  const current = state.credential;
  if (!current) return;
  await storeCredential(patch(current), current.origin);
}

export async function signInCloud(input: { email: string; password: string }, signal?: AbortSignal): Promise<StudioCloudStatus> {
  const payload = await cloudAuthRequest("/api/desktop/auth/sign-in", {
    body: { email: input.email, password: input.password, device_label: deviceLabel() },
    signal,
  });
  await adoptToken(parseOrInvalid(TokenResponseSchema, payload, "token"), normalizeCloudOrigin(undefined));
  return getCloudStatus();
}

export async function signUpCloud(
  input: { email: string; password: string; name: string },
  signal?: AbortSignal,
): Promise<StudioCloudStatus> {
  const payload = await cloudAuthRequest("/api/desktop/auth/sign-up", {
    body: { email: input.email, password: input.password, name: input.name, device_label: deviceLabel() },
    signal,
  });
  await adoptToken(parseOrInvalid(TokenResponseSchema, payload, "token"), normalizeCloudOrigin(undefined));
  return getCloudStatus();
}

export async function verifyCloudEmail(code: string, signal?: AbortSignal): Promise<StudioCloudStatus> {
  await cloudAuthRequest("/api/desktop/auth/verify-email", { bearer: true, body: { code }, signal });
  await patchCredential((current) => ({ ...current, user: { ...current.user, emailVerified: true } }));
  return getCloudStatus();
}

export async function resendCloudVerification(signal?: AbortSignal): Promise<StudioCloudStatus> {
  await cloudAuthRequest("/api/desktop/auth/verify-email/resend", { bearer: true, signal });
  return getCloudStatus();
}

export async function forgotCloudPassword(email: string, signal?: AbortSignal): Promise<void> {
  await cloudAuthRequest("/api/desktop/auth/password/forgot", { body: { email }, signal });
}

/**
 * Reset with the emailed code. The Cloud revokes every desktop session of
 * that account, so a matching local sign-in is dropped rather than left to
 * fail on its next refresh.
 */
export async function resetCloudPassword(
  input: { email: string; code: string; newPassword: string },
  signal?: AbortSignal,
): Promise<StudioCloudStatus> {
  await cloudAuthRequest("/api/desktop/auth/password/reset", {
    body: { email: input.email, code: input.code, new_password: input.newPassword },
    signal,
  });
  const credential = state.credential;
  if (credential && (credential.user.email === null || credential.user.email.toLowerCase() === input.email.trim().toLowerCase())) {
    state.expiredMessage = null;
    await storeCredential(null, credential.origin);
  }
  return getCloudStatus();
}

/** The Cloud revokes the account's other desktop sessions; this one continues. */
export async function changeCloudPassword(
  input: { currentPassword: string; newPassword: string },
  signal?: AbortSignal,
): Promise<void> {
  await cloudAuthRequest("/api/desktop/auth/password/change", {
    bearer: true,
    body: { current_password: input.currentPassword, new_password: input.newPassword },
    signal,
  });
}

async function adoptAccount(payload: unknown): Promise<StudioCloudAccount> {
  const account = parseOrInvalid(AccountResponseSchema, payload, "account");
  // The Cloud is the authority on the profile; keep the local copy in step.
  await patchCredential((current) => ({
    ...current,
    user: {
      ...current.user,
      email: account.user.email ?? current.user.email,
      name: account.user.name ?? null,
      emailVerified: account.user.email_verified,
    },
    activeOrganizationId: account.active_organization_id,
  }));
  return {
    user: {
      id: account.user.id,
      email: account.user.email ?? null,
      name: account.user.name ?? null,
      emailVerified: account.user.email_verified,
    },
    activeOrganizationId: account.active_organization_id,
    sessions: account.sessions.map((session) => ({
      id: session.id,
      label: session.label,
      userAgent: session.user_agent,
      createdAt: session.created_at,
      lastUsedAt: session.last_used_at,
      active: session.active,
      current: session.current,
    })),
  };
}

export async function getCloudAccount(signal?: AbortSignal): Promise<StudioCloudAccount> {
  return adoptAccount(await cloudAuthRequest("/api/desktop/account", { method: "GET", bearer: true, signal }));
}

export async function updateCloudAccount(input: { name: string }, signal?: AbortSignal): Promise<StudioCloudAccount> {
  return adoptAccount(await cloudAuthRequest("/api/desktop/account", {
    method: "PATCH",
    bearer: true,
    body: { name: input.name },
    signal,
  }));
}

export async function revokeCloudSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  await cloudAuthRequest(`/api/desktop/account/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    bearer: true,
    signal,
  });
}

export async function listCloudInvitations(signal?: AbortSignal): Promise<StudioCloudInvitation[]> {
  const payload = await cloudAuthRequest("/api/desktop/invitations", { method: "GET", bearer: true, signal });
  return parseOrInvalid(InvitationsResponseSchema, payload, "invitations").invitations.map((invitation) => ({
    id: invitation.id,
    organizationId: invitation.organization_id,
    organizationName: invitation.organization_name,
    role: invitation.role,
    inviterEmail: invitation.inviter_email,
    expiresAt: invitation.expires_at,
  }));
}

export async function acceptCloudInvitation(invitationId: string, signal?: AbortSignal): Promise<{ organizationId: string }> {
  const payload = await cloudAuthRequest(`/api/desktop/invitations/${encodeURIComponent(invitationId)}/accept`, {
    bearer: true,
    signal,
  });
  return { organizationId: parseOrInvalid(OrganizationResponseSchema, payload, "invitation").organization_id };
}

export async function declineCloudInvitation(invitationId: string, signal?: AbortSignal): Promise<void> {
  await cloudAuthRequest(`/api/desktop/invitations/${encodeURIComponent(invitationId)}/decline`, { bearer: true, signal });
}

/** `token` is the invite token or the whole invite URL; the Cloud extracts `token=` itself. */
export async function acceptCloudInvitationLink(token: string, signal?: AbortSignal): Promise<{ organizationId: string }> {
  const payload = await cloudAuthRequest("/api/desktop/invitations/accept-link", { bearer: true, body: { token }, signal });
  return { organizationId: parseOrInvalid(OrganizationResponseSchema, payload, "invitation").organization_id };
}

// ── Social hop (Google / GitHub) ──────────────────────────────────────────────

/**
 * Start the one flow that leaves the app: the Cloud bounces the system
 * browser to the provider and returns it to the loopback callback with a
 * PKCE-bound code. No consent page and no password ever cross this path.
 */
export async function beginCloudConnect(options: { origin?: string; provider: StudioCloudProvider }): Promise<{ authorizationUrl: string }> {
  await ensureLoaded();
  const origin = normalizeCloudOrigin(options.origin);
  if (origin !== normalizeCloudOrigin(undefined)) {
    // One installation connects to one Cloud; the origin is configuration, not a per-request choice.
    throw new CloudConnectionError("cloud_invalid_origin", "Cloud origin does not match this installation");
  }
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const pending: Pending = {
    state: randomBytes(32).toString("base64url"),
    verifier,
    origin,
    redirectUri: `${localServiceOrigin()}/api/simforge/cloud/callback`,
    createdAt: Date.now(),
  };
  state.pending = pending;
  state.message = null;
  const url = new URL("/desktop/connect", origin);
  url.searchParams.set("provider", options.provider);
  url.searchParams.set("client_id", CLOUD_CLIENT_ID);
  url.searchParams.set("redirect_uri", pending.redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pending.state);
  return { authorizationUrl: url.toString() };
}

async function postToken(origin: string, body: Record<string, string>, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(new URL("/api/desktop/token", origin), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      throw new CloudConnectionError(
        "cloud_unreachable",
        `SimCloud at ${origin} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = (payload as { error?: unknown } | null)?.error;
      return { ok: false as const, status: response.status, error: typeof code === "string" ? code : "token_request_failed" };
    }
    const parsed = TokenResponseSchema.safeParse(payload);
    if (!parsed.success) return { ok: false as const, status: response.status, error: "invalid_token_response" };
    return { ok: true as const, token: parsed.data };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function credentialFromToken(
  token: TokenResponse,
  origin: string,
  connectionId: string,
  now = Date.now(),
): Credential {
  return {
    schema: CREDENTIAL_SCHEMA,
    origin,
    connectionId,
    accessToken: token.access_token,
    accessExpiresAt: now + token.expires_in * 1000,
    refreshToken: token.refresh_token,
    sessionExpiresAt: now + token.refresh_expires_in * 1000,
    user: {
      id: token.user.id,
      email: token.user.email ?? null,
      name: token.user.name ?? null,
      emailVerified: token.user.email_verified,
    },
    activeOrganizationId: state.credential?.user.id === token.user.id ? state.credential.activeOrganizationId : null,
  };
}

export type CloudCallbackResult =
  | { ok: true; user: StudioCloudUser }
  | { ok: false; error: string };

/**
 * Consume the one pending state, exchange the code server-side and store the
 * session. Every failure clears the pending state: a callback is one-shot.
 */
export async function completeCloudCallback(params: URLSearchParams): Promise<CloudCallbackResult> {
  await ensureLoaded();
  const pending = state.pending;
  const presented = params.get("state") ?? "";
  const expectedBuffer = Buffer.from(pending?.state ?? "");
  const presentedBuffer = Buffer.from(presented);
  const stateMatches = pending !== null
    && expectedBuffer.byteLength === presentedBuffer.byteLength
    && timingSafeEqual(expectedBuffer, presentedBuffer);
  if (!pending || !stateMatches || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    // Do not consume a live pending flow for a stray or forged callback.
    if (pending && Date.now() - pending.createdAt > PENDING_TTL_MS) state.pending = null;
    return { ok: false, error: "callback_state_mismatch" };
  }
  state.pending = null;
  const denied = params.get("error");
  if (denied) {
    state.message = denied === "access_denied" ? "Sign-in was declined." : `Sign-in failed: ${denied}`;
    return { ok: false, error: denied };
  }
  const code = params.get("code");
  if (!code) {
    state.message = "Sign-in failed: no authorization code.";
    return { ok: false, error: "missing_code" };
  }
  const result = await postToken(pending.origin, {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
    client_id: CLOUD_CLIENT_ID,
  }).catch((error: unknown) => {
    if (error instanceof CloudConnectionError) return { ok: false as const, status: 0, error: error.message };
    throw error;
  });
  if (!result.ok) {
    state.message = `Sign-in failed: ${result.error}`;
    return { ok: false, error: result.error };
  }
  const credential = await adoptToken(result.token, pending.origin);
  return { ok: true, user: toUser(credential) };
}

// ── Session upkeep ────────────────────────────────────────────────────────────

/** Refresh the access token; coalesced so concurrent callers share one rotation. */
async function refreshCredential(current: Credential, signal?: AbortSignal): Promise<Credential> {
  state.refreshing ??= (async () => {
    try {
      const result = await postToken(current.origin, {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: CLOUD_CLIENT_ID,
      }, signal);
      if (!result.ok) {
        if (result.status === 400 || result.status === 401) {
          state.expiredMessage = "SimCloud no longer accepts this session. Sign in again.";
          throw new CloudConnectionError("cloud_session_expired", state.expiredMessage);
        }
        throw new CloudConnectionError("cloud_unreachable", `token refresh failed (${result.status})`);
      }
      // Same sign-in: the connection scope is unchanged by rotation.
      const next = { ...credentialFromToken(result.token, current.origin, current.connectionId), activeOrganizationId: current.activeOrganizationId };
      await storeCredential(next, current.origin);
      return next;
    } finally {
      state.refreshing = null;
    }
  })();
  return state.refreshing;
}

async function validAccessToken(signal?: AbortSignal, forceRefresh = false): Promise<Credential> {
  await ensureLoaded();
  const credential = state.credential;
  if (!credential) throw new CloudConnectionError("cloud_disconnected", "Not signed in to SimCloud");
  if (!sessionActive(credential)) {
    throw new CloudConnectionError("cloud_session_expired", state.expiredMessage ?? "SimCloud session expired");
  }
  if (!forceRefresh && credential.accessExpiresAt - ACCESS_REFRESH_SKEW_MS > Date.now()) return credential;
  return refreshCredential(credential, signal);
}

export async function disconnectCloud(): Promise<StudioCloudStatus> {
  await ensureLoaded();
  const credential = state.credential;
  state.pending = null;
  state.message = null;
  state.expiredMessage = null;
  if (credential) {
    // Best effort: an offline logout still clears local credentials.
    try {
      await fetch(new URL("/api/desktop/revoke", credential.origin), {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ refresh_token: credential.refreshToken }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch {
      // Offline or already revoked; the local session ends regardless.
    }
    await storeCredential(null, credential.origin);
  }
  return getCloudStatus();
}

// ── Legacy workspace wire adapter ─────────────────────────────────────────────

/**
 * SimCloud as deployed still speaks *workspace* on its desktop surface: it
 * enumerates tenants as workspace rows (`/api/desktop/projects/workspaces`
 * answers `{id,name,role}`), and a scoped desktop request must name the tenant
 * it acts in through `x-simforge-workspace-id`, which the server verifies
 * against the caller's membership — a desktop write that names none is refused
 * with `workspace_required`. A workspace row and an organization are 1:1 there
 * (`workspaces.auth_organization_id`) and the desktop surface exposes no
 * organization listing at all, so this block is where the legacy name stops:
 * it presents each tenant as a {@link StudioCloudOrganization} and puts that
 * organization's wire id back into the legacy header. No other OSS module
 * knows the word. When the platform resolves organization membership directly
 * (`docs/engineering/local-cloud-boundary.md` §8 step 2), delete this block and
 * send `organizationId` under its own name.
 */
const LEGACY_WORKSPACE_HEADER = "x-simforge-workspace-id";
const LEGACY_ORGANIZATION_LIST_PATH = "/api/desktop/projects/workspaces";

const OrganizationsResponseSchema = z.object({
  workspaces: z.array(z.object({ id: z.string().min(1), name: z.string(), role: z.string() })),
});

/** The organizations this account may act in, with the membership role the server holds. */
export async function listCloudOrganizations(signal?: AbortSignal): Promise<StudioCloudOrganization[]> {
  const response = await cloudRequest(LEGACY_ORGANIZATION_LIST_PATH, { method: "GET" }, { signal });
  if (!response.ok) {
    await discardResponseBody(response);
    throw new CloudConnectionError(
      "cloud_organizations_unavailable",
      "SimCloud could not list your organizations.",
      response.status,
    );
  }
  return parseOrInvalid(OrganizationsResponseSchema, await response.json(), "organizations").workspaces;
}

function stripCredentialHeaders(headers: Headers) {
  headers.delete("authorization");
  headers.delete(LEGACY_WORKSPACE_HEADER);
  headers.delete("cookie");
}

/**
 * Authenticated request to the connected Cloud. `path` is a same-origin
 * absolute path such as `/api/simforge/maps`; other origins are refused.
 * Redirects are followed by hand so a cross-origin artifact delivery hop
 * (presigned storage) never receives the bearer token. One expired-token
 * retry is performed; a persisting 401 is returned to the caller and marks the
 * connection expired.
 */
export async function cloudRequest(
  path: string,
  init: RequestInit = {},
  options: { organizationId?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  let credential = await validAccessToken(options.signal);
  const target = resolveCloudPath(path, credential.origin);
  const bodyIsReplayable = init.body === undefined || init.body === null
    || typeof init.body === "string" || init.body instanceof Uint8Array
    || init.body instanceof URLSearchParams || init.body instanceof Blob;
  const send = async (token: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", headers.get("accept") ?? "application/json");
    if (options.organizationId) headers.set(LEGACY_WORKSPACE_HEADER, options.organizationId);
    return followRedirects(target, { ...init, headers }, credential.origin, options.signal);
  };
  let response = await send(credential.accessToken);
  if (response.status === 401 && bodyIsReplayable) {
    await discardResponseBody(response);
    credential = await validAccessToken(options.signal, true);
    response = await send(credential.accessToken);
    if (response.status === 401) {
      state.expiredMessage = "SimCloud rejected the current session. Sign in again.";
    }
  }
  return response;
}

/**
 * Unauthenticated request to the configured Cloud for content the server
 * publishes anonymously (the public RFS catalog and its assets).
 */
export async function cloudPublicRequest(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const origin = normalizeCloudOrigin(undefined);
  const headers = new Headers(init.headers);
  stripCredentialHeaders(headers);
  headers.set("accept", headers.get("accept") ?? "application/json");
  return followRedirects(resolveCloudPath(path, origin), { ...init, headers }, origin, signal);
}

function resolveCloudPath(path: string, origin: string): URL {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new CloudConnectionError("cloud_invalid_path", `cloudRequest path must be an absolute same-origin path: ${path}`);
  }
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new CloudConnectionError("cloud_invalid_path", `path escapes the Cloud origin: ${path}`);
  return url;
}

async function followRedirects(url: URL, init: RequestInit, origin: string, signal?: AbortSignal): Promise<Response> {
  let current = url;
  let request: RequestInit = { ...init, cache: "no-store", redirect: "manual", signal };
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current, request);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new CloudConnectionError(
        "cloud_unreachable",
        `SimCloud at ${origin} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) return response;
    if (hop >= MAX_REDIRECTS) throw new CloudConnectionError("cloud_unreachable", "too many redirects");
    await discardResponseBody(response);
    const next = new URL(location, current);
    if (next.protocol !== "https:" && !(next.protocol === "http:" && isLoopbackHost(next.hostname))) {
      throw new CloudConnectionError("cloud_unreachable", `refused redirect to ${next.protocol}//${next.host}`);
    }
    const headers = new Headers(request.headers);
    if (next.origin !== origin) stripCredentialHeaders(headers);
    // 303, and 301/302 on POST, become GET; a redirected body is never replayed cross-origin.
    const method = response.status === 303 || ((response.status === 301 || response.status === 302) && request.method?.toUpperCase() === "POST")
      ? "GET"
      : request.method;
    request = {
      ...request,
      method,
      headers,
      body: method === "GET" || next.origin !== origin ? undefined : request.body,
    };
    current = next;
  }
}
