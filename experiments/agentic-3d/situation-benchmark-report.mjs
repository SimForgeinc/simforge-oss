#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCENARIO_REVIEW_POLICY, policyDigest, validateEnsembleReview } from './situation-ensemble.mjs';
import { applySituationTransaction, situationDigest } from '@simforge-oss/scenario';
import { sensingPolicyDigest, validateSensingExecution } from './situation-sensing-policy.mjs';
import { GATEWAY_TIMEOUT_MS } from './gateway.mjs';
import { RUNTIME_IDENTITY_SCHEMA } from './runtime-identity.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const same = (a, b) => canonical(a) === canonical(b);
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const key = a => JSON.stringify([a?.cohort, a?.briefId, a?.arm, a?.mode]);
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const median = values => { const a = values.filter(v => number(v) !== null).sort((a, b) => a - b); return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : null; };
function observed(values) {
  const known = values.filter(v => number(v) !== null);
  return { observedTotal: known.length ? known.reduce((a, b) => a + b, 0) : null,
    total: known.length === values.length && values.length ? known.reduce((a, b) => a + b, 0) : null,
    known: known.length, unknown: values.length - known.length };
}
function distribution(values) {
  const known = values.filter(v => number(v) !== null).sort((a, b) => a - b);
  return { values, known: known.length, unknown: values.length - known.length, median: median(known),
    min: known[0] ?? null, max: known.at(-1) ?? null, p90: known.length ? known[Math.ceil(known.length * .9) - 1] : null };
}
function optional(file, findings, label) {
  try { const value = json(file); requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected JSON object'); return value; }
  catch (error) { findings.push(`${label}: ${error.code === 'ENOENT' ? 'missing' : 'malformed: ' + error.message}`); return null; }
}
function time(value) { const n = typeof value === 'number' ? value : Date.parse(value); return number(n); }
function delta(end, start) { const a = time(end), b = time(start); return a !== null && b !== null ? number(a - b) : null; }
function summary(rows) {
  const accepted = rows.filter(r => r.ensembleAccepted), wall = observed(rows.map(r => r.wallMs)), queue = observed(rows.map(r => r.queueMs));
  const cost = observed(rows.map(r => r.cost.total));
  cost.observedTotal = observed(rows.map(r => r.cost.reportedTotal)).observedTotal;
  return { assigned: rows.length, ensembleAccepted: accepted.length, failures: rows.length - accepted.length,
    ensembleAcceptanceRate: rows.length ? accepted.length / rows.length : null,
    firstSubmissionSuccess: rows.filter(r => r.firstSubmissionSuccess === true).length,
    firstSubmissionUnknown: rows.filter(r => r.firstSubmissionSuccess === null).length,
    firstSubmissionSuccessRate: rows.length ? rows.filter(r => r.firstSubmissionSuccess === true).length / rows.length : null,
    statusCounts: rows.reduce((o, r) => { o[r.status] = (o[r.status] ?? 0) + 1; return o; }, {}),
    medianAcceptedIterations: median(accepted.map(r => r.iterations)), acceptedIterationUnknown: accepted.filter(r => r.iterations === null).length,
    cappedAllAssignedIterations: distribution(rows.map(r => r.cappedIterations)),
    iterationPolicy: 'Failures receive the frozen rehearsal-attempt cap; accepted runs use min(observed iterations, cap). Unknown accepted iterations remain null.',
    metrics: Object.fromEntries(['calls', 'tools', 'requestedTools', 'semanticEdits', 'failedTools', 'submissions'].map(k => [k, observed(rows.map(r => r[k]))])),
    tokens: Object.fromEntries([...new Set(rows.flatMap(r => Object.keys(r.tokens)))].sort().map(k => [k, observed(rows.map(r => number(r.tokens[k])))])),
    wallMs: wall, queueMs: queue, allAssignedWallMsPerAcceptedBundle: accepted.length && wall.total !== null ? wall.total / accepted.length : null,
    observedWallMsPerAcceptedBundle: accepted.length && wall.observedTotal !== null ? wall.observedTotal / accepted.length : null,
    allAssignedQueueMsPerAcceptedBundle: accepted.length && queue.total !== null ? queue.total / accepted.length : null,
    costUSD: cost, stageElapsedMs: Object.fromEntries([...new Set(rows.flatMap(r => Object.keys(r.stages)))].sort().map(k => [k, observed(rows.map(r => number(r.stages[k])))])) };
}
function bootstrap(differences, seedText) {
  if (!differences.length) return null;
  let state = parseInt(sha(seedText).slice(0, 8), 16) || 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const estimates = [];
  for (let i = 0; i < 10000; i++) { let sum = 0; for (let j = 0; j < differences.length; j++) sum += differences[Math.floor(random() * differences.length)]; estimates.push(sum / differences.length); }
  estimates.sort((a, b) => a - b);
  return { estimate: differences.reduce((a, b) => a + b, 0) / differences.length, lower: estimates[249], upper: estimates[9749], confidence: .95, replicates: 10000, seed: sha(seedText), method: 'Deterministic xorshift32 percentile paired brief bootstrap; descriptive only, not an efficacy claim.', pairs: differences.length };
}

/** Verifies retained gateway receipts, not upstream model execution or effective effort. */
export function verifySituationAuthor({ protocol, assignment, session, outcome }) {
  const findings = [], model = protocol?.operatingModel, effort = protocol?.effort, requestTimeoutMs = protocol?.requestTimeoutMs;
  const routes = {
    'anthropic/claude-opus-5': ['anthropic', 'anthropic-messages'],
    'anthropic/claude-fable-5-1': ['anthropic', 'anthropic-messages'],
    'openai-codex/gpt-5.6-sol': ['openai-codex', 'openai-codex-responses'],
    'openai-codex/gpt-6-astra': ['openai-codex', 'openai-codex-responses'],
  };
  const route = Object.hasOwn(routes, model) ? routes[model] : null;
  const check = (ok, message) => { if (!ok) findings.push(message); };
  check(route !== null, 'Frozen author model is missing or not an exact supported provider route');
  check(['low', 'high'].includes(effort), 'Frozen author effort is missing or unsupported');
  check(typeof assignment?.authorModel === 'string' && assignment.authorModel === model, 'Assignment author model is missing or differs from frozen protocol');
  check(typeof assignment?.authorEffort === 'string' && assignment.authorEffort === effort, 'Assignment author effort is missing or differs from frozen protocol');
  check(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs === GATEWAY_TIMEOUT_MS[effort], 'Frozen author request timeout is missing or differs from gateway deadline');
  check(assignment?.authorRequestTimeoutMs === requestTimeoutMs, 'Assignment author request timeout differs from frozen protocol');
  const identity = session?.identity, catalog = identity?.catalog;
  check(session?.version === 2, 'Saved director session is missing or has unsupported version');
  check(typeof identity?.requestedModel === 'string' && identity.requestedModel === model, 'Director identity requested model is missing or mismatched');
  check(typeof identity?.requestedEffort === 'string' && identity.requestedEffort === effort, 'Director identity requested effort is missing or mismatched');
  check(identity?.requestTimeoutMs === requestTimeoutMs, 'Director identity request timeout is missing or mismatched');
  check(route && catalog?.id === model && catalog?.owned_by === route[0] && catalog?.api === route[1], 'Director catalog ownership/API does not match exact author route');
  check(identity?.routingVerified === true && identity?.requestEffortVerified === true, 'Director routing/request-effort verification is absent');
  const requests = Array.isArray(session?.usage?.requests) ? session.usage.requests : [];
  const count = outcome?.metrics?.models?.director?.requests;
  check(requests.length > 0, 'No real director request receipts');
  check(Number.isSafeInteger(count) && count > 0 && count === requests.length, 'Director receipt count differs from outcome.metrics.models.director.requests or is missing');
  const receipts = requests.map((request, index) => {
    const r = request ?? {};
    check(typeof r.requestedModel === 'string' && r.requestedModel === model && r.wireModel === model, `Director request ${index + 1} requested/wire model mismatch or missing`);
    check(typeof r.requestedEffort === 'string' && r.requestedEffort === effort && r.wireEffort === effort, `Director request ${index + 1} requested/wire effort mismatch or missing`);
    check(r.requestTimeoutMs === requestTimeoutMs, `Director request ${index + 1} request timeout mismatch or missing`);
    check(Number.isInteger(r.status) && r.status >= 200 && r.status < 300, `Director request ${index + 1} lacks successful HTTP receipt`);
    check(route && (r.returnedModel === model || r.returnedModel === model.slice(model.indexOf('/') + 1)), `Director request ${index + 1} returned routing model mismatch or missing`);
    return { requestedModel: r.requestedModel ?? null, requestedEffort: r.requestedEffort ?? null,
      wireModel: r.wireModel ?? null, wireEffort: r.wireEffort ?? null, returnedModel: r.returnedModel ?? null, status: r.status ?? null, requestTimeoutMs: r.requestTimeoutMs ?? null };
  });
  const verified = findings.length === 0;
  return { verified, pairingKey: verified ? JSON.stringify([model, effort, requestTimeoutMs]) : null,
    declared: { protocolModel: model ?? null, protocolEffort: effort ?? null, protocolRequestTimeoutMs: requestTimeoutMs ?? null, assignmentModel: assignment?.authorModel ?? null, assignmentEffort: assignment?.authorEffort ?? null, assignmentRequestTimeoutMs: assignment?.authorRequestTimeoutMs ?? null },
    observed: { requestedModel: identity?.requestedModel ?? null, requestedEffort: identity?.requestedEffort ?? null, requestTimeoutMs: identity?.requestTimeoutMs ?? null,
      catalog: catalog ? { id: catalog.id ?? null, owned_by: catalog.owned_by ?? null, api: catalog.api ?? null } : null,
      requestCount: requests.length, outcomeRequestCount: number(count), receiptKinds: [...new Map(receipts.map(r => [canonical(r), r])).values()] },
    upstreamExecutionVerified: false, effectiveEffortVerified: false,
    limitation: 'Saved catalog and response routing IDs verify gateway routing; wire effort verifies only the requested effort. No upstream execution or effective reasoning-effort attestation.',
    findings };
}

/** Reads authoritative outcomes only. Invalid assigned rows stay in the denominator. */
export function reportSituationBenchmark({ manifest: manifestFile, out }) {
  manifestFile = path.resolve(manifestFile);
  const manifest = json(manifestFile), directory = path.dirname(manifestFile), findings = [];
  requireValue(manifest.schema === 'simforge.situation-benchmark-run/v1' && Array.isArray(manifest.assignments), 'Invalid frozen run manifest');
  requireValue(path.isAbsolute(manifest.protocolFile) && path.isAbsolute(manifest.cohortFile), 'Protocol and cohort paths must be absolute');
  const protocolBytes = fs.readFileSync(manifest.protocolFile), cohortBytes = fs.readFileSync(manifest.cohortFile);
  const protocol = JSON.parse(protocolBytes), cohort = JSON.parse(cohortBytes);
  requireValue(['simforge.situation-benchmark-protocol/v1', 'simforge.situation-benchmark-protocol/v2'].includes(protocol.schema) && ['simforge.situation-benchmark-cohort/v1', 'simforge.situation-benchmark-cohort/v2'].includes(cohort.schema), 'Unsupported protocol/cohort schema');
  if (sha(protocolBytes) !== manifest.protocolSha256) findings.push('Manifest protocol SHA mismatch');
  if (sha(cohortBytes) !== manifest.cohortSha256) findings.push('Manifest cohort SHA mismatch');
  if (cohort.protocolSha256 !== sha(protocolBytes)) findings.push('Cohort protocol SHA mismatch');
  const arms = ['C', 'D'], modes = Object.keys(protocol.budgets), dimensions = protocol.diversity.dimensions;
  requireValue(Array.isArray(cohort.briefs), 'Frozen cohort has no brief records');
  const identities = new Map();
  for (const a of manifest.assignments) identities.set(key(a), (identities.get(key(a)) ?? 0) + 1);
  const executionFindings = [], executionPath = path.join(directory, 'execution.json');
  const execution = fs.existsSync(executionPath) ? optional(executionPath, executionFindings, 'execution') : null;
  if (!execution) executionFindings.push('No scheduler queue/resource observations; timings are unknown unless observed in outcome');
  const rows = manifest.assignments.map((input, index) => {
    const a = input && typeof input === 'object' ? input : {}, issues = [...findings];
    const records = cohort.briefs.filter(b => b.id === a.briefId), brief = records.length === 1 ? records[0] : null;
    if (!brief || a.cohort !== cohort.cohort || a.brief !== brief.brief) issues.push('Assignment does not match unique frozen cohort brief');
    if (!arms.includes(a.arm) || !modes.includes(a.mode)) issues.push('Unsupported arm or mode');
    if (!manifest.scope?.arms?.includes(a.arm) || !manifest.scope?.modes?.includes(a.mode) || !manifest.scope?.briefIds?.includes(a.briefId)) issues.push('Assignment is outside frozen selected scope');
    if (identities.get(key(a)) !== 1) issues.push('Duplicate assigned identity');
    const validPath = typeof a.runDir === 'string' && a.runDir.length > 0 && !path.isAbsolute(a.runDir);
    if (!validPath) issues.push('runDir must be a nonempty relative path');
    const runDir = validPath ? path.resolve(directory, a.runDir) : null;
    const assignment = runDir ? optional(path.join(runDir, 'assignment.json'), issues, 'assignment.json') : null;
    const outcome = runDir ? optional(path.join(runDir, 'outcome.json'), issues, 'outcome.json') : null;
    if (assignment) {
      if (assignment.schema !== 'simforge.situation-assignment/v1' || assignment.id !== a.briefId || assignment.cohort !== a.cohort || assignment.arm !== a.arm || assignment.mode !== a.mode || !same(assignment.brief, brief) || assignment.protocolSha256 !== manifest.protocolSha256 || assignment.cohortSha256 !== manifest.cohortSha256 || !same(assignment.budgets, protocol.budgets[a.mode]) || assignment.replacement !== false || assignment.source !== 'frozen-cohort') issues.push('assignment.json identity/frozen contract mismatch');
    }
    if (outcome) {
      const identity = outcome.assignment;
      if (!identity || identity.id !== a.briefId || identity.cohort !== a.cohort || identity.arm !== a.arm || identity.mode !== a.mode || identity.protocolSha256 !== manifest.protocolSha256) issues.push('outcome.json identity mismatch');
      if (!['ensemble_accepted', 'rejected', 'impossible', 'unsupported', 'infrastructure', 'budget'].includes(outcome.status)) issues.push('Historical or unsupported outcome status; not ensemble acceptance');
    }
    const authorReadFindings = [];
    const directorSession = runDir ? optional(path.join(runDir, 'sessions', 'director', 'session.json'), authorReadFindings, 'director session') : null;
    const authorIdentity = verifySituationAuthor({ protocol, assignment, session: directorSession, outcome });
    authorIdentity.findings.unshift(...authorReadFindings);
    authorIdentity.verified = authorIdentity.findings.length === 0;
    if (!authorIdentity.verified) authorIdentity.pairingKey = null;
    issues.push(...authorIdentity.findings.map(finding => 'Author identity: ' + finding));
    const metadataFindings = [], runtime = runDir ? optional(path.join(runDir, 'runtime-identity.json'), metadataFindings, 'runtime-identity.json') : null;
    const source = runDir ? optional(path.join(runDir, 'source.json'), metadataFindings, 'source.json') : null;
    if (runtime && (!runtime.digest || runtime.digest !== outcome?.assignment?.runtimeDigest)) issues.push('Runtime digest/outcome mismatch');
    if (runtime) { const { digest, ...payload } = runtime; if (sha(canonical(payload)) !== digest) issues.push('Runtime metadata digest mismatch'); }
    if (runtime && (runtime.schema !== RUNTIME_IDENTITY_SCHEMA || !sha256(runtime.native?.addonSha256))) issues.push('Runtime identity does not pin the native execution addon');
    let reviewEvidence = null;
    if (outcome?.status !== 'ensemble_accepted' && outcome?.evaluation?.reviewId) {
      try {
        const id = outcome.evaluation.reviewId;
        requireValue(/^review-\d+$/.test(id), 'Invalid retained review ID');
        const review = json(path.join(runDir,'artifacts',id+'.json'));
        requireValue(/^evidence-\d+$/.test(review.evidenceId), 'Invalid retained evidence ID');
        const frozen = json(path.join(runDir,'artifacts',review.evidenceId+'.json'));
        requireValue(sha(canonical(frozen)) === review.evidenceDigest && review.evidenceDigest === outcome.evaluation.evidenceDigest, 'Retained review evidence digest mismatch');
        reviewEvidence = {review,frozen,validation:validateEnsembleReview(review.verdict,{policy:SCENARIO_REVIEW_POLICY,evidenceDigest:review.evidenceDigest})};
      } catch(error) { metadataFindings.push('Retained nonaccepted review: '+error.message); }
    }
    if (outcome?.status === 'ensemble_accepted') {
      try {
        const evaluation = outcome.evaluation, decision = outcome.decision;
        requireValue(protocol.schema === 'simforge.situation-benchmark-protocol/v2' && cohort.schema === 'simforge.situation-benchmark-cohort/v2', 'Ensemble acceptance requires frozen v2 protocol/cohort');
        requireValue(protocol.evaluation?.scenario?.policyDigest === policyDigest(SCENARIO_REVIEW_POLICY), 'Frozen scenario review policy mismatch');
        requireValue(evaluation?.kind === 'llm-ensemble' && evaluation.policyDigest === policyDigest(SCENARIO_REVIEW_POLICY) && evaluation.decision === 'accept', 'Outcome ensemble evaluation missing or mismatched');
        const artifact = id => {
          requireValue(typeof id === 'string' && /^[a-z]+-\d+$/.test(id), 'Invalid acceptance artifact ID');
          return json(path.join(runDir,'artifacts',id+'.json'));
        };
        const review = artifact(evaluation.reviewId), frozen = artifact(review.evidenceId);
        requireValue(review.evidenceDigest === evaluation.evidenceDigest && sha(canonical(frozen)) === evaluation.evidenceDigest, 'Frozen evidence digest mismatch');
        requireValue(review.policyDigest === evaluation.policyDigest && review.comparisonId === frozen.comparisonId, 'Review policy/comparison binding mismatch');
        const validation = validateEnsembleReview(review.verdict,{policy:SCENARIO_REVIEW_POLICY,evidenceDigest:evaluation.evidenceDigest});
        requireValue(validation.valid, 'Invalid ensemble aggregate: '+validation.errors.join('; '));
        requireValue(review.verdict.decision === 'accept' && same(evaluation.members,review.verdict.members), 'Outcome member records differ from accepting aggregate');
        requireValue(decision?.reviewId === evaluation.reviewId && decision.evidenceDigest === evaluation.evidenceDigest && decision.comparisonId === frozen.comparisonId, 'Acceptance decision does not bind reviewed evidence');
        requireValue(runtime?.schema === RUNTIME_IDENTITY_SCHEMA && runtime.local?.some(file => file.path === 'experiments/agentic-3d/situation-ensemble.mjs') && source, 'Accepted run lacks native runtime identity, ensemble fingerprint or source metadata');
        requireValue(frozen.source?.mapId === brief.mapId && frozen.program?.question?.brief === brief.brief, 'Frozen review does not describe the assigned brief/map');
        requireValue(frozen.base?.satisfied === true && frozen.base.constraints?.length > 0 && Array.isArray(frozen.invariantFailures) && frozen.invariantFailures.length === 0, 'Frozen event/invariant gates failed');
        const effect = frozen.eventDeltas?.find(event => event.id === frozen.declaration?.expectedEventId);
        const event = frozen.program?.events?.find(event => event.id === frozen.declaration?.expectedEventId);
        requireValue(effect && event && (effect.baseOccurs !== effect.interventionOccurs || (number(Math.abs(effect.deltaS)) !== null && effect.deltaS !== null && Math.abs(effect.deltaS) > event.toleranceS)), 'Frozen declared causal effect absent');
        const comparison = artifact(decision.comparisonId);
        requireValue(same(frozen.declaration, comparison.declaration), 'Frozen control declaration differs from executed comparison');
        const sensing = frozen.sensing;
        requireValue(sensing && typeof assignment?.sensingPolicyDigest === 'string', 'Benchmark acceptance requires frozen sensing policy');
        requireValue(same(sensing.policy?.brief, assignment.brief) && same(assignment.brief, brief), 'Frozen sensing policy does not bind the entire assigned brief');
        requireValue(sensingPolicyDigest(sensing.policy) === sensing.policyDigest && sensing.policyDigest === assignment.sensingPolicyDigest, 'Frozen sensing policy digest differs from assignment');
        requireValue(same(json(path.join(runDir, 'sensing-policy.json')), sensing.policy), 'Retained sensing policy differs from judged policy');
        const baseProgram = { ...frozen.program, source };
        requireValue(frozen.programDigest === situationDigest(baseProgram), 'Frozen executable program digest mismatch');
        const control = applySituationTransaction(baseProgram, comparison.declaration.transaction).program;
        for (const [name, program, variant] of [['base', baseProgram, 'base'], ['intervention', control, 'control']]) {
          requireValue(comparison.result?.[name]?.bound?.programDigest === situationDigest(program), 'Frozen '+name+' executable program mismatch');
          const derived = validateSensingExecution(program, sensing.policy, comparison.result[name].simulation, variant);
          requireValue(derived.valid && same(sensing[name], derived), 'Frozen '+name+' sensing differs from valid declared/executed channels: '+canonical(derived.issues));
        }
        requireValue(same(Object.keys(sensing).sort(), ['base', 'intervention', 'policy', 'policyDigest']), 'Frozen sensing packet contains unsupported fields');
        requireValue(Array.isArray(frozen.groundingEvidence) && frozen.groundingEvidence.length <= 12, 'Grounding evidence packet absent');
        for (const {id,...record} of frozen.groundingEvidence) {
          requireValue(/^tool-\d+$/.test(id) && ['query','inspect','measure'].includes(record.name), 'Invalid grounding evidence attachment');
          requireValue(same(artifact(id),record), 'Grounding evidence differs from saved tool output');
        }
        for (const [name,replayId,views] of [['base',decision.replayId,frozen.baseViews],['intervention',decision.controlReplayId,frozen.interventionViews]]) {
          const replay = artifact(replayId), original = comparison.result?.[name];
          requireValue(replay.simulation && original?.simulation && same(replay.simulation.input,original.simulation.input) && same(replay.simulation.trace,original.simulation.trace), 'Exact '+name+' replay mismatch');
          const proof = frozen.replayProof?.[name];
          requireValue(proof?.replayId === replayId && proof.exactInput === true && proof.exactTrace === true &&
            proof.programDigest === replay.bound?.programDigest &&
            proof.inputDigest === sha(canonical(replay.simulation.input)) && proof.traceDigest === sha(canonical(replay.simulation.trace)),
          'Exact '+name+' replay proof was not included in judged evidence');
          requireValue(frozen[name]?.inputHash === original.simulation.trace?.header?.inputHash && frozen[name]?.programDigest === original.bound?.programDigest && !original.simulation.issues?.some(issue => issue.severity === 'error'), 'Frozen '+name+' execution binding mismatch');
          requireValue(Array.isArray(views) && views.length <= 6 && views.some(view => view.camera?.kind === 'actor-relative') && views.some(view => view.camera?.kind === 'world'), 'Missing participant/diagnostic evidence views');
          for (const view of views) {
            requireValue(Array.isArray(view.evidence?.visualOnlyPatches) && view.evidence.visualOnlyPatches.length === 0, 'Unverified visual-only evidence');
            requireValue(Array.isArray(view.images) && view.images.length > 0 && Array.isArray(view.bindings), 'Frozen image/asset evidence absent');
            for (const image of view.images ?? []) requireValue(sha(fs.readFileSync(path.resolve(runDir,image.file))) === image.sha256, 'Frozen evidence pixels changed');
            for (const binding of view.bindings ?? []) requireValue(sha(fs.readFileSync(binding.path)) === binding.sha256, 'Frozen asset binding changed');
            for (const finding of [...(view.evidence.unsupportedCapabilities ?? []),...(view.evidence.findings ?? [])].map(value => typeof value === 'string' ? value : canonical(value)))
              requireValue(review.verdict.capabilityAssessments?.some(assessment => assessment.finding === finding && assessment.disposition === 'not-required'), 'Unresolved render capability finding');
          }
        }
        requireValue(Array.isArray(frozen.source.artifacts) && frozen.source.artifacts.length > 0 && frozen.source.artifacts.every(item => source.artifacts?.some(original => same(item,original))), 'Frozen source metadata is absent or differs from source snapshot');
        for (const item of frozen.source.artifacts ?? []) requireValue(sha(fs.readFileSync(fileURLToPath(item.uri))) === item.sha256, 'Pinned source changed: '+item.id);
        reviewEvidence = {review, frozen};
      } catch(error) { issues.push('Ensemble acceptance evidence: '+error.message); }
    }
    const accepted = issues.length === 0 && outcome?.status === 'ensemble_accepted';
    const counters = outcome?.counters ?? {}, metrics = outcome?.metrics ?? {};
    const e = execution?.assignments?.[key(a)] ?? {};
    const wallMs = number(e.wallMs) ?? delta(e.endedAt, e.startedAt) ?? number(outcome?.assignedWallMs) ?? number(metrics.elapsedMs);
    const queueMs = number(e.queueMs) ?? delta(e.startedAt, e.queuedAt);
    const stages = {};
    for (const stage of Array.isArray(metrics.stages) ? metrics.stages : []) if (typeof stage.stage === 'string' && number(stage.elapsedMs) !== null) stages[stage.stage] = (stages[stage.stage] ?? 0) + stage.elapsedMs;
    const iterations = number(outcome?.iterations), cap = number(protocol.budgets[a.mode]?.rehearsalAttempts);
    return { index, identity: key(a), cohort: a.cohort ?? null, briefId: a.briefId ?? null, arm: a.arm ?? null, mode: a.mode ?? null,
      brief: brief ?? null, runDir, heldout: brief?.heldout ?? null, validIdentity: issues.length === 0,
      status: !outcome ? (issues.some(s => s.startsWith('outcome.json: malformed')) ? 'malformed' : 'missing') : issues.length ? 'invalid' : outcome.status,
      reportedStatus: outcome?.status ?? null, ensembleAccepted: accepted, evaluation: outcome?.evaluation ?? null, reviewEvidence,
      authorIdentity,
      firstSubmissionSuccess: issues.length ? null : typeof outcome?.firstSubmissionAccepted === 'boolean' ? outcome.firstSubmissionAccepted && accepted : null,
      findings: issues, metadataFindings, iterations, cappedIterations: !accepted ? cap : iterations !== null && cap !== null ? Math.min(iterations, cap) : null,
      calls: number(counters.calls), tools: number(counters.tools), requestedTools: number(metrics.requestedTools), semanticEdits: number(counters.semanticEdits),
      failedTools: number(counters.failedTools), submissions: Array.isArray(outcome?.submissions) ? outcome.submissions.length : null,
      tokens: metrics.tokens && typeof metrics.tokens === 'object' ? metrics.tokens : {}, cost: { total: number(metrics.cost?.total), reportedTotal: number(metrics.cost?.reportedTotal), reportedRequests: number(metrics.cost?.reportedRequests), unavailableRequests: number(metrics.cost?.unavailableRequests) },
      wallMs, queueMs, stages, metricDefinitions: outcome?.metricDefinitions ?? null,
      metadata: { seed: assignment?.seed ?? null, runtimeDigest: runtime?.digest ?? null, sourceDigest: source ? sha(canonical(source)) : null,
        authorPairingKey: authorIdentity.pairingKey,
        render: outcome?.attestations?.render ?? null, sensor: outcome?.attestations?.sensor ?? null, reviewer: outcome?.attestations?.reviewer ?? null } };
  });
  const groups = [];
  for (const c of protocol.cohorts) for (const mode of modes) for (const arm of arms) {
    const selected = rows.filter(r => r.cohort === c.id && r.arm === arm && r.mode === mode);
    const valid = selected.filter(r => r.validIdentity);
    groups.push({ cohort: c.id, arm, mode, expected: c.count, assigned: selected.length, validUniqueAssigned: new Set(valid.map(r => r.briefId)).size,
      authoritativeOutcomes: valid.length, missingAssignments: Math.max(0, c.count - new Set(selected.filter(r => r.brief).map(r => r.briefId)).size),
      summary: summary(selected), heldout: summary(selected.filter(r => r.heldout === true)), nonHeldout: summary(selected.filter(r => r.heldout === false)),
      axes: Object.fromEntries(dimensions.map(d => [d, [...new Set(selected.map(r => canonical(r.brief?.[d] ?? null)))].sort().map(value => ({ value: JSON.parse(value), ...summary(selected.filter(r => canonical(r.brief?.[d] ?? null) === value)) }))])) });
  }
  const pairs = [], intervals = [];
  for (const mode of modes) for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
    const armA = arms[i], armB = arms[j];
    for (const brief of cohort.briefs) {
      const sides = [armA, armB].map(arm => rows.filter(r => r.cohort === cohort.cohort && r.briefId === brief.id && r.arm === arm && r.mode === mode));
      const [a, b] = sides.map(s => s.length === 1 ? s[0] : null), reasons = [];
      if (!a || !b) reasons.push('Missing or duplicate assigned side');
      if (!a?.validIdentity || !b?.validIdentity) reasons.push('Missing, malformed or invalid authoritative outcome');
      if (!a?.authorIdentity.verified || !b?.authorIdentity.verified) reasons.push('Unverified author model/effort receipts');
      for (const field of ['authorPairingKey', 'seed', 'runtimeDigest', 'sourceDigest', 'render', 'sensor', 'reviewer']) {
        if (a?.metadata[field] == null || b?.metadata[field] == null) reasons.push(`Missing ${field} attestation`);
        else if (!same(a.metadata[field], b.metadata[field])) reasons.push(`Mismatched ${field}`);
      }
      if (a && b && !same(a.metricDefinitions, b.metricDefinitions)) reasons.push('Mismatched accounting semantics');
      pairs.push({ cohort: cohort.cohort, briefId: brief.id, heldout: brief.heldout, mode, armA, armB,
        a: a ? { identity: a.identity, status: a.status, accepted: a.ensembleAccepted, iterations: a.iterations, cappedIterations: a.cappedIterations, calls: a.calls } : null,
        b: b ? { identity: b.identity, status: b.status, accepted: b.ensembleAccepted, iterations: b.iterations, cappedIterations: b.cappedIterations, calls: b.calls } : null,
        comparable: reasons.length === 0, reasons });
    }
    for (const heldout of [false, true]) {
      const selected = pairs.filter(p => p.mode === mode && p.armA === armA && p.armB === armB && p.heldout === heldout);
      const comparable = selected.filter(p => p.comparable);
      intervals.push({ cohort: cohort.cohort, mode, armA, armB, heldout, expectedPairs: selected.length, comparablePairs: comparable.length,
        acceptanceDifferenceBMinusA: bootstrap(comparable.map(p => Number(p.b.accepted) - Number(p.a.accepted)), `${manifest.protocolSha256}:${mode}:${armA}:${armB}:${heldout}:acceptance`),
        cappedIterationsDifferenceBMinusA: bootstrap(comparable.filter(p => p.a.cappedIterations !== null && p.b.cappedIterations !== null).map(p => p.b.cappedIterations - p.a.cappedIterations), `${manifest.protocolSha256}:${mode}:${armA}:${armB}:${heldout}:iterations`),
        callsDifferenceBMinusA: bootstrap(comparable.filter(p => p.a.calls !== null && p.b.calls !== null).map(p => p.b.calls - p.a.calls), `${manifest.protocolSha256}:${mode}:${armA}:${armB}:${heldout}:calls`) });
    }
  }
  const observations = Array.isArray(execution?.observations) ? execution.observations : [];
  const peak = field => { const values = observations.map(o => number(o[field])).filter(v => v !== null); return values.length ? Math.max(...values) : null; };
  const supervisorWallMs = observed((execution?.sessions ?? []).map(s => number(s.wallMs) ?? delta(s.endedAt, s.startedAt))).total;
  const complete = groups.every(g => g.validUniqueAssigned === g.expected);
  const result = { schema: 'simforge.situation-benchmark-report/v2', manifestFile, manifestSha256: sha(fs.readFileSync(manifestFile)),
    evidenceClass: manifest.evidenceClass ?? 'benchmark-run', syntheticFixture: manifest.syntheticFixture === true,
    qualification: 'automated-unqualified', efficacyConclusion: null,
    limitations: ['Ensemble acceptance is automated, not ground truth.', 'No efficacy claim from incomplete or noncomparable pairs.', 'Diversity adequacy requires corpus-level ensemble evidence; marginal axis counts are not an adequacy gate.', 'Fresh-three-pass qualification is evaluated by the collection reporter over exact frozen evidence.', 'No fallback to result.json. Invalid or absent authoritative outcomes remain assigned failures.', 'Stage sums are observed tool durations; simulation, render/readback/encode and cache components are not inferred from combined durations.', 'Resident worker observations are not resident memory measurements.'],
    findings, executionFindings, coverage: { fullFrozenPlanComplete: complete && !manifest.syntheticFixture, expectedAssignments: groups.reduce((n, g) => n + g.expected, 0), assignedRows: rows.length, missingAssignments: groups.reduce((n, g) => n + g.missingAssignments, 0), selectedScope: manifest.scope,
      conclusion: complete && !manifest.syntheticFixture ? 'Assignment coverage only; qualification remains unproven' : 'Incomplete preregistered comparison; subset or smoke data is not a completed benchmark' },
    overall: summary(rows), cohorts: protocol.cohorts.map(c => ({ cohort: c.id, ...summary(rows.filter(r => r.cohort === c.id)), heldout: summary(rows.filter(r => r.cohort === c.id && r.heldout === true)), nonHeldout: summary(rows.filter(r => r.cohort === c.id && r.heldout === false)) })),
    groups, rows, pairs, pairedBootstrap: intervals, resources: { peakResidentWorkers: peak('residentWorkers'), peakActiveWorkers: peak('activeWorkers'), observations: observations.length,
      supervisorWallMs, productiveAcceptedBundlesPerHour: supervisorWallMs > 0 ? rows.filter(r => r.ensembleAccepted).length * 3600000 / supervisorWallMs : null },
    gates: { evaluation: {kind:'llm-ensemble', policyDigest:policyDigest(SCENARIO_REVIEW_POLICY)}, freshThreePass: { status: 'collection-required', reason: 'Evaluate complete frozen cohorts and corpus-diversity evidence together with the collection reporter' } } };
  if (out) { const output = path.resolve(out); requireValue(![manifestFile, manifest.protocolFile, manifest.cohortFile].includes(output), 'Cannot overwrite frozen input'); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const flags = new Map();
    for (let i = 2; i < process.argv.length; i += 2) { const name = process.argv[i], value = process.argv[i + 1]; requireValue(['--manifest', '--out'].includes(name) && value && !value.startsWith('--') && !flags.has(name), 'Invalid or duplicate CLI option'); flags.set(name, value); }
    requireValue(flags.has('--manifest') && flags.has('--out'), 'Required: --manifest FILE --out NEW_FILE');
    const result = reportSituationBenchmark({ manifest: flags.get('--manifest'), out: flags.get('--out') });
    console.log(JSON.stringify({ out: path.resolve(flags.get('--out')), qualification: result.qualification, coverage: result.coverage, overall: result.overall }));
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
