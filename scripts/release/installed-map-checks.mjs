import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const SHA256 = /^[a-f0-9]{64}$/;
const ROOT = "/api/simforge/maps";

class Blocked extends Error {}

function requireValue(value, message) {
  if (!value) {
    const error = new Error(message);
    error.safeMapCheck = true;
    throw error;
  }
}

function memberPath(path) {
  requireValue(typeof path === "string" && path.length > 0 && !path.includes("\\") &&
    !/[?#:%]/.test(path) && path.split("/").every((part) => part && part !== "." && part !== ".."),
  "Invalid map member relative path");
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Exercise only an already-running installed HTTP host. No repository runtime
 * imports, Cloud mutations, scenario creation, render jobs or cache deletion.
 *
 * options: baseUrl, headers, signal, allowMapDownload (strict true authorizes
 * installs/cache fills), timeoutMs (default 30 minutes), pollIntervalMs (1500).
 * The caller owns host.json credentials, CLI flags, report files and exit code.
 * Cancellation stops this observer; host-owned installs can continue afterward.
 * Read-only has() probes may maintain cache aliases, but never fetch map bytes
 * upstream. A cache miss is blocked before any asset GET, which can fill misses.
 */
export async function runInstalledMapChecks({
  baseUrl, headers = {}, signal, allowMapDownload = false,
  timeoutMs = 30 * 60_000, pollIntervalMs = 1_500,
} = {}) {
  const results = [];
  const names = ["map-catalog", "map-install-browser", "map-install-semantic",
    "map-browser-ready", "map-semantic-ready", "map-editor-metadata",
    "map-browser-bytes", "map-editor-assets", "map-semantic-bytes",
    "map-repeat-install", "map-cache-reuse"];
  const controller = new AbortController();
  let deadline;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const checksSignal = controller.signal;
  const check = async (name, operation) => {
    try {
      checksSignal.throwIfAborted();
      const details = await operation();
      results.push({ name, status: "passed", ...(details === undefined ? {} : { details }) });
      return true;
    } catch (error) {
      // Only locally authored errors are reported; never echo HTTP bodies,
      // signed locations, credential-bearing URLs, or fetch exception causes.
      const cancelled = checksSignal.aborted;
      results.push({ name, status: error instanceof Blocked || cancelled ? "blocked" : "failed",
        error: cancelled ? "Observation cancelled or deadline reached; host-owned installs may continue."
          : error instanceof Blocked || error?.safeMapCheck ? error.message : "Map request or byte verification failed; response bodies and untrusted error text withheld." });
      return false;
    }
  };
  const fail = (message) => { const error = new Error(message); error.safeMapCheck = true; throw error; };
  try {
    requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "Invalid timeout");
    requireValue(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 250, "Invalid polling interval");
    deadline = setTimeout(abort, timeoutMs);
    const origin = new URL(baseUrl);
    requireValue(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password,
      "Expected installed-host HTTP URL without embedded credentials");
    const requestHeaders = new Headers(headers);
    requestHeaders.delete("range");
    requestHeaders.delete("if-none-match");
    requestHeaders.delete("if-modified-since");
    requestHeaders.set("origin", origin.origin);
    requestHeaders.set("accept-encoding", "identity");
    const localUrl = (path) => {
      const url = new URL(path, origin);
      requireValue(url.origin === origin.origin && !url.username && !url.password && !url.hash,
        "Map route must remain on the installed host");
      return url;
    };
    const request = async (path, body) => {
      checksSignal.throwIfAborted();
      const outgoing = new Headers(requestHeaders);
      if (body !== undefined) outgoing.set("content-type", "application/json");
      const response = await fetch(localUrl(path), { headers: outgoing, signal: checksSignal,
        cache: "no-store", redirect: "manual", ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
      if (!response.ok) {
        await response.body?.cancel();
        fail(`Installed-host request returned HTTP ${response.status}; response body and location withheld.`);
      }
      return response;
    };
    const json = async (path, body) => (await request(path, body)).json();
    let map;
    let metadata;
    let inventory;
    const verified = new Map();
    const installStates = new Map();
    const catalogOk = await check("map-catalog", async () => {
      const catalog = await json(`${ROOT}/catalog`);
      requireValue(Array.isArray(catalog.maps), "Invalid catalog");
      const candidates = catalog.maps.filter((entry) => entry.access === "public" && !entry.locked &&
        (entry.sourceMapId === "richmond-field-station" || /^Richmond Field Station(?:\s*[,(-].*)?$/i.test(entry.label ?? "")));
      if (candidates.length === 0) throw new Blocked("Public Richmond Field Station is absent from the installed-host catalog; no other map selected.");
      if (candidates.length !== 1) throw new Blocked("Public Richmond Field Station selection is ambiguous; no map was installed.");
      map = candidates[0];
      requireValue(/^[A-Za-z0-9_-]{8,128}$/.test(map.mapVersionId), "Invalid map version identity");
      return { mapVersionId: map.mapVersionId, access: "public", installed: {
        browser: map.installed?.browser === true, semantic: map.installed?.semantic === true } };
    });
    if (!catalogOk) return results;
    const mapRoot = `${ROOT}/${encodeURIComponent(map.mapVersionId)}`;
    const assetUrl = (profile, path) => `${mapRoot}/${profile}-assets/${memberPath(path)}`;
    const install = async (profile) => {
      let state = await json(`${mapRoot}/install`, { profile });
      let polls = 0;
      for (;;) {
        requireValue(state.mapVersionId === map.mapVersionId && state.profile === profile &&
          ["idle", "materializing", "ready", "error"].includes(state.state), "Invalid install response");
        if (state.state !== "materializing") break;
        await delay(pollIntervalMs, undefined, { signal: checksSignal });
        state = await json(`${mapRoot}/install?profile=${profile}`);
        polls++;
      }
      if (state.state !== "ready") fail(`The ${profile} install ended in ${state.state}; server message withheld.`);
      requireValue(typeof state.directory === "string" && state.directory.length > 0, "Missing materialization directory");
      requireValue(state.progress && ["members", "completedMembers", "bytes", "completedBytes"].every(
        (key) => Number.isSafeInteger(state.progress[key]) && state.progress[key] >= 0) &&
        state.progress.members === state.progress.completedMembers && state.progress.bytes === state.progress.completedBytes,
      "Incomplete install accounting");
      installStates.set(profile, state);
      return { polls, ...state.progress };
    };
    for (const profile of ["browser", "semantic"]) {
      await check(`map-install-${profile}`, async () => {
        if (allowMapDownload !== true) throw new Blocked("Install POST requires explicit allowMapDownload authorization; existing cache is preserved.");
        return install(profile);
      });
    }
    const refreshed = await check("map-browser-ready", async () => {
      metadata = await json(mapRoot);
      if (allowMapDownload === true && !installStates.has("browser")) {
        throw new Blocked("Browser install did not complete successfully.");
      }
      requireValue(metadata.mapVersionId === map.mapVersionId && metadata.access === "public" && metadata.locked === false, "Map identity/access changed");
      if (metadata.installed?.browser !== true) throw new Blocked("Browser closure is not installed.");
      return { registered: true, installObserved: installStates.has("browser") };
    });
    await check("map-semantic-ready", async () => {
      if (allowMapDownload === true && !installStates.has("semantic")) {
        throw new Blocked("Semantic install did not complete successfully.");
      }
      if (!metadata || metadata.installed?.semantic !== true) throw new Blocked("Semantic closure is not installed.");
      return { registered: true, installObserved: installStates.has("semantic") };
    });
    await check("map-editor-metadata", async () => {
      if (!refreshed) throw new Blocked("Installed browser metadata is unavailable.");
      const editor = await json(ROOT);
      const entry = editor.maps?.find((candidate) => candidate.mapVersionId === map.mapVersionId);
      requireValue(entry && entry.browserManifestUrl === metadata.browserManifestUrl &&
        entry.browserClosureSha256 === metadata.browserClosureSha256 && SHA256.test(entry.browserClosureSha256) &&
        typeof entry.xodr?.artifactId === "string" && typeof entry.coordinateSystem?.id === "string", "Editor metadata mismatch");
      const plan = await json(`${ROOT}/cache-plan`);
      inventory = plan.maps?.find((candidate) => candidate.mapVersionId === map.mapVersionId);
      requireValue(inventory && inventory.closureSha256 === entry.browserClosureSha256 &&
        Array.isArray(inventory.assets) && inventory.assets.length > 0, "Browser inventory mismatch");
      const paths = new Set();
      for (const member of inventory.assets) {
        memberPath(member.relativePath);
        requireValue(!paths.has(member.relativePath) && SHA256.test(member.sha256) &&
          Number.isSafeInteger(member.byteLength) && member.byteLength >= 0, "Invalid browser inventory member");
        paths.add(member.relativePath);
      }
      return { mapVersionId: map.mapVersionId, closureSha256: inventory.closureSha256, members: paths.size };
    });
    const readAsset = async (profile, path, declaration, capture = false) => {
      const url = assetUrl(profile, path);
      if (allowMapDownload !== true) {
        const present = await json("/api/simforge/map-cache/has", { url, ...(declaration ? { sha256: declaration.sha256 } : {}) });
        if (present.cached !== true) throw new Blocked(`A ${profile} member is absent from verified cache; asset GET withheld to avoid an implicit download.`);
      }
      const response = await request(url);
      const digest = response.headers.get("x-content-sha256");
      const length = response.headers.get("content-length");
      const bytesDeclared = length !== null && /^\d+$/.test(length) ? Number(length) : NaN;
      if (!SHA256.test(digest ?? "") || !Number.isSafeInteger(bytesDeclared) ||
        (declaration && (digest !== declaration.sha256 || bytesDeclared !== declaration.byteLength))) {
        await response.body?.cancel();
        fail(`The ${profile} asset digest/size declaration is missing or inconsistent.`);
      }
      const hash = createHash("sha256");
      const chunks = [];
      let bytes = 0;
      requireValue(response.body, "Missing asset body");
      for await (const chunk of response.body) {
        checksSignal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > bytesDeclared || (capture && bytes > 64 * 1024 * 1024)) fail("Asset body exceeded declared or JSON capture size.");
        hash.update(chunk);
        if (capture) chunks.push(chunk);
      }
      if (bytes !== bytesDeclared || hash.digest("hex") !== digest) fail(`The ${profile} asset bytes failed SHA-256/length verification.`);
      verified.set(url, { sha256: digest, byteLength: bytes, profile, path });
      return capture ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : bytes;
    };
    const browserBytesOk = await check("map-browser-bytes", async () => {
      if (!inventory?.assets?.length) throw new Blocked("Verified browser inventory is unavailable.");
      let bytes = 0;
      for (const member of [...inventory.assets].sort((a, b) => a.relativePath < b.relativePath ? -1 : 1)) {
        bytes += await readAsset("browser", member.relativePath, member);
      }
      return { members: inventory.assets.length, bytes, verification: "Every inventory member streamed and matched declared SHA-256 and byte length." };
    });
    await check("map-editor-assets", async () => {
      if (!browserBytesOk) throw new Blocked("Complete browser byte verification did not pass.");
      const fields = ["browserManifestUrl", "topologyArtifactUrl", "derivedTopologyUrl", "locationsUrl", "signalsArtifactUrl"];
      for (const field of fields) {
        requireValue(typeof metadata[field] === "string", "Missing editor asset route");
        const url = localUrl(metadata[field]);
        requireValue(!url.search && verified.has(url.pathname), "Editor route does not resolve to verified browser bytes");
      }
      const manifestMember = verified.get(localUrl(metadata.browserManifestUrl).pathname);
      const manifest = await readAsset("browser", manifestMember.path, manifestMember, true);
      requireValue(manifest && typeof manifest === "object" && !Array.isArray(manifest), "Invalid browser manifest JSON");
      return { routes: fields, manifestJson: true, allRoutesByteVerified: true };
    });
    await check("map-semantic-bytes", async () => {
      if (metadata?.installed?.semantic !== true) throw new Blocked("Semantic closure registration is unavailable.");
      const master = await readAsset("semantic", "master.gltf", undefined, true);
      requireValue(master.asset?.version === "2.0" && Array.isArray(master.meshes) && master.meshes.length > 0,
        "Semantic master is not a glTF 2 mesh scene");
      const resources = new Set();
      for (const resource of [...(master.buffers ?? []), ...(master.images ?? [])]) {
        if (resource.uri === undefined) continue;
        requireValue(typeof resource.uri === "string", "Invalid glTF resource URI");
        if (resource.uri.startsWith("data:")) continue;
        memberPath(resource.uri);
        resources.add(resource.uri);
      }
      for (const path of [...resources].sort()) await readAsset("semantic", path);
      const members = [...verified.values()].filter((member) => member.profile === "semantic");
      return { members: members.length, bytes: members.reduce((sum, member) => sum + member.byteLength, 0),
        scope: "master.gltf and every external buffer/image URI; digests and sizes from installed registry response headers, not a full native inventory" };
    });
    const repeated = await check("map-repeat-install", async () => {
      if (allowMapDownload !== true) throw new Blocked("Repeated install requires explicit allowMapDownload authorization.");
      if (!installStates.has("browser") || !installStates.has("semantic")) throw new Blocked("Both initial installs must complete before reuse can be exercised.");
      for (const profile of ["browser", "semantic"]) {
        const previousDirectory = installStates.get(profile).directory;
        await install(profile);
        requireValue(installStates.get(profile).directory === previousDirectory,
          "Repeat install did not reuse the registered materialization directory");
      }
      return { profiles: ["browser", "semantic"], directoriesStable: true };
    });
    await check("map-cache-reuse", async () => {
      if (!repeated || !browserBytesOk || !results.some((result) => result.name === "map-semantic-bytes" && result.status === "passed")) {
        throw new Blocked("Repeat install and browser/semantic byte verification must pass before cache reuse can be proven.");
      }
      const members = [...verified.entries()];
      let bytes = 0;
      for (const [url, member] of members) {
        const receipt = await json("/api/simforge/map-cache/ensure", { requestId: `qualification:${randomUUID()}`,
          url, sha256: member.sha256, sizeBytes: member.byteLength });
        requireValue(receipt.cacheHit === true && receipt.sha256 === member.sha256 && receipt.sizeBytes === member.byteLength,
          "Repeat cache ensure was not a verified cache hit");
        bytes += await readAsset(member.profile, member.path, member);
      }
      return { cacheHits: members.length, reverifiedBytes: bytes,
        verification: "Repeat install followed by cacheHit=true receipts and second complete SHA-256/size checks of the exercised members." };
    });
  } catch {
    results.push({ name: "map-check-configuration", status: "failed", error: "Invalid installed-host map-check options; credentials and raw values withheld." });
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    for (const name of names) {
      if (!results.some((result) => result.name === name)) results.push({ name, status: "blocked", error: "Required prior map check did not complete." });
    }
    for (const name of ["map-native-scenario-build", "map-native-simulation", "map-native-render"]) {
      results.push({ name, status: "blocked", error: "Not exercised: map HTTP readiness is not evidence of a native scenario, simulation, or render workflow. No jobs were submitted." });
    }
  }
  return results;
}
