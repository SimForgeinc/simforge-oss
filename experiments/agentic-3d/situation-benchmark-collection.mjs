#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { reportSituationBenchmark } from './situation-benchmark-report.mjs';
import { SCENARIO_REVIEW_POLICY, DIVERSITY_REVIEW_POLICY, policyDigest, validateEnsembleReview } from './situation-ensemble.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
function distribution(values) {
  const sorted = values.filter(known).sort((a, b) => a - b);
  return { values, known: sorted.length, unknown: values.length - sorted.length, min: sorted[0] ?? null, max: sorted.at(-1) ?? null,
    median: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null,
    p90: sorted.length ? sorted[Math.ceil(sorted.length * .9) - 1] : null };
}
function observed(values) {
  const present = values.filter(known), sum = present.reduce((a, b) => a + b, 0);
  return { total: values.length && present.length === values.length ? sum : null, observedTotal: present.length ? sum : null, known: present.length, unknown: values.length - present.length };
}
function summarize(rows) {
  const accepted = rows.filter(r => r.collectionAccepted), wall = observed(rows.map(r => r.wallMs));
  const keyed = field => Object.fromEntries([...new Set(rows.flatMap(r => Object.keys(r[field] ?? {})))].sort().map(k => [k, observed(rows.map(r => r[field]?.[k]))]));
  return { assigned: rows.length, ensembleAccepted: accepted.length, failures: rows.length - accepted.length,
    ensembleAcceptanceRate: rows.length ? accepted.length / rows.length : null,
    firstSubmissionSuccess: rows.filter(r => r.collectionEligible && r.firstSubmissionSuccess === true).length,
    firstSubmissionUnknown: rows.filter(r => !r.collectionEligible || r.firstSubmissionSuccess === null).length,
    firstSubmissionSuccessRate: rows.length ? rows.filter(r => r.collectionEligible && r.firstSubmissionSuccess === true).length / rows.length : null,
    statusCounts: rows.reduce((o, r) => { o[r.status] = (o[r.status] ?? 0) + 1; return o; }, {}),
    collectionIneligible: rows.filter(r => !r.collectionEligible).length,
    acceptedIterations: distribution(accepted.map(r => r.iterations)), medianAcceptedIterations: distribution(accepted.map(r => r.iterations)).median,
    cappedAllAssignedIterations: distribution(rows.map(r => r.collectionCappedIterations)),
    metrics: Object.fromEntries(['calls', 'tools', 'requestedTools', 'semanticEdits', 'failedTools', 'submissions'].map(k => [k, observed(rows.map(r => r[k]))])),
    tokens: keyed('tokens'), stageElapsedMs: keyed('stages'), wallMs: wall, queueMs: observed(rows.map(r => r.queueMs)),
    costUSD: { ...observed(rows.map(r => r.cost.total)), reported: observed(rows.map(r => r.cost.reportedTotal)), reportedRequests: observed(rows.map(r => r.cost.reportedRequests)), unavailableRequests: observed(rows.map(r => r.cost.unavailableRequests)) },
    allAssignedWallMsPerAcceptedBundle: accepted.length && wall.total !== null ? wall.total / accepted.length : null };
}
function bootstrap(values, seedText) {
  if (!values.length) return null;
  let state = parseInt(sha(seedText).slice(0, 8), 16) || 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const estimates = [];
  for (let i = 0; i < 10000; i++) { let sum = 0; for (let j = 0; j < values.length; j++) sum += values[Math.floor(random() * values.length)]; estimates.push(sum / values.length); }
  estimates.sort((a, b) => a - b);
  return { estimate: values.reduce((a, b) => a + b, 0) / values.length, lower: estimates[249], upper: estimates[9749], confidence: .95, pairs: values.length, replicates: 10000, seed: sha(seedText), method: 'Deterministic xorshift32 percentile paired-brief bootstrap; descriptive, not an efficacy conclusion.' };
}

/** Manifests and optional corpus-diversity review are immutable inputs. */
export function reportSituationBenchmarkCollection({ manifests, out, diversityReview }) {
  requireValue(Array.isArray(manifests) && manifests.length > 0, 'Supply at least one immutable manifest');
  const sources = manifests.map((entry, sourceIndex) => {
    const options = typeof entry === 'string' ? { manifest: entry } : entry;
    requireValue(options && typeof options.manifest === 'string', 'Each entry needs a manifest filename');
    const manifestFile = path.resolve(options.manifest), manifest = json(manifestFile);
    const report = reportSituationBenchmark({ manifest: manifestFile });
    const protocolBytes = fs.readFileSync(manifest.protocolFile), cohortBytes = fs.readFileSync(manifest.cohortFile);
    return { sourceIndex, manifestFile, manifestSha256: sha(fs.readFileSync(manifestFile)), manifest,
      protocol: JSON.parse(protocolBytes), protocolSha256: sha(protocolBytes), cohort: JSON.parse(cohortBytes), cohortSha256: sha(cohortBytes),
      report };
  });
  const protocol = sources[0].protocol, findings = [];
  const protocolIdentityVerified = sources.every(s => s.protocolSha256 === sources[0].protocolSha256 && s.manifest.protocolSha256 === s.protocolSha256 && s.cohort.protocolSha256 === s.protocolSha256);
  if (!protocolIdentityVerified) findings.push('Frozen protocol identities differ or fail their SHA bindings; no combined gate is evaluable.');
  const cohortCoverage = protocol.cohorts.map(c => {
    const supplied = sources.filter(s => s.cohort.cohort === c.id), hashes = [...new Set(supplied.map(s => s.cohortSha256))];
    const briefs = supplied[0]?.cohort.briefs ?? [];
    const reasons = [];
    if (!supplied.length) reasons.push('Missing frozen cohort');
    if (hashes.length > 1) reasons.push('Conflicting frozen cohort identities');
    if (supplied.some(s => s.manifest.cohortSha256 !== s.cohortSha256)) reasons.push('Cohort SHA binding mismatch');
    if (briefs.length !== c.count || new Set(briefs.map(b => b.id)).size !== c.count) reasons.push('Frozen cohort does not contain the expected unique briefs');
    if (briefs.filter(b => b.heldout === true).length !== c.heldout || briefs.some(b => typeof b.heldout !== 'boolean')) reasons.push('Frozen heldout allocation mismatch');
    return { cohort: c.id, expected: c.count, expectedHeldout: c.heldout, suppliedManifests: supplied.map(s => s.sourceIndex), cohortSha256: hashes, verified: reasons.length === 0, reasons, briefs };
  });
  for (const s of sources) if (!protocol.cohorts.some(c => c.id === s.cohort.cohort)) findings.push(`Unknown cohort in source ${s.sourceIndex}: ${s.cohort.cohort}`);
  const rows = sources.flatMap(s => s.report.rows.map(r => ({ ...r, source: { sourceIndex: s.sourceIndex, manifestFile: s.manifestFile, manifestSha256: s.manifestSha256, rowIndex: r.index, runDir: r.runDir, evidenceClass: s.report.evidenceClass, syntheticFixture: s.report.syntheticFixture } })));
  const identities = new Map();
  for (const row of rows) { const group = identities.get(row.identity) ?? []; group.push(row); identities.set(row.identity, group); }
  const duplicates = [...identities.entries()].filter(([, group]) => group.length > 1).map(([identity, group]) => ({ identity, occurrences: group.map(r => r.source), policy: 'All occurrences retained and ineligible; no retry selected.' }));
  for (const row of rows) {
    row.collectionFindings = [];
    if (!protocolIdentityVerified) row.collectionFindings.push('Collection protocol identity unverified');
    if (!cohortCoverage.find(c => c.cohort === row.cohort)?.verified) row.collectionFindings.push('Collection frozen cohort identity or coverage unverified');
    if (identities.get(row.identity).length > 1) row.collectionFindings.push('Duplicate collection assignment; no best retry selection');
    if (row.source.syntheticFixture) row.collectionFindings.push('Synthetic fixture cannot qualify actual benchmark coverage');
    if (!row.authorIdentity.verified) row.collectionFindings.push('Author model/effort receipts unverified');
    row.collectionEligible = row.validIdentity && row.collectionFindings.length === 0;
    row.collectionAccepted = row.collectionEligible && row.ensembleAccepted;
    row.collectionCappedIterations = row.collectionAccepted ? row.cappedIterations : (sources[row.source.sourceIndex].protocol.budgets[row.mode]?.rehearsalAttempts ?? null);
  }
  const arms = ['C', 'D'], modes = Object.keys(protocol.budgets), groups = [];
  for (const cohort of cohortCoverage) for (const mode of modes) for (const arm of arms) {
    const selected = rows.filter(r => r.cohort === cohort.cohort && r.mode === mode && r.arm === arm);
    const assignedIds = new Set(selected.map(r => r.briefId)), eligibleIds = new Set(selected.filter(r => r.collectionEligible).map(r => r.briefId));
    groups.push({ cohort: cohort.cohort, mode, arm, expected: cohort.expected, assigned: selected.length, eligibleUniqueAssigned: eligibleIds.size,
      complete: protocolIdentityVerified && cohort.verified && selected.length === cohort.expected && eligibleIds.size === cohort.expected,
      missingBriefIds: cohort.briefs.filter(b => !assignedIds.has(b.id)).map(b => b.id), missingAssignments: Math.max(0, cohort.expected - assignedIds.size),
      summary: summarize(selected), heldout: summarize(selected.filter(r => r.heldout === true)), nonHeldout: summarize(selected.filter(r => r.heldout === false)),
      axes: Object.fromEntries(protocol.diversity.dimensions.map(d => [d, [...new Set(selected.map(r => canonical(r.brief?.[d] ?? null)))].sort().map(value => ({ value: JSON.parse(value), ...summarize(selected.filter(r => canonical(r.brief?.[d] ?? null) === value)) }))])) });
  }
  const pairs = [];
  for (const cohort of cohortCoverage) for (const brief of cohort.briefs) for (const mode of modes) for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
    const [armA, armB] = [arms[i], arms[j]], sides = [armA, armB].map(arm => rows.filter(r => r.cohort === cohort.cohort && r.briefId === brief.id && r.mode === mode && r.arm === arm));
    const [a, b] = sides.map(side => side.length === 1 ? side[0] : null), reasons = [];
    if (!a || !b) reasons.push('Missing or duplicate assigned side');
    if (!a?.collectionEligible || !b?.collectionEligible) reasons.push('Missing or ineligible authoritative outcome');
    if (!a?.authorIdentity.verified || !b?.authorIdentity.verified) reasons.push('Unverified author model/effort receipts');
    for (const field of ['authorPairingKey', 'seed', 'runtimeDigest', 'sourceDigest', 'render', 'sensor', 'reviewer']) {
      if (a?.metadata?.[field] == null || b?.metadata?.[field] == null) reasons.push(`Missing ${field} attestation`);
      else if (canonical(a.metadata[field]) !== canonical(b.metadata[field])) reasons.push(`Mismatched ${field}`);
    }
    if (a?.metricDefinitions == null || b?.metricDefinitions == null) reasons.push('Missing accounting semantics');
    else if (canonical(a.metricDefinitions) !== canonical(b.metricDefinitions)) reasons.push('Mismatched accounting semantics');
    pairs.push({ cohort: cohort.cohort, briefId: brief.id, heldout: brief.heldout, mode, armA, armB, a, b, assignedSides: sides, comparable: reasons.length === 0, reasons });
  }
  const fresh = protocol.cohorts.filter(c => /^fresh-\d+$/.test(c.id)), pairedBootstrap = [];
  for (const scope of [...cohortCoverage.map(c => c.cohort), 'all-fresh']) for (const mode of modes) for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) for (const heldout of [null, false, true]) {
    const selected = pairs.filter(p => (scope === 'all-fresh' ? fresh.some(c => c.id === p.cohort) : p.cohort === scope) && p.mode === mode && p.armA === arms[i] && p.armB === arms[j] && (heldout === null || p.heldout === heldout));
    const comparable = selected.filter(p => p.comparable), seed = `${sources[0].protocolSha256}:${scope}:${mode}:${arms[i]}:${arms[j]}:${heldout}`;
    const expectedPairs = protocol.cohorts.filter(c => scope === 'all-fresh' ? fresh.some(f => f.id === c.id) : c.id === scope).reduce((n, c) => n + (heldout === null ? c.count : heldout ? c.heldout : c.count - c.heldout), 0);
    pairedBootstrap.push({ scope, mode, armA: arms[i], armB: arms[j], heldout, expectedPairs, listedPairs: selected.length, comparablePairs: comparable.length,
      acceptanceDifferenceBMinusA: bootstrap(comparable.map(p => Number(p.b.collectionAccepted) - Number(p.a.collectionAccepted)), seed + ':acceptance'),
      cappedIterationsDifferenceBMinusA: bootstrap(comparable.filter(p => known(p.a.collectionCappedIterations) && known(p.b.collectionCappedIterations)).map(p => p.b.collectionCappedIterations - p.a.collectionCappedIterations), seed + ':iterations'),
      callsDifferenceBMinusA: bootstrap(comparable.filter(p => known(p.a.calls) && known(p.b.calls)).map(p => p.b.calls - p.a.calls), seed + ':calls') });
  }
  const thresholds = protocol.acceptance.finalGate;
  const numericGates = ['matched', 'naturalStopping'].map(mode => {
    const cohorts = fresh.map(c => {
      const group = groups.find(g => g.cohort === c.id && g.mode === mode && g.arm === 'D'), s = group?.summary, h = group?.heldout;
      const gate = (value, complete, pass) => ({ status: !complete || value === null ? 'incomplete' : pass(value) ? 'passed' : 'failed', value });
      const eventual = gate(s?.ensembleAcceptanceRate ?? null, group?.complete, v => v >= thresholds.eventualAcceptanceAtLeast);
      const heldout = gate(h?.ensembleAcceptanceRate ?? null, group?.complete && h?.assigned === c.heldout, v => v >= thresholds.heldoutAcceptanceAtLeast);
      const medianAcceptedIterations = gate(s?.medianAcceptedIterations ?? null, group?.complete && s?.acceptedIterations.unknown === 0, v => v <= thresholds.medianAcceptedIterationsAtMost);
      const states = [eventual, heldout, medianAcceptedIterations].map(g => g.status);
      return { cohort: c.id, assigned: s?.assigned ?? 0, expected: c.count, eventual, heldout, medianAcceptedIterations, status: states.includes('failed') ? 'failed' : states.includes('incomplete') ? 'incomplete' : 'passed' };
    });
    const fullFreshPlan = fresh.length === thresholds.passes && fresh.length === 3 && fresh.every(c => c.count === 64) && protocolIdentityVerified;
    return { arm: 'D', mode, thresholds, requiredCohorts: 3, listedFreshCohorts: fresh.length, cohorts,
      status: !fullFreshPlan ? 'incomplete' : cohorts.some(c => c.status === 'failed') ? 'failed' : cohorts.some(c => c.status === 'incomplete') ? 'incomplete' : 'passed',
      interpretation: 'Automated ensemble numeric gates only. Every fresh cohort must independently meet each threshold; no pooled rescue or best retry.' };
  });
  const fullFrozenPlanComplete = groups.every(g => g.complete) && duplicates.length === 0 && findings.length === 0;
  const comparableFreshCoverage = fresh.length === 3 && fresh.every(c => c.count === 64 && modes.every(mode => arms.every(arm => groups.find(g => g.cohort === c.id && g.mode === mode && g.arm === arm)?.complete))) && pairs.filter(p => fresh.some(c => c.id === p.cohort)).every(p => p.comparable);
  const evidence = {
    schema: 'simforge.situation-corpus-evidence/v1',
    protocolSha256: sources[0].protocolSha256,
    manifests: sources.map(s => ({manifestFile:s.manifestFile, manifestSha256:s.manifestSha256, cohortSha256:s.cohortSha256})),
    rows: rows.map(r => ({identity:r.identity, source:r.source, brief:r.brief, status:r.reportedStatus, accepted:r.collectionAccepted,
      authorIdentity:r.authorIdentity, evaluation:r.evaluation, reviewEvidence:r.reviewEvidence, metadata:r.metadata, metadataFindings:r.metadataFindings, findings:[...r.findings,...r.collectionFindings], outcomeSha256:r.runDir && fs.existsSync(path.join(r.runDir,'outcome.json')) ? sha(fs.readFileSync(path.join(r.runDir,'outcome.json'))) : null})),
  };
  const evidenceDigest = sha(canonical(evidence));
  let diversityAdequacy = {status:'incomplete', kind:'llm-ensemble', policyDigest:policyDigest(DIVERSITY_REVIEW_POLICY), evidenceDigest, review:null, errors:['No corpus-diversity ensemble review supplied']};
  if (diversityReview) {
    try {
      const review = json(path.resolve(diversityReview)), validation = validateEnsembleReview(review,{policy:DIVERSITY_REVIEW_POLICY,evidenceDigest});
      diversityAdequacy = {...diversityAdequacy, file:path.resolve(diversityReview), review, errors:validation.errors,
        status:!validation.valid ? 'invalid' : review.decision === 'accept' ? 'passed' : 'failed'};
    } catch(error) { diversityAdequacy = {...diversityAdequacy, status:'invalid', errors:[error.message]}; }
  }
  const currentPolicies = protocol.schema === 'simforge.situation-benchmark-protocol/v2'
    && protocol.evaluation?.scenario?.policyDigest === policyDigest(SCENARIO_REVIEW_POLICY)
    && protocol.evaluation?.diversity?.policyDigest === policyDigest(DIVERSITY_REVIEW_POLICY);
  const qualified = currentPolicies && fullFrozenPlanComplete && comparableFreshCoverage && numericGates.every(g => g.status === 'passed') && diversityAdequacy.status === 'passed';
  const result = { schema: 'simforge.situation-benchmark-collection/v2', qualification: qualified ? 'automated-qualified' : 'withheld', efficacyConclusion: null,
    evidence, evidenceDigest, evaluationKind:'llm-ensemble',
    protocolIdentity: { verified: protocolIdentityVerified, protocolSha256: sources[0].protocolSha256, sources: sources.map(s => ({ sourceIndex: s.sourceIndex, file: s.manifest.protocolFile, declaredSha256: s.manifest.protocolSha256, observedSha256: s.protocolSha256 })) },
    findings, duplicates, sources: sources.map(({ protocol: _p, cohort: _c, ...s }) => s),
    coverage: { assignedRows: rows.length, expectedAssignments: groups.reduce((n, g) => n + g.expected, 0), fullFrozenPlanComplete, comparableFreshCoverage, cohorts: cohortCoverage },
    overall: summarize(rows), groups,
    cohorts: cohortCoverage.map(c => ({ cohort: c.cohort, summary: summarize(rows.filter(r => r.cohort === c.cohort)), heldout: summarize(rows.filter(r => r.cohort === c.cohort && r.heldout === true)) })),
    armModes: modes.flatMap(mode => arms.map(arm => ({ arm, mode, summary: summarize(rows.filter(r => r.arm === arm && r.mode === mode)), heldout: summarize(rows.filter(r => r.arm === arm && r.mode === mode && r.heldout === true)) }))),
    rows, pairs, pairedBootstrap,
    resources: { byManifest: sources.map(s => ({ sourceIndex: s.sourceIndex, manifestSha256: s.manifestSha256, ...s.report.resources, executionFindings: s.report.executionFindings })),
      policy: 'Per-manifest observations retained. Supervisor sessions can overlap or be shared; no summed wall-clock throughput or inferred memory/cost.' },
    gates: { numericDArm: numericGates,
      diversityAdequacy,
      automatedQualification: { status:qualified ? 'passed' : 'incomplete', currentPolicies,
        reason:qualified ? 'All frozen numeric, comparable coverage and corpus-diversity ensemble gates passed; automated evidence, not ground truth.' : 'Requires current policies, complete comparable frozen coverage, every numeric gate and an accepting ensemble review of this exact corpus evidence.' } },
    limitations: ['Every supplied assignment and authoritative source report is retained, including failures and duplicates.', 'Missing outcomes remain failures; missing observations and unpriced costs remain null, never zero.', 'Synthetic fixtures cannot complete actual coverage.', 'Bootstrap evidence uses only actual comparable pairs with all required attestations; missing metadata is not equality.', 'Source reports and collection-qualified counts are distinct: collection conflicts can invalidate otherwise valid source rows.', 'Matched and naturalStopping are reported separately; neither is an invented primary mode.'] };
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const manifests = [], flags = new Map();
    for (let i = 2; i < process.argv.length; i += 2) {
      const name = process.argv[i], value = process.argv[i + 1];
      requireValue(['--manifest', '--out', '--diversity-review'].includes(name) && value && !value.startsWith('--'), 'Usage: --manifest FILE [--manifest FILE ...] --out NEW_FILE [--diversity-review FILE]');
      if (name === '--manifest') manifests.push(value);
      else { requireValue(!flags.has(name), `Duplicate ${name}`); flags.set(name, value); }
    }
    requireValue(manifests.length && flags.has('--out'), 'Required: --manifest FILE --out NEW_FILE');
    const result = reportSituationBenchmarkCollection({ manifests, out: flags.get('--out'), diversityReview:flags.get('--diversity-review') });
    console.log(JSON.stringify({ out: path.resolve(flags.get('--out')), qualification: result.qualification, overall: result.overall, coverage: { assignedRows: result.coverage.assignedRows, fullFrozenPlanComplete: result.coverage.fullFrozenPlanComplete }, numericDArm: result.gates.numericDArm }));
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
