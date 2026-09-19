/** Production integration gate for the real drive Pause -> Leave -> history.back path.
 * Vendored ONCE from TierGen's replay-activity.mjs (2026-09-19); this committed
 * script replaces that throwaway replay as the maintained implementation.
 * The root must already contain a prepared scenario and completed onboarding.
 * pnpm verify:drive-activity --root=<throwaway-root> --port=<authorized-port>
 *   --drive-path='/dashboard/drive/<scenario>?actor=ego' --out=<evidence-directory>
 * Optional --cdp=<authorized-loopback-CDP-url> borrows a browser connection;
 * only this gate's new browser context is driven. Never modifies daemon setup,
 * scenarios, maps, or another agent's processes. Production builds only.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { Checks } from './texture-tier-assertions';
import type { CityViewer } from '../../packages/viewer/src/viewer';
import type {} from '../../packages/viewer/src/viewer-diagnostics';
import type { CityViewerStats } from '../../packages/viewer/src/types';

type GL = WebGLRenderingContext | WebGL2RenderingContext;
interface ContextObservation { canvas: HTMLCanvasElement; gl: GL; stage: string; lost: boolean }
interface HeldViewer { viewer: CityViewer; canvas: HTMLCanvasElement; gl: GL }
interface ActivityPaint {
  href: string;
  canvasPresent: boolean;
  visible: boolean;
  contextLost: boolean | null;
  sameCanvas: boolean | null;
  sharedContext: boolean | null;
  programs: number;
  drawCalls: number;
  litFraction: number;
  litPixel: number[] | null;
  pixel: number[];
  probeViable: boolean | null;
  crashBoundary: boolean;
  body: string;
  stats: CityViewerStats | null;
}
declare global {
  interface Window {
    __activityStage: string;
    __activityContexts: ContextObservation[];
    __activityFirst?: HeldViewer;
  }
}
const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const root = args.get('root');
const drivePath = args.get('drive-path');
const outArg = args.get('out');
const port = Number(args.get('port'));
assert(root && drivePath && outArg && Number.isInteger(port), '--root, --port, --drive-path and --out are required');
assert(!resolve(root).includes('/.local/share/simforge/'), 'never attach this gate to a user data root');
assert(port >= 1024 && ![5199, 5421, 5455, 8443].includes(port), 'reserved/live port forbidden');
const host = JSON.parse(await readFile(join(root, 'host.json'), 'utf8')) as { baseUrl: string; controlToken: string };
const base = new URL(host.baseUrl);
assert(base.hostname === '127.0.0.1' && Number(base.port) === port, 'host.json must match the explicitly authorized loopback port');
const route = new URL(drivePath, base);
assert(route.origin === base.origin && /^\/dashboard\/drive\/[^/]+$/.test(route.pathname), '--drive-path must name the real drive route');
const out = resolve(outArg);
assert(!out.startsWith(`${resolve(root)}/`), 'keep borrowed-fixture evidence outside its daemon root');
await mkdir(out, { recursive: true });
const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${host.controlToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};
const setup = await api<{ completedAt: string | null }>('/api/simforge/host/setup');
assert(setup.completedAt, 'fixture owner must complete onboarding before this read-only replay');
const ticket = await api<{ url: string }>('/api/simforge/host/session', { next: route.pathname + route.search });
const cdpEndpoint = args.get('cdp');
if (cdpEndpoint) {
  const cdpUrl = new URL(cdpEndpoint);
  assert(cdpUrl.hostname === '127.0.0.1' && Number(cdpUrl.port) >= 1024 && ![5199, 5421, 5455, 8443].includes(Number(cdpUrl.port)), 'CDP must be an explicitly supplied non-live loopback endpoint');
}
const browser = cdpEndpoint
  ? await chromium.connectOverCDP(cdpEndpoint, { timeout: 10_000 })
  : await chromium.launch({ headless: true, executablePath: args.get('chromium') ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const checks = new Checks();
const errors: string[] = [];
const errorEvents: { stage: string; atMs: number; message: string }[] = [];
let stage = 'initial-load';
const recordError = (message: string) => {
  errors.push(message);
  errorEvents.push({ stage, atMs: performance.now(), message });
};
const developmentSignals: string[] = [];
const cycles: unknown[] = [];
let before: ActivityPaint | undefined;

async function paint(page: Page): Promise<ActivityPaint> {
  return page.evaluate(async () => {
    const frame = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => frame.resolve()));
    await frame.promise;
    const probe = window.__simforgeViewerProbe;
    const viewer = probe?.viewer;
    // Never use the retained OLD canvas as a substitute for a missing restored
    // viewer. The crash boundary removes the canvas entirely: that must fail.
    const canvas = viewer?.renderer.domElement;
    const connected = Boolean(canvas?.isConnected);
    let visible = connected && Boolean(canvas && canvas.width > 0 && canvas.height > 0 && canvas.getBoundingClientRect().height > 0);
    for (let element: HTMLElement | null = canvas ?? null; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) visible = false;
    }
    const sample = document.createElement('canvas'); sample.width = 32; sample.height = 24;
    const twoD = sample.getContext('2d')!;
    if (canvas && connected) twoD.drawImage(canvas, 0, 0, 32, 24);
    const bytes = twoD.getImageData(0, 0, 32, 24).data;
    let lit = 0;
    let litPixel: number[] | null = null;
    for (let i = 0; i < bytes.length; i += 4) {
      if (bytes[i]! + bytes[i + 1]! + bytes[i + 2]! > 105 && bytes[i + 3]! > 0) {
        lit++; litPixel ??= [...bytes.slice(i, i + 4)];
      }
    }
    const first = window.__activityFirst;
    const gl = viewer?.renderer.getContext();
    const body = document.body.innerText;
    return { href: location.href, canvasPresent: connected, visible, contextLost: gl?.isContextLost() ?? null,
      sameCanvas: first ? canvas === first.canvas : null, sharedContext: first ? gl === first.gl : null,
      programs: viewer?.renderer.info.programs?.length ?? 0, drawCalls: viewer?.getStats().drawCalls ?? 0,
      litFraction: lit / 768, litPixel, pixel: [...bytes.slice(0, 4)],
      probeViable: probe && 'viable' in probe && typeof probe.viable === 'boolean' ? probe.viable : null,
      crashBoundary: body.includes('Something went wrong'), body: body.slice(0, 2000), stats: viewer?.getStats() ?? null };
  });
}

try {
  const page = await context.newPage();
  page.on('pageerror', error => recordError(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) recordError(message.text()); });
  page.on('request', request => { if (/react-refresh|webpack-hmr|\/_next\/static\/development\//.test(request.url())) developmentSignals.push(request.url()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', event => { if (/webpack-hmr|react-refresh/.test(event.url)) developmentSignals.push(event.url); });
  await page.addInitScript({ content: `window.__activityStage='before';window.__activityContexts=[];
    const original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(...args){const gl=original.apply(this,args);
      if(gl&&/^webgl/.test(args[0]))window.__activityContexts.push({canvas:this,gl,stage:window.__activityStage,lost:gl.isContextLost()});return gl};` });
  await page.goto(ticket.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => {
    const viewer = window.__simforgeViewerProbe?.viewer;
    return document.body.innerText.includes('Something went wrong') || Boolean(viewer && viewer.renderer.domElement.isConnected && viewer.getStats().requiredPendingAssets === 0 && viewer.getStats().drawCalls > 0);
  }, undefined, { timeout: 180_000 });
  const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src') ?? ''));
  checks.check('real drive replay runs production assets only', { developmentSignals, scripts }, () => {
    assert.deepEqual(developmentSignals, []);
    assert(scripts.some(src => /\/_next\/static\/chunks\/(?:[^/?]*[-.])?[a-f0-9]{8,}\.js(?:\?|$)/i.test(src)), 'no content-hashed production JavaScript observed');
  });
  before = await paint(page);
  checks.check('before: healthy visible drive with lit pixels', {
    canvasPresent: before.canvasPresent, visible: before.visible, contextLost: before.contextLost,
    programs: before.programs, litFraction: before.litFraction, litPixel: before.litPixel,
    crashBoundary: before.crashBoundary,
  }, () => {
    assert(before);
    const sample = before;
    assert(!sample.crashBoundary && sample.canvasPresent && sample.visible, 'healthy drive canvas is required; missing canvas is not a skip');
    assert.equal(sample.contextLost, false); assert(sample.programs > 0);
    assert(sample.litFraction > 0.05 && sample.litPixel, 'at least5% of samples must contain opaque lit pixels');
  });
  await page.screenshot({ path: join(out, 'before.png') });
  if (!before.canvasPresent) throw new Error('Initial drive route has no canvas');
  for (let cycle = 1; cycle <= 2; cycle++) {
    stage = `cycle${cycle}/pause`;
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Leave the drive', exact: true }).waitFor({ timeout: 10_000 });
    await page.evaluate(() => {
      const viewer = window.__simforgeViewerProbe!.viewer;
      window.__activityFirst = { viewer, canvas: viewer.renderer.domElement, gl: viewer.renderer.getContext() };
      window.__activityStage = 'away';
    });
    stage = `cycle${cycle}/away`;
    await page.getByRole('button', { name: 'Leave the drive', exact: true }).click();
    await page.waitForURL('**/dashboard/scenario?**', { timeout: 30_000 });
    // Let deferred cleanup run while React Activity keeps its DOM connected.
    await page.waitForTimeout(250);
    const away = await page.evaluate(() => ({ href: location.href, canvasConnected: window.__activityFirst!.canvas.isConnected,
      contextLost: window.__activityFirst!.gl.isContextLost(), probe: Boolean(window.__simforgeViewerProbe) }));
    checks.check(`cycle${cycle}/away: connected Activity canvas retains its context`, away, () => {
      assert(away.canvasConnected, 'fixture must exercise retained DOM, not a synthetic unmount');
      assert.equal(away.contextLost, false, 'silent context loss occurred while away');
    });
    stage = `cycle${cycle}/back`;
    await page.evaluate(() => { window.__activityStage = 'back'; });
    const resumeStarted = performance.now();
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const viewer = window.__simforgeViewerProbe?.viewer;
      return document.body.innerText.includes('Something went wrong') || Boolean(viewer && viewer.renderer.domElement.isConnected && viewer.getStats().drawCalls > 0 && viewer.getStats().requiredPendingAssets === 0);
    }, undefined, { timeout: 180_000 });
    const back = await paint(page);
    const resumeToObservationMs = performance.now() - resumeStarted;
    await page.screenshot({ path: join(out, `back-${cycle}.png`) });
    cycles.push({ cycle, away, back, resumeToObservationMs });
    checks.check(`cycle${cycle}/back: no crash boundary and a viable restored canvas`, {
      canvasPresent: back.canvasPresent, visible: back.visible, contextLost: back.contextLost,
      probeViable: back.probeViable, sameCanvas: back.sameCanvas, sharedContext: back.sharedContext,
      programs: back.programs, crashBoundary: back.crashBoundary,
      resumeToObservationMs,
    }, () => {
      assert.equal(back.crashBoundary, false, back.body);
      assert(back.canvasPresent && back.visible, 'missing/hidden restored canvas is a FAILURE');
      assert.equal(back.probeViable, true); assert.equal(back.contextLost, false);
      assert.equal(back.sameCanvas, true); assert.equal(back.sharedContext, true);
      assert(back.programs > 0);
    });
    checks.check(`cycle${cycle}/back: actual lit pixels restored`, { fraction: back.litFraction, litPixel: back.litPixel, pixel: back.pixel }, () => {
      assert(back.litFraction > 0.05 && back.litPixel, 'program/context counters do not substitute for lit pixels');
    });
    if (back.crashBoundary || !back.canvasPresent) break;
  }
  checks.check('two consecutive real away/back cycles completed', { completed: cycles.length }, () => assert.equal(cycles.length, 2));
  checks.check('production drive navigation emits no runtime errors', { count: errors.length, messages: errors.map(error => error.split('\n')[0]) }, () => assert.equal(errors.length, 0));
  await writeFile(join(out, 'result.json'), JSON.stringify({ root, port, drivePath, before, cycles, errors, errorEvents, checks: checks.results }, null, 2));
  checks.finish();
} catch (error) {
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error), before, cycles, errors, errorEvents, checks: checks.results }, null, 2));
  console.error(`FAIL production drive Activity replay: ${String(error)}`);
  throw error;
} finally {
  await context.close();
  // For connectOverCDP this disconnects OUR client; the borrowed browser stays up.
  await browser.close();
}
