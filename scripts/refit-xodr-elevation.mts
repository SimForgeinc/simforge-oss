#!/usr/bin/env -S tsx --conditions=development
/**
 * Refit a map's OpenDRIVE road surface (elevation, superelevation,
 * laneHeight) to its rendered road mesh (docs/engineering/xodr-elevation-refit.md).
 *
 *   pnpm maps:refit-elevation -- --map richmond-field-station --out /tmp/refit
 *   pnpm maps:refit-elevation -- --all --out /tmp/refit
 *   pnpm maps:refit-elevation -- --map x --xodr other.xodr --master-dir DIR --out /tmp/refit
 *
 * A map directory holds `master.gltf` (+ buffers) and `map.xodr`. The mesh is
 * the ground derivative's surface, extracted from `master.gltf` with the same
 * code the ground stage uses (or read from `--ground-mesh ground-mesh.bin`).
 * The source files are only read. Per map, `<out>/<map>/` receives:
 *
 *   map.xodr              the corrected OpenDRIVE
 *   refit-report.json     before/after survey, continuity, structural diff, gates, per-road changes
 *   CHANGES.md            the same for people (roads changed, max correction, holes kept)
 *   survey-{before,after}.f64   per-sample rows [road, junction, lane, s, x, y, xodrZ, meshZ, topZ, driving]
 *
 * stdout is one JSON summary. Exit 2 when any map failed a gate (its
 * corrected file is still written, next to a failed report, for inspection;
 * nothing is published by this command), 1 when the command could not run.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { changesMarkdown, runRefit } from '../packages/map-pipeline/src/elevation-refit/index.js';
import { decodeGroundMesh, encodeGroundMesh, extractGroundSurface, GroundQuery, type GroundMesh } from '../packages/map-pipeline/src/ground/index.js';

const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
};
const flag = (name: string) => argv.includes(`--${name}`);
const fail = (code: string, reason: string, detail: unknown = {}) => {
  process.stderr.write(`${JSON.stringify({ code, reason, detail })}\n`);
  process.exit(1);
};

const defaultRoot = path.join(process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'maps'), '.corpus');
const mapsRoot = path.resolve(option('maps-root') ?? defaultRoot);
const installed = existsSync(mapsRoot) ? readdirSync(mapsRoot).filter((name) => existsSync(path.join(mapsRoot, name, 'master.gltf'))).sort() : [];
const requested = flag('all') ? installed : (option('map') ?? '').split(',').filter(Boolean);
const outRoot = option('out');
if (requested.length === 0) fail('usage', 'pass --map <id>[,<id>] or --all', { mapsRoot, installed });
if (!outRoot) fail('usage', 'pass --out <dir> (the corrected files are never written over the source)');
if (requested.length > 1 && (option('xodr') || option('master-dir') || option('ground-mesh'))) fail('usage', '--xodr/--master-dir/--ground-mesh apply to a single --map');

let gitSha: string | null = null;
try {
  gitSha = execFileSync('git', ['-C', path.dirname(new URL(import.meta.url).pathname), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', path.dirname(new URL(import.meta.url).pathname), 'status', '--porcelain', '--', 'packages/map-pipeline/src/elevation-refit', 'packages/map-pipeline/src/ground', 'scripts/refit-xodr-elevation.mts'], { encoding: 'utf8' }).trim();
  if (dirty) gitSha = `${gitSha}+dirty`;
} catch {
  gitSha = null;
}

const results: unknown[] = [];
let failed = false;
for (const mapId of requested) {
  const mapDir = path.join(mapsRoot, mapId);
  const masterDir = path.resolve(option('master-dir') ?? mapDir);
  const xodrPath = path.resolve(option('xodr') ?? path.join(mapDir, 'map.xodr'));
  if (!existsSync(xodrPath)) fail('missing-xodr', `no OpenDRIVE at ${xodrPath}`, { mapId });
  const started = Date.now();
  let mesh: GroundMesh;
  let meshSource: string;
  const meshPath = option('ground-mesh');
  if (meshPath) {
    mesh = decodeGroundMesh(new Uint8Array(await readFile(meshPath)));
    meshSource = path.resolve(meshPath);
  } else {
    if (!existsSync(path.join(masterDir, 'master.gltf'))) fail('missing-master', `no master.gltf in ${masterDir}; pass --master-dir or --ground-mesh`, { mapId });
    mesh = await extractGroundSurface(masterDir);
    meshSource = path.join(masterDir, 'master.gltf');
  }
  const meshSha = createHash('sha256').update(encodeGroundMesh(mesh)).digest('hex');
  const xodrText = await readFile(xodrPath, 'utf8');
  const { report, correctedText, before, after } = runRefit({
    mapId, xodrText, query: new GroundQuery(mesh), groundMesh: { sha256: meshSha, source: meshSource }, gitSha,
    log: (line) => process.stderr.write(`${mapId}: ${line}\n`),
  });
  const outDir = path.join(path.resolve(outRoot!), mapId);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'map.xodr'), correctedText);
  await writeFile(path.join(outDir, report.ok ? 'refit-report.json' : 'failed-refit-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  await writeFile(path.join(outDir, 'CHANGES.md'), changesMarkdown(report, { title: option('title') ?? mapId, sourceFile: option('source-name') ?? path.basename(xodrPath), correctedFile: option('corrected-name') ?? 'map.xodr' }));
  await writeFile(path.join(outDir, 'survey-before.f64'), Buffer.from(before.rows.buffer));
  await writeFile(path.join(outDir, 'survey-after.f64'), Buffer.from(after.rows.buffer));
  if (!report.ok) failed = true;
  results.push({
    mapId,
    ok: report.ok,
    seconds: Math.round((Date.now() - started) / 1000),
    outDir,
    source: report.source.xodrSha256,
    corrected: report.corrected.xodrSha256,
    drivable: { beforeP95: report.before.drivable.p95, beforeMax: report.before.drivable.max, afterP95: report.after.drivable.p95, afterMax: report.after.drivable.max },
    flaggedRoads: { before: report.before.flaggedRoads, after: report.after.flaggedRoads },
    roadsRefit: report.totals.roadsRefit,
    failedGates: report.gates.filter((g) => !g.ok).map((g) => g.name),
  });
}
process.stdout.write(`${JSON.stringify({ mapsRoot, results }, null, 2)}\n`);
process.exit(failed ? 2 : 0);
