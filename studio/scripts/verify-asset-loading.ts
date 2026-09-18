/**
 * Real asset-serving and renderer-lifetime gate, against an isolated daemon:
 *   pnpm exec tsx scripts/verify-asset-loading.ts --root=/tmp/host \
 *     --maps-root=/tmp/maps --chromium=/path/to/chrome --out=/tmp/loading
 *
 * Default: 32 closure members, serving integrity/ranges/conditional requests,
 * and cold + warm High gallery loads at the user's measured 13 ms RTT, followed
 * by same-map route retention, five editor exits and a genuine different-map load.
 * --all also checks every closure member, 100 ms latency, and the desktop bridge.
 * Both tiers require 100%, a single renderer lifetime, and zero browser errors.
 * Chromium resolves asset-host.test to loopback: HTTP is deliberately NOT a
 * secure context, so Cache Storage cannot hide a broken HTTP caching policy.
 * Requires hardware-accelerated Chromium and a throwaway daemon on 5470-5490.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { verifyWorldNavigation } from "./verify-world-navigation";

const gateStarted = performance.now();
const args = new Map(process.argv.slice(2).map((arg) => {
  if (arg === "--all") return ["all", "true"] as const;
  const match = /^--(root|maps-root|chromium|out)=(.+)$/.exec(arg);
  if (!match) throw new Error(`unknown argument ${arg}`);
  return [match[1]!, match[2]!] as const;
}));
const root = args.get("root");
assert(root, "--root must name a throwaway daemon data root");
const mapsRoot = resolve(args.get("maps-root") ?? join(root, "installed-maps"));
const out = resolve(args.get("out") ?? join(root, "asset-loading-verification"));
const host = JSON.parse(await readFile(join(root, "host.json"), "utf8")) as { baseUrl: string; controlToken: string };
const base = new URL(host.baseUrl);
assert(base.hostname === "127.0.0.1" && Number(base.port) >= 5470 && Number(base.port) <= 5490,
  "refusing anything other than a throwaway loopback daemon on 5470-5490");
const browserOrigin = new URL(base);
browserOrigin.hostname = "asset-host.test";
const authorization = `Bearer ${host.controlToken}`;
const MAP = "belmont-research-center";
const LATENCY_MS = args.has("all") ? 100 : 13;
const MAX_LOAD_MS = 120_000;
const MIN_MBPS = 10;
const pass = (message: string) => console.log(`PASS ${message}`);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, base), { ...init, headers: { authorization, ...init.headers }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}
const jsonBody = (value: unknown): RequestInit => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
type MapDescriptor = { mapVersionId: string; sourceMapId: string; label: string; browserAssetRootUrl: string };
const { maps: catalog } = await api<{ maps: MapDescriptor[] }>("/api/simforge/maps");
const map = catalog.find((candidate) => candidate.sourceMapId === MAP);
assert(map, `install ${MAP} in the throwaway daemon first`);
assert.equal([...catalog].sort((a, b) => a.label.localeCompare(b.label))[0]?.mapVersionId, map.mapVersionId,
  "this fixture must start the real gallery on Belmont");
const releaseBytes = await readFile(join(mapsRoot, "map-bundles", MAP, ".map-release.json"));
const release = JSON.parse(releaseBytes.toString("utf8")) as {
  members: Record<string, { bytes: number; sha256: string }>;
};
const allMembers = Object.entries({ ".map-release.json": { bytes: releaseBytes.length, sha256: sha256(releaseBytes) }, ...release.members });
assert(allMembers.length >= 32, "the gate requires a real closure, not a tiny fixture");
const members = args.has("all") ? allMembers : Array.from({ length: 32 }, (_, i) => allMembers[Math.floor(i * allMembers.length / 32)]!);
await mkdir(out, { recursive: true });
const getMember = (path: string, headers: Record<string, string> = {}) => fetch(new URL(`${map.browserAssetRootUrl}/${path}`, base), {
  headers: { authorization, ...headers }, redirect: "manual", signal: AbortSignal.timeout(30_000),
});

async function verifyClosure() {
  let cursor = 0;
  let bytes = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < members.length) {
      const [path, member] = members[cursor++]!;
      const response = await getMember(path);
      assert.equal(response.status, 200, `${path}: must serve directly, not redirect`);
      assert(response.body, `${path}: missing body`);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of response.body) { hash.update(chunk); size += chunk.byteLength; }
      assert.equal(size, member.bytes, `${path}: byte count`);
      assert.equal(hash.digest("hex"), member.sha256, `${path}: digest`);
      bytes += size;
    }
  }));
  const ms = performance.now() - started;
  const MBps = bytes / ms / 1000;
  assert(MBps >= MIN_MBPS, `closure throughput ${MBps.toFixed(2)} MB/s < ${MIN_MBPS}`);
  pass(`closure: ${members.length}/${allMembers.length} members, ${bytes} bytes, all sha256/size verified through HTTP`);
  pass(`serving performance: ${MBps.toFixed(2)} MB/s >= ${MIN_MBPS}; ${ms.toFixed(0)} ms, ${members.length} requests, 0 redirects, concurrency 8`);
  return { members: members.length, bytes, ms, MBps };
}

async function verifyServing() {
  const path = "3d/manifest.json";
  const expected = release.members[path]!;
  const response = await getMember(path);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(sha256(bytes), expected.sha256);
  const etag = `"${expected.sha256}"`;
  assert.equal(response.headers.get("etag"), etag);
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  const unchanged = await getMember(path, { "if-none-match": `"old", W/${etag}` });
  assert.equal(unchanged.status, 304);
  assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
  const range = await getMember(path, { range: "bytes=10-29", "if-range": etag });
  assert.equal(range.status, 206);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), bytes.slice(10, 30));
  const changed = await getMember(path, { range: "bytes=10-29", "if-range": '"not-this-member"' });
  assert.equal(changed.status, 200);
  assert.equal(sha256(new Uint8Array(await changed.arrayBuffer())), expected.sha256);
  const unknown = await getMember("not-in-the-published-closure", { "if-none-match": etag });
  assert.equal(unknown.status, 404, "a validator must not authorize another member");
  assert.deepEqual(await unknown.json(), { error: "map_asset_not_found" });
  pass("HTTP contract: digest ETag, authorized 304, exact range, stale If-Range full body, unknown member refused");

  const guard = release.members["topology-index.json.gz"]!;
  const artifact = join(root!, "artifacts", "local-artifacts", "maps", MAP, "objects", guard.sha256);
  const parked = `${artifact}.verify-asset-loading`;
  const cached = join(root!, "map-cache", "objects", guard.sha256.slice(0, 2), guard.sha256);
  await rename(artifact, parked);
  try {
    await rm(cached, { force: true });
    const missing = await getMember("topology-index.json.gz");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "map_member_missing" });
    // The canonical hardlink is parked, NOT opened for writing. This creates
    // a new inode; the source corpus can never be modified by this test.
    await writeFile(artifact, Buffer.alloc(guard.bytes, 0x5a), { flag: "wx" });
    const corrupt = await getMember("topology-index.json.gz", { "if-none-match": `"${guard.sha256}"` });
    assert.equal(corrupt.status, 502);
    assert.deepEqual(await corrupt.json(), { error: "map_member_integrity" });
  } finally {
    await rm(artifact, { force: true });
    await rename(parked, artifact);
  }
  // Simultaneous misses must coalesce, not collide on a timestamp request id.
  await Promise.all(Array.from({ length: 8 }, async () => {
    const restored = await getMember("topology-index.json.gz");
    assert.equal(restored.status, 200);
    assert.equal(sha256(new Uint8Array(await restored.arrayBuffer())), guard.sha256);
  }));
  pass("integrity: missing member refused; same-size corrupt member refused even with ETag; 8 concurrent repaired reads verified");
}

type NetworkRow = { url: string; start: number; status?: number; wireStatus?: number; wireBodyBytes?: number; ms?: number; bytes?: number; failed?: string; asset: boolean };
type Progress = { at: number; percent: number };
declare global {
  interface Window {
    __assetLoadingProgress?: Progress[];
    __assetCacheCall: (method: string, body?: unknown) => Promise<unknown>;
  }
}
async function desktopContract(context: BrowserContext) {
  const calls: string[] = [];
  // Only the Electron IPC boundary is replaced; every operation reaches the
  // real host. This exercises the desktop branch, not Cache Storage fallback.
  await context.exposeFunction("__assetCacheCall", async (method: string, body?: unknown) => {
    calls.push(method);
    if (method === "status") return api("/api/simforge/map-cache/status");
    if (method === "chooseDirectory") throw new Error("Native folder selection is outside browser verification");
    if (method === "receipt") {
      assert.equal(typeof body, "string");
      return api(`/api/simforge/map-cache/receipt?key=${encodeURIComponent(String(body))}`);
    }
    if (method === "writeReceipt") return api("/api/simforge/map-cache/receipt", { method: "PUT", ...jsonBody(body) });
    return api(`/api/simforge/map-cache/${method}`, { method: "POST", ...jsonBody(body),
      headers: { "content-type": "application/json", host: browserOrigin.host } });
  });
  // A string avoids tsx's function-name helper leaking into the browser realm.
  await context.addInitScript({ content: `window.simforgeDesktop = {
    version: 1, shell: "desktop", mapCache: {
      status: () => window.__assetCacheCall("status"),
      has: async request => (await window.__assetCacheCall("has", request)).cached,
      ensure: async request => { const result = await window.__assetCacheCall("ensure", request); return {...result, url: new URL(result.url, location.origin).href}; },
      cancel: requestId => window.__assetCacheCall("cancel", {requestId}),
      receipt: async key => (await window.__assetCacheCall("receipt", key)).receipt,
      writeReceipt: (key, receipt) => window.__assetCacheCall("writeReceipt", {key, receipt}),
      clear: () => window.__assetCacheCall("clear"),
      chooseDirectory: () => window.__assetCacheCall("chooseDirectory")
    }
  };` });
  return calls;
}

/** Ceiling for p95 frame time on a settled scene in headless ANGLE, ms. */
const READY_FRAME_MS_P95 = 120;
const READY_STABILITY_WINDOW_MS = 8_000;

/**
 * Watch a scene that has just reported itself ready.
 *
 * Two regressions hide here and both are invisible to a load-time assertion:
 * a readiness signal that fires before the view is resident (the user sees
 * buildings pop in seconds later), and a settled scene that does not hold a
 * steady frame. Both are read from the viewer's own diagnostics probe.
 */
async function measureReadyScene(page: Page) {
  // The evaluated body must contain no named function expressions: tsx's
  // esbuild transform adds a `__name` helper to them that does not exist in
  // the browser realm.
  return await page.evaluate(async (windowMs: number) => {
    const probe = window.__simforgeViewerProbe;
    const missingAtReady = probe?.viewer.getStats().coverage.city?.missingInViewTiles ?? 0;
    let maxMissingInView = missingAtReady;
    let samples = 1;
    const deltas: number[] = [];
    let last = performance.now();
    const deadline = last + windowMs;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      const missing = probe?.viewer.getStats().coverage.city?.missingInViewTiles ?? 0;
      if (missing > maxMissingInView) maxMissingInView = missing;
      samples++;
    }
    const sorted = [...deltas].sort((a, b) => a - b);
    const p50 = sorted[Math.min(sorted.length - 1, Math.round(0.5 * (sorted.length - 1)))] ?? 0;
    const p95 = sorted[Math.min(sorted.length - 1, Math.round(0.95 * (sorted.length - 1)))] ?? 0;
    return {
      probed: probe !== undefined,
      windowMs,
      samples,
      frames: deltas.length,
      missingInViewAtReady: missingAtReady,
      maxMissingInView,
      frameMsP50: p50,
      frameMsP95: p95,
      frameMsMax: sorted[sorted.length - 1] ?? 0,
    };
  }, READY_STABILITY_WINDOW_MS);
}

async function verifyViewer(context: BrowserContext, name: string, path: string) {
  const ticket = await api<{ url: string }>("/api/simforge/host/session", { method: "POST", ...jsonBody({ next: path }),
    headers: { "content-type": "application/json", host: browserOrigin.host } });
  // DNS aliasing exists in Chromium only. Redeem the one-use ticket on that
  // authority, so the cookie and redirect belong to the non-secure origin.
  const ticketUrl = new URL(ticket.url);
  ticketUrl.hostname = browserOrigin.hostname;
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1 });
    const network: NetworkRow[] = [];
    const active = new Map<string, NetworkRow>();
    const byId = new Map<string, NetworkRow>();
    const errors: string[] = [];
    let mounts = 0;
    let peakAssetConcurrency = 0;
    let responses304 = 0;
    let development = false;
    cdp.on("Network.webSocketCreated", (event) => { if (event.url.includes("/_next/webpack-hmr")) development = true; });
    cdp.on("Network.requestWillBeSent", (event) => {
      if (event.redirectResponse) {
        const previous = active.get(event.requestId);
        if (previous) { previous.status = event.redirectResponse.status; previous.ms = (event.timestamp - previous.start) * 1000; }
      }
      const url = new URL(event.request.url);
      const row: NetworkRow = { url: url.pathname, start: event.timestamp, asset: /\/(browser-assets|semantic-assets|local-objects|map-cache\/stream)\//.test(url.pathname) };
      network.push(row);
      active.set(event.requestId, row);
      byId.set(event.requestId, row);
      peakAssetConcurrency = Math.max(peakAssetConcurrency, [...active.values()].filter((entry) => entry.asset).length);
    });
    cdp.on("Network.responseReceived", (event) => { const row = active.get(event.requestId); if (row) row.status = event.response.status; });
    cdp.on("Network.responseReceivedExtraInfo", (event) => {
      const row = byId.get(event.requestId);
      if (row) row.wireStatus = event.statusCode;
      if (event.statusCode === 304 && row?.asset) responses304++;
    });
    cdp.on("Network.dataReceived", (event) => {
      const row = byId.get(event.requestId);
      if (row) row.wireBodyBytes = (row.wireBodyBytes ?? 0) + event.encodedDataLength;
    });
    cdp.on("Network.loadingFinished", (event) => {
      const row = active.get(event.requestId);
      if (row) { row.ms = (event.timestamp - row.start) * 1000; row.bytes = event.encodedDataLength; }
      active.delete(event.requestId);
    });
    cdp.on("Network.loadingFailed", (event) => { const row = active.get(event.requestId); if (row) row.failed = event.errorText; active.delete(event.requestId); });
    page.on("console", (message) => {
      if (message.text().includes("[viewer-diagnostics] mount")) mounts++;
      if (message.type() === "error" && !message.location().url?.endsWith("/favicon.ico")) errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const samples: Progress[] = [];
      window.__assetLoadingProgress = samples;
      new MutationObserver(() => {
        const raw = document.querySelector('[data-testid="scenario-world-host"]')?.getAttribute("data-world-load-percent");
        if (!raw) return;
        const percent = Number(raw);
        if (samples.at(-1)?.percent !== percent) samples.push({ at: performance.now(), percent });
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-world-load-percent"], childList: true });
    });
    const started = performance.now();
    await page.goto(ticketUrl.href, { waitUntil: "domcontentloaded", timeout: MAX_LOAD_MS });
    let failure: unknown;
    try {
      await page.waitForFunction((id) => {
        const host = document.querySelector('[data-testid="scenario-world-host"]');
        return host?.getAttribute("data-world-loaded-map-version-id") === id && host.getAttribute("data-world-load-percent") === "100";
      }, map!.mapVersionId, { timeout: Math.max(1, MAX_LOAD_MS - (performance.now() - started)) });
      if (name === "editor-desktop") await page.getByTestId("scenario-editor-session").waitFor({ state: "visible", timeout: 10_000 });
      await page.locator('[data-testid="cloud-loading-surface"][data-cloud-loading-scope="screen"]').waitFor({ state: "hidden", timeout: 10_000 });
    } catch (error) { failure = error; }
    const ms = performance.now() - started;
    await cdp.send("Network.disable");
    const stability = await measureReadyScene(page);
    const progress = await page.evaluate(() => window.__assetLoadingProgress ?? []);
    const security = await page.evaluate(() => ({ secureContext: isSecureContext, cacheStorage: "caches" in window }));
    const result = { name, ms, latencyMs: LATENCY_MS, mounts, errors, progress, security, responses304, requests: network.length,
      redirects: network.filter((row) => row.asset && row.status && row.status >= 300 && row.status < 400).length,
      assetBytes: network.filter((row) => row.asset).reduce((n, row) => n + (row.bytes ?? 0), 0), peakAssetConcurrency, stability, network };
    await writeFile(join(out, `${name}.json`), JSON.stringify(result, null, 2));
    await page.screenshot({ path: join(out, `${name}.png`) });
    if (failure) throw failure;
    assert.equal(security.secureContext, false);
    assert.equal(security.cacheStorage, false, "Cache Storage must not hide HTTP-cache failures");
    assert(ms < MAX_LOAD_MS, `${name}: ${ms} ms >= ${MAX_LOAD_MS}`);
    assert.equal(mounts, development ? 2 : 1, `${name}: renderer constructions (one lifetime${development ? " plus StrictMode probe" : ""})`);
    assert(!errors.some((error) => error.includes("Maximum update depth exceeded")), `${name}: React update loop`);
    assert.deepEqual(errors, [], `${name}: browser errors`);
    assert.equal(progress.at(-1)?.percent, 100);
    assert(progress.every((sample, index) => index === 0 || sample.percent >= progress[index - 1]!.percent), `${name}: progress regressed`);
    assert(peakAssetConcurrency > 1, `${name}: asset loading became serial`);
    // Readiness has to mean what it says: a scene that reports itself loaded
    // shows every tile the camera can see, and nothing pops into the frame
    // afterwards. Before this gate existed the map announced readiness with
    // zero tiles resident and the buildings arrived up to 70 s later.
    assert.equal(stability.missingInViewAtReady, 0, `${name}: tiles missing from the view at ready`);
    assert.equal(stability.maxMissingInView, 0, `${name}: a tile appeared inside the view after ready`);
    assert(stability.frameMsP95 <= READY_FRAME_MS_P95, `${name}: p95 frame ${stability.frameMsP95.toFixed(1)} ms > ${READY_FRAME_MS_P95} ms on a settled scene`);
    pass(`${name}: ready means visible — 0 in-view tiles missing at ready and over ${(stability.windowMs / 1000).toFixed(0)} s after it (${stability.samples} samples)`);
    pass(`${name}: settled-scene pacing p50 ${stability.frameMsP50.toFixed(1)} ms / p95 ${stability.frameMsP95.toFixed(1)} ms over ${stability.frames} frames`);
    assert.equal(result.redirects, 0, `${name}: map delivery must not mint expiring URLs`);
    pass(`${name}: 100% ready in ${ms.toFixed(0)} ms < ${MAX_LOAD_MS}, ${LATENCY_MS} ms latency, insecure HTTP (no Cache Storage)`);
    pass(`${name}: exactly ${mounts} renderer mount(s), monotonic ${progress.map((p) => p.percent).join(" -> ")}, 0 non-favicon errors`);
    pass(`${name}: ${result.requests} requests, 0 asset redirects, ${responses304} asset 304s, ${result.assetBytes} encoded asset bytes, peak inflight ${peakAssetConcurrency}`);
    return result;
  } finally { await page.close(); }
}

/** Hold the real setup response in an isolated context: hidden must mean unmounted. */
async function verifySetupGate() {
  const browser = context.browser();
  assert(browser);
  const probe = await browser.newContext();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let mounts = 0;
  try {
    await probe.route("**/api/simforge/host/setup", async (route) => {
      await held;
      // The probe closes immediately after releasing its barrier.
      await route.continue().catch(() => undefined);
    });
    const page = await probe.newPage();
    page.on("console", (message) => { if (message.text().includes("[viewer-diagnostics] mount")) mounts++; });
    const ticket = await api<{ url: string }>("/api/simforge/host/session", { method: "POST", ...jsonBody({ next: "/dashboard/map-assets" }) });
    const url = new URL(ticket.url);
    url.hostname = browserOrigin.hostname;
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/simforge/host/setup");
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await requested;
    await page.getByTestId("onboarding-gate-content").waitFor({ state: "attached" });
    await page.waitForTimeout(500);
    assert.notEqual(await page.getByTestId("onboarding-gate-content").getAttribute("inert"), null);
    assert.equal(await page.getByTestId("scenario-world-host").count(), 0);
    assert.equal(mounts, 0);
    pass("setup gate: 0 renderer constructions and no world mounted while the real setup response is pending");
  } finally {
    release();
    await probe.close();
  }
}

await api("/api/simforge/host/setup", { method: "PUT", ...jsonBody({ mode: "local", quality: "high" }) });
const closure = await verifyClosure();
await verifyServing();
const profile = join(out, "browser-profile");
// A repeat gate must start cold too. This directory is owned exclusively by
// this script under its output directory, never the user's Chromium profile.
await rm(profile, { recursive: true, force: true });
// The HTTP reuse contract requires room for Belmont's 1.8 GB closure; Chromium's
// machine-dependent default quota evicts its largest textures during this test.
// This does not affect the route-retention assertion: that forbids even a GET.
const context = await chromium.launchPersistentContext(profile, { executablePath: args.get("chromium") ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  headless: true, viewport: { width: 1600, height: 1000 }, args: ["--no-sandbox", "--disk-cache-size=4294967296", "--use-gl=angle", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--host-resolver-rules=MAP asset-host.test 127.0.0.1", "--no-proxy-server"] });
try {
  await verifySetupGate();
  const cold = await verifyViewer(context, "gallery-cold", "/dashboard/map-assets");
  const warm = await verifyViewer(context, "gallery-warm", "/dashboard/map-assets");
  assert(warm.responses304 >= 30, "warm map must revalidate stable URLs rather than download new signed URLs");
  assert(warm.assetBytes < cold.assetBytes / 2, "warm map must reuse most response bytes");
  pass(`warm reuse: ${(100 * (1 - warm.assetBytes / cold.assetBytes)).toFixed(2)}% fewer wire bytes; ${warm.responses304} authorized 304s, ${(warm.ms / 1000).toFixed(2)} s`);
  const other = catalog.find((candidate) => candidate.sourceMapId === "richmond-field-station");
  assert(other, "install Richmond for the different-map navigation assertion");
  const navigationTicket = await api<{ url: string }>("/api/simforge/host/session", {
    method: "POST", ...jsonBody({ next: "/dashboard/map-assets" }),
    headers: { "content-type": "application/json", host: browserOrigin.host },
  });
  const navigationUrl = new URL(navigationTicket.url);
  navigationUrl.hostname = browserOrigin.hostname;
  const navigation = await verifyWorldNavigation({ context, ticketUrl: navigationUrl.href, map, other, out, latencyMs: LATENCY_MS });
  let editor;
  if (args.has("all")) {
    const created = await api<{ document: { id: string; datasetId: string } }>(`/api/simforge/maps/${map.mapVersionId}/documents/default`, { method: "POST" });
    await context.clearCookies();
    const calls = await desktopContract(context);
    const query = new URLSearchParams({ dataset: created.document.datasetId, document: created.document.id });
    editor = await verifyViewer(context, "editor-desktop", `/dashboard/scenario?${query}`);
    assert(!calls.includes("ensure"), "normal desktop reads must not add an ensure IPC before every asset GET");
    pass("desktop path: real host bridge available, no per-asset ensure IPC");
  }
  await writeFile(join(out, "summary.json"), JSON.stringify({ closure, cold, warm, navigation, editor }, null, 2));
  console.log(`verify-asset-loading: ${args.has("all") ? "exhaustive" : "sampled"} tier passed in ${((performance.now() - gateStarted) / 1000).toFixed(1)} s`);
} finally { await context.close(); }
