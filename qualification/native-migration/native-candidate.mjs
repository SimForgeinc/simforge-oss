#!/usr/bin/env node
/**
 * Native candidate adapter for the native-migration qualification corpus.
 *
 * Executes every row of a stored reference run on the native runtime
 * (`@simforge-oss/engine/node` over the N-API addon) and writes a candidate
 * directory in the layout `harness.mjs compare` consumes:
 *
 *   <out>/<id>/signature.json          discreteSignature (lib/signature.mjs)
 *   <out>/<id>/numeric.json.gz         numericSignature
 *   <out>/<id>/trace.json.gz           canonical native trace
 *   <out>/<id>/engine-result.json      issues, arrival, policy action calls
 *   <out>/<id>/result.json             status, identities, phase timings, replay
 *   <out>/<id>/intervention/...        the second leg of a comparison fixture
 *   <out>/run.json                     runtime identity, counts, per-row summary
 *
 * Measurement boundary: this is an *executed-input* conformance adapter. Every
 * input comes from the sealed reference directory (`instance.json` and optional
 * `runtime.json`). Contract-resealed inputs carry their explicit projection
 * provenance in run.json; this adapter never migrates an input. Nothing here
 * matches sites, materialises templates, generates ambient traffic or derives
 * thresholds; compiler identity is qualified separately. The recorded-policy
 * handover fixture's `policy` schedule is driven through the native
 * `Simulation` action channel exactly as the fixture describes.
 *
 * Nothing is fabricated: a reference row that failed stays `reference-failed`
 * (no signature is written), a row the native runtime cannot execute is
 * `failed` with the binding's error, and a missing binding operation is an
 * error — there is no TypeScript engine or older `dist` behind any row.
 *
 *   node qualification/native-migration/native-candidate.mjs status [--packages-root DIR] [--dev-assets DIR]
 *   node qualification/native-migration/native-candidate.mjs run --reference DIR --out DIR
 *        [--repeats 5] [--only id,id] [--packages-root DIR] [--dev-assets DIR]
 *
 * Exit codes: `run` 0 every executable row completed / 2 some row failed /
 * 3 native runtime not available. `status` executes nothing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { discreteSignature, numericSignature } from './lib/signature.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RUN_SCHEMA = 'simforge.native-migration.candidate-run/v1';
const RESULT_SCHEMA = 'simforge.native-migration.candidate-result/v1';
const MAP_MEMBERS = ['map.xodr', 'signals.geojson.gz', 'topology-index.json.gz', 'derived/topology-derived.json.gz', 'derived/locations.json.gz'];
const PHASES = ['moduleLoad', 'instanceLoad', 'compile', 'mapLoad', 'simulate', 'digest', 'serialize'];
const MIN_REPEATS = 5;

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function writeJsonGz(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }));
}
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exists = (file) => { try { fs.accessSync(file); return true; } catch { return false; } };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { args._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

function fail(message, code = 1) {
  process.stderr.write(`native-candidate: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// stack identity

function packagesRoot(args) {
  return path.resolve(args['packages-root'] ?? process.env.SIMFORGE_PACKAGES_ROOT ?? REPO_ROOT);
}

/** Same default as `packages/compiler/src/maps.ts` `DEV_ASSETS`; the compiler itself is not loaded here. */
function devAssetsRoot(args) {
  if (args['dev-assets']) return path.resolve(args['dev-assets']);
  if (process.env.SCEN_DEV_ASSETS) return path.resolve(process.env.SCEN_DEV_ASSETS);
  const cacheRoot = process.env.SIMFORGE_MAPS_CACHE_ROOT
    ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'maps');
  return path.join(path.resolve(cacheRoot), 'dev-assets');
}

/** The built façade files the adapter imports; `null` where the build is missing. */
function distFiles(root) {
  const engine = path.join(root, 'packages', 'engine', 'dist', 'node.js');
  const shared = path.join(root, 'packages', 'native-runtime', 'dist', 'shared.js');
  return { engine: exists(engine) ? engine : null, shared: exists(shared) ? shared : null };
}

function gitIdentity(dir) {
  const run = (cmd) => spawnSync('git', cmd, { cwd: dir, encoding: 'utf8' });
  const head = run(['rev-parse', 'HEAD']);
  if (head.status !== 0) return null;
  return {
    head: head.stdout.trim(),
    dirty: run(['status', '--porcelain']).stdout.trim().length > 0,
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(),
  };
}

function hostIdentity() {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
  };
}

function mapIdentity(devAssets, mapId) {
  const dir = path.join(devAssets, mapId);
  const members = {};
  for (const member of MAP_MEMBERS) {
    const file = path.join(dir, member);
    members[member] = exists(file) ? sha256File(file) : null;
  }
  return { mapId, dir, present: Object.values(members).every(Boolean), members };
}

// ---------------------------------------------------------------------------
// reference inventory


/**
 * The executable rows of one reference run. Each row names the pinned input
 * files (never a template, site or fixture program) and the identities the
 * native execution must reproduce.
 */
function referenceRows(referenceDir, referenceRun) {
  return referenceRun.scenarios.map((row) => {
    const scenarioDir = path.join(referenceDir, row.id);
    if (row.status !== 'completed') {
      return { id: row.id, kind: row.kind, mapId: row.mapId, referenceStatus: row.status, legs: [], policy: null, prepareError: null };
    }
    try {
      const base = {
        leg: 'base', relDir: '',
        instance: instancePath(row, scenarioDir),
        runtime: exists(path.join(scenarioDir, 'runtime.json')) ? path.join(scenarioDir, 'runtime.json') : null,
        expectedInputHash: row.inputHash,
        referenceTraceDigest: row.traceDigest,
      };
      const legs = [base];
      const interventionInstance = path.join(scenarioDir, 'intervention', 'instance.json');
      if (exists(interventionInstance)) {
        legs.push({
          leg: 'intervention', relDir: 'intervention',
          instance: interventionInstance, runtime: null,
          expectedInputHash: row.legs?.intervention?.inputHash ?? null,
          referenceTraceDigest: row.legs?.intervention?.traceDigest ?? null,
        });
      }
      let policy = null;
      if (row.kind === 'situation') {
        const fixturePath = path.join(scenarioDir, 'fixture.json');
        const fixture = readJson(fixturePath);
        if (fixture.policy) policy = { ...fixture.policy, fixture: fixturePath };
      }
      return { id: row.id, kind: row.kind, mapId: row.mapId, referenceStatus: row.status, legs, policy, prepareError: null };
    } catch (error) {
      return { id: row.id, kind: row.kind, mapId: row.mapId, referenceStatus: row.status, legs: [], policy: null, prepareError: String(error?.message ?? error) };
    }
  });
}

/** Every executable input must be sealed beside the reference evidence. */
function instancePath(row, scenarioDir) {
  const recorded = path.join(scenarioDir, 'instance.json');
  if (!exists(recorded)) throw new Error(`reference row ${row.id} (${row.kind}) completed but recorded no instance.json`);
  return recorded;
}

// ---------------------------------------------------------------------------
// status

async function cmdStatus(args) {
  const root = packagesRoot(args);
  const files = distFiles(root);
  const report = {
    packagesRoot: root,
    git: gitIdentity(root),
    dist: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, file ? { file, sha256: sha256File(file) } : null])),
    runtime: null,
    runtimeError: null,
    devAssets: devAssetsRoot(args),
    host: hostIdentity(),
  };
  if (files.engine && files.shared) {
    try {
      const engine = await import(pathToFileURL(files.engine).href);
      report.runtime = engine.runtimeIdentity();
      report.simulationResultJson = typeof engine.engine().module.Simulation?.prototype?.resultJson === 'function';
    } catch (error) {
      report.runtimeError = String(error?.message ?? error);
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return files.engine && files.shared && report.runtime ? 0 : 3;
}

// ---------------------------------------------------------------------------
// run (parent)

async function cmdRun(args) {
  if (!args.reference || !args.out) fail('run requires --reference DIR and --out DIR');
  const referenceDir = path.resolve(args.reference);
  const outDir = path.resolve(args.out);
  const repeats = Number(args.repeats ?? MIN_REPEATS);
  if (!Number.isInteger(repeats) || repeats < MIN_REPEATS) fail(`--repeats must be an integer >= ${MIN_REPEATS} (one cold iteration plus warm repeats for a measured comparison)`);
  const referenceRunFile = path.join(referenceDir, 'run.json');
  if (!exists(referenceRunFile)) fail(`${referenceDir} holds no run.json`);
  const referenceRun = readJson(referenceRunFile);
  if (exists(path.join(outDir, 'run.json'))) fail(`${outDir} already holds a run; use a fresh output directory`, 2);

  const root = packagesRoot(args);
  const files = distFiles(root);
  if (!files.engine || !files.shared) {
    fail(`native façade not built under ${root}: need packages/engine/dist/node.js and packages/native-runtime/dist/shared.js (pnpm install; pnpm --filter @simforge-oss/native-runtime build; pnpm --filter @simforge-oss/engine build)`, 3);
  }
  let runtime;
  try {
    const engine = await import(pathToFileURL(files.engine).href);
    runtime = engine.runtimeIdentity();
  } catch (error) {
    fail(`native runtime unavailable: ${String(error?.message ?? error)}`, 3);
  }
  const devAssets = devAssetsRoot({ ...args, 'dev-assets': args['dev-assets'] ?? referenceRun.devAssets });

  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const rows = referenceRows(referenceDir, referenceRun).filter((row) => !only || only.has(row.id));
  if (rows.length === 0) fail('no scenarios selected');
  fs.mkdirSync(outDir, { recursive: true });

  const maps = [...new Set(rows.map((row) => row.mapId))].sort().map((mapId) => {
    const identity = mapIdentity(devAssets, mapId);
    const reference = referenceRun.maps?.find((row) => row.mapId === mapId) ?? null;
    return { ...identity, matchesReference: reference ? MAP_MEMBERS.every((member) => reference.members?.[member] === identity.members[member]) : null };
  });
  const mismatchedMaps = maps.filter((map) => !map.present || map.matchesReference !== true);
  if (mismatchedMaps.length > 0) {
    writeJson(path.join(outDir, 'map-identity.json'), {
      status: 'blocked', reference: referenceDir, devAssets, maps,
      reason: 'candidate map bytes must match the frozen reference before execution',
    });
    fail(`map identity mismatch for ${mismatchedMaps.map((map) => map.mapId).join(', ')}; use --dev-assets with the frozen map corpus (details: ${path.join(outDir, 'map-identity.json')})`, 3);
  }

  const results = [];
  for (const row of rows) {
    const scenarioDir = path.join(outDir, row.id);
    fs.mkdirSync(scenarioDir, { recursive: true });
    const resultFile = path.join(scenarioDir, 'result.json');
    if (row.referenceStatus !== 'completed') {
      const result = {
        schema: RESULT_SCHEMA, id: row.id, kind: row.kind, mapId: row.mapId, status: 'reference-failed', referenceStatus: row.referenceStatus,
        reason: 'the reference run recorded no executed input for this row; there is nothing for the candidate to execute',
        legs: {}, iterations: { requested: 0, completed: 0, failed: 0, errors: [] }, timingMs: null,
      };
      writeJson(resultFile, result);
      results.push(result);
      process.stderr.write(`[candidate] ${row.id}: reference-failed (${row.referenceStatus})\n`);
      continue;
    }
    if (row.prepareError) {
      const result = {
        schema: RESULT_SCHEMA, id: row.id, kind: row.kind, mapId: row.mapId, status: 'failed', referenceStatus: row.referenceStatus,
        error: { message: row.prepareError },
        legs: {}, iterations: { requested: 0, completed: 0, failed: 0, errors: [{ iteration: 0, message: row.prepareError }] }, timingMs: null,
      };
      writeJson(resultFile, result);
      results.push(result);
      process.stderr.write(`[candidate] ${row.id}: failed (${row.prepareError})\n`);
      continue;
    }
    const spec = { row, repeats, scenarioDir, packagesRoot: root, devAssets, files };
    const specFile = path.join(scenarioDir, 'spec.json');
    writeJson(specFile, spec);
    process.stderr.write(`[candidate] ${row.id} (${row.kind}, ${row.legs.length} leg${row.legs.length === 1 ? '' : 's'}, ${repeats} iterations)\n`);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'run-one', '--spec', specFile], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NODE_CHANNEL_FD: undefined, NODE_CHANNEL_SERIALIZATION_MODE: undefined },
    });
    let result;
    if (child.status === 0 && exists(resultFile)) {
      result = readJson(resultFile);
    } else {
      result = {
        schema: RESULT_SCHEMA, id: row.id, kind: row.kind, mapId: row.mapId, status: 'failed', referenceStatus: row.referenceStatus,
        error: { exitCode: child.status, signal: child.signal, stderr: (child.stderr ?? '').slice(-4000), stdout: (child.stdout ?? '').slice(-2000) },
        legs: {}, iterations: { requested: repeats * row.legs.length, completed: 0, failed: repeats * row.legs.length, errors: [] }, timingMs: null,
      };
      writeJson(resultFile, result);
    }
    process.stderr.write(`[candidate] ${row.id}: ${result.status}${result.traceDigest ? ` ${result.traceDigest.slice(0, 16)}` : ''}${result.inputHashMatchesReference === false ? ' (inputHash differs from reference)' : ''}\n`);
    results.push(result);
  }

  const summary = {
    schema: RUN_SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    measurement: 'executed-input conformance: pinned reference instance.json/runtime.json executed natively; no site matching, materialisation, ambient generation or threshold derivation',
    reference: {
      dir: referenceDir,
      schema: referenceRun.schema,
      generatedAt: referenceRun.generatedAt,
      stack: referenceRun.stack ?? null,
      scenarios: referenceRun.scenarios.length,
      inputContractProjection: referenceRun.inputContractProjection ?? null,
    },
    stack: {
      packagesRoot: root,
      git: gitIdentity(root),
      dist: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, { file, sha256: sha256File(file) }])),
      runtime,
      ...hostIdentity(),
    },
    devAssets,
    maps,
    repeats,
    scenarios: results.map((result) => ({
      id: result.id, kind: result.kind, status: result.status, mapId: result.mapId, referenceStatus: result.referenceStatus,
      inputHash: result.inputHash ?? null, inputHashMatchesReference: result.inputHashMatchesReference ?? null,
      traceDigest: result.traceDigest ?? null, traceDigestEqualsReference: result.traceDigestEqualsReference ?? null,
      replayStable: result.replayStable ?? null,
      legs: result.legs ?? {},
      policy: result.policy ?? null,
      iterations: result.iterations,
      timingMs: result.timingMs ?? null,
      error: result.error ?? null,
    })),
    counts: {
      scenarios: results.length,
      legs: results.reduce((n, result) => n + Object.keys(result.legs ?? {}).length, 0),
      completed: results.filter((result) => result.status === 'completed').length,
      failed: results.filter((result) => result.status === 'failed' || result.status === 'partial').length,
      referenceFailed: results.filter((result) => result.status === 'reference-failed').length,
      notRun: referenceRun.scenarios.length - results.length,
      replayStable: results.filter((result) => result.replayStable === true).length,
      inputHashMatchesReference: results.filter((result) => result.inputHashMatchesReference === true).length,
    },
  };
  writeJson(path.join(outDir, 'run.json'), summary);
  process.stdout.write(`${JSON.stringify({ out: outDir, counts: summary.counts }, null, 2)}\n`);
  return summary.counts.failed === 0 ? 0 : 2;
}

// ---------------------------------------------------------------------------
// run-one (child): one reference row, cold iteration then warm repeats

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function stats(values) {
  if (values.length === 0) return null;
  return { n: values.length, min: Math.min(...values), median: median(values), max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length };
}

class Phases {
  constructor() { for (const phase of PHASES) this[phase] = []; }
  async time(phase, fn) {
    const t0 = performance.now();
    const value = await fn();
    this[phase].push(performance.now() - t0);
    return value;
  }
  report() {
    return Object.fromEntries(PHASES.map((phase) => [phase, { cold: this[phase][0] ?? null, warm: stats(this[phase].slice(1)) }]));
  }
}

/**
 * The fixture's `policy` as a per-tick action supplier: `{ targetSpeedMps }`
 * from the latest schedule row with `fromS <= tS` for every tick with
 * `tS >= schedule[0].fromS`, nothing before (fixture.json `semantics`).
 */
function schedulePolicy(policy) {
  if (policy.kind !== 'target-speed-schedule') throw new Error(`unsupported policy kind ${policy.kind} in ${policy.fixture}`);
  const rows = [...policy.schedule].sort((a, b) => a.fromS - b.fromS);
  return (tS) => {
    if (tS < rows[0].fromS) return null;
    let row = rows[0];
    for (const candidate of rows) if (tS >= candidate.fromS) row = candidate;
    return { targetSpeedMps: row.targetSpeedMps };
  };
}

/**
 * Execute the pinned input with the policy on the native `Simulation` action
 * channel: one `advance(1, actions)` per tick, actions supplied from the
 * schedule, then the completed `SimResult` from the same session. This is the
 * loop the native situation rehearsal runs; no compiler is involved.
 */
function runWithPolicy(engine, shared, scenario, graph, optionsJson, policy) {
  const module = engine.module;
  if (typeof module.Simulation !== 'function') throw new Error('native runtime exposes no Simulation class');
  if (typeof module.Simulation.prototype.resultJson !== 'function') {
    throw new Error('native Simulation has no resultJson(): the binding cannot return the completed SimResult of a stepped world (required to execute the recorded-policy handover on the action channel)');
  }
  const supply = schedulePolicy(policy);
  const sim = new module.Simulation(scenario, graph, optionsJson);
  const actorIndex = sim.actorIndex(policy.roleId);
  const row = new Float64Array(1 + shared.ACTION_WIDTH);
  row[0] = actorIndex;
  let actionCalls = 0;
  let firstActionT = null;
  let ticks = 0;
  const warmupTicks = Math.round(scenario.warmupSeconds / sim.dtS);
  const finalTick = warmupTicks + Math.round(scenario.clipSeconds / sim.dtS);
  while (!sim.done) {
    // tS describes the last processed tick; actions apply to the upcoming
    // planning tick. The final tick records observations but does not plan.
    const tS = (sim.tickIndex - warmupTicks) * sim.dtS;
    const action = sim.tickIndex < finalTick ? supply(tS) : null;
    if (action) {
      shared.encodeAction(action, row.subarray(1));
      sim.advance(1, row);
      actionCalls += 1;
      if (firstActionT === null) firstActionT = tS;
    } else {
      sim.advance(1, null);
    }
    ticks += 1;
  }
  const result = JSON.parse(sim.resultJson());
  return { result, policyWitness: { roleId: policy.roleId, actionCalls: { [policy.roleId]: actionCalls }, firstActionT, ticksAdvanced: ticks, schedule: policy.schedule } };
}

const mapCache = new Map();

/** Execute one leg `repeats` times in this process; iteration 0 is the cold sample. */
async function executeLeg({ engine, shared, phases, leg, policy, mapDir }) {
  const digests = [];
  const errors = [];
  let first = null;
  const runtime = leg.runtime ? readJson(leg.runtime) : null;
  const optionsJson = runtime ? JSON.stringify(runtime) : null;
  for (let iteration = 0; iteration < leg.repeats; iteration += 1) {
    try {
      const scenario = await phases.time('instanceLoad', () => engine.scenario(fs.readFileSync(leg.instance, 'utf8')));
      // Memoised per process like the reference's map loader: the cold sample is a real load, warm samples a lookup.
      const map = await phases.time('mapLoad', () => (mapCache.get(mapDir) ?? mapCache.set(mapDir, engine.module.MapBundle.load(mapDir)).get(mapDir)));
      const outcome = await phases.time('simulate', () => (policy
        ? runWithPolicy(engine, shared, scenario, map.graph, optionsJson, policy)
        : { result: engine.runSimulation(scenario, { graph: map.graph, ...(runtime ?? {}) }), policyWitness: null }));
      const handle = await phases.time('digest', () => engine.trace(outcome.result.trace));
      const digest = handle.digest();
      digests.push(digest);
      const gz = await phases.time('serialize', () => zlib.gzipSync(Buffer.from(handle.canonicalJson()), { level: 9 }));
      if (!first) first = { result: outcome.result, digest, policyWitness: outcome.policyWitness, scenarioContentHash: scenario.contentHash, gz };
    } catch (error) {
      errors.push({ iteration, message: String(error?.stack ?? error).slice(0, 4000) });
    }
  }
  return { digests, errors, first, runtime };
}

function writeLeg(dir, leg, execution) {
  const trace = execution.first.result.trace;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trace.json.gz'), execution.first.gz);
  const discrete = discreteSignature(trace, { traceDigest: execution.first.digest, inputHash: trace.header.inputHash });
  writeJson(path.join(dir, 'signature.json'), discrete);
  writeJsonGz(path.join(dir, 'numeric.json.gz'), numericSignature(trace));
  writeJson(path.join(dir, 'engine-result.json'), {
    issues: execution.first.result.issues,
    arrival: execution.first.result.arrival,
    ...(execution.first.policyWitness ? { policy: execution.first.policyWitness } : {}),
  });
  const completed = execution.digests.length;
  return {
    status: execution.errors.length === 0 ? 'completed' : 'partial',
    instance: leg.instance,
    runtime: execution.runtime,
    inputHash: trace.header.inputHash,
    scenarioContentHash: execution.first.scenarioContentHash,
    expectedInputHash: leg.expectedInputHash,
    inputHashMatchesReference: trace.header.inputHash === leg.expectedInputHash,
    traceDigest: execution.first.digest,
    referenceTraceDigest: leg.referenceTraceDigest,
    traceDigestEqualsReference: execution.first.digest === leg.referenceTraceDigest,
    replayStable: execution.digests.every((digest) => digest === execution.digests[0]),
    tickCount: discrete.tickCount,
    events: discrete.events.length,
    engineVersion: discrete.engineVersion,
    collisions: trace.metrics.collisions.length,
    issues: execution.first.result.issues.length,
    ...(execution.first.policyWitness ? { actionCalls: execution.first.policyWitness.actionCalls } : {}),
    iterations: { requested: completed + execution.errors.length, completed, failed: execution.errors.length, errors: execution.errors },
  };
}

async function cmdRunOne(args) {
  const spec = readJson(args.spec);
  const { row, repeats, scenarioDir, devAssets, files } = spec;
  const phases = new Phases();
  const started = performance.now();
  let modules = null;
  let loadError = null;
  try {
    modules = await phases.time('moduleLoad', async () => {
      const engineModule = await import(pathToFileURL(files.engine).href);
      const shared = await import(pathToFileURL(files.shared).href);
      return { engine: engineModule.engine(), shared, identity: engineModule.runtimeIdentity() };
    });
  } catch (error) {
    loadError = { iteration: 0, message: String(error?.stack ?? error).slice(0, 4000) };
  }
  const legs = {};
  const allErrors = loadError ? [loadError] : [];
  const mapDir = path.join(devAssets, row.mapId);
  if (modules) {
    for (const leg of row.legs) {
      const dir = leg.relDir ? path.join(scenarioDir, leg.relDir) : scenarioDir;
      const legPhases = leg.leg === 'base' ? phases : new Phases();
      const execution = await executeLeg({ ...modules, phases: legPhases, leg: { ...leg, repeats }, policy: row.policy, mapDir });
      if (!execution.first) {
        legs[leg.leg] = {
          status: 'failed', instance: leg.instance, runtime: execution.runtime, expectedInputHash: leg.expectedInputHash, referenceTraceDigest: leg.referenceTraceDigest,
          iterations: { requested: repeats, completed: 0, failed: execution.errors.length, errors: execution.errors },
        };
        allErrors.push(...execution.errors);
        continue;
      }
      legs[leg.leg] = writeLeg(dir, leg, execution);
      allErrors.push(...execution.errors);
      if (leg.leg !== 'base') legs[leg.leg].timingMs = legPhases.report();
    }
  }
  const legRows = Object.values(legs);
  const requested = repeats * row.legs.length;
  const completed = legRows.reduce((n, leg) => n + leg.iterations.completed, 0);
  const base = legs.base ?? null;
  const status = !modules ? 'failed'
    : legRows.length === row.legs.length && legRows.every((leg) => leg.status === 'completed') ? 'completed'
      : legRows.some((leg) => leg.status === 'completed' || leg.status === 'partial') ? 'partial' : 'failed';
  const result = {
    schema: RESULT_SCHEMA,
    id: row.id, kind: row.kind, mapId: row.mapId, status, referenceStatus: row.referenceStatus,
    runtime: modules?.identity ?? null,
    inputHash: base?.inputHash ?? null,
    inputHashMatchesReference: base?.inputHashMatchesReference ?? null,
    traceDigest: base?.traceDigest ?? null,
    traceDigestEqualsReference: base?.traceDigestEqualsReference ?? null,
    replayStable: legRows.length ? legRows.every((leg) => leg.replayStable === true) : null,
    tickCount: base?.tickCount ?? null,
    events: base?.events ?? null,
    policy: row.policy ? { fixture: row.policy.fixture, roleId: row.policy.roleId, kind: row.policy.kind, schedule: row.policy.schedule, channel: 'native Simulation.advance(1, [actorIndex, ...action]) per tick, SimResult from Simulation.resultJson()' } : null,
    legs,
    iterations: { requested, completed, failed: requested - completed, errors: allErrors },
    timingMs: phases.report(),
    wallMs: performance.now() - started,
  };
  writeJson(path.join(scenarioDir, 'result.json'), result);
  return 0;
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const commands = { status: cmdStatus, run: cmdRun, 'run-one': cmdRunOne };
if (!commands[command]) fail('usage: native-candidate.mjs status|run (see header comment)');
try {
  process.exitCode = await commands[command](args);
} catch (error) {
  fail(String(error?.stack ?? error));
}
