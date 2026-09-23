import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildBrowserPacks, BROWSER_PACK_CHUNK_BYTES, BROWSER_PACK_REVISION } from '../scripts/browser-packs.mjs';
import { buildTextureTiers, TEXTURE_TIERS_REVISION, TEXTURE_VARIANTS } from '../scripts/texture-tiers.mjs';
import { canonicalJson, sha256 } from './closure.js';
import { ktx2ToolFingerprint } from './ktx2.js';

/**
 * `derived/browser-variants/`: the browser texture tiers and packs of a map
 * version published before ingest cooked them.
 *
 * Maps built by the pipeline carry `textures-{256,512}-{uastc,bc7,astc,etc2}`
 * and the per-tier browser packs in the web closure (`cookMapTextures`). A
 * published closure is immutable and its `3d/variants/manifest.json` is a
 * simulation member, so a backfill runs the same builders into an overlay:
 *
 * - every new file keeps its natural path (`3d/variants/objects/*.ktx2`,
 *   `3d/variants/textures-*.json`, `3d/variants/browser-pack-*.json`,
 *   `3d/packs/objects/*.bin`) and is served beside the closure;
 * - the overlay's complete variant envelope (the closure's entries plus the
 *   new tiers and `browser-pack:*` entries) is `derived/browser-variants/manifest.json`,
 *   which the viewer prefers over `3d/variants/manifest.json` when it is bound
 *   to the same `3d/manifest.json`.
 *
 * Presentation only: no simulation member is read for anything but identity,
 * and none is written.
 */
export const BROWSER_VARIANTS_REVISION = 1;
export const BROWSER_VARIANTS_SCHEMA = 'simforge.map-browser-variants.v1';
export const BROWSER_VARIANTS_DIR = 'derived/browser-variants';

/** Closure members the builders read: the web scene (`3d/`) and the UASTC sources (`images/*.ktx2`). */
export function browserVariantInput(relativePath: string): boolean {
  return (relativePath.startsWith('3d/') && !relativePath.startsWith('3d/runtime/')) || /^images\/[^/]+\.ktx2$/.test(relativePath);
}

export function browserVariantsFingerprint(ktxBinDir?: string): string {
  return sha256(canonicalJson({
    builder: 'simforge-map-browser-variants',
    revision: BROWSER_VARIANTS_REVISION,
    tiers: { revision: TEXTURE_TIERS_REVISION, variants: TEXTURE_VARIANTS },
    packs: { revision: BROWSER_PACK_REVISION, chunkBytes: BROWSER_PACK_CHUNK_BYTES },
    ktx2: ktx2ToolFingerprint(ktxBinDir ? { ktxBinDir } : {}),
  }));
}

/** Content address: every input member by digest plus the builder fingerprint. */
export function browserVariantsBuildKey(input: { members: Readonly<Record<string, string>>; fingerprint: string }): string {
  const members = Object.fromEntries(Object.entries(input.members).filter(([file]) => browserVariantInput(file)).sort(([a], [b]) => (a < b ? -1 : 1)));
  return sha256(canonicalJson({ schema: BROWSER_VARIANTS_SCHEMA, members, fingerprint: input.fingerprint }));
}

export interface BrowserVariantsManifest {
  schemaVersion: 1;
  sourceManifestSha256: string;
  variants: Record<string, { file: string; outputSha256: string; sourceManifestSha256: string }>;
  schema: typeof BROWSER_VARIANTS_SCHEMA;
  buildKey: string;
  revision: number;
  /** Tier and pack ids this derivative adds to the closure's envelope. */
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
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/**
 * Build the derivative from `sourceRoot` (a directory holding exactly the
 * version's input members: see `browserVariantInput`) into `outputDir`, laid
 * out as closure paths. `buildKey` is computed by the caller from the
 * closure's member digests (`browserVariantsBuildKey`).
 */
export async function buildBrowserVariants(options: { sourceRoot: string; outputDir: string; buildKey: string; ktxBinDir?: string; concurrency?: number }): Promise<{ manifest: BrowserVariantsManifest; files: Record<string, { sha256: string; bytes: number }> }> {
  await rm(options.outputDir, { recursive: true, force: true });
  await mkdir(options.outputDir, { recursive: true });
  const closureEnvelope = JSON.parse(await readFile(path.join(options.sourceRoot, '3d', 'variants', 'manifest.json'), 'utf8').catch(() => '{"variants":{}}')) as { variants?: Record<string, unknown> };
  // The builders read a tier the closure already has (its index and objects)
  // from the output root: seed it with the closure's own variant files. They
  // stay closure members (a publisher skips paths the closure carries).
  const closureVariants = (await filesUnder(path.join(options.sourceRoot, '3d', 'variants'))).filter((file) => file !== 'manifest.json');
  await materializeSourceRoot(path.join(options.sourceRoot, '3d', 'variants'), path.join(options.outputDir, '3d', 'variants'), closureVariants);
  await buildTextureTiers({
    sourceRoot: options.sourceRoot,
    outputRoot: options.outputDir,
    concurrency: Math.min(8, options.concurrency ?? 4),
    ...(options.ktxBinDir ? { ktxBin: path.join(options.ktxBinDir, 'ktx') } : {}),
  });
  await buildBrowserPacks({ sourceRoot: options.sourceRoot, outputRoot: options.outputDir });
  // The overlay envelope moves out of the simulation member's path.
  const overlayEnvelopePath = path.join(options.outputDir, '3d', 'variants', 'manifest.json');
  const envelope = JSON.parse(await readFile(overlayEnvelopePath, 'utf8')) as Omit<BrowserVariantsManifest, 'schema' | 'buildKey' | 'revision' | 'added'>;
  const added = Object.keys(envelope.variants).filter((id) => !(id in (closureEnvelope.variants ?? {}))).sort();
  if (added.length === 0) throw new Error('browser variants: the closure already has every tier and pack; nothing to add');
  const manifest: BrowserVariantsManifest = { ...envelope, schema: BROWSER_VARIANTS_SCHEMA, buildKey: options.buildKey, revision: BROWSER_VARIANTS_REVISION, added };
  const target = path.join(options.outputDir, ...BROWSER_VARIANTS_DIR.split('/'), 'manifest.json');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(`${target}.tmp`, `${canonicalJson(manifest)}\n`);
  await rename(`${target}.tmp`, target);
  await rm(overlayEnvelopePath);
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const file of await filesUnder(options.outputDir)) {
    const bytes = await readFile(path.join(options.outputDir, file));
    files[file] = { sha256: sha256(bytes), bytes: bytes.byteLength };
  }
  return { manifest, files };
}

/** Hardlink (or copy) `members` from `from` into a fresh source root. */
export async function materializeSourceRoot(from: string, to: string, members: readonly string[]): Promise<void> {
  const { link } = await import('node:fs/promises');
  for (const member of members) {
    const destination = path.join(to, member);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await link(path.join(from, member), destination);
    } catch {
      await cp(path.join(from, member), destination);
    }
  }
}
