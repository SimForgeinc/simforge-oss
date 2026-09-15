import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, beforeEach, test } from "node:test";

/**
 * The native sign-in path against a stubbed SimCloud: what the vault holds
 * after a sign-in, how a rejected bearer token is refreshed once, what an
 * unrefreshable session reports, that pre-native (v1) vault entries are
 * not sessions any more, and how account deletion treats the two 401s it can
 * receive - a lapsed token and a rejected password - differently.
 */

type Vault = {
  persistence: "os-vault";
  entries: Map<string, string>;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
};

const vault: Vault = {
  persistence: "os-vault",
  entries: new Map(),
  async get(account) { return this.entries.get(account) ?? null; },
  async set(account, secret) { this.entries.set(account, secret); },
  async delete(account) { return this.entries.delete(account); },
};

// Seed the process-wide connection state with the fake vault before the
// module loads: the vault is its only durable store, so this is the seam.
// A static import would evaluate the module (and reach for the OS keychain)
// before this seed exists, hence the deferred import in `before`.
const STATE_KEY = Symbol.for("simforge.cloud-connection");
const state = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= {}) as Record<string, unknown>;
const loadConnection = () => import("../connection");
let connection: Awaited<ReturnType<typeof loadConnection>>;

function resetState() {
  Object.assign(state, {
    loaded: null,
    vault,
    credential: null,
    pending: null,
    expiredMessage: null,
    message: null,
    refreshing: null,
    providers: null,
    providersFetch: null,
    providersRetryAt: 0,
  });
  vault.entries.clear();
  calls.length = 0;
}

type Call = { method: string; path: string; authorization: string | null; body: Record<string, unknown> | null };
const calls: Call[] = [];

function token(suffix: string) {
  return {
    access_token: `sfd_at_${suffix}`,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: `sfd_rt_${suffix}`,
    refresh_expires_in: 30 * 86_400,
    user: { id: "user_1", email: "ada@example.test", name: "Ada", email_verified: false },
  };
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  const call: Call = {
    method: request.method ?? "GET",
    path: request.url ?? "/",
    authorization: request.headers.authorization ?? null,
    body: raw ? JSON.parse(raw) : null,
  };
  calls.push(call);
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  switch (`${call.method} ${call.path}`) {
    case "GET /api/desktop/auth/providers":
      return json(200, { providers: ["google", "saml"] });
    case "POST /api/desktop/auth/sign-in":
      if (call.body?.password !== "correct horse") return json(401, { error: "invalid_credentials", error_description: "Wrong password." });
      return json(200, token("first"));
    case "POST /api/desktop/token":
      if (call.body?.refresh_token === "sfd_rt_first") return json(200, token("second"));
      return json(401, { error: "invalid_grant", error_description: "Refresh token revoked." });
    case "GET /api/desktop/account":
      if (call.authorization !== "Bearer sfd_at_second") return json(401, { error: "invalid_token", error_description: "Expired." });
      return json(200, {
        user: { id: "user_1", email: "ada@example.test", name: "Ada Lovelace", email_verified: true },
        active_organization_id: "org_1",
        sessions: [{ id: "sess_1", label: "this-mac", user_agent: null, created_at: "2026-09-13T00:00:00Z", last_used_at: null, active: true, current: true }],
      });
    case "DELETE /api/desktop/account":
      if (call.authorization !== "Bearer sfd_at_first") return json(401, { error: "invalid_token", error_description: "Expired." });
      // Re-authentication: the Cloud answers 401 for a wrong password too.
      if (call.body?.password !== "correct horse") {
        return json(401, { error: "invalid_credentials", error_description: "That password is wrong. Nothing has been deleted." });
      }
      return json(200, {
        deleted: true,
        account: { id: "user_1", email: "ada@example.test" },
        destroyed: {
          workspaces: [{ id: "ws_1", name: "Ada" }],
          desktop_sessions: 2,
          browser_sessions: 1,
          scenario_ratings: 4,
          render_annotations: 0,
        },
        organizations_left: ["org_9"],
        local_data_untouched: true,
        message: "Your account and the organization Ada were deleted. Nothing on this computer was removed.",
      });
    default:
      return json(404, { error: "not_found" });
  }
}

const server = createServer((request, response) => void handle(request, response));
let origin = "";
const previousOrigin = process.env.SIMFORGE_CLOUD_ORIGIN;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  process.env.SIMFORGE_CLOUD_ORIGIN = origin;
  resetState();
  connection = await loadConnection();
});

after(async () => {
  if (previousOrigin === undefined) delete process.env.SIMFORGE_CLOUD_ORIGIN;
  else process.env.SIMFORGE_CLOUD_ORIGIN = previousOrigin;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(resetState);

function seedCredential(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  vault.entries.set(`cloud:${origin}`, JSON.stringify({
    schema: "simforge.cloud-credential/v2",
    origin,
    connectionId: "connection-0000000000",
    accessToken: "sfd_at_first",
    accessExpiresAt: now + 3_600_000,
    refreshToken: "sfd_rt_first",
    sessionExpiresAt: now + 30 * 86_400_000,
    user: { id: "user_1", email: "ada@example.test", name: "Ada", emailVerified: false },
    activeOrganizationId: null,
    ...overrides,
  }));
}

test("sign-in stores a v2 credential in the vault and status becomes connected", async () => {
  const { signInCloud, getCloudStatus } = connection;
  const status = await signInCloud({ email: "ada@example.test", password: "correct horse" });
  assert.equal(status.state, "connected");
  assert.deepEqual(status.user, { id: "user_1", email: "ada@example.test", name: "Ada", emailVerified: false });
  // Only the configured providers the client knows are offered.
  assert.deepEqual(status.providers, ["google"]);
  assert.equal(status.credentialPersistence, "os-vault");

  const signIn = calls.find((call) => call.path === "/api/desktop/auth/sign-in");
  assert.ok(signIn);
  assert.equal(typeof signIn.body?.device_label, "string");
  assert.ok((signIn.body?.device_label as string).length > 0 && (signIn.body?.device_label as string).length <= 80);

  const stored = JSON.parse(vault.entries.get(`cloud:${origin}`) ?? "null");
  assert.equal(stored.schema, "simforge.cloud-credential/v2");
  assert.equal(stored.accessToken, "sfd_at_first");
  assert.equal(stored.refreshToken, "sfd_rt_first");
  assert.equal(stored.user.emailVerified, false);
  assert.equal((await getCloudStatus()).state, "connected");
});

test("a wrong password is reported with the Cloud's code and status, and nothing is stored", async () => {
  const { signInCloud, CloudConnectionError, getCloudStatus } = connection;
  await assert.rejects(
    signInCloud({ email: "ada@example.test", password: "nope" }),
    (error: unknown) => error instanceof CloudConnectionError && error.code === "invalid_credentials" && error.status === 401,
  );
  assert.equal(vault.entries.size, 0);
  assert.equal((await getCloudStatus()).state, "disconnected");
});

test("a rejected bearer token is refreshed once and the call retried", async () => {
  seedCredential();
  const { getCloudAccount, getCloudStatus } = connection;
  const account = await getCloudAccount();
  assert.equal(account.user.name, "Ada Lovelace");
  assert.equal(account.activeOrganizationId, "org_1");
  assert.deepEqual(account.sessions.map((session) => [session.id, session.current]), [["sess_1", true]]);

  const sequence = calls.map((call) => `${call.method} ${call.path} ${call.authorization ?? "-"}`);
  assert.deepEqual(sequence.filter((line) => !line.startsWith("GET /api/desktop/auth/providers")), [
    "GET /api/desktop/account Bearer sfd_at_first",
    "POST /api/desktop/token -",
    "GET /api/desktop/account Bearer sfd_at_second",
  ]);
  // The rotated token and the Cloud's view of the profile are what the vault keeps now.
  const stored = JSON.parse(vault.entries.get(`cloud:${origin}`) ?? "null");
  assert.equal(stored.accessToken, "sfd_at_second");
  assert.equal(stored.user.emailVerified, true);
  assert.equal(stored.activeOrganizationId, "org_1");
  const status = await getCloudStatus();
  assert.equal(status.state, "connected");
  assert.equal(status.activeOrganizationId, "org_1");
  assert.equal(status.user?.emailVerified, true);
});

test("a refresh the Cloud refuses marks the session expired", async () => {
  seedCredential({ accessExpiresAt: Date.now() - 1, refreshToken: "sfd_rt_revoked" });
  const { getCloudAccount, CloudConnectionError, getCloudStatus } = connection;
  await assert.rejects(
    getCloudAccount(),
    (error: unknown) => error instanceof CloudConnectionError && error.code === "cloud_session_expired",
  );
  const status = await getCloudStatus();
  assert.equal(status.state, "expired");
  assert.equal(status.user?.email, "ada@example.test");
  // The bearer route itself was never reached with a dead token.
  assert.equal(calls.filter((call) => call.path === "/api/desktop/account").length, 0);
});

test("a rejected deletion password is reported as such and leaves the session signed in", async () => {
  seedCredential();
  const { deleteCloudAccount, CloudConnectionError, getCloudStatus } = connection;
  await assert.rejects(
    deleteCloudAccount({ password: "nope" }),
    (error: unknown) => error instanceof CloudConnectionError && error.code === "invalid_credentials" && error.status === 401,
  );
  // The 401 must not be mistaken for a lapsed token: no refresh, and above all
  // no second attempt, which would spend the password against the Cloud's
  // per-account throttle and finally report the session expired.
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`).filter((line) => !line.endsWith("/api/desktop/auth/providers")),
    ["DELETE /api/desktop/account"],
  );
  const status = await getCloudStatus();
  assert.equal(status.state, "connected");
  assert.equal(status.user?.email, "ada@example.test");
  assert.equal(vault.entries.has(`cloud:${origin}`), true);
});

test("a completed deletion reports what was destroyed and clears the local credential", async () => {
  seedCredential();
  const { deleteCloudAccount, getCloudStatus, cloudSessionScope } = connection;
  const deletion = await deleteCloudAccount({ password: "correct horse" });
  assert.equal(deletion.email, "ada@example.test");
  assert.deepEqual(deletion.organizationsClosed, [{ id: "ws_1", name: "Ada" }]);
  assert.deepEqual(deletion.organizationsLeft, ["org_9"]);
  assert.equal(deletion.sessionsRevoked, 3);
  assert.match(deletion.message, /Nothing on this computer was removed/);

  // The account is gone upstream, so the app must present itself as signed
  // out, not as a session that expired: nothing is left to sign back into.
  const status = await getCloudStatus();
  assert.equal(status.state, "disconnected");
  assert.equal(status.user, null);
  assert.equal(status.message, null);
  assert.equal(vault.entries.has(`cloud:${origin}`), false);
  assert.equal(cloudSessionScope().active, false);
});

test("a v1 vault entry from the retired consent flow is dropped, not treated as a session", async () => {
  vault.entries.set(`cloud:${origin}`, JSON.stringify({
    schema: "simforge.cloud-credential/v1",
    origin,
    connectionId: "connection-0000000000",
    accessToken: "sfd_at_old",
    accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: "sfd_rt_old",
    sessionExpiresAt: Date.now() + 86_400_000,
    user: { id: "user_1", email: "ada@example.test", name: "Ada" },
  }));
  const { getCloudStatus, cloudSessionScope } = connection;
  const status = await getCloudStatus();
  assert.equal(status.state, "disconnected");
  assert.equal(status.user, null);
  assert.equal(vault.entries.has(`cloud:${origin}`), false);
  assert.equal(cloudSessionScope().active, false);
});
