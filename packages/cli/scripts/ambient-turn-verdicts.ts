/**
 * Build (or check) the ambient turn-verdict table of installed maps.
 *
 *   pnpm maps:ambient-verdicts -- --map yale-street      build one map in place
 *   pnpm maps:ambient-verdicts -- --all                  every installed map
 *   pnpm maps:ambient-verdicts -- --all --check          report current/stale/missing only
 *
 * The table (`derived/ambient/turn-verdicts.json.gz`) is keyed by the map's
 * simulation `closureDigest` and `ENGINE_SEM_VER`; `stale` means it was built
 * for another closure or engine and is ignored by every host. Maps are read
 * from `--maps-root` (default: the CLI's dev-assets cache). stdout is one JSON
 * document; exit 2 when a map could not be built, 1 when the command could not
 * run.
 */

import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ambientTurnVerdictCount } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';
import {
  AMBIENT_TURN_VERDICTS_PATH,
} from '@simforge-oss/playback';
import {
  ambientTurnVerdictStatus,
  buildAmbientTurnVerdictArtifact,
  createSimulationMapBundle,
  DEV_ASSETS,
  readInstalledMapClosureFiles,
} from '@simforge-oss/compiler/node';

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
};
const mapsRoot = path.resolve(option('maps-root') ?? DEV_ASSETS);
const check = argv.includes('--check');
const installed = existsSync(mapsRoot)
  ? readdirSync(mapsRoot).filter((name) => existsSync(path.join(mapsRoot, name, '3d', 'variants', 'manifest.json'))).sort()
  : [];
const requested = argv.includes('--all') ? installed : (option('map') ?? '').split(',').filter(Boolean);
if (requested.length === 0) {
  process.stderr.write(`${JSON.stringify({ code: 'usage', reason: 'pass --map <id>[,<id>] or --all', detail: { mapsRoot, installed } })}\n`);
  process.exit(1);
}

const results: Array<Record<string, unknown>> = [];
for (const mapId of requested) {
  const dir = path.join(mapsRoot, mapId);
  const target = path.join(dir, ...AMBIENT_TURN_VERDICTS_PATH.split('/'));
  try {
    const bundle = await createSimulationMapBundle(await readInstalledMapClosureFiles(dir, mapId));
    const existing = existsSync(target) ? new Uint8Array(await readFile(target)) : null;
    const status = ambientTurnVerdictStatus(bundle, existing);
    if (check || status === 'current') {
      results.push({ mapId, status, closureDigest: bundle.closureDigest });
      continue;
    }
    const started = performance.now();
    const { bytes, table } = buildAmbientTurnVerdictArtifact(bundle);
    // Gate: the table reloads whole and describes this closure under this engine.
    if (engine().loadAmbientTurnVerdicts(JSON.stringify(table)) !== ambientTurnVerdictCount(table)
      || ambientTurnVerdictStatus(bundle, bytes) !== 'current') {
      throw new Error('built table does not reload as current');
    }
    await mkdir(path.dirname(target), { recursive: true });
    // Installed files are often hardlinks shared between map roots: never write in place.
    await writeFile(`${target}.tmp`, bytes);
    await rename(`${target}.tmp`, target);
    results.push({ mapId, status: 'built', previous: status, closureDigest: bundle.closureDigest, transitions: table.verdicts.length, verdicts: ambientTurnVerdictCount(table), bytes: bytes.byteLength, seconds: Number(((performance.now() - started) / 1000).toFixed(2)) });
  } catch (error) {
    results.push({ mapId, status: 'error', reason: error instanceof Error ? error.message : String(error) });
  }
}
process.stdout.write(`${JSON.stringify({ engineSemVer: engine().version().engineSemVer, mapsRoot, results }, null, 2)}\n`);
process.exitCode = results.some((result) => result.status === 'error') ? 2 : 0;
