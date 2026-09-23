import { describe, expect, it, vi } from 'vitest';
import { MapPackReader, parseBrowserPackIndex, type BrowserPackIndex } from './map-pack';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const MANIFEST = 'c'.repeat(64);
const TIER = 'd'.repeat(64);
const BASE = 'https://studio.test/api/simforge/maps/usmap_x/browser-assets/3d/';

function pack(): { index: BrowserPackIndex; bytes: Map<string, Uint8Array> } {
  const geometry = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const textures = new Uint8Array([9, 8, 7, 6]);
  const index: BrowserPackIndex = {
    schema: 'simforge.map-browser-pack.v1',
    revision: 'browser-pack-v1',
    id: 'textures-256-bc7',
    sourceManifestSha256: MANIFEST,
    tier: { id: 'textures-256-bc7', outputSha256: TIER },
    focus: [0, 0, 0],
    chunks: [
      { file: `packs/objects/${SHA_A}.bin`, sha256: SHA_A, bytes: 6, group: 'core', kind: 'geometry' },
      { file: `packs/objects/${SHA_B}.bin`, sha256: SHA_B, bytes: 4, group: 'core', kind: 'textures' },
    ],
    members: {
      'tiles/road.glb': [0, 0, 4],
      'tiles/tile_0_0.lod0.glb': [0, 4, 2],
      'variants/objects/e.ktx2': [1, 0, 3],
      'variants/objects/f.ktx2': [1, 3, 1],
    },
    albedo: { classifiedFrom: 'textures-256-uastc', sources: 2, rgbMissing: ['variants/objects/f.ktx2'] },
  };
  return { index, bytes: new Map([[`${BASE}packs/objects/${SHA_A}.bin`, geometry], [`${BASE}packs/objects/${SHA_B}.bin`, textures]]) };
}

const expected = { tierId: 'textures-256-bc7', tierOutputSha256: TIER, sourceManifestSha256: MANIFEST };

describe('parseBrowserPackIndex', () => {
  it('accepts a pack bound to the selected tier and manifest', () => {
    expect(parseBrowserPackIndex(pack().index, expected).id).toBe('textures-256-bc7');
  });

  it('refuses a pack bound to another tier index, manifest or tier', () => {
    const { index } = pack();
    expect(() => parseBrowserPackIndex(index, { ...expected, tierOutputSha256: MANIFEST })).toThrow('another tier index');
    expect(() => parseBrowserPackIndex(index, { ...expected, sourceManifestSha256: TIER })).toThrow('another map manifest');
    expect(() => parseBrowserPackIndex(index, { ...expected, tierId: 'textures-512-bc7' })).toThrow('another tier');
  });

  it('refuses ranges outside their chunk and unsafe member paths', () => {
    const out = pack().index;
    out.members['tiles/road.glb'] = [0, 4, 4];
    expect(() => parseBrowserPackIndex(out, expected)).toThrow('range out of chunk');
    const unsafe = pack().index;
    unsafe.members['../secret'] = [0, 0, 1];
    expect(() => parseBrowserPackIndex(unsafe, expected)).toThrow('unsafe member');
    const renamed = pack().index;
    renamed.chunks[0]!.file = 'packs/objects/other.bin';
    expect(() => parseBrowserPackIndex(renamed, expected)).toThrow('bad chunk');
  });
});

describe('MapPackReader', () => {
  it('serves every member of a chunk from one read, and drops the chunk once all were read', async () => {
    const { index, bytes } = pack();
    const load = vi.fn(async (url: string) => bytes.get(url)!.slice().buffer);
    const reader = new MapPackReader(index, BASE, load);
    const [road, tile] = await Promise.all([
      reader.read(`${BASE}tiles/road.glb`),
      reader.read(`${BASE}tiles/tile_0_0.lod0.glb`),
    ]);
    expect([...new Uint8Array(road)]).toEqual([1, 2, 3, 4]);
    expect([...new Uint8Array(tile)]).toEqual([5, 6]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(reader.stats()).toMatchObject({ chunksRead: 1, memberReads: 2, residentChunkBytes: 0 });
    // A re-read (evicted tile wanted again) reads the chunk again and does not pin it.
    await reader.read(`${BASE}tiles/road.glb`);
    expect(load).toHaveBeenCalledTimes(2);
    expect(reader.stats().residentChunkBytes).toBe(0);
  });

  it('hands out private copies callers may transfer', async () => {
    const { index, bytes } = pack();
    const reader = new MapPackReader(index, BASE, async (url) => bytes.get(url)!.slice().buffer);
    const first = await reader.read(`${BASE}variants/objects/e.ktx2`);
    new Uint8Array(first).fill(0);
    const again = await reader.read(`${BASE}variants/objects/e.ktx2`);
    expect([...new Uint8Array(again)]).toEqual([9, 8, 7]);
  });

  it('runs the decoder once per texture chunk and serves decoded ranges', async () => {
    const { index, bytes } = pack();
    const decode = vi.fn(async (_buffer: ArrayBuffer, members: readonly { path: string }[]) => ({
      buffer: new Uint8Array([42, 42, 42, 42, 42, 43, 43]).buffer,
      ranges: new Map(members.map((member) => [member.path, member.path.endsWith('e.ktx2') ? [0, 5] as const : [5, 2] as const])),
    }));
    const reader = new MapPackReader(index, BASE, async (url) => bytes.get(url)!.slice().buffer, decode);
    const [e, f, road] = await Promise.all([
      reader.read(`${BASE}variants/objects/e.ktx2`),
      reader.read(`${BASE}variants/objects/f.ktx2`),
      reader.read(`${BASE}tiles/road.glb`),
    ]);
    expect(new Uint8Array(e)).toHaveLength(5);
    expect([...new Uint8Array(f)]).toEqual([43, 43]);
    expect([...new Uint8Array(road)]).toEqual([1, 2, 3, 4]);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('knows its members and the ingest albedo classification, and nothing else', () => {
    const { index } = pack();
    const reader = new MapPackReader(index, BASE, async () => new ArrayBuffer(0));
    expect(reader.has(`${BASE}tiles/road.glb`)).toBe(true);
    expect(reader.has(`${BASE}tiles/other.glb`)).toBe(false);
    expect(reader.has('https://elsewhere.test/api/simforge/maps/usmap_x/browser-assets/3d/tiles/road.glb')).toBe(false);
    expect(reader.albedoRgbMissingFor(`${BASE}variants/objects/f.ktx2`)).toBe(true);
    expect(reader.albedoRgbMissingFor(`${BASE}variants/objects/e.ktx2`)).toBe(false);
    expect(reader.albedoRgbMissingFor(`${BASE}variants/objects/zzz.ktx2`)).toBeNull();
  });

  it('rejects a chunk whose size does not match the index', async () => {
    const { index } = pack();
    const reader = new MapPackReader(index, BASE, async () => new ArrayBuffer(3));
    await expect(reader.read(`${BASE}tiles/road.glb`)).rejects.toThrow('index says 6');
  });
});
