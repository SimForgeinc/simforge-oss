import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  nativeCornerFocalPx, nativeTextureResidencyLevels, nativeTextureResidencyPlan, planNativeTextureDensity,
  NATIVE_MIN_MIP_BIAS, NATIVE_TEXTURE_DENSITY_MANIFEST, NATIVE_TEXTURE_RESIDENCY_SCHEMA,
} from './texture-residency.js';
import type { NativeTextureDensityImage } from './texture-residency.js';

const MASTER = 'a'.repeat(64);
const image = (uri: string, uses: [number, number, number, number, number][]): NativeTextureDensityImage => ({ uri, width: 2048, height: 2048, uses });
const manifest = {
  schema: 'simforge.map-texture-density.v1', buildKey: 'b'.repeat(64), cellM: 64,
  source: { master: { path: 'master.gltf', sha256: MASTER } }, builder: { revision: 1, fingerprint: 'f' },
  images: [image('images/a.ktx2', [[0, 0, 10, 10, 512]])],
};
function source(value: unknown, masterSha256 = MASTER) {
  const files: Record<string, { sha256: string; text: string }> = {
    'master.gltf': { sha256: masterSha256, text: '{}' },
    ...(value === undefined ? {} : { [NATIVE_TEXTURE_DENSITY_MANIFEST]: { sha256: 'c'.repeat(64), text: JSON.stringify(value) } }),
  };
  return { sha256: (uri: string) => files[uri]?.sha256, readText: async (uri: string) => files[uri]!.text };
}
// 1920x1080, 90 degree horizontal field of view.
const vfov = (2 * Math.atan(Math.tan(Math.PI / 4) * 1080 / 1920) * 180) / Math.PI;
const camera = (x: number, z: number) => ({ eye: [x, 1.5, z] as [number, number, number], width: 1920, height: 1080, fovDeg: vfov });

describe('per-job texture residency', () => {
  it('bounds the pixel footprint by the corner ray', () => {
    const tanX = 1, tanY = 1080 / 1920;
    expect(nativeCornerFocalPx(camera(0, 0))).toBeCloseTo(960 * (1 + tanX * tanX + tanY * tanY), 6);
  });

  it('keeps the levels the closest camera approach can sample, with the TAA bias', () => {
    const focal = nativeCornerFocalPx(camera(0, 0));
    // 512 texels/m seen from 400 m: log2(512 * 400 / focal) + bias.
    const far = image('images/far.ktx2', [[400, -5, 410, 5, 512]]);
    const levels = nativeTextureResidencyLevels([far], [[camera(0, 0)]], 0.1);
    expect(levels.get('images/far.ktx2')).toBe(Math.floor(Math.log2((512 * 400) / focal) + NATIVE_MIN_MIP_BIAS));
    // A camera inside the box: the near plane bounds the distance.
    expect(nativeTextureResidencyLevels([far], [[camera(0, 0)], [camera(405, 0)]], 0.1).get('images/far.ktx2')).toBe(0);
  });

  it('keeps every level of an image a triangle samples at one texel position', () => {
    const constant = image('images/constant.ktx2', [[1e5, 1e5, 1e5 + 1, 1e5 + 1, 1000], [0, 0, 1, 1, 0]]);
    expect(nativeTextureResidencyLevels([constant], [[camera(0, 0)]], 0.1).get('images/constant.ktx2')).toBe(0);
  });

  it('is a function of the poses, not their order or duplicates', () => {
    const images = [image('images/a.ktx2', [[50, 50, 60, 60, 256]]), image('images/b.ktx2', [[-300, 0, -290, 20, 1024]])];
    const frames = [[camera(0, 0)], [camera(10, 5)], [camera(20, 10)]];
    const reversed = [...frames].reverse();
    expect(nativeTextureResidencyLevels(images, frames, 0.1)).toEqual(nativeTextureResidencyLevels(images, [...reversed, ...frames], 0.1));
  });

  it('reads the derivative and refuses one built from another master', async () => {
    expect(await planNativeTextureDensity(source(undefined))).toBeUndefined();
    const plan = await planNativeTextureDensity(source(manifest));
    expect(plan).toMatchObject({ manifestSha256: 'c'.repeat(64), buildKey: 'b'.repeat(64) });
    await expect(planNativeTextureDensity(source(manifest, 'd'.repeat(64)))).rejects.toThrow(/native_texture_density_master_mismatch/);
    await expect(planNativeTextureDensity(source({ ...manifest, images: [image('images/a.ktx2', [[0, 0, 1, 1, -1]])] }))).rejects.toThrow(/native_texture_density_invalid/);
  });

  it('plans the staged files by the source URIs, and counts the bytes each keeps', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'residency-'));
    try {
      const header = (width: number, height: number, levels: number, format = 145) => {
        const bytes = Buffer.alloc(80);
        Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
        bytes.writeUInt32LE(format, 12); bytes.writeUInt32LE(width, 20); bytes.writeUInt32LE(height, 24); bytes.writeUInt32LE(levels, 40);
        return bytes;
      };
      await mkdir(path.join(dir, 'staged', 'objects'), { recursive: true });
      await writeFile(path.join(dir, 'staged', 'objects', 'a.ktx2'), header(16, 16, 5));
      await writeFile(path.join(dir, 'staged', 'objects', 'b.ktx2'), header(16, 16, 5));
      await writeFile(path.join(dir, 'master.gltf'), JSON.stringify({ images: [{ uri: 'images/a.ktx2' }, { uri: 'images/b.ktx2' }] }));
      await writeFile(path.join(dir, 'staged', 'master.gltf'), JSON.stringify({ images: [{ uri: 'objects/a.ktx2' }, { uri: 'objects/b.ktx2' }] }));
      const density = { manifestSha256: 'c'.repeat(64), buildKey: 'b'.repeat(64), images: [image('images/a.ktx2', []), image('images/b.ktx2', [])].map((i) => ({ ...i, width: 16, height: 16 })) };
      const residency = await nativeTextureResidencyPlan({
        closureMasterPath: path.join(dir, 'master.gltf'), stagedMasterPath: path.join(dir, 'staged', 'master.gltf'),
        levels: new Map([['images/a.ktx2', 2], ['images/b.ktx2', 0]]), density,
      });
      // Clamped to the staged chain and to whole 4x4 blocks: 16x16 keeps 4x4 (level 2).
      const clamped = await nativeTextureResidencyPlan({
        closureMasterPath: path.join(dir, 'master.gltf'), stagedMasterPath: path.join(dir, 'staged', 'master.gltf'),
        levels: new Map([['images/a.ktx2', 9]]), density,
      });
      expect(clamped.plan.images).toEqual([{ uri: 'objects/a.ktx2', dropLevels: 2 }]);
      expect(residency.plan.schema).toBe(NATIVE_TEXTURE_RESIDENCY_SCHEMA);
      expect(residency.plan.images).toEqual([{ uri: 'objects/a.ktx2', dropLevels: 2 }]);
      // 16x16 BC7 chain: 256 + 64 + 16 + 16 + 16 bytes; from level 2: 48.
      expect(residency.fullTextureBytes).toBe(2 * 368);
      expect(residency.residentTextureBytes).toBe(48 + 368);
      expect(residency.levelsDropped).toEqual([1, 0, 1, 0, 0, 0, 0, 0]);
      await expect(nativeTextureResidencyPlan({
        closureMasterPath: path.join(dir, 'master.gltf'), stagedMasterPath: path.join(dir, 'staged', 'master.gltf'),
        levels: new Map([['images/a.ktx2', 2]]), density: { ...density, images: [{ ...density.images[0]!, width: 32 }] },
      })).rejects.toThrow(/native_texture_residency_dims_mismatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
