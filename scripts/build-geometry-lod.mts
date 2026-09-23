#!/usr/bin/env -S node --conditions=development --import tsx
/**
 * Map geometry derivatives (docs/engineering/map-geometry-lod.md).
 *
 *   pnpm maps:geometry-lod -- --master DIR [--out DIR]           build for one map master
 *   pnpm maps:geometry-lod -- --all [--maps-root ROOT]            every installed map (ROOT/<map>/master.gltf)
 *   pnpm maps:geometry-lod -- --master DIR --check                current / stale / missing
 *   pnpm maps:geometry-lod -- substitute --master DIR --trace native-trace.json --host ACTOR --out FILE
 *       [--lod-dir derived/geometry-lod] [--start 0] [--ticks 48] [--fpx 914.1] [--pixel-error 1]
 *       [--margin 12] [--force-level N] [--no-impostor] [--variant-master --source-master DIR]
 *
 * Build: writes `<master>/derived/geometry-lod/` (or --out). Images the
 * impostor baker needs are read from `<master>/images/<sha>.png`, or from
 * --images DIR (`<sha>.png`) when the install keeps only KTX2. Impostor
 * atlases are KTX2-encoded with the pinned KTX-Software (SIMFORGE_KTX_BIN_DIR)
 * unless --skip-ktx2.
 *
 * Substitute: writes a copy of master.gltf whose LOD'd instances point at the
 * level the selection rule picks for the host's positions over the ticks
 * (the image gate and render-bench render it through the unmodified renderer).
 *
 * stdout is one JSON document; exit 1 when the command could not run.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildGeometryLod, GEOMETRY_LOD_DIR, geometryLodBuildKey, geometryLodFingerprint, parseGeometryLodManifest, sha256, substituteLods,
} from '../packages/map-pipeline/src/index.ts';

// pnpm forwards its own `--` separator.
const argv = process.argv.slice(2).filter((argument, index) => !(index === 0 && argument === '--'));
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
};
const flag = (name: string): boolean => argv.includes(`--${name}`);
const fail = (code: string, reason: string, detail: Record<string, unknown> = {}): never => {
  process.stderr.write(`${JSON.stringify({ code, reason, detail })}\n`);
  process.exit(1);
};

async function substitute(): Promise<void> {
  const masterDir = path.resolve(option('master') ?? fail('usage', 'substitute needs --master'));
  const lodDir = option('lod-dir') ?? GEOMETRY_LOD_DIR;
  const tracePath = option('trace') ?? fail('usage', 'substitute needs --trace');
  const host = option('host') ?? fail('usage', 'substitute needs --host');
  const out = option('out') ?? fail('usage', 'substitute needs --out');
  const start = Number(option('start') ?? 0);
  const ticks = Number(option('ticks') ?? 48);
  const master = JSON.parse(await readFile(path.join(masterDir, 'master.gltf'), 'utf8'));
  const lod = JSON.parse(await readFile(path.join(masterDir, lodDir, 'lod.gltf'), 'utf8'));
  const manifest = parseGeometryLodManifest(JSON.parse(await readFile(path.join(masterDir, lodDir, 'manifest.json'), 'utf8')));
  if (manifest.source.master.sha256 !== sha256(await readFile(path.join(masterDir, 'master.gltf')))) {
    // A texture-tier variant of the same master (image URIs rewritten, e.g.
    // the 512 px BC7 closure) keeps every mesh, node and buffer: accepted with
    // --variant-master, which verifies exactly that.
    const source = option('source-master');
    if (!flag('variant-master') || !source) fail('geometry_lod_stale', 'the derivative was built from a different master.gltf (pass --variant-master --source-master DIR for a texture-tier variant)', { lodDir });
    const original = JSON.parse(await readFile(path.join(source!, 'master.gltf'), 'utf8'));
    if (manifest.source.master.sha256 !== sha256(await readFile(path.join(source!, 'master.gltf')))) fail('geometry_lod_stale', '--source-master is not the master the derivative was built from');
    for (const key of ['nodes', 'meshes', 'accessors', 'bufferViews', 'buffers', 'scenes', 'scene']) {
      if (JSON.stringify(original[key]) !== JSON.stringify(master[key])) fail('geometry_lod_stale', `variant master differs from the source master in ${key}`);
    }
  }
  const trace = JSON.parse(await readFile(tracePath, 'utf8')) as { frames: Array<{ actors: Array<{ id: string; transform?: { position: [number, number, number] } }> }> };
  const cameras = trace.frames.slice(start, start + ticks).flatMap((frame) => {
    const actor = frame.actors.find((candidate) => candidate.id === host);
    return actor?.transform ? [actor.transform.position] : [];
  });
  if (cameras.length === 0) fail('usage', `host ${host} has no positions in ticks ${start}..${start + ticks}`);
  const force = option('force-level');
  const { json, report } = substituteLods(master, lod, manifest, {
    cameras,
    marginM: Number(option('margin') ?? 12),
    fPx: Number(option('fpx') ?? 914.1),
    pixelErrorPx: Number(option('pixel-error') ?? manifest.thresholds.pixelErrorPx),
    lodPrefix: `${lodDir.replace(/\/$/, '')}/`,
    ...(force !== undefined ? { forceLevel: Number(force) } : {}),
    noImpostor: flag('no-impostor'),
  });
  await writeFile(out, JSON.stringify(json));
  process.stdout.write(`${JSON.stringify({ out, cameras: cameras.length, ...report }, null, 2)}\n`);
}

async function build(): Promise<void> {
  const defaultRoot = path.join(process.env.SIMFORGE_MAPS_CACHE_ROOT ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'maps'), '.corpus');
  const mapsRoot = path.resolve(option('maps-root') ?? defaultRoot);
  const masters = flag('all')
    ? (existsSync(mapsRoot) ? readdirSync(mapsRoot).sort().map((name) => path.join(mapsRoot, name)).filter((dir) => existsSync(path.join(dir, 'master.gltf'))) : [])
    : option('master') ? [path.resolve(option('master')!)] : [];
  if (masters.length === 0) fail('usage', 'pass --master DIR or --all', { mapsRoot });
  const images = option('images');
  const skipKtx2 = flag('skip-ktx2');
  const fingerprint = geometryLodFingerprint({}, {}, skipKtx2);
  const results: Array<Record<string, unknown>> = [];
  for (const masterDir of masters) {
    const outputDir = option('out') && masters.length === 1 ? path.resolve(option('out')!) : path.join(masterDir, ...GEOMETRY_LOD_DIR.split('/'));
    const masterSha256 = sha256(await readFile(path.join(masterDir, 'master.gltf')));
    const masterJson = JSON.parse(await readFile(path.join(masterDir, 'master.gltf'), 'utf8')) as { buffers?: Array<{ uri?: string }> };
    const bufferSha256s = await Promise.all((masterJson.buffers ?? []).map(async (buffer) => sha256(await readFile(path.join(masterDir, buffer.uri!)))));
    const expectedKey = geometryLodBuildKey({ masterSha256, bufferSha256s, fingerprint });
    let existing: string | null = null;
    try {
      existing = parseGeometryLodManifest(JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'))).buildKey;
    } catch {
      existing = null;
    }
    if (flag('check')) {
      results.push({ master: masterDir, status: existing === null ? 'missing' : existing === expectedKey ? 'current' : 'stale', buildKey: existing, expectedKey });
      continue;
    }
    const started = Date.now();
    const result = await buildGeometryLod({
      masterDir,
      outputDir,
      ...(images ? { readImage: async (uri: string) => {
        try {
          return new Uint8Array(await readFile(path.join(images, path.basename(uri))));
        } catch {
          return undefined;
        }
      } } : {}),
      skipKtx2,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    results.push({
      master: masterDir,
      status: 'built',
      outputDir,
      buildKey: result.manifest.buildKey,
      seconds: (Date.now() - started) / 1000,
      totals: result.manifest.totals,
      sensor: result.manifest.sensor.triangles,
      bytes: Object.values(result.files).reduce((sum, file) => sum + file.bytes, 0),
    });
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

try {
  if (argv[0] === 'substitute') await substitute();
  else await build();
} catch (error) {
  fail('geometry_lod_failed', error instanceof Error ? error.message : String(error));
}
