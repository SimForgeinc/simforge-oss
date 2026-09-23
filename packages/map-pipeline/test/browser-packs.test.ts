import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBrowserPacks, streamingOrder, uastcRgbMissing } from '../scripts/browser-packs.mjs';

const fixtures = path.join(import.meta.dirname, 'fixtures/albedo');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** A GLB whose JSON chunk uses `images` as base colour; the BIN chunk is filler. */
function glb(images: string[], filler: number): Buffer {
  const json = {
    asset: { version: '2.0' },
    images: images.map((uri) => ({ uri, mimeType: 'image/ktx2' })),
    textures: images.map((_, source) => ({ extensions: { KHR_texture_basisu: { source } } })),
    materials: images.map((_, index) => ({ pbrMetallicRoughness: { baseColorTexture: { index } } })),
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const bin = Buffer.alloc(filler + (4 - (filler % 4)) % 4, 7);
  const out = Buffer.alloc(12 + 8 + text.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(text.length, 12); out.writeUInt32LE(0x4e4f534a, 16); out.write(text, 20);
  out.writeUInt32LE(bin.length, 20 + text.length); out.writeUInt32LE(0x004e4942, 24 + text.length);
  bin.copy(out, 28 + text.length);
  return out;
}

const tile = (id: string, x: number, file: string) => ({
  id, gridX: x, gridZ: 0,
  bounds: { min: [x * 100, 0, 0], max: [x * 100 + 100, 10, 100] },
  lods: [{ level: 0, file, triangles: 1, fileSize: 1, geometricError: 0 }],
});

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'browser-packs-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function map(): Promise<{ missing: string; present: string }> {
  const missingBytes = await readFile(path.join(fixtures, 'rgb-missing.uastc.ktx2'));
  const presentBytes = await readFile(path.join(fixtures, 'rgb-present.uastc.ktx2'));
  const manifest = {
    version: '1.2.0',
    scene: { bounds: { min: [0, 0, 0], max: [300, 10, 100] }, totalTriangles: 3, gridDimensions: [3, 1], cellSize: [100, 100], origin: [0, 0, 0], lodLevels: 1, coordinateSystem: 'y-up' },
    staticLayers: [{ id: 'road', file: 'tiles/road.glb', triangles: 1, fileSize: 1 }],
    // The far cell is listed first: packs follow distance from the focus, not listing order.
    tiles: [tile('tile_2_0', 2, 'tiles/tile_2_0.lod0.glb'), tile('tile_1_0', 1, 'tiles/tile_1_0.lod0.glb')],
    vegetationTiles: [tile('veg_1_0', 1, 'tiles/veg_1_0.lod0.glb')],
  };
  const d3 = path.join(root, '3d');
  await mkdir(path.join(d3, 'tiles'), { recursive: true });
  await mkdir(path.join(d3, 'variants/objects'), { recursive: true });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(d3, 'manifest.json'), manifestBytes);
  await writeFile(path.join(d3, 'tiles/road.glb'), glb(['../../images/m.ktx2'], 64));
  await writeFile(path.join(d3, 'tiles/tile_1_0.lod0.glb'), glb(['../../images/p.ktx2'], 32));
  await writeFile(path.join(d3, 'tiles/tile_2_0.lod0.glb'), glb(['../../images/p.ktx2', '../../images/m.ktx2'], 16));
  await writeFile(path.join(d3, 'tiles/veg_1_0.lod0.glb'), glb(['../../images/v.ktx2'], 128));
  const objects: Record<string, Buffer> = { m: missingBytes, p: presentBytes, v: presentBytes };
  const variants: Record<string, unknown> = {};
  for (const codec of ['uastc', 'bc7']) {
    const id = `textures-256-${codec}`;
    const images: Record<string, unknown> = {};
    for (const [name, bytes] of Object.entries(objects)) {
      // The BC7 tier's objects are stand-ins (distinct bytes); classification reads the UASTC tier.
      const body = codec === 'uastc' ? bytes : Buffer.concat([bytes, Buffer.from(codec)]);
      const digest = sha256(body);
      await writeFile(path.join(d3, `variants/objects/${digest}.ktx2`), body);
      images[`../images/${name}.ktx2`] = { file: `variants/objects/${digest}.ktx2`, outputSha256: digest, bytes: body.length, codec, width: 4, height: 4 };
    }
    const assets = {
      'tiles/road.glb': { images: ['../images/m.ktx2'] },
      'tiles/tile_1_0.lod0.glb': { images: ['../images/p.ktx2'] },
      'tiles/tile_2_0.lod0.glb': { images: ['../images/m.ktx2', '../images/p.ktx2'] },
      'tiles/veg_1_0.lod0.glb': { images: ['../images/v.ktx2'] },
    };
    const index = Buffer.from(`${JSON.stringify({ schemaVersion: 1, id, codec, longestEdgePx: 256, sourceManifestSha256: sha256(manifestBytes), images, assets })}\n`);
    const outputSha256 = sha256(index);
    const file = `${id}-${outputSha256}.json`;
    await writeFile(path.join(d3, 'variants', file), index);
    variants[id] = { id, schemaVersion: 1, file, outputSha256, digest: `sha256-${outputSha256}`, sourceManifestSha256: sha256(manifestBytes), bytes: index.length };
  }
  await writeFile(path.join(d3, 'variants/manifest.json'), JSON.stringify({ schemaVersion: 1, sourceManifestSha256: sha256(manifestBytes), variants }));
  return { missing: sha256(missingBytes), present: sha256(presentBytes) };
}

describe('uastcRgbMissing', () => {
  it('classifies a mask-only albedo from the UASTC base level', async () => {
    expect(await uastcRgbMissing(await readFile(path.join(fixtures, 'rgb-missing.uastc.ktx2')))).toBe(true);
    expect(await uastcRgbMissing(await readFile(path.join(fixtures, 'rgb-present.uastc.ktx2')))).toBe(false);
  });
});

describe('streamingOrder', () => {
  it('puts roads first, then city cells nearest the initial focus, then vegetation', () => {
    const order = streamingOrder({
      scene: { bounds: { min: [0, 0, 0], max: [300, 10, 100] } },
      staticLayers: [{ file: 'tiles/road.glb' }],
      tiles: [tile('far', 2, 'tiles/far.glb'), tile('near', 1, 'tiles/near.glb')],
      vegetationTiles: [tile('veg', 1, 'tiles/veg.glb')],
    });
    expect(order.core).toEqual(['tiles/road.glb', 'tiles/near.glb', 'tiles/far.glb']);
    expect(order.vegetation).toEqual(['tiles/veg.glb']);
  });
});

describe('buildBrowserPacks', () => {
  it('packs every member of each tier into content-addressed chunks, shares geometry chunks across tiers and records albedo', async () => {
    await map();
    const report = await buildBrowserPacks({ sourceRoot: root, chunkBytes: 1 << 20 });
    expect(Object.keys(report.packs).sort()).toEqual(['textures-256-bc7', 'textures-256-uastc']);
    const envelope = JSON.parse(await readFile(path.join(root, '3d/variants/manifest.json'), 'utf8'));
    const indexes: Record<string, { chunks: { file: string; sha256: string; kind: string; group: string }[]; members: Record<string, [number, number, number]>; albedo: { rgbMissing: string[] }; tier: { outputSha256: string } }> = {};
    for (const id of ['textures-256-bc7', 'textures-256-uastc']) {
      const reference = envelope.variants[`browser-pack:${id}`];
      const bytes = await readFile(path.join(root, '3d/variants', reference.file));
      expect(sha256(bytes)).toBe(reference.outputSha256);
      indexes[id] = JSON.parse(bytes.toString('utf8'));
      expect(indexes[id]!.tier.outputSha256).toBe(envelope.variants[id].outputSha256);
      // Every member's bytes are exactly the file's, at its recorded range.
      for (const [member, [chunk, offset, length]] of Object.entries(indexes[id]!.members)) {
        const info = indexes[id]!.chunks[chunk]!;
        const data = await readFile(path.join(root, '3d', info.file));
        expect(sha256(data)).toBe(info.sha256);
        expect(data.subarray(offset, offset + length).equals(await readFile(path.join(root, '3d', member)))).toBe(true);
      }
      // Streaming order: the road leads the first core geometry chunk, the near cell precedes the far one.
      const core = indexes[id]!.members;
      expect(core['tiles/road.glb']![1]).toBe(16); // right after the chunk header
      expect(core['tiles/tile_1_0.lod0.glb']![1]).toBeLessThan(core['tiles/tile_2_0.lod0.glb']![1]);
      expect(indexes[id]!.chunks[core['tiles/veg_1_0.lod0.glb']![0]]!.group).toBe('vegetation');
    }
    // Every chunk starts with the pack magic, so no chunk equals a member it holds.
    for (const chunk of indexes['textures-256-bc7']!.chunks) {
      const data = await readFile(path.join(root, '3d', chunk.file));
      expect(data.subarray(0, 8).toString('ascii')).toBe('SFBPACK1');
    }
    const geometry = (id: string) => indexes[id]!.chunks.filter((chunk) => chunk.kind === 'geometry').map((chunk) => chunk.sha256);
    expect(geometry('textures-256-bc7')).toEqual(geometry('textures-256-uastc'));
    // The mask-only image (m) is flagged in both tiers; the others are not.
    expect(indexes['textures-256-uastc']!.albedo.rgbMissing).toHaveLength(1);
    expect(indexes['textures-256-bc7']!.albedo.rgbMissing).toHaveLength(1);
    // Rebuilding is byte-identical: same index files, no new chunk files.
    const before = await readdir(path.join(root, '3d/packs/objects'));
    await buildBrowserPacks({ sourceRoot: root, chunkBytes: 1 << 20 });
    expect(await readdir(path.join(root, '3d/packs/objects'))).toEqual(before);
    expect(JSON.parse(await readFile(path.join(root, '3d/variants/manifest.json'), 'utf8'))).toEqual(envelope);
  });

  it('refuses a variant manifest bound to another map manifest', async () => {
    await map();
    const file = path.join(root, '3d/variants/manifest.json');
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...envelope, sourceManifestSha256: 'f'.repeat(64) }));
    await expect(buildBrowserPacks({ sourceRoot: root })).rejects.toThrow('another map manifest');
  });
});
