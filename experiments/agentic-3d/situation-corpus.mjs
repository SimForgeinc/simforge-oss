#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson } from '@simforge-oss/engine';
import { applySituationTransaction, parseSituationProgram, situationDigest } from '@simforge-oss/scenario';
import { loadMap, compareSituation, DEV_ASSETS } from '@simforge-oss/compiler/node';
import { authoringRuntimeIdentity, RUNTIME_IDENTITY_SCHEMA } from './runtime-identity.mjs';
import { buildFrozenSituationEvidence } from './situation-loop.mjs';
import { loadGeometryExport } from './geometry-binding.mjs';
import { assert, hash, fileHash, verifySources } from './situation-authoring-resources.mjs';
import { SCENARIO_REVIEW_POLICY, policyDigest, validateEnsembleReview } from './situation-ensemble.mjs';
import { sensingPolicyDigest, validateSensingExecution } from './situation-sensing-policy.mjs';
import { verifySituationAuthor } from './situation-benchmark-report.mjs';

const SCHEMA = 'simforge.situation-corpus/v1';
const digest = value => hash(canonicalJson(value));
const exact = (a, b, label) => assert(canonicalJson(a) === canonicalJson(b), `${label} mismatch`);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const QUALIFICATION = 'Automated current-policy ensemble judgment and deterministic evidence checks; not human calibration, ground truth, sensor fidelity, or portable dependency closure.';

function local(root, relative) {
  assert(typeof relative === 'string' && relative.length && !path.isAbsolute(relative) && !relative.split(/[\\/]/).some(p => p === '..' || p === '.' || !p), 'Unsafe corpus-relative path');
  const file = path.join(root, relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current)) assert(!fs.lstatSync(current).isSymbolicLink(), `Symlink is not evidence closure: ${current}`);
  }
  return file;
}
function inventory(root, relative = '') {
  const rows = [];
  for (const entry of fs.readdirSync(relative ? local(root, relative) : root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Run contains symlink: ${name}`);
    if (entry.isDirectory()) rows.push(...inventory(root, name));
    else {
      assert(entry.isFile(), `Run contains non-file: ${name}`);
      rows.push({ file: name, sha256: fileHash(local(root, name)) });
    }
  }
  return rows;
}

// Consumption uses pure evidence construction; it never creates an authoring session.
function reader(root, state) {
  const readArtifact = id => {
    assert(/^[a-z]+-\d+$/.test(id), 'Invalid artifact id');
    return json(local(root, `artifacts/${id}.json`));
  };
  const candidate = state.candidates[state.active];
  assert(candidate, 'Missing active candidate');
  const program = parseSituationProgram(json(local(root, candidate.file)));
  assert(situationDigest(program) === candidate.digest, 'Active candidate digest mismatch');
  return { state, program, readArtifact };
}
function bounded(program, brief) {
  const choreography = program.template.choreography;
  assert(program.question.brief === brief, 'Immutable user brief mismatch');
  assert(choreography.clipSeconds <= 60 && choreography.warmupSeconds <= 10, 'Execution exceeds runner duration envelope');
  assert(program.template.roles.length <= 32 && choreography.interactions.length <= 128 && program.events.length <= 32, 'Execution exceeds runner entity envelope');
  assert(program.participants.every(p => p.authority.every(a => a.kind !== 'policy')), 'External policies are not supplied');
  return program;
}
function externalDependencies(state, frozen, rows) {
  const pins = new Map();
  const add = (uri, sha256, purpose) => {
    assert(typeof uri === 'string' && sha(sha256), `Invalid ${purpose} dependency pin`);
    const file = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    assert(path.isAbsolute(file), `Dependency must be absolute: ${file}`);
    const previous = pins.get(file);
    assert(!previous || previous.sha256 === sha256, `Conflicting dependency pin: ${file}`);
    pins.set(file, { uri: pathToFileURL(file).href, sha256, requirement: purpose });
  };
  for (const source of state.source.artifacts) add(source.uri, source.sha256, 'Immutable map, ground or asset bytes; original absolute path must remain readable');
  for (const view of [...frozen.baseViews, ...frozen.interventionViews]) for (const binding of view.bindings) add(binding.path, binding.sha256, 'Bound render asset');
  for (const row of rows) for (const record of Object.values(row.geometryBindings ?? {})) {
    add(record.descriptorReference.uri, record.descriptorReference.sha256, 'Generated geometry descriptor');
    add(record.descriptor.asset.uri, record.descriptor.asset.sha256, 'Generated static mesh');
    for (const source of record.descriptor.sourceArtifacts) add(source.uri, source.sha256, 'Generated geometry immutable source');
  }
  return [...pins.values()].sort((a, b) => a.uri.localeCompare(b.uri));
}

export async function inspectAcceptedRun(root) {
  const state = json(local(root, 'state.json')), decision = state.decision;
  assert(state.status === 'ensemble_accepted' && decision?.qualification === 'automated', 'Run is not currently ensemble_accepted with automated qualification');
  assert(decision.policyDigest === policyDigest(SCENARIO_REVIEW_POLICY), 'Acceptance policy is not the current ensemble policy');
  const view = reader(root, state);
  const reference = state.comparisons[decision.comparisonId];
  assert(reference && reference.digest === situationDigest(view.program), 'Missing or stale comparison');
  const review = state.reviews[decision.reviewId];
  assert(review && review.comparisonId === decision.comparisonId && review.evidenceDigest === decision.evidenceDigest && review.policyDigest === decision.policyDigest, 'Review does not cover this decision');
  const saved = view.readArtifact(review.evidenceId);
  const assignmentFile = local(root, 'assignment.json');
  const assignment = fs.existsSync(assignmentFile) ? json(assignmentFile) : null;
  const outcomeFile = local(root, 'outcome.json');
  const outcome = fs.existsSync(outcomeFile) ? json(outcomeFile) : null;
  assert(assignment || !(outcome?.assignment || fs.existsSync(local(root, 'protocol.json')) || fs.existsSync(local(root, 'cohort.json'))), 'Benchmark assignment is absent');
  if (assignment) {
    const protocolFile = local(root, 'protocol.json'), cohortFile = local(root, 'cohort.json');
    assert(fileHash(protocolFile) === assignment.protocolSha256 && fileHash(cohortFile) === assignment.cohortSha256, 'Benchmark protocol/cohort snapshot digest mismatch');
    const protocol = json(protocolFile), cohort = json(cohortFile);
    assert(assignment.schema === 'simforge.situation-assignment/v1' && protocol.schema === 'simforge.situation-benchmark-protocol/v2' && cohort.schema === 'simforge.situation-benchmark-cohort/v2' && cohort.protocolSha256 === assignment.protocolSha256, 'Benchmark frozen assignment/protocol/cohort mismatch');
    const briefs = cohort.briefs.filter(brief => brief.id === assignment.id);
    assert(briefs.length === 1 && cohort.cohort === assignment.cohort && assignment.source === 'frozen-cohort' && assignment.replacement === false, 'Benchmark assignment is not a unique frozen cohort brief');
    exact(assignment.brief, briefs[0], 'Entire benchmark assigned brief');
    assert(assignment.brief.brief === state.options.brief && assignment.brief.mapId === state.options.map, 'Benchmark state brief/map mismatch');
    exact(assignment.budgets, protocol.budgets[assignment.mode], 'Benchmark assigned budgets');
    assert(outcome.status === state.status && outcome.assignment?.id === assignment.id && outcome.assignment?.cohort === assignment.cohort && outcome.assignment?.arm === assignment.arm && outcome.assignment?.mode === assignment.mode && outcome.assignment?.protocolSha256 === assignment.protocolSha256, 'Benchmark outcome identity mismatch');
    exact(outcome.decision, decision, 'Benchmark outcome decision');
    const author = verifySituationAuthor({ protocol, assignment, session: json(local(root, 'sessions/director/session.json')), outcome });
    assert(author.verified, `Benchmark author identity: ${author.findings.join('; ')}`);
    assert(saved.sensing && typeof assignment.sensingPolicyDigest === 'string' && saved.sensing.policyDigest === assignment.sensingPolicyDigest, 'Benchmark requires exact frozen sensing policy');
    exact(saved.sensing.policy.brief, assignment.brief, 'Sensing entire assigned brief');
  }
  if (saved.sensing) {
    assert(sensingPolicyDigest(saved.sensing.policy) === saved.sensing.policyDigest, 'Frozen sensing policy digest mismatch');
    assert(state.sensingPolicy?.digest === saved.sensing.policyDigest && state.options.sensingPolicyDigest === saved.sensing.policyDigest, 'State sensing policy digest mismatch');
    exact(json(local(root, state.sensingPolicy.file)), saved.sensing.policy, 'Retained sensing policy');
  } else assert(!assignment && !state.sensingPolicy && !state.options.sensingPolicyDigest, 'Required sensing evidence is absent');
  const frozen = buildFrozenSituationEvidence({ brief: state.options.brief, program: view.program, source: state.source,
    comparisonId: decision.comparisonId, comparison: view.readArtifact(decision.comparisonId),
    baseViews: state.rehearsals[reference.baseId].views, interventionViews: state.rehearsals[reference.interventionId].views,
    replays: Object.fromEntries(Object.entries(reference.replayIds).map(([arm,id]) => [arm,{id,run:view.readArtifact(id)}])),
    groundingEvidence: reference.groundingEvidenceIds.map(id => ({id,...view.readArtifact(id)})),
    sensingPolicy: saved.sensing?.policy ?? null });
  if (frozen.sensing) assert(frozen.sensing.base.valid && frozen.sensing.intervention.valid, 'Declared/executed sensing channels failed validation');
  assert(decision.evidenceDigest === digest(frozen), 'Decision frozen evidence digest mismatch');
  assert(reference.replayIds.base === decision.replayId && reference.replayIds.intervention === decision.controlReplayId, 'Decision differs from reviewed replay proof');
  exact(view.readArtifact(decision.reviewId), review, 'Review artifact/state');
  exact(view.readArtifact(review.evidenceId), frozen, 'Saved/reconstructed frozen evidence');
  const validation = validateEnsembleReview(review.verdict, { policy: SCENARIO_REVIEW_POLICY, evidenceDigest: decision.evidenceDigest });
  assert(validation.valid && review.verdict.decision === 'accept', `Current ensemble rejected: ${validation.errors.join('; ')}`);
  const program = bounded(view.program, state.options.brief), control = bounded(applySituationTransaction(program, frozen.declaration.transaction).program, state.options.brief);
  exact(program.source, state.source, 'Program/state source');
  exact(json(local(root, 'source.json')), state.source, 'Source artifact/state');
  // The runtime that executed the accepted traces is evidence too: the retained identity must be the one the state pinned.
  const runtime = json(local(root, 'runtime-identity.json'));
  { const { digest: recordedDigest, ...payload } = runtime; assert(runtime.schema === RUNTIME_IDENTITY_SCHEMA && digest(payload) === recordedDigest && state.runtime?.digest === recordedDigest && state.runtime.file === 'runtime-identity.json', 'Retained native runtime identity does not match the run state'); }
  assert(sha(runtime.native?.addonSha256) && typeof runtime.native.engineVersion === 'string', 'Accepted run does not pin the native execution addon');
  const declaration = frozen.declaration;
  assert(declaration.transaction.templateOps?.length === 1 && !declaration.transaction.changes && declaration.transaction.templateOps[0].type !== 'removeRole' && Array.isArray(declaration.transaction.preserve?.roles), 'Not a supported single causal intervention');
  assert(frozen.base.satisfied && frozen.base.constraints.length > 0 && !frozen.invariantFailures.length, 'Event constraints or paired invariants failed');
  const effect = frozen.eventDeltas.find(e => e.id === declaration.expectedEventId);
  const event = program.events.find(e => e.id === declaration.expectedEventId);
  assert(event && effect && (effect.baseOccurs !== effect.interventionOccurs || effect.deltaS !== null && Math.abs(effect.deltaS) > event.toleranceS), 'Named causal event did not change beyond tolerance');
  assert(program.question.hypothesis.trim() && program.question.falsifier.trim(), 'Hypothesis and falsifier are required');
  assert(program.geometryPatches.every(p => p.status === 'executable') && !program.template.props.length, 'Unsupported visual-only geometry or fixed props');
  const comparison = view.readArtifact(decision.comparisonId), ref = state.comparisons[decision.comparisonId];
  const rows = [];
  for (const [arm, expectedProgram, id, replayId, views] of [
    ['base', program, ref.baseId, decision.replayId, frozen.baseViews],
    ['intervention', control, ref.interventionId, decision.controlReplayId, frozen.interventionViews],
  ]) {
    const expected = comparison.result[arm], expectedDigest = situationDigest(expectedProgram);
    assert(expected.bound.programDigest === expectedDigest && !expected.simulation.issues.some(i => i.severity === 'error'), `${arm} execution identity/error`);
    for (const executionId of [id, replayId]) {
      const row = state.rehearsals[executionId], execution = view.readArtifact(executionId);
      assert(row && row.programDigest === expectedDigest && row.traceDigest === digest(execution.simulation.trace), `${arm} execution pin mismatch`);
      exact(json(local(root, row.programFile)), expectedProgram, `${arm} executable program`);
      exact(execution.simulation.input, expected.simulation.input, `${arm} saved replay input`);
      exact(execution.simulation.trace, expected.simulation.trace, `${arm} saved replay trace`);
      assert(execution.bound.programDigest === expectedDigest, `${arm} saved replay program mismatch`);
      rows.push(row);
    }
    exact(view.readArtifact(id), expected, `${arm} comparison/rehearsal`);
    assert(views.length <= 6 && views.some(v => v.camera.kind === 'actor-relative') && views.some(v => v.camera.kind === 'world'), `${arm} missing paired diagnostic views`);
    for (const rendered of views) {
      assert(Array.isArray(rendered.evidence.visualOnlyPatches) && !rendered.evidence.visualOnlyPatches.length && rendered.images.length, 'Unattested geometry or absent image');
      for (const image of rendered.images) assert(fileHash(local(root, image.file)) === image.sha256, 'Evidence pixels changed');
      const findings = [...(rendered.evidence.unsupportedCapabilities ?? []), ...(rendered.evidence.findings ?? [])].map(f => typeof f === 'string' ? f : canonicalJson(f));
      for (const finding of findings) assert(review.verdict.capabilityAssessments?.some(a => a.finding === finding && a.disposition === 'not-required' && a.explanation.trim()), `Unresolved render limitation: ${finding}`);
    }
  }
  const geometryRecords = state.geometryBindings?.[state.active] ?? {};
  for (const row of rows) exact(row.geometryBindings ?? {}, geometryRecords, 'Paired geometry bindings');
  const geometryBindings = [];
  for (const record of Object.values(geometryRecords)) {
    const descriptor = await loadGeometryExport(record.descriptorReference);
    exact(descriptor, record.descriptor, 'Generated geometry descriptor');
    geometryBindings.push({ ...record, descriptor });
  }
  verifySources(state.source);
  const dependencies = externalDependencies(state, frozen, rows);
  for (const pin of dependencies) assert(fileHash(fileURLToPath(pin.uri)) === pin.sha256, `External dependency changed: ${pin.uri}`);
  return { view, program, control, comparison, frozen, geometryBindings, dependencies, runtime,
    entry: { status: state.status, qualification: 'automated', decision, programDigest: situationDigest(program), controlProgramDigest: situationDigest(control),
      scenario: state.rehearsals[ref.baseId].programFile, control: state.rehearsals[ref.interventionId].programFile,
      base: { inputSha256: digest(comparison.result.base.simulation.input), traceSha256: digest(comparison.result.base.simulation.trace) },
      intervention: { inputSha256: digest(comparison.result.intervention.simulation.input), traceSha256: digest(comparison.result.intervention.simulation.trace) },
      comparisonSha256: digest(comparison.result), runtime: { digest: runtime.digest, native: runtime.native }, dependencies } };
}

export async function exportCorpus({ runs, out }) {
  assert(Array.isArray(runs) && runs.length, 'At least one --run is required');
  out = path.resolve(out);
  assert(!fs.existsSync(out), 'Corpus output must be a NEW directory');
  const roots = runs.map(run => fs.realpathSync(run));
  assert(new Set(roots).size === roots.length, 'Duplicate source run');
  for (const root of roots) assert(out !== root && !out.startsWith(`${root}${path.sep}`), 'Corpus cannot be inside a source run');
  const manifest = { schema: SCHEMA, policyDigest: policyDigest(SCENARIO_REVIEW_POLICY), qualification: QUALIFICATION,
    dependencyPolicy: 'Evidence files are copied unchanged. External immutable sources and generated assets are references, not copied; accepted verification requires every pinned path readable. Replay also requires the native runtime addon with the public packages installed and the pinned map under SCEN_DEV_ASSETS/default DEV_ASSETS. Keep manifestSha256 independently: hashes are integrity, not signed provenance.',
    entries: [], failures: [] };
  // Validate before creating output; no failed acceptance is silently downgraded.
  const prepared = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i], state = json(local(root, 'state.json'));
    assert(state.version === 1 && state.options && typeof state.status === 'string', 'Not a situation run state');
    const accepted = state.status === 'ensemble_accepted' ? await inspectAcceptedRun(root) : null;
    prepared.push({ root, files: inventory(root), accepted, state, id: `entry-${String(i + 1).padStart(4, '0')}` });
  }
  fs.mkdirSync(out, { mode: 0o700 });
  for (const item of prepared) {
    const directory = `${item.accepted ? 'entries' : 'failures'}/${item.id}`;
    for (const pin of item.files) {
      const target = local(out, `${directory}/${pin.file}`);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(local(item.root, pin.file), target, fs.constants.COPYFILE_EXCL);
      assert(fileHash(target) === pin.sha256, 'Source run changed during export');
    }
    exact(json(local(out, `${directory}/state.json`)), item.state, 'Source state changed during export');
    if (item.accepted) exact((await inspectAcceptedRun(local(out, directory))).entry, item.accepted.entry, 'Copied acceptance closure');
    const record = { id: item.id, directory, sourceRun: pathToFileURL(item.root).href, files: item.files };
    if (item.accepted) manifest.entries.push({ ...record, ...item.accepted.entry });
    else manifest.failures.push({ ...record, status: item.state.status, qualification: 'not-accepted', decision: item.state.decision ?? null });
  }
  const bytes = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(local(out, 'corpus.json'), bytes, { flag: 'wx', mode: 0o600 });
  return { corpus: out, manifestSha256: hash(bytes), accepted: manifest.entries.length, failures: manifest.failures.length, qualification: QUALIFICATION };
}

export async function verifyCorpus({ corpus, sha256 }) {
  corpus = fs.realpathSync(corpus);
  assert(sha(sha256), 'An independently retained export manifest --sha256 is required');
  assert(fileHash(local(corpus, 'corpus.json')) === sha256, 'Corpus manifest hash mismatch');
  const manifest = json(local(corpus, 'corpus.json'));
  assert(manifest.schema === SCHEMA && manifest.policyDigest === policyDigest(SCENARIO_REVIEW_POLICY), 'Unsupported corpus schema or non-current ensemble policy');
  assert(Array.isArray(manifest.entries) && Array.isArray(manifest.failures), 'Invalid corpus records');
  const ids = new Set(), directories = new Set();
  for (const [kind, records] of [['entries', manifest.entries], ['failures', manifest.failures]]) for (const record of records) {
    assert(/^entry-\d{4,}$/.test(record.id) && !ids.has(record.id) && record.directory === `${kind}/${record.id}` && !directories.has(record.directory), 'Duplicate/invalid corpus entry');
    ids.add(record.id); directories.add(record.directory);
    const root = local(corpus, record.directory);
    exact(inventory(root), record.files, 'Evidence file inventory');
    const state = json(local(root, 'state.json'));
    if (kind === 'failures') {
      assert(state.status !== 'ensemble_accepted' && record.qualification === 'not-accepted' && record.status === state.status, 'Failure cannot be relabeled accepted');
      exact(record.decision, state.decision ?? null, 'Failure decision');
    } else {
      const inspected = await inspectAcceptedRun(root);
      for (const [key, value] of Object.entries(inspected.entry)) exact(record[key], value, `Accepted ${key}`);
    }
  }
  return { corpus, manifest, manifestSha256: sha256, accepted: manifest.entries.length, failures: manifest.failures.length,
    qualification: QUALIFICATION, verification: 'Retained bytes, current ensemble, mechanical evidence and external pins verified; fresh execution is the replay command.' };
}

export async function replayCorpus({ corpus, sha256, entry }) {
  const verified = await verifyCorpus({ corpus, sha256 });
  const records = entry ? verified.manifest.entries.filter(row => row.id === entry) : verified.manifest.entries;
  assert(records.length > 0, 'No accepted entries selected; failures are never replay-qualified');
  // Replay is a fresh native execution; its runtime is recorded so an exact trace match names both runtimes.
  const runtime = authoringRuntimeIdentity();
  const results = [];
  for (const record of records) {
    const checked = await inspectAcceptedRun(local(verified.corpus, record.directory));
    const mapId = checked.view.state.options.map;
    const recorded = checked.runtime;
    // loadMap resolves from DEV_ASSETS; prove those exact map bytes are pinned,
    // rather than assuming a matching map name means a matching map bundle.
    for (const name of ['map.xodr', 'topology-index.json.gz', 'derived/topology-derived.json.gz', 'derived/locations.json.gz', 'signals.geojson.gz']) {
      const file = path.join(DEV_ASSETS, mapId, name);
      const source = checked.view.state.source.artifacts.find(pin => pin.id === name);
      assert(source && fileHash(file) === source.sha256, `Canonical map resolver is not pinned: ${file}`);
    }
    const bundle = await loadMap(mapId);
    const actual = compareSituation(checked.program, checked.comparison.declaration.transaction, bundle, {
      seed: checked.view.state.options.seed, geometryBindings: checked.geometryBindings,
      reactiveRoleIds: checked.comparison.declaration.reactiveRoleIds,
    });
    const arms = {};
    for (const arm of ['base', 'intervention']) {
      exact(actual[arm].simulation.input, checked.comparison.result[arm].simulation.input, `${record.id} ${arm} fresh engine input`);
      exact(actual[arm].simulation.trace, checked.comparison.result[arm].simulation.trace, `${record.id} ${arm} fresh engine trace`);
      if (checked.frozen.sensing) {
        const sensing = validateSensingExecution(arm === 'base' ? checked.program : checked.control, checked.frozen.sensing.policy, actual[arm].simulation, arm === 'base' ? 'base' : 'control');
        assert(sensing.valid, `${record.id} ${arm} fresh sensing execution invalid`);
        exact(sensing, checked.frozen.sensing[arm], `${record.id} ${arm} fresh sensing execution`);
      }
      arms[arm] = { inputSha256: digest(actual[arm].simulation.input), traceSha256: digest(actual[arm].simulation.trace), exact: true };
    }
    exact(actual, checked.comparison.result, `${record.id} fresh canonical comparison`);
    results.push({ id: record.id, qualification: 'automated', ...arms, comparisonSha256: digest(actual), exact: true,
      runtime: { recordedDigest: recorded.digest, recordedNative: recorded.native, replayDigest: runtime.digest, replayNative: runtime.native, sameRuntime: recorded.digest === runtime.digest } });
  }
  return { corpus: verified.corpus, manifestSha256: sha256, qualification: QUALIFICATION, runtimeDigest: runtime.digest, results };
}

const HELP = { commands: {
  export: '--out NEW_DIRECTORY --run RUN_DIRECTORY [--run RUN_DIRECTORY ...]',
  verify: '--corpus DIRECTORY --sha256 INDEPENDENTLY_RETAINED_MANIFEST_SHA256',
  replay: '--corpus DIRECTORY --sha256 INDEPENDENTLY_RETAINED_MANIFEST_SHA256 [--entry entry-0001]',
}, qualification: QUALIFICATION, notes: ['No authoring, gateway, renderer, services or approval creation.', 'Export stdout supplies manifestSha256; retain it outside the corpus.', 'Failed/running/historical statuses remain not-accepted records, never accepted entries.', 'Verification requires external pinned files; replay requires the native runtime addon, installed public packages and matching map resolution.'] };
async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') return HELP;
  const [command, ...flags] = argv;
  assert(['export', 'verify', 'replay'].includes(command), 'Expected export, verify or replay; use --help');
  const options = { runs: [] }, allowed = command === 'export' ? ['--run', '--out'] : ['--corpus', '--sha256', ...(command === 'replay' ? ['--entry'] : [])];
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i], value = flags[i + 1];
    assert(allowed.includes(flag) && typeof value === 'string' && value.length && !value.startsWith('--'), `Unknown or incomplete flag: ${flag}`);
    if (flag === '--run') options.runs.push(value);
    else { const key = flag.slice(2); assert(options[key] === undefined, `Duplicate flag: ${flag}`); options[key] = value; }
  }
  assert(command === 'export' ? options.out && options.runs.length : options.corpus && options.sha256, 'Missing required flags');
  if (command === 'export') return exportCorpus(options);
  if (command === 'replay') return replayCorpus(options);
  const { manifest, ...result } = await verifyCorpus(options);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(JSON.stringify({ code: 'situation_corpus_invalid', reason: error.message })); process.exitCode = 2; }
}
