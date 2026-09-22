/**
 * SUMO derivative smoke test (CI and map hosts).
 *
 *   pnpm maps:sumo:smoke                                 committed OpenDRIVE fixtures
 *   pnpm maps:sumo:smoke -- --maps representative        + installed representative maps
 *   pnpm maps:sumo:smoke -- --maps yale-street,garching-phase-1-2 --require-runtime
 *
 * Fixtures are built twice and must be byte-identical and pass every gate.
 * Installed maps (from the CLI dev-assets cache) are built into a temporary
 * directory, never in place. The headless gate runs whenever the pinned
 * browser runtime is found ($SIMFORGE_SUMO_RUNTIME_DIR, <maps-root>/sumo-runtime,
 * dev-assets/sumo-runtime); --require-runtime makes its absence fatal.
 * Exit 0 when everything passed, 2 when a build failed its gates, 1 when the
 * smoke could not run (no pinned toolchain).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildMapTopologyIndex, TOPOLOGY_CONTENT_EPOCH } from '@simforge-oss/maps/topology';
import { buildSumoDerivative, resolveSumoToolchain, SumoBuildError } from '../scripts/sumo-network.mjs';

const repository = path.resolve(import.meta.dirname, '..', '..', '..');
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
/** Coverage of the importer paths the gates guard: RoadRunner junction signals, German heads without dynamic flags, cubic lane offsets, a large city. */
const REPRESENTATIVE = ['richmond-field-station', 'yale-street', 'garching-phase-1-2', 'san-ramon-phase-2'];
const FIXTURES = [
  { mapId: 'signalized-4way', xodr: 'studio/app/lib/studio-shared/__tests__/fixtures/xodr/signalized-4way.xodr' },
];

const mapsRoot = path.resolve(option('maps-root') ?? process.env['SCEN_DEV_ASSETS'] ?? path.join(
  process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'maps'),
  'dev-assets',
));
const runtimeDir = [process.env['SIMFORGE_SUMO_RUNTIME_DIR'], path.join(mapsRoot, 'sumo-runtime'), path.join(repository, 'dev-assets', 'sumo-runtime')]
  .filter((candidate): candidate is string => Boolean(candidate))
  .find((candidate) => existsSync(path.join(candidate, 'sumo.wasm')));
if (argv.includes('--require-runtime') && !runtimeDir) {
  process.stderr.write(`${JSON.stringify({ code: 'sumo_runtime_missing', reason: 'the headless gate is required but no SUMO browser runtime was found' })}\n`);
  process.exit(1);
}
let toolchain;
try {
  toolchain = await resolveSumoToolchain({ repository });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: 'sumo_toolchain_missing', reason: (error as Error).message })}\n`);
  process.exit(1);
}

const mapsOption = option('maps');
const maps = mapsOption === undefined ? [] : mapsOption === 'representative' ? REPRESENTATIVE : mapsOption.split(',').filter(Boolean);
const work = await mkdtemp(path.join(os.tmpdir(), 'sumo-smoke-'));
const results: Array<Record<string, unknown>> = [];
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

try {
  for (const fixture of FIXTURES) {
    const xodrPath = path.join(repository, fixture.xodr);
    const xodr = await readFile(xodrPath);
    const topology = buildMapTopologyIndex({
      mapName: fixture.mapId, xodr: xodr.toString('utf8').replace(/>\s*</g, '>\n<'), xodrSha256: sha256(xodr), now: () => TOPOLOGY_CONTENT_EPOCH,
    });
    const topologyPath = path.join(work, `${fixture.mapId}.topology-index.json.gz`);
    await writeFile(topologyPath, gzipSync(JSON.stringify(topology)));
    results.push(await attempt(fixture.mapId, 'fixture', async () => {
      const builds = [];
      for (const copy of ['a', 'b']) {
        builds.push(await buildSumoDerivative({
          xodrPath, topologyPath, mapId: fixture.mapId, outputDir: path.join(work, fixture.mapId, copy), toolchain,
          ...(runtimeDir ? { runtimeDir } : {}), simulate: Boolean(runtimeDir),
        }));
      }
      if (JSON.stringify(builds[0]!.files) !== JSON.stringify(builds[1]!.files)) throw new Error('two builds of the same inputs produced different bytes');
      return builds[0]!;
    }));
  }
  for (const mapId of maps) {
    const xodrPath = path.join(mapsRoot, mapId, 'map.xodr');
    const topologyPath = path.join(mapsRoot, mapId, 'topology-index.json.gz');
    if (!existsSync(xodrPath) || !existsSync(topologyPath)) {
      results.push({ mapId, kind: 'map', status: 'skipped', reason: `not installed under ${mapsRoot} (simforge maps pull ${mapId}@<version>)` });
      continue;
    }
    results.push(await attempt(mapId, 'map', () => buildSumoDerivative({
      xodrPath, topologyPath, mapId, outputDir: path.join(work, mapId), toolchain,
      ...(runtimeDir ? { runtimeDir } : {}), simulate: Boolean(runtimeDir),
    })));
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

async function attempt(mapId: string, kind: string, build: () => ReturnType<typeof buildSumoDerivative>) {
  const started = Date.now();
  try {
    const built = await build();
    const report = built.report as Record<string, any>;
    return {
      mapId, kind, status: 'passed', seconds: (Date.now() - started) / 1000, buildKey: built.buildKey,
      networkSha256: built.manifest.sha256, trafficLights: built.manifest.trafficLights, routes: built.manifest.routeCandidates.length,
      laneOffsetP95M: report.alignment?.normal?.p95M, vehicleOffsetP95M: report.simulation?.vehicleOffset?.p95M ?? null,
      simulated: Boolean(report.simulation && !report.simulation.skipped), warnings: built.report.warnings.length,
    };
  } catch (error) {
    if (!(error instanceof SumoBuildError) && !(error instanceof Error)) throw error;
    return { mapId, kind, status: 'failed', seconds: (Date.now() - started) / 1000, code: (error as SumoBuildError).code ?? 'error', reason: error.message };
  }
}

process.stdout.write(`${JSON.stringify({ schema: 'simforge.sumo-smoke.v1', toolchain: toolchain.version, runtimeDir: runtimeDir ?? null, results }, null, 2)}\n`);
process.exit(results.some((result) => result.status === 'failed') ? 2 : 0);
