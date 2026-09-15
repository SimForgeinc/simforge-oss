/**
 * The real SimCloud platform, reached the way the product reaches it.
 *
 * Every call here goes through Node's `fetch`, because that is the defect
 * class this module exists to cover: `POST /api/desktop/auth/sign-in`
 * answered 200 to `curl` and 500 to every real client, since Node's fetch
 * sends `sec-fetch-mode: cors` with no `Origin` and the platform's
 * Fetch-Metadata check escalated on exactly that combination. A curl-shaped
 * request is therefore worthless as coverage — it is the shape that passed
 * while the product was broken for everyone.
 *
 * Accounts are created through the product's own sign-up endpoint and are
 * throwaway per run. Nothing here writes to production: {@link cloudOrigin}
 * refuses a production origin outright, because a test that can reach
 * production is one mistyped environment variable away from mutating it.
 */

import { randomBytes } from "node:crypto";
import { E2E_ENV, envValue } from "./env";

/** The header the platform scopes a tenant call by; it carries a *workspace* id. */
export const WORKSPACE_HEADER = "x-simforge-workspace-id";

/** Header shapes that distinguish a real client from a curl-shaped request. */
export const REQUEST_SHAPES = {
  /**
   * What Node's `fetch` and the packaged desktop client actually send. This
   * is the shape that returned 500 while the curl-shaped one returned 200.
   */
  nodeClient: { "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty" },
  /** A curl-shaped request: no Fetch-Metadata headers at all. */
  curl: {},
  /** A browser cross-origin request, which does carry an `Origin`. */
  browser: { origin: "https://studio.invalid", "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" },
} as const satisfies Record<string, Record<string, string>>;

export type CloudAccount = {
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
  readonly userId: string;
  /** The workspace the platform created for this account. */
  readonly workspaceId: string;
  readonly organizationId: string;
  /** Revoke this session. Safe to call twice. */
  revoke(): Promise<void>;
};

export type CloudResponse<T = unknown> = {
  readonly status: number;
  readonly body: T;
  /** The raw text, for assertions on a non-JSON error page. */
  readonly text: string;
};

/**
 * The environment under test. Production is refused rather than merely
 * defaulted away from: read-only intent is not enforceable once a token is in
 * hand, so the origin is the place to stop it.
 */
export function cloudOrigin(): string {
  const origin = envValue(E2E_ENV.cloudOrigin) ?? envValue(E2E_ENV.stagingOrigin) ?? "https://staging.simforge.ai";
  const { hostname } = new URL(origin);
  if (hostname === "simforge.ai" || hostname === "www.simforge.ai") {
    throw new Error(`Refusing to run the real-stack suite against production (${origin}); use dev or staging`);
  }
  return origin;
}

/** One request to the platform, as a real client sends it. */
export async function cloudFetch<T = unknown>(
  path: string,
  init: RequestInit & { shape?: Record<string, string>; bearer?: string } = {},
): Promise<CloudResponse<T>> {
  const { shape = REQUEST_SHAPES.nodeClient, bearer, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("accept", "application/json");
  if (rest.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  for (const [name, value] of Object.entries(shape)) headers.set(name, value);
  if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);
  const response = await fetch(new URL(path, cloudOrigin()), { ...rest, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // An HTML error page is a legitimate answer to assert on; keep the text.
  }
  return { status: response.status, body: body as T, text };
}

type TokenResponse = {
  access_token?: string;
  user?: { id?: string; email?: string; email_verified?: boolean };
  active_organization_id?: string;
  active_workspace_id?: string;
};

type WorkspaceResponse = { workspaces?: { id?: string; organization_id?: string }[] };

async function signUp(email: string, password: string): Promise<CloudResponse<TokenResponse>> {
  return cloudFetch<TokenResponse>("/api/desktop/auth/sign-up", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Real Stack Suite", device_label: "real-stack-suite" }),
  });
}

/**
 * A fresh account, created through `POST /api/desktop/auth/sign-up`.
 *
 * Per-run rather than shared: a shared account accumulates state that makes
 * "the catalogue shows one map signed out" and "this account has no
 * artifacts" false in ways no test can see, and two runs at once fight over
 * it. Sign-up costs under a second here, so there is no reason to share.
 *
 * The address is unique per run and sits on the `studio-test+` subaddress the
 * project already uses for QA identities.
 */
export async function createThrowawayAccount(): Promise<CloudAccount> {
  const email = `studio-test+rs-${Date.now()}-${randomBytes(3).toString("hex")}@simforge.ai`;
  const password = `Rs-${randomBytes(12).toString("base64url")}-9!`;
  /*
   * Sign-up is throttled to four attempts a minute on staging (measured: the
   * fifth returns 429 `{"error":"throttled"}`). A suite that creates an
   * account per test therefore fails on its own success rate rather than on
   * the product, so callers share one account per file and this retries the
   * throttle rather than surfacing it as a product failure. Waiting is
   * correct here: the limit is a real property of the environment and the
   * alternative — reusing a long-lived account — is what makes "this account
   * has no artifacts" quietly untrue.
   */
  let created = await signUp(email, password);
  for (let attempt = 0; attempt < 5 && created.status === 429; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 65_000));
    created = await signUp(email, password);
  }
  if (created.status !== 200 || created.body.access_token === undefined) {
    throw new Error(`Could not create a throwaway account: HTTP ${created.status} ${created.text.slice(0, 300)}`);
  }
  const accessToken = created.body.access_token;
  const workspaces = await cloudFetch<WorkspaceResponse>("/api/desktop/projects/workspaces", { bearer: accessToken });
  const workspace = workspaces.body.workspaces?.[0];
  if (workspace?.id === undefined || workspace.organization_id === undefined) {
    throw new Error(`A new account has no workspace: HTTP ${workspaces.status} ${workspaces.text.slice(0, 300)}`);
  }
  return {
    email,
    password,
    accessToken,
    userId: created.body.user?.id ?? "",
    workspaceId: workspace.id,
    organizationId: workspace.organization_id,
    async revoke() {
      await cloudFetch("/api/desktop/revoke", { method: "POST", bearer: accessToken, body: "{}" });
    },
  };
}

/** Sign in an existing identity, as the product does. */
export async function signInToCloud(
  email: string,
  password: string,
  shape: Record<string, string> = REQUEST_SHAPES.nodeClient,
): Promise<CloudResponse<TokenResponse>> {
  return cloudFetch<TokenResponse>("/api/desktop/auth/sign-in", {
    method: "POST",
    shape,
    body: JSON.stringify({ email, password, device_label: "real-stack-suite" }),
  });
}

/** A well-formed workspace id that belongs to nobody. */
export function foreignWorkspaceId(): string {
  return `ws_${randomBytes(12).toString("hex")}`;
}
