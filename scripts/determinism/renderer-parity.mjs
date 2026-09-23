#!/usr/bin/env node
/**
 * Cross-renderer pose-parity hook (phase 5 of the deterministic pipeline).
 *
 * The job this reserves: for each golden-trace case, sample the render
 * timeline with the shared sampler (`pose(timeline, t)`), render it with Bevy
 * (observed-frames.jsonl) and CARLA trace replay (observed transforms), and
 * compare with WS-B's comparator under the tolerance profile in
 * docs/engineering/render-timeline.md (Bevy <= 1e-3 m / 0.05 deg; CARLA replay
 * <= 1 cm / 0.1 deg). Renderers need GPU runners, so the real job runs on the
 * self-hosted `gpu-rtx5080` runner (see .github/workflows/native-golden.yml).
 *
 * Contract for the comparator, when it lands:
 *   SIMFORGE_PARITY_COMPARATOR=<executable> node scripts/determinism/renderer-parity.mjs
 *   the executable receives `--corpus fixtures/golden-traces/corpus.json
 *   --manifest fixtures/golden-traces/manifest.json --out <dir>` and exits
 *   non-zero on any tolerance violation.
 *
 * Until then this reports "skipped" and exits 0, so the CI step exists and its
 * wiring is reviewed once, not invented later.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const comparator = process.env.SIMFORGE_PARITY_COMPARATOR;

if (!comparator || !existsSync(comparator)) {
  console.log(JSON.stringify({ job: 'renderer-parity', status: 'skipped', reason: 'no comparator configured (SIMFORGE_PARITY_COMPARATOR); lands with WS-B' }));
} else {
  const out = process.env.SIMFORGE_PARITY_OUT ?? path.join(ROOT, 'artifacts', 'renderer-parity');
  const result = spawnSync(comparator, [
    '--corpus', path.join(ROOT, 'fixtures/golden-traces/corpus.json'),
    '--manifest', path.join(ROOT, 'fixtures/golden-traces/manifest.json'),
    '--out', out,
  ], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
