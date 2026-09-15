/**
 * Defect class 6 — an auth path that answered 200 to `curl` and 500 to every
 * real client — plus the account and tenant flows around it, against a real
 * SimCloud environment.
 *
 * The bug: `POST /api/desktop/auth/sign-in` returned 500 for every real
 * client because Node's `fetch` sends `sec-fetch-mode: cors` with no
 * `Origin`, and Better Auth's Fetch-Metadata origin check escalated on
 * exactly that combination (compounded by `asResponse` being inferred from
 * `isRequestLike(request)`, leaving `.user` undefined). A curl-shaped probe
 * passed throughout. That is the whole lesson of this file: the request shape
 * is part of the contract, so the coverage has to send the shape the product
 * sends, and has to be able to tell the two apart.
 *
 * Accounts are created through the product's own sign-up endpoint and are
 * throwaway per run, never hand-inserted and never the shared QA identity —
 * `~/.simforge/test-account.env` is read-only to this suite.
 *
 * Exactly one sign-up per run, not one per test: staging throttles sign-up at
 * six attempts a minute per IP (measured; the next returns 429
 * `{"error":"throttled"}`), so an account per test makes the suite fail on
 * its own request rate rather than on the product. Every test reads through
 * the one account and none mutates it, so they run in any order and in
 * isolation. The sign-out test opens a *second session* on that account
 * instead of creating a second account — which is also the better assertion,
 * because it proves revocation is scoped to one session rather than merely
 * that a token stops working.
 */

import {
  cloudFetch,
  cloudOrigin,
  createThrowawayAccount,
  foreignWorkspaceId,
  REQUEST_SHAPES,
  signInToCloud,
  WORKSPACE_HEADER,
  type CloudAccount,
} from "../support/cloud";
import { expect, test } from "../support/fixtures";

type AccountBody = { user?: { id?: string; email?: string } };
type ArtifactsBody = { artifacts?: unknown[]; error?: string };

/** One account per file for the read-only tests; see the note above. */
let shared: CloudAccount | undefined;

test.beforeAll(async () => {
  shared = await createThrowawayAccount();
});

test.afterAll(async () => {
  // Guarded: when sign-up itself fails there is nothing to revoke, and an
  // unguarded teardown would replace that diagnosis with a TypeError.
  await shared?.revoke();
});

test.describe("SimCloud authentication through the real client path", () => {
  test("sign-in succeeds for the shape Node's fetch actually sends", async () => {
    const account = shared!;
    {
      // The shape that returned 500: Fetch-Metadata headers present, no
      // `Origin`. This is what the desktop client and the CLI send.
      const real = await signInToCloud(account.email, account.password, REQUEST_SHAPES.nodeClient);
      expect(real.status, `sign-in from a Node client against ${cloudOrigin()}`).toBe(200);
      expect(typeof real.body.access_token, "the token a real client receives").toBe("string");

      // The curl-shaped request is the *control*, not the coverage. Both must
      // pass now; the point of asserting them together is that when the
      // platform regresses, this test shows the signature of the original bug
      // — curl green, real client red — instead of a bare 500 with no
      // indication that the request shape is what mattered.
      const curlShaped = await signInToCloud(account.email, account.password, REQUEST_SHAPES.curl);
      expect(curlShaped.status, "sign-in from a curl-shaped request").toBe(200);

      // A browser cross-origin request carries an `Origin`, which is the
      // third distinct path through the same origin check.
      const browserShaped = await signInToCloud(account.email, account.password, REQUEST_SHAPES.browser);
      expect(browserShaped.status, "sign-in from a browser-shaped request").toBe(200);
    }
  });

  test("a wrong password is refused rather than erroring", async () => {
    {
      const refused = await signInToCloud(shared!.email, `${shared!.password}-wrong`, REQUEST_SHAPES.nodeClient);
      // The distinction that matters: a refusal, not a 500. The original
      // defect turned every sign-in into a server error, so "not 200" alone
      // would have passed while the product was broken.
      expect(refused.status, "sign-in with a wrong password").toBeGreaterThanOrEqual(400);
      expect(refused.status, "sign-in with a wrong password must not be a server error").toBeLessThan(500);
    }
  });

  test("a new account is usable, and signing out ends that session only", async () => {
    const account = shared!;
    // Sign-up is the real account-creation path, so a new identity must come
    // back readable and already owning a workspace — the platform creating an
    // account with no tenant is a state no client can recover from.
    const profile = await cloudFetch<AccountBody>("/api/desktop/account", { bearer: account.accessToken });
    expect(profile.status, "reading a fresh account").toBe(200);
    expect(profile.body.user?.email, "the address the account was created with").toBe(account.email);
    expect(account.workspaceId, "a fresh account's workspace id").toMatch(/^ws_/);

    // A second device signing in to the same account.
    const second = await signInToCloud(account.email, account.password, REQUEST_SHAPES.nodeClient);
    expect(second.status, "a second sign-in on the same account").toBe(200);
    const secondToken = second.body.access_token!;
    expect(secondToken, "the second session's token").not.toBe(account.accessToken);

    const revoked = await cloudFetch("/api/desktop/revoke", { method: "POST", bearer: secondToken, body: "{}" });
    expect(revoked.status, "revoking the second session").toBeLessThan(300);

    // Sign-out must end the session server-side: a client-side-only sign-out
    // leaves a live bearer token on disk, which is the whole risk on a
    // shared machine.
    const deadSession = await cloudFetch("/api/desktop/account", { bearer: secondToken });
    expect(deadSession.status, "the revoked session").toBe(401);

    // And it must end only that one. Signing out on one device logging the
    // user out everywhere is a different bug, invisible unless a test holds
    // two sessions at once.
    const stillLive = await cloudFetch("/api/desktop/account", { bearer: account.accessToken });
    expect(stillLive.status, "the other session, which was not revoked").toBe(200);
  });

  test("a password reset can be requested for a real address", async () => {
    {
      const requested = await cloudFetch("/api/desktop/auth/password/forgot", {
        method: "POST",
        body: JSON.stringify({ email: shared!.email }),
      });
      // Deliberately not asserting an email arrives — no mailbox here. What
      // is assertable, and what broke in class 6, is that the endpoint
      // completes through the real client shape instead of 500ing.
      expect(requested.status, "requesting a password reset").toBeLessThan(400);
    }
  });
});

test.describe("tenant-scoped calls are scoped to the caller's tenant", () => {
  // All four read through the same account and none mutates it, so they run
  // in any order and in isolation.
  test("the caller's own workspace id is accepted", async () => {
    const account = shared!;
    const own = await cloudFetch<ArtifactsBody>("/api/desktop/storage/artifacts", {
      bearer: account.accessToken,
      headers: { [WORKSPACE_HEADER]: account.workspaceId },
    });
    expect(own.status, `artifacts scoped to ${account.workspaceId}`).toBe(200);
    expect(Array.isArray(own.body.artifacts), "a scoped listing returns an artifact array").toBe(true);
  });

  test("a foreign workspace id is refused with 403, not served or 500", async () => {
    const account = shared!;
    const foreign = foreignWorkspaceId();
    const refused = await cloudFetch<ArtifactsBody>("/api/desktop/storage/artifacts", {
      bearer: account.accessToken,
      headers: { [WORKSPACE_HEADER]: foreign },
    });
    // The bug this guards against is cross-tenant reads: a seam that ignores
    // an unknown scope header and serves the caller's own data looks
    // identical to a working one until someone passes another tenant's id.
    // 403 with a named reason is the contract; 200 would be a data leak and
    // 500 would mean the seam cannot tell tenants apart at all.
    expect(refused.status, `artifacts scoped to the foreign workspace ${foreign}`).toBe(403);
    expect(refused.body.error, "the refusal names why").toBe("workspace_forbidden");
  });

  test("an organization id is not a workspace id", async () => {
    // Worth pinning because it is a real trap at this seam: the header takes
    // a *workspace* id (`ws_…`), and passing the organization id
    // (`org_ws_…`) that the same payload hands back is refused exactly like a
    // stranger's. A client that conflates them fails only for real tenants.
    const account = shared!;
    const asOrg = await cloudFetch<ArtifactsBody>("/api/desktop/storage/artifacts", {
      bearer: account.accessToken,
      headers: { [WORKSPACE_HEADER]: account.organizationId },
    });
    expect(account.organizationId, "the organization id is distinct from the workspace id")
      .not.toBe(account.workspaceId);
    expect(asOrg.status, `artifacts scoped by organization id ${account.organizationId}`).toBe(403);
  });

  test("no credential at all is refused", async () => {
    const anonymous = await cloudFetch("/api/desktop/storage/artifacts");
    // Keeps the three assertions above honest: if the endpoint were open,
    // they would all pass for the wrong reason.
    expect(anonymous.status, "artifacts with no bearer token").toBe(401);
  });
});
