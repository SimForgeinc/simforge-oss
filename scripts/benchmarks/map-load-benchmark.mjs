#!/usr/bin/env node
/**
 * Map-load benchmark: how long a map takes to become usable and interactive
 * in the web studio, cold and warm, broken into stages, with budgets.
 *
 *   pnpm bench:map-load -- --base-url http://127.0.0.1:5199 --data-root <SIMFORGE_CLOUD_ROOT> \
 *     --maps richmond-field-station --settings low-no-foliage,medium --modes editor,drive \
 *     --runs 4 --budgets config/bench/map-load-budgets.json --out artifacts/bench/map-load
 *
 * Authentication: `--data-root` (a local host: one-use session URL from its
 * control token) or SIMFORGE_BENCH_EMAIL / SIMFORGE_BENCH_PASSWORD (a cloud
 * deployment's email sign-in).
 *
 * Per (map, setting, surface) the first run starts from an empty browser
 * profile (cold: every byte downloaded) and the remaining runs reuse it with a
 * fresh browser process each time (warm: the map cache holds everything, the
 * way a returning user finds it). Budgets are judged on the warm runs; the
 * process exits 1 when any is exceeded and prints the failing checks.
 *
 * Stages (page time, ms after navigation start):
 *   contextMs      the viewer's WebGL2 context exists (app/JS boot done)
 *   firstFrameMs   the viewer draws map geometry for the first time
 *   usableMs       roads and every in-view cell are on screen (viewer `usable`)
 *   interactiveMs  the surface accepts input: the editor's world is loaded, or
 *                  the drive session has its car and no status overlay
 *   fullMs         nothing wanted is loading, queued or uploading any more
 * plus counts: Cache Storage reads and bytes, map network requests, Basis
 * transcodes, meshopt decodes, pack inflates, compressed texture bytes
 * uploaded, programs linked, albedo GPU readbacks, main-thread long tasks.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { machineState, median, numberArg, parseArgs, requireArg } from './lib/common.mjs';
import { evaluateBudgets, formatChecks } from './lib/map-load-budget.mjs';

const args = parseArgs(process.argv.slice(2));
const baseUrl = requireArg(args, 'base-url').replace(/\/$/, '');
const dataRoot = args.get('data-root');
const maps = (args.get('maps') ?? 'richmond-field-station').split(',').filter(Boolean);
const settings = (args.get('settings') ?? 'low-no-foliage,medium').split(',').filter(Boolean);
const modes = (args.get('modes') ?? 'editor,drive').split(',').filter(Boolean);
const runs = numberArg(args, 'runs', 4);
const timeoutMs = numberArg(args, 'timeout-ms', 300_000);
const fullSettleMs = numberArg(args, 'full-settle-ms', 30_000);
const budgetsFile = args.get('budgets');
const outDir = path.resolve(args.get('out') ?? 'artifacts/bench/map-load');
const gpu = args.get('gpu') ?? 'vulkan';
const keepProfiles = args.get('keep-profiles') === 'true';
/** Chrome trace (with CPU samples) of the last warm run of each surface, for stage attribution. */
const traceRuns = args.get('trace') === 'true';
const instrumentation = await readFile(new URL('./lib/map-load-instrument.js', import.meta.url), 'utf8');

const GPU_ARGS = {
  vulkan: ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--ignore-gpu-blocklist'],
  gl: ['--enable-gpu', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'],
  swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  default: [],
};
if (!GPU_ARGS[gpu]) throw new Error(`--gpu must be one of ${Object.keys(GPU_ARGS).join(', ')}`);

async function authenticate(context, next) {
  if (dataRoot) {
    const host = JSON.parse(await readFile(path.join(dataRoot, 'host.json'), 'utf8'));
    const response = await fetch(`${baseUrl}/api/simforge/host/session`, {
      method: 'POST', headers: { authorization: `Bearer ${host.controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ next }),
    });
    if (!response.ok) throw new Error(`host session failed ${response.status}`);
    return (await response.json()).url;
  }
  const session = await context.request.get(`${baseUrl}/api/auth/get-session`).then((r) => (r.ok() ? r.json() : null)).catch(() => null);
  if (!session?.user) {
    for (let attempt = 0; ; attempt++) {
      const response = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
        headers: { Origin: baseUrl, 'content-type': 'application/json' },
        data: { email: process.env.SIMFORGE_BENCH_EMAIL, password: process.env.SIMFORGE_BENCH_PASSWORD },
      });
      if (response.status() === 200) break;
      if (response.status() !== 429 || attempt >= 8) throw new Error(`sign-in failed ${response.status()}`);
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
  return `${baseUrl}${next}`;
}

/** One document per (map, texture quality): a blank scenario with ambient traffic off. */
async function benchDocuments(context) {
  const request = context.request;
  if (dataRoot) await request.get(await authenticate(context, '/dashboard'));
  else await authenticate(context, '/dashboard');
  const listing = await (await request.get(`${baseUrl}/api/simforge/maps`)).json();
  const documents = (await (await request.get(`${baseUrl}/api/simforge/documents`)).json()).documents ?? [];
  const out = {};
  for (const mapId of maps) {
    const map = listing.maps.find((candidate) => candidate.sourceMapId === mapId);
    if (!map) throw new Error(`map ${mapId} is not available at ${baseUrl}`);
    out[mapId] = { mapVersionId: map.mapVersionId };
    for (const quality of ['low', 'medium']) {
      const title = `bench:map-load ${mapId} ${quality}`;
      let document = documents.find((candidate) => candidate.title === title && candidate.mapVersionId === map.mapVersionId);
      if (!document) {
        const created = await request.post(`${baseUrl}/api/simforge/maps/${map.mapVersionId}/documents/default`, { headers: { Origin: baseUrl } });
        if (!created.ok()) throw new Error(`creating a ${mapId} document failed ${created.status()}`);
        const template = (await created.json()).document;
        const content = { ...template.content, extensions: { ...(template.content.extensions ?? {}), 'studio.ambientTraffic.profile.v1': { seed: 'ambient-1', preset: 'off', version: 1 } } };
        const response = await request.post(`${baseUrl}/api/simforge/documents`, {
          headers: { Origin: baseUrl },
          data: { title, schemaVersion: template.schemaVersion, content, mapVersionId: map.mapVersionId, datasetId: template.datasetId, authoringQualityId: quality },
        });
        if (!response.ok()) throw new Error(`creating ${title} failed ${response.status()}`);
        document = await response.json();
        // The default route's own document is not needed.
        await request.delete(`${baseUrl}/api/simforge/documents/${template.id}`, { headers: { Origin: baseUrl } }).catch(() => undefined);
      }
      out[mapId][quality] = { id: document.id, datasetId: document.datasetId };
    }
  }
  return out;
}

function route(documents, mapId, setting, mode) {
  const entry = documents[mapId];
  if (mode === 'drive') return `/dashboard/map-assets/drive/${entry.mapVersionId}`;
  const document = entry[setting === 'medium' ? 'medium' : 'low'];
  return `/dashboard/scenario?dataset=${document.datasetId}&document=${document.id}`;
}

async function measure(profile, target, setting, mode, traceFile = null) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: args.get('headed') !== 'true', args: GPU_ARGS[gpu], ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1,
  });
  try {
    await context.addInitScript(({ preference }) => {
      try {
        localStorage.setItem('simforge.rendering-preference.v1', preference);
        localStorage.setItem('simforge.local-setup.v1', 'completed');
      } catch { /* storage unavailable: the default profile applies and is recorded */ }
    }, { preference: setting });
    await context.addInitScript({ content: instrumentation });
    const page = context.pages()[0] ?? await context.newPage();
    const url = await authenticate(context, target);
    const cdp = traceFile ? await context.newCDPSession(page) : null;
    if (cdp) {
      await cdp.send('Tracing.start', {
        traceConfig: { recordMode: 'recordContinuously', includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing', 'gpu', 'toplevel', 'disabled-by-default-v8.cpu_profiler'] },
        transferMode: 'ReturnAsStream',
      });
    }
    await page.goto(url, { waitUntil: 'commit', timeout: 120_000 });
    const marks = { usableMs: null, interactiveMs: null, firstViewerDrawMs: null, fullMs: null };
    let last = null;
    const deadline = Date.now() + timeoutMs;
    let fullDeadline = null;
    while (Date.now() < deadline && (fullDeadline === null || Date.now() < fullDeadline)) {
      const sample = await page.evaluate(() => {
        const viewer = window.__simforgeViewerProbe?.viewer;
        let stats = null;
        try { stats = viewer?.getStats() ?? null; } catch { stats = null; }
        const host = document.querySelector('[data-testid=scenario-world-host]');
        return {
          t: performance.now(),
          usable: stats?.usable ?? false,
          draws: stats?.drawCalls ?? 0,
          triangles: stats?.triangles ?? 0,
          residentBytes: stats?.residentBytes ?? 0,
          fps: stats?.fps ?? null,
          idle: Boolean(stats && stats.loadProgress.stage === 'ready' && stats.loading === 0 && stats.queued === 0 && stats.uploading === 0 && stats.pendingTextureUploads === 0),
          error: stats?.streamingError ?? null,
          tier: stats?.tierSelection ?? null,
          pack: stats?.loadDiagnostics?.mapPack ?? null,
          loaded: Boolean(host?.getAttribute('data-world-loaded-map-version-id')),
          driveSession: Boolean(document.querySelector('[data-testid=drive-session]')),
          driveStatus: document.querySelector('[data-testid=drive-status]')?.textContent ?? null,
        };
      }).catch(() => null);
      if (sample) {
        last = sample;
        marks.firstViewerDrawMs ??= sample.draws > 0 ? sample.t : null;
        marks.usableMs ??= sample.usable ? sample.t : null;
        const interactive = mode === 'drive' ? sample.loaded && sample.driveSession && !sample.driveStatus : sample.loaded;
        if (interactive && marks.interactiveMs === null) {
          marks.interactiveMs = sample.t;
          fullDeadline = Date.now() + fullSettleMs;
        }
        if (marks.interactiveMs !== null && sample.idle) { marks.fullMs = sample.t; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const bench = await page.evaluate(() => window.__mapLoadBench);
    if (cdp) {
      const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');
      const { stream } = await done;
      const chunks = [];
      for (;;) {
        const { data, eof, base64Encoded } = await cdp.send('IO.read', { handle: stream, size: 1 << 20 });
        chunks.push(base64Encoded ? Buffer.from(data, 'base64') : Buffer.from(data));
        if (eof) break;
      }
      await writeFile(traceFile, Buffer.concat(chunks));
    }
    const mapFetches = bench.fetches.filter((fetch) => fetch.layer === 'network');
    return {
      contextMs: bench.gl.contextAt,
      firstFrameMs: marks.firstViewerDrawMs,
      usableMs: marks.usableMs,
      interactiveMs: marks.interactiveMs,
      fullMs: marks.fullMs,
      cacheReads: bench.cache.matches,
      cacheHitBytes: bench.cache.hitBytes,
      cacheReadSpanMs: bench.cache.first === null ? 0 : bench.cache.last - bench.cache.first,
      mapNetworkRequests: mapFetches.length,
      mapNetworkUrls: mapFetches.map((fetch) => fetch.url),
      appMapFetches: bench.fetches.filter((fetch) => fetch.layer === 'app').length,
      basisTranscodes: bench.workers.basisTranscodes,
      meshoptDecodes: bench.workers.meshoptDecodes,
      packInflates: bench.workers.packInflates,
      compressedTextureBytes: bench.gl.compressedBytes,
      bufferBytes: bench.gl.bufferBytes,
      programsLinked: bench.gl.linkProgram,
      parallelShaderCompile: bench.gl.parallelShaderCompile,
      albedoReadbacks: bench.gl.readPixels,
      getErrorCalls: bench.gl.getError,
      getErrorMs: bench.gl.getErrorMs,
      mainThreadLongTaskMs: bench.longTasks.reduce((sum, [, duration]) => sum + duration, 0),
      // The host is shared: record how busy it was, so a slow run can be told from a regression.
      loadAverage1m: os.loadavg()[0],
      // What the settled view costs to draw (the last sample).
      drawCalls: last?.draws ?? null,
      triangles: last?.triangles ?? null,
      residentBytes: last?.residentBytes ?? null,
      fps: last?.fps ?? null,
      tier: last?.tier ?? null,
      pack: last?.pack ?? null,
      error: last?.error ?? (marks.interactiveMs === null ? 'did not become interactive before the timeout' : null),
    };
  } finally {
    await context.close();
  }
}

await mkdir(outDir, { recursive: true });
const profilesRoot = await mkdtemp(path.join(os.tmpdir(), 'map-load-bench-'));
const partialFile = path.join(outDir, 'map-load-partial.json');
const report = { schema: 'simforge.map-load-benchmark.v1', baseUrl, gpu, runs, startedAt: new Date().toISOString(), machine: await machineState(), results: [] };
try {
  const setupContext = await chromium.launchPersistentContext(path.join(profilesRoot, 'setup'), { headless: true, ignoreHTTPSErrors: true });
  const documents = await benchDocuments(setupContext);
  await setupContext.close();
  for (const mapId of maps) {
    for (const setting of settings) {
      // One profile per (map, setting): its first run is the cold download and
      // every later surface of the same setting starts warm.
      const profile = path.join(profilesRoot, `${mapId}-${setting}`);
      let coldTaken = false;
      for (const mode of modes) {
        const entry = { map: mapId, setting, mode, cold: null, warm: [] };
        for (let run = 0; run < runs; run++) {
          const cold = !coldTaken;
          coldTaken = true;
          const traceFile = traceRuns && run === runs - 1 ? path.join(outDir, `trace-${mapId}-${setting}-${mode}.json`) : null;
          // A crashed or failed run is a result (it fails its budgets), not the end of the benchmark.
          const sample = await measure(profile, route(documents, mapId, setting, mode), setting, mode, traceFile)
            .catch((error) => ({ contextMs: null, firstFrameMs: null, usableMs: null, interactiveMs: null, fullMs: null, error: String(error?.message ?? error).split('\n')[0] }));
          if (cold) entry.cold = sample;
          else entry.warm.push(sample);
          console.error(`${mapId} ${setting} ${mode} ${cold ? 'cold' : 'warm'}: usable ${Math.round(sample.usableMs ?? -1)} interactive ${Math.round(sample.interactiveMs ?? -1)} full ${Math.round(sample.fullMs ?? -1)} ms, ${sample.cacheReads} cache reads, ${sample.mapNetworkRequests} map requests, load ${os.loadavg()[0].toFixed(1)}${sample.error ? `, error: ${sample.error}` : ''}`);
        }
        entry.warmMedian = Object.fromEntries(['contextMs', 'firstFrameMs', 'usableMs', 'interactiveMs', 'fullMs', 'cacheReads', 'mapNetworkRequests', 'mainThreadLongTaskMs']
          .map((field) => [field, median(entry.warm.map((sample) => sample[field]))]));
        report.results.push(entry);
        // Written after every surface so an interrupted run keeps what it measured.
        await writeFile(partialFile, `${JSON.stringify(report, null, 2)}\n`);
      }
    }
  }
} finally {
  if (!keepProfiles) await rm(profilesRoot, { recursive: true, force: true });
}
report.finishedAt = new Date().toISOString();
if (budgetsFile) {
  report.budgets = evaluateBudgets(JSON.parse(await readFile(budgetsFile, 'utf8')), report.results);
  console.error(formatChecks(report.budgets));
}
const file = path.join(outDir, `map-load-${report.startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: file, ok: report.budgets?.ok ?? null }));
if (report.budgets && !report.budgets.ok) process.exit(1);
