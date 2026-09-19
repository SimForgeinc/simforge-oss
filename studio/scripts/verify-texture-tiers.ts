/** Real Chromium + real daemon. Run once for low, medium, medium/portable and
 * medium/restricted. Root must be throwaway and daemon port must be 5514–5517.
 * --baseline=true uses main's high preset but still EXPECTS the requested tier:
 * its failures are useful red-gate evidence, not a passing compatibility mode.
 * Optional --inspection-view=<CameraView.json> applies one explicit shared pose
 * AFTER the original readiness/byte/pacing measurements, for1600x1000 raw-canvas
 * comparisons. First-view and inspection evidence remain separately labelled.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import { assertAuthoredDimensions, assertDimensions, assertNoBlackGeometry, assertNoDuplicateFetches, assertReadableSky, assertSameCameraView, browserCapabilityRestriction, Checks, FRAME_P95_MS, isTextureUrl, STABILITY_MS, TEXTURE_BUDGET_BYTES, trafficBeforeReady, type NetworkTransfer, type TierSelection } from './texture-tier-assertions';
import type { SettledTierFrame } from './texture-tier-browser-probe';
import type { CameraView } from '../../packages/viewer/src/camera-controls';

const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const root = args.get('root');
assert(root && !resolve(root).includes('/.local/share/simforge/'), '--root must name a throwaway daemon');
const tier = args.get('tier') ?? 'low';
assert(tier === 'low' || tier === 'medium', 'browser tiers are low or medium; render/ml require verify:native-texture-tiers');
const restriction = args.get('capabilities') ?? 'normal';
assert(['normal', 'portable', 'restricted'].includes(restriction));
const expected = restriction === 'restricted' ? 'low' : tier;
const target = expected === 'low' ? 256 : 512;
let inspectionView: CameraView | undefined;
if (args.get('inspection-view')) {
  const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
  inspectionView = z.object({ position: vector, target: vector, fov: z.number().positive().lt(180) })
    .parse(JSON.parse(await readFile(args.get('inspection-view')!, 'utf8')));
}
const host = JSON.parse(await readFile(join(root, 'host.json'), 'utf8')) as { baseUrl: string; controlToken: string };
const base = new URL(host.baseUrl);
assert(base.hostname === '127.0.0.1' && Number(base.port) >= 5514 && Number(base.port) <= 5517, 'only throwaway loopback ports 5514–5517 are allowed');
const out = resolve(args.get('out') ?? join(root, 'texture-tier-evidence', `${tier}-${restriction}`));
await mkdir(out, { recursive: true });
const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${host.controlToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};
const setup = await fetch(new URL('/api/simforge/host/setup', base), { method: 'PUT', headers: {
  authorization: `Bearer ${host.controlToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'local', quality: args.has('baseline') ? 'high' : tier }) });
if (!setup.ok) throw new Error(`tier setup ${setup.status}: ${await setup.text()}`);
const { maps } = await api<{ maps: { sourceMapId: string; mapVersionId: string; label: string }[] }>('/api/simforge/maps');
const map = maps.find(map => map.sourceMapId === 'belmont-research-center');
assert(map, 'install real Belmont in the throwaway daemon');
const ticket = await api<{ url: string }>('/api/simforge/host/session', { next: args.get('path') ?? '/dashboard/map-assets' });
const bundled = await build({ entryPoints: [join(import.meta.dirname, 'texture-tier-browser-probe.ts')], bundle: true, write: false, format: 'iife', platform: 'browser' });
const browser = await chromium.launch({ executablePath: args.get('chromium') ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
const checks = new Checks();
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript({ content: bundled.outputFiles[0]!.text });
  if (restriction === 'portable' || restriction === 'restricted') {
    await context.addInitScript({ content: browserCapabilityRestriction(restriction) });
  }
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 13, downloadThroughput: -1, uploadThroughput: -1 });
  const requests = new Map<string, NetworkTransfer>();
  let wallOffset = 0;
  const errors: string[] = [];
  cdp.on('Network.requestWillBeSent', event => {
    wallOffset = event.wallTime - event.timestamp;
    requests.set(event.requestId, { url: event.request.url, start: event.timestamp, texture: isTextureUrl(event.request.url), chunks: [] });
  });
  cdp.on('Network.responseReceived', event => {
    const row = requests.get(event.requestId);
    if (row && /^(image\/|application\/(?:ktx|x-ktx))/.test(event.response.mimeType)) row.texture = true;
  });
  cdp.on('Network.dataReceived', event => { requests.get(event.requestId)?.chunks.push({ at: event.timestamp, bytes: event.encodedDataLength }); });
  cdp.on('Network.loadingFinished', event => { const row = requests.get(event.requestId); if (row) { row.finished = event.timestamp; row.bytes = event.encodedDataLength; } });
  cdp.on('Network.loadingFailed', event => { const row = requests.get(event.requestId); if (row) row.failed = event.errorText; });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text()); });
  await page.goto(ticket.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  try {
    await page.waitForFunction(() => window.__tierEvidence || window.__tierProbeError, undefined, { timeout: 180_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      readyAtMs: window.__simforgeViewerProbe?.readyAtMs,
      stats: window.__simforgeViewerProbe?.viewer.getStats(),
      connected: window.__simforgeViewerProbe?.viewer.renderer.domElement.isConnected,
      contextLost: window.__simforgeViewerProbe?.viewer.renderer.getContext().isContextLost(),
      host: document.querySelector('[data-testid="scenario-world-host"]')?.outerHTML.slice(0, 2000),
      probeError: window.__tierProbeError,
    }));
    await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error), state, errors, requests: [...requests.values()] }, null, 2));
    await page.screenshot({ path: join(out, 'failure.png') });
    console.error(`FAIL eligible ready renderer: ${JSON.stringify(state)}`);
    throw error;
  }
  const capture = await page.evaluate(() => ({ evidence: window.__tierEvidence, error: window.__tierProbeError, timeOrigin: performance.timeOrigin,
    mapId: document.querySelector('[data-testid="scenario-world-host"]')?.getAttribute('data-world-loaded-map-version-id') }));
  assert(!capture.error, capture.error);
  assert(capture.evidence, 'no ready-instant evidence');
  const ready = capture.evidence;
  await page.screenshot({ path: join(out, 'ready.png') });
  const stability = await page.evaluate(async (duration: number) => {
    const probe = window.__simforgeViewerProbe!;
    const viewer = probe.viewer;
    const missingAtReady = viewer.getStats().coverage.city?.missingInViewTiles;
    if (missingAtReady === undefined) throw new Error('city coverage missing');
    let maxMissingInViewAfterReady = missingAtReady;
    const frames: number[] = [];
    const glErrors: number[] = [];
    let ineligibleSamples = 0;
    let last = performance.now();
    const deadline = last + duration;
    while (performance.now() < deadline) {
      const frame = Promise.withResolvers<number>();
      requestAnimationFrame(frame.resolve);
      await frame.promise;
      if (window.__simforgeViewerProbe !== probe || !('viable' in probe) || probe.viable !== true) ineligibleSamples++;
      const now = performance.now(); frames.push(now - last); last = now;
      maxMissingInViewAfterReady = Math.max(maxMissingInViewAfterReady, viewer.getStats().coverage.city!.missingInViewTiles);
      const error = viewer.renderer.getContext().getError(); if (error) glErrors.push(error);
    }
    frames.sort((a, b) => a - b);
    return { maxMissingInViewAfterReady, ineligibleSamples, frames: frames.length, p95: frames[Math.ceil(frames.length * 0.95) - 1]!, glErrors };
  }, STABILITY_MS);
  // Freeze all first-view measurements BEFORE resizing or moving the camera.
  const primary = await page.evaluate(() => ({ atMs: performance.now(), view: window.__simforgeViewerProbe!.viewer.captureView() }));
  const primaryNetwork = [...requests.values()];
  const readyCdp = (capture.timeOrigin + ready.readyAtMs) / 1000 - wallOffset;
  const textures = primaryNetwork.filter(row => row.texture).map(row => ({ url: row.url, bytes: row.bytes ?? 0 }));
  const accounting = trafficBeforeReady(primaryNetwork, readyCdp);
  const textureBytesBeforeReady = accounting.textureBytes;
  let inspectionStartedAtMs: number | null = null;
  let inspectionPoseAppliedAtMs: number | null = null;
  let settled: Omit<SettledTierFrame, 'png'> | undefined;
  let settlingError: string | undefined;
  try {
    if (inspectionView) {
      inspectionStartedAtMs = await page.evaluate(() => performance.now());
      const size = await page.evaluate(() => {
        const viewer = window.__simforgeViewerProbe!.viewer;
        return { width: viewer.renderer.domElement.clientWidth, height: viewer.renderer.domElement.clientHeight, ratio: viewer.renderer.getPixelRatio() };
      });
      assert.equal(size.ratio, 1, 'comparison fixture requires identical1x pixel ratio');
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ width: viewport.width + 1600 - size.width, height: viewport.height + 1000 - size.height });
      const actual = await page.evaluate(async view => {
        const viewer = window.__simforgeViewerProbe!.viewer;
        const appliedAtMs = performance.now();
        viewer.setCameraPoseConstraintsEnabled(false);
        viewer.applyView(view);
        const frame = Promise.withResolvers<void>();
        requestAnimationFrame(() => requestAnimationFrame(() => frame.resolve()));
        await frame.promise;
        return { appliedAtMs, view: viewer.captureView(), width: viewer.renderer.domElement.width, height: viewer.renderer.domElement.height };
      }, inspectionView);
      inspectionPoseAppliedAtMs = actual.appliedAtMs;
      assert.equal(actual.width, 1600); assert.equal(actual.height, 1000);
      assertSameCameraView(actual.view, inspectionView);
    }
    const { png, ...measurement } = await page.evaluate(() => window.__captureSettledTierFrame());
    assert(png.startsWith('data:image/png;base64,'), 'settled capture must be a real PNG');
    await writeFile(join(out, 'settled.png'), Buffer.from(png.slice('data:image/png;base64,'.length), 'base64'));
    settled = measurement;
  } catch (error) { settlingError = String(error); }
  const stats = ready.stats as typeof ready.stats & { tierSelection?: TierSelection; mapTextures?: { dimensions: Record<string, number> }; usable?: boolean; targetQualityReady?: boolean };
  checks.check('Belmont fixture at ready', capture.mapId, () => assert.equal(capture.mapId, map.mapVersionId));
  checks.check('actual resident texture dimensions', stats.mapTextures?.dimensions, () => assertDimensions(stats.mapTextures?.dimensions ?? {}, target));
  checks.check('exact resident authored mip invariant', { residentSources: ready.textures.length, target }, () => {
    assertAuthoredDimensions(ready.textures, target);
    const residentHistogram: Record<string, number> = {};
    for (const texture of ready.textures) {
      const key = `${texture.width}x${texture.height}`;
      residentHistogram[key] = (residentHistogram[key] ?? 0) + 1;
    }
    assert.deepEqual(residentHistogram, stats.mapTextures?.dimensions, 'reported dimensions must describe the actual resident sources');
  });
  checks.check('explicit image/3d texture bytes before ready', { ...accounting, budget: TEXTURE_BUDGET_BYTES[expected] }, () => {
    assert(accounting.textureRequests > 0 && textureBytesBeforeReady > 0, 'cold load must observe texture transfer');
    assert(textureBytesBeforeReady <= TEXTURE_BUDGET_BYTES[expected]);
  });
  checks.check('zero repeated container fetches at any cap', { requests: textures.length, distinct: new Set(textures.map(row => row.url)).size }, () => assertNoDuplicateFetches(textures.map(row => ({ url: row.url, bytes: row.bytes ?? 0 }))));
  checks.check('honest readiness at 350m', { atReady: ready.stats.coverage.city?.missingInViewTiles, ...stability }, () => {
    assert.equal(ready.viable, true, 'product must publish a viable ready renderer');
    assert.equal(stability.ineligibleSamples, 0, 'ready renderer became ineligible');
    assert.equal(ready.stats.coverage.city?.missingInViewTiles, 0);
    assert.equal(stability.maxMissingInViewAfterReady, 0);
    assert.equal(stats.usable, true); assert.equal(stats.targetQualityReady, true);
  });
  checks.check('requested and actual tier reported honestly', stats.tierSelection, () => {
    assert(stats.tierSelection); assert.equal(stats.tierSelection.requested, tier); assert.equal(stats.tierSelection.actual, expected);
    assert.equal(stats.tierSelection.longestEdgePx, target);
    if (restriction !== 'normal') { assert.equal(stats.tierSelection.codec, 'uastc'); assert(stats.tierSelection.downgradeReason); }
    assert.equal(stats.tierSelection.variantId, `textures-${target}-${stats.tierSelection.codec}`);
  });
  checks.check('real context restriction and supported codec selection', { ...ready.capabilities, codec: stats.tierSelection?.codec }, () => {
    const capabilities = ready.capabilities;
    if (restriction !== 'normal') {
      assert.equal(capabilities.bc7, false); assert.equal(capabilities.astc, false);
    }
    if (restriction === 'restricted') assert.equal(capabilities.maxTextureSize, 256);
    assert(capabilities.maxTextureSize >= target);
    if (expected === 'low' || (!capabilities.bc7 && !capabilities.astc)) {
      assert.equal(stats.tierSelection?.codec, 'uastc');
    } else {
      assert((stats.tierSelection?.codec === 'bc7' && capabilities.bc7)
        || (stats.tierSelection?.codec === 'astc' && capabilities.astc), 'capable Medium must select an available native block codec');
    }
  });
  checks.check('zero GL and browser errors', { atReady: ready.glError, subsequent: stability.glErrors, errors }, () => { assert.equal(ready.glError, 0); assert.deepEqual(stability.glErrors, []); assert.deepEqual(errors, []); });
  checks.check('settled frame pacing', { p95: stability.p95, boundMs: FRAME_P95_MS, frames: stability.frames }, () => { assert(stability.frames >= 30); assert(stability.p95 <= FRAME_P95_MS); });
  checks.check('ready-instant lit geometry pixels', { visible: ready.visible, ...ready.pixels }, () => {
    assert(ready.visible, 'canvas or ancestor hides the rendered world');
    assert(ready.snapshotAtMs - ready.readyAtMs < 100, 'pixel capture missed ready instant');
    assert(ready.width >= 1280 && ready.height >= 720);
    assert(ready.pixels.colors >= 12); assert(ready.pixels.litGeometrySamples >= 24);
  });
  checks.check('camera outside geometry, not a wall-filling frame', ready.pixels, () => {
    assert(ready.pixels.trianglesExamined > 0);
    assert(Number.isFinite(ready.pixels.nearestSurfaceM) && ready.pixels.nearestSurfaceM >= 1);
    assert(Number.isFinite(ready.pixels.centerDistance) && ready.pixels.centerDistance >= 3);
    assert(ready.pixels.insideFacingHits < ready.pixels.geometryHits / 2, 'majority of visible surfaces face out from the camera enclosure');
  });
  checks.check('settled viewer contains no large near-black region', { frame: settled?.frame, settlingError }, () => {
    assert(settled, settlingError ?? 'no settled frame');
    assertNoBlackGeometry(settled.frame);
    assert.equal(settled.glError, 0);
    assert.equal(settled.missingInViewTiles, 0);
    assert.equal(settled.tierSelection?.actual, expected, 'inspection pose must not silently change the compared tier');
  });
  checks.check('geometry-verified daytime sky is not black', { frame: settled?.frame, skyRegions: settled?.skyRegions, verification: settled?.skyVerification, settlingError }, () => {
    assert(settled, settlingError ?? 'no settled frame');
    assertReadableSky(settled.frame);
  });
  if (inspectionView) checks.check('inspection framing matches the declared shared camera', { requested: inspectionView, actual: settled?.captureView }, () => {
    assert(settled, settlingError ?? 'no settled inspection frame');
    assertSameCameraView(settled.captureView, inspectionView);
    assert.equal(settled.frame.width, 1600); assert.equal(settled.frame.height, 1000);
    assert(inspectionStartedAtMs! >= primary.atMs && inspectionPoseAppliedAtMs! >= inspectionStartedAtMs!);
    assert(settled.capturedAtMs > inspectionPoseAppliedAtMs!);
  });
  const wholeSessionTextures = [...requests.values()].filter(row => row.texture).map(row => ({ url: row.url, bytes: row.bytes ?? 0 }));
  checks.check('whole-session container dedup including inspection', { requests: wholeSessionTextures.length, distinct: new Set(wholeSessionTextures.map(row => row.url)).size }, () => assertNoDuplicateFetches(wholeSessionTextures));
  const phases = { readyAtMs: ready.readyAtMs, readyPixelAtMs: ready.snapshotAtMs, primaryFrozenAtMs: primary.atMs, primaryView: primary.view,
    primaryRequestCount: primaryNetwork.length, inspectionStartedAtMs, inspectionPoseAppliedAtMs };
  await writeFile(join(out, 'results.json'), JSON.stringify({ tier, restriction, inspectionView, phases, ready, stability, settled, settlingError, accounting, textureBytesBeforeReady,
    wholeSessionAccounting: trafficBeforeReady([...requests.values()], Infinity), requests: [...requests.values()], checks: checks.results }, null, 2));
  checks.finish();
} finally { await browser.close(); }
