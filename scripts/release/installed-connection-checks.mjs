// Read-only installed-host probes. Node built-ins only: never load checkout runtime code.
// The caller owns CLI flags/output. Supply dataRoot explicitly to use its private host.json.
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";

const CAPABILITIES = "/api/simforge/host/capabilities";
const CLOUD_STATUS = "/api/simforge/cloud/status";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const nullableText = (value) => value === null || typeof value === "string";

function problem(code) {
  return Object.assign(new Error(code), { code });
}

// Never serialize exception messages, response bodies, headers, identities or host records.
// Node network causes retain errno even when fetch itself says only "fetch failed".
function safeError(error) {
  const known = new Set([
    "EADDRNOTAVAIL", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH",
    "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EACCES", "EPERM", "ESRCH", "ENOENT",
    "ELOOP", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID",
    "BODY_TOO_LARGE", "INVALID_JSON", "INVALID_URL", "RECORD_TOO_LARGE", "RECORD_NOT_PRIVATE",
    "RECORD_WRONG_OWNER", "RECORD_NOT_FILE", "RECORD_INVALID", "CONTRACT_INVALID",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  ]);
  const pending = [error];
  const codes = new Set();
  for (let count = 0; pending.length && count < 20; count++) {
    const current = pending.shift();
    if (!current || typeof current !== "object") continue;
    if (known.has(current.code)) codes.add(current.code);
    if (current.name === "AbortError") codes.add("ABORTED");
    if (current.name === "TimeoutError") codes.add("ETIMEDOUT");
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 10));
  }
  if (codes.has("EADDRNOTAVAIL")) return "EADDRNOTAVAIL: the OS could not assign a local socket address; this does not establish that the listening host is dead.";
  if (codes.has("ECONNREFUSED")) return "ECONNREFUSED: the destination refused TCP; no accepting listener was reached at this address.";
  return codes.size ? [...codes].join(", ") : "Request or local record operation failed (untrusted error text omitted).";
}

function origin(value, local = false) {
  let url;
  try { url = new URL(value); } catch { throw problem("INVALID_URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") throw problem("INVALID_URL");
  if (local && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw problem("INVALID_URL");
  return url;
}

function deadline(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function request(url, { headers, signal, timeoutMs, json = true }) {
  const response = await fetch(url, {
    headers, signal: deadline(signal, timeoutMs), redirect: "manual", cache: "no-store",
  });
  try {
    if (!json || response.status !== 200) return { status: response.status };
    const reader = response.body?.getReader();
    if (!reader) throw problem("INVALID_JSON");
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw problem("BODY_TOO_LARGE");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
    catch { throw problem("INVALID_JSON"); }
    return { status: response.status, body };
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

async function tcp(url, signal, timeoutMs, localAddress) {
  const bounded = deadline(signal, timeoutMs);
  bounded.throwIfAborted();
  await new Promise((resolve, reject) => {
    const socket = createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      ...(localAddress ? { localAddress, localPort: 0 } : {}),
    });
    const finish = (error) => {
      bounded.removeEventListener("abort", abort);
      socket.removeListener("connect", connected);
      socket.destroy();
      // Retain the error listener until close in case destruction races a connect error.
      if (error) reject(error); else resolve();
    };
    const connected = () => finish();
    const abort = () => finish(bounded.reason);
    socket.once("error", finish);
    socket.once("connect", connected);
    bounded.addEventListener("abort", abort, { once: true });
    if (bounded.aborted) abort();
  });
}

export async function readInstalledHostRecord(dataRoot) {
  const file = await open(join(dataRoot, "host.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw problem("RECORD_NOT_FILE");
    if (stat.size > 64 * 1024) throw problem("RECORD_TOO_LARGE");
    if (process.platform !== "win32" && (stat.mode & 0o077)) throw problem("RECORD_NOT_PRIVATE");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw problem("RECORD_WRONG_OWNER");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) throw problem("RECORD_TOO_LARGE");
    let record;
    try { record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch { throw problem("RECORD_INVALID"); }
    if (!object(record) || record.schema !== "simforge.local-host-state/v1" ||
        !Number.isSafeInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.port) ||
        record.port < 1 || record.port > 65535 || !text(record.controlToken) ||
        typeof record.withWorker !== "boolean" || !text(record.startedAt) ||
        !Number.isFinite(Date.parse(record.startedAt))) throw problem("RECORD_INVALID");
    const url = origin(record.baseUrl, true);
    if (Number(url.port || (url.protocol === "https:" ? 443 : 80)) !== record.port) throw problem("RECORD_INVALID");
    return record;
  } finally { await file.close(); }
}

function capabilitiesValid(body) {
  const runtime = body?.execution?.nativeRuntime;
  return object(body) && body.schema === "simforge.studio-host-capabilities/v1" &&
    body.host?.kind === "local" && text(body.host.label) && nullableText(body.host.version) &&
    body.identity?.mode === "fixed-local" && text(body.identity.userId) && text(body.identity.workspaceId) &&
    body.persistence?.kind === "pglite-filesystem" && text(body.persistence.dataRoot) &&
    body.execution?.browserSimulation === true && object(body.execution.renderWorkers) &&
    Object.values(body.execution.renderWorkers).every((worker) => object(worker) && typeof worker.available === "boolean" && nullableText(worker.reason)) &&
    ((runtime?.state === "available" && text(runtime.binaryPath) && runtime.runtime?.schema === "simforge.native-runtime/v1") ||
     (runtime?.state === "unavailable" && text(runtime.code) && text(runtime.reason) && Array.isArray(runtime.searchedPaths))) &&
    Array.isArray(body.jobs?.families) && body.jobs.families.every(text) && typeof body.jobs.survivesUiClose === "boolean";
}

/**
 * Execute real, read-only probes of an installed local host. No login, logout, uploads,
 * downloads of installers, compute submissions, process launches or termination.
 * Each check is passed, failed or blocked; a valid disconnected status is not a working
 * Cloud session. Connected sessions are verified by the read-only workspace endpoint
 * (the host may transparently refresh its credential while serving that GET).
 *
 * @param {{baseUrl?: string, headers?: HeadersInit, signal?: AbortSignal,
 *   dataRoot?: string, timeoutMs?: number, expectedVersion?: string,
 *   tcpTargets?: string[]}} options
 * @returns {Promise<Array<{name: string, status: 'passed'|'failed'|'blocked', details?: object, error?: string}>>}
 */
export async function runInstalledConnectionChecks(options = {}) {
  const { signal, dataRoot, expectedVersion, tcpTargets = [] } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const checks = [];
  const add = (name, status, details, error) => checks.push({ name, status, ...(details ? { details } : {}), ...(error ? { error } : {}) });
  const blocked = (name, reason) => add(name, "blocked", { reason });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    add("connection.options", "failed", undefined, "timeoutMs must be an integer from 1 to 120000.");
    return checks;
  }
  const attempt = async (name, action) => {
    if (signal?.aborted) { blocked(name, "Caller cancelled the qualification."); return; }
    try { return await action(); }
    catch (error) {
      if (signal?.aborted) blocked(name, "Caller cancelled the qualification.");
      else add(name, "failed", undefined, safeError(error));
    }
  };
  const probeTcp = async (name, target) => {
    await attempt(name, async () => {
      try {
        await tcp(target, signal, timeoutMs);
        add(name, "passed", { origin: target.origin });
      } catch (error) {
        const addressUnavailable = error?.code === "EADDRNOTAVAIL" ||
          error?.errors?.some((cause) => cause?.code === "EADDRNOTAVAIL");
        if (!addressUnavailable || signal?.aborted) throw error;
        // Diagnostic comparison only. Never replace normal connectivity with a
        // bound socket or change the HTTP transport used by subsequent checks.
        add(name, "failed", { origin: target.origin }, safeError(error));
        const localAddress = target.hostname === "[::1]" ? "::1" : "127.0.0.1";
        await attempt(`${name}.explicit-local-address`, async () => {
          await tcp(target, signal, timeoutMs, localAddress);
          add(`${name}.explicit-local-address`, "passed", {
            origin: target.origin, localAddress, localPort: 0, diagnosticOnly: true,
            meaning: "Explicit source binding reached the listener while ordinary TCP failed EADDRNOTAVAIL. Normal connectivity remains failed; no recovery or OS change was attempted.",
          });
        });
      }
    });
  };
  let record;
  if (dataRoot) {
    record = await attempt("host.record", async () => {
      const value = await readInstalledHostRecord(dataRoot);
      add("host.record", "passed", { schema: value.schema, privateFile: true, ownerMatchesCurrentUser: typeof process.getuid === "function" ? true : null });
      return value;
    });
  } else blocked("host.record", "No local dataRoot supplied; host record and filesystem ownership cannot be checked.");
  if (record) await attempt("host.record.pid", async () => {
    process.kill(record.pid, 0);
    add("host.record.pid", "passed", { pid: record.pid, meaning: "Recorded supervisor PID exists and is signal-visible; this alone does not prove process identity or socket ownership." });
  });
  else blocked("host.record.pid", "A valid local host record is required.");

  let base;
  await attempt("host.target", async () => {
    base = origin(options.baseUrl ?? record?.baseUrl, true);
    if (record && origin(record.baseUrl, true).origin !== base.origin) {
      base = undefined;
      add("host.target", "failed", undefined, "Explicit baseUrl does not match host.json; refusing to send its credential to another endpoint.");
    } else add("host.target", "passed", { origin: base.origin });
  });
  for (let i = 0; i < tcpTargets.length; i++) {
    await attempt(`host.tcp.extra.${i + 1}`, async () => {
      const target = origin(tcpTargets[i], true);
      await probeTcp(`host.tcp.extra.${i + 1}`, target);
    });
  }
  let headers;
  await attempt("host.credentials", async () => {
    headers = new Headers(options.headers);
    if (record && !headers.has("authorization")) headers.set("authorization", `Bearer ${record.controlToken}`);
    if (!headers.has("authorization") && !headers.has("cookie")) {
      headers = undefined;
      blocked("host.credentials", "No local bearer/session credentials supplied and no valid private host record available.");
    } else add("host.credentials", "passed", { meaning: "Local credentials available; acceptance is tested separately." });
  });
  const localRequest = (path, authenticated = true) => request(new URL(path, base), { headers: authenticated ? headers : undefined, signal, timeoutMs });
  if (base) {
    await probeTcp("host.tcp", base);
    await attempt("host.unauthenticated", async () => {
      const result = await localRequest(CAPABILITIES, false);
      add("host.unauthenticated", result.status === 401 ? "passed" : "failed", { httpStatus: result.status, expectedStatus: 401 });
    });
  } else {
    blocked("host.tcp", "No valid matching local host target.");
    blocked("host.unauthenticated", "No valid matching local host target.");
  }
  let capabilities;
  if (base && headers) capabilities = await attempt("host.capabilities", async () => {
    const result = await localRequest(CAPABILITIES);
    if (result.status !== 200) { add("host.capabilities", "failed", { httpStatus: result.status }); return; }
    if (!capabilitiesValid(result.body)) throw problem("CONTRACT_INVALID");
    if (expectedVersion !== undefined && result.body.host.version !== expectedVersion) {
      add("host.capabilities", "failed", undefined, "Installed host version does not match expectedVersion.");
      return;
    }
    add("host.capabilities", "passed", {
      schema: result.body.schema, nativeRuntime: result.body.execution.nativeRuntime.state,
      survivesUiClose: result.body.jobs.survivesUiClose,
      meaning: "Authenticated local-host contract answered; capability availability is reported, not inferred healthy.",
    });
    return result.body;
  });
  else blocked("host.capabilities", "Valid host target and local credentials required.");
  if (capabilities) {
    const available = capabilities.execution.nativeRuntime.state === "available";
    add("host.native-runtime", available ? "passed" : "failed", {
      available, meaning: "Native runner manifest probe only; simulation and rendering require separate execution checks.",
    }, available ? undefined : "Installed native runner failed its runtime manifest probe; inspect local capabilities for the cause.");
  } else blocked("host.native-runtime", "Authenticated capabilities are required to inspect native runtime readiness.");
  if (dataRoot && record && capabilities) await attempt("host.ownership", async () => {
    const matches = await realpath(dataRoot) === await realpath(capabilities.persistence.dataRoot);
    add("host.ownership", matches ? "passed" : "failed", { dataRootMatches: matches, meaning: "Host authenticated with the supplied credential advertises this record's data root; PID executable identity is not inspected." });
  });
  else blocked("host.ownership", "Private host record and authenticated capabilities required to match the local data root.");

  let cloud;
  if (base && headers) cloud = await attempt("cloud.status", async () => {
    const result = await localRequest(CLOUD_STATUS);
    if (result.status !== 200) { add("cloud.status", "failed", { httpStatus: result.status }); return; }
    const body = result.body;
    if (!object(body) || !["disconnected", "connecting", "connected", "expired", "error"].includes(body.state) ||
        !["os-vault", "session"].includes(body.credentialPersistence) || !nullableText(body.message) ||
        !nullableText(body.sessionExpiresAt) || (body.sessionExpiresAt !== null && !Number.isFinite(Date.parse(body.sessionExpiresAt))) ||
        !(body.user === null || (object(body.user) && text(body.user.id) && nullableText(body.user.email) && nullableText(body.user.name))) ||
        (body.state === "connected" && (!body.user || !body.sessionExpiresAt))) throw problem("CONTRACT_INVALID");
    const advertised = origin(body.origin);
    add("cloud.status", ["expired", "error"].includes(body.state) ? "failed" : "passed", {
      state: body.state, origin: advertised.origin, credentialPersistence: body.credentialPersistence,
      meaning: "Connection-state contract only; a disconnected or connecting state does not establish Cloud authentication.",
    });
    return body;
  });
  else blocked("cloud.status", "Valid host target and local credentials required.");

  if (cloud) {
    const advertised = origin(cloud.origin);
    await attempt("cloud.origin", async () => {
      // Never forward the local bearer/cookie to Cloud, including redirects.
      const result = await request(advertised, { signal, timeoutMs, json: false });
      add("cloud.origin", result.status >= 200 && result.status < 400 ? "passed" : "failed", { origin: advertised.origin, httpStatus: result.status, redirectsFollowed: false });
    });
    await attempt("cloud.download-manifest", async () => {
      const result = await request(new URL("/download/releases.json", advertised), { signal, timeoutMs });
      if ([404, 410].includes(result.status)) { blocked("cloud.download-manifest", `Advertised Cloud has no published download manifest (HTTP ${result.status}).`); return; }
      if (result.status !== 200) { add("cloud.download-manifest", "failed", { httpStatus: result.status }); return; }
      const body = result.body;
      if (!object(body) || !object(body.channels) || !object(body.releases) ||
          !Object.values(body.channels).every((tag) => tag === null || typeof tag === "string")) throw problem("CONTRACT_INVALID");
      const tags = Object.values(body.channels).filter(text);
      if (!tags.length) { blocked("cloud.download-manifest", "Manifest is reachable but has no published channel pointers."); return; }
      if (!tags.every((tag) => object(body.releases[tag]))) throw problem("CONTRACT_INVALID");
      add("cloud.download-manifest", "passed", { httpStatus: 200, publishedChannelCount: tags.length, meaning: "Manifest and channel release records are reachable; installer assets were not downloaded." });
    });
  } else {
    blocked("cloud.origin", "Cloud origin was not advertised by a valid status response.");
    blocked("cloud.download-manifest", "Cloud origin was not advertised by a valid status response.");
  }
  if (cloud?.state === "connected") await attempt("cloud.authenticated-workspaces", async () => {
    const result = await localRequest("/api/simforge/cloud/workspaces");
    if (result.status !== 200) { add("cloud.authenticated-workspaces", "failed", { httpStatus: result.status }); return; }
    if (!object(result.body) || !Array.isArray(result.body.workspaces) || !result.body.workspaces.every((workspace) =>
      object(workspace) && text(workspace.id) && typeof workspace.name === "string" && text(workspace.role))) throw problem("CONTRACT_INVALID");
    add("cloud.authenticated-workspaces", "passed", { httpStatus: 200, workspaceCount: result.body.workspaces.length, meaning: "Actual authenticated read through the installed Cloud connector; an empty workspace list is valid." });
  });
  else blocked("cloud.authenticated-workspaces", cloud ? `Cloud is ${cloud.state}; authenticated flows require an existing connected session.` : "Cloud connection status unavailable.");
  return checks;
}
