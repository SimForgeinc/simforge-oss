/**
 * The golden-trace corpus under the engineSemVer rule (see
 * `src/determinism/golden-traces.ts`, docs/engineering/engine-semver.md).
 * Runs the `ci` tier; SIMFORGE_GOLDEN_TIERS=all adds installed private maps.
 * Needs the native addon (`pnpm --filter @simforge-oss/native-runtime build:node`).
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { engine } from '@simforge-oss/engine/node';

import { GOLDEN_ROOT, judge, readCorpus, readManifest, runCorpus } from '../determinism/golden-traces.js';

const ADDON_DIR = path.join(GOLDEN_ROOT, '..', '..', 'packages', 'native-runtime', 'native');
const haveAddon = existsSync(ADDON_DIR) && readdirSync(ADDON_DIR).some((file) => file.endsWith('.node'));

describe('golden-trace corpus', () => {
  it('covers the behaviours the engine must keep byte-stable', () => {
    const covered = new Set(readCorpus().cases.filter((c) => c.tier === 'ci').flatMap((c) => c.covers));
    for (const behaviour of ['stop', 'u-turn', 'walker', 'ambient-heavy', 'static-map-colliders', 'eased-stop-at-route-end', 'template-compile', 'pinned-simulation-seed']) {
      expect(covered, behaviour).toContain(behaviour);
    }
  });

  it('has a manifest for every corpus case', () => {
    const manifest = readManifest();
    expect(manifest).not.toBeNull();
    const ciIds = readCorpus().cases.filter((c) => c.tier === 'ci').map((c) => c.id);
    for (const id of ciIds) expect(Object.keys(manifest!.cases)).toContain(id);
  });

  it.skipIf(!haveAddon)('reproduces every digest under the current ENGINE_SEM_VER', async () => {
    const tiers = process.env['SIMFORGE_GOLDEN_TIERS'] === 'all' ? (['ci', 'local'] as const) : (['ci'] as const);
    const run = await runCorpus({ tiers });
    expect(run.engineSemVer).toBe(engine().version().engineSemVer);
    const verdict = judge(run, readManifest());
    expect(verdict.messages).toEqual([]);
  }, 900_000);
});
