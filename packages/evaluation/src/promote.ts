import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordPolicyPromotion, resolvePolicyCheckpoint } from '@simforge-oss/model-store';
import { compareNativeEpisodeTraces } from './campaign.js';
import { isScreeningPanel, loadPanel, type EvaluationPanel, type PanelEntry } from './panels.js';
import type { EpisodeScore } from './scoring.js';
import type { ResultManifest } from './protocol/manifest.js';

export type PromotionVerdict = 'qualified' | 'exploratory' | 'insufficient-evidence';
export interface PromotionRunRequest { entry: PanelEntry; scenario: string; policy: string; out: string; panel: EvaluationPanel }
export interface PromotionOptions {
  policy: string; panelFile: string; out: string; comparisons: string[]; bcBaseline?: string;
  run(request: PromotionRunRequest): Promise<string>;
  log?: (line: string) => void;
}
export type PromotionScore = Pick<EpisodeScore, 'drivingScore' | 'routeCompletion' | 'infractions' | 'terminal' | 'alpasim-style-score'>;
export interface PromotionEpisode {
  entryId: string; source: 'test' | 'control'; pairId: string; seed: number; mapId: string;
  runDir: string | null; health: { healthy: boolean; reasons: string[] }; score: PromotionScore | null; error: string | null;
}
export interface PolicyPanelResult {
  policy: string; episodes: PromotionEpisode[]; health: { healthy: boolean; reasons: string[] };
  drivingScore: { mean: number; se: number; n: number } | null;
  'alpasim-style-score': { mean: number; se: number; n: number } | null;
  collisionEpisodes: number | null; meanCompletion: number | null; failures: Record<string, number>;
}
export interface Day28Statistics {
  status: 'passed' | 'failed' | 'insufficient-evidence'; reasons: string[]; pairs: number;
  candidateCollisions: number | null; baselineCollisions: number | null; relativeCollisionReduction: number | null;
  pairedAbsoluteReduction95CI: [number, number] | null; completionLoss: number | null;
  method: string; seed: number; replicates: number;
}
export interface PromotionReport {
  schema: 'simforge.promotion/v1'; policy: string; verdict: PromotionVerdict; reasons: string[];
  panel: EvaluationPanel; createdAt: string; checkpoint: unknown;
  comparison: PolicyPanelResult[]; determinism: { entryId: string; originalDir: string; rerunDir: string | null; match: boolean; proof?: unknown; error?: string }[];
  day28: Day28Statistics; referenceGate: { policy: string | null; threshold: number | null; passed: boolean | null };
  metricLabel: 'not an AlpaSim result'; scope: string;
}

export function promotionHealth(manifest: ResultManifest | null): { healthy: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!manifest || manifest.status !== 'succeeded') reasons.push('session did not complete successfully');
  const health = manifest?.metrics?.['modelHealth'] as Record<string, unknown> | undefined;
  const fallbacks = health?.['fallbacks'] as Record<string, unknown> | undefined;
  const sessions = health?.['sessions'] as Record<string, unknown> | undefined;
  if (!health) reasons.push('missing model-health receipt');
  if (fallbacks?.['closedLoop'] !== 0) reasons.push('closed-loop fallbacks are nonzero or unreported');
  if (health?.['invalidPlans'] !== 0) reasons.push('invalid plans are nonzero or unreported');
  if (health?.['timeouts'] !== 0) reasons.push('timeouts are nonzero or unreported');
  if (sessions?.['expected'] !== 1 || sessions?.['completed'] !== 1) reasons.push('expected/completed session receipt is incomplete');
  if (!Number.isInteger(health?.['decisions']) || Number(health?.['decisions']) <= 0) reasons.push('no completed policy decisions');
  return { healthy: reasons.length === 0, reasons };
}

export function meanAndSe(values: readonly number[]): { mean: number; se: number; n: number } | null {
  if (!values.length || values.some((v) => !Number.isFinite(v))) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1) : 0;
  return { mean, se: Math.sqrt(variance / values.length), n: values.length };
}

/** Fixed-seed paired percentile bootstrap, test episodes only; controls are not independent trials. */
export function day28Statistics(candidate: readonly PromotionEpisode[], baseline: readonly PromotionEpisode[] | undefined, config: EvaluationPanel['statistics']): Day28Statistics {
  const out: Day28Statistics = { status: 'insufficient-evidence', reasons: [], pairs: 0, candidateCollisions: null, baselineCollisions: null, relativeCollisionReduction: null, pairedAbsoluteReduction95CI: null, completionLoss: null, method: 'paired episode bootstrap; 95% percentile CI of BC collision rate minus candidate; hazard-removed controls excluded', seed: config.bootstrapSeed, replicates: config.bootstrapReplicates };
  const own = candidate.filter((e) => e.source === 'test');
  if (!baseline) { out.reasons.push('matched BC baseline is absent'); return out; }
  const base = baseline.filter((e) => e.source === 'test');
  if (!own.length || own.length !== base.length || own.some((e) => !e.health.healthy || !e.score || !base.some((b) => b.entryId === e.entryId && b.seed === e.seed && b.health.healthy && b.score))) { out.reasons.push('complete healthy paired test results are required'); return out; }
  const pairs = own.map((e) => [e.score!, base.find((b) => b.entryId === e.entryId)!.score!] as const);
  out.pairs = pairs.length;
  out.candidateCollisions = pairs.filter(([a]) => a.terminal.collision).length;
  out.baselineCollisions = pairs.filter(([, b]) => b.terminal.collision).length;
  out.completionLoss = pairs.reduce((sum, [a, b]) => sum + b.routeCompletion - a.routeCompletion, 0) / pairs.length;
  if (out.baselineCollisions === 0) { out.reasons.push('zero-collision BC ceiling: insufficient evidence, frozen test unchanged'); return out; }
  out.relativeCollisionReduction = (out.baselineCollisions - out.candidateCollisions) / out.baselineCollisions;
  let state = config.bootstrapSeed >>> 0;
  const differences = pairs.map(([a, b]) => Number(b.terminal.collision) - Number(a.terminal.collision));
  const samples = new Float64Array(config.bootstrapReplicates);
  for (let draw = 0; draw < samples.length; draw++) {
    let sum = 0;
    for (let i = 0; i < pairs.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      sum += differences[Math.floor(state / 4294967296 * pairs.length)]!;
    }
    samples[draw] = sum / pairs.length;
  }
  samples.sort();
  out.pairedAbsoluteReduction95CI = [samples[Math.floor(samples.length * 0.025)]!, samples[Math.ceil(samples.length * 0.975) - 1]!];
  if (out.relativeCollisionReduction < config.minimumCollisionReduction) out.reasons.push('collision episode reduction is below 20%');
  if (out.pairedAbsoluteReduction95CI[0] <= 0) out.reasons.push('paired-bootstrap 95% lower bound is not positive');
  // Subtraction/mean roundoff must not reject the inclusive 2-point boundary (1 - 0.98).
  if (out.completionLoss - config.maximumCompletionLoss > 4 * Number.EPSILON * pairs.length) out.reasons.push('task completion loss exceeds 2 percentage points');
  out.status = out.reasons.length ? 'failed' : 'passed';
  return out;
}

async function freeze(file: string, document: unknown): Promise<void> {
  const bytes = Buffer.isBuffer(document) ? document : Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await readFile(file)).equals(bytes)) throw new Error(`frozen promotion inputs changed: ${file}; choose a new --out`);
  }
}

/** Validate inventory before opening score.json; untrusted/corrupt scores cannot enter a mean. */
async function verifiedScore(runDir: string, manifest: ResultManifest): Promise<PromotionScore> {
  if (!manifest.scored || !manifest.artifacts.some((a) => a.path === 'score.json') || !manifest.artifacts.some((a) => a.path === 'trace.jsonl')) throw new Error('score/trace inventory missing');
  for (const artifact of manifest.artifacts) {
    const file = path.resolve(runDir, artifact.path);
    if (!file.startsWith(path.resolve(runDir) + path.sep)) throw new Error('artifact escapes run directory');
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256 || bytes.length !== artifact.bytes) throw new Error(`artifact digest/size mismatch: ${artifact.path}`);
  }
  const score = JSON.parse(await readFile(path.join(runDir, 'score.json'), 'utf8')) as PromotionScore;
  const named = score['alpasim-style-score'];
  if (!Number.isFinite(score.drivingScore) || score.drivingScore < 0 || score.drivingScore > 1 ||
      !Number.isFinite(score.routeCompletion) || score.routeCompletion < 0 || score.routeCompletion > 1 ||
      typeof score.terminal?.collision !== 'boolean' || !score.infractions ||
      named?.version !== 'simforge.alpasim-style-score/v1' || named.label !== 'not an AlpaSim result' ||
      !Array.isArray(named.unavailable) || !Array.isArray(named.hardFailures) ||
      (named.value !== null && (!Number.isFinite(named.value) || named.value < 0 || named.value > 1))) throw new Error('both valid score instruments must be recorded');
  return score;
}

export async function promotePolicy(options: PromotionOptions): Promise<PromotionReport> {
  const loaded = await loadPanel(options.panelFile);
  const { panel } = loaded;
  const out = path.resolve(options.out);
  const policies = [...new Set([options.policy, 'scripted', ...options.comparisons, ...(options.bcBaseline ? [options.bcBaseline] : [])])];
  const checkpoint = options.policy.startsWith('torch:') ? await resolvePolicyCheckpoint(options.policy.slice(6)) : null;
  if (options.bcBaseline) {
    const bc = options.bcBaseline.startsWith('torch:') ? await resolvePolicyCheckpoint(options.bcBaseline.slice(6)) : null;
    if (bc?.entry?.trainer.recipe !== 'distill-student') throw new Error('--bc-baseline requires a registered distill-student checkpoint, not a renamed scripted/frontier policy');
  }
  const immutableCheckpoint = checkpoint?.entry ? {
    schema: checkpoint.entry.schema, family: checkpoint.entry.family, revision: checkpoint.entry.revision, sha256: checkpoint.entry.sha256,
    obsPreset: checkpoint.entry.obsPreset, actionHead: checkpoint.entry.actionHead, trainer: checkpoint.entry.trainer, provenance: checkpoint.entry.provenance,
  } : null;
  await freeze(path.join(out, 'campaign.json'), { schema: 'simforge.promotion-campaign/v1', panel, policies, candidate: options.policy, bcBaseline: options.bcBaseline ?? null, checkpoint: immutableCheckpoint });
  await freeze(path.join(out, 'panel.json'), panel);
  for (const source of panel.sources) {
    await freeze(path.join(out, 'sources', `${source.purpose}.split.json`), await readFile(path.resolve(path.dirname(loaded.file), source.manifest)));
    await freeze(path.join(out, 'sources', `${source.purpose}.episodes.json`), await readFile(path.resolve(path.dirname(loaded.file), source.episodes)));
  }
  const comparison: PolicyPanelResult[] = [];
  for (const policy of policies) {
    const episodes: PromotionEpisode[] = [];
    const manifests = new Map<string, ResultManifest>();
    const policyRoot = path.join(out, 'runs', policy.replace(/[^a-zA-Z0-9_.-]/g, '_'));
    for (const entry of panel.entries) {
      const row: PromotionEpisode = { entryId: entry.id, source: entry.source, pairId: entry.pairId, seed: entry.seed, mapId: entry.mapId, runDir: null, health: { healthy: false, reasons: ['not run'] }, score: null, error: null };
      episodes.push(row);
      const scenario = path.join(out, 'configs', `${entry.id}.episodes.json`);
      await freeze(scenario, { version: 1, scenarioId: entry.id, instances: [{ input: loaded.inputs.get(entry.id) }] });
      const pointer = path.join(policyRoot, `${entry.id}.run.json`);
      try {
        let runDir: string;
        try {
          const saved = JSON.parse(await readFile(pointer, 'utf8')) as { runDir: string };
          await access(path.join(saved.runDir, 'result.json'));
          runDir = saved.runDir;
          options.log?.(`cached ${policy} ${entry.id}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          options.log?.(`running ${policy} ${entry.id} seed=${entry.seed} at 2 Hz/offline-simtime`);
          runDir = await options.run({ entry, scenario, policy, out: path.join(policyRoot, entry.id), panel });
          await freeze(pointer, { runDir });
        }
        row.runDir = runDir;
        const manifest = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as ResultManifest;
        row.health = promotionHealth(manifest);
        const run = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) as Record<string, unknown>;
        if (run['replanHz'] !== 2 || run['warmupFrames'] !== 64 || run['decisionHz'] !== 10 || run['mode'] !== 'offline-simtime' || run['seed'] !== entry.seed || run['scenarioId'] !== entry.id || run['durationS'] !== entry.durationS) row.health.reasons.push('execution does not match frozen panel');
        if (run['scenarioInputSha256'] !== entry.inputSha256 || manifest.provenance.input?.digest !== entry.inputSha256) row.health.reasons.push('scenario input digest does not match frozen panel');
        if (run['appearance'] != null) row.health.reasons.push('raw panel cannot consume an appearance-ablation run');
        if (run['graphDigest'] !== loaded.graphDigests.get(entry.id)) row.health.reasons.push('installed lane graph differs from admitted panel topology');
        const health = manifest.metrics?.['modelHealth'] as Record<string, unknown> | undefined;
        if (policy !== 'scripted' && Number(health?.['genuinePlans'] ?? 0) <= 0) row.health.reasons.push('no genuine model plans');
        if (policy === options.policy && checkpoint?.entry && manifest.provenance.model?.checkpointDigest !== checkpoint.entry.sha256) row.health.reasons.push('checkpoint identity mismatch');
        row.health.healthy = row.health.reasons.length === 0;
        manifests.set(entry.id, manifest);
      } catch (error) { row.error = String(error); row.health = { healthy: false, reasons: [String(error)] }; }
    }
    // Deliberate two-phase gate: read EVERY health receipt BEFORE reading ANY score for this policy.
    const reasons = episodes.flatMap((e) => e.health.reasons.map((r) => `${e.entryId}: ${r}`));
    if (!reasons.length) {
      for (const row of episodes) {
        try { row.score = await verifiedScore(row.runDir!, manifests.get(row.entryId)!); }
        catch (error) { row.error = String(error); reasons.push(`${row.entryId}: ${error}`); }
      }
    }
    const scores = episodes.flatMap((e) => e.score ? [e.score] : []);
    const allScored = scores.length === panel.entries.length && reasons.length === 0;
    const named = scores.flatMap((s) => s['alpasim-style-score']?.value == null ? [] : [s['alpasim-style-score']!.value!]);
    const failures: Record<string, number> = {};
    for (const score of scores) for (const failure of score['alpasim-style-score']?.hardFailures ?? []) failures[failure] = (failures[failure] ?? 0) + 1;
    comparison.push({ policy, episodes, health: { healthy: reasons.length === 0, reasons }, drivingScore: allScored ? meanAndSe(scores.map((s) => s.drivingScore)) : null, 'alpasim-style-score': allScored && named.length === scores.length ? meanAndSe(named) : null, collisionEpisodes: allScored ? scores.filter((s) => s.terminal.collision).length : null, meanCompletion: allScored ? scores.reduce((sum, s) => sum + s.routeCompletion, 0) / scores.length : null, failures });
  }
  const candidate = comparison[0]!;
  const determinism: PromotionReport['determinism'] = [];
  const rerunRoot = path.join(out, 'rerun', randomUUID());
  if (candidate.health.healthy) for (const entry of panel.entries) {
    const original = candidate.episodes.find((e) => e.entryId === entry.id)!;
    if (!original.runDir) continue;
    const row: PromotionReport['determinism'][number] = { entryId: entry.id, originalDir: original.runDir, rerunDir: null, match: false };
    determinism.push(row);
    try {
      row.rerunDir = await options.run({ entry, policy: options.policy, scenario: path.join(out, 'configs', `${entry.id}.episodes.json`), out: path.join(rerunRoot, entry.id), panel });
      const manifest = JSON.parse(await readFile(path.join(row.rerunDir, 'result.json'), 'utf8')) as ResultManifest;
      if (!promotionHealth(manifest).healthy) throw new Error('rerun model health failed');
      const proof = compareNativeEpisodeTraces(await readFile(path.join(original.runDir, 'trace.jsonl'), 'utf8'), await readFile(path.join(row.rerunDir, 'trace.jsonl'), 'utf8'));
      row.match = proof.match; row.proof = proof;
    } catch (error) { row.error = String(error); }
  }
  const reference = comparison.find((p) => p.policy === options.comparisons[0] && p.policy !== candidate.policy);
  const referenceGate = { policy: reference?.policy ?? null, threshold: reference?.drivingScore ? reference.drivingScore.mean - reference.drivingScore.se : null, passed: candidate.drivingScore && reference?.drivingScore ? candidate.drivingScore.mean >= reference.drivingScore.mean - reference.drivingScore.se : null };
  const day28 = day28Statistics(candidate.episodes, comparison.find((p) => p.policy === options.bcBaseline)?.episodes, panel.statistics);
  const reasons: string[] = [];
  let verdict: PromotionVerdict = 'qualified';
  if (!candidate.health.healthy || determinism.some((r) => !r.match) || referenceGate.passed === false || day28.status === 'failed') verdict = 'exploratory';
  const unavailable = candidate.episodes.flatMap((e) => e.score?.['alpasim-style-score']?.unavailable ?? []);
  if (candidate.health.healthy && (day28.status === 'insufficient-evidence' || referenceGate.passed === null || unavailable.length || determinism.length !== panel.entries.length)) verdict = verdict === 'exploratory' ? verdict : 'insufficient-evidence';
  reasons.push(...candidate.health.reasons, ...day28.reasons);
  if (determinism.length !== panel.entries.length || determinism.some((r) => !r.match)) reasons.push('full-panel rerun determinism proof did not pass');
  if (referenceGate.passed !== true) reasons.push(referenceGate.passed === false ? 'mean driving score below reference minus one SE' : 'matched frontier comparison unavailable');
  if (unavailable.length) reasons.push(`named metric has unavailable authority: ${[...new Set(unavailable)].join(', ')}`);
  if (isScreeningPanel(panel)) { reasons.push(`${panel.panelId} screening only (${panel.entries.length} entries); at least 32 entries are required before qualification`); if (verdict === 'qualified') verdict = 'insufficient-evidence'; }
  const report: PromotionReport = { schema: 'simforge.promotion/v1', policy: options.policy, verdict, reasons, panel, createdAt: new Date().toISOString(), checkpoint: checkpoint?.entry ?? null, comparison, determinism, day28, referenceGate, metricLabel: 'not an AlpaSim result', scope: `same-host/same-device; matched ${panel.timing.replanHz} Hz inference and ${panel.timing.decisionHz} Hz world decisions; common ${(panel.timing.warmupFrames - 1) / panel.timing.decisionHz} s authored prologue; panel ${panel.panelId} has ${panel.entries.length} entries from admitted sources ${panel.sources.map((source) => `${source.purpose}:${source.splitDigest}`).join(', ')}; statistical result does not by itself prove DAgger, full-grid admission, budget compliance or real-world safety` };
  const file = path.join(out, 'promotion.json');
  await writeFile(`${file}.partial`, `${JSON.stringify(report, null, 2)}\n`); await rename(`${file}.partial`, file);
  await writeFile(path.join(out, 'score.json'), `${JSON.stringify({ schema: 'simforge.promotion-score/v1', policy: report.policy, drivingScore: candidate.drivingScore, 'alpasim-style-score': candidate['alpasim-style-score'], label: report.metricLabel, day28 }, null, 2)}\n`);
  await writeFile(path.join(out, 'report.md'), promotionMarkdown(report));
  if (checkpoint?.entry) await recordPolicyPromotion(options.policy.slice(6), file);
  return report;
}

export function promotionMarkdown(report: PromotionReport): string {
  const rows = report.comparison.map((p) => `| ${p.policy} | ${p.health.healthy ? 'clean' : 'failed; scores withheld'} | ${p.drivingScore ? `${p.drivingScore.mean.toFixed(4)} ± ${p.drivingScore.se.toFixed(4)}` : 'unavailable'} | ${p['alpasim-style-score'] ? `${p['alpasim-style-score'].mean.toFixed(4)} ± ${p['alpasim-style-score'].se.toFixed(4)}` : 'unavailable'} | ${p.collisionEpisodes ?? 'unavailable'} |`);
  return [`# Promotion ${report.policy}`, '', `Verdict: **${report.verdict}**`, '', 'alpasim-style-score: **not an AlpaSim result**.', '', '| policy | model health | drivingScore mean ± SE | alpasim-style-score mean ± SE | collision episodes |', '|---|---|---:|---:|---:|', ...rows, '', ...report.reasons.map((r) => `- ${r}`), '', `Day 28: ${report.day28.status}. ${report.day28.method}.`, report.scope, ''].join('\n');
}
