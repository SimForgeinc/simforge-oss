import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildTextureTiers } from '../scripts/texture-tiers.mjs';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('refuses writes into installed maps before creating any directory (alias: %s)', async (alias) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'texture-tier-safety-'));
  try {
    const installed = path.join(home, '.local/share/simforge/maps');
    await mkdir(installed, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    let output = path.join(installed, 'must-not-create');
    if (alias) {
      const linked = path.join(home, 'alias');
      await symlink(installed, linked);
      output = path.join(linked, 'must-not-create');
    }
    await expect(buildTextureTiers({ sourceRoot: installed, outputRoot: output })).rejects.toThrow('Installed maps are immutable');
    await expect(stat(path.join(installed, 'must-not-create'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('extends a closure that already has tiers into a separate overlay, reading the closure\'s tier files', async () => {
  const { copyFile, mkdir: mkdirp, readFile: read, writeFile: write } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'texture-tier-overlay-'));
  try {
    const source = path.join(root, 'closure');
    const overlay = path.join(root, 'overlay');
    await mkdirp(path.join(source, '3d/tiles'), { recursive: true });
    await mkdirp(path.join(source, 'images'), { recursive: true });
    await copyFile(path.join(import.meta.dirname, 'fixtures/albedo/rgb-present.uastc.ktx2'), path.join(source, 'images/a.ktx2'));
    let text = JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: '../../images/a.ktx2', mimeType: 'image/ktx2' }] });
    while (text.length % 4) text += ' ';
    const glb = Buffer.alloc(20 + text.length);
    glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(text.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); glb.write(text, 20);
    await write(path.join(source, '3d/tiles/road.glb'), glb);
    await write(path.join(source, '3d/manifest.json'), JSON.stringify({ staticLayers: [{ id: 'road', file: 'tiles/road.glb' }], tiles: [], vegetationTiles: [] }));
    await buildTextureTiers({ sourceRoot: source, variants: ['textures-256-uastc'] });
    const report = await buildTextureTiers({ sourceRoot: source, outputRoot: overlay, variants: ['textures-256-uastc'] });
    expect(report.variants['textures-256-uastc']).toMatchObject({ images: 1, reusedObjects: 1, producedObjects: 0 });
    const envelope = JSON.parse(await read(path.join(overlay, '3d/variants/manifest.json'), 'utf8'));
    expect(envelope.variants['textures-256-uastc'].file).toMatch(/^textures-256-uastc-[a-f0-9]{64}\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
