#!/usr/bin/env node
/**
 * Measure the CLI render contract. The first iteration is cold and the rest
 * are warm; no single wall-clock total is allowed to hide the render stages.
 * The native engine is opt-in. On a host with only the browser worker, the
 * report says so explicitly instead of labelling browser timings as native.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  boolArg, directoryBytes, gpuSample, machineState, median, numberArg, parseArgs,
  processTreeSample, progressFraction, readJson, requireArg, run, runJson, sha256,
  sleep, stageSummaryFromTimings, summarize, writeJson, collectDirectoryFiles,
} from './lib/common.mjs';

const ROOT = process.cwd();
const CLI = path.resolve(ROOT, 'packages/cli/bin/simforge.js');

async function monitored(argv, options = {}) {
  let child;
  let sampleInFlight = false;
  const processSamples = [];
  const gpuSamples = [];
  const sample = async () => {
    if (!child?.pid || sampleInFlight) return;
    sampleInFlight = true;
    try {
      const [proc, gpu] = await Promise.all([processTreeSample(child.pid), gpuSample()]);
      processSamples.push(proc);
      if (gpu) gpuSamples.push(gpu);
    } finally { sampleInFlight = false; }
  };
  const timer = setInterval(() => { void sample(); }, Math.max(250, options.sampleIntervalMs ?? 500));
  const started = process.hrtime.bigint();
  const result = await run(argv, {
    cwd: ROOT,
    env: options.env,
    onSpawn: (value) => { child = value; options.onSpawn?.(value); },
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });
  clearInterval(timer);
  await sample();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    result, elapsedMs, processPeakRssBytes: Math.max(0, ...processSamples.map((item) => item.peakRssBytes)),
    processPeakRssObservedBytes: Math.max(0, ...processSamples.map((item) => item.rssBytes)),
    gpuPeakMemoryMiB: Math.max(0, ...gpuSamples.map((item) => item.memoryUsedMiB)),
    gpuPeakPowerW: Math.max(0, ...gpuSamples.map((item) => item.powerW)),
    gpuPeakUtilizationPercent: Math.max(0, ...gpuSamples.map((item) => item.utilizationPercent)),
    gpuSamples,
  };
}

function cliArgs(dataRoot, ...args) { return [process.execPath, CLI, ...args, '--data-root', dataRoot]; }
function terminalStatus(value) { return ['succeeded', 'failed', 'cancelled'].includes(value?.status); }

function stageTimingsFromManifest(manifest) {
  const timings = manifest?.timings ?? manifest?.stageTimings ?? manifest?.stageTimingsMs ?? {};
  if (timings && typeof timings === 'object' && !Array.isArray(timings)) {
    const normalised = {};
    for (const [key, value] of Object.entries(timings)) {
      if (typeof value === 'number') normalised[key] = { totalMs: value };
      else if (value && typeof value === 'object') normalised[key] = value;
    }
    return normalised;
  }
  return {};
}

function stageReport({ submitMs, waitMs, manifest, progressSamples, tailMs }) {
  const instrumented = stageSummaryFromTimings(stageTimingsFromManifest(manifest));
  return {
    mapAssetPreparation: {
      ms: null,
      reason: 'The public render-job DTO does not expose asset preparation separately; submit wall time is retained below rather than fabricated.',
    },
    scenarioCompile: {
      ms: null,
      reason: 'The public render-job DTO does not expose compile timing separately; submit wall time is retained below rather than fabricated.',
    },
    cliSubmitFreezeAndCompileWallMs: submitMs,
    simulationStepping: { ms: instrumented.simulationSteppingMs, source: 'browser/native render manifest when present' },
    frameRasterisation: { ms: instrumented.frameRasterisationMs, source: 'browser/native render manifest when present' },
    sensorSynthesis: { ms: instrumented.sensorSynthesisMs, source: 'browser/native render manifest when present' },
    encodeFinalise: { ms: instrumented.encodeFinaliseMs, source: 'browser/native render manifest when present' },
    cliWaitToTerminalWallMs: waitMs,
    progress90ToTerminalMs: tailMs,
    progressSamples,
    instrumentedTotalMs: instrumented.instrumentedTotalMs,
    uninstrumentedWaitMs: Math.max(0, waitMs - instrumented.instrumentedTotalMs),
  };
}

async function findManifest(directory) {
  for (const file of await collectDirectoryFiles(directory)) {
    if (!file.endsWith('.json')) continue;
    try {
      const value = await readJson(file);
      if (typeof value?.schema === 'string' && /render-manifest/.test(value.schema)) return { file, value };
    } catch { /* artifact may be binary or partially written */ }
  }
  return null;
}

async function runIteration(config, index, kind) {
  const output = path.resolve(config.output, `run-${String(index).padStart(2, '0')}`);
  await mkdir(output, { recursive: true });
  const startMachine = await machineState();
  const submit = await monitored(cliArgs(config.dataRoot,
    'render', 'submit', '--scenario', config.scenario, '--engine', config.engine,
    '--seconds', String(config.seconds), '--fps', String(config.fps),
    '--resolution', `${config.width}x${config.height}`, '--quality', config.quality,
  ));
  const submitted = submit.result.code === 0 ? (() => {
    try { return JSON.parse(submit.result.stdout.trim().split('\n').at(-1)); } catch { return null; }
  })() : null;
  const jobId = submitted?.jobId;
  const progressSamples = [];
  let ninetyAt = null;
  let statusTimer;
  if (jobId) {
    statusTimer = setInterval(async () => {
      const startedAt = Date.now();
      try {
        const status = await runJson(cliArgs(config.dataRoot, 'render', 'status', jobId));
        const fraction = progressFraction(status.value.progress);
        const sample = { elapsedMs: Date.now() - startedAt, status: status.value.status, fraction, atMs: Date.now() };
        progressSamples.push(sample);
        if (ninetyAt === null && fraction !== null && fraction >= 0.9) ninetyAt = sample.atMs;
      } catch { /* wait command remains authoritative */ }
    }, 500);
  }
  const wait = jobId
    ? await monitored(cliArgs(config.dataRoot, 'render', 'wait', jobId, '--timeout', String(config.timeout)))
    : { result: { code: 1, stdout: '', stderr: 'submit failed' }, elapsedMs: 0, processPeakRssBytes: 0, gpuPeakMemoryMiB: 0, gpuPeakPowerW: 0, gpuPeakUtilizationPercent: 0, gpuSamples: [] };
  if (statusTimer) clearInterval(statusTimer);
  const terminalAt = Date.now();
  const tailMs = ninetyAt === null ? null : Math.max(0, terminalAt - ninetyAt);
  const artifacts = jobId && wait.result.code === 0
    ? await monitored(cliArgs(config.dataRoot, 'render', 'artifacts', jobId, '--out', output))
    : null;
  const manifest = artifacts ? await findManifest(output) : null;
  const outputBytes = await directoryBytes(output);
  const endMachine = await machineState();
  const frameCount = Number(manifest?.value?.schedule?.frameCount ?? manifest?.value?.frameCount ?? 0);
  const elapsedMs = submit.elapsedMs + wait.elapsedMs + (artifacts?.elapsedMs ?? 0);
  const sampleResources = [submit, wait, artifacts].filter(Boolean);
  return {
    index, kind, jobId, engine: config.engine, status: wait.result.code === 0 && submit.result.code === 0 ? 'succeeded' : 'failed',
    exitCodes: { submit: submit.result.code, wait: wait.result.code, artifacts: artifacts?.result.code ?? null },
    stderr: [submit.result.stderr, wait.result.stderr, artifacts?.result.stderr].filter(Boolean).join('\n').slice(-8000),
    elapsedMs,
    frameCount,
    throughput: { framesPerSecond: frameCount > 0 ? frameCount / (elapsedMs / 1000) : null, simulatedSecondsPerSecond: config.seconds / (elapsedMs / 1000) },
    artifactBytes: outputBytes,
    manifest: manifest ? { path: path.relative(ROOT, manifest.file), schema: manifest.value.schema, timings: manifest.value.timings ?? null } : null,
    stages: stageReport({ submitMs: submit.elapsedMs, waitMs: wait.elapsedMs, manifest: manifest?.value, progressSamples, tailMs }),
    resources: {
      processPeakRssBytes: Math.max(...sampleResources.map((item) => item.processPeakRssBytes ?? 0)),
      processPeakRssObservedBytes: Math.max(...sampleResources.map((item) => item.processPeakRssObservedBytes ?? 0)),
      vramPeakMiB: Math.max(...sampleResources.map((item) => item.gpuPeakMemoryMiB ?? 0)),
      gpuPeakPowerW: Math.max(...sampleResources.map((item) => item.gpuPeakPowerW ?? 0)),
      gpuPeakUtilizationPercent: Math.max(...sampleResources.map((item) => item.gpuPeakUtilizationPercent ?? 0)),
    },
    machine: { start: startMachine, end: endMachine },
  };
}

function aggregate(runs, config) {
  const successful = runs.filter((run) => run.status === 'succeeded');
  const warm = successful.filter((run) => run.kind === 'warm');
  const values = (items, key) => items.map((item) => key(item)).filter(Number.isFinite);
  return {
    elapsedMs: summarize(values(warm, (item) => item.elapsedMs)),
    framesPerSecond: summarize(values(warm, (item) => item.throughput.framesPerSecond)),
    simulatedSecondsPerSecond: summarize(values(warm, (item) => item.throughput.simulatedSecondsPerSecond)),
    artifactBytes: summarize(values(warm, (item) => item.artifactBytes)),
    peakRssBytes: summarize(values(warm, (item) => item.resources.processPeakRssBytes)),
    peakVramMiB: summarize(values(warm, (item) => item.resources.vramPeakMiB)),
    stageMediansMs: Object.fromEntries(['simulationStepping', 'frameRasterisation', 'sensorSynthesis', 'encodeFinalise'].map((name) => [name, median(warm.map((item) => item.stages[name].ms).filter(Number.isFinite))])),
    cold: runs.find((run) => run.kind === 'cold') ? { elapsedMs: runs.find((run) => run.kind === 'cold').elapsedMs } : null,
    warmRuns: warm.length,
    failedRuns: runs.filter((run) => run.status !== 'succeeded').length,
    fixedCorpus: { scenario: config.scenario, seconds: config.seconds, fps: config.fps, resolution: `${config.width}x${config.height}`, engine: config.engine },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataRoot = path.resolve(requireArg(args, 'data-root'));
  const scenario = args.get('scenario') ?? (await runJson(cliArgs(dataRoot, 'scenario', 'list')).then(({ value }) => value?.items?.[0]?.id ?? value?.[0]?.id));
  if (!scenario) throw new Error('No scenario supplied or discoverable; pass --scenario <documentId>.');
  const config = {
    dataRoot, scenario, engine: args.get('engine') ?? 'browser', seconds: numberArg(args, 'seconds', 1),
    fps: numberArg(args, 'fps', 5), width: numberArg(args, 'width', 320), height: numberArg(args, 'height', 180),
    quality: args.get('quality') ?? 'preview', timeout: numberArg(args, 'timeout', 1800),
    repeats: Math.max(2, Math.floor(numberArg(args, 'repeats', 3))), output: path.resolve(args.get('out') ?? 'artifacts/benchmarks/cli'),
  };
  await mkdir(config.output, { recursive: true });
  const runs = [];
  for (let index = 0; index < config.repeats; index += 1) runs.push(await runIteration(config, index, index === 0 ? 'cold' : 'warm'));
  let qualityGate = { status: "not-run", reason: "No --reference supplied." };
  if (args.get("reference")) {
    const gateOut = path.join(config.output, "quality-gate.json");
    const gate = await run([process.execPath, path.join(ROOT, "scripts/benchmarks/quality-gate.mjs"), "--reference", path.resolve(args.get("reference")), "--candidate", config.output, "--out", gateOut], { cwd: ROOT });
    qualityGate = { status: gate.code === 0 ? "passed" : "rejected", report: await readJson(gateOut).catch(() => null), stderr: gate.stderr.slice(-4000) };
  }
  const reportBase = {
    schema: 'simforge.cli-render-benchmark/v1', benchmark: 'cli-render', generatedAt: new Date().toISOString(),
    sourceRevision: (await run(['git', 'rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim(),
    corpus: config, runs, aggregate: aggregate(runs, config),
    qualityGate,
    limitations: {
      compileAndAssetSplit: 'render submit wall time includes freeze, map/asset preparation, and scenario compile; the host DTO exposes no independent counters.',
      nativeAvailability: config.engine === 'native' ? 'Requested native; a failed run is rejected rather than relabelled.' : 'Browser engine requested explicitly; these numbers are CLI orchestration around browser rendering, not native rendering.',
    },
  };
  const report = { ...reportBase, reportSha256: sha256(reportBase) };
  await writeJson(path.join(config.output, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2));
  if (runs.some((run) => run.status !== 'succeeded')) process.exitCode = 2;
}

await main();
