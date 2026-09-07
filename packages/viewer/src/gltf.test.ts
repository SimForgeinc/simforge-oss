import type { Texture } from 'three';
import { CompressedTexture, Mesh, MeshStandardMaterial, PlaneGeometry, RGBAFormat, RGBA_S3TC_DXT1_Format, Group } from 'three';
import {
  createDefaultContainer,
  KHR_SUPERCOMPRESSION_BASISLZ,
  read as readKtx2,
  VK_FORMAT_BC1_RGB_UNORM_BLOCK,
  VK_FORMAT_BC7_SRGB_BLOCK,
  VK_FORMAT_UNDEFINED,
  write as writeKtx2,
} from 'three/addons/libs/ktx-parse.module.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectResources,
  disposeResources,
  estimateResourceBytes,
  limitCompressedTextureMipmaps,
  resourceDirectory,
  selectKtx2MipLevels,
  sharedTextures,
} from './gltf';

function decoded(bytes: number): CompressedTexture {
  const texture = new CompressedTexture([{ data: new Uint8Array(bytes), width: 4, height: 4 }], 4, 4, RGBA_S3TC_DXT1_Format);
  texture.needsUpdate = true;
  return texture;
}

function cellWith(texture: CompressedTexture): Group {
  const group = new Group();
  const material = new MeshStandardMaterial({ map: texture });
  group.add(new Mesh(new PlaneGeometry(1, 1), material));
  return group;
}

afterEach(() => sharedTextures.clear());

describe('shared KTX2 texture cache', () => {
  it('decodes a URL once and hands every requester a clone that shares the source', async () => {
    let fetches = 0;
    const fetchTexture = async () => {
      fetches += 1;
      return decoded(64);
    };
    const first = await sharedTextures.acquire('images/a.ktx2', fetchTexture);
    const second = await sharedTextures.acquire('images/a.ktx2', fetchTexture);
    expect(fetches).toBe(1);
    expect(first).not.toBe(second);
    expect(first.source).toBe(second.source);
    expect(sharedTextures.stats()).toMatchObject({ textures: 1, refs: 2, bytes: 64, hits: 1, misses: 1 });
  });

  it('keeps the decoded texture until the last cell holding it is disposed', async () => {
    const original = decoded(64);
    let disposed = 0;
    original.addEventListener('dispose', () => { disposed += 1; });
    const fetchTexture = async () => original;
    const cellA = cellWith(await sharedTextures.acquire('images/a.ktx2', fetchTexture));
    const cellB = cellWith(await sharedTextures.acquire('images/a.ktx2', fetchTexture));
    const resourcesA = collectResources(cellA);
    const resourcesB = collectResources(cellB);
    // Fair share while both cells hold it; the full size once one is gone.
    expect(estimateResourceBytes(resourcesA)).toBe(32 + estimateResourceBytes({ geometries: resourcesA.geometries, materials: [], textures: [] }));
    disposeResources(resourcesA);
    expect(disposed).toBe(0);
    expect(sharedTextures.stats()).toMatchObject({ textures: 1, refs: 1 });
    expect(estimateResourceBytes(resourcesB)).toBe(64 + estimateResourceBytes({ geometries: resourcesB.geometries, materials: [], textures: [] }));
    disposeResources(resourcesB);
    expect(disposed).toBe(1);
    expect(sharedTextures.stats()).toMatchObject({ textures: 0, refs: 0 });
  });

  it('releases a source once per asset even when the asset holds several clones of it', async () => {
    const fetchTexture = async () => decoded(16);
    const clone = await sharedTextures.acquire('images/a.ktx2', fetchTexture);
    const transformed = clone.clone(); // KHR_texture_transform clones inside GLTFLoader
    const group = new Group();
    group.add(new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ map: clone, normalMap: transformed })));
    const other = cellWith(await sharedTextures.acquire('images/a.ktx2', fetchTexture));
    disposeResources(collectResources(group));
    expect(sharedTextures.stats()).toMatchObject({ textures: 1, refs: 1 });
    disposeResources(collectResources(other));
    expect(sharedTextures.stats()).toMatchObject({ textures: 0, refs: 0 });
  });

  it('forgets a failed fetch so the next requester retries', async () => {
    await expect(sharedTextures.acquire('images/bad.ktx2', async () => { throw new Error('404'); })).rejects.toThrow('404');
    expect(sharedTextures.stats()).toMatchObject({ textures: 0, refs: 0 });
    const texture = await sharedTextures.acquire('images/bad.ktx2', async () => decoded(8));
    expect(texture.source).toBeDefined();
    expect(sharedTextures.stats()).toMatchObject({ textures: 1, refs: 1, misses: 2 });
  });
});

describe('resourceDirectory', () => {
  it('yields the directory URL GLTFLoader resolves ../../images/<sha>.ktx2 against', () => {
    expect(resourceDirectory('http://h/maps/el-camino/3d/tiles/tile_3_2.lod0.glb')).toBe('http://h/maps/el-camino/3d/tiles/');
    expect(resourceDirectory('file:///x/3d/tiles/road.glb?v=1')).toBe('file:///x/3d/tiles/');
    expect(new URL('../../images/abc.ktx2', resourceDirectory('http://h/maps/el-camino/3d/tiles/road.glb')).href).toBe('http://h/maps/el-camino/images/abc.ktx2');
  });
});

function mipChain(width: number, height: number): { data: Uint8Array; width: number; height: number }[] {
  const mips: { data: Uint8Array; width: number; height: number }[] = [];
  for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    mips.push({ data: new Uint8Array(Math.max(1, w >> 2) * Math.max(1, h >> 2) * 8), width: w, height: h });
    if (w === 1 && h === 1) break;
  }
  return mips;
}

describe('limitCompressedTextureMipmaps', () => {
  it('makes the largest authored level within the renderer limit the base and updates the image size', () => {
    const texture = new CompressedTexture(mipChain(16384, 8192), 16384, 8192, RGBA_S3TC_DXT1_Format);
    limitCompressedTextureMipmaps(texture, 8192);
    expect(texture.mipmaps[0]).toMatchObject({ width: 8192, height: 4096 });
    expect(texture.image).toEqual({ width: 8192, height: 4096 });
    expect(texture.mipmaps.length).toBe(14);
    expect(texture.mipmaps.at(-1)).toMatchObject({ width: 1, height: 1 });
  });

  it('leaves a texture that already fits untouched', () => {
    const mips = mipChain(4096, 4096);
    const texture = new CompressedTexture(mips, 4096, 4096, RGBA_S3TC_DXT1_Format);
    const image = texture.image;
    limitCompressedTextureMipmaps(texture, 8192);
    expect(texture.mipmaps).toBe(mips);
    expect(texture.image).toBe(image);
  });

  it('retreats a block-compressed crop to the nearest block-aligned level', () => {
    const mips = [48, 24, 12, 6, 3, 1].map((size) => ({ data: new Uint8Array(8), width: size, height: size }));
    const texture = new CompressedTexture(mips, 48, 48, RGBA_S3TC_DXT1_Format);
    limitCompressedTextureMipmaps(texture, 6);
    expect(texture.mipmaps[0]).toMatchObject({ width: 12, height: 12 });
    expect(texture.image).toEqual({ width: 12, height: 12 });
  });

  it('crops uncompressed RGBA output to any level since it has no block constraint', () => {
    const mips = [48, 24, 12, 6, 3, 1].map((size) => ({ data: new Uint8Array(size * size * 4), width: size, height: size }));
    // KTX2Loader's uncompressed output is a CompressedTexture whose format is RGBAFormat.
    const texture = new CompressedTexture(mips, 48, 48);
    (texture as Texture).format = RGBAFormat;
    limitCompressedTextureMipmaps(texture, 6);
    expect(texture.mipmaps[0]).toMatchObject({ width: 6, height: 6 });
  });
});

/**
 * A KTX2 file with a full mip chain of 8-byte 4x4 blocks (the BC1/ETC1S
 * layout), each level's bytes filled with its level index + 1 so a test can
 * tell which authored level ended up as the base.
 */
function ktx2(width: number, height: number, vkFormat: number, options: { basisLz?: boolean } = {}): ArrayBuffer {
  const container = createDefaultContainer();
  container.vkFormat = vkFormat;
  container.pixelWidth = width;
  container.pixelHeight = height;
  container.dataFormatDescriptor[0]!.texelBlockDimension = [3, 3, 0, 0];
  const levels = 1 + Math.floor(Math.log2(Math.max(width, height)));
  for (let level = 0; level < levels; level++) {
    const blocks = Math.ceil(Math.max(1, width >> level) / 4) * Math.ceil(Math.max(1, height >> level) / 4);
    const data = new Uint8Array(blocks * 8).fill(level + 1);
    container.levels.push({ levelData: data, uncompressedByteLength: data.byteLength });
  }
  container.levelCount = levels;
  if (options.basisLz) {
    container.supercompressionScheme = KHR_SUPERCOMPRESSION_BASISLZ;
    container.globalData = {
      endpointCount: 1,
      selectorCount: 1,
      imageDescs: Array.from({ length: levels }, (_, level) => ({
        imageFlags: 0, rgbSliceByteOffset: 0, rgbSliceByteLength: 16, alphaSliceByteOffset: level, alphaSliceByteLength: 0,
      })),
      endpointsData: new Uint8Array(4),
      selectorsData: new Uint8Array(4),
      tablesData: new Uint8Array(4),
      extendedData: new Uint8Array(0),
    };
  }
  return writeKtx2(container, { keepWriter: true }).buffer as ArrayBuffer;
}

describe('selectKtx2MipLevels', () => {
  it('returns the original buffer when every level fits', () => {
    const buffer = ktx2(256, 256, VK_FORMAT_UNDEFINED);
    const selected = selectKtx2MipLevels(buffer, 256);
    expect(selected.buffer).toBe(buffer);
    expect(selected.forceRgba).toBe(false);
  });

  it('rewrites an oversized Basis container so the transcoder only sees legal levels', () => {
    const selected = selectKtx2MipLevels(ktx2(256, 128, VK_FORMAT_UNDEFINED), 128);
    const container = readKtx2(new Uint8Array(selected.buffer));
    expect(selected.forceRgba).toBe(false);
    expect(container.pixelWidth).toBe(128);
    expect(container.pixelHeight).toBe(64);
    expect(container.levelCount).toBe(8);
    expect(container.levels.length).toBe(8);
    // Level data is the authored mip, shifted down one level, not resampled.
    expect(container.levels[0]!.levelData[0]).toBe(2);
    expect(container.levels[0]!.levelData.byteLength).toBe(32 * 16 * 8);
  });

  it('keeps BasisLZ image descriptors in step with the retained levels', () => {
    const selected = selectKtx2MipLevels(ktx2(256, 256, VK_FORMAT_UNDEFINED, { basisLz: true }), 64);
    const container = readKtx2(new Uint8Array(selected.buffer));
    expect(container.levelCount).toBe(7);
    expect(container.globalData?.imageDescs.length).toBe(7);
    expect(container.globalData?.imageDescs[0]?.alphaSliceByteOffset).toBe(2);
  });

  it('asks for RGBA when the cropped Basis base is not block-aligned', () => {
    const selected = selectKtx2MipLevels(ktx2(24, 24, VK_FORMAT_UNDEFINED), 6);
    expect(selected.forceRgba).toBe(true);
    expect(readKtx2(new Uint8Array(selected.buffer)).pixelWidth).toBe(6);
  });

  it('retains the nearest block-aligned level for data that is already BC', () => {
    for (const vkFormat of [VK_FORMAT_BC1_RGB_UNORM_BLOCK, VK_FORMAT_BC7_SRGB_BLOCK]) {
      const selected = selectKtx2MipLevels(ktx2(24, 24, vkFormat), 6);
      expect(selected.forceRgba).toBe(false);
      expect(readKtx2(new Uint8Array(selected.buffer)).pixelWidth).toBe(12);
    }
  });

  it('does not rewrite BC data that already fits, whatever its alignment', () => {
    const buffer = ktx2(6, 6, VK_FORMAT_BC7_SRGB_BLOCK);
    expect(selectKtx2MipLevels(buffer, 8).buffer).toBe(buffer);
  });
});
