/**
 * `pnpm golden-traces:verify` / `pnpm golden-traces:update [--tier ci]`.
 *
 * verify: run the corpus on the native addon and compare with
 *   fixtures/golden-traces/manifest.json under the engineSemVer rule; exit 1
 *   on any violation.
 * update: rewrite the manifest (and the resolved ambient inputs). Refuses when
 *   a digest changed but ENGINE_SEM_VER did not.
 */

import { judge, readManifest, runCorpus, writeManifest, type GoldenTier } from '../src/determinism/golden-traces.js';

const [mode = 'verify', ...rest] = process.argv.slice(2);
const tierArg = rest.includes('--tier') ? rest[rest.indexOf('--tier') + 1] : undefined;
const tiers: GoldenTier[] = tierArg === 'ci' ? ['ci'] : tierArg === 'local' ? ['local'] : ['ci', 'local'];

const started = performance.now();
const run = await runCorpus({ tiers });
const manifest = readManifest();
const seconds = ((performance.now() - started) / 1000).toFixed(1);
const summary = {
  engineSemVer: run.engineSemVer,
  ran: Object.keys(run.results).length,
  skipped: run.skipped,
  seconds: Number(seconds),
};

if (mode === 'update') {
  const written = writeManifest(run, manifest);
  console.log(JSON.stringify({ ...summary, written: Object.keys(written.cases).length }, null, 2));
} else if (mode === 'verify') {
  const verdict = judge(run, manifest);
  console.log(JSON.stringify({ ...summary, ok: verdict.ok, messages: verdict.messages }, null, 2));
  if (!verdict.ok) process.exitCode = 1;
} else {
  console.error(`unknown mode ${mode}; use verify or update`);
  process.exitCode = 1;
}
