/**
 * The published ambient turn-verdict table (`derived/ambient/turn-verdicts.json.gz`):
 * built once per (closureDigest, ENGINE_SEM_VER) at map publish, shipped in the
 * closure, loaded by every simulating host instead of probing.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ambientTurnVerdictCount } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';
import {
  ambientTurnVerdictStatus,
  buildAmbientTurnVerdictArtifact,
  createAmbientTurnVerdictBuilder,
  createSimulationMapBundle,
  readInstalledMapClosureFiles,
} from '@simforge-oss/compiler/node';
import { AMBIENT_TURN_VERDICTS_PATH } from '@simforge-oss/playback';

import { GOLDEN_ROOT } from '../determinism/golden-traces.js';

const ADDON_DIR = path.join(GOLDEN_ROOT, '..', '..', 'packages', 'native-runtime', 'native');
const haveAddon = existsSync(ADDON_DIR) && readdirSync(ADDON_DIR).some((file) => file.endsWith('.node'));
const MAP = 'richmond-field-station';
const scratch = mkdtempSync(path.join(tmpdir(), 'simforge-verdict-artifact-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(!haveAddon)('published ambient turn-verdict table', () => {
  it('is built for this closure and engine, deterministic, and read back from the closure', async () => {
    const dir = path.join(scratch, MAP);
    cpSync(path.join(GOLDEN_ROOT, 'maps', MAP), dir, { recursive: true });
    const bundle = await createSimulationMapBundle(await readInstalledMapClosureFiles(dir, MAP));
    expect(ambientTurnVerdictStatus(bundle, null)).toBe('missing');

    const first = buildAmbientTurnVerdictArtifact(bundle);
    const second = buildAmbientTurnVerdictArtifact(bundle);
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    expect(first.table.engineSemVer).toBe(engine().version().engineSemVer);
    expect(first.table.closureDigest).toBe(bundle.closureDigest);
    expect(first.table.classes).toContain('truck');
    expect(ambientTurnVerdictCount(first.table)).toBeGreaterThan(first.table.verdicts.length);
    expect(ambientTurnVerdictStatus(bundle, first.bytes)).toBe('current');

    // Another engine's table is stale and never loaded.
    const foreign = new TextEncoder().encode(JSON.stringify({ ...first.table, engineSemVer: '0.0.1' }));
    expect(ambientTurnVerdictStatus(bundle, foreign)).toBe('stale');

    // Shipped in the closure: the reader returns it and the builder loads it.
    const target = path.join(dir, ...AMBIENT_TURN_VERDICTS_PATH.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, first.bytes);
    const files = await readInstalledMapClosureFiles(dir, MAP);
    expect(files.ambientTurnVerdicts).toBeTruthy();
    const shipped = await createSimulationMapBundle(files);
    expect(shipped.closureDigest).toBe(bundle.closureDigest);
  }, 300_000);

  it('the map-pipeline producer builds the same table from split master / web-runtime directories', async () => {
    const master = path.join(scratch, 'master');
    const runtime = path.join(scratch, 'runtime');
    cpSync(path.join(GOLDEN_ROOT, 'maps', MAP), master, { recursive: true });
    rmSync(path.join(master, '3d'), { recursive: true, force: true });
    cpSync(path.join(GOLDEN_ROOT, 'maps', MAP, '3d'), path.join(runtime, '3d'), { recursive: true });
    const producer = createAmbientTurnVerdictBuilder();
    expect(producer.fingerprint).toBe(`simforge.ambient-turn-verdicts/v1:${engine().version().engineSemVer}`);
    const bytes = await producer.build({ mapId: MAP, masterDir: master, runtimeDir: runtime });
    const reference = buildAmbientTurnVerdictArtifact(
      await createSimulationMapBundle(await readInstalledMapClosureFiles(path.join(GOLDEN_ROOT, 'maps', MAP), MAP)),
    );
    expect(Buffer.from(bytes).equals(Buffer.from(reference.bytes))).toBe(true);
  }, 300_000);
});
