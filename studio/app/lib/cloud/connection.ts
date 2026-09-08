import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StudioCloudStatus, StudioCloudUser } from "@simforge-oss/studio-host";
import { z } from "zod";
import { openSecretVault, type SecretVault } from "./vault";
import { discardResponseBody } from "@/app/lib/cloud/drain";

/**
 * The installed Studio's connection to SimCloud.
 *
 * Privileged, server-only state of the local service: OAuth pending state and
 * PKCE verifier, the server-issued native session (short-lived access token,
 * rotated refresh token) and the account it belongs to. Tokens live in the OS
 * vault (or the reported session-only vault) and never reach the renderer,
 * receipts, artifacts or logs; the renderer sees {@link StudioCloudStatus}
 * only. Connecting changes nothing about local projects or compute — it makes
 * {@link cloudRequest} usable for the modules that need the account.
 */

export const CLOUD_CLIENT_ID = "simforge-desktop";
/** The repository's production application origin; overridable for isolated qualification. */
export const DEFAULT_CLOUD_ORIGIN = "https://simforge.ai";
const VAULT_SERVICE = "simforge-studio";
const CREDENTIAL_SCHEMA = "simforge.cloud-credential/v1";
const PENDING_TTL_MS = 10 * 60_000;
/** Refresh ahead of expiry so an in-flight request never carries a token about to lapse. */
const ACCESS_REFRESH_SKEW_MS = 60_000;
const MAX_REDIRECTS = 5;
const TOKEN_TIMEOUT_MS = 30_000;

export type CloudConnectionErrorCode =
  | "cloud_disconnected"
  | "cloud_session_expired"
  | "cloud_unreachable"
  | "cloud_invalid_path"
  | "cloud_invalid_origin"
  | "cloud_callback_rejected";

export class CloudConnectionError extends Error {
  constructor(readonly code: CloudConnectionErrorCode, message: string = code) {
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
  }),
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
  }),
});

type Pending = {
  state: string;
  verifier: string;
  origin: string;
  redirectUri: string;
  createdAt: number;
};

type ConnectionState = {
  loaded: Promise<void> | null;
  vault: SecretVault | null;
  credential: Credential | null;
  pending: Pending | null;
  /** Set when the server refused the refresh token; cleared by sign-in/out. */
  expiredMessage: string | null;
  message: string | null;
  refreshing: Promise<Credential> | null;
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

/** The local service's own loopback origin, where the system browser is sent back to. */
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
    state.vault = await openSecretVault(VAULT_SERVICE);
    const origin = normalizeCloudOrigin(undefined);
    const raw = await state.vault.get(vaultAccount(origin));
    if (!raw) return;
    const parsed = CredentialSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.origin === origin) {
      state.credential = parsed.data;
    } else {
      // Unreadable or foreign-origin entry: not ours to keep.
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
  return { id: credential.user.id, email: credential.user.email, name: credential.user.name };
}

export async function getCloudStatus(): Promise<StudioCloudStatus> {
  await ensureLoaded();
  const origin = normalizeCloudOrigin(undefined);
  const persistence = state.vault?.persistence ?? "session";
  const now = Date.now();
  if (state.pending && now - state.pending.createdAt > PENDING_TTL_MS) {
    state.pending = null;
    state.message = "Sign-in timed out. Start again from Studio.";
  }
  if (state.pending) {
    return { state: "connecting", origin, user: null, credentialPersistence: persistence, sessionExpiresAt: null, message: null };
  }
  const credential = state.credential;
  if (credential && (state.expiredMessage !== null || credential.sessionExpiresAt <= now)) {
    return {
      state: "expired",
      origin,
      user: toUser(credential),
      credentialPersistence: persistence,
      sessionExpiresAt: new Date(credential.sessionExpiresAt).toISOString(),
      message: state.expiredMessage ?? "Your SimCloud session has expired. Sign in again.",
    };
  }
  if (credential) {
    return {
      state: "connected",
      origin,
      user: toUser(credential),
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

export async function beginCloudConnect(options: { origin?: string } = {}): Promise<{ authorizationUrl: string }> {
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
  token: z.infer<typeof TokenResponseSchema>,
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
    user: { id: token.user.id, email: token.user.email ?? null, name: token.user.name ?? null },
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
  const credential = credentialFromToken(result.token, pending.origin, randomBytes(16).toString("base64url"));
  state.expiredMessage = null;
  state.message = null;
  await storeCredential(credential, pending.origin);
  return { ok: true, user: toUser(credential) };
}

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
      const next = credentialFromToken(result.token, current.origin, current.connectionId);
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
  if (!credential) throw new CloudConnectionError("cloud_disconnected", "Not connected to SimCloud");
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

function stripCredentialHeaders(headers: Headers) {
  headers.delete("authorization");
  headers.delete("x-simforge-workspace-id");
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
  options: { workspaceId?: string; signal?: AbortSignal } = {},
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
    if (options.workspaceId) headers.set("x-simforge-workspace-id", options.workspaceId);
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
