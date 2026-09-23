/**
 * Workers persist the ambient generator's turn verdicts per map closure and
 * engine semantics, so the probes run once per closure, not once per process.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ambientTurnVerdictCount, parseSimScenarioInput, resolveAmbientTrafficProfile, type AmbientTurnVerdictTable } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';
import {
  ambientTurnVerdictCachePath,
  createSimulationMapBundle,
  persistAmbientTurnVerdictsToDisk,
  readInstalledMapClosureFiles,
} from '@simforge-oss/compiler/node';

import { GOLDEN_ROOT } from '../determinism/golden-traces.js';

const ADDON_DIR = path.join(GOLDEN_ROOT, '..', '..', 'packages', 'native-runtime', 'native');
const haveAddon = existsSync(ADDON_DIR) && readdirSync(ADDON_DIR).some((file) => file.endsWith('.node'));
const root = mkdtempSync(path.join(tmpdir(), 'simforge-turn-cache-'));
process.env['SIMFORGE_AMBIENT_TURN_CACHE'] = root;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!haveAddon)('ambient turn-verdict disk cache', () => {
  it('writes the verdicts under closureDigest and engineSemVer, and they reload in any process', async () => {
    const mapId = 'richmond-field-station';
    const bundle = await createSimulationMapBundle(await readInstalledMapClosureFiles(path.join(GOLDEN_ROOT, 'maps', mapId), mapId));
    const file = ambientTurnVerdictCachePath(bundle);
    expect(file).toBe(path.join(root, engine().version().engineSemVer, `${bundle.closureDigest}.json`));

    const base = parseSimScenarioInput({
      mapId, clipSeconds: 4, warmupSeconds: 0, dt: 0.02, seed: 'turn-cache',
      actors: [{ id: 'ambient-world-seed', kind: 'static_object', static: true, initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 }, behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } }, tags: ['ambient:internal-clock'] }],
      physics: { mode: 'dynamic-v1' },
    });
    engine().materializeAmbientTraffic(base, bundle.graph, resolveAmbientTrafficProfile({ version: 1, preset: 'city', seed: 'ambient-1' }));
    await persistAmbientTurnVerdictsToDisk(bundle);
    const table = JSON.parse(readFileSync(file, 'utf8')) as AmbientTurnVerdictTable;
    expect(table.schema).toBe('simforge.ambient-turn-verdicts/v1');
    expect(table.engineSemVer).toBe(engine().version().engineSemVer);
    expect(table.verdicts.length).toBeGreaterThan(0);
    expect(engine().loadAmbientTurnVerdicts(readFileSync(file, 'utf8'))).toBe(ambientTurnVerdictCount(table));
  }, 120_000);
});
