import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { canonicalJson, sha256 } from './closure.js';

/**
 * `derived/textures-full-bc7/`: the full-resolution GPU-block texture tier.
 *
 * The native service loads every map texture as UASTC KTX2 and transcodes it
 * to BC7/BC5/BC4 at load: about 125 s of CPU per job start on Belmont. This
 * derivative is that transcode done once at ingest by `ktx2-gpu-variant`
 * (renderer/render-core), which runs Bevy's own loader function and verifies
 * that each output loads to exactly the blocks the service would have made,
 * so renders are byte-identical. The engine plans these files for the
 * `uastc-full` tier when present and transcodes at load (a logged
 * `texture_tier_miss`) when not.
 *
 * Layout (the `3d/variants` envelope and index shapes, rooted here):
 *
 *   manifest.json            envelope: variants["textures-full-bc7"] -> index.json
 *   index.json               images["../<master image uri>"] -> objects/<sha>.ktx2
 *   objects/<sha256>.ktx2    zstd-supercompressed BC KTX2, named by digest
 *
 * The envelope and index bind `3d/manifest.json` (the engine's texture-set
 * identity); passthrough (non-Basis) images are omitted and load as they are.
 */
export const TEXTURE_VARIANT_REVISION = 1;
export const TEXTURE_VARIANT_SCHEMA = 'simforge.map-texture-variant.v1';
export const TEXTURES_FULL_BC7_ID = 'textures-full-bc7';
export const TEXTURES_FULL_BC7_DIR = 'derived/textures-full-bc7';

const execFileAsync = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{64}$/);

export const gpuVariantToolFingerprintSchema = z.object({
  tool: z.literal('simforge.ktx2-gpu-variant/v1'),
  binarySha256: sha,
}).passthrough();

export interface GpuVariantTool {
  bin: string;
  fingerprint: z.infer<typeof gpuVariantToolFingerprintSchema>;
}

/**
 * The pinned generator: `--tool`, else SIMFORGE_KTX2_GPU_VARIANT_BIN. Its
 * `--fingerprint` (tool id plus the binary's digest) is part of every key,
 * so a different build rebuilds every map.
 */
export async function resolveGpuVariantTool(explicit?: string): Promise<GpuVariantTool> {
  const bin = explicit ?? process.env['SIMFORGE_KTX2_GPU_VARIANT_BIN'];
  if (!bin || !existsSync(bin)) {
    throw new Error('ktx2-gpu-variant not found: build it (cd renderer && cargo build --release --locked -p render-core --bin ktx2-gpu-variant) and set SIMFORGE_KTX2_GPU_VARIANT_BIN, or skip the tier with SIMFORGE_MAP_TEXTURES_FULL_BC7=skip');
  }
  const { stdout } = await execFileAsync(bin, ['--fingerprint'], { encoding: 'utf8' });
  const fingerprint = gpuVariantToolFingerprintSchema.parse(JSON.parse(stdout));
  const actual = sha256(await readFile(bin));
  if (actual !== fingerprint.binarySha256) throw new Error(`ktx2-gpu-variant reports binarySha256 ${fingerprint.binarySha256} but the file hashes to ${actual}`);
  return { bin, fingerprint };
}

export function textureVariantFingerprint(tool: GpuVariantTool): string {
  return sha256(canonicalJson({ builder: 'simforge-map-texture-variant', revision: TEXTURE_VARIANT_REVISION, id: TEXTURES_FULL_BC7_ID, tool: tool.fingerprint }));
}

/**
 * Content address: the master's JSON, the texture-set identity
 * (`3d/manifest.json`), every source KTX2 by digest, and the builder
 * fingerprint. The master names images by their PNG digest, so the KTX2
 * encodings are listed explicitly.
 */
export function textureVariantBuildKey(input: { masterSha256: string; sourceManifestSha256: string; images: Readonly<Record<string, string>>; fingerprint: string }): string {
  return sha256(canonicalJson({ schema: TEXTURE_VARIANT_SCHEMA, id: TEXTURES_FULL_BC7_ID, ...input }));
}

/** The KTX2 image URIs a master's textures sample (their `KHR_texture_basisu` sources), sorted. */
export function masterKtx2Images(master: { textures?: Array<{ extensions?: { KHR_texture_basisu?: { source: number } } }>; images?: Array<{ uri?: string }> }): string[] {
  const uris = new Set<string>();
  for (const texture of master.textures ?? []) {
    const index = texture.extensions?.KHR_texture_basisu?.source;
    const uri = index === undefined ? undefined : master.images?.[index]?.uri;
    if (uri && !uri.startsWith('data:')) uris.add(uri);
  }
  return [...uris].sort();
}

const variantRecordSchema = z.object({
  input: z.string(),
  inputSha256: sha,
  codec: z.enum(['bc7', 'bc5', 'bc4', 'passthrough']),
  file: z.string().optional(),
  outputSha256: sha.optional(),
  vkFormat: z.number().int().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  levels: z.number().int().positive(),
});

export const textureVariantManifestSchema = z.object({
  schema: z.literal(TEXTURE_VARIANT_SCHEMA),
  buildKey: sha,
  revision: z.number().int().positive(),
  sourceManifestSha256: sha,
  source: z.object({ master: sha }),
  tool: gpuVariantToolFingerprintSchema,
  variants: z.object({
    [TEXTURES_FULL_BC7_ID]: z.object({ file: z.string(), outputSha256: sha, sourceManifestSha256: sha }).strict(),
  }).strict(),
  totals: z.object({ images: z.number().int(), bc7: z.number().int(), bc5: z.number().int(), bc4: z.number().int(), passthrough: z.number().int(), sourceBytes: z.number().int(), outputBytes: z.number().int() }).strict(),
}).strict();
export type TextureVariantManifest = z.infer<typeof textureVariantManifestSchema>;

export interface BuildTextureVariantOptions {
  /** The master's `master.gltf` bytes. */
  master: Uint8Array;
  /** sha256 of the closure's `3d/manifest.json`. */
  sourceManifestSha256: string;
  /** Bytes of a closure member by path (`images/<sha>.ktx2`). */
  readImage(uri: string): Promise<Uint8Array | undefined>;
  outputDir: string;
  tool: GpuVariantTool;
  log?: (line: string) => void;
}

export interface TextureVariantResult {
  manifest: TextureVariantManifest;
  /** Path under the derivative directory -> digest and size. */
  files: Record<string, { sha256: string; bytes: number }>;
}

async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

/** Inputs per generator invocation (argv stays far below ARG_MAX). */
const BATCH = 1000;

export async function buildTexturesFullBc7(options: BuildTextureVariantOptions): Promise<TextureVariantResult> {
  const log = options.log ?? (() => {});
  const masterSha256 = sha256(options.master);
  const master = JSON.parse(Buffer.from(options.master).toString('utf8')) as Parameters<typeof masterKtx2Images>[0];
  const uris = masterKtx2Images(master);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'simforge-texture-variant-'));
  try {
    // Sources on disk under their closure names; digests for the key.
    const images: Record<string, string> = {};
    const byInput = new Map<string, string>();
    let sourceBytes = 0;
    for (const [index, uri] of uris.entries()) {
      const bytes = await options.readImage(uri);
      if (!bytes) throw new Error(`texture variant: closure lacks ${uri}`);
      images[uri] = sha256(bytes);
      sourceBytes += bytes.byteLength;
      const file = path.join(scratch, 'in', `${index}.ktx2`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      byInput.set(file, uri);
    }
    const fingerprint = textureVariantFingerprint(options.tool);
    const buildKey = textureVariantBuildKey({ masterSha256, sourceManifestSha256: options.sourceManifestSha256, images, fingerprint });
    const objects = path.join(options.outputDir, 'objects');
    await rm(options.outputDir, { recursive: true, force: true });
    await mkdir(objects, { recursive: true });
    const inputs = [...byInput.keys()];
    const records: z.infer<typeof variantRecordSchema>[] = [];
    for (let start = 0; start < inputs.length; start += BATCH) {
      const batch = inputs.slice(start, start + BATCH);
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(options.tool.bin, ['--out-dir', objects, '--supercompression', 'zstd', ...batch], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
      } catch (error) {
        const failure = error as { stderr?: string; message: string };
        throw new Error(`ktx2-gpu-variant failed: ${failure.stderr || failure.message}`);
      }
      const lines = stdout.split('\n').filter((line) => line.trim());
      if (lines.length !== batch.length) throw new Error(`ktx2-gpu-variant printed ${lines.length} records for ${batch.length} inputs`);
      for (const line of lines) records.push(variantRecordSchema.parse(JSON.parse(line)));
      log(`texture variant: ${Math.min(start + BATCH, inputs.length)}/${inputs.length}`);
    }
    const counts = { bc7: 0, bc5: 0, bc4: 0, passthrough: 0 };
    const indexImages: Record<string, { file: string; outputSha256: string; width: number; height: number; codec: string }> = {};
    const files: TextureVariantResult['files'] = {};
    let outputBytes = 0;
    for (const record of records) {
      const uri = byInput.get(record.input);
      if (!uri) throw new Error(`ktx2-gpu-variant reported an unknown input ${record.input}`);
      if (record.inputSha256 !== images[uri]) throw new Error(`ktx2-gpu-variant read ${uri} as ${record.inputSha256}`);
      counts[record.codec] += 1;
      if (record.codec === 'passthrough') continue;
      if (!record.file || !record.outputSha256 || record.file !== `${record.outputSha256}.ktx2`) throw new Error(`ktx2-gpu-variant record for ${uri} has no content-addressed output`);
      const bytes = await readFile(path.join(objects, record.file));
      if (sha256(bytes) !== record.outputSha256) throw new Error(`ktx2-gpu-variant output ${record.file} does not match its digest`);
      const relative = `objects/${record.file}`;
      if (!files[relative]) outputBytes += bytes.byteLength;
      files[relative] = { sha256: record.outputSha256, bytes: bytes.byteLength };
      indexImages[`../${uri}`] = { file: relative, outputSha256: record.outputSha256, width: record.width, height: record.height, codec: record.codec };
    }
    const index = canonicalJson({ schemaVersion: 1, id: TEXTURES_FULL_BC7_ID, sourceManifestSha256: options.sourceManifestSha256, images: indexImages });
    await writeAtomic(path.join(options.outputDir, 'index.json'), index);
    const indexSha256 = sha256(Buffer.from(index));
    files['index.json'] = { sha256: indexSha256, bytes: Buffer.byteLength(index) };
    const manifest: TextureVariantManifest = {
      schema: TEXTURE_VARIANT_SCHEMA,
      buildKey,
      revision: TEXTURE_VARIANT_REVISION,
      sourceManifestSha256: options.sourceManifestSha256,
      source: { master: masterSha256 },
      tool: options.tool.fingerprint,
      variants: { [TEXTURES_FULL_BC7_ID]: { file: 'index.json', outputSha256: indexSha256, sourceManifestSha256: options.sourceManifestSha256 } },
      totals: { images: records.length, ...counts, sourceBytes, outputBytes },
    };
    const manifestText = `${canonicalJson(manifest)}\n`;
    await writeAtomic(path.join(options.outputDir, 'manifest.json'), manifestText);
    files['manifest.json'] = { sha256: sha256(Buffer.from(manifestText)), bytes: Buffer.byteLength(manifestText) };
    return { manifest, files };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
