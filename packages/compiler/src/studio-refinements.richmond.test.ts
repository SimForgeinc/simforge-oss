/**
 * Identity lock for the Studio refinements on a real map: Richmond map-bound
 * documents with authored paint in several spellings, baked parked cars and
 * native ambient traffic resolve to exactly the digests the TypeScript
 * refinements produced before they moved to native. Needs the Richmond map
 * with its colliders (`SIMFORGE_SIM_TEST_MAP_DIR` or the dev assets).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { engine } from '@simforge-oss/engine/node';

import { richmondStudioVariants } from './__fixtures__/richmond-studio-variants';
import { DEV_ASSETS, readInstalledMapClosureFiles } from './maps.js';
import { simulateAuthoritative, simulationMapClosureFromFiles } from './simulation.js';

const mapDir = path.resolve(process.env['SIMFORGE_SIM_TEST_MAP_DIR'] ?? path.join(DEV_ASSETS, 'richmond-field-station'));
const available = existsSync(path.join(mapDir, '3d', 'variants', 'static-colliders-v1.json'));
const locked = JSON.parse(readFileSync(new URL('./__fixtures__/richmond-studio-variants.digests.json', import.meta.url), 'utf8')) as {
  engineSemVer: string;
  cases: Record<string, { resolvedInputDigest: string; traceSha256: string; simKey: string; actors: number }>;
};

describe.skipIf(!available || engine().version().engineSemVer !== locked.engineSemVer)('Studio refinements on Richmond', () => {
  it('reproduce the locked digests for paint, parked cars and native ambient', async () => {
    const closure = await simulationMapClosureFromFiles(await readInstalledMapClosureFiles(mapDir, 'richmond-field-station'), {
      mapVersionId: 'v', mapAssetId: 'richmond-field-station', browserClosureSha256: 'f'.repeat(64),
    });
    for (const [name, document] of Object.entries(richmondStudioVariants())) {
      const simulation = simulateAuthoritative({ canonicalContent: document, closure });
      expect({
        resolvedInputDigest: simulation.resolvedInputDigest,
        traceSha256: simulation.traceSha256,
        simKey: simulation.simKey,
        actors: simulation.trace.header.actorIds.length,
      }, name).toEqual(locked.cases[name]);
    }
  }, 240_000);
});
