#!/usr/bin/env -S tsx --conditions=development
/**
 * Build (or check) the ground derivative (`derived/ground/*`) of installed maps.
 *
 *   pnpm maps:ground -- --map richmond-field-station   build one map in place
 *   pnpm maps:ground -- --all                          every installed map
 *   pnpm maps:ground -- --all --check                  report current/stale/missing only
 *   pnpm maps:ground -- --map x --out /tmp/ground      write elsewhere
 *
 * A map directory holds `master.gltf` (+ buffers) and `map.xodr` (the
 * canonical map closure layout). stdout is one JSON document: per map the
 * status (`ok` | `xodr-disagrees` | `no-xodr`), coverage, the OpenDRIVE
 * disagreement summary and the worst roads. Exit 2 when any map failed its
 * gates, 1 when the command could not run.
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildGroundDerivative, GROUND_DERIVED_DIR, GroundBuildError, inspectGroundDerivative } from '../packages/map-pipeline/src/ground/index.js';

const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
};
const flag = (name: string) => argv.includes(`--${name}`);
const defaultRoot = path.join(process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'maps'), '.corpus');
const mapsRoot = path.resolve(option('maps-root') ?? defaultRoot);
const installed = existsSync(mapsRoot) ? readdirSync(mapsRoot).filter((name) => existsSync(path.join(mapsRoot, name, 'master.gltf'))).sort() : [];
const requested = flag('all') ? installed : (option('map') ?? '').split(',').filter(Boolean);
if (requested.length === 0) {
  process.stderr.write(`${JSON.stringify({ code: 'usage', reason: 'pass --map <id>[,<id>] or --all', detail: { mapsRoot, installed } })}\n`);
  process.exit(1);
}
const outRoot = option('out');
const results: unknown[] = [];
let failed = false;
for (const mapId of requested) {
  const masterDir = path.join(mapsRoot, mapId);
  const xodrPath = existsSync(path.join(masterDir, 'map.xodr')) ? path.join(masterDir, 'map.xodr') : undefined;
  const outputDir = outRoot ? path.join(path.resolve(outRoot), mapId) : path.join(masterDir, ...GROUND_DERIVED_DIR.split('/'));
  const options = { masterDir, ...(xodrPath ? { xodrPath } : {}), mapId, outputDir };
  if (flag('check')) {
    const state = await inspectGroundDerivative(options);
    results.push({ mapId, state: state.state, buildKey: state.manifest?.buildKey ?? null, expectedKey: state.expectedKey });
    continue;
  }
  try {
    const { manifest, report } = await buildGroundDerivative(options);
    const v = report.validation;
    results.push({
      mapId,
      status: manifest.status,
      outputDir,
      mesh: { triangles: manifest.mesh.triangles, bytes: manifest.mesh.bytes, sha256: manifest.mesh.sha256 },
      coverage: v ? { drivable: v.drivableCoverage, driving: v.drivingCoverage, holes: v.holes.count } : null,
      dzAbsM: v?.dzAbsM ?? null,
      flaggedRoads: v?.flaggedRoads.length ?? 0,
      worst: v?.flaggedRoads.slice(0, 5).map((road) => ({ road: road.road, junction: road.junction, maxAbsM: road.maxAbsM, worst: road.worst })) ?? [],
      warnings: manifest.warnings,
    });
  } catch (error) {
    if (!(error instanceof GroundBuildError)) throw error;
    failed = true;
    results.push({ mapId, status: 'failed', reason: error.message });
  }
}
process.stdout.write(`${JSON.stringify({ mapsRoot, results }, null, 2)}\n`);
process.exit(failed ? 2 : 0);
