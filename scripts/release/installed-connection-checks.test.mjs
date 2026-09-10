import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInstalledConnectionChecks } from "./installed-connection-checks.mjs";

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function check(checks, name) {
  const found = checks.filter((entry) => entry.name === name);
  assert.equal(found.length, 1, `exactly one outcome for ${name}`);
  return found[0];
}

async function fixture(t, { state = "disconnected", workspaceStatus = 200, cloudRedirect = null, capabilityReply } = {}) {
  const token = randomBytes(32).toString("hex");
  const cookie = `private-session-${randomBytes(16).toString("hex")}`;
  const dataRoot = await mkdtemp(join(tmpdir(), "installed-connections-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const cloudRequests = [];
  const cloud = await serve(t, (request, response) => {
    cloudRequests.push({ path: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (cloudRedirect) {
      response.writeHead(302, { location: `${cloudRedirect}/?secret=${token}` });
      response.end();
    } else if (request.url === "/download/releases.json") {
      json(response, 200, { channels: { stable: "studio-1.0.0", preview: null }, releases: { "studio-1.0.0": { tag: "studio-1.0.0" } } });
    } else response.end("Cloud landing page");
  });
  const requests = [];
  const capability = {
    schema: "simforge.studio-host-capabilities/v1",
    host: { kind: "local", label: "Installed Studio", version: "1.0.0" },
    identity: { mode: "fixed-local", userId: "private-user", workspaceId: "private-workspace" },
    persistence: { kind: "pglite-filesystem", dataRoot },
    execution: {
      browserSimulation: true, renderWorkers: {},
      nativeRuntime: { state: "unavailable", code: "not_installed", reason: token, searchedPaths: [] },
    },
    jobs: { families: ["simulation"], survivesUiClose: true },
  };
  const host = await serve(t, (request, response) => {
    requests.push({ path: request.url, authenticated: request.headers.authorization === `Bearer ${token}`, method: request.method });
    if (capabilityReply && request.url === "/api/simforge/host/capabilities") {
      capabilityReply(request, response, { token, capability });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(response, 401, { error: "local_access_denied", message: token });
      return;
    }
    if (request.url === "/api/simforge/host/capabilities") json(response, 200, capability);
    else if (request.url === "/api/simforge/cloud/status") json(response, 200, {
      state, origin: cloud.origin, credentialPersistence: "session", message: token,
      user: state === "connected" ? { id: "private-cloud-user", email: "private@example.test", name: null } : null,
      sessionExpiresAt: state === "connected" ? new Date(Date.now() + 60_000).toISOString() : null,
    });
    else if (request.url === "/api/simforge/cloud/workspaces") json(response, workspaceStatus,
      workspaceStatus === 200 ? { workspaces: [{ id: "private-workspace", name: token, role: "owner" }] } : { error: token });
    else json(response, 404, { error: token });
  });
  await writeFile(join(dataRoot, "host.json"), JSON.stringify({
    schema: "simforge.local-host-state/v1", pid: process.pid, port: Number(new URL(host.origin).port),
    baseUrl: host.origin, controlToken: token, startedAt: new Date().toISOString(), withWorker: false,
  }), { mode: 0o600 });
  return { token, cookie, dataRoot, cloudRequests, requests, host, cloud };
}

function noSecrets(checks, fixture) {
  const output = JSON.stringify(checks);
  for (const secret of [fixture.token, fixture.cookie, "private@example.test", "private-cloud-user", "private-workspace"]) {
    assert.equal(output.includes(secret), false, "qualification output must not disclose credentials or response identities");
  }
}

test("private host record authenticates actual HTTP while disconnected Cloud reads remain blocked", async (t) => {
  const f = await fixture(t);
  const checks = await runInstalledConnectionChecks({ dataRoot: f.dataRoot, headers: { cookie: f.cookie }, expectedVersion: "1.0.0" });
  for (const name of ["host.record", "host.record.pid", "host.tcp", "host.unauthenticated", "host.capabilities", "host.ownership", "cloud.status", "cloud.origin", "cloud.download-manifest"]) {
    assert.equal(check(checks, name).status, "passed", name);
  }
  assert.equal(check(checks, "cloud.authenticated-workspaces").status, "blocked");
  assert.equal(f.requests.some((request) => request.path.endsWith("/workspaces")), false);
  assert.deepEqual(f.requests.filter((request) => request.path.endsWith("/capabilities")).map((request) => request.authenticated), [false, true]);
  assert.deepEqual(f.cloudRequests.map((request) => request.path), ["/", "/download/releases.json"]);
  assert.ok(f.cloudRequests.every((request) => request.authorization === undefined && request.cookie === undefined));
  assert.ok(f.requests.every((request) => request.method === "GET"));
  assert.equal(check(checks, "host.capabilities").details.nativeRuntime, "unavailable");
  noSecrets(checks, f);
});

test("connected status is not proof of authentication when the actual workspace read is rejected", async (t) => {
  const f = await fixture(t, { state: "connected", workspaceStatus: 401 });
  const checks = await runInstalledConnectionChecks({ dataRoot: f.dataRoot });
  assert.equal(check(checks, "cloud.status").status, "passed");
  assert.equal(check(checks, "cloud.authenticated-workspaces").status, "failed");
  assert.equal(check(checks, "cloud.authenticated-workspaces").details.httpStatus, 401);
  assert.equal(f.requests.filter((request) => request.path.endsWith("/workspaces") && request.authenticated).length, 1);
  noSecrets(checks, f);
});

test("connected workspace reads verify the returned workspace contract without disclosing identities", async (t) => {
  const f = await fixture(t, { state: "connected" });
  const checks = await runInstalledConnectionChecks({ dataRoot: f.dataRoot });
  assert.equal(check(checks, "cloud.authenticated-workspaces").status, "passed");
  assert.equal(check(checks, "cloud.authenticated-workspaces").details.workspaceCount, 1);
  noSecrets(checks, f);
});

test("a mismatched explicit endpoint never receives the private host credential", async (t) => {
  const f = await fixture(t);
  let foreignRequests = 0;
  const foreign = await serve(t, (_request, response) => { foreignRequests++; response.end(); });
  const checks = await runInstalledConnectionChecks({ dataRoot: f.dataRoot, baseUrl: foreign.origin });
  assert.equal(check(checks, "host.target").status, "failed");
  assert.equal(check(checks, "host.capabilities").status, "blocked");
  assert.equal(foreignRequests, 0);
  assert.equal(f.requests.length, 0);
  noSecrets(checks, f);
});

test("unprotected capabilities and malformed authenticated replies fail without echoing secret-bearing bodies", async (t) => {
  const f = await fixture(t, { capabilityReply(request, response, { token, capability }) {
    if (!request.headers.authorization) json(response, 200, capability);
    else { response.writeHead(200); response.end(`invalid JSON with credential ${token}`); }
  } });
  const checks = await runInstalledConnectionChecks({ dataRoot: f.dataRoot });
  assert.equal(check(checks, "host.unauthenticated").status, "failed");
  assert.equal(check(checks, "host.capabilities").status, "failed");
  assert.equal(check(checks, "host.capabilities").error, "INVALID_JSON");
  assert.equal(check(checks, "host.ownership").status, "blocked");
  noSecrets(checks, f);
});

test("public Cloud redirects do not forward local credentials or disclose redirect query secrets", async (t) => {
  let redirectedRequests = 0;
  const destination = await serve(t, (_request, response) => { redirectedRequests++; response.end(); });
  const f = await fixture(t, { cloudRedirect: destination.origin });
  const checks = await runInstalledConnectionChecks({ dataRoot: f.dataRoot, headers: { cookie: f.cookie } });
  assert.equal(check(checks, "cloud.download-manifest").status, "failed");
  assert.equal(check(checks, "cloud.download-manifest").details.httpStatus, 302);
  assert.equal(redirectedRequests, 0);
  assert.ok(f.cloudRequests.every((request) => request.authorization === undefined && request.cookie === undefined));
  noSecrets(checks, f);
});

test("cancelling a streaming response blocks pending qualification instead of passing it", { timeout: 10_000 }, async (t) => {
  const controller = new AbortController();
  let responseStarted;
  const started = new Promise((resolve) => { responseStarted = resolve; });
  const host = await serve(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"schema":');
    responseStarted();
  });
  const pending = runInstalledConnectionChecks({ baseUrl: host.origin, headers: { authorization: "Bearer private-token" }, signal: controller.signal, timeoutMs: 1000 });
  await started;
  controller.abort();
  const checks = await pending;
  assert.equal(check(checks, "host.unauthenticated").status, "blocked");
  assert.equal(check(checks, "host.capabilities").status, "blocked");
  assert.equal(check(checks, "cloud.authenticated-workspaces").status, "blocked");
  assert.equal(JSON.stringify(checks).includes("private-token"), false);
});

test("the request deadline covers a response body that never finishes", { timeout: 10_000 }, async (t) => {
  let capabilityRequests = 0;
  const host = await serve(t, (request, response) => {
    if (!request.headers.authorization || request.url !== "/api/simforge/host/capabilities") {
      json(response, 401, { error: "local_access_denied" });
      return;
    }
    capabilityRequests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"schema":');
  });
  const checks = await runInstalledConnectionChecks({
    baseUrl: host.origin, headers: { authorization: "Bearer private-deadline-token" }, timeoutMs: 1000,
  });
  assert.equal(capabilityRequests, 1);
  assert.equal(check(checks, "host.unauthenticated").status, "passed");
  assert.equal(check(checks, "host.capabilities").status, "failed");
  assert.match(check(checks, "host.capabilities").error, /ETIMEDOUT|ABORTED/);
  assert.equal(JSON.stringify(checks).includes("private-deadline-token"), false);
});
