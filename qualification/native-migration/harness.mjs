#!/usr/bin/env node
/**
 * Native-migration qualification harness (BASE work package).
 *
 *   node qualification/native-migration/harness.mjs status
 *   node qualification/native-migration/harness.mjs record  --out DIR [--repeats 5] [--only ID,ID] [--packages-root DIR]
 *   node qualification/native-migration/harness.mjs compare --reference DIR --candidate DIR [--class conformance|replay] [--out FILE]
 *
 * `record` executes every pinned real scenario (scenarios.json) through the
 * current TypeScript reference path — the same calls `simforge simulate`
 * makes — in one fresh child process per scenario so the first iteration is
 * a genuine cold measurement (module import, map load) and the remaining
 * iterations are warm. It writes, per scenario, the discrete and numeric
 * signatures (lib/signature.mjs), the gzipped trace, phase timings and the
 * exact stack identity (package dist digests, map member digests, node,
 * hardware). Failures are recorded as failures; nothing is retried or dropped.
 *
 * `compare` evaluates a candidate directory produced in the same layout by
 * another implementation (the Rust runner writes `<id>/signature.json` and
 * `<id>/numeric.json.gz`). Discrete signatures must match exactly; numeric
 * channels are checked against the frozen tolerance class. A scenario without
 * a candidate is reported `not-run`, never inferred.
 *
 * `status` reports what is reachable on this machine: built packages, maps,
 * scenario files, and the separately-owned protocol evidence (protocols.json).
 * It executes nothing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { compareDiscrete, compareNumeric, discreteSignature, numericSignature, SIGNATURE_SCHEMA } from './lib/signature.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCENARIOS = readJson(path.join(HERE, 'scenarios.json'));
const TOLERANCES = readJson(path.join(HERE, 'tolerances.json'));
const PROTOCOLS = readJson(path.join(HERE, 'protocols.json'));
const RESULT_SCHEMA = 'simforge.native-migration.reference-run/v1';
const MAP_MEMBERS = ['map.xodr', 'signals.geojson.gz', 'topology-index.json.gz', 'derived/topology-derived.json.gz', 'derived/locations.json.gz'];

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function writeJsonGz(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 6 }));
}
function readJsonGz(file) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); }
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exists = (file) => { try { fs.accessSync(file); return true; } catch { return false; } };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// stack identity

function packagesRoot(args) {
  return path.resolve(args['packages-root'] ?? process.env.SIMFORGE_PACKAGES_ROOT ?? REPO_ROOT);
}

function distFiles(root) {
  return {
    engine: path.join(root, 'packages/engine/dist/index.js'),
    compilerNode: path.join(root, 'packages/compiler/dist/node.js'),
    compiler: path.join(root, 'packages/compiler/dist/index.js'),
    scenario: path.join(root, 'packages/scenario/dist/index.js'),
  };
}

function gitIdentity(dir) {
  const run = (argsList) => {
    const result = spawnSync('git', ['-C', dir, ...argsList], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const head = run(['rev-parse', 'HEAD']);
  if (!head) return null;
  const dirty = run(['status', '--porcelain', '--untracked-files=no']);
  return { head, dirty: dirty === null ? null : dirty.length > 0, branch: run(['branch', '--show-current']) };
}

function stackIdentity(root) {
  const files = distFiles(root);
  const versions = {};
  for (const pkg of ['engine', 'compiler', 'scenario', 'maps', 'asset-catalog']) {
    const file = path.join(root, 'packages', pkg, 'package.json');
    versions[pkg] = exists(file) ? readJson(file).version : null;
  }
  return {
    packagesRoot: root,
    git: gitIdentity(root),
    packageVersions: versions,
    dist: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, exists(file) ? { file, sha256: sha256File(file) } : null])),
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
  };
}

function mapIdentity(devAssets, mapId) {
  const dir = path.join(devAssets, mapId);
  const receipt = path.join(dir, '.map-release.json');
  const members = {};
  for (const member of MAP_MEMBERS) {
    const file = path.join(dir, member);
    members[member] = exists(file) ? sha256File(file) : null;
  }
  return {
    mapId,
    dir,
    present: Object.values(members).every(Boolean),
    releaseDigest: exists(receipt) ? readJson(receipt).releaseDigest ?? null : null,
    members,
  };
}

// ---------------------------------------------------------------------------
// status

function scenarioFiles() {
  const rows = [];
  for (const entry of SCENARIOS.scenarios) {
    rows.push({ id: entry.id, kind: 'instance', mapId: entry.mapId, file: entry.instance, present: exists(path.join(REPO_ROOT, entry.instance)) });
  }
  for (const entry of SCENARIOS.compiled.entries) {
    rows.push({ id: entry.id, kind: 'compiled', mapId: entry.mapId, file: entry.template, present: exists(path.join(REPO_ROOT, entry.template)) });
  }
  for (const entry of SCENARIOS.situations) {
    rows.push({ id: entry.id, kind: 'situation', mapId: entry.mapId, file: entry.fixture, present: exists(path.join(REPO_ROOT, entry.fixture, 'fixture.json')) });
  }
  for (const entry of SCENARIOS.thresholdCorpus.entries) {
    const base = rows.find((row) => row.id === entry.base);
    rows.push({ id: entry.id, kind: 'threshold', mapId: base?.mapId ?? null, file: entry.base, present: Boolean(base?.present) });
  }
  return rows;
}

async function resolveDevAssets(root) {
  const files = distFiles(root);
  if (!exists(files.compilerNode)) return { devAssets: null, source: 'compiler dist missing' };
  const compiler = await import(pathToFileURL(files.compilerNode).href);
  return { devAssets: compiler.DEV_ASSETS, source: process.env.SCEN_DEV_ASSETS ? 'SCEN_DEV_ASSETS' : 'compiler default (map registry cache)' };
}

function protocolStatus() {
  return PROTOCOLS.protocols.map((protocol) => ({
    id: protocol.id,
    status: protocol.status,
    evidence: protocol.evidence.map((item) => {
      const file = item.relativeToRepo ? path.join(REPO_ROOT, item.path) : item.path;
      const reachable = exists(file);
      return {
        ...item,
        reachable,
        sha256: reachable && fs.statSync(file).isFile() ? sha256File(file) : null,
      };
    }),
  }));
}

async function cmdStatus(args) {
  const root = packagesRoot(args);
  const stack = stackIdentity(root);
  const { devAssets, source } = await resolveDevAssets(root);
  const mapIds = [...new Set(scenarioFiles().map((row) => row.mapId))].sort();
  const report = {
    schema: 'simforge.native-migration.status/v1',
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    stack,
    builtPackagesAvailable: Object.values(stack.dist).every(Boolean),
    devAssets: { root: devAssets, source },
    maps: devAssets ? mapIds.map((mapId) => mapIdentity(devAssets, mapId)) : mapIds.map((mapId) => ({ mapId, present: false })),
    scenarios: scenarioFiles(),
    coverageGaps: SCENARIOS.coverageGaps,
    protocols: protocolStatus(),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// record (parent)

async function cmdRecord(args) {
  if (!args.out) fail('record requires --out DIR');
  const outDir = path.resolve(args.out);
  const repeats = Number(args.repeats ?? 5);
  if (!Number.isInteger(repeats) || repeats < 1) fail('--repeats must be a positive integer');
  const root = packagesRoot(args);
  const stack = stackIdentity(root);
  if (!Object.values(stack.dist).every(Boolean)) {
    fail(`built packages missing under ${root}: run the workspace build first (engine/compiler dist)`, 3);
  }
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const allEntries = [
    ...SCENARIOS.scenarios.map((entry) => ({ ...entry, kind: 'instance' })),
    ...SCENARIOS.compiled.entries.map((entry) => ({ ...entry, kind: 'compiled', seed: entry.seed ?? SCENARIOS.compiled.seed })),
    ...SCENARIOS.situations.map((entry) => ({ ...entry, kind: 'situation' })),
    ...SCENARIOS.thresholdCorpus.entries.map((entry) => ({ ...entry, kind: 'threshold' })),
  ];
  const byId = new Map(allEntries.map((entry) => [entry.id, entry]));
  for (const entry of allEntries) {
    if (entry.kind !== 'threshold') continue;
    const baseEntry = byId.get(entry.base);
    if (!baseEntry || !['instance', 'compiled'].includes(baseEntry.kind)) fail(`threshold entry ${entry.id} names unknown base ${entry.base}`);
    entry.baseEntry = baseEntry;
    entry.mapId = baseEntry.mapId;
  }
  // A threshold derivation reads its compiled base from this run, so bases run first.
  const entries = allEntries.filter((entry) => !only || only.has(entry.id) || (entry.kind !== 'threshold' && [...only].some((id) => byId.get(id)?.base === entry.id)));
  if (entries.length === 0) fail('no scenarios selected');
  if (exists(path.join(outDir, 'run.json'))) fail(`${outDir} already holds a run; use a fresh output directory`, 2);
  fs.mkdirSync(outDir, { recursive: true });
  const { devAssets } = await resolveDevAssets(root);

  const results = [];
  const derivations = [];
  for (const entry of entries) {
    const scenarioDir = path.join(outDir, entry.id);
    const spec = { entry, repeats, scenarioDir, runDir: outDir, packagesRoot: root, repoRoot: REPO_ROOT };
    fs.mkdirSync(scenarioDir, { recursive: true });
    const specFile = path.join(scenarioDir, 'spec.json');
    writeJson(specFile, spec);
    process.stderr.write(`[record] ${entry.id} (${entry.kind}, ${repeats} iterations)\n`);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'run-one', '--spec', specFile], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NODE_CHANNEL_FD: undefined, NODE_CHANNEL_SERIALIZATION_MODE: undefined },
    });
    const resultFile = path.join(scenarioDir, 'result.json');
    let result;
    if (child.status === 0 && exists(resultFile)) {
      result = readJson(resultFile);
    } else {
      result = {
        id: entry.id, kind: entry.kind, status: 'failed', mapId: entry.mapId,
        error: { exitCode: child.status, signal: child.signal, stderr: (child.stderr ?? '').slice(-4000), stdout: (child.stdout ?? '').slice(-2000) },
        iterations: { requested: repeats, completed: 0, failed: repeats },
      };
      writeJson(resultFile, result);
    }
    process.stderr.write(`[record] ${entry.id}: ${result.status}${result.traceDigest ? ` ${result.traceDigest.slice(0, 16)}` : ''}${result.variantCount !== undefined ? ` (${result.variantCount} variants)` : ''}\n`);
    if (result.kind === 'threshold') {
      derivations.push({ id: result.id, status: result.status, base: result.base, interactionId: result.interactionId ?? null, authoredValue: result.authoredValue ?? null, baseTrigger: result.baseTrigger ?? null, variants: result.variants ?? [], error: result.iterations?.errors?.[0]?.message ?? null });
      results.push(...(result.children ?? []));
    } else {
      results.push(result);
    }
  }
  const summary = {
    schema: RESULT_SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    stack,
    devAssets,
    maps: [...new Set(entries.map((entry) => entry.mapId))].sort().map((mapId) => (devAssets ? mapIdentity(devAssets, mapId) : { mapId, present: false })),
    repeats,
    scenarios: results.map((result) => ({
      id: result.id, kind: result.kind, status: result.status, mapId: result.mapId,
      inputHash: result.inputHash ?? null, traceDigest: result.traceDigest ?? null,
      replayStable: result.replayStable ?? null,
      recordedTrace: result.recordedTrace ?? null,
      compileIdentity: result.compileIdentity ?? null,
      threshold: result.threshold ?? null,
      fixture: result.fixture ?? null,
      legs: result.legs ?? null,
      comparison: result.comparison ?? null,
      artifacts: result.artifacts ? { retained: result.artifacts.retained.map((row) => ({ label: row.label, retainedVerified: row.retainedVerified, originalVerified: row.originalVerified })), sources: result.artifacts.sources } : null,
      iterations: result.iterations,
      timingMs: result.timingMs ?? null,
    })),
    derivations,
    counts: {
      scenarios: results.length,
      completed: results.filter((result) => result.status === 'completed').length,
      failed: results.filter((result) => result.status !== 'completed').length,
      derivations: derivations.length,
      derivationsFailed: derivations.filter((row) => row.status !== 'derived').length,
    },
    coverageGaps: SCENARIOS.coverageGaps,
    protocols: protocolStatus(),
  };
  writeJson(path.join(outDir, 'run.json'), summary);
  process.stdout.write(`${JSON.stringify({ out: outDir, counts: summary.counts }, null, 2)}\n`);
  return summary.counts.failed === 0 && summary.counts.derivationsFailed === 0 ? 0 : 2;
}

// ---------------------------------------------------------------------------
// run-one (child): one scenario, cold iteration then warm repeats

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function stats(values) {
  if (values.length === 0) return null;
  return { n: values.length, min: Math.min(...values), median: median(values), max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length };
}
const PHASES = ['moduleLoad', 'instanceLoad', 'compile', 'mapLoad', 'simulate', 'digest', 'serialize'];

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

function fileSha(file) { return sha256File(file); }

/** Resolve a pinned matcher site; a witness may accept a now-rejected pin. */
async function resolveSite(compiler, template, entry) {
  const match = await compiler.matchOnMap(template, entry.mapId, { maxSites: 100 });
  let site = entry.siteId ? match.report.sites.find((s) => s.siteId === entry.siteId) : match.report.sites[0];
  const rejectedPinned = entry.siteId ? match.report.rejected.find((s) => s.siteId === entry.siteId) : null;
  if (!site && entry.allowRejectedSite) site = rejectedPinned;
  if (!site) {
    throw new Error(`no accepted site for ${entry.id} on ${entry.mapId} (pinned ${entry.siteId ?? 'none'}; accepted ${match.report.sites.length}, rejected ${match.report.rejected.length}${rejectedPinned ? `; pinned site is rejected: ${rejectedPinned.degradation?.summary ?? 'degraded'}` : ''})`);
  }
  return site;
}

/** Deterministic open-loop policy from a fixture schedule (see fixture.json `policy`). */
function schedulePolicy(policy) {
  if (!policy) return undefined;
  if (policy.kind !== 'target-speed-schedule') throw new Error(`unsupported policy kind ${policy.kind}`);
  const rows = [...policy.schedule].sort((a, b) => a.fromS - b.fromS);
  return ({ actorId, tS }) => {
    if (actorId !== policy.roleId || tS < rows[0].fromS) return undefined;
    let row = rows[0];
    for (const candidate of rows) if (tS >= candidate.fromS) row = candidate;
    return { targetSpeedMps: row.targetSpeedMps };
  };
}

/**
 * Verify every artifact a situation fixture claims: retained copies by sha256
 * (required), external source artifacts by sha256 when reachable (reported).
 */
function verifySituationArtifacts(fixtureDir, fixture, program) {
  const retained = (fixture.retainedArtifacts ?? []).map((row) => {
    const local = path.join(fixtureDir, row.retainedAs);
    const localSha = exists(local) ? fileSha(local) : null;
    const originalFile = row.uri.replace(/^file:\/\//, '');
    const originalSha = exists(originalFile) ? fileSha(originalFile) : null;
    return { ...row, retainedVerified: localSha === row.sha256, originalReachable: originalSha !== null, originalVerified: originalSha === row.sha256 };
  });
  if (retained.some((row) => !row.retainedVerified)) {
    throw new Error(`retained artifact digest mismatch: ${retained.filter((row) => !row.retainedVerified).map((row) => row.label).join(', ')}`);
  }
  const sources = program.source.artifacts.map((row) => {
    const file = row.uri.startsWith('file://') ? row.uri.replace(/^file:\/\//, '') : row.uri;
    const reachable = exists(file) && fs.statSync(file).isFile();
    return { id: row.id, kind: row.kind, reachable, verified: reachable ? fileSha(file) === row.sha256 : null };
  });
  return {
    retained,
    sources: {
      total: sources.length,
      reachable: sources.filter((row) => row.reachable).length,
      verified: sources.filter((row) => row.verified === true).length,
      mismatched: sources.filter((row) => row.reachable && row.verified === false).map((row) => row.id),
      unreachable: sources.filter((row) => !row.reachable).map((row) => row.id),
    },
  };
}

/** Load a situation fixture into the exact program and options the compiler consumes. */
function loadSituationFixture(scenario, repoRoot, entry) {
  const fixtureDir = path.join(repoRoot, entry.fixture);
  const fixture = readJson(path.join(fixtureDir, 'fixture.json'));
  let program = scenario.parseSituationProgram(readJson(path.join(fixtureDir, fixture.program)));
  const applied = [];
  for (const transaction of fixture.transactions ?? []) {
    const result = scenario.applySituationTransaction(program, transaction.apply);
    program = result.program;
    applied.push({ id: transaction.id, revision: program.revision, digest: scenario.situationDigest(program) });
  }
  const geometryBindings = fixture.geometryBinding
    ? [readJson(path.join(fixtureDir, fixture.geometryBinding))]
    : [];
  return { fixtureDir, fixture, program, applied, geometryBindings };
}

/**
 * Threshold-near corpus: sample the base scenario's own predicate at a grid of
 * thresholds using the engine's pre-integration condition evaluation, keep the
 * adjacent grid values whose first-true tick differs (the crossing lies between
 * them), and emit those thresholds as variant instances. Only thresholds that
 * cross no later than the base trigger are admissible: after the base trigger
 * fires the base trajectory no longer predicts the variant.
 */
function deriveThresholdVariants(engine, baseInput, graph, entry) {
  const interaction = baseInput.interactions.find((row) => row.id === entry.interactionId);
  if (!interaction || interaction.trigger.kind !== 'when') throw new Error(`${entry.interactionId} is not a when-trigger in ${entry.base}`);
  const condition = interaction.trigger.condition;
  if (!('value' in condition) || !('cmp' in condition)) throw new Error(`${entry.interactionId} condition ${condition.kind} has no scalar threshold`);
  const authored = condition.value;
  const steps = entry.gridSteps ?? 40;
  const span = entry.gridSpan ?? 0.2;
  const grid = [];
  for (let k = -steps; k <= steps; k += 1) grid.push(+(authored * (1 + (span * k) / steps)).toFixed(6));
  const conditions = grid.map((value) => ({ ...condition, value }));
  const session = engine.createFixedStepSimulation(baseInput, { graph, guards: 'collect' });
  const firstTrue = new Array(grid.length).fill(null);
  const firstTrueT = new Array(grid.length).fill(null);
  const progress = session.advance(Number.POSITIVE_INFINITY, {
    trace: true,
    conditions,
    onConditions: ({ tickIndex, tS, values }) => {
      values.forEach((value, index) => { if (value && firstTrue[index] === null) { firstTrue[index] = tickIndex; firstTrueT[index] = tS; } });
    },
  });
  const baseFire = progress.trace?.events.find((event) => event.kind === 'trigger_fired' && event.interactionId === entry.interactionId) ?? null;
  const baseFireT = baseFire?.t ?? null;
  const admissible = (index) => firstTrueT[index] !== null && (baseFireT === null || firstTrueT[index] <= baseFireT + 1e-9);
  const pairs = [];
  for (let index = 1; index < grid.length; index += 1) {
    if (firstTrue[index - 1] !== firstTrue[index] && (admissible(index - 1) || admissible(index)) && !(firstTrueT[index - 1] === null && firstTrueT[index] === null)) {
      pairs.push({ lower: index - 1, upper: index, distance: Math.min(Math.abs(grid[index - 1] - authored), Math.abs(grid[index] - authored)) });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance);
  const chosen = new Set();
  for (const pair of pairs.slice(0, entry.maxPairs ?? 4)) { chosen.add(pair.lower); chosen.add(pair.upper); }
  const variants = [...chosen].sort((a, b) => a - b).map((index) => ({
    threshold: grid[index],
    gridIndex: index,
    predictedFirstTrueTick: firstTrue[index],
    predictedFirstTrueT: firstTrueT[index],
    admissible: admissible(index),
    input: engine.parseSimScenarioInput({
      ...baseInput,
      interactions: baseInput.interactions.map((row) => (row.id === interaction.id
        ? { ...row, trigger: { ...row.trigger, condition: { ...condition, value: grid[index] } } }
        : row)),
    }),
  }));
  return {
    interactionId: interaction.id, conditionKind: condition.kind, cmp: condition.cmp, authoredValue: authored,
    grid: { steps, span, values: grid, firstTrueTick: firstTrue, firstTrueT },
    baseTrigger: baseFire ? { t: baseFire.t, forced: baseFire.forced } : null,
    variants,
  };
}

/** Execute one prepared input `repeats` times; the first iteration is the cold sample. */
async function executeInput(engine, phases, input, runtime, repeats, outDir, prepare) {
  const digests = [];
  const errors = [];
  let first = null;
  for (let iteration = 0; iteration < repeats; iteration += 1) {
    try {
      const { input: iterationInput, graph } = await prepare(iteration);
      const result = await phases.time('simulate', () => engine.runSimulation(iterationInput, { graph, guards: 'collect', ...runtime }));
      const digest = await phases.time('digest', () => engine.traceDigest(result.trace));
      const gz = await phases.time('serialize', () => engine.encodeTraceGz(result.trace));
      digests.push(digest);
      if (!first) {
        first = { result, digest };
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'trace.json.gz'), Buffer.from(gz));
      }
    } catch (error) {
      errors.push({ iteration, message: String(error?.stack ?? error).slice(0, 4000) });
    }
  }
  void input;
  return { digests, errors, first };
}

function writeSignatures(outDir, trace, digest, extra) {
  const inputHash = trace.header.inputHash;
  const discrete = discreteSignature(trace, { traceDigest: digest, inputHash });
  writeJson(path.join(outDir, 'signature.json'), discrete);
  writeJsonGz(path.join(outDir, 'numeric.json.gz'), numericSignature(trace));
  if (extra) writeJson(path.join(outDir, 'engine-result.json'), extra);
  return { inputHash, discrete };
}

function finishResult(outDir, entry, execution, discrete, phases, fields) {
  const completed = execution.digests.length;
  const requested = completed + execution.errors.length;
  const result = {
    id: fields.id ?? entry.id, kind: entry.kind, mapId: entry.mapId,
    status: execution.errors.length === 0 ? 'completed' : 'partial',
    inputHash: discrete.inputHash, traceDigest: execution.digests[0],
    replayStable: execution.digests.every((digest) => digest === execution.digests[0]),
    iterations: { requested, completed, failed: execution.errors.length, errors: execution.errors },
    timingMs: phases.report(),
    tickCount: discrete.tickCount, events: discrete.events.length,
    ...fields,
  };
  writeJson(path.join(outDir, 'result.json'), result);
  return result;
}

function failedResult(outDir, entry, repeats, errors, phases, fields = {}) {
  const result = {
    id: fields.id ?? entry.id, kind: entry.kind, mapId: entry.mapId, status: 'failed',
    iterations: { requested: repeats, completed: 0, failed: repeats, errors },
    timingMs: { moduleLoad: phases.moduleLoad[0] ?? null }, ...fields,
  };
  writeJson(path.join(outDir, 'result.json'), result);
  return result;
}

async function runInstanceOrCompiled({ entry, repeats, scenarioDir, repoRoot, engine, compiler, phases }) {
  let input = null;
  let compileIdentity = null;
  const runtime = entry.runtime ?? {};
  const execution = await executeInput(engine, phases, null, runtime, repeats, scenarioDir, async (iteration) => {
    let bundle;
    if (entry.kind === 'instance') {
      const instance = await phases.time('instanceLoad', () => compiler.readInstance(path.join(repoRoot, entry.instance)));
      if (iteration === 0) input = instance.input;
      bundle = await phases.time('mapLoad', () => compiler.loadMap(instance.input.mapId));
    } else {
      const template = await phases.time('instanceLoad', () => compiler.readTemplate(path.join(repoRoot, entry.template)));
      bundle = await phases.time('mapLoad', () => compiler.loadMap(entry.mapId));
      const materialized = await phases.time('compile', async () => {
        const site = await resolveSite(compiler, template, entry);
        return { site, ...compiler.materialize(template, bundle, site, {
          seed: entry.seed,
          ...(entry.drawIndex === undefined ? {} : { drawIndex: entry.drawIndex }),
          ...(entry.ambient ? { ambient: entry.ambient } : {}),
          ...(entry.ambientSettleSeconds === undefined ? {} : { ambientSettleSeconds: entry.ambientSettleSeconds }),
        }) };
      });
      if (iteration === 0) {
        input = materialized.input;
        const ambientActors = materialized.input.actors.filter((actor) => actor.tags.includes('ambient'));
        compileIdentity = {
          siteId: materialized.site.siteId, siteScore: materialized.site.score, degradation: materialized.site.degradation?.summary ?? null,
          inputHash: materialized.manifest.inputHash, instanceId: materialized.manifest.instanceId, replayKey: materialized.manifest.replayKey,
          feasible: materialized.manifest.feasible, notes: materialized.manifest.notes,
          ...(entry.ambient ? {
            ambient: {
              profile: entry.ambient, settleSeconds: entry.ambientSettleSeconds ?? 0,
              placedActors: ambientActors.length, kinds: Object.fromEntries([...new Set(ambientActors.map((actor) => actor.kind))].sort().map((kind) => [kind, ambientActors.filter((actor) => actor.kind === kind).length])),
              provenance: materialized.manifest.ambient ?? null, settle: materialized.manifest.ambientSettle ?? null,
            },
          } : {}),
        };
        writeJson(path.join(scenarioDir, 'instance.json'), { kind: 'scenario-instance', version: 1, manifest: materialized.manifest, input: materialized.input });
        if (Object.keys(runtime).length) writeJson(path.join(scenarioDir, 'runtime.json'), runtime);
      } else if (materialized.manifest.inputHash !== compileIdentity.inputHash) {
        throw new Error(`compile identity drifted between iterations: ${compileIdentity.inputHash} vs ${materialized.manifest.inputHash}`);
      }
    }
    return { input, graph: bundle.graph };
  });
  if (!execution.first) return failedResult(scenarioDir, entry, repeats, execution.errors, phases, { compileIdentity });
  const { discrete, inputHash } = writeSignatures(scenarioDir, execution.first.result.trace, execution.first.digest, { issues: execution.first.result.issues, arrival: execution.first.result.arrival });
  let recordedTrace = null;
  if (entry.kind === 'compiled') {
    if (entry.pinnedInstance) {
      const pinned = readJson(path.join(repoRoot, entry.pinnedInstance));
      compileIdentity.pinnedInstance = entry.pinnedInstance;
      compileIdentity.pinnedInputHash = pinned.manifest.inputHash;
      compileIdentity.pinnedReplayKey = pinned.manifest.replayKey;
      compileIdentity.matchesPinnedInstance = pinned.manifest.inputHash === compileIdentity.inputHash;
    }
    if (entry.expectedInputHash) {
      compileIdentity.expectedInputHash = entry.expectedInputHash;
      compileIdentity.matchesExpectedInputHash = entry.expectedInputHash === compileIdentity.inputHash;
    }
  } else if (entry.recordedTrace && exists(path.join(repoRoot, entry.recordedTrace))) {
    const recorded = await compiler.readTraceFile(path.join(repoRoot, entry.recordedTrace));
    const recordedDigest = engine.traceDigest(recorded);
    const recordedDiscrete = discreteSignature(recorded, { traceDigest: recordedDigest, inputHash: recorded.header.inputHash });
    recordedTrace = {
      file: entry.recordedTrace, engineVersion: recorded.header.engineVersion, inputHash: recorded.header.inputHash, traceDigest: recordedDigest,
      inputHashEqual: recorded.header.inputHash === inputHash, traceDigestEqual: recordedDigest === execution.first.digest,
      discrete: compareDiscrete(recordedDiscrete, discrete),
      note: 'Historical trace recorded by an earlier engine version; inequality here is retained engine evolution, not a port failure.',
    };
  }
  return finishResult(scenarioDir, entry, execution, discrete, phases, { issues: execution.first.result.issues.length, compileIdentity, recordedTrace });
}

async function runSituation({ entry, repeats, scenarioDir, repoRoot, engine, compiler, scenario, phases }) {
  const loaded = await phases.time('instanceLoad', async () => loadSituationFixture(scenario, repoRoot, entry));
  const { fixture, program, applied, geometryBindings, fixtureDir } = loaded;
  const artifacts = verifySituationArtifacts(fixtureDir, fixture, program);
  const bundle = await phases.time('mapLoad', () => compiler.loadMap(fixture.mapId));
  const actionHook = schedulePolicy(fixture.policy);
  const options = { seed: fixture.seed, geometryBindings, ...(actionHook ? { actionHook } : {}) };
  const digests = { base: [], intervention: [] };
  const errors = [];
  let first = null;
  for (let iteration = 0; iteration < repeats; iteration += 1) {
    try {
      const outcome = await phases.time('simulate', () => (fixture.comparison
        ? compiler.compareSituation(program, fixture.comparison.transaction, bundle, { ...options, reactiveRoleIds: fixture.comparison.reactiveRoleIds })
        : { base: compiler.rehearseSituation(program, bundle, options) }));
      const legs = { base: outcome.base, ...(outcome.intervention ? { intervention: outcome.intervention } : {}) };
      for (const [leg, rehearsal] of Object.entries(legs)) {
        const digest = await phases.time('digest', () => engine.traceDigest(rehearsal.simulation.trace));
        digests[leg].push(digest);
        if (iteration === 0) {
          const gz = await phases.time('serialize', () => engine.encodeTraceGz(rehearsal.simulation.trace));
          const dir = leg === 'base' ? scenarioDir : path.join(scenarioDir, 'intervention');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'trace.json.gz'), Buffer.from(gz));
        }
      }
      if (iteration === 0) first = { outcome, legs, digest: digests.base[0] };
    } catch (error) {
      errors.push({ iteration, message: String(error?.stack ?? error).slice(0, 4000) });
    }
  }
  if (!first) return failedResult(scenarioDir, entry, repeats, errors, phases, { artifacts });
  const summaries = {};
  for (const [leg, rehearsal] of Object.entries(first.legs)) {
    const dir = leg === 'base' ? scenarioDir : path.join(scenarioDir, 'intervention');
    const { discrete } = writeSignatures(dir, rehearsal.simulation.trace, digests[leg][0], {
      issues: rehearsal.simulation.issues, arrival: rehearsal.simulation.arrival,
      events: rehearsal.events, constraints: rehearsal.constraints, satisfied: rehearsal.satisfied,
      actionCalls: rehearsal.actionCalls, authorityIntervals: rehearsal.authorityIntervals, authorityTransitions: rehearsal.authorityTransitions,
      authority: rehearsal.bound.authority, observations: rehearsal.bound.observations, programDigest: rehearsal.bound.programDigest,
    });
    writeJson(path.join(dir, 'instance.json'), { kind: 'scenario-instance', version: 1, manifest: rehearsal.simulation.input === rehearsal.bound.execution.input ? rehearsal.bound.execution.manifest : { ...rehearsal.bound.execution.manifest, inputHash: engine.contentHash(rehearsal.simulation.input) }, input: rehearsal.simulation.input });
    summaries[leg] = {
      inputHash: discrete.inputHash, traceDigest: digests[leg][0], replayStable: digests[leg].every((digest) => digest === digests[leg][0]),
      tickCount: discrete.tickCount, events: discrete.events.length, programDigest: rehearsal.bound.programDigest,
      situationEvents: rehearsal.events.map((event) => ({ id: event.id, firstTrueS: event.firstTrueS, lastTrueS: event.lastTrueS })),
      authorityTransitions: rehearsal.authorityTransitions, actionCalls: rehearsal.actionCalls,
      collisions: rehearsal.simulation.trace.metrics.collisions.length,
    };
  }
  const comparison = first.outcome.intervention ? {
    changedRoles: first.outcome.changedRoles, changedTracks: first.outcome.changedTracks,
    invariantFailures: first.outcome.invariantFailures, eventDeltas: first.outcome.eventDeltas,
  } : null;
  const execution = { digests: digests.base, errors, first: { digest: digests.base[0] } };
  const discrete = readJson(path.join(scenarioDir, 'signature.json'));
  return finishResult(scenarioDir, entry, execution, { ...discrete, inputHash: discrete.inputHash }, phases, {
    fixture: { path: entry.fixture, id: fixture.id, seed: fixture.seed, origin: fixture.origin, transactionsApplied: applied, policy: fixture.policy ?? null, geometryBinding: geometryBindings.map((binding) => ({ patchId: binding.patchId, patchSha256: binding.patchSha256, roleId: binding.roleId, mesh: binding.descriptor.asset.sha256 })) },
    artifacts, legs: summaries, comparison,
  });
}

async function runThreshold({ entry, repeats, scenarioDir, runDir, repoRoot, engine, compiler, phases }) {
  const baseEntry = entry.baseEntry;
  const baseFile = baseEntry.kind === 'instance' ? path.join(repoRoot, baseEntry.instance) : path.join(runDir, baseEntry.id, 'instance.json');
  if (!exists(baseFile)) throw new Error(`base instance for ${entry.base} is not available at ${baseFile}`);
  const instance = await phases.time('instanceLoad', () => compiler.readInstance(baseFile));
  const bundle = await phases.time('mapLoad', () => compiler.loadMap(instance.input.mapId));
  const derivation = await phases.time('compile', async () => deriveThresholdVariants(engine, instance.input, bundle.graph, entry));
  const variants = [];
  for (const variant of derivation.variants) {
    const id = `${entry.id}-t${variant.threshold.toFixed(4).replace('.', 'p')}`;
    const dir = path.join(runDir, id);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'instance.json'), { kind: 'scenario-instance', version: 1, manifest: { ...instance.manifest, inputHash: engine.contentHash(variant.input), derivedFrom: { entry: entry.base, interactionId: derivation.interactionId, authoredValue: derivation.authoredValue, threshold: variant.threshold } }, input: variant.input });
    const variantPhases = new Phases();
    const execution = await executeInput(engine, variantPhases, variant.input, {}, repeats, dir, async () => ({ input: variant.input, graph: bundle.graph }));
    const variantEntry = { id, kind: 'threshold-variant', mapId: instance.input.mapId };
    if (!execution.first) { variants.push(failedResult(dir, variantEntry, repeats, execution.errors, variantPhases)); continue; }
    const { discrete } = writeSignatures(dir, execution.first.result.trace, execution.first.digest, { issues: execution.first.result.issues, arrival: execution.first.result.arrival });
    const fired = discrete.events.find((event) => event.kind === 'trigger_fired' && event.interactionId === derivation.interactionId) ?? null;
    variants.push(finishResult(dir, variantEntry, execution, discrete, variantPhases, {
      id,
      threshold: {
        base: entry.base, interactionId: derivation.interactionId, conditionKind: derivation.conditionKind, cmp: derivation.cmp,
        authoredValue: derivation.authoredValue, value: variant.threshold, gridIndex: variant.gridIndex,
        predictedFirstTrueT: variant.predictedFirstTrueT, admissible: variant.admissible,
        actualFire: fired ? { t: fired.t, forced: fired.forced } : null,
        predictionMatched: fired && variant.predictedFirstTrueT !== null ? Math.abs(fired.t - variant.predictedFirstTrueT) < 1e-6 : null,
      },
    }));
  }
  writeJson(path.join(scenarioDir, 'threshold-corpus.json'), { ...derivation, variants: derivation.variants.map(({ input: _input, ...rest }) => rest), results: variants.map((row) => ({ id: row.id, status: row.status, traceDigest: row.traceDigest ?? null, threshold: row.threshold ?? null })) });
  const crossings = derivation.grid.firstTrueTick.filter((tick) => tick !== null).length;
  const result = {
    id: entry.id, kind: entry.kind, mapId: instance.input.mapId,
    status: variants.length ? 'derived' : (crossings === 0 ? 'no-crossing' : 'no-admissible-pair'),
    reason: variants.length ? null : (crossings === 0 ? 'the predicate never became true at any grid threshold in the base run' : 'every crossing lies after the base trigger fired, so the base trajectory cannot predict it'),
    base: entry.base, interactionId: derivation.interactionId, authoredValue: derivation.authoredValue, baseTrigger: derivation.baseTrigger,
    variantCount: variants.length, variants: variants.map((row) => row.id),
    iterations: { requested: repeats * variants.length, completed: variants.reduce((n, row) => n + row.iterations.completed, 0), failed: variants.reduce((n, row) => n + row.iterations.failed, 0), errors: [] },
    timingMs: phases.report(),
    children: variants,
  };
  writeJson(path.join(scenarioDir, 'result.json'), result);
  return result;
}

async function cmdRunOne(args) {
  const spec = readJson(args.spec);
  const { entry, packagesRoot: root } = spec;
  const files = distFiles(root);
  const phases = new Phases();
  const modules = await phases.time('moduleLoad', async () => ({
    engine: await import(pathToFileURL(files.engine).href),
    compiler: await import(pathToFileURL(files.compilerNode).href),
    scenario: await import(pathToFileURL(files.scenario).href),
  }));
  const context = { ...spec, ...modules, phases };
  try {
    if (entry.kind === 'situation') await runSituation(context);
    else if (entry.kind === 'threshold') await runThreshold(context);
    else await runInstanceOrCompiled(context);
  } catch (error) {
    failedResult(spec.scenarioDir, entry, spec.repeats, [{ iteration: 0, message: String(error?.stack ?? error).slice(0, 4000) }], phases);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// compare

function cmdCompare(args) {
  if (!args.reference || !args.candidate) fail('compare requires --reference DIR and --candidate DIR');
  const className = args.class ?? 'conformance';
  const tolerances = TOLERANCES.classes[className];
  if (!tolerances) fail(`unknown tolerance class ${className}; known: ${Object.keys(TOLERANCES.classes).join(', ')}`);
  const referenceDir = path.resolve(args.reference);
  const candidateDir = path.resolve(args.candidate);
  const referenceRun = exists(path.join(referenceDir, 'run.json')) ? readJson(path.join(referenceDir, 'run.json')) : null;
  const candidateRun = exists(path.join(candidateDir, 'run.json')) ? readJson(path.join(candidateDir, 'run.json')) : null;
  const referenceStatus = new Map((referenceRun?.scenarios ?? []).map((row) => [row.id, row.status]));
  const baseIds = referenceRun
    ? referenceRun.scenarios.map((row) => row.id)
    : fs.readdirSync(referenceDir).filter((name) => exists(path.join(referenceDir, name, 'signature.json')));
  // A situation comparison keeps its intervention leg under <id>/intervention.
  const ids = baseIds.flatMap((id) => (exists(path.join(referenceDir, id, 'intervention', 'signature.json')) ? [id, `${id}/intervention`] : [id]));
  const rows = [];
  for (const id of ids) {
    const refSig = path.join(referenceDir, id, 'signature.json');
    const candSig = path.join(candidateDir, id, 'signature.json');
    if (!exists(refSig)) {
      const status = referenceStatus.get(id);
      rows.push(status && status !== 'completed' ? { id, status: 'reference-failed', referenceStatus: status } : { id, status: 'reference-missing' });
      continue;
    }
    if (!exists(candSig)) { rows.push({ id, status: 'not-run', reason: 'candidate produced no signature for this scenario' }); continue; }
    const reference = readJson(refSig);
    const candidate = readJson(candSig);
    if (reference.schema !== SIGNATURE_SCHEMA || candidate.schema !== SIGNATURE_SCHEMA) {
      rows.push({ id, status: 'schema-mismatch', reference: reference.schema, candidate: candidate.schema });
      continue;
    }
    const discrete = compareDiscrete(reference, candidate);
    const refNum = path.join(referenceDir, id, 'numeric.json.gz');
    const candNum = path.join(candidateDir, id, 'numeric.json.gz');
    const numeric = exists(refNum) && exists(candNum)
      ? compareNumeric(readJsonGz(refNum), readJsonGz(candNum), tolerances)
      : { pass: false, reason: 'numeric signature missing on one side', channels: {}, metrics: {} };
    const digestOk = !tolerances.requireTraceDigest || discrete.traceDigestEqual;
    const pass = discrete.pass && numeric.pass && digestOk && discrete.inputHashEqual;
    rows.push({
      id,
      status: pass ? 'pass' : 'fail',
      inputHashEqual: discrete.inputHashEqual,
      traceDigestEqual: discrete.traceDigestEqual,
      traceDigestRequired: tolerances.requireTraceDigest,
      engineVersion: discrete.engineVersion,
      discrete: { pass: discrete.pass, mismatches: discrete.mismatches },
      numeric,
    });
  }
  const report = {
    schema: 'simforge.native-migration.comparison/v1',
    generatedAt: new Date().toISOString(),
    toleranceClass: className,
    tolerances,
    reference: { dir: referenceDir, stack: referenceRun?.stack ?? null },
    candidate: { dir: candidateDir, stack: candidateRun?.stack ?? null },
    counts: {
      scenarios: rows.length,
      pass: rows.filter((row) => row.status === 'pass').length,
      fail: rows.filter((row) => row.status === 'fail').length,
      notRun: rows.filter((row) => row.status === 'not-run').length,
      referenceFailed: rows.filter((row) => row.status === 'reference-failed').length,
      other: rows.filter((row) => !['pass', 'fail', 'not-run', 'reference-failed'].includes(row.status)).length,
    },
    scenarios: rows,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(path.resolve(args.out), text); }
  process.stdout.write(args.out ? `${JSON.stringify({ out: path.resolve(args.out), counts: report.counts }, null, 2)}\n` : text);
  if (report.counts.fail > 0 || report.counts.other > 0) return 2;
  return report.counts.notRun > 0 ? 4 : 0;
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const commands = { status: cmdStatus, record: cmdRecord, 'run-one': cmdRunOne, compare: cmdCompare };
if (!commands[command]) fail('usage: harness.mjs status|record|compare (see header comment)');
try {
  process.exitCode = await commands[command](args);
} catch (error) {
  fail(String(error?.stack ?? error));
}
