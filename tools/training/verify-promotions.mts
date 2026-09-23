import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyRunDirectory } from '../../packages/cli/src/commands/drive/verify.js';
import type { PromotionReport } from '../../packages/evaluation/src/promote.js';
const [out, ...directories] = process.argv.slice(2);
if (!out || !directories.length) throw new Error('usage: verify-promotions.mts OUTPUT.json PROMOTION_DIR...');
const runs = new Set<string>();
for (const directory of directories) {
  const report = JSON.parse(await readFile(path.join(directory, 'promotion.json'), 'utf8')) as PromotionReport;
  for (const policy of report.comparison) {
    if (!policy.health.healthy || policy.episodes.length !== report.panel.expectedEpisodes) throw new Error(`${directory}: incomplete model-health prerequisite for ${policy.policy}`);
    for (const episode of policy.episodes) {
      if (!episode.runDir) throw new Error('promotion omitted an expected source run');
      runs.add(episode.runDir);
    }
  }
  if (report.determinism.length !== report.panel.expectedEpisodes) throw new Error('incomplete model re-inference rerun coverage');
  for (const rerun of report.determinism) {
    if (!rerun.rerunDir || rerun.error) throw new Error(`rerun infrastructure did not complete: ${rerun.entryId}`);
    runs.add(rerun.rerunDir);
  }
}
const receipts = [];
let pngs = 0, decisions = 0;
for (const directory of runs) {
  const receipt = await verifyRunDirectory(directory);
  if (!receipt.modelHealth.healthy) throw new Error(`${directory}: unhealthy rendered run`);
  receipts.push(receipt); pngs += receipt.frameDigestsVerified; decisions += receipt.steps;
  console.log(`VERIFIED ${receipts.length}/${runs.size} ${directory}`);
}
const result = { schema: 'simforge.student-promotion-verification/v1', passed: true, runs: receipts.length, pngDigestsVerified: pngs, policyDecisions: decisions, note: 'Artifact/health verification does not change failed world/action rerun classifications or imply promotion.', receipts };
await writeFile(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, receipts: undefined }));
