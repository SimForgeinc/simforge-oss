// Rebuild a map's web closure (with vegetation LOD cells, per-GPU tiers and
// browser packs) into a private directory, from the installed corpus master
// plus the geometry-lod derivative. Mirrors webStage for local measurement.
import { mkdir, readdir, symlink, cp, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { buildWebTier } from './src/web-tier.ts';
import { vegetationLodLevels } from './src/index.ts';
import { buildTextureTiers } from './scripts/texture-tiers.mjs';
import { buildBrowserPacks } from './scripts/browser-packs.mjs';

const [map, out] = process.argv.slice(2);
const corpus = `${process.env.HOME}/.local/share/simforge/maps/.corpus/${map}`;
const lod = `/tmp/claude-1000/-home-path/bb0d75f9-19c6-4010-a03b-2bb79dd806bc/scratchpad/map-lod/out/${map}`;
const masterDir = path.join(out, '.master');
await rm(out, { recursive: true, force: true });
await mkdir(path.join(masterDir, 'derived'), { recursive: true });
for (const name of ['master.gltf', 'geometry.bin', 'images']) await symlink(path.join(corpus, name), path.join(masterDir, name));
await symlink(lod, path.join(masterDir, 'derived', 'geometry-lod'));
const started = Date.now();
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const { readFile } = await import('node:fs/promises');
const json = JSON.parse(await readFile(path.join(masterDir, 'master.gltf'), 'utf8'));
const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
for (const b of json.buffers) resources[b.uri] = new Uint8Array(await readFile(path.join(masterDir, b.uri)));
for (const i of json.images ?? []) if (i.uri) resources[i.uri] = new Uint8Array(0);
const document = await io.readJSON({ json, resources });
console.log('read master', (Date.now() - started) / 1000);
const levels = await vegetationLodLevels(io, masterDir, out);
const report = await buildWebTier(document, out, { cellSize: 100, ...(levels ? { vegetationLevels: levels } : {}) });
console.log('web tier', JSON.stringify(report), (Date.now() - started) / 1000);
await mkdir(path.join(out, '3d', 'env'), { recursive: true });
await cp(path.join(corpus, 'env', 'sky.hdr'), path.join(out, '3d', 'env', 'sky.hdr'));
await mkdir(path.join(out, 'images'), { recursive: true });
for (const file of await readdir(path.join(corpus, 'images'))) {
  if (file.endsWith('.ktx2')) await link(path.join(corpus, 'images', file), path.join(out, 'images', file)).catch((error) => { if (error.code !== 'EEXIST') throw error; });
}
await rm(masterDir, { recursive: true, force: true });
const tiers = await buildTextureTiers({ sourceRoot: out, concurrency: 8 });
console.log('tiers', tiers.wallSeconds);
const packs = await buildBrowserPacks({ sourceRoot: out });
console.log('packs', JSON.stringify(packs.packs['textures-512-bc7']), packs.wallSeconds);
