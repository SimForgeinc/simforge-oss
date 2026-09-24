import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/closure.js';
import { buildTextureDensity, parseTextureDensityManifest, textureDensityBuildKey, textureDensityFingerprint } from '../src/texture-density.js';

function ktx2(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(80);
  Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32LE(145, 12); bytes.writeUInt32LE(width, 20); bytes.writeUInt32LE(height, 24); bytes.writeUInt32LE(1, 40);
  return bytes;
}

/** A 1 m quad in the XZ plane with UVs 0..1 (plus one triangle whose UVs are all equal), instanced twice. */
async function master(dir: string): Promise<void> {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 5, 0, 5, 6, 0, 5, 6, 0, 6]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 0]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(uvs.buffer), Buffer.from(indices.buffer)]);
  await writeFile(path.join(dir, 'geometry.bin'), bin);
  await writeFile(path.join(dir, 'images', 'a.ktx2'), ktx2(256, 128));
  await writeFile(path.join(dir, 'master.gltf'), JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ uri: 'geometry.bin', byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 84 },
      { buffer: 0, byteOffset: 84, byteLength: 56 },
      { buffer: 0, byteOffset: 140, byteLength: 20 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 7, type: 'VEC3', min: [0, 0, 0], max: [6, 0, 6] },
      { bufferView: 1, componentType: 5126, count: 7, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 2, componentType: 5123, count: 9, type: 'SCALAR' },
    ],
    images: [{ uri: 'images/a.ktx2', mimeType: 'image/ktx2' }],
    textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
    materials: [
      { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      { normalTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [4, 4] } } } },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] },
      { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 3, material: 1 }] },
    ],
    nodes: [
      { mesh: 0, translation: [100, 0, 200] },
      { mesh: 0, translation: [-1000, 0, 0], scale: [2, 2, 2] },
      { mesh: 1, translation: [0, 0, 1000] },
    ],
    scenes: [{ nodes: [0, 1, 2] }],
  }));
}

describe('texture density derivative', () => {
  it('records each image use: its horizontal box and its lowest texel density', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'texture-density-'));
    try {
      await (await import('node:fs/promises')).mkdir(path.join(dir, 'images'));
      await master(dir);
      const manifest = await buildTextureDensity({ masterDir: dir, outputDir: path.join(dir, 'out') });
      expect(parseTextureDensityManifest(JSON.parse(await readFile(path.join(dir, 'out', 'manifest.json'), 'utf8')))).toEqual(manifest);
      expect(manifest.buildKey).toBe(textureDensityBuildKey({ masterSha256: sha256(await readFile(path.join(dir, 'master.gltf'))), fingerprint: textureDensityFingerprint() }));
      expect(manifest.images).toHaveLength(1);
      const [image] = manifest.images;
      expect(image).toMatchObject({ uri: 'images/a.ktx2', width: 256, height: 128 });
      // UV 0..1 over 1 m on a 256x128 image: sqrt((256^2 + 128^2) / 2) texels per metre.
      const quad = Math.sqrt((256 ** 2 + 128 ** 2) / 2);
      expect(image!.uses).toEqual([
        // Scaled 2x: half the density per world metre, a box twice as large.
        [-1000, 0, -988, 12, expect.closeTo(quad / 2, 0)],
        // The constant-UV triangle of mesh 1 samples one texel position: density 0.
        [0, 1000, 6, 1006, 0],
        [100, 200, 106, 206, expect.closeTo(quad, 0)],
      ]);
      expect(image!.uses[0]![4]).toBeLessThanOrEqual(quad / 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a malformed manifest', () => {
    expect(() => parseTextureDensityManifest({ schema: 'other' })).toThrow(/schema/);
  });
});
