import { cp, link, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

import { buildBrowserPacks, BROWSER_PACK_CHUNK_BYTES, BROWSER_PACK_REVISION } from '../scripts/browser-packs.mjs';
import { buildTextureTiers, TEXTURE_TIERS_REVISION, TEXTURE_VARIANTS } from '../scripts/texture-tiers.mjs';
import { browserVariantInput } from './browser-variants.js';
import { canonicalJson, sha256 } from './closure.js';
import { GEOMETRY_LOD_DIR } from './geometry-lod/build.js';
import { ktx2ToolFingerprint } from './ktx2.js';
import { vegetationLodLevels } from './vegetation-lod-levels.js';
import { buildWebTier, MESHOPTIMIZER_VERSION, WEB_TIER_REVISION } from './web-tier.js';

/**
 * `derived/browser-scene/`: a published map version's web scene with the
 * coarse vegetation levels the geometry derivative gives it
 * (`tiles/veg_<x>_<z>.lod<k>.glb`), and the browser texture tiers and packs
 * bound to that scene.
 *
 * Maps built by the pipeline carry the levels in their web closure
 * (`webStage`). A published closure is immutable and its `3d/manifest.json`
 * is pinned by simulation (static colliders), so the backfill rebuilds the web
 * tier from the version's own master and geometry derivative, proves every
 * file the closure already has is byte-identical, and publishes only what is
 * new:
 *
 * - `derived/browser-scene/scene.json`: the closure's `3d/manifest.json` with
 *   each vegetation cell's coarser levels added (paths stay relative to `3d/`);
 * - `derived/browser-scene/manifest.json`: the variant envelope (all tiers and
 *   `browser-pack:*` entries) bound to `scene.json`, plus
 *   `scene: { file, sha256, baseManifestSha256 }` binding the scene to the
 *   closure manifest it extends;
 * - the new cells and impostor atlases, tier indexes, pack indexes and pack
 *   chunks at their natural paths (`3d/tiles/`, `images/`, `3d/variants/`,
 *   `3d/packs/objects/`).
 *
 * The viewer uses the scene when the envelope is bound to the closure manifest
 * it loaded and reports which scene it drew (`loadDiagnostics.scene`).
 */
export const BROWSER_SCENE_REVISION = 1;
export const BROWSER_SCENE_SCHEMA = 'simforge.map-browser-scene.v1';
export const BROWSER_SCENE_DIR = 'derived/browser-scene';
const CELL_SIZE = 100;

/** Native closure members the scene is rebuilt from: the master and the geometry derivative's render levels. */
export function browserSceneNativeInput(relativePath: string): boolean {
  return relativePath === 'master.gltf' || relativePath === 'geometry.bin'
    || (relativePath.startsWith(`${GEOMETRY_LOD_DIR}/`) && !relativePath.startsWith(`${GEOMETRY_LOD_DIR}/sensor`));
}

export function browserSceneFingerprint(ktxBinDir?: string): string {
  return sha256(canonicalJson({
    builder: 'simforge-map-browser-scene',
    revision: BROWSER_SCENE_REVISION,
    web: { revision: WEB_TIER_REVISION, meshoptimizer: MESHOPTIMIZER_VERSION, cellSize: CELL_SIZE },
    tiers: { revision: TEXTURE_TIERS_REVISION, variants: TEXTURE_VARIANTS },
    packs: { revision: BROWSER_PACK_REVISION, chunkBytes: BROWSER_PACK_CHUNK_BYTES },
    ktx2: ktx2ToolFingerprint(ktxBinDir ? { ktxBinDir } : {}),
  }));
}

const sorted = (members: Readonly<Record<string, string>>, keep: (file: string) => boolean) =>
  Object.fromEntries(Object.entries(members).filter(([file]) => keep(file)).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Content address: the browser closure's scene inputs, the native master and geometry levels, and the builder. */
export function browserSceneBuildKey(input: { browser: Readonly<Record<string, string>>; native: Readonly<Record<string, string>>; fingerprint: string }): string {
  return sha256(canonicalJson({
    schema: BROWSER_SCENE_SCHEMA,
    browser: sorted(input.browser, browserVariantInput),
    native: sorted(input.native, browserSceneNativeInput),
    fingerprint: input.fingerprint,
  }));
}

interface Lod { file: string; level: number; geometricError: number; triangles: number; fileSize: number }
interface Cell { id: string; lods: Lod[] }
interface SceneManifest {
  scene: Record<string, unknown>;
  staticLayers?: Array<{ file: string }>;
  tiles?: Cell[];
  vegetationTiles?: Cell[];
  [key: string]: unknown;
}

/** Why a closure cannot take a browser scene (reported, not an error), or null. */
export function browserSceneNotApplicable(closureManifest: SceneManifest): string | null {
  const cells = closureManifest.vegetationTiles ?? [];
  if (cells.length === 0) return 'the web scene has no vegetation cells';
  if (cells.some((cell) => cell.lods.length > 1)) return 'the web scene already carries vegetation levels';
  return null;
}

export interface BrowserSceneManifest {
  schemaVersion: 1;
  sourceManifestSha256: string;
  variants: Record<string, { file: string; outputSha256: string; sourceManifestSha256: string }>;
  schema: typeof BROWSER_SCENE_SCHEMA;
  buildKey: string;
  revision: number;
  scene: { file: string; sha256: string; baseManifestSha256: string };
  /** Cells and images the scene adds to the closure. */
  added: string[];
}

async function filesUnder(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await filesUnder(root, relative));
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative);
  }
  return out;
}

async function place(from: string, to: string, mode: 'link' | 'move'): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  if (mode === 'move') {
    try { await rename(from, to); return; } catch { /* another filesystem */ }
    await cp(from, to);
    return;
  }
  try { await link(from, to); } catch { await symlink(path.resolve(from), to); }
}

/**
 * Build the derivative from `sourceRoot` (the browser closure's scene inputs
 * at their paths, plus the native `master.gltf`, `geometry.bin` and
 * `derived/geometry-lod/*`) into `outputDir`, laid out as closure paths.
 * Throws when the rebuilt web tier differs from the closure anywhere the
 * closure already has a file: a scene that silently replaced published
 * geometry would be a different map.
 */
export async function buildBrowserScene(options: { sourceRoot: string; outputDir: string; buildKey: string; ktxBinDir?: string; concurrency?: number; log?: (line: string) => void }): Promise<{ manifest: BrowserSceneManifest }> {
  const log = options.log ?? (() => {});
  const source = options.sourceRoot;
  await rm(options.outputDir, { recursive: true, force: true });
  const work = path.join(options.outputDir, '.work');
  const web = path.join(work, 'web');
  const root = path.join(work, 'scene-root');
  await mkdir(web, { recursive: true });

  const closureBytes = await readFile(path.join(source, '3d', 'manifest.json'));
  const baseManifestSha256 = sha256(closureBytes);
  const closure = JSON.parse(closureBytes.toString('utf8')) as SceneManifest;
  const notApplicable = browserSceneNotApplicable(closure);
  if (notApplicable) throw new Error(`browser scene not applicable: ${notApplicable}`);

  // The web tier from the version's own master and geometry levels.
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const json = JSON.parse(await readFile(path.join(source, 'master.gltf'), 'utf8')) as { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const buffer of json.buffers ?? []) if (buffer.uri) resources[buffer.uri] = new Uint8Array(await readFile(path.join(source, buffer.uri)));
  // Cells reference images by URI only; the bytes are never read.
  for (const image of json.images ?? []) if (image.uri) resources[image.uri] = new Uint8Array(0);
  const document = await io.readJSON({ json: json as never, resources });
  const levels = await vegetationLodLevels(io, source, web);
  if (!levels) throw new Error('browser scene not applicable: the geometry derivative has no levels');
  const report = await buildWebTier(document, web, { cellSize: CELL_SIZE, vegetationLevels: levels });
  log(`browser-scene: web tier rebuilt (${JSON.stringify(report).slice(0, 200)})`);
  const rebuilt = JSON.parse(await readFile(path.join(web, '3d', 'manifest.json'), 'utf8')) as SceneManifest;

  // Every file the closure has must be the one the rebuild made.
  const closureFiles = [
    ...(closure.staticLayers ?? []).map((layer) => layer.file),
    ...(closure.tiles ?? []).flatMap((cell) => cell.lods.map((lod) => lod.file)),
    ...(closure.vegetationTiles ?? []).flatMap((cell) => cell.lods.map((lod) => lod.file)),
  ];
  for (const file of closureFiles) {
    const published = sha256(await readFile(path.join(source, '3d', file)));
    let made: string;
    try { made = sha256(await readFile(path.join(web, '3d', file))); } catch { made = 'missing'; }
    if (made !== published) throw new Error(`browser scene: the rebuilt web tier differs from the published closure at 3d/${file} (published ${published.slice(0, 12)}, rebuilt ${made.slice(0, 12)}); the version was built by another web tier`);
  }
  const rebuiltCells = new Map((rebuilt.vegetationTiles ?? []).map((cell) => [cell.id, cell]));
  if (rebuiltCells.size !== (closure.vegetationTiles ?? []).length) throw new Error('browser scene: the rebuilt web tier has other vegetation cells than the published closure');

  // The scene: the closure manifest with each cell's coarser levels.
  const added: string[] = [];
  const scene = structuredClone(closure);
  for (const cell of scene.vegetationTiles ?? []) {
    const levelsOf = rebuiltCells.get(cell.id);
    if (!levelsOf || levelsOf.lods[0]?.file !== cell.lods[0]?.file) throw new Error(`browser scene: vegetation cell ${cell.id} does not match the published closure`);
    const coarser = levelsOf.lods.filter((lod) => lod.level > 0);
    cell.lods = [cell.lods[0]!, ...coarser];
    added.push(...coarser.map((lod) => `3d/${lod.file}`));
  }
  if (added.length === 0) throw new Error('browser scene not applicable: no vegetation cell has a coarser level');
  scene.scene = { ...scene.scene, lodLevels: rebuilt.scene['lodLevels'] };
  const sourceImages = new Set((await filesUnder(path.join(source, 'images'))));
  for (const image of await filesUnder(path.join(web, 'images'))) if (!sourceImages.has(image)) added.push(`images/${image}`);
  added.sort();
  const sceneBytes = Buffer.from(JSON.stringify(scene));
  const sceneSha256 = sha256(sceneBytes);

  // Tiers and packs over the scene (the closure's own tiers are bound to its manifest).
  for (const file of await filesUnder(path.join(source, '3d'))) {
    if (file === 'manifest.json' || file.startsWith('variants/') || file.startsWith('packs/') || file.startsWith('runtime/')) continue;
    await place(path.join(source, '3d', file), path.join(root, '3d', file), 'link');
  }
  for (const image of sourceImages) if (image.endsWith('.ktx2')) await place(path.join(source, 'images', image), path.join(root, 'images', image), 'link');
  for (const file of added) await place(path.join(web, file), path.join(root, file), 'link');
  await writeFile(path.join(root, '3d', 'manifest.json'), sceneBytes);
  await buildTextureTiers({ sourceRoot: root, outputRoot: root, concurrency: Math.min(8, options.concurrency ?? 4), ...(options.ktxBinDir ? { ktxBin: path.join(options.ktxBinDir, 'ktx') } : {}) });
  await buildBrowserPacks({ sourceRoot: root });
  const envelope = JSON.parse(await readFile(path.join(root, '3d', 'variants', 'manifest.json'), 'utf8')) as Omit<BrowserSceneManifest, 'schema' | 'buildKey' | 'revision' | 'scene' | 'added'>;
  if (envelope.sourceManifestSha256 !== sceneSha256) throw new Error('browser scene: the tiers are bound to another manifest');
  for (const tier of TEXTURE_VARIANTS) {
    if (!envelope.variants[tier] || !envelope.variants[`browser-pack:${tier}`]) throw new Error(`browser scene: ${tier} or its pack is missing`);
  }

  // Output: only what is new, at closure paths.
  const directory = path.join(options.outputDir, ...BROWSER_SCENE_DIR.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'scene.json'), sceneBytes);
  const manifest: BrowserSceneManifest = {
    ...envelope, schema: BROWSER_SCENE_SCHEMA, buildKey: options.buildKey, revision: BROWSER_SCENE_REVISION,
    scene: { file: `${BROWSER_SCENE_DIR}/scene.json`, sha256: sceneSha256, baseManifestSha256 }, added,
  };
  await writeFile(path.join(directory, 'manifest.json'), `${canonicalJson(manifest)}\n`);
  for (const file of added) await place(path.join(web, file), path.join(options.outputDir, file), 'move');
  for (const file of await filesUnder(path.join(root, '3d', 'variants'))) {
    if (file === 'manifest.json') continue;
    await place(path.join(root, '3d', 'variants', file), path.join(options.outputDir, '3d', 'variants', file), 'move');
  }
  for (const file of await filesUnder(path.join(root, '3d', 'packs'))) await place(path.join(root, '3d', 'packs', file), path.join(options.outputDir, '3d', 'packs', file), 'move');
  await rm(work, { recursive: true, force: true });
  return { manifest };
}
