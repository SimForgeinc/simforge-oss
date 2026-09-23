import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256 } from '../src/closure.js';
import { encodeKtx2 } from '../src/ktx2.js';
import {
  buildTexturesFullBc7, masterKtx2Images, resolveGpuVariantTool, textureVariantBuildKey, textureVariantFingerprint, textureVariantManifestSchema,
} from '../src/texture-variant.js';

// Needs the pinned generator (renderer/render-core bin ktx2-gpu-variant) and KTX-Software.
const tool = process.env['SIMFORGE_KTX2_GPU_VARIANT_BIN'];
const ktx = process.env['SIMFORGE_KTX_BIN_DIR'];

describe('masterKtx2Images', () => {
  it('lists the KTX2 sources textures sample, not the PNG cores', () => {
    const master = {
      images: [{ uri: 'images/a.png' }, { uri: 'images/b.png' }, { uri: 'images/a.ktx2' }, { uri: 'images/b.ktx2' }],
      textures: [{ extensions: { KHR_texture_basisu: { source: 3 } } }, { extensions: { KHR_texture_basisu: { source: 2 } } }, {}, { extensions: { KHR_texture_basisu: { source: 2 } } }],
    };
    expect(masterKtx2Images(master)).toEqual(['images/a.ktx2', 'images/b.ktx2']);
  });
});

describe.skipIf(!tool || !ktx)('buildTexturesFullBc7', () => {
  let root = '';
  const members = new Map<string, Uint8Array>();
  let masterBytes: Uint8Array;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'simforge-texture-variant-'));
    const color = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 90, b: 30, alpha: 255 } } }).png().toBuffer();
    const normal = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 128, g: 128, b: 255, alpha: 255 } } }).png().toBuffer();
    const images: Array<{ uri: string; mimeType: string }> = [];
    for (const [png, cls] of [[color, 'color'], [normal, 'normal']] as const) {
      const encoded = await encodeKtx2(png, cls, { ktxBinDir: ktx! });
      const uri = `images/${sha256(png)}.ktx2`;
      members.set(uri, new Uint8Array(encoded.bytes));
      images.push({ uri: `images/${sha256(png)}.png`, mimeType: 'image/png' });
      images.push({ uri, mimeType: 'image/ktx2' });
    }
    masterBytes = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, images, textures: [{ source: 0, extensions: { KHR_texture_basisu: { source: 1 } } }, { source: 2, extensions: { KHR_texture_basisu: { source: 3 } } }] }));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the envelope, index and content-addressed BC blocks for every KTX2 source, byte-identically on rebuild', async () => {
    const gpu = await resolveGpuVariantTool(tool);
    const sourceManifestSha256 = 'e'.repeat(64);
    const build = (dir: string) => buildTexturesFullBc7({
      master: masterBytes, sourceManifestSha256, outputDir: path.join(root, dir), tool: gpu,
      readImage: async (uri) => members.get(uri),
    });
    const first = await build('a');
    const manifest = textureVariantManifestSchema.parse(JSON.parse(await readFile(path.join(root, 'a', 'manifest.json'), 'utf8')));
    expect(manifest.buildKey).toBe(textureVariantBuildKey({
      masterSha256: sha256(masterBytes), sourceManifestSha256,
      images: Object.fromEntries([...members].map(([uri, bytes]) => [uri, sha256(bytes)])), fingerprint: textureVariantFingerprint(gpu),
    }));
    expect(manifest.totals.images).toBe(2);
    expect(manifest.totals.bc7 + manifest.totals.bc5 + manifest.totals.bc4).toBe(2);
    const index = JSON.parse(await readFile(path.join(root, 'a', 'index.json'), 'utf8'));
    expect(index).toMatchObject({ schemaVersion: 1, id: 'textures-full-bc7', sourceManifestSha256 });
    expect(Object.keys(index.images).sort()).toEqual([...members.keys()].map((uri) => `../${uri}`).sort());
    expect(manifest.variants['textures-full-bc7'].outputSha256).toBe(sha256(await readFile(path.join(root, 'a', 'index.json'))));
    for (const entry of Object.values(index.images) as Array<{ file: string; outputSha256: string }>) {
      expect(entry.file).toBe(`objects/${entry.outputSha256}.ktx2`);
      expect(sha256(await readFile(path.join(root, 'a', entry.file)))).toBe(entry.outputSha256);
    }
    const second = await build('b');
    expect(second.files).toEqual(first.files);
  });

  it('fails loudly when a source is missing from the closure', async () => {
    const gpu = await resolveGpuVariantTool(tool);
    await expect(buildTexturesFullBc7({ master: masterBytes, sourceManifestSha256: 'e'.repeat(64), outputDir: path.join(root, 'c'), tool: gpu, readImage: async () => undefined }))
      .rejects.toThrow(/closure lacks/);
  });
});

describe('resolveGpuVariantTool', () => {
  it('refuses to run without the pinned generator', async () => {
    await expect(resolveGpuVariantTool('/nonexistent/ktx2-gpu-variant')).rejects.toThrow(/ktx2-gpu-variant not found/);
  });
});
