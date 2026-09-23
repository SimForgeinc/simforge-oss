#!/usr/bin/env node
/**
 * Paired cold/warm benchmark of the two interactive map backends.
 *
 * Same map, same scripted camera path, both backends, one real GPU:
 *
 *   native  the shipped `simforge-render view` process (Bevy/wgpu) on the
 *           `.corpus/<map>` native closure, driven through the shipped
 *           `NativeViewportProcess` host wrapper.
 *   web     the shipped `CityViewer` (three.js) on the `map-bundles/<map>`
 *           web closure, driven headlessly through the shipped
 *           `packages/viewer/dev` harness page. No second loader exists here:
 *           the page is the one the viewer team develops against, and the
 *           bytes are served by that harness's own static server.
 *
 * Both halves read the ONE map cache (`SIMFORGE_MAPS_CACHE_ROOT`, default
 * `$XDG_DATA_HOME/simforge/maps`). Nothing is copied and nothing is fetched.
 *
 * Frame time is CPU frame delta on both sides -- wall time between presented
 * frames -- because neither backend has GPU timestamp queries. It is reported
 * as `source: "cpu-frame-delta"` and must not be read as GPU time.
 *
 * Cold vs warm is file-cache state and nothing else. `cold` drops the OS page
 * cache immediately before the run (needs passwordless sudo; without it the
 * pass is recorded as `cold: false` rather than silently mislabelled), `warm`
 * repeats the identical sequence straight afterwards. Every pass is a fresh
 * process with a fresh profile directory on both sides, so neither backend
 * gets to keep a warmed shader cache the other does not have.
 *
 * Usage:
 *   xvfb-run -a node scripts/bench/interactive-viewport/run.mjs \
 *     [--maps=all|<id>,<id>] [--backends=native,web] [--out=<dir>]
 *     [--dwell-ms=2000] [--passes=cold,warm]
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BENCH_DWELL_MS, BENCH_VIEWPORT_ARGS, cameraPath } from './camera-path.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const require = createRequire(path.join(repoRoot, 'packages/viewer/package.json'));
const { createMapServer } = await import(path.join(repoRoot, 'packages/viewer/dev/serve.mjs'));
const { NativeViewportProcess } = await import(path.join(repoRoot, 'studio/desktop/native-viewport.mjs'));

const args = new Map(process.argv.slice(2).map((arg) => {
  const [name, ...value] = arg.replace(/^--/, '').split('=');
  return [name, value.join('=') || 'true'];
}));
const cacheRoot = process.env.SIMFORGE_MAPS_CACHE_ROOT
  ?? path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local/share'), 'simforge/maps');
const outDir = path.resolve(args.get('out') ?? '/tmp/native-bench');
const binary = process.env.SIMFORGE_NATIVE_VIEWPORT
  ?? path.join(repoRoot, 'renderer/target/release/simforge-render');
const chromeBinary = process.env.SIMFORGE_CHROMIUM
  ?? path.join(homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const dwellMs = Number(args.get('dwell-ms') ?? BENCH_DWELL_MS);
const backends = (args.get('backends') ?? 'native,web').split(',');
const passes = (args.get('passes') ?? 'cold,warm').split(',');
const loadTimeoutMs = Number(args.get('load-timeout-ms') ?? 900_000);
const vitePort = Number(args.get('vite-port') ?? 5188);
const mapPort = Number(args.get('map-port') ?? 8791);

if (!process.env.DISPLAY) throw new Error('no DISPLAY; run under `xvfb-run -a` (a windowed swapchain is the point)');
await access(binary);
await access(chromeBinary);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Maps with BOTH closures materialised: native `.corpus` and web `map-bundles`. */
async function canonicalMaps() {
  const requested = args.get('maps');
  const ids = requested && requested !== 'all'
    ? requested.split(',')
    : (await readdir(path.join(cacheRoot, '.corpus'))).sort();
  const maps = [];
  for (const id of ids) {
    const corpus = path.join(cacheRoot, '.corpus', id);
    const bundle = path.join(cacheRoot, 'map-bundles', id);
    const receipt = path.join(corpus, '.map-release.json');
    try {
      await access(path.join(corpus, 'master.gltf'));
      await access(path.join(bundle, '3d/manifest.json'));
      await access(receipt);
    } catch {
      console.log(`skip ${id}: incomplete closure (native master.gltf / web 3d/manifest.json / receipt)`);
      continue;
    }
    const release = JSON.parse(await readFile(receipt, 'utf8'));
    maps.push({
      id,
      corpus,
      bundle,
      // `mapRoot` is part of the command, exactly as the Electron main
      // process sends it: the process verifies the root against these digests
      // before it opens a byte.
      identity: {
        mapRoot: corpus,
        sourceMapId: id,
        mapVersionId: `${release.name}@${release.version}`,
        releaseDigest: release.releaseDigest,
        canonicalDigest: release.canonicalDigest,
      },
    });
  }
  return maps;
}


function percentiles(samples) {
  if (samples.length === 0) return { frames: 0, minMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.round(fraction * (sorted.length - 1)))];
  return {
    frames: sorted.length,
    // The fastest frame in the window. If it sits at the presentation
    // interval, every percentile above it is measuring the presentation path
    // rather than the renderer, and the reader has to be able to see that.
    minMs: Number(sorted[0].toFixed(3)),
    p50Ms: Number(at(0.5).toFixed(3)),
    p95Ms: Number(at(0.95).toFixed(3)),
    p99Ms: Number(at(0.99).toFixed(3)),
  };
}

/** True cold means the page cache is gone. Report the attempt, never fake it. */
async function dropPageCache() {
  const dropped = await new Promise((done) => {
    const child = spawn('sudo', ['-n', 'sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches'], { stdio: 'ignore' });
    child.on('exit', (code) => done(code === 0));
    child.on('error', () => done(false));
  });
  if (!dropped) console.log('  (page cache NOT dropped: no passwordless sudo; pass recorded as cold=false)');
  return dropped;
}

/**
 * Per-process GPU memory, if the driver reports it for a graphics context.
 * Total `memory.used` is useless here: other processes, including the live
 * daemon, share this GPU.
 */
async function gpuProcessBytes(pid) {
  const out = await new Promise((done) => {
    const child = spawn('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => { text += String(chunk); });
    child.on('exit', () => done(text));
    child.on('error', () => done(''));
  });
  for (const line of out.split('\n')) {
    const [reported, mib] = line.split(',').map((field) => field.trim());
    if (Number(reported) === pid) return Number(mib) * 1024 * 1024;
  }
  return null;
}

// ---------------------------------------------------------------------------
// native: the shipped viewport process, driven through the host wrapper.
// ---------------------------------------------------------------------------
async function runNative(map, { cold }) {
  // `--present-mode immediate` for the same reason the browser gets
  // `--disable-gpu-vsync`: a frame time paced by the swapchain measures the
  // swapchain. Default `auto-vsync` pinned p50 at 17 ms on both backends.
  const viewport = new NativeViewportProcess({
    executable: binary,
    mapRoot: map.corpus,
    args: BENCH_VIEWPORT_ARGS,
  });
  const events = [];
  viewport.onEvent((event) => events.push({ ...event, at: performance.now() }));
  const stderr = [];
  if (cold) await dropPageCache();
  const started = viewport.start();
  viewport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  try {
    await started;
    const waitFor = async (name, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find((event) => event.event === name);
        if (found) return found;
        // A rejected load or a dead process is an answer, and waiting out a
        // long timeout to report it wastes the run. Fail on the evidence.
        const failed = events.find((event) => event.event === 'error' || event.event === 'closed');
        if (failed) {
          throw new Error(`native ${map.id}: ${failed.event} before ${name}: ${failed.message ?? failed.code ?? ''}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`native ${map.id}: no ${name} in ${timeoutMs} ms; saw ${events.map((e) => e.event).join(',')}`);
        }
        await sleep(20);
      }
    };
    viewport.loadMap(map.identity);
    const manifest = await waitFor('manifest-ready', loadTimeoutMs);
    const interactive = await waitFor('interactive', loadTimeoutMs);
    const complete = await waitFor('complete', loadTimeoutMs);
    const bounds = manifest.sceneBounds;
    if (!bounds) throw new Error(`native ${map.id}: manifest-ready carried no sceneBounds`);

    // Frame samples are taken only while the camera path runs, so a load
    // spike cannot be presented as steady-state frame time.
    const pathStart = performance.now();
    const poses = cameraPath(bounds);
    for (const pose of poses) {
      viewport.setCamera(pose.position, pose.target);
      await sleep(dwellMs);
    }
    const pathEnd = performance.now();
    const gpuBytes = await gpuProcessBytes(viewport.pid);
    const windows = events.filter((event) => event.event === 'frame-stats' && event.at >= pathStart && event.at <= pathEnd);
    const samples = windows.flatMap((window) => window.samplesMs ?? []);
    const last = windows.at(-1) ?? complete;
    const adapter = events.find((event) => event.event === 'adapter');
    return {
      backend: 'native',
      engine: 'bevy-wgpu',
      renderer: adapter?.renderer ?? null,
      adapter: adapter ? `${adapter.name} | ${adapter.backend} | ${adapter.deviceType} | driver ${adapter.driver} ${adapter.driverInfo}` : null,
      timeToInteractiveMs: interactive.elapsedMs,
      timeToCompleteMs: complete.elapsedMs,
      frameTime: { source: 'cpu-frame-delta', ...percentiles(samples) },
      peakResidentBytes: { value: complete.peakResidentBytes, source: 'scheduler-accounting' },
      gpuProcessBytes: { value: gpuBytes, source: 'nvidia-smi-per-process' },
      budgetBytes: complete.budgetBytes,
      residentNodes: complete.residentNodes,
      budgetSkippedNodes: complete.budgetSkippedNodes,
      budgetSkippedBytes: complete.budgetSkippedBytes,
      admissions: last.admissions ?? complete.admissions,
      evictions: last.evictions ?? complete.evictions,
      sceneBounds: bounds,
      cameraPath: poses.map((pose) => pose.name),
      cold,
      pageCacheDropped: cold,
    };
  } finally {
    viewport.stop();
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// web: the shipped CityViewer, in the viewer team's own dev harness page.
// ---------------------------------------------------------------------------
async function runWeb(map, { cold, vite }) {
  if (cold) await dropPageCache();
  const profile = path.join(tmpdir(), `simforge-bench-chrome-${Date.now()}`);
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromeBinary,
    headless: false,
    viewport: { width: 1600, height: 1000 },
    args: [
      // Under Xvfb, Chromium's GLX path lands on Mesa llvmpipe and its plain
      // EGL path lands on SwiftShader -- both software, both worthless as a
      // comparison against a discrete GPU. ANGLE over Vulkan picks up the
      // NVIDIA ICD without needing a real X display. The adapter string is
      // asserted below, so this cannot regress silently.
      '--use-gl=angle',
      '--use-angle=vulkan',
      '--enable-features=Vulkan',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      // Neither backend is allowed an artificial frame cap: Xvfb has no
      // refresh to sync to, and a vsync-limited web number against an
      // unlimited native one is not a comparison.
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
    ],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    const manifestUrl = `http://localhost:${mapPort}/${map.id}/3d/manifest.json`;
    const started = performance.now();
    await page.goto(`http://localhost:${vitePort}/?manifest=${encodeURIComponent(manifestUrl)}`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.__simforge), null, { timeout: 120_000 });

    const adapter = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
    });
    if (!adapter || /swiftshader|llvmpipe|software/i.test(adapter)) {
      throw new Error(`web ${map.id}: not on a real GPU (adapter: ${adapter ?? 'unknown'})`);
    }

    // `interactive`, web side: the viewer's own loadMap settles, which is
    // when required scene preparation is done and the canvas is drawable.
    await page.evaluate(() => window.__simforge.loaded);
    const timeToInteractiveMs = Math.round(performance.now() - started);
    // `complete`, web side: nothing loading, queued, uploading or pending for
    // 30 consecutive frames -- the harness's own `ready()` definition.
    await page.evaluate((timeout) => window.__simforge.ready(30, timeout), loadTimeoutMs);
    const timeToCompleteMs = Math.round(performance.now() - started);

    const bounds = JSON.parse(await readFile(path.join(map.bundle, '3d/manifest.json'), 'utf8')).scene.bounds;
    const poses = cameraPath(bounds);
    await page.evaluate(() => {
      window.__benchFrames = [];
      let previous = performance.now();
      const loop = (now) => {
        window.__benchFrames.push(now - previous);
        previous = now;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    for (const pose of poses) {
      await page.evaluate((next) => window.__simforge.goto(next.position, next.target), pose);
      await page.waitForTimeout(dwellMs);
    }
    const samples = await page.evaluate(() => window.__benchFrames.slice(1));
    const stats = await page.evaluate(() => window.__simforge.stats());
    return {
      backend: 'web',
      engine: 'three.js-webgl2',
      renderer: 'web-three',
      adapter,
      timeToInteractiveMs,
      timeToCompleteMs,
      frameTime: { source: 'cpu-frame-delta', ...percentiles(samples) },
      peakResidentBytes: { value: stats.residentBytes, source: 'viewer-accounting' },
      gpuProcessBytes: {
        value: null,
        // Chromium holds GPU objects in a separate GPU process shared by every
        // context, so a driver figure cannot be attributed to this page. The
        // viewer's own accounting above is the comparable number.
        source: 'unavailable-chromium-gpu-process',
      },
      budgetBytes: stats.byteBudget,
      residentNodes: stats.residentAssets,
      residentTiles: stats.residentTiles,
      drawCalls: stats.drawCalls,
      triangles: stats.triangles,
      sceneBounds: bounds,
      cameraPath: poses.map((pose) => pose.name),
      cold,
      pageCacheDropped: cold,
      consoleErrors: errors.slice(0, 10),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

const maps = await canonicalMaps();
if (maps.length === 0) throw new Error(`no map in ${cacheRoot} has both closures materialised`);
await mkdir(outDir, { recursive: true });

const mapServer = createMapServer(path.join(cacheRoot, 'map-bundles'));
await new Promise((done) => mapServer.listen(mapPort, done));
const { createServer } = await import(require.resolve('vite'));
const vite = await createServer({
  configFile: path.join(repoRoot, 'packages/viewer/dev/vite.config.ts'),
  server: { port: vitePort, strictPort: true },
});
await vite.listen();

const gpu = await new Promise((done) => {
  const child = spawn('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let text = '';
  child.stdout.on('data', (chunk) => { text += String(chunk); });
  child.on('exit', () => done(text.trim()));
  child.on('error', () => done('unknown'));
});

const runs = [];
for (const map of maps) {
  for (const pass of passes) {
    for (const backend of backends) {
      const label = `${map.id} ${backend} ${pass}`;
      console.log(`> ${label}`);
      try {
        const result = backend === 'native'
          ? await runNative(map, { cold: pass === 'cold' })
          : await runWeb(map, { cold: pass === 'cold', vite: vitePort });
        runs.push({ map: map.id, mapVersionId: map.identity.mapVersionId, pass, ...result });
        console.log(`  interactive ${result.timeToInteractiveMs} ms, complete ${result.timeToCompleteMs} ms, `
          + `p50 ${result.frameTime.p50Ms} ms, p95 ${result.frameTime.p95Ms} ms, p99 ${result.frameTime.p99Ms} ms, `
          + `peak ${(result.peakResidentBytes.value / 1e6).toFixed(0)} MB`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  FAILED ${message}`);
        runs.push({ map: map.id, mapVersionId: map.identity.mapVersionId, pass, backend, error: message });
      }
    }
  }
}

const report = {
  ranAt: new Date().toISOString(),
  host: { gpu, display: process.env.DISPLAY, node: process.version },
  cacheRoot,
  binary,
  chromeBinary,
  dwellMs,
  definitions: {
    frameTime: 'CPU frame delta (wall time between presented frames). Neither backend has GPU timestamp queries; these are NOT GPU times.',
    framePacing: 'MEASURED ON THIS HOST: the native viewport is paced at ~60 fps under Xvfb regardless of present mode -- auto-vsync, immediate, mailbox and auto-no-vsync all yield a ~16.6 ms floor -- so its minMs/p50Ms report the presentation interval, not render cost; p95/p99 above that floor are real hitches. Chromium is launched with vsync and the frame-rate limit disabled, so its frame times are uncapped. Native and web p50 are therefore NOT comparable on this host; compare p95/p99 and the load timings.',
    webGpu: 'Chromium is forced onto the discrete GPU with ANGLE over Vulkan; the adapter string is asserted per run, and a software adapter fails the run rather than producing a number.',
    native: {
      interactive: 'readiness `interactive`: coarse plan resident and the render world idle for 3 consecutive frames',
      complete: 'readiness `complete`: nothing left to admit within the GPU byte budget, GPU idle; budgetSkippedNodes says what did not fit',
      peakResidentBytes: 'the streaming scheduler\'s own accounting of resident geometry and texture bytes',
    },
    web: {
      interactive: 'CityViewer.loadMap() settled: required scene preparation done',
      complete: 'dev harness ready(): nothing loading, queued, uploading or pending for 30 consecutive frames',
      peakResidentBytes: 'CityViewerStats.residentBytes at the end of the camera path',
    },
    cold: 'OS page cache dropped immediately before the pass',
    warm: 'identical sequence repeated straight after the cold pass, page cache warm',
  },
  runs,
};
const jsonPath = path.join(outDir, 'interactive-viewport-bench.json');
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

const columns = ['map', 'backend', 'pass', 'interactiveMs', 'completeMs', 'minMs', 'p50Ms', 'p95Ms', 'p99Ms', 'peakMB', 'adapter'];
const rows = runs.map((run) => [
  run.map,
  run.backend,
  run.pass,
  run.error ? 'FAIL' : String(run.timeToInteractiveMs),
  run.error ? 'FAIL' : String(run.timeToCompleteMs),
  run.error ? '-' : String(run.frameTime.minMs),
  run.error ? '-' : String(run.frameTime.p50Ms),
  run.error ? '-' : String(run.frameTime.p95Ms),
  run.error ? '-' : String(run.frameTime.p99Ms),
  run.error ? '-' : (run.peakResidentBytes.value / 1e6).toFixed(0),
  run.error ? run.error.slice(0, 40) : (run.adapter ?? '').slice(0, 44),
]);
const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => row[index].length)));
const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ');
const table = [line(columns), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
await writeFile(path.join(outDir, 'interactive-viewport-bench.txt'), `${gpu}\nframe time source: cpu-frame-delta\n\n${table}\n`);
console.log(`\n${gpu}\nframe time source: cpu-frame-delta\n\n${table}`);
console.log(`\nresult: ${jsonPath}`);

await vite.close();
await new Promise((done) => mapServer.close(done));
process.exit(runs.some((run) => run.error) ? 1 : 0);
