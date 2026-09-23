import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type {} from "../../packages/viewer/src/viewer-diagnostics";
import { hostUrl } from "./host-url";

type Descriptor = { mapVersionId: string; sourceMapId: string; label: string; browserAssetRootUrl: string };
type RequestRow = { url: string; bytes: number; bodyBytes: number; status?: number; at: number };
type Lifetime = { mounts: number; disposals: number; loads: number; created: number; live: number; worldContexts: number; wrongMapFrames: number };
declare global { interface Window { __worldNavigation: () => Lifetime } }

/** Observe real paint after two natural render frames, never suspend/hide the
 * canvas to capture it. The geometry check also rejects an inherited tour pose
 * buried below a building roof, even when its close-up has textured pixels. */
export async function assertWorldPaint(page: Page) {
  const sample = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const host = document.querySelector('[data-testid="scenario-world-host"]');
    const canvas = host?.querySelector<HTMLCanvasElement>('canvas');
    if (!canvas?.isConnected || host?.getAttribute('data-world-load-percent') !== '100'
      || !host.getAttribute('data-world-loaded-map-version-id')) {
      throw new Error("The ready world has no connected, map-bound canvas");
    }
    let visible = canvas.width > 0 && canvas.height > 0 && canvas.getBoundingClientRect().height > 0;
    for (let node: HTMLElement | null = canvas; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) visible = false;
    }
    const probe = document.createElement("canvas");
    probe.width = 32;
    probe.height = 24;
    const context = probe.getContext("2d")!;
    context.drawImage(canvas, 0, 0, 32, 24);
    const pixels = context.getImageData(0, 0, 32, 24).data;
    let sum = 0, squares = 0, lit = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const value = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
      sum += value;
      squares += value * value;
      if (value > 35 && pixels[i + 3]! > 0) lit++;
    }
    // Bind the published viability contract to THIS visible canvas. React hook
    // internals are not a lifetime API and change when ownership is retained.
    const diagnostics = window.__simforgeViewerProbe;
    if (!diagnostics || diagnostics.viewer.renderer.domElement !== canvas || !('viable' in diagnostics) || diagnostics.viable !== true) {
      throw new Error("The ready world has no viable renderer diagnostics");
    }
    const viewer = diagnostics.viewer;
    const position = viewer.camera.getWorldPosition(viewer.camera.position.clone());
    const surfaceY = viewer.sampleGroundHeight(position.x, position.z);
    const count = pixels.length / 4;
    return {
      visible, litFraction: lit / count,
      luminanceStdDev: Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2)),
      cameraClearanceM: surfaceY === null ? null : position.y - surfaceY,
    };
  });
  assert(sample.cameraClearanceM === null || sample.cameraClearanceM > 1,
    `ready camera must not be buried in rendered geometry: ${JSON.stringify(sample)}`);
  assert(sample.visible && sample.litFraction > 0.05 && sample.luminanceStdDev > 8,
    `ready world must visibly paint geometry, not a blank frame: ${JSON.stringify(sample)}`);
  return sample;
}

async function ready(page: Page, id: string, editor = false) {
  // Cached Activity trees retain ready attributes while a destination is still
  // in Suspense. Bind readiness to the visible destination, not the old host.
  if (editor) await page.getByTestId("scenario-editor-session").waitFor({ state: "visible", timeout: 120_000 });
  else await page.getByTestId("map-gallery-editorial-overlay").waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(({ id, editor }) => {
    const world = document.querySelector('[data-testid="scenario-world-host"]');
    return world?.getAttribute("data-world-loaded-map-version-id") === id
      && world.getAttribute("data-world-load-percent") === "100"
      && (!editor || document.querySelector('[data-testid="scenario-editor-session"]')?.getAttribute("data-editor-ready") === "true");
  }, { id, editor }, { timeout: 120_000 });
  await page.locator('[data-testid="cloud-loading-surface"][data-cloud-loading-scope="screen"]').waitFor({ state: "hidden", timeout: 10_000 });
  const paint = await assertWorldPaint(page);
  console.log(`PASS ready world pixels: ${JSON.stringify(paint)}`);
}

/** Real route/DOM ownership, not a hook mock: moving the provider below a page
 * boundary must fail even if HTTP caching makes the reload appear inexpensive. */
export async function verifyWorldNavigation({ context, ticketUrl, map, other, out, latencyMs, scope = "full" }: {
  context: BrowserContext;
  ticketUrl: string;
  map: Descriptor;
  other: Descriptor;
  out: string;
  latencyMs: number;
  /** Same-map still includes all five editor/list release cycles; only the different-map leg is omitted. */
  scope?: "full" | "same-map";
}) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const browserCdp = await context.browser()!.newBrowserCDPSession();
  const gpu = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo.find((process) => process.type === "GPU");
  const gpuMemoryMiB = () => {
    try {
      const xml = execFileSync("nvidia-smi", ["-q", "-x"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const process = [...xml.matchAll(/<process_info>([\s\S]*?)<\/process_info>/g)].find((match) =>
        Number(match[1]?.match(/<pid>(\d+)<\/pid>/)?.[1]) === gpu?.id);
      return Number(process?.[1]?.match(/<used_memory>(\d+) MiB<\/used_memory>/)?.[1]) || null;
    } catch { return null; }
  };
  const rows: RequestRow[] = [];
  const requests = new Map<string, RequestRow>();
  const errors: string[] = [];
  await page.addInitScript({ content: `
    const contexts=[];const seen=new WeakSet();let mounts=0,disposals=0,loads=0,wrongMapFrames=0;
    const get=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(...args){const gl=get.apply(this,args);if(gl&&/^(webgl|experimental-webgl)/.test(args[0])&&!seen.has(gl)){seen.add(gl);contexts.push({gl:new WeakRef(gl),world:!!this.closest('[data-testid="scenario-world-host"]')});}return gl;};
    const info=console.info;console.info=function(...args){const text=args.map(String).join(' ');if(text.includes('[viewer-diagnostics] mount'))mounts++;if(text.includes('[city-renderer] cityviewer.disposed'))disposals++;if(text.includes('[viewer-diagnostics] map-loaded'))loads++;info.apply(this,args);};
    window.__worldNavigation=()=>{const live=contexts.filter(c=>{const gl=c.gl.deref();return gl&&!gl.isContextLost()});return {mounts,disposals,loads,created:contexts.length,live:live.length,worldContexts:live.filter(c=>c.world).length,wrongMapFrames};};
    const frame=()=>{const host=document.querySelector('[data-testid="scenario-world-host"]');let canvas=host?.querySelector('canvas');if(canvas&&host.getAttribute('data-world-loaded-map-version-id')!==host.getAttribute('data-world-map-version-id')){let visible=true;for(let node=canvas;node;node=node.parentElement){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0){visible=false;break;}}if(visible)wrongMapFrames++;}requestAnimationFrame(frame)};requestAnimationFrame(frame);
  ` });
  page.on("pageerror", (error) => errors.push(error.message));
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: latencyMs, downloadThroughput: -1, uploadThroughput: -1 });
  cdp.on("Network.requestWillBeSent", (event) => {
    const url = new URL(event.request.url);
    if (!/\/(browser-assets|semantic-assets|local-objects|map-cache\/stream)\//.test(url.pathname)) return;
    const row = { url: url.pathname, bytes: 0, bodyBytes: 0, at: event.timestamp };
    rows.push(row);
    requests.set(event.requestId, row);
  });
  cdp.on("Network.responseReceived", (event) => { const row = requests.get(event.requestId); if (row) row.status = event.response.status; });
  cdp.on("Network.dataReceived", (event) => { const row = requests.get(event.requestId); if (row) row.bodyBytes += event.encodedDataLength; });
  cdp.on("Network.loadingFinished", (event) => { const row = requests.get(event.requestId); if (row) row.bytes = event.encodedDataLength; });
  const samples: unknown[] = [];
  try {
    await page.goto(ticketUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await ready(page, map.mapVersionId);
    await page.waitForTimeout(1500);
    const initial = await page.evaluate(() => window.__worldNavigation());
    assert.equal(initial.mounts, 1, "one city renderer for the gallery's genuine map load");
    assert.equal(initial.worldContexts, 1);
    const held = new Set(rows.map((row) => row.url));
    const boundary = rows.length;
    const click = performance.now();
    await page.getByRole("button", { name: "Create scenario", exact: true }).click();
    await page.waitForURL("**/dashboard/scenario?**");
    await ready(page, map.mapVersionId, true);
    const first = await page.evaluate(() => window.__worldNavigation());
    const repeated = rows.slice(boundary).filter((row) => held.has(row.url));
    const heldMemberBytes = repeated.reduce((n, row) => n + row.bodyBytes, 0);
    assert.deepEqual(repeated, [], "same-map navigation must not issue ANY GET for a member already read by the gallery");
    assert.equal(first.mounts, initial.mounts);
    assert.equal(first.created, initial.created, "same-map navigation must create no WebGL context, including hidden coverage/loading renderers");
    assert.equal(first.loads, initial.loads);
    assert.equal(first.disposals, initial.disposals);
    const firstUse = rows.slice(boundary);
    const firstResult = { clickToReadyMs: performance.now() - click, rendererConstructions: 0, contextsCreated: 0, mapLoads: 0,
      heldMemberRequests: repeated.length, heldMemberBytes,
      firstUseRequests: firstUse.length, firstUseBodyBytes: firstUse.reduce((n, row) => n + row.bodyBytes, 0) };
    samples.push(firstResult);
    console.log(`PASS same-map gallery -> editor: ${JSON.stringify(firstResult)}`);
    await page.screenshot({ path: join(out, "same-map-transition.png") });

    // Back/forward is real App Router navigation, including its cached/hidden
    // route tree. It catches a late outgoing lease cleanup detaching a new one.
    for (let cycle = 1; cycle <= 5; cycle++) {
      const start = rows.length;
      await page.goBack();
      await ready(page, map.mapVersionId);
      await page.goForward();
      await ready(page, map.mapVersionId, true);
      await cdp.send("HeapProfiler.collectGarbage");
      const lifetime = await page.evaluate(() => window.__worldNavigation());
      assert.equal(lifetime.mounts, 1);
      assert.equal(lifetime.created, initial.created);
      assert.equal(lifetime.loads, 1);
      assert.equal(lifetime.worldContexts, 1);
      assert.equal(lifetime.live, 1, "only the city context remains, not hidden maps or clouds");
      assert.deepEqual(rows.slice(start).filter((row) => held.has(row.url)), []);
      const heap = await cdp.send("Runtime.getHeapUsage");
      const vramMiB = gpuMemoryMiB();
      samples.push({ navigationCycle: cycle, ...lifetime, heap, vramMiB });
      console.log(`PASS same-map route cycle ${cycle}: 1 live WebGL context, 1 renderer lifetime, 0 retained-member requests; heap=${heap.usedSize}, GPU=${vramMiB ?? "unavailable"} MiB`);
    }

    const documentId = new URL(page.url()).searchParams.get("document");
    assert(documentId);
    for (let cycle = 1; cycle <= 5; cycle++) {
      const exit = performance.now();
      await page.getByRole("button", { name: "Exit editor", exact: true }).click();
      await page.getByTestId("scenario-list-session").waitFor({ state: "visible", timeout: 4000 });
      await page.getByTestId("scenario-coverage-map").waitFor({ state: "visible", timeout: 4000 });
      await page.waitForFunction(() => {
        const life = window.__worldNavigation();
        return life.mounts === life.disposals && life.worldContexts === 0
          && !document.querySelector('[data-testid="scenario-editor-transition-cover"]');
      }, null, { timeout: 4000 });
      const exitMs = performance.now() - exit;
      assert(exitMs < 4000, "leaving the editor must not wait on a camera/network callback");
      const card = page.locator(`[data-document-id="${documentId}"]`);
      await card.getByRole("button", { name: /^Edit / }).click();
      const enter = performance.now();
      await ready(page, map.mapVersionId, true);
      const lifetime = await page.evaluate(() => window.__worldNavigation());
      assert.equal(lifetime.mounts - lifetime.disposals, 1);
      assert.equal(lifetime.worldContexts, 1);
      assert.equal(lifetime.loads, lifetime.mounts, "exactly one load per renderer after explicit list releases");
      samples.push({ editorCycle: cycle, exitMs, enterMs: performance.now() - enter, ...lifetime });
      console.log(`PASS editor/list cycle ${cycle}: exit ${exitMs.toFixed(0)} ms < 4000; no retained city context on list; one renderer on re-entry`);
    }

    if (scope === "same-map") {
      assert.equal((await page.evaluate(() => window.__worldNavigation())).wrongMapFrames, 0, "same-map navigation must never expose the wrong world");
      assert.deepEqual(errors, []);
      const skipped = [{ leg: "different-map", reason: "explicit same-map scope; all editor/list and retained navigation assertions ran" }];
      await writeFile(join(out, "world-navigation.json"), JSON.stringify({ scope, documentId, initial, firstResult, samples, rows, errors, skipped }, null, 2));
      console.log(`SKIP different-map: explicitly selected same-map scope`);
      return firstResult;
    }

    // Start the different-map case independently of the editor's replaceState
    // history edits. The same-route lifetime was asserted above, before reload.
    await page.goto(hostUrl(ticketUrl, "/dashboard/map-assets").href, { waitUntil: "domcontentloaded" });
    await ready(page, map.mapVersionId);
    const differentBoundary = rows.length;
    const mounts = (await page.evaluate(() => window.__worldNavigation())).mounts;
    await page.getByRole("button", { name: "Choose a map", exact: true }).click();
    await page.getByRole("textbox", { name: "Search maps", exact: true }).fill(other.label);
    await page.getByRole("button", { name: "Select Map", exact: true }).click();
    await ready(page, other.mapVersionId);
    const changed = await page.evaluate(() => window.__worldNavigation());
    assert.equal(changed.mounts, mounts, "a different map loads through the same viewer");
    assert(rows.slice(differentBoundary).some((row) => row.url.startsWith(other.browserAssetRootUrl) && row.bodyBytes > 0), "the different map must genuinely load its own closure");
    assert.equal(changed.wrongMapFrames, 0, "no frame may expose the previous map under a different target");
    assert.deepEqual(errors, []);
    console.log(`PASS different map: ${other.label} ready; its closure loaded through the existing renderer`);
    await writeFile(join(out, "world-navigation.json"), JSON.stringify({ documentId, initial, firstResult, samples, changed, rows, errors }, null, 2));
    return firstResult;
  } catch (error) {
    const state = await page.evaluate(() => ({
      lifetime: window.__worldNavigation?.() ?? null,
      url: location.href,
      hosts: [...document.querySelectorAll('[data-testid="scenario-world-host"]')].map(host => ({
        loadedMap: host.getAttribute("data-world-loaded-map-version-id"), percent: host.getAttribute("data-world-load-percent"),
        canvasConnected: Boolean(host.querySelector("canvas")?.isConnected),
      })),
      body: document.body.innerText.slice(0, 2000),
    })).catch(() => null);
    await writeFile(join(out, "world-navigation-failure.json"), JSON.stringify({ scope, latencyMs, error: String(error), state, samples, rows, errors }, null, 2));
    await page.screenshot({ path: join(out, "world-navigation-failure.png") }).catch(() => undefined);
    throw error;
  } finally { await page.close(); }
}
