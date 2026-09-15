#!/usr/bin/env node
/**
 * Native render benchmark: run the real `@simforge-oss/render` native engine
 * (service process, shm frame bundles, ffmpeg encoders, lidar/radar
 * rasterizers) against a captured fixture and report throughput.
 *
 * The number to beat is `msPerTick`: wall time of the tick loop divided by
 * ticks rendered, for the fixture's full sensor rig. Everything else in the
 * report is there to explain where the time goes.
 *
 * Usage:
 *   node scripts/bench/native-render/run.mjs --fixture <dir> [--seconds 2]
 *     [--sources all|rgb|lidar|radar|<outputName,...>] [--out <dir>]
 *     [--baseline <result.json>] [--binary <native-render-service>] [--label <text>]
 *
 * `--seconds` trims the intent clip to `[start, start + seconds]`; the fixture's
 * scene, rig and video format are otherwise untouched. `--baseline` compares
 * against a previous result and enforces the correctness gate described in
 * README.md (same trace digest, same frame counts, PSNR floor per video).
 *
 * Environment: `SIMFORGE_NATIVE_RENDER_BINARY` / `SIMFORGE_FFMPEG_BINARY`
 * override the installed runtime; the engine otherwise resolves the runtime
 * root exactly like the Studio worker does.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const { createRenderEngine, resolveBinary, resolveEncoder } = await import(path.join(repoRoot, 'packages/render/dist/native/index.js'));
const { createFixedSchedules, hashFile } = await import(path.join(repoRoot, 'packages/render/dist/index.js'));

const PSNR_FLOOR_DB = 35;

function argsOf(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`usage: --key value pairs (got ${key})`);
    map.set(key.slice(2), argv[i + 1]);
  }
  return map;
}

const args = argsOf(process.argv.slice(2));
const fixture = path.resolve(args.get('fixture') ?? (() => { throw new Error('--fixture is required'); })());
const seconds = Number(args.get('seconds') ?? '2');
if (!(seconds > 0)) throw new Error('--seconds must be positive');
const sourceFilter = args.get('sources') ?? 'all';
const out = path.resolve(args.get('out') ?? path.join(os.tmpdir(), `simforge-native-bench-${Date.now()}`));
const baselinePath = args.get('baseline') ? path.resolve(args.get('baseline')) : null;
const label = args.get('label') ?? null;

const intent = JSON.parse(await fs.readFile(path.join(fixture, 'intent.json'), 'utf8'));
const inputMap = JSON.parse(await fs.readFile(path.join(fixture, 'inputs.json'), 'utf8'));

const selected = intent.renderSpec.sources.filter((source) => {
  if (sourceFilter === 'all') return true;
  if (['rgb', 'lidar', 'radar'].includes(sourceFilter)) return source.modality === sourceFilter;
  return sourceFilter.split(',').includes(source.outputName);
});
if (selected.length === 0) throw new Error(`--sources ${sourceFilter} selects no fixture source`);
const clipStart = intent.renderSpec.clip.startSeconds;
const clipEnd = Math.min(intent.renderSpec.clip.endSeconds, clipStart + seconds);
const benchIntent = {
  ...intent,
  intentId: `bench-${intent.intentId}`,
  renderSpec: { ...intent.renderSpec, sources: selected, clip: { startSeconds: clipStart, endSeconds: clipEnd } },
};

const inputs = new Map();
for (const [inputId, entry] of Object.entries(inputMap)) {
  const file = path.isAbsolute(entry.path) ? entry.path : path.join(fixture, entry.path);
  const digest = await hashFile(file);
  inputs.set(inputId, { inputId, path: file, ...(entry.relativePath ? { relativePath: entry.relativePath } : {}), ...digest });
}

const binary = resolveBinary({ binary: args.get('binary') ?? (process.env.SIMFORGE_NATIVE_RENDER_BINARY?.trim() || undefined) });
const encoder = resolveEncoder();
if (encoder.state !== 'available') throw new Error('ffmpeg is not installed in the runtime root or on PATH');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

// Timeline: the engine reports `rendering` progress per ~1% of ticks (every
// tick for short clips) and `encoding` around the encoder flush. Timestamps
// of those events, taken here, split wall time into startup / tick loop /
// encode flush without touching the engine.
const t0 = performance.now();
let firstTickAt = null;
let lastTickAt = null;
let encodeStartAt = null;
let encodeEndAt = null;
const tickMarks = [];
const manifest = await createRenderEngine({ binary }).execute({
  jobId: benchIntent.intentId, attempt: 1, intent: benchIntent, intentSha256: 'b'.repeat(64),
  executionPackageControlSha256: 'c'.repeat(64), schedules: createFixedSchedules(benchIntent),
  inputs, workspace: out, signal: new AbortController().signal,
  reportProgress: async (record) => {
    if (record.event !== 'stage.progress') return;
    const now = performance.now();
    if (record.stage === 'rendering') {
      firstTickAt ??= now;
      lastTickAt = now;
      tickMarks.push({ completed: record.completed, at: now });
    } else if (record.stage === 'encoding') {
      if (record.completed === 0) encodeStartAt = now; else encodeEndAt = now;
    }
  },
});
const wallMs = performance.now() - t0;

const diagnostics = JSON.parse(await fs.readFile(path.join(out, 'diagnostics/native-run.json'), 'utf8'));
const ticks = diagnostics.frameCount;
const videos = manifest.artifacts.filter((artifact) => artifact.identity.role === 'video');
const trace = manifest.artifacts.find((artifact) => artifact.identity.role === 'trace');
// The first tick event lands after tick 0 completed; startup covers scene
// lowering, service prewarm and the first bundle.
const loopMs = lastTickAt - firstTickAt;
const loopTicks = tickMarks.length > 1 ? tickMarks[tickMarks.length - 1].completed - tickMarks[0].completed : 0;
const msPerTick = loopTicks > 0 ? loopMs / loopTicks : null;

const gpu = process.platform === 'darwin'
  ? (await executeFile('system_profiler', ['SPDisplaysDataType']).catch(() => ({ stdout: '' }))).stdout.match(/Chipset Model: (.+)/)?.[1] ?? null
  : null;
const gitSha = (await executeFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).catch(() => ({ stdout: 'unknown' }))).stdout.trim();

const result = {
  schema: 'simforge.native-render-bench/v1',
  label,
  createdAt: new Date().toISOString(),
  machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? null, gpu, node: process.version },
  code: { gitSha, serviceBinary: binary, serviceSha256: (await hashFile(binary)).sha256 },
  fixture: { path: fixture, intentId: intent.intentId, clip: benchIntent.renderSpec.clip },
  rig: {
    sources: selected.map((source) => ({ outputName: source.outputName, modality: source.modality, width: source.attributes.width ?? null, height: source.attributes.height ?? null })),
    rgb: selected.filter((s) => s.modality === 'rgb').length,
    lidar: selected.filter((s) => s.modality === 'lidar').length,
    radar: selected.filter((s) => s.modality === 'radar').length,
  },
  ticks,
  timings: {
    wallMs: Math.round(wallMs),
    startupMs: Math.round(firstTickAt - t0),
    loopMs: Math.round(loopMs),
    loopTicks,
    msPerTick: msPerTick === null ? null : Math.round(msPerTick * 10) / 10,
    msPerSourceTick: msPerTick === null ? null : Math.round((msPerTick / selected.length) * 10) / 10,
    serviceMs: Math.round(diagnostics.timings.serverMs),
    serviceShareOfLoop: msPerTick === null ? null : Math.round((diagnostics.timings.serverMs / (msPerTick * ticks)) * 1000) / 10,
    encodeFlushMs: encodeStartAt && encodeEndAt ? Math.round(encodeEndAt - encodeStartAt) : null,
    projectedFullClipMin: msPerTick === null ? null : Math.round((msPerTick * (intent.renderSpec.clip.endSeconds - intent.renderSpec.clip.startSeconds) * 24) / 60000 * 10) / 10,
  },
  evidence: {
    traceSha256: trace?.sha256 ?? null,
    videos: videos.map((video) => ({ outputName: path.basename(video.relativePath, '.mp4'), frameCount: video.frameCount, sha256: video.sha256, sizeBytes: video.sizeBytes })),
  },
  workspace: out,
};

const psnr = async (candidate, reference) => {
  const { stderr } = await executeFile('ffmpeg', ['-v', 'info', '-i', candidate, '-i', reference, '-lavfi', 'psnr', '-f', 'null', '-'], { maxBuffer: 1 << 24 });
  const value = stderr.match(/average:([\d.]+|inf)/)?.[1];
  return value === 'inf' ? Number.POSITIVE_INFINITY : value ? Number(value) : null;
};

let comparison = null;
if (baselinePath) {
  const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
  const failures = [];
  if (baseline.evidence.traceSha256 !== result.evidence.traceSha256) failures.push('trace digest differs: the simulated scene state changed, not just its rendering');
  if (baseline.ticks !== result.ticks) failures.push(`tick count ${result.ticks} differs from baseline ${baseline.ticks}`);
  const videoChecks = [];
  for (const video of result.evidence.videos) {
    const reference = baseline.evidence.videos.find((candidate) => candidate.outputName === video.outputName);
    if (!reference) { failures.push(`baseline has no video ${video.outputName}`); continue; }
    if (reference.frameCount !== video.frameCount) failures.push(`${video.outputName}: ${video.frameCount} frames, baseline ${reference.frameCount}`);
    const referencePath = path.join(baseline.workspace, 'video', `${video.outputName}.mp4`);
    const candidatePath = path.join(out, 'video', `${video.outputName}.mp4`);
    const reachable = await fs.access(referencePath).then(() => true, () => false);
    const db = reachable ? await psnr(candidatePath, referencePath) : null;
    videoChecks.push({ outputName: video.outputName, psnrDb: db === null ? null : db === Number.POSITIVE_INFINITY ? 'identical' : Math.round(db * 100) / 100 });
    if (db !== null && db < PSNR_FLOOR_DB) failures.push(`${video.outputName}: PSNR ${db.toFixed(2)} dB against baseline is below ${PSNR_FLOOR_DB} dB`);
  }
  if (baseline.evidence.videos.length !== result.evidence.videos.length) failures.push('video count differs from baseline');
  const speedup = baseline.timings.msPerTick && result.timings.msPerTick ? baseline.timings.msPerTick / result.timings.msPerTick : null;
  comparison = {
    baseline: baselinePath,
    baselineMsPerTick: baseline.timings.msPerTick,
    speedup: speedup === null ? null : Math.round(speedup * 1000) / 1000,
    videos: videoChecks,
    baselineVideosReachable: videoChecks.some((check) => check.psnrDb !== null),
    failures,
  };
}
result.comparison = comparison;

await fs.writeFile(path.join(out, 'bench-result.json'), `${JSON.stringify(result, null, 2)}\n`);
const t = result.timings;
const lines = [
  `native render bench${label ? ` [${label}]` : ''} — ${gitSha} on ${gpu ?? result.machine.cpu}`,
  `rig: ${result.rig.rgb} rgb + ${result.rig.lidar} lidar + ${result.rig.radar} radar, ${ticks} ticks (${benchIntent.renderSpec.clip.startSeconds}s..${benchIntent.renderSpec.clip.endSeconds}s)`,
  `msPerTick        ${t.msPerTick}   (${t.msPerSourceTick} per source-tick)`,
  `service share    ${t.serviceShareOfLoop}% of loop  (serviceMs ${t.serviceMs} / loopMs ${t.loopMs})`,
  `startup          ${t.startupMs} ms   encode flush ${t.encodeFlushMs} ms   wall ${t.wallMs} ms`,
  `projected 20 s clip at 24 fps: ${t.projectedFullClipMin} min`,
];
if (comparison) {
  lines.push(`vs baseline      ${comparison.baselineMsPerTick} ms/tick -> ${comparison.speedup}x${comparison.baselineVideosReachable ? '' : ' (baseline videos not reachable: PSNR skipped)'}`);
  for (const check of comparison.videos) if (check.psnrDb !== null) lines.push(`  psnr ${String(check.psnrDb).padStart(9)}  ${check.outputName}`);
  for (const failure of comparison.failures) lines.push(`  FAIL ${failure}`);
}
lines.push(`result: ${path.join(out, 'bench-result.json')}`);
process.stdout.write(`${lines.join('\n')}\n`);
if (comparison?.failures.length) process.exit(1);
