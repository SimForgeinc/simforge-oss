#!/usr/bin/env node
/**
 * Measure the three user-facing Studio surfaces with one cold and one warm
 * cache pass. Instrumentation lives in the page so the numbers describe what
 * the browser executed, not a synthetic server request benchmark.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { machineState, numberArg, parseArgs, requireArg, sha256, summarize, writeJson } from './lib/common.mjs';

const INSTRUMENTATION = String.raw`(() => {
  const state = {
    navigationStart: performance.timeOrigin,
    firstWorldFrameMs: null,
    drawCalls: 0,
    textureUploads: 0,
    textureUploadBytes: 0,
    longTasks: [],
    rafTimes: [],
    stopped: false,
  };
  const canvasContexts = new WeakMap();
  const canvasFor = (context) => context?.canvas ?? null;
  const markDraw = function () {
    state.drawCalls += 1;
    const canvas = canvasFor(this);
    if (state.firstWorldFrameMs === null && canvas?.closest('[data-testid="scenario-world-host"]')) state.firstWorldFrameMs = performance.now();
  };
  const markTexture = function (...args) {
    state.textureUploads += 1;
    const candidate = args.find((value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value));
    if (candidate) state.textureUploadBytes += candidate.byteLength;
    else {
      const numbers = args.filter((value) => Number.isFinite(value));
      if (numbers.length >= 2) state.textureUploadBytes += Math.max(0, numbers.at(-1) * numbers.at(-2) * 4);
    }
  };
  const patch = (prototype, name, callback) => {
    if (!prototype || typeof prototype[name] !== 'function') return;
    const original = prototype[name];
    if (original.__simforgeBenchmarkWrapped) return;
    const wrapped = function (...args) { callback.apply(this, args); return original.apply(this, args); };
    wrapped.__simforgeBenchmarkWrapped = true;
    prototype[name] = wrapped;
  };
  const patchContext = (context) => {
    if (!context || canvasContexts.has(context)) return;
    canvasContexts.set(context, true);
    const proto = Object.getPrototypeOf(context);
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) patch(proto, name, markDraw);
    for (const name of ['texImage2D', 'texSubImage2D', 'compressedTexImage2D', 'compressedTexSubImage2D']) patch(proto, name, markTexture);
  };
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const context = originalGetContext.apply(this, args);
    patchContext(context);
    return context;
  };
  for (const canvas of document.querySelectorAll('canvas')) for (const type of ['webgl2', 'webgl']) { try { patchContext(canvas.getContext(type)); } catch {} }
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true });
  } catch {}
  let last = performance.now();
  const frame = (now) => {
    if (state.stopped) return;
    state.rafTimes.push(now - last);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__simforgeBenchmark = {
    stop() {
      state.stopped = true;
      const resources = performance.getEntriesByType('resource').map((entry) => ({
        name: entry.name, initiatorType: entry.initiatorType, transferSize: entry.transferSize || 0,
        decodedBodySize: entry.decodedBodySize || 0, encodedBodySize: entry.encodedBodySize || 0,
        startTime: entry.startTime, duration: entry.duration,
      }));
      const scriptResources = resources.filter((entry) => entry.initiatorType === 'script' || /\.m?js(?:[?#]|$)/i.test(entry.name));
      const domReferences = [...document.querySelectorAll('[src],[href]')].flatMap((node) => [node.getAttribute('src'), node.getAttribute('href')]).filter(Boolean).map((value) => { try { return new URL(value, location.href).href; } catch { return value; } });
      const assetResources = resources.filter((entry) => ['img', 'image', 'font', 'media', 'fetch', 'xmlhttprequest'].includes(entry.initiatorType));
      const duplicateCounts = {};
      for (const entry of resources) duplicateCounts[entry.name] = (duplicateCounts[entry.name] || 0) + 1;
      return {
        navigation: performance.getEntriesByType('navigation').at(-1) ?? null,
        firstWorldFrameMs: state.firstWorldFrameMs,
        drawCalls: state.drawCalls,
        textureUploads: state.textureUploads,
        textureUploadBytes: state.textureUploadBytes,
        longTasks: state.longTasks,
        rafTimes: state.rafTimes.filter((value) => Number.isFinite(value) && value > 0),
        resources,
        requests: resources.length,
        networkBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
        assetsFetchedBeforeInteractive: assetResources.filter((entry) => entry.startTime < (performance.getEntriesByType('navigation').at(-1)?.domInteractive ?? Infinity)).length,
        unusedAssetBytes: assetResources.filter((entry) => !domReferences.includes(entry.name)).reduce((sum, entry) => sum + entry.transferSize, 0),
        duplicateFetches: Object.entries(duplicateCounts).filter(([, count]) => count > 1).map(([name, count]) => ({ name, count })),
        jsBytesShipped: scriptResources.reduce((sum, entry) => sum + entry.transferSize, 0),
        // A loaded script has executed before load; decoded bytes are the execution accounting unit.
        jsBytesExecuted: scriptResources.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
        ttiMs: performance.getEntriesByType('navigation').at(-1)?.domInteractive ?? null,
        domContentLoadedMs: performance.getEntriesByType('navigation').at(-1)?.domContentLoadedEventEnd ?? null,
        loadEventMs: performance.getEntriesByType('navigation').at(-1)?.loadEventEnd ?? null,
      };
    },
  };
})();`;

const ROUTES = ['/dashboard/map-assets', '/dashboard/scenario', '/dashboard/simcloud'];

async function hostTicket(baseUrl, dataRoot, next) {
  const host = JSON.parse(await readFile(path.join(dataRoot, 'host.json'), 'utf8'));
  const response = await fetch(`${baseUrl}/api/simforge/host/session`, {
    method: 'POST', headers: { authorization: `Bearer ${host.controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ next }),
  });
  if (!response.ok) throw new Error(`host session failed ${response.status}: ${await response.text()}`);
  const value = await response.json();
  if (!value.url) throw new Error('host session response did not contain a one-use URL');
  return value.url;
}

async function visit(context, baseUrl, dataRoot, route, cacheKind, settleMs) {
  const page = await context.newPage();
  await page.addInitScript({ content: INSTRUMENTATION });
  const started = Date.now();
  const url = await hostTicket(baseUrl, dataRoot, route);
  let error = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForTimeout(settleMs);
  } catch (caught) { error = String(caught?.stack ?? caught); }
  const metrics = await page.evaluate(() => window.__simforgeBenchmark?.stop?.() ?? null).catch(() => null);
  await page.close();
  const frameSummary = summarize(metrics?.rafTimes ?? []);
  return {
    route, surface: route.split('/').filter(Boolean).at(-1), cacheKind, wallMs: Date.now() - started,
    error, metrics: metrics ? {
      ...metrics, frameTime: frameSummary,
      jsExecutionRatio: metrics.jsBytesShipped ? metrics.jsBytesExecuted / metrics.jsBytesShipped : null,
      duplicateFetchCount: metrics.duplicateFetches.reduce((sum, item) => sum + item.count - 1, 0),
      longTaskCount: metrics.longTasks.length,
      longTaskTotalMs: metrics.longTasks.reduce((sum, item) => sum + item.duration, 0),
    } : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataRoot = path.resolve(requireArg(args, 'data-root'));
  const baseUrl = args.get('base-url') ?? 'http://127.0.0.1:5430';
  const routes = (args.get('routes') ?? ROUTES.join(',')).split(',').map((value) => value.trim()).filter(Boolean);
  const settleMs = numberArg(args, 'settle-ms', 3000);
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist'] });
  const machine = await machineState();
  const runs = [];
  try {
    for (const route of routes) {
      const context = await browser.newContext();
      runs.push(await visit(context, baseUrl, dataRoot, route, 'cold', settleMs));
      runs.push(await visit(context, baseUrl, dataRoot, route, 'warm', settleMs));
      await context.close();
    }
  } finally { await browser.close(); }
  const reportBase = {
    schema: 'simforge.browser-app-benchmark/v1', benchmark: 'browser-app', generatedAt: new Date().toISOString(),
    corpus: { routes, settleMs, coldDefinition: 'new browser context with empty context cache', warmDefinition: 'second ticket/page in the same context after cold route' },
    machine, runs,
    metrics: {
      ttiBySurface: Object.fromEntries(routes.map((route) => [route, runs.filter((run) => run.route === route).map((run) => run.metrics?.ttiMs).filter(Number.isFinite)])),
      frameTimeBySurface: Object.fromEntries(routes.map((route) => [route, runs.filter((run) => run.route === route && run.metrics).map((run) => run.metrics.frameTime)])),
      first3dFrameMs: runs.filter((run) => run.metrics?.firstWorldFrameMs !== null).map((run) => run.metrics.firstWorldFrameMs),
    },
    definitions: {
      jsBytesExecuted: 'decoded bytes for script resources that loaded before the measurement stop; this is a conservative browser-observed execution proxy, not CPU instruction bytes.',
      unusedAssetBytes: 'asset-like resource bytes whose absolute URL was not present in src/href DOM references at stop; dynamic texture use is reported as uncertain rather than silently counted as used.',
      preInteractiveAssets: 'asset-like requests starting before navigation domInteractive.',
      drawCalls: 'WebGL draw* calls intercepted on canvas contexts; instrumented browser calls only.',
      textureUploads: 'texImage/texSubImage/compressed texture calls; upload bytes are an estimate for typed-array and width×height calls.',
    },
    limitations: { webglDriver: 'recorded in machine state; headless Chromium may use SwiftShader when the host blocks the RTX 5080.', scenarioFirst3dFrame: 'only the canvas below [data-testid=scenario-world-host] is counted.' },
  };
  const report = { ...reportBase, reportSha256: sha256(reportBase) };
  await writeJson(path.resolve(args.get('out') ?? 'artifacts/benchmarks/browser/report.json'), report);
  console.log(JSON.stringify(report, null, 2));
  if (runs.some((run) => run.error)) process.exitCode = 2;
}

await main();
