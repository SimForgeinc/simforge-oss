#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TemplateDocument, createSituationProgram, parseSituationProgram, applySituationTransaction, situationDigest } from '@simforge-oss/scenario';
import { loadMap, compileSituation, rehearseSituation, solveSituation, compareSituation } from '@simforge-oss/compiler/node';
import { canonicalJson } from '@simforge-oss/engine';
import { sceneState } from '@simforge-oss/engine/node';
import { findLocations, getLocation, describeLocation, knownFactKeys, resolveReference } from '@simforge-oss/maps';
import { createGatewayAgent, AUTHOR_MODEL, AUTHOR_MODELS, AUTHOR_EFFORT, AUTHOR_EFFORTS, GATEWAY_TIMEOUT_MS, ASTRA_MODEL } from './gateway.mjs';
import { BlenderWorkbenchClient, WorkbenchActionSchema, InspectionCameraSchema } from './blender-client.mjs';
import { assert, hash, fileHash, saveJson, pinSources, verifySources, resources } from './situation-authoring-resources.mjs';
import { loadGeometryExport, prepareStaticGeometry } from './geometry-binding.mjs';
import { loadCapabilityMemory, queryCapabilityMemory } from './situation-capabilities.mjs';
import { SCENARIO_REVIEW_POLICY, policyDigest, reviewEnsemble, validateEnsembleReview } from './situation-ensemble.mjs';
import { loadBriefSensingPolicy, sensingPolicyDigest, expectedParticipantSensors, validateSensingProgram, validateSensingExecution } from './situation-sensing-policy.mjs';
import { authoringRuntimeIdentity, verifyRuntimeIdentity } from './runtime-identity.mjs';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const arbitrary = { type: 'object', additionalProperties: true };
const text = value => ({ type: 'text', text: JSON.stringify(value) });
const strings = { type: 'array', items: string };
const setFilter = { anyOf: [string, strings, object({ anyOf: strings, allOf: strings, noneOf: strings })] };
const fact = object({ key: string, op: { enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists', 'missing'] }, value: {} }, ['key', 'op']);
const facts = { type: 'array', items: fact };
const locationQuery = object({
  type: setFilter, subtype: setFilter, tags: setFilter, affordances: setFilter, anchorQuality: setFilter,
  facts: { anyOf: [facts, object({ anyOf: facts, allOf: facts, noneOf: facts })] },
  near: object({ id: string, withinM: { type: 'number', minimum: 0 } }, ['id', 'withinM']),
  requireRoadAnchor: { type: 'boolean' }, diversityRadiusM: { type: 'number', minimum: 0 },
  sort: { enum: ['relevance', 'distance', 'handle'] },
});
const querySchema = { anyOf: [
  object({ kind: { const: 'assets' }, search: string, limit: integer(1, 20) }, ['kind']),
  object({ kind: { const: 'locations' }, query: locationQuery, limit: integer(1, 20) }, ['kind']),
  object({ kind: { const: 'resolve-location' }, search: string, limit: integer(1, 20) }, ['kind', 'search']),
  object({ kind: { const: 'facts' } }, ['kind']),
  object({ kind: { const: 'lane' }, reference: string }, ['kind', 'reference']),
  object({ kind: { const: 'lanes' }, offset: integer(0, 100000), limit: integer(1, 20) }, ['kind']),
  object({ kind: { const: 'schema' }, reference: string, pointer: { type: 'string' } }, ['kind']),
] };
const REHEARSAL_TOOLS = new Set(['rehearse', 'solve', 'compare']);
const FAILURE_OUTCOMES = ['rejected', 'impossible', 'unsupported', 'infrastructure'];
const REVIEW_POLICY_DIGEST = policyDigest(SCENARIO_REVIEW_POLICY);
function inputChangeWitnesses(before, after) {
  const changes = [];
  const objects = value => value !== null && typeof value === 'object';
  const keyed = values => values.every(value => objects(value) && typeof value.id === 'string')
    && new Set(values.map(value => value.id)).size === values.length;
  const walk = (a, b, at) => {
    if (Object.is(a, b)) return;
    if (Array.isArray(a) && Array.isArray(b) && keyed(a) && keyed(b)) {
      const left = new Map(a.map(value => [value.id, value])), right = new Map(b.map(value => [value.id, value]));
      for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) walk(left.get(id), right.get(id), `${at}{${JSON.stringify(id)}}`);
      if (a.length === b.length && a.some((value, index) => value.id !== b[index].id)) changes.push({ path: `${at}.@order`, before: a.map(value => value.id), after: b.map(value => value.id) });
      return;
    }
    if (objects(a) && objects(b) && Array.isArray(a) === Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(a[key], b[key], `${at}.${key}`);
    } else changes.push({ path: at, operation: a === undefined ? 'add' : b === undefined ? 'remove' : 'replace',
      ...(a === undefined ? {} : { before: a }), ...(b === undefined ? {} : { after: b }) });
  };
  walk(before, after, 'input');
  return { schema: 'simforge.input-change-witness/v1', pathFormat: 'Object keys use dots; keyed arrays use a JSON-quoted ID in braces; other arrays use indices.', changes };
}
const SUPPORT = [
  'Authored local map-bound situations only; NuRec/twin immutable adapters are not supplied by this runner.',
  'No implicit meshes, external policies or vertical vehicle contact dynamics. Generated static meshes require adopt_geometry and explicit enclosing opaque planar OBB collision/occlusion semantics.',
  'Unadopted geometry-workbench edits remain visual-only. Source-map modifications cannot be promoted. Rehearsals use immutable ORIGINAL source-map ground plus verified generated-asset offsets.',
  'Actor-relative inspection cameras are diagnostic views, not attested policy sensor pixels.',
  'Participant critics receive only reported sensor detections, never missed-target or world-truth channels.',
  'Built-in controllers provide longitudinal hazard braking, not autonomous overtaking decisions. Conditional authored when-triggered lane actions are separate supported primitives; failure of one route or offset is not proof that every conditional maneuver is unsupported.',
  'Synthetic sensor-channel reports are not the built-in governor inputs. Ego has a separate optional geometric range/FOV/line-of-sight gate; non-ego governors use world state. Scoped participant criticism is not a perception-driven control policy.',
  'Acceptance is automated ensemble judgment plus deterministic gates, not human calibration or objective ground truth.',
];
const RUNTIME_GUIDANCE = ' Built-in driving uses authority kind controller; policy means an external callback, which this runner does not supply. Model-request budgets and tool-invocation counts are different: use the explicit remaining modelRequests reported by tools, not evidence IDs or toolInvocation. The runner alone ends resource exhaustion; never call finish_failure to predict that remaining work will not fit. Metadata-only transactions may omit templateOps. Leave model requests for the three-member frozen review ensemble.';
const DIRECTOR = `You are the persistent situation author. Use only grounded tool observations and typed atomic edits; never retrieve or copy complete scenario examples. Start with the empty real-map document. Treat explicit brief requirements as mandatory, but do not turn staging preferences or unverified assumptions into extra requirements. A failed location/asset pairing rejects that candidate, not the entire brief: use the remaining budget to investigate genuinely different grounded alternatives unless a concrete capability finding rules them out. Individual map records need not span the whole situation; use canonical connectivity to compose supported movement. State a decision hypothesis and falsifier, inspect the site visually, choose catalog-backed real assets explicitly, author participants/authority/events/constraints, run actual simulation, inspect diagnostic and participant-relative views, declare one controlled intervention and preserved roles/reactive set, and request the independent frozen ensemble before accept. Cheap queries are cached. Do not claim arithmetic is simulation or a camera is a policy sensor. No model-per-tick. The author uses the configured authoring model; scoped critics and independent judges remain Astra-low through the same Starline OMP gateway. Preserve original map files and the verbatim user brief. On unsupported or infeasible requests record a concrete finding and reject honestly; budget exhaustion is not mathematical impossibility. accept records automated ensemble acceptance only after deterministic closure. Tool errors are evidence to repair, not permission for a silent fallback. Tools must use exact schema fields; query schema fragments rather than guessing. ${SUPPORT.join(' ')}`;

function reportedSensorObservations(trace, sensors, lastFrame) {
  const targets = sensors.flatMap(sensor => Object.entries(sensor.targets).map(([target, values]) => ({sensorId: sensor.sensorId, target, values})));
  const observations = [];
  for (let i = 0; i <= lastFrame; i++) {
    const reports = [];
    for (const {sensorId, target, values} of targets) {
      if (values.status[i] >= 2) reports.push({sensorId, target, confidence: values.confidence[i], rangeM: values.rangeM[i]});
    }
    if (reports.length) observations.push({t: trace.ticks.t[i], reports});
  }
  return observations;
}

function summarizeSituationRun(run, includeParticipantEvidence) {
  const trace = run.simulation.trace, sensors = includeParticipantEvidence ? Object.values(trace.ticks.sensors ?? {}) : null;
  return { programDigest: run.bound.programDigest, inputHash: run.simulation.trace.header.inputHash,
    satisfied: run.satisfied, events: run.events, constraints: run.constraints, authority: run.bound.authority,
    externalPolicyActionCalls: run.actionCalls, issues: run.simulation.issues, visualOnlyPatches: run.bound.visualOnlyPatches,
    authorityIntervals: run.authorityIntervals, authorityTransitions: run.authorityTransitions,
    physics: run.simulation.trace.header.physics, controller: run.simulation.trace.header.ego,
    resolvedActors: run.simulation.input.actors.map(actor => ({ id: actor.id, kind: actor.kind, static: actor.static,
      dimensions: actor.dims, initialSpeedMps: actor.initial.speedMps, routeKind: actor.behavior.route.kind,
      rules: actor.behavior.rules, drivingProfile: actor.behavior.drivingProfile })),
    ...(includeParticipantEvidence ? {participantEvidence: run.simulation.input.actors.map(actor => {
      const channels = sensors.filter(sensor => sensor.observer === actor.id);
      return {actorId: actor.id, sensorRecipe: actor.sensors ?? [], executedSensorChannels: channels.length,
        observations: reportedSensorObservations(trace, channels, trace.ticks.t.length - 1),
        scope: 'Executed synthetic reported detections only; omitted times have no positive report, not proven absence. No missed-target identities or policy pixel claim.'};
    })} : {}),
    metrics: run.simulation.trace.metrics, durationS: run.simulation.trace.header.clipSeconds };
}

export function buildFrozenSituationEvidence({ brief, program, source: sourceInput, comparisonId, comparison, baseViews, interventionViews, replays, groundingEvidence, sensingPolicy = null }) {
  const source = { ...sourceInput, artifacts: sourceInput.artifacts.filter(a => !a.id.startsWith('asset:') ||
    program.participants.some(p => p.appearance.sourceId === a.id)) };
  const replayProof = {};
  for (const arm of ['base', 'intervention']) {
    const replay = replays[arm], expected = comparison.result[arm];
    assert(replay?.run.bound.programDigest === expected.bound.programDigest, `${arm} replay program differs`);
    const input = canonicalJson(replay.run.simulation.input), trace = canonicalJson(replay.run.simulation.trace);
    assert(input === canonicalJson(expected.simulation.input) && trace === canonicalJson(expected.simulation.trace), `Exact ${arm} bundle replay differs`);
    replayProof[arm] = { replayId: replay.id, programDigest: replay.run.bound.programDigest,
      inputDigest: hash(input), traceDigest: hash(trace), exactInput: true, exactTrace: true };
  }
  return { brief, comparisonId, programDigest: situationDigest(program), program: { ...program, source }, declaration: comparison.declaration,
    base: summarizeSituationRun(comparison.result.base, true), intervention: summarizeSituationRun(comparison.result.intervention, true),
    invariantFailures: comparison.result.invariantFailures, eventDeltas: comparison.result.eventDeltas,
    changedRoles: comparison.result.changedRoles, changedTracks: comparison.result.changedTracks,
    inputChanges: inputChangeWitnesses(comparison.result.base.simulation.input, comparison.result.intervention.simulation.input),
    ...(sensingPolicy ? {sensing: {policy: sensingPolicy, policyDigest: sensingPolicyDigest(sensingPolicy),
      base: validateSensingExecution(program, sensingPolicy, comparison.result.base.simulation, 'base'),
      intervention: validateSensingExecution(applySituationTransaction(program, comparison.declaration.transaction).program, sensingPolicy, comparison.result.intervention.simulation, 'control')}} : {}),
    replayProof, groundingEvidence, baseViews, interventionViews, support: SUPPORT, source };
}

/** Importable, disk-persistent authoring session. Construct with await SituationAuthoringRunner.open(options). */
export class SituationAuthoringRunner {
  static async open(options) {
    const runner = new SituationAuthoringRunner(options);
    await runner.initialize();
    return runner;
  }
  constructor({ brief, map, out, workbench = 'http://127.0.0.1:8767', seed, authorModel = AUTHOR_MODEL, authorEffort = AUTHOR_EFFORT, maxCalls = 24, maxRehearsals = 16, branching, capabilityMemory, maxSubmissions, maxOutputTokens, sensingPolicyFile, briefRecord }) {
    assert(typeof brief === 'string' && brief.trim(), 'A nonempty brief is required');
    assert(typeof map === 'string' && map && typeof out === 'string' && out, 'map and out are required');
    assert(typeof seed === 'string' && seed.trim(), 'An explicit nonempty seed is required');
    assert(AUTHOR_MODELS.includes(authorModel), 'Unsupported author model');
    assert(AUTHOR_EFFORTS.includes(authorEffort), 'Unsupported author reasoning effort');
    assert(Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 128, 'maxCalls must be in [1,128]');
    assert(Number.isInteger(maxRehearsals) && maxRehearsals >= 1 && maxRehearsals <= 256, 'maxRehearsals must be in [1,256]');
    assert(branching === undefined || typeof branching === 'boolean', 'branching must be boolean');
    assert(maxSubmissions === undefined || Number.isInteger(maxSubmissions) && maxSubmissions >= 1 && maxSubmissions <= 24, 'maxSubmissions must be in [1,24]');
    assert(maxOutputTokens === undefined || Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1024 && maxOutputTokens <= 16000, 'maxOutputTokens must be in [1024,16000]');
    this.branching = branching ?? true;
    this.maxSubmissions = maxSubmissions ?? 6;
    this.options = { brief, map, out: path.resolve(out), workbench, seed, authorModel, authorEffort, authorRequestTimeoutMs: GATEWAY_TIMEOUT_MS[authorEffort], maxCalls, maxRehearsals };
    if (branching !== undefined) this.options.branching = branching;
    if (maxSubmissions !== undefined) this.options.maxSubmissions = maxSubmissions;
    if (maxOutputTokens !== undefined) this.options.maxOutputTokens = maxOutputTokens;
    if (capabilityMemory !== undefined) this.options.capabilityMemory = path.resolve(capabilityMemory);
    if (briefRecord !== undefined) this.options.briefRecord = structuredClone(briefRecord);
    this.sensingPolicy = sensingPolicyFile ? loadBriefSensingPolicy(sensingPolicyFile, briefRecord) : null;
    if (this.sensingPolicy) {
      assert(this.sensingPolicy.policy.brief.brief === brief && this.sensingPolicy.policy.brief.mapId === map, 'Frozen sensing policy belongs to another brief or map');
      this.options.sensingPolicyFile = path.resolve(sensingPolicyFile);
      this.options.sensingPolicyDigest = this.sensingPolicy.digest;
    }
    this.client = new BlenderWorkbenchClient({ url: workbench });
    this.started = performance.now();
    this.agents = [];
    this.staticQueries = new Map();
    this.executionIds = new Map();
    this.verifiedGeometry = new Map();
    this.queue = Promise.resolve();
  }
  async initialize() {
    fs.mkdirSync(this.options.out, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.file('artifacts'), { recursive: true, mode: 0o700 });
    const checkpoint = this.file('state.json');
    this.state = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')) : {
      version: 1, options: this.options, status: 'running', active: 'main', candidates: {}, bindings: {}, findings: [],
      rehearsals: {}, comparisons: {}, reviews: {}, counters: { calls: 0, rehearsals: 0, tools: 0, sequence: 0 },
      metrics: { stages: [], elapsedMs: 0 },
    };
    assert(canonicalJson(this.state.options) === canonicalJson(this.options), 'Resume options differ from the saved run; use another output directory');
    for (const name of fs.readdirSync(this.file('artifacts'))) {
      const sequence = /^[a-z]+-(\d+)\.json$/.exec(name);
      if (sequence) {
        const value = Number(sequence[1]);
        assert(Number.isSafeInteger(value), 'Invalid saved artifact sequence');
        this.state.counters.sequence = Math.max(this.state.counters.sequence, value);
      }
    }
    this.state.branches ??= {};
    this.state.submissions ??= [];
    this.state.submissionCounterOrigin ??= this.state.counters.tools;
    this.state.counterOrigin ??= { sequence: this.state.counters.sequence, tools: this.state.counters.tools };
    this.state.counters.iterations ??= this.state.metrics.stages.filter(row => REHEARSAL_TOOLS.has(row.stage)).length;
    this.state.counters.semanticEdits ??= 0;
    this.state.counters.failedTools ??= this.state.findings.length;
    if (this.options.capabilityMemory) {
      const memory = loadCapabilityMemory(this.options.capabilityMemory);
      assert(!this.state.capabilityMemory || this.state.capabilityMemory.digest === memory.digest, 'Capability memory changed during a run');
      this.state.capabilityMemory ??= { digest: memory.digest, file: 'capabilities.json' };
      const snapshot = this.file(this.state.capabilityMemory.file);
      if (!fs.existsSync(snapshot)) fs.copyFileSync(this.options.capabilityMemory, snapshot, fs.constants.COPYFILE_EXCL);
      this.capabilities = loadCapabilityMemory(snapshot);
      assert(this.capabilities.digest === memory.digest, 'Saved capability memory changed');
    }
    if (this.sensingPolicy) {
      const snapshot = this.file('sensing-policy.json');
      if (!fs.existsSync(snapshot)) fs.copyFileSync(this.options.sensingPolicyFile, snapshot, fs.constants.COPYFILE_EXCL);
      assert(loadBriefSensingPolicy(snapshot, this.sensingPolicy.policy.brief).digest === this.sensingPolicy.digest, 'Saved sensing policy changed');
      this.state.sensingPolicy = {digest: this.sensingPolicy.digest, file: 'sensing-policy.json'};
    }
    this.bundle = await loadMap(this.options.map);
    assert(this.bundle.catalog, `Installed map ${this.options.map} has no map-intel location catalog; grounded location queries are impossible without it`);
    this.library = resources();
    if (!this.state.source) {
      const prior = await this.client.getState();
      assert(prior.mapId === this.options.map && prior.ready && !prior.busy, 'Requested workbench map must be ready and idle');
      const resetStarted = performance.now();
      await this.client.action({ op: 'begin-authoring', baseRevision: prior.revision });
      this.state.metrics.stages.push({ stage: 'scene-source-reset', elapsedMs: performance.now() - resetStarted });
      const source = pinSources(this.options.map, await this.client.getState());
      source.artifacts.push(...this.library.pinAssets());
      const template = TemplateDocument.create({ name: 'Untitled situation', description: this.options.brief,
        sourceMap: { mapId: this.options.map, mapName: this.bundle.topology.mapName || this.options.map, xodrSha256: source.artifacts[0].sha256 },
        anchor: { features: [], pin: { mapId: this.options.map } } }).data;
      const program = createSituationProgram({ source, template, question: { brief: this.options.brief, hypothesis: '', falsifier: '' } });
      this.state.source = source;
      this.state.candidates.main = this.recordProgram(program, { kind: 'create-empty' });
      saveJson(this.file('source.json'), source);
    } else verifySources(this.state.source);
    // The native runtime is part of the evidence: a resumed run must execute on the exact addon and package artifacts that produced its saved traces.
    if (!this.state.runtime) {
      const runtime = authoringRuntimeIdentity();
      saveJson(this.file('runtime-identity.json'), runtime);
      this.state.runtime = { digest: runtime.digest, file: 'runtime-identity.json', native: runtime.native };
    } else {
      const verification = verifyRuntimeIdentity(JSON.parse(fs.readFileSync(this.file(this.state.runtime.file), 'utf8')));
      assert(verification.recordedDigest === this.state.runtime.digest && verification.unchanged,
        `Native runtime differs from the one that produced this run (${verification.changed.length} changed files); saved traces cannot be extended by another runtime. Use another output directory.`);
    }
    this.state.geometryBindings ??= {};
    this.state.branches.main ??= { from: null, baseDigest: this.state.candidates.main.digest, hypothesis: null, falsifier: null, evidenceIds: [] };
    this.verifiedGeometry.set(this.state.active, await this.loadGeometryBindings(this.state.geometryBindings[this.state.active] ?? {}));
    this.save();
    return this;
  }
  file(name) { return path.join(this.options.out, name); }
  save() { saveJson(this.file('state.json'), this.state); }
  budgetSnapshot() {
    return { modelRequests: { used: this.state.counters.calls, limit: this.options.maxCalls,
      remaining: Math.max(0, this.options.maxCalls - this.state.counters.calls) },
    rehearsalAttempts: { used: this.state.counters.rehearsals, limit: this.options.maxRehearsals },
    submissions: { used: this.state.submissions.length, limit: this.maxSubmissions },
    toolInvocations: this.state.counters.tools };
  }
  artifact(kind, value) {
    const id = `${kind}-${++this.state.counters.sequence}`;
    fs.writeFileSync(this.file(`artifacts/${id}.json`), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    return id;
  }
  recordProgram(program, transaction, candidate = this.state.active) {
    const digest = situationDigest(program);
    const previous = this.state.candidates[candidate];
    const name = `programs/${digest}.json`;
    if (!fs.existsSync(this.file(name))) saveJson(this.file(name), program);
    const history = this.artifact('transaction', { candidate, digest, revision: program.revision, transaction });
    if (previous && previous.digest !== digest) this.state.counters.semanticEdits++;
    return { digest, revision: program.revision, file: name, history };
  }
  program(candidate = this.state.active) {
    const row = this.state.candidates[candidate];
    assert(row, `Unknown candidate ${candidate}`);
    const program = parseSituationProgram(JSON.parse(fs.readFileSync(this.file(row.file), 'utf8')));
    assert(situationDigest(program) === row.digest, 'Persisted candidate digest mismatch');
    return program;
  }
  readArtifact(id) {
    assert(/^[a-z]+-\d+$/.test(id), 'Invalid artifact id');
    return JSON.parse(fs.readFileSync(this.file(`artifacts/${id}.json`), 'utf8'));
  }
  branchEvidence(ids, digest) {
    assert(Array.isArray(ids) && ids.length > 0 && ids.length <= 8, 'A causal repair requires one to eight saved evidence IDs');
    const evidence = ids.map(id => {
      const row = this.readArtifact(id);
      const programDigest = row.programDigest ?? row.bound?.programDigest ?? row.result?.base?.bound?.programDigest
        ?? this.state.comparisons[row.comparisonId]?.digest;
      return { id, programDigest: programDigest ?? null };
    });
    assert(evidence.some(row => row.programDigest === digest), 'Repair evidence must include the exact source candidate, not only stale or unrelated observations');
    return evidence;
  }
  async branch({ candidate, from = this.state.active, hypothesis, falsifier, evidenceIds = [] }, transaction) {
    assert(this.branching, 'Branching is disabled in this ablation');
    assert(/^[a-zA-Z0-9_-]{1,48}$/.test(candidate), 'Invalid branch name');
    const activeCount = Object.keys(this.state.candidates).filter(id => this.state.branches[id]?.status !== 'abandoned').length;
    assert(!this.state.candidates[candidate] && activeCount < 8, 'Candidate exists or eight-active-branch cap reached; abandoned evidence remains retained');
    assert(this.state.candidates[from], 'Unknown source candidate');
    assert(typeof hypothesis === 'string' && hypothesis.trim() && typeof falsifier === 'string' && falsifier.trim(), 'Each branch needs its own hypothesis and falsifier');
    const base = this.program(from);
    const evidence = evidenceIds.length ? this.branchEvidence(evidenceIds, situationDigest(base)) : [];
    assert(!transaction || evidence.length, 'A repair must cite candidate-local evidence');
    const next = transaction ? applySituationTransaction(base, transaction) : null;
    if (next) this.bounded(next.program);
    const verified = await this.loadGeometryBindings(this.state.geometryBindings[from] ?? {});
    const record = next ? this.recordProgram(next.program, transaction, candidate) : { ...this.state.candidates[from] };
    this.state.candidates[candidate] = record;
    this.state.bindings[candidate] = structuredClone(this.state.bindings[from] ?? {});
    this.state.geometryBindings[candidate] = structuredClone(this.state.geometryBindings[from] ?? {});
    this.state.branches[candidate] = { from, baseDigest: situationDigest(base), hypothesis, falsifier, evidenceIds, evidence,
      changedPaths: next?.changedPaths ?? [] };
    this.state.active = candidate;
    this.verifiedGeometry.set(candidate, verified);
    if (next) this.state.counters.semanticEdits++;
    return { ...this.state.candidates[candidate], branch: this.state.branches[candidate] };
  }
  reserveRuns(count) {
    assert(this.state.counters.rehearsals + count <= this.options.maxRehearsals, 'rehearsal_budget_exhausted');
    this.state.counters.rehearsals += count;
    this.save();
  }
  runOptions() { return { seed: this.options.seed, geometryBindings: this.verifiedGeometry.get(this.state.active) ?? [] }; }
  async loadGeometryBindings(records) {
    const loaded = [];
    for (const record of Object.values(records)) {
      const descriptor = await loadGeometryExport(record.descriptorReference);
      assert(canonicalJson(descriptor) === canonicalJson(record.descriptor), 'Saved generated geometry descriptor changed');
      loaded.push({ ...record, descriptor });
    }
    return loaded;
  }
  async prepareExecution(program = this.program(), records = this.state.geometryBindings[this.state.active] ?? {}) {
    verifySources(program.source);
    this.requireSensing(program);
    const bindings = await this.loadGeometryBindings(records);
    const state = await this.client.getState();
    assert(state.ready && !state.busy, 'Workbench must be idle before preparing executable geometry');
    if (state.visualOnlyPatches.length) {
      const exportedJobs = new Set(bindings.map(binding => binding.descriptor.jobId));
      assert(state.visualOnlyPatches.every(patch => exportedJobs.has(patch.jobId)),
        'Unadopted visual edits cannot alter execution. Adopt a supported static export or undo/reset explicitly.');
      await this.client.action({ op: 'reset', baseRevision: state.revision });
      this.executionIds.clear();
    }
    return bindings;
  }
  requireSensing(program, variant = 'base') {
    if (!this.sensingPolicy) return;
    const report = validateSensingProgram(program, this.sensingPolicy.policy, variant);
    if (!report.valid) throw Object.assign(new Error('Frozen sensing declaration mismatch; use sensing to inspect exact required arrays and apply them explicitly'), {issues: report.issues});
  }
  bounded(program = this.program()) {
    const choreography = program.template.choreography;
    assert(program.question.brief === this.options.brief, 'The user brief is immutable; edit hypothesis or falsifier without rewriting the request');
    assert(choreography.clipSeconds <= 60 && choreography.warmupSeconds <= 10, 'Runner execution envelope: clip <=60s, warmup <=10s');
    assert(program.template.roles.length <= 32 && choreography.interactions.length <= 128 && program.events.length <= 32, 'Runner execution envelope: <=32 roles/events, <=128 interactions');
    assert(program.participants.every(p => p.authority.every(a => a.kind !== 'policy')), 'External policy callbacks are not supplied by this runner');
    return program;
  }
  storeRun(run, kind = 'rehearsal', program = this.program()) {
    assert(situationDigest(program) === run.bound.programDigest, 'Execution program identity mismatch');
    const programFile = `programs/${run.bound.programDigest}.json`;
    if (!fs.existsSync(this.file(programFile))) saveJson(this.file(programFile), program);
    const id = this.artifact(kind, run);
    this.state.rehearsals[id] = { programDigest: run.bound.programDigest, programFile,
      bindings: structuredClone(this.state.bindings[this.state.active] ?? {}),
      geometryBindings: structuredClone(this.state.geometryBindings[this.state.active] ?? {}),
      traceDigest: hash(canonicalJson(run.simulation.trace)), views: [] };
    return { id, ...summarizeSituationRun(run, false) };
  }
  tool(name, description, parameters, perform) {
    return { name, label: name, description, parameters, execute: (_callId, args) => {
      const work = this.queue.then(async () => {
        const started = performance.now();
        const toolInvocation = ++this.state.counters.tools;
        const context = { candidate: this.state.active, programDigest: this.state.candidates[this.state.active]?.digest };
        if (REHEARSAL_TOOLS.has(name)) this.state.counters.iterations++;
        try {
          assert(this.state.status === 'running', `Run already terminated: ${this.state.status}`);
          assert(toolInvocation <= this.options.maxCalls * 20, 'tool_budget_exhausted');
          if (['edit', 'adopt_geometry', 'solve', 'compare', 'accept'].includes(name)) {
            assert(this.state.branches[this.state.active]?.status !== 'abandoned', 'Candidate was abandoned; fork a new hypothesis or switch to another candidate before mutation or acceptance');
          }
          const result = await perform(args);
          const content = result?.content ?? [text(result)];
          const evidence = result?.evidence ?? result;
          const evidenceId = this.artifact('tool', { name, args, evidence, toolInvocation, ...context });
          if (name === 'accept') {
            const submission = this.state.submissions.find(row => row.reviewId === args.reviewId);
            if (submission) submission.accepted = this.state.status === 'ensemble_accepted';
          }
          return { content: [...content, text({ evidenceId, toolInvocation, budgets: this.budgetSnapshot() })], details: evidence };
        } catch (error) {
          this.state.counters.failedTools++;
          const finding = { tool: name, args, code: error.code ?? 'operation_failed', message: String(error.message ?? error),
            ...(Array.isArray(error.issues) ? { issues: error.issues } : {}), toolInvocation, ...context };
          this.state.findings.push(finding);
          const evidenceId = this.artifact('failure', finding);
          return { content: [text({ ok: false, evidenceId, ...finding, budgets: this.budgetSnapshot() })], details: { evidenceId, ...finding }, isError: true };
        } finally {
          this.state.metrics.stages.push({ stage: name, elapsedMs: performance.now() - started, toolInvocation });
          this.save();
        }
      });
      this.queue = work.then(() => undefined, () => undefined);
      return work;
    } };
  }
  tools() {
    return [
      this.tool('sensing', 'Read immutable sensing recipes and explicit role bindings. Optionally resolve one exact participant label against an actor specification to obtain canonical sensor arrays. Never edits roles or inserts sensors. Bind template.extensions.sensingPolicy={digest,participants:{exactLabel:[roleIds]}} and explicitly author returned actor.sensors in atomic edits. Diagnostic cameras are not sensor pixels.', object({participant: string, actor: arbitrary, variant: {enum: ['base', 'control']}}), async ({participant, actor, variant = 'base'}) => {
        if (!this.sensingPolicy) return {assigned: false, scope: 'No frozen instrumentation policy assigned to this standalone run'};
        assert(Boolean(participant) === Boolean(actor), 'participant and actor must be supplied together');
        const {policy, digest} = this.sensingPolicy;
        return {assigned: true, digest, brief: policy.brief, participants: policy.participants,
          ...(participant ? {sensors: expectedParticipantSensors(policy, participant, actor, variant)} : {}),
          declaration: validateSensingProgram(this.program(), policy, variant)};
      }),
      this.tool('inspect', 'Inspect the current frozen program, workbench state or a source-backed location.', object({ kind: { enum: ['program', 'workbench', 'location'] }, reference: string }, ['kind']), async a => {
        if (a.kind === 'program') return { candidate: this.state.active, ...this.state.candidates[this.state.active],
          branch: this.state.branches[this.state.active], branches: this.state.branches, branching: this.branching,
          program: { ...this.program(), source: { id: this.state.source.id, kind: this.state.source.kind, mapId: this.state.source.mapId, frame: this.state.source.frame, time: this.state.source.time, artifactCount: this.state.source.artifacts.length } },
          assetSourceIds: 'bind_asset returns the pinned sourceId for participant.appearance', namedSchemas: ['SceneAbsoluteRoleSchema', 'InteractionSchema', 'SituationParticipantSchema', 'SituationEventSchema', 'SituationConstraintSchema', 'SituationKnobSchema'], budgets: this.budgetSnapshot(), counters: this.state.counters, support: SUPPORT };
        if (a.kind === 'workbench') { const { sourceArtifacts, ...state } = await this.client.getState(); return { ...state, sourceArtifactCount: sourceArtifacts.length }; }
        assert(a.reference, 'Location reference required');
        return { location: getLocation(this.bundle.catalog, a.reference), description: describeLocation(this.bundle.catalog, a.reference) };
      }),
      this.tool('capabilities', 'Read curated implementation/mechanism findings with pinned evidence. No scenario answers, no benchmark retrieval, no automatic promotion of this run. Stale implementation findings are not current support.', object({
        backend: string, operation: string, search: string, limit: integer(1, 20),
      }), a => this.capabilities ? queryCapabilityMemory(this.capabilities, a) : { records: [], stale: [], reason: 'No curated memory snapshot supplied' }),
      this.tool('query', 'Grounded queries: assets uses search (omit to browse); resolve-location uses search for natural language; locations uses structured query filters only. Facts/lane/schema have separate exact fields. No ignored fields or scenario recipes.', querySchema, async a => {
        const key = canonicalJson(a);
        if (this.staticQueries.has(key)) return this.staticQueries.get(key);
        let result;
        if (a.kind === 'locations') result = findLocations(this.bundle.catalog, { ...a.query, limit: a.limit ?? 8 });
        else if (a.kind === 'resolve-location') result = resolveReference(this.bundle.catalog, a.search, { limit: a.limit ?? 8 });
        else if (a.kind === 'facts') result = [...knownFactKeys(this.bundle.catalog)].sort();
        else if (a.kind === 'lane') { assert(a.reference && this.bundle.topology.lanes[a.reference], 'Unknown lane reference'); result = { frame: 'xodr-local metres; scene=(x,up,-y)', lane: this.bundle.topology.lanes[a.reference] }; }
        else if (a.kind === 'lanes') result = Object.keys(this.bundle.topology.lanes).slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 20));
        else if (a.kind === 'assets') result = this.library.search(a.search ?? '', a.limit ?? 8);
        else result = this.library.schema(a.reference ?? 'SituationTransactionSchema', a.pointer ?? '');
        if (this.staticQueries.size >= 128) this.staticQueries.delete(this.staticQueries.keys().next().value);
        this.staticQueries.set(key, result);
        return result;
      }),
      this.tool('workbench', 'Typed real Blender actions. Use payload.op. For absolute site inspection: op look, mode world, frame simforge-y-up, eye/target in meters, explicit fovYDeg. Other camera modes: home/frame-selection/orbit/pan/dolly. Query WorkbenchActionSchema for complete fields. Geometry edits remain visual-only, never simulation truth. Use look afterward to inspect pixels.', object({ payload: WorkbenchActionSchema }, ['payload']), ({ payload }) => this.client.action(payload)),
      this.tool('look', 'Get the current actual Blender frame, validated and downscaled by the shared client.', object(), () => this.client.frame()),
      this.tool('bind_asset', 'Bind an explicitly selected library asset to its exact engine catalog ID and hashed GLB. Returns measured native vertex bounds before placement; these include accessories and are not automatically a physical body collider. No generated assets or unrelated replacements.', object({ actorId: string, libraryId: string, catalogId: string }, ['actorId', 'libraryId', 'catalogId']), async a => {
        const binding = this.library.bind(a);
        binding.sourceId = `asset:${a.libraryId}`;
        assert(this.state.source.artifacts.some(row => row.id === binding.sourceId && row.sha256 === binding.sha256), 'Asset not in the immutable source inventory');
        const inspected = await this.client.action({ op: 'inspect-asset', path: binding.path, sha256: binding.sha256 });
        assert(inspected.asset?.sha256 === binding.sha256 && inspected.asset.frame === 'simforge-y-up', 'Native asset measurement identity mismatch');
        binding.geometry = inspected.asset;
        this.state.bindings[this.state.active] ??= {};
        this.state.bindings[this.state.active][a.actorId] = binding;
        return binding;
      }),
      this.tool('adopt_geometry', 'Export one current grounded addition-only Blender job and atomically add its immutable GLB plus a static opaque planar OBB collision/occlusion proxy. Requires unparented applied meshes and constant opaque PBR materials. Source edits remain visual-only. A later rehearsal restores the original preview scene and renders the committed asset; this is not triangle or vertical physics.', object({
        jobId: string, roleId: string, intention: string, baseRevision: integer(0, Number.MAX_SAFE_INTEGER), baseDigest: string,
      }, ['jobId', 'roleId', 'intention', 'baseRevision', 'baseDigest']), async a => {
        const base = this.program();
        assert(base.revision === a.baseRevision && situationDigest(base) === a.baseDigest, 'Stale situation geometry adoption');
        const exported = await this.client.action({ op: 'export-geometry', jobId: a.jobId });
        const descriptor = await loadGeometryExport(exported.descriptor);
        const prepared = await prepareStaticGeometry(base, descriptor, { roleId: a.roleId, intention: a.intention });
        const next = applySituationTransaction(base, prepared.transaction);
        const records = { ...(this.state.geometryBindings[this.state.active] ?? {}),
          [prepared.geometryBinding.patchId]: { ...prepared.geometryBinding, descriptorReference: exported.descriptor } };
        const verified = await this.loadGeometryBindings(records);
        compileSituation(this.bounded(next.program), this.bundle, { seed: this.options.seed, geometryBindings: verified });
        const candidate = this.recordProgram(next.program, prepared.transaction);
        this.state.bindings[this.state.active] = { ...(this.state.bindings[this.state.active] ?? {}), [a.roleId]: prepared.binding };
        this.state.geometryBindings[this.state.active] = records;
        this.verifiedGeometry.set(this.state.active, verified);
        this.state.candidates[this.state.active] = candidate;
        return { ...candidate, binding: prepared.binding, changedPaths: next.changedPaths,
          support: 'Static enclosing opaque planar OBB; no road, triangle-contact, animation or vertical-contact claim.',
          preview: 'Still visual-only. Original source scene is restored before executable rehearsal.' };
      }),
      this.tool('edit', 'Apply a typed atomic SituationTransaction against exact baseRevision/baseDigest. Query SituationTransactionSchema for fields. Source is immutable.', object({ transaction: arbitrary }, ['transaction']), async ({ transaction }) => {
        const next = applySituationTransaction(this.program(), transaction);
        this.bounded(next.program);
        this.state.candidates[this.state.active] = this.recordProgram(next.program, transaction);
        return { ...this.state.candidates[this.state.active], changedPaths: next.changedPaths };
      }),
      this.tool('fork', 'Branch on a declared hypothesis and falsifier, preserving the exact parent digest. switchOnly selects an existing candidate without mutation. Branching is absent in the nonbranching ablation.', object({
        candidate: string, from: string, switchOnly: { type: 'boolean' }, hypothesis: string, falsifier: string,
        evidenceIds: { type: 'array', items: string, maxItems: 8 },
      }, ['candidate']), async a => {
        if (!a.switchOnly) return this.branch(a);
        assert(a.from === undefined && a.hypothesis === undefined && a.falsifier === undefined && a.evidenceIds === undefined, 'switchOnly accepts only candidate');
        assert(this.state.candidates[a.candidate], 'Unknown candidate');
        const verified = await this.loadGeometryBindings(this.state.geometryBindings[a.candidate] ?? {});
        this.state.active = a.candidate;
        this.verifiedGeometry.set(a.candidate, verified);
        return { ...this.state.candidates[a.candidate], branch: this.state.branches[a.candidate] };
      }),
      this.tool('repair', 'Create a causal repair branch from the current immutable candidate, citing exact candidate-local failure/rehearsal evidence. The typed transaction is validated before publishing any branch. Neither stale evidence nor a failed transaction can mutate the parent.', object({
        candidate: string, hypothesis: string, falsifier: string, evidenceIds: { type: 'array', items: string, minItems: 1, maxItems: 8 },
        transaction: arbitrary,
      }, ['candidate', 'hypothesis', 'falsifier', 'evidenceIds', 'transaction']), a => this.branch(a, a.transaction)),
      this.tool('rehearse', 'Execute the actual engine first; persist exact input/trace and event residuals. Rendering is a separate targeted render tool so simulation failures cost no GPU.', object(), async () => {
        this.verifiedGeometry.set(this.state.active, await this.prepareExecution());
        this.reserveRuns(1);
        return this.storeRun(rehearseSituation(this.bounded(), this.bundle, this.runOptions()));
      }),
      this.tool('solve', 'Bounded canonical simulation-backed search over only declared knobs; persists attempts and the winning atomic transaction. Budget exhaustion is not impossibility.', object({ maxEvaluations: integer(1, 32) }, ['maxEvaluations']), async a => {
        this.verifiedGeometry.set(this.state.active, await this.prepareExecution());
        this.reserveRuns(a.maxEvaluations);
        const evaluations = [];
        const solved = solveSituation(this.bounded(), this.bundle, { ...this.runOptions(), maxEvaluations: a.maxEvaluations,
          onEvaluation: (program, rehearsal) => { evaluations.push(this.storeRun(rehearsal, 'evaluation', program).id); },
        });
        assert(evaluations.length > 0, 'Solver reported no evaluation evidence; every native evaluation must be persisted before a result is trusted');
        const id = this.artifact('solve', { ...solved, evaluations });
        if (solved.transaction) this.state.candidates[this.state.active] = this.recordProgram(solved.program, solved.transaction);
        return { id, status: solved.status, attempts: solved.attempts, evaluations, rehearsal: this.storeRun(solved.rehearsal) };
      }),
      this.tool('render', 'Render a targeted frame from a persisted real execution. World camera uses eye/target in SimForge y-up meters. Actor-relative camera requires actorId, offset and targetOffset, both [forward,up,right], plus fovYDeg. Query InspectionCameraSchema for exact fields. All views diagnostic, not policy sensor attestation.', object({ rehearsalId: string, frameIndex: integer(0, 100000), camera: InspectionCameraSchema, samples: integer(1, 256) }, ['rehearsalId', 'frameIndex', 'camera']), a => this.render(a)),
      this.tool('compare', 'Execute paired arms under identical seed with one intervention, explicit preserve.roles and reactiveRoleIds. Physical actor absence uses addInteraction with actor=<roleId>, verb=exist, trigger={kind:at,t:0}, target={state:absent}; keep role and participant definitions so information/events remain meaningful. removeRole deletes the semantic definition, not just presence. Persists exact inputs/traces and event differences; no automatic causal claim.', object({ transaction: arbitrary, reactiveRoleIds: { type: 'array', items: string, maxItems: 32 }, hypothesis: string, expectedEventId: string }, ['transaction', 'reactiveRoleIds', 'hypothesis', 'expectedEventId']), async a => {
        assert(a.transaction.templateOps?.length === 1 && !a.transaction.changes, 'Comparison requires exactly one template operation and no metadata changes');
        assert(a.transaction.templateOps[0].type !== 'removeRole', 'role_definition_is_not_presence: retain the role and participant information; use one addInteraction with actor=<roleId>, verb=exist, trigger={kind:at,t:0}, target={state:absent} for physical absence. Inspect any existing existence schedule before choosing its timing.');
        assert(Array.isArray(a.transaction.preserve?.roles), 'Explicit preserve.roles required, even when empty');
        assert(this.program().events.some(e => e.id === a.expectedEventId), 'Expected event must already be defined');
        this.bounded();
        const controlProgram = this.bounded(applySituationTransaction(this.program(), a.transaction).program);
        this.requireSensing(controlProgram, 'control');
        this.verifiedGeometry.set(this.state.active, await this.prepareExecution());
        this.reserveRuns(2);
        const result = compareSituation(this.program(), a.transaction, this.bundle, { ...this.runOptions(), reactiveRoleIds: a.reactiveRoleIds });
        const id = this.artifact('comparison', { declaration: a, result });
        const base = this.storeRun(result.base);
        const interventionProgram = applySituationTransaction(this.program(), a.transaction).program;
        const intervention = this.storeRun(result.intervention, 'rehearsal', interventionProgram);
        this.state.comparisons[id] = { digest: situationDigest(this.program()), baseId: base.id, interventionId: intervention.id };
        return { id, baseId: base.id, interventionId: intervention.id, changedRoles: result.changedRoles, changedTracks: result.changedTracks, invariantFailures: result.invariantFailures, eventDeltas: result.eventDeltas };
      }),
      this.tool('participant_review', 'One offline scoped participant critic. Only own intention and actual reported detections through selected frame; no hidden actors, truth, missed-target identities, future or author hypothesis.', object({ rehearsalId: string, actorId: string, frameIndex: integer(0, 100000) }, ['rehearsalId', 'actorId', 'frameIndex']), a => this.participantReview(a)),
      this.tool('review', 'Verify exact paired engine replay BEFORE three independent Astra-low judges evaluate frozen evidence and saved pixels. Include evidenceIds of material saved query/inspect/measure results, such as lane geometry and legal stopping facts; author assertions do not replace them. Requires two replay attempts once per comparison and three model requests per changed evidence packet. All three judges must be valid and two must accept; disagreements remain.', object({ comparisonId: string, evidenceIds: { type: 'array', items: string, maxItems: 12, uniqueItems: true } }, ['comparisonId']), a => this.review(a.comparisonId, a.evidenceIds)),
      this.tool('accept', 'Recheck source/asset/event/causal gates and the exact replay proof already seen by a valid frozen judge ensemble. Result is ensemble_accepted: automated judgment, not human or ground-truth certification.', object({ comparisonId: string, reviewId: string }, ['comparisonId', 'reviewId']), a => this.accept(a)),
      this.tool('abandon_candidate', 'Reject only the active candidate, retaining its evidence and returning to its parent. The authoring run continues. Use this after a failed arrangement, not finish_failure. New hypotheses may fork from the saved parent or abandoned candidate.', object({
        explanation: string, evidenceIds: { type: 'array', items: string, minItems: 1, maxItems: 8 },
      }, ['explanation', 'evidenceIds']), async a => {
        const candidate = this.state.active, digest = situationDigest(this.program());
        const evidence = this.branchEvidence(a.evidenceIds, digest);
        const branch = this.state.branches[candidate];
        const parent = branch.from && this.state.branches[branch.from]?.status !== 'abandoned' ? branch.from : null;
        const verified = parent ? await this.loadGeometryBindings(this.state.geometryBindings[parent] ?? {}) : null;
        const id = this.artifact('abandon', { candidate, programDigest: digest, ...a, evidence });
        Object.assign(branch, { status: 'abandoned', finalDigest: digest, abandonmentId: id, explanation: a.explanation });
        if (parent) {
          this.state.active = parent;
          this.verifiedGeometry.set(parent, verified);
        }
        return { id, abandoned: candidate, active: this.state.active, runStatus: this.state.status, instruction: 'The brief remains active. Investigate or repair another grounded arrangement.' };
      }),
      this.tool('finish_failure', 'End the ENTIRE brief for a concrete rejected, impossible, unsupported or infrastructure outcome. Do not use for one failed candidate or anticipated budget limits: continue repairs or abandon_candidate. Resource exhaustion is owned by the runner. Impossible/unsupported requires direct saved evidence, never keywords or solver exhaustion.', object({ scope: { const: 'entire-brief' }, outcome: { enum: FAILURE_OUTCOMES }, explanation: string, evidenceIds: { type: 'array', items: string } }, ['scope', 'outcome', 'explanation', 'evidenceIds']), async a => {
        for (const id of a.evidenceIds) this.readArtifact(id);
        assert(FAILURE_OUTCOMES.includes(a.outcome), 'Only the runner may classify resource exhaustion; choose a supported evidence-based failure outcome');
        assert(!['impossible', 'unsupported'].includes(a.outcome) || a.evidenceIds.length > 0, 'Impossible or unsupported requires a persisted evidence finding');
        this.state.status = a.outcome;
        this.state.decision = a;
        return a;
      }),
    ].filter(tool => this.branching || !['fork', 'repair', 'abandon_candidate'].includes(tool.name));
  }
  async render({ rehearsalId, frameIndex, camera, samples }) {
    const row = this.state.rehearsals[rehearsalId];
    assert(row, 'Unknown rehearsal');
    const run = this.readArtifact(rehearsalId);
    assert(row.views.length < 6, 'At most six targeted evidence views per execution');
    assert(Object.keys(run.simulation.trace.header.propMetadata ?? {}).length === 0, 'Fixed props are not emitted into scene-state by the canonical emitter; cannot claim render closure');
    const scene = sceneState(run.simulation.trace);
    assert(frameIndex < scene.frames.length, 'Frame outside execution');
    const program = parseSituationProgram(JSON.parse(fs.readFileSync(this.file(row.programFile), 'utf8')));
    await this.prepareExecution(program, row.geometryBindings ?? {});
    const bindings = scene.actors.map(actor => {
      const binding = row.bindings[actor.id];
      assert(binding && binding.catalogId === actor.catalogId, `Explicit asset binding missing/mismatched for ${actor.id}:${actor.catalogId}`);
      const participant = program.participants.find(p => p.roleId === actor.id);
      assert(participant?.appearance.sourceId === binding.sourceId, `Participant appearance does not match bound asset for ${actor.id}`);
      assert(fileHash(binding.path) === binding.sha256, `Render asset changed: ${actor.id}`);
      return { actorId: actor.id, catalogId: actor.catalogId, path: binding.path, sha256: binding.sha256,
        ...(binding.groundOffsetM === undefined ? {} : { groundOffsetM: binding.groundOffsetM }) };
    });
    const identity = hash(canonicalJson({ scene, bindings }));
    if (!this.executionIds.has(identity)) this.executionIds.set(identity, (await this.client.bindExecution({ scene, assetBindings: bindings, grounding: 'source-map' })).executionId);
    const rendered = await this.client.renderFrame({ executionId: this.executionIds.get(identity), frameIndex, camera, ...(samples ? { samples } : {}) });
    assert(rendered.evidence.visualOnlyPatches.length === 0,
      'Rendered geometry has visual-only edits without semantic/physical closure; undo them before generating executable acceptance evidence');
    if (this.executionIds.size > 16) this.executionIds.delete(this.executionIds.keys().next().value);
    const images = [];
    for (const block of rendered.content) if (block.type === 'image') {
      const bytes = Buffer.from(block.data, 'base64');
      const sha256 = hash(bytes), file = `images/${sha256}`;
      fs.mkdirSync(this.file('images'), { recursive: true });
      if (!fs.existsSync(this.file(file))) fs.writeFileSync(this.file(file), bytes, { mode: 0o600 });
      images.push({ sha256, file, mimeType: block.mimeType });
    }
    assert(images.length > 0, 'Renderer returned no actual image');
    const view = { frameIndex, camera, t: scene.frames[frameIndex].t, images, evidence: rendered.evidence, bindings,
      assetMetadata: scene.actors.map(actor => ({ actorId: actor.id, canonicalDims: actor.dims, library: row.bindings[actor.id] })),
      scope: 'diagnostic-not-policy-sensor' };
    row.views.push(view);
    return { content: rendered.content, evidence: view };
  }
  makeAgent(kind, tools, systemPrompt) {
    const id = `${kind}-${++this.state.counters.sequence}`;
    const gateway = createGatewayAgent({ modelId: ASTRA_MODEL, systemPrompt, tools, sessionDir: this.file(`sessions/${id}`), maxTokens: 8000,
      transformContext: async history => {
        assert(this.state.counters.calls < this.options.maxCalls, 'model_call_budget_exhausted');
        this.state.counters.calls++;
        this.save();
        return history;
      } });
    this.agents.push({ id, gateway });
    return { id, ...gateway };
  }
  async prompt(gateway, prompt) {
    try { await gateway.agent.prompt(typeof prompt === 'string' ? prompt : { role: 'user', content: prompt, timestamp: Date.now() }); }
    finally { gateway.save(); }
    const message = gateway.agent.state.messages.findLast(m => m.role === 'assistant');
    assert(message && !['error', 'aborted'].includes(message.stopReason), message?.errorMessage ?? 'Gateway request failed or timed out');
  }
  async participantReview({ rehearsalId, actorId, frameIndex }) {
    const run = this.readArtifact(rehearsalId);
    assert(this.state.rehearsals[rehearsalId], 'Unknown rehearsal');
    const track = run.simulation.trace;
    assert(frameIndex < track.ticks.t.length, 'Frame outside execution');
    const frozenProgram = parseSituationProgram(JSON.parse(fs.readFileSync(this.file(this.state.rehearsals[rehearsalId].programFile), 'utf8')));
    const participant = frozenProgram.participants.find(p => p.roleId === actorId);
    assert(participant, 'Unknown participant');
    const sensors = Object.values(track.ticks.sensors ?? {}).filter(s => s.observer === actorId);
    assert(sensors.length, 'No executed participant sensor channel; diagnostic camera cannot substitute');
    const observations = reportedSensorObservations(track, sensors, frameIndex);
    // Intention is participant-owned. Author brief/hypothesis, truth poses, LOS and missed-target records never cross this boundary.
    const scoped = { actorId, intention: participant.intention, untilS: track.ticks.t[frameIndex], observations,
      limitation: 'Synthetic detection reports only, not pixel observations; no claim of sensor fidelity or complete belief state.' };
    const id = this.artifact('participant', { programDigest: run.bound.programDigest, rehearsalId, scoped });
    const reviewer = this.makeAgent('participant', [], 'You are an offline participant-perspective critic. Only use the supplied participant-owned intention and reported detections. Do not infer unseen actors, hidden intentions, future events or claim access to sensor pixels. Explain plausible uncertainty and any unsupported behavioral inference. You cannot approve the scenario.');
    await this.prompt(reviewer, JSON.stringify(scoped));
    const response = reviewer.agent.state.messages.findLast(m => m.role === 'assistant');
    const reviewId = this.artifact('participantreview', { scopeId: id, response, identity: reviewer.identity });
    return { reviewId, scopeId: id, response: response.content };
  }
  validateReviewEvidence(frozen) {
    if (frozen.sensing) assert(frozen.sensing.base.valid && frozen.sensing.intervention.valid,
      'Frozen sensing execution mismatch: ' + canonicalJson({base: frozen.sensing.base.issues, intervention: frozen.sensing.intervention.issues}));
    assert(frozen.base.satisfied && frozen.base.constraints.length > 0, 'Base event constraints are not satisfied');
    assert(!frozen.invariantFailures.length, 'Paired invariants failed');
    const effect = frozen.eventDeltas.find(e => e.id === frozen.declaration.expectedEventId);
    const tolerance = frozen.program.events.find(e => e.id === frozen.declaration.expectedEventId).toleranceS;
    assert(effect && (effect.baseOccurs !== effect.interventionOccurs || (effect.deltaS !== null && Math.abs(effect.deltaS) > tolerance)), 'Declared intervention did not change its named event beyond its declared tolerance');
    assert(frozen.program.question.hypothesis.trim() && frozen.program.question.falsifier.trim(), 'A decision hypothesis and falsifier are required');
    assert(frozen.program.geometryPatches.every(patch => patch.status === 'executable'), 'Visual-only patches cannot qualify an executable situation');
    assert(!frozen.program.template.props.length, 'Canonical scene emitter does not emit fixed props: render closure unsupported');
    for (const [name, run, views] of [['base', frozen.base, frozen.baseViews], ['intervention', frozen.intervention, frozen.interventionViews]]) {
      assert(!run.issues.some(i => i.severity === 'error'), `${name} has engine errors`);
      assert(views.some(v => v.camera.kind === 'actor-relative') && views.some(v => v.camera.kind === 'world'), `${name} requires participant-relative and world diagnostic views`);
      assert(views.length <= 6, 'Each arm may retain at most six acceptance views');
      for (const view of views) {
        assert(Array.isArray(view.evidence.visualOnlyPatches) && view.evidence.visualOnlyPatches.length === 0,
          'Saved evidence contains unattested or visual-only geometry; it cannot qualify an executable scenario');
        for (const b of view.bindings) assert(fileHash(b.path) === b.sha256, 'Bound render asset changed');
        for (const image of view.images) assert(fileHash(this.file(image.file)) === image.sha256, 'Evidence pixels changed');
      }
    }
  }
  async prepareReview(comparisonId, evidenceIds) {
    const program = this.program(), ref = this.state.comparisons[comparisonId];
    assert(ref && ref.digest === situationDigest(program), 'Comparison is absent or stale for active candidate');
    const ids = evidenceIds ?? ref.groundingEvidenceIds ?? [];
    assert(Array.isArray(ids) && ids.length <= 12 && new Set(ids).size === ids.length, 'At most twelve unique grounding evidence IDs');
    for (const id of ids) {
      assert(/^tool-\d+$/.test(id), 'Grounding evidence must be a successful saved tool result');
      assert(['query', 'inspect', 'measure'].includes(this.readArtifact(id).name), 'Only grounded queries, inspections and measurements may be attached');
    }
    verifySources(program.source);
    this.verifiedGeometry.set(this.state.active, await this.loadGeometryBindings(this.state.geometryBindings[this.state.active] ?? {}));
    if (!ref.replayIds) {
      this.reserveRuns(2);
      const comparison = this.readArtifact(comparisonId);
      const base = rehearseSituation(this.bounded(program), this.bundle, this.runOptions());
      const baseId = this.storeRun(base, 'replay', program).id;
      const control = applySituationTransaction(program, comparison.declaration.transaction).program;
      const intervention = rehearseSituation(this.bounded(control), this.bundle, this.runOptions());
      const interventionId = this.storeRun(intervention, 'replay', control).id;
      ref.replayIds = { base: baseId, intervention: interventionId };
    }
    ref.groundingEvidenceIds = [...ids].sort();
    // Reconstructing the packet verifies exact replay bytes, including a reused proof.
    this.frozenEvidence(comparisonId);
    this.save();
  }
  frozenEvidence(comparisonId) {
    const program = this.program();
    const ref = this.state.comparisons[comparisonId];
    assert(ref && ref.digest === situationDigest(program), 'Comparison is absent or stale for active candidate');
    assert(ref.replayIds, 'Paired replay proof is required before judging');
    return buildFrozenSituationEvidence({ brief: this.options.brief, program, source: this.state.source, comparisonId,
      comparison: this.readArtifact(comparisonId),
      baseViews: this.state.rehearsals[ref.baseId].views,
      interventionViews: this.state.rehearsals[ref.interventionId].views,
      replays: Object.fromEntries(Object.entries(ref.replayIds).map(([arm, id]) => [arm, {id, run:this.readArtifact(id)}])),
      groundingEvidence: ref.groundingEvidenceIds.map(id => ({id, ...this.readArtifact(id)})), sensingPolicy: this.sensingPolicy?.policy ?? null });
  }
  async review(comparisonId, evidenceIds) {
    await this.prepareReview(comparisonId, evidenceIds);
    const frozen = this.frozenEvidence(comparisonId);
    const evidenceDigest = hash(canonicalJson(frozen));
    for (const view of [...frozen.baseViews, ...frozen.interventionViews]) for (const image of view.images) {
      assert(fileHash(this.file(image.file)) === image.sha256, 'Frozen review evidence pixels changed');
    }
    const cached = Object.entries(this.state.reviews).find(([, row]) => row.evidenceDigest === evidenceDigest && row.policyDigest === REVIEW_POLICY_DIGEST);
    if (cached) return { id: cached[0], evidenceId: cached[1].evidenceId, ...cached[1].verdict, cached: true };
    assert(this.state.submissions.length < this.maxSubmissions, 'submission_budget_exhausted');
    const submission = { attempt: this.state.submissions.length + 1, candidate: this.state.active,
      programDigest: frozen.programDigest, comparisonId, evidenceDigest, policyDigest: REVIEW_POLICY_DIGEST, accepted: false };
    this.state.submissions.push(submission);
    this.save();
    this.validateReviewEvidence(frozen);
    assert(this.state.counters.calls + SCENARIO_REVIEW_POLICY.memberCount <= this.options.maxCalls, 'model_call_budget_exhausted');
    const content = [text(frozen)];
    for (const view of [...frozen.baseViews, ...frozen.interventionViews]) for (const image of view.images) {
      const bytes = fs.readFileSync(this.file(image.file));
      assert(hash(bytes) === image.sha256, 'Evidence image changed');
      content.push(text({ frameIndex: view.frameIndex, t: view.t, camera: view.camera, scope: view.scope }), { type: 'image', data: bytes.toString('base64'), mimeType: image.mimeType });
    }
    assert(content.filter(block => block.type === 'image').length <= 12, 'Review accepts at most twelve targeted images; choose a bounded evidence set');
    const evidenceId = this.artifact('evidence', frozen);
    const verdict = await reviewEnsemble({ policy: SCENARIO_REVIEW_POLICY, evidenceDigest, content,
      makeReviewer: (kind, systemPrompt) => this.makeAgent(kind, [], systemPrompt),
      prompt: (reviewer, message) => this.prompt(reviewer, message) });
    const validation = validateEnsembleReview(verdict, { policy: SCENARIO_REVIEW_POLICY, evidenceDigest });
    const id = this.artifact('review', { verdict, evidenceDigest, policyDigest: REVIEW_POLICY_DIGEST, comparisonId, evidenceId });
    this.state.reviews[id] = { evidenceDigest, policyDigest: REVIEW_POLICY_DIGEST, comparisonId, evidenceId, verdict };
    Object.assign(submission, { reviewId: id, evidenceId, decision: verdict.decision });
    this.save();
    return { id, evidenceId, ...verdict, validation };
  }
  async accept({ comparisonId, reviewId }) {
    const frozen = this.frozenEvidence(comparisonId);
    const review = this.state.reviews[reviewId];
    assert(review?.comparisonId === comparisonId && review.evidenceDigest === hash(canonicalJson(frozen)) && review.policyDigest === REVIEW_POLICY_DIGEST, 'Ensemble review does not cover these exact frozen bytes and policy');
    const validation = validateEnsembleReview(review.verdict, { policy: SCENARIO_REVIEW_POLICY, evidenceDigest: review.evidenceDigest });
    assert(validation.valid && review.verdict.decision === 'accept', `Frozen ensemble did not accept: ${validation.errors.join('; ')}`);
    this.validateReviewEvidence(frozen);
    this.verifiedGeometry.set(this.state.active, await this.loadGeometryBindings(this.state.geometryBindings[this.state.active] ?? {}));
    for (const view of [...frozen.baseViews, ...frozen.interventionViews]) {
      const findings = [...(view.evidence?.unsupportedCapabilities ?? []), ...(view.evidence?.findings ?? [])].map(f => typeof f === 'string' ? f : canonicalJson(f));
      for (const finding of findings) assert(review.verdict.capabilityAssessments?.some(a => a.finding === finding && a.disposition === 'not-required' && a.explanation.trim()),
        `Independent review has not resolved render limitation against the brief: ${finding}`);
    }
    verifySources(this.state.source);
    const {base: replayId, intervention: controlReplayId} = this.state.comparisons[comparisonId].replayIds;
    this.state.status = 'ensemble_accepted';
    this.state.decision = { comparisonId, reviewId, replayId, controlReplayId, evidenceDigest: review.evidenceDigest,
      policyDigest: REVIEW_POLICY_DIGEST, qualification: 'automated', support: SUPPORT };
    return { status: this.state.status, ...this.state.decision };
  }
  resumeInfrastructure() {
    assert(this.state.status === 'infrastructure', 'Only an infrastructure-interrupted run can be resumed explicitly');
    assert(this.state.counters.calls < this.options.maxCalls, 'No model-call budget remains');
    verifySources(this.state.source);
    const interruptionId = this.artifact('interruption', this.result());
    this.state.interruptions ??= [];
    this.state.interruptions.push(interruptionId);
    this.state.status = 'running';
    this.state.decision = null;
    this.save();
  }
  async run() {
    if (this.state.status !== 'running') return this.result();
    if (this.state.counters.calls >= this.options.maxCalls) {
      this.state.status = 'budget';
      this.state.decision = { explanation: 'Model request cap reached; no new gateway session is needed to record exhaustion.' };
      this.state.metrics.elapsedMs += performance.now() - this.started;
      this.save();
      const result = this.result();
      saveJson(this.file('result.json'), result);
      return result;
    }
    // A resumed director rehydrates the same gateway session rather than starting a new author.
    const branchInstructions = this.branching
      ? ' Use small fork/repair branches for distinct causal hypotheses. A repair cites evidence from the exact parent digest; keep the parent intact and test the falsifier before choosing a branch.'
      : ' This is the nonbranching situation-tool arm: revise the single candidate and still verify its declared one-cause control.';
    const sensingInstructions = this.sensingPolicy ? ' A per-brief sensing policy is frozen. Call sensing, bind every exact brief participant label to your concrete role IDs in template.extensions.sensingPolicy, and explicitly author canonical sensor arrays returned for each actor. You cannot tune, replace or omit assigned sensors. Physical presence changes do not change instrumentation; reported synthetic detections are not sensor pixels.' : '';
    const director = createGatewayAgent({ modelId: this.options.authorModel, effort: this.options.authorEffort, systemPrompt: DIRECTOR + RUNTIME_GUIDANCE + branchInstructions + sensingInstructions, tools: this.tools(), sessionDir: this.file('sessions/director'), maxTokens: this.options.maxOutputTokens ?? 8000,
      transformContext: async history => {
        assert(this.state.status === 'running', 'run_terminated');
        assert(this.state.counters.calls < this.options.maxCalls, 'model_call_budget_exhausted');
        this.state.counters.calls++;
        this.save();
        return history;
      } });
    this.agents.push({ id: 'director', gateway: director });
    try {
      while (this.state.status === 'running' && this.state.counters.calls < this.options.maxCalls) {
        await this.prompt(director, JSON.stringify({ brief: this.options.brief, map: this.options.map, seed: this.options.seed, candidate: this.state.candidates[this.state.active], interruptions: this.state.interruptions ?? [], budgets: this.budgetSnapshot(), instruction: 'Continue from saved state. After interruption inspect saved program and renderer state; never blindly repeat a write. Prior failures remain in this run. ' + (this.branching ? 'Repair evidence or abandon one arrangement while continuing the brief. ' : 'Revise the single candidate; a failed review does not end the brief. ') + 'Use finish_failure only for evidence-based whole-brief failure, never anticipated resource exhaustion. Leave three model requests for the independent ensemble and two rehearsals for exact paired replay.' }));
      }
      if (this.state.status === 'running') { this.state.status = 'budget'; this.state.decision = { explanation: 'Model call cap reached without acceptance; not evidence of impossibility.' }; }
    } catch (error) {
      if (this.state.status === 'running') {
        this.state.status = String(error.message).includes('budget_exhausted') ? 'budget' : 'infrastructure';
        this.state.decision = { explanation: String(error.stack ?? error), support: SUPPORT };
        this.artifact('failure', this.state.decision);
      }
    } finally {
      for (const { id, gateway } of this.agents) {
        gateway.save();
        saveJson(this.file(`metrics/${id}.json`), { identity: gateway.identity, usage: gateway.usage });
        this.state.metrics.models ??= {};
        this.state.metrics.models[id] = { requests: gateway.usage.requests.length, tokens: gateway.usage.totals,
          tools: { totals: gateway.usage.tools.totals, byName: gateway.usage.tools.byName }, cost: gateway.usage.cost };
      }
      this.state.metrics.tokens = Object.values(this.state.metrics.models ?? {}).reduce((totals, row) => {
        for (const [key, value] of Object.entries(row.tokens)) totals[key] = (totals[key] ?? 0) + value;
        return totals;
      }, {});
      const modelMetrics = Object.values(this.state.metrics.models ?? {});
      const reportedRequests = modelMetrics.reduce((sum, row) => sum + (row.cost?.reportedRequests ?? 0), 0);
      const unavailableRequests = modelMetrics.reduce((sum, row) => sum + (row.cost?.unavailableRequests ?? row.requests), 0);
      const reportedTotal = reportedRequests ? modelMetrics.reduce((sum, row) => sum + (row.cost?.reportedTotal ?? 0), 0) : null;
      this.state.metrics.cost = { currency: 'USD', reportedRequests, unavailableRequests, reportedTotal,
        total: unavailableRequests === 0 ? reportedTotal : null };
      this.state.metrics.requestedTools = modelMetrics.every(row => row.tools)
        ? modelMetrics.reduce((sum, row) => sum + row.tools.totals.requested, 0) : null;
      this.state.metrics.elapsedMs += performance.now() - this.started;
      this.save();
      saveJson(this.file('result.json'), this.result());
    }
    return this.result();
  }
  result() {
    const models = Object.values(this.state.metrics.models ?? {});
    const argumentFailuresKnown = models.every(row => row.tools && [...REHEARSAL_TOOLS].every(name => !row.tools.byName[name]?.executionUnknown));
    const iterationArgumentFailures = argumentFailuresKnown ? models.reduce((total, row) =>
      total + [...REHEARSAL_TOOLS].reduce((count, name) => count + (row.tools.byName[name]?.validationFailures ?? 0), 0), 0) : null;
    const reviewId = this.state.decision?.reviewId ?? Object.entries(this.state.reviews).findLast(([, row]) =>
      row.policyDigest === REVIEW_POLICY_DIGEST && this.state.comparisons[row.comparisonId]?.digest === this.state.candidates[this.state.active]?.digest)?.[0] ?? null;
    const review = reviewId ? this.state.reviews[reviewId] : null;
    return { status: this.state.status, out: this.options.out, candidate: this.state.candidates[this.state.active], decision: this.state.decision ?? null,
      counters: this.state.counters, metrics: this.state.metrics, interruptions: this.state.interruptions ?? [],
      iterations: iterationArgumentFailures === null ? null : this.state.counters.iterations + iterationArgumentFailures,
      iterationArgumentFailures, counterOrigin: this.state.counterOrigin,
      submissionCounterOrigin: this.state.submissionCounterOrigin,
      submissions: this.state.submissions, firstSubmissionAccepted: this.state.submissionCounterOrigin > 0 ? null : Boolean(this.state.submissions[0]?.accepted),
      branches: this.state.branches, branching: this.branching, capabilityMemory: this.state.capabilityMemory ?? null, runtime: this.state.runtime ?? null,
      metricDefinitions: { calls: 'Gateway requests attempted across director and all critics; no per-tick model calls.',
        iterations: 'One requested rehearse, solve, or compare cycle, including compile/tool/argument failures; solve evaluations and paired arms share their enclosing cycle. Repeated inspection does not increment it. Null when historical argument-rejection evidence is incomplete.',
        rehearsals: 'Conservative engine-attempt budget units; failed compilation consumes a unit, interrupted solver reservations remain charged.',
        semanticEdits: 'Saved revision-changing transactions, excluding empty creation/fork/switch; measured since counterOrigin.',
        submissions: 'Frozen candidate/control evidence submitted to independent review, including rejected or incomplete evidence. Unchanged frozen reviews are cached, not rerolled. Acceptance requires subsequent deterministic closure. Measured since submissionCounterOrigin.',
        tools: 'Validated director implementation invocations, including implementation errors; not authoring iterations. Argument rejections are counted separately in requestedTools.',
        requestedTools: 'All model-requested tool calls across director and critics, including JSON/schema rejection and unknown tools; null if historical evidence is incomplete. Per-tool outcomes are in metrics.models.',
        cost: 'Only finite nonnegative gateway-reported USD. total is null unless every request is priced; reportedTotal covers only the known subset. Transport descriptor zeros are not observed prices.',
        elapsedMs: 'End-to-end process time including source binding; summed across resumed segments.',
        tokens: 'Reported gateway usage, not inferred pricing.' },
      evaluation: { kind: 'llm-ensemble', policyDigest: REVIEW_POLICY_DIGEST, reviewId,
        evidenceDigest: review?.evidenceDigest ?? null, decision: review?.verdict.decision ?? null, members: review?.verdict.members ?? [] },
      qualification: this.state.status === 'ensemble_accepted' ? 'automated' : 'incomplete' };
  }
}
export async function runSituationAuthoring({ resumeInfrastructure = false, ...options }) {
  const runner = await SituationAuthoringRunner.open(options);
  if (resumeInfrastructure) runner.resumeInfrastructure();
  return runner.run();
}

export function parseCli(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    assert(['--brief', '--brief-file', '--brief-record', '--map', '--out', '--workbench', '--seed', '--author-model', '--author-effort', '--sensing-policy', '--max-calls', '--max-rehearsals', '--resume-infrastructure', '--branching', '--capability-memory', '--max-submissions'].includes(argv[i]), `Unknown option ${argv[i]}`);
    assert(!flags.has(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing or duplicate option ${argv[i]}`);
    flags.set(argv[i], argv[i + 1]);
  }
  assert(['--brief', '--brief-file', '--brief-record'].filter(key => flags.has(key)).length === 1, 'Provide exactly one --brief, --brief-file or --brief-record');
  assert(!flags.has('--sensing-policy') || flags.has('--brief-record'), '--sensing-policy requires the independently frozen --brief-record');
  const briefRecord = flags.has('--brief-record') ? JSON.parse(fs.readFileSync(flags.get('--brief-record'), 'utf8')) : undefined;
  assert(!flags.has('--resume-infrastructure') || ['true', 'false'].includes(flags.get('--resume-infrastructure')), '--resume-infrastructure requires true or false');
  assert(!flags.has('--branching') || ['true', 'false'].includes(flags.get('--branching')), '--branching requires true or false');
  return { brief: briefRecord ? briefRecord.brief : flags.has('--brief-file') ? fs.readFileSync(flags.get('--brief-file'), 'utf8') : flags.get('--brief'), ...(briefRecord ? {briefRecord} : {}), map: flags.get('--map') ?? briefRecord?.mapId, out: flags.get('--out'), seed: flags.get('--seed'),
    workbench: flags.get('--workbench') ?? 'http://127.0.0.1:8767', maxCalls: Number(flags.get('--max-calls') ?? 24), maxRehearsals: Number(flags.get('--max-rehearsals') ?? 16),
    authorModel: flags.get('--author-model') ?? AUTHOR_MODEL,
    authorEffort: flags.get('--author-effort') ?? AUTHOR_EFFORT,
    ...(flags.has('--branching') ? { branching: flags.get('--branching') === 'true' } : {}),
    ...(flags.has('--capability-memory') ? { capabilityMemory: flags.get('--capability-memory') } : {}),
    ...(flags.has('--sensing-policy') ? { sensingPolicyFile: flags.get('--sensing-policy') } : {}),
    ...(flags.has('--max-submissions') ? { maxSubmissions: Number(flags.get('--max-submissions')) } : {}),
    resumeInfrastructure: flags.get('--resume-infrastructure') === 'true' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) console.log('node experiments/agentic-3d/situation-loop.mjs (--brief TEXT | --brief-file FILE | --brief-record JSON) --map MAP_ID --out DIR --seed SEED [--workbench URL] [--author-model anthropic/claude-opus-5] [--author-effort high|low] [--sensing-policy FILE (requires --brief-record)] [--max-calls 24] [--max-rehearsals 16] [--max-submissions 6] [--branching true|false] [--capability-memory FILE] [--resume-infrastructure true]');
  else {
    let options;
    try { options = parseCli(process.argv.slice(2)); const result = await runSituationAuthoring(options); console.log(JSON.stringify(result)); process.exitCode = result.status === 'ensemble_accepted' ? 0 : 2; }
    catch (error) {
      const failure = { status: 'infrastructure', explanation: String(error.stack ?? error), qualification: 'incomplete',
        evaluation: { kind: 'llm-ensemble', policyDigest: REVIEW_POLICY_DIGEST, reviewId: null, evidenceDigest: null, decision: null, members: [] } };
      if (options?.out) {
        const out = path.resolve(options.out);
        saveJson(path.join(out, 'failures', `startup-${Date.now()}-${process.pid}.json`), failure);
        if (!fs.existsSync(path.join(out, 'result.json'))) saveJson(path.join(out, 'result.json'), failure);
      }
      console.error(JSON.stringify(failure)); process.exitCode = 1;
    }
  }
}
