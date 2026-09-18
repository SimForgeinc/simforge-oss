/**
 * Verify a real installed map through HTTP AND the product's two viewer surfaces.
 * Run against a throwaway daemon on 5470-5490 (never the live installation):
 *   pnpm exec tsx scripts/verify-asset-loading.ts --root=/tmp/host \
 *     --maps-root=/tmp/installed-maps --chromium=/path/to/chrome --out=/tmp/loading
 *
 * The browser starts with a cold client cache and 100 ms latency. A fast file
 * server alone cannot pass: the world must finish at 100%, without rebuilding
 * its renderer on progress updates. No mocked routes, renderer, or reduced LOD.
 *
 * Default: 32 evenly distributed closure members plus both complete viewer
 * loads. --all hashes every recorded member instead; browser assertions and
 * latency are identical in both tiers. Requires hardware-accelerated Chromium.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";

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
const authorization = `Bearer ${host.controlToken}`;
const MAP = "belmont-research-center";
const LATENCY_MS = 100;
const MAX_LOAD_MS = 120_000;
const MIN_CLOSURE_MBPS = 10;
const pass = (message: string) => console.log(`PASS ${message}`);

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, base), { ...init, headers: { authorization, ...init.headers }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

type MapDescriptor = { mapVersionId: string; sourceMapId: string; label: string; browserAssetRootUrl: string };
const { maps: catalog } = await api<{ maps: MapDescriptor[] }>("/api/simforge/maps");
const map = catalog.find((candidate) => candidate.sourceMapId === MAP);
assert(map, `install ${MAP} in the throwaway daemon first`);
// The gallery intentionally starts with the alphabetically first installed map.
assert.equal([...catalog].sort((a, b) => a.label.localeCompare(b.label))[0]?.mapVersionId, map.mapVersionId,
  "this fixture must start the real gallery on Belmont");
const release = JSON.parse(await readFile(join(mapsRoot, "map-bundles", MAP, ".map-release.json"), "utf8")) as {
  members: Record<string, { bytes: number; sha256: string }>;
};
const allMembers = Object.entries(release.members);
assert(allMembers.length >= 32, "the gate requires a real closure, not a tiny fixture");
const members = args.has("all") ? allMembers
  : Array.from({ length: 32 }, (_, index) => allMembers[Math.floor(index * allMembers.length / 32)]!);
await mkdir(out, { recursive: true });

async function verifyClosure() {
  let cursor = 0;
  let bytes = 0;
  let requests = 0;
  let redirects = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < members.length) {
      const [path, member] = members[cursor++]!;
      let url = new URL(`${map!.browserAssetRootUrl}/${path}`, base);
      for (let hop = 0; ; hop++) {
        assert(hop <= 2, `${path}: unexpected redirect chain`);
        const response = await fetch(url, { redirect: "manual", headers: { authorization }, signal: AbortSignal.timeout(30_000) });
        requests++;
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          assert(location, `${path}: redirect without a location`);
          await response.arrayBuffer();
          const target = new URL(location, url);
          assert.equal(target.origin, base.origin, "installed members must stay on this host");
          url = target;
          redirects++;
          continue;
        }
        assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
        assert(response.body, `${path}: missing body`);
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of response.body) { hash.update(chunk); size += chunk.byteLength; }
        assert.equal(size, member.bytes, `${path}: byte count`);
        assert.equal(hash.digest("hex"), member.sha256, `${path}: digest`);
        bytes += size;
        break;
      }
    }
  }));
  const ms = performance.now() - started;
  const MBps = bytes / ms / 1000;
  assert(MBps >= MIN_CLOSURE_MBPS, `closure throughput ${MBps.toFixed(2)} MB/s < ${MIN_CLOSURE_MBPS}`);
  pass(`closure: ${members.length} members, ${bytes} bytes, all sha256/size verified through HTTP`);
  pass(`closure performance: ${MBps.toFixed(2)} MB/s >= ${MIN_CLOSURE_MBPS}; ${ms.toFixed(0)} ms, ${requests} requests, ${redirects} redirects, concurrency 8`);
  return { members: members.length, bytes, ms, MBps, requests, redirects };
}

type NetworkRow = { url: string; start: number; status?: number; ms?: number; bytes?: number; failed?: string; asset: boolean };
type Progress = { at: number; percent: number };
declare global {
  interface Window { __assetLoadingProgress?: Progress[] }
}
async function verifyViewer(browser: Browser, name: string, path: string) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  try {
    const ticket = await api<{ url: string }>("/api/simforge/host/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ next: path }) });
    // The ticket is redeemed by the browser; it receives the same HttpOnly
    // trusted-local cookie as the desktop. Never log the token or ticket.
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1 });
    const network: NetworkRow[] = [];
    const active = new Map<string, NetworkRow>();
    const errors: string[] = [];
    let mounts = 0;
    let peakAssetConcurrency = 0;
    let development = false;
    cdp.on("Network.webSocketCreated", (event) => {
      if (event.url.includes("/_next/webpack-hmr")) development = true;
    });
    cdp.on("Network.requestWillBeSent", (event) => {
      if (event.redirectResponse) {
        const previous = active.get(event.requestId);
        if (previous) { previous.status = event.redirectResponse.status; previous.ms = (event.timestamp - previous.start) * 1000; }
      }
      const url = new URL(event.request.url);
      const row: NetworkRow = { url: url.pathname, start: event.timestamp, asset: /\/(browser-assets|semantic-assets|local-objects|map-cache\/stream)\//.test(url.pathname) };
      network.push(row);
      active.set(event.requestId, row);
      peakAssetConcurrency = Math.max(peakAssetConcurrency, [...active.values()].filter((entry) => entry.asset).length);
    });
    cdp.on("Network.responseReceived", (event) => { const row = active.get(event.requestId); if (row) row.status = event.response.status; });
    cdp.on("Network.loadingFinished", (event) => {
      const row = active.get(event.requestId);
      if (row) { row.ms = (event.timestamp - row.start) * 1000; row.bytes = event.encodedDataLength; }
      active.delete(event.requestId);
    });
    cdp.on("Network.loadingFailed", (event) => {
      const row = active.get(event.requestId);
      if (row) row.failed = event.errorText;
      active.delete(event.requestId);
    });
    page.on("console", (message) => {
      if (message.text().includes("[viewer-diagnostics] mount")) mounts++;
      if (message.type() === "error" && !message.location().url?.endsWith("/favicon.ico")) errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const samples: { at: number; percent: number }[] = [];
      window.__assetLoadingProgress = samples;
      new MutationObserver(() => {
        const raw = document.querySelector('[data-testid="scenario-world-host"]')?.getAttribute("data-world-load-percent");
        if (!raw) return;
        const percent = Number(raw);
        if (samples.at(-1)?.percent !== percent) samples.push({ at: performance.now(), percent });
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-world-load-percent"], childList: true });
    });
    const started = performance.now();
    await page.goto(ticket.url, { waitUntil: "domcontentloaded", timeout: MAX_LOAD_MS });
    let failure: unknown;
    try {
      await page.waitForFunction((id) => {
        const host = document.querySelector('[data-testid="scenario-world-host"]');
        return host?.getAttribute("data-world-loaded-map-version-id") === id && host.getAttribute("data-world-load-percent") === "100";
      }, map!.mapVersionId, { timeout: Math.max(1, MAX_LOAD_MS - (performance.now() - started)) });
      if (name === "editor") await page.getByTestId("scenario-editor-session").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("cloud-loading-surface").waitFor({ state: "hidden", timeout: 10_000 });
    } catch (error) { failure = error; }
    const ms = performance.now() - started;
    const progress = await page.evaluate(() => window.__assetLoadingProgress ?? []);
    const result = { name, ms, latencyMs: LATENCY_MS, mounts, errors, progress, requests: network.length,
      redirects: network.filter((row) => row.status && row.status >= 300 && row.status < 400).length,
      bytes: network.reduce((n, row) => n + (row.bytes ?? 0), 0),
      assetBytes: network.filter((row) => row.asset).reduce((n, row) => n + (row.bytes ?? 0), 0),
      peakAssetConcurrency, network };
    await writeFile(join(out, `${name}.json`), JSON.stringify(result, null, 2));
    await page.screenshot({ path: join(out, `${name}.png`) });
    if (failure) throw failure;
    assert(ms < MAX_LOAD_MS, `${name}: ${ms} ms >= ${MAX_LOAD_MS}`);
    // React development StrictMode probes mount/cleanup once. A real load has
    // one live renderer, not unbounded reconstruction on progress callbacks.
    assert.equal(mounts, development ? 2 : 1, `${name}: renderer constructions (one lifetime${development ? " plus StrictMode probe" : ""})`);
    assert(!errors.some((error) => error.includes("Maximum update depth exceeded")), `${name}: React update loop`);
    assert.deepEqual(errors, [], `${name}: browser errors`);
    assert.equal(progress.at(-1)?.percent, 100, `${name}: terminal progress`);
    assert(progress.every((sample, index) => index === 0 || sample.percent >= progress[index - 1]!.percent), `${name}: progress regressed`);
    assert(peakAssetConcurrency > 1, `${name}: asset loading became serial`);
    pass(`${name}: 100% ready in ${ms.toFixed(0)} ms < ${MAX_LOAD_MS}, cold browser cache + ${LATENCY_MS} ms latency`);
    pass(`${name}: ${mounts} renderer mount(s), monotonic progress ${progress.map((p) => p.percent).join(" -> ")}, 0 non-favicon console errors`);
    pass(`${name}: ${result.requests} requests, ${result.redirects} redirects, ${result.assetBytes} encoded asset bytes, peak asset concurrency ${peakAssetConcurrency}`);
    return result;
  } finally { await context.close(); }
}

await api("/api/simforge/host/setup", { method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ mode: "local", quality: "high" }) });
const closure = await verifyClosure();
const created = await api<{ document: { id: string; datasetId: string } }>(`/api/simforge/maps/${map.mapVersionId}/documents/default`, { method: "POST" });
const browser = await chromium.launch({ executablePath: args.get("chromium") ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  headless: true, args: ["--no-sandbox", "--use-gl=angle", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface"] });
try {
  const gallery = await verifyViewer(browser, "gallery", "/dashboard/map-assets");
  const query = new URLSearchParams({ dataset: created.document.datasetId, document: created.document.id });
  const editor = await verifyViewer(browser, "editor", `/dashboard/scenario?${query}`);
  await writeFile(join(out, "summary.json"), JSON.stringify({ closure, gallery, editor }, null, 2));
  console.log(`verify-asset-loading: ${args.has("all") ? "exhaustive" : "sampled"} closure and both real viewer surfaces passed in ${((performance.now() - gateStarted) / 1000).toFixed(1)} s`);
} finally { await browser.close(); }
