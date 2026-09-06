#!/usr/bin/env node
// Prepare only: consume canonical sensor-corpus + atlas + renderer lighting products.
// Never decode assets, launch Blender, or inherit actors from the lighting manifest.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const AUTHORED_MAP_IDS = Object.freeze([
  'yale-street', 'belmont-research-center', 'el-camino-road', 'easterbrook-discovery-school',
]);
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function pin(file, expected) {
  const canonical = await realpath(file);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(canonical)) { hash.update(chunk); bytes += chunk.length; }
  const sha256 = hash.digest('hex');
  if (expected && (sha256 !== expected.sha256 || bytes !== expected.bytes)) {
    throw new Error(`Published corpus pin mismatch: ${canonical}`);
  }
  return { path: canonical, bytes, sha256 };
}

/**
 * Writes manifest.json and preparation.json into a NEW output directory.
 * corpusRoot is the parent of <mapId>/manifest.json, normally .corpus.
 * lightingManifest supplies only the named case's lighting, never scene content.
 * atlasRoot supplies published sites.json; siteId is optional and deterministic.
 * All source bytes are checked against corpus pins before any output is created.
 */
export async function prepareMapWorkbench({
  mapId, out, corpusRoot = path.join(REPO, '.corpus'),
  atlasRoot = path.join(REPO, 'experiments/agentic-3d/atlas'),
  lightingManifest, lightingCase = 'daylight', siteId, lod = 2,
}) {
  if (!AUTHORED_MAP_IDS.includes(mapId)) throw new Error(`Unsupported authored map: ${mapId}`);
  if (!out || !lightingManifest) throw new Error('Explicit out and lightingManifest are required');
  if (!Number.isInteger(lod) || lod < 0 || lod > 3) throw new Error('lod must be 0, 1, 2 or 3');
  const mapRoot = await realpath(path.join(corpusRoot, mapId));
  const atlasPath = await realpath(path.join(atlasRoot, mapId, 'sites.json'));
  const lightPath = await realpath(lightingManifest);
  const corpusPath = path.join(mapRoot, 'manifest.json');
  const corpus = await json(corpusPath);
  if (corpus.schema !== 'sensor-corpus.v1' || corpus.mapId !== mapId) throw new Error('Corpus map/schema mismatch');
  const entries = new Map();
  for (const entry of corpus.files) {
    if (entries.has(entry.path)) throw new Error(`Duplicate corpus identity: ${entry.path}`);
    entries.set(entry.path, entry);
  }
  const pinned = new Map();
  async function source(relative) {
    const entry = entries.get(relative);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Missing published source pin: ${relative}`);
    const file = await realpath(path.resolve(mapRoot, relative));
    if (!inside(mapRoot, file)) throw new Error(`Source escapes corpus: ${relative}`);
    if (!pinned.has(file)) pinned.set(file, { ...await pin(file, entry), corpusPath: relative,
      originalPath: entry.srcPath, originalSha256: entry.srcSha256 });
    return file;
  }
  const scenePath = await source('scene-manifest.json');
  const scene = await json(scenePath);
  if (scene.scene?.coordinateSystem !== 'y-up') throw new Error('Expected published Y-up map geometry');
  const roads = (scene.staticLayers ?? []).filter(layer => layer.id === 'road' && layer.file);
  if (roads.length !== 1) throw new Error('Published map must identify exactly one road asset');
  const road = await source(roads[0].file);
  const staticGlbs = [road];
  const vegGlbs = [];
  async function tileSource(tile) {
    const levels = (tile.lods ?? []).filter(level => level.level === lod);
    if (levels.length !== 1) throw new Error(`Missing/ambiguous LOD ${lod}: ${tile.id}`);
    return source(levels[0].file);
  }
  for (const layer of [...scene.staticLayers].sort((a, b) => compare(a.id, b.id))) {
    if (layer === roads[0]) continue;
    staticGlbs.push(await source(layer.file));
  }
  for (const tile of [...scene.tiles].sort((a, b) => compare(a.id, b.id))) {
    staticGlbs.push(tile.file ? await source(tile.file) : await tileSource(tile));
  }
  if (!Array.isArray(scene.vegetationTiles) || !scene.vegetationTiles.length) throw new Error('Missing published vegetation layer');
  for (const tile of [...scene.vegetationTiles].sort((a, b) => compare(a.id, b.id))) {
    const file = await tileSource(tile);
    const sidecar = await source(tile.instanceFile);
    if (sidecar !== file.replace(/\.lod\d+\.glb$/, '.instances.json')) {
      throw new Error(`Vegetation sidecar does not match renderer naming contract: ${tile.id}`);
    }
    vegGlbs.push(file);
  }
  if (new Set([...staticGlbs, ...vegGlbs]).size !== staticGlbs.length + vegGlbs.length) throw new Error('Ambiguous repeated asset identities');

  const atlas = await json(atlasPath);
  if (atlas.mapId !== mapId) throw new Error('Atlas map mismatch');
  // No nearby-cell elevation fallback: select a directly observed road-mesh site.
  const eligible = atlas.sites.filter(site => site.meshRingR === 0 && Number.isFinite(site.meshY)
    && ['x', 'z', 'headingRad'].every(key => Number.isFinite(site.pose?.[key])));
  const site = siteId ? eligible.find(site => site.siteId === siteId) : eligible[0];
  if (!site) throw new Error('No directly grounded atlas site matches the requested diagnostic camera');
  const { x, z, headingRad } = site.pose;
  const target = [x, site.meshY, z];
  // A map-only overhead oblique diagnostic, not an ego pose or a scenario recipe.
  const camera = { sensorId: 'front', eye: [x - 18 * Math.cos(headingRad), site.meshY + 35,
    z + 18 * Math.sin(headingRad)], target, fovDeg: 58, near: 0.1, far: 10000, grounding: 'source-map' };
  const lights = await json(lightPath);
  if (lights.schema !== 'simforge.renderer-bakeoff/v1') throw new Error('Expected canonical renderer-bakeoff lighting manifest');
  const lightCases = lights.cases.filter(item => item.id === lightingCase);
  if (lightCases.length !== 1) throw new Error('Missing/ambiguous lighting case');
  const lighting = structuredClone(lightCases[0].lighting);
  if (!lighting?.hdriPath) throw new Error('Real source HDRI required; no primitive lighting fallback');
  const hdri = await pin(path.resolve(path.dirname(lightPath), lighting.hdriPath));
  lighting.hdriPath = hdri.path;
  const metadata = await Promise.all([corpusPath, atlasPath, lightPath].map(file => pin(file)));
  const manifest = {
    schema: 'simforge.renderer-bakeoff/v1', width: 1280, height: 720, fps: 12,
    frameCount: 1, warmupFrames: 0, repeats: 1, persistentData: true,
    cases: [{ id: 'map-only', name: `${mapId} immutable map workbench`, mapId,
      staticGlbs, vegGlbs, sourceGroundSources: [road], lighting, actors: [],
      frames: [{ frameIndex: 0, timeS: 0, actors: [], cameras: [camera] }] }],
  };
  const preparation = {
    schema: 'simforge.blender-map-workbench-preparation/v1', mapId, lod,
    coverage: 'Complete published static and vegetation map at one explicit LOD; road remains canonical full resolution.',
    producers: { corpus: 'packages/cli/src/commands/corpus.ts',
      atlas: 'experiments/agentic-3d/atlas/build-atlas.mjs', lighting: { path: lightPath, caseId: lightingCase } },
    diagnosticCamera: { atlasPath, siteId: site.siteId, rsl: site.rsl, meshY: site.meshY,
      meshRingR: site.meshRingR, xodrY: site.xodrY,
      semantics: 'Published atlas anchor; workbench startup must raycast original source ground at target and translate eye/target by the exact height correction. No hit is an error; no engine trajectory.' },
    sources: [...metadata, hdri, ...pinned.values()],
    qualification: 'Map preparation only; no simulation, closed-loop qualification, or scenario content.',
  };
  const output = path.resolve(out);
  // Resolve the parent first to catch symlinks; never permit output within immutable sources.
  await mkdir(path.dirname(output), { recursive: true });
  const destination = path.join(await realpath(path.dirname(output)), path.basename(output));
  const protectedRoots = [await realpath(corpusRoot), await realpath(atlasRoot)];
  if (protectedRoots.some(root => inside(root, destination))) throw new Error('Output must be outside source directories');
  try { await stat(destination); throw new Error(`Output already exists: ${destination}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(destination);
  const manifestPath = path.join(destination, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(destination, 'preparation.json'), JSON.stringify(preparation, null, 2) + '\n', { flag: 'wx' });
  return { manifestPath, caseId: 'map-only', mapId, staticCount: staticGlbs.length,
    vegetationCount: vegGlbs.length, sourceGroundSources: [road], camera, siteId: site.siteId };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    map: { type: 'string' }, out: { type: 'string' }, 'corpus-root': { type: 'string' },
    'atlas-root': { type: 'string' }, 'lighting-manifest': { type: 'string' },
    'lighting-case': { type: 'string' }, site: { type: 'string' }, lod: { type: 'string' },
  } });
  const result = await prepareMapWorkbench({ mapId: values.map, out: values.out,
    corpusRoot: values['corpus-root'], atlasRoot: values['atlas-root'],
    lightingManifest: values['lighting-manifest'], lightingCase: values['lighting-case'],
    siteId: values.site, lod: values.lod === undefined ? undefined : Number(values.lod) });
  console.log(JSON.stringify(result, null, 2));
}
