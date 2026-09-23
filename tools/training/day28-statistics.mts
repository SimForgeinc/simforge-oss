import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { day28Statistics, meanAndSe, type PromotionEpisode, type PromotionReport } from '../../packages/evaluation/src/promote.js';

const [out, ...args] = process.argv.slice(2);
const secondaryIndex = args.indexOf('--secondary-baseline');
const secondaryBaseline = secondaryIndex >= 0 ? args[secondaryIndex + 1] : undefined;
if (secondaryIndex >= 0) {
  if (!secondaryBaseline?.startsWith('torch:')) throw new Error('--secondary-baseline requires an explicit registered torch ref');
  args.splice(secondaryIndex, 2);
}
const directories = args;
if (!out || !directories.length) throw new Error('usage: day28-statistics.mts OUTPUT.json [--secondary-baseline TORCH_REF] DAGGER_PROMOTION_DIR...');

function pairedIntervals(differences: number[][], seed: number, replicates: number) {
  if (!differences.length) throw new Error('paired bootstrap needs nonempty matched episodes');
  let state = seed >>> 0;
  const draws = differences[0]!.map(() => new Float64Array(replicates));
  for (let draw = 0; draw < replicates; draw++) {
    const sums = differences[0]!.map(() => 0);
    for (let i = 0; i < differences.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const row = differences[Math.floor(state / 4294967296 * differences.length)]!;
      for (let j = 0; j < sums.length; j++) sums[j]! += row[j]!;
    }
    for (let j = 0; j < sums.length; j++) draws[j]![draw] = sums[j]! / differences.length;
  }
  return draws.map((values) => {
    values.sort();
    return [values[Math.floor(replicates * 0.025)]!, values[Math.ceil(replicates * 0.975) - 1]!];
  });
}

function summarize(rows: PromotionEpisode[]) {
  if (!rows.length || rows.some((row) => !row.health.healthy || !row.score)) throw new Error('statistics require complete healthy scored pairs');
  return { episodes: rows.length, collisionEpisodes: rows.filter((row) => row.score!.terminal.collision).length,
    drivingScore: meanAndSe(rows.map((row) => row.score!.drivingScore)),
    taskCompletion: meanAndSe(rows.map((row) => row.score!.routeCompletion)) };
}

const panels = [];
const comparisons = directories.flatMap((directory) => [
  { directory, comparisonRole: 'primary', baselineRef: undefined as string | undefined },
  ...(secondaryBaseline ? [{ directory, comparisonRole: 'secondary-label-matched', baselineRef: secondaryBaseline }] : []),
]);
for (const { directory, comparisonRole, baselineRef } of comparisons) {
  const bytes = await readFile(path.join(directory, 'promotion.json'));
  const report = JSON.parse(bytes.toString()) as PromotionReport;
  const campaign = JSON.parse(await readFile(path.join(directory, 'campaign.json'), 'utf8'));
  const reruns = report.determinism.map((row) => {
    const proof = row.proof as { pixelIdentical?: boolean } | undefined;
    return { ...row, classification: row.error || !row.proof ? 'verification-error' : row.match ? proof?.pixelIdentical ? 'world-and-RGB-identical' : 'renderer-only-nondeterminism' : 'world-action-or-scene-divergence' };
  });
  const modelReInferenceDeterminism = {
    episodes: reruns.length, exactWorldActionScene: reruns.filter((row) => row.match).length,
    RGBIdentical: reruns.filter((row) => row.classification === 'world-and-RGB-identical').length,
    rendererOnlyDifferences: reruns.filter((row) => row.classification === 'renderer-only-nondeterminism').length,
    worldActionOrSceneDivergences: reruns.filter((row) => row.classification === 'world-action-or-scene-divergence').length,
    verificationErrors: reruns.filter((row) => row.classification === 'verification-error').length,
    recordedActionReplaySubstituted: false, rows: reruns,
  };
  const candidate = report.comparison.find((row) => row.policy === report.policy);
  const baseline = report.comparison.find((row) => row.policy === (baselineRef ?? campaign.bcBaseline));
  if (!candidate || !baseline || !candidate.health.healthy || !baseline.health.healthy) throw new Error(`${directory}: complete matched healthy BC is required`);
  const candidateHazards = candidate.episodes.filter((row) => row.source === 'test');
  const baselineHazards = candidateHazards.map((row) => baseline.episodes.find((b) => b.entryId === row.entryId && b.seed === row.seed && b.mapId === row.mapId));
  if (baselineHazards.some((row) => !row)) throw new Error('panel identities differ');
  const bc = baselineHazards as PromotionEpisode[];
  summarize(candidateHazards); summarize(bc);
  const differences = candidateHazards.map((row, i) => [Number(bc[i]!.score!.terminal.collision) - Number(row.score!.terminal.collision), row.score!.drivingScore - bc[i]!.score!.drivingScore, row.score!.routeCompletion - bc[i]!.score!.routeCompletion]);
  const intervals = pairedIntervals(differences, report.panel.statistics.bootstrapSeed, report.panel.statistics.bootstrapReplicates);
  const gate = day28Statistics(candidate.episodes, baseline.episodes, report.panel.statistics);
  if (gate.pairedAbsoluteReduction95CI && JSON.stringify(gate.pairedAbsoluteReduction95CI) !== JSON.stringify(intervals[0])) throw new Error('bootstrap differs from promotion implementation');
  const source = JSON.parse(await readFile(path.join(directory, 'sources/test.episodes.json'), 'utf8'));
  const familyOf = (row: PromotionEpisode) => source.instances[report.panel.entries.find((entry) => entry.id === row.entryId)!.instance].provenance.replayKey.templateId as string;
  const families = [...new Set(candidateHazards.map(familyOf))].sort().map((family) => {
    const ids = candidateHazards.map((row, index) => ({ row, index })).filter(({ row }) => familyOf(row) === family).map(({ index }) => index);
    return { family, BC: summarize(ids.map((i) => bc[i]!)), DAgger: summarize(ids.map((i) => candidateHazards[i]!)), paired95CI: pairedIntervals(ids.map((i) => differences[i]!), report.panel.statistics.bootstrapSeed, report.panel.statistics.bootstrapReplicates) };
  });
  panels.push({ panel: report.panel.panelId, panelDigest: report.panel.digest, promotionDirectory: path.resolve(directory), promotionSha256: createHash('sha256').update(bytes).digest('hex'), candidate: report.policy, baseline: baseline.policy,
    comparisonRole, comparisonLabel: comparisonRole === 'primary' ? 'BC-100k versus DAgger' : 'BC-200k versus DAgger (secondary only)', promotionVerdict: report.verdict, gate, modelReInferenceDeterminism,
    hazardOnly: { BC: summarize(bc), DAgger: summarize(candidateHazards), collisionEpisodeReduction95CI: intervals[0], drivingScoreDifference95CI: intervals[1], taskCompletionDifference95CI: intervals[2],
      collisionRateDifference: differences.reduce((sum, row) => sum + row[0]!, 0) / differences.length,
      drivingScoreDifference: differences.reduce((sum, row) => sum + row[1]!, 0) / differences.length },
    controlsDescriptiveOnly: { BC: summarize(baseline.episodes.filter((row) => row.source === 'control')), DAgger: summarize(candidate.episodes.filter((row) => row.source === 'control')) },
    allPanelEpisodesDescriptiveOnly: { BC: summarize(baseline.episodes), DAgger: summarize(candidate.episodes) }, families,
    pairing: candidateHazards.map((row) => ({ id: row.entryId, seed: row.seed, mapId: row.mapId, family: familyOf(row) })) });
}
const primary = panels.find((panel) => panel.panel === 'devpanel32-v3' && panel.comparisonRole === 'primary');
if (!primary) throw new Error('primary frozen devpanel32-v3 result required');
const document = { schema: 'simforge.day28-statistics/v1', verdict: primary.gate.status, promotionVerdict: primary.promotionVerdict,
  verdictScope: 'Preregistered primary collision/completion statistical gate only; promotion status is separate and budget/methodology audits remain required.',
  method: '10,000 fixed-panel-seed paired episode bootstrap replicates, percentile95%; differences BC-candidate collision episodes and candidate-BC drivingScore/completion. Hazard-only primary; controls never count as independent samples. Degenerate collision intervals remain insufficient evidence when BC has zero collisions.',
  confidence: 0.95, primaryComparison: 'BC-100k versus DAgger; unequal unique label acquisition is the preregistered recipe, not a label-efficiency claim', panels };
await writeFile(out, JSON.stringify(document, null, 2) + '\n');
console.log(JSON.stringify({ out, verdict: document.verdict, panels: panels.map(({ panel, comparisonRole, gate }) => ({ panel, comparisonRole, gate })) }, null, 2));
