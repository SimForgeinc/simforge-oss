#!/usr/bin/env node
/**
 * Build (or check) the SUMO derivative of installed maps.
 *
 *   pnpm maps:sumo -- --map yale-street            build one map in place
 *   pnpm maps:sumo -- --all                         every installed map
 *   pnpm maps:sumo -- --all --check                 report current/stale/missing only
 *   pnpm maps:sumo -- --map x --out /tmp/sumo       write elsewhere
 *
 * Maps are read from `<maps-root>/<map>/{map.xodr,topology-index.json.gz}`
 * (default: the CLI's dev-assets cache). The headless gate runs on the pinned
 * browser runtime found at --runtime-dir, $SIMFORGE_SUMO_RUNTIME_DIR, or
 * `<maps-root>/sumo-runtime`. stdout is one JSON document; exit 2 when any map
 * failed its gates, 1 when the command could not run.
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSumoDerivative, inspectSumoDerivative, resolveSumoToolchain, SumoBuildError, SUMO_DERIVED_DIR,
} from '../packages/map-pipeline/scripts/sumo-network.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
};
const flag = (name) => argv.includes(`--${name}`);

const defaultMapsRoot = path.join(
  process.env.SIMFORGE_MAPS_CACHE_ROOT ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'maps'),
  'dev-assets',
);
const mapsRoot = path.resolve(option('maps-root') ?? process.env.SCEN_DEV_ASSETS ?? defaultMapsRoot);
const runtimeDir = [option('runtime-dir'), process.env.SIMFORGE_SUMO_RUNTIME_DIR, path.join(mapsRoot, 'sumo-runtime'), path.join(repository, 'dev-assets', 'sumo-runtime')]
  .filter(Boolean).map((candidate) => path.resolve(candidate)).find((candidate) => existsSync(path.join(candidate, 'sumo.wasm')));
const simulate = !flag('no-simulate');
const check = flag('check');
const outRoot = option('out');

const installed = existsSync(mapsRoot)
  ? readdirSync(mapsRoot).filter((name) => existsSync(path.join(mapsRoot, name, 'map.xodr'))).sort()
  : [];
const requested = flag('all') ? installed : (option('map') ?? '').split(',').filter(Boolean);
if (requested.length === 0) {
  process.stderr.write(`${JSON.stringify({ code: 'usage', reason: 'pass --map <id>[,<id>] or --all', detail: { mapsRoot, installed } })}\n`);
  process.exit(1);
}
if (simulate && !check && !runtimeDir) {
  process.stderr.write(`${JSON.stringify({ code: 'sumo_runtime_missing', reason: 'no SUMO browser runtime found for the headless gate; pass --runtime-dir or --no-simulate', detail: { mapsRoot } })}\n`);
  process.exit(1);
}

let toolchain = null;
if (!check) {
  try {
    toolchain = await resolveSumoToolchain({ repository });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code ?? 'sumo_toolchain_missing', reason: error.message })}\n`);
    process.exit(1);
  }
}

const results = [];
for (const mapId of requested) {
  const mapRoot = path.join(mapsRoot, mapId);
  const xodrPath = path.join(mapRoot, 'map.xodr');
  const topologyPath = path.join(mapRoot, 'topology-index.json.gz');
  const outputDir = outRoot ? path.join(path.resolve(outRoot), mapId) : path.join(mapRoot, ...SUMO_DERIVED_DIR.split('/'));
  if (!existsSync(xodrPath) || !existsSync(topologyPath)) {
    results.push({ mapId, status: 'error', reason: 'map.xodr or topology-index.json.gz is not installed', mapRoot });
    continue;
  }
  const before = await inspectSumoDerivative({ outputDir, xodrPath, mapId });
  if (check) {
    results.push({ mapId, status: before.state, buildKey: before.manifest?.buildKey ?? null, expectedKey: before.expectedKey });
    continue;
  }
  if (before.state === 'current' && !flag('force')) {
    results.push({ mapId, status: 'current', buildKey: before.expectedKey, outputDir });
    continue;
  }
  const started = Date.now();
  try {
    const built = await buildSumoDerivative({ xodrPath, topologyPath, mapId, outputDir, toolchain, runtimeDir, simulate, writeFailedReport: true });
    results.push({ mapId, status: 'built', previous: before.state, buildKey: built.buildKey, seconds: (Date.now() - started) / 1000, outputDir, files: built.files, summary: summarize(built.report) });
  } catch (error) {
    if (!(error instanceof SumoBuildError)) throw error;
    results.push({ mapId, status: 'failed', previous: before.state, code: error.code, reason: error.message, seconds: (Date.now() - started) / 1000, summary: error.report ? summarize(error.report) : null });
  }
  process.stderr.write(`${mapId}: ${results.at(-1).status}${results.at(-1).reason ? ` (${results.at(-1).reason})` : ''}\n`);
}

function summarize(report) {
  return {
    netconvertWarnings: report.netconvert?.warningCount ?? null,
    unsetTrafficLights: report.netconvert?.unsetTrafficLights ?? [],
    registration: report.registration ? { registered: report.registration.registered, lanes: report.registration.lanes, maxShiftM: report.registration.maxShiftM } : null,
    laneOffsetP95M: report.alignment?.normal?.p95M ?? null,
    laneOffsetMaxM: report.alignment?.normal?.maxM ?? null,
    laneCoverage: report.alignment?.coverage?.share ?? null,
    trafficLights: report.signals ? `${report.signals.sumoTrafficLights} (heads ${report.signals.boundHeads}/${report.signals.openDriveHeads}, unbound links ${report.signals.unboundLinks})` : null,
    routes: report.demand?.routeCandidates ?? null,
    simulation: report.simulation && !report.simulation.skipped
      ? { departed: report.simulation.departed, movingShare: report.simulation.movingShare, vehicleOffsetP95M: report.simulation.vehicleOffset?.p95M, teleports: report.simulation.teleports, cyclingTrafficLights: report.simulation.cyclingTrafficLights }
      : report.simulation ?? null,
    failures: report.failures.map((failure) => `${failure.gate}: ${failure.reason}`),
    warnings: (report.warnings ?? []).map((warning) => `${warning.gate}: ${warning.reason}`),
  };
}

const output = { schema: 'simforge.sumo-derivative-run.v1', mapsRoot, runtimeDir: runtimeDir ?? null, toolchain, results };
process.stdout.write(`${JSON.stringify(output, null, flag('pretty') ? 2 : 0)}\n`);
process.exit(results.some((result) => result.status === 'failed' || result.status === 'error') ? 2 : 0);
