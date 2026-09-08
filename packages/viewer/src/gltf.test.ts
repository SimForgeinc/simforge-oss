import type { Texture } from 'three';
import { CompressedTexture, Light, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, RGBAFormat, RGBA_S3TC_DXT1_Format, Group } from 'three';
import {
  createDefaultContainer,
  KHR_SUPERCOMPRESSION_BASISLZ,
  read as readKtx2,
  VK_FORMAT_BC1_RGB_UNORM_BLOCK,
  VK_FORMAT_BC7_SRGB_BLOCK,
  VK_FORMAT_UNDEFINED,
  write as writeKtx2,
} from 'three/addons/libs/ktx-parse.module.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultContainer, read as readKtx2, write as writeKtx2, VK_FORMAT_BC7_UNORM_BLOCK } from 'ktx-parse';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
  collectResources,
  disposeResources,
  estimateResourceBytes,
  limitCompressedTextureMipmaps,
  parseMapGLTF,
  resourceDirectory,
  selectKtx2MipLevels,
  sharedTextures,
  textureDimensionForBudget,
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

afterEach(() => {
  sharedTextures.clear();
  vi.unstubAllGlobals();
});

describe('map lighting ownership', () => {
  it('excludes imported lights from every camera layer without hiding their authored mesh children or changing generic loads', async () => {
    // Three emits browser progress events while reading inline glTF buffers.
    vi.stubGlobal('ProgressEvent', Event);
    const document = {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_lights_punctual'],
      extensions: { KHR_lights_punctual: { lights: [{ type: 'spot' }, { type: 'point' }] } },
      scenes: [{ nodes: [0] }, { nodes: [2] }],
      scene: 0,
      nodes: [
        { name: 'Street_Light', extensions: { KHR_lights_punctual: { light: 0 } }, children: [1] },
        { name: 'Fixture', mesh: 0 },
        { extensions: { KHR_lights_punctual: { light: 1 } } },
      ],
      buffers: [{ byteLength: 36, uri: 'data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAA' }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 0.75, 1], roughnessFactor: 0.4 } }],
    };
    const buffer = new TextEncoder().encode(JSON.stringify(document)).buffer;
    const loader = new GLTFLoader();
    const map = await parseMapGLTF(loader, buffer, '');
    const generic = await loader.parseAsync(buffer, '');
    const camera = new PerspectiveCamera();
    camera.layers.enableAll();
    let importedLights = 0;
    for (const scene of map.scenes) scene.traverse(node => {
      if ((node as Light).isLight) {
        importedLights++;
        expect(node.layers.test(camera.layers)).toBe(false);
      }
    });
    expect(importedLights).toBe(2);
    const fixture = map.scene.getObjectByName('Fixture') as Mesh;
    const original = generic.scene.getObjectByName('Fixture') as Mesh;
    expect(fixture.parent?.name).toBe('Street_Light');
    expect(fixture.visible && fixture.parent?.visible && fixture.layers.test(camera.layers)).toBe(true);
    expect(fixture.geometry.attributes.position?.array).toEqual(original.geometry.attributes.position?.array);
    expect((fixture.material as MeshStandardMaterial).color).toEqual((original.material as MeshStandardMaterial).color);
    expect((fixture.material as MeshStandardMaterial).roughness).toBe(0.4);
    expect(generic.scene.getObjectByName('Street_Light')?.layers.test(camera.layers)).toBe(true);
    for (const scene of [...map.scenes, ...generic.scenes]) disposeResources(collectResources(scene));
  });
});

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

describe('compressed texture mip budgets', () => {
  it('fits a large map image set before allocating its authored high-detail mips', () => {
    const imageCount = 250;
    const bytesPerAsset = 1.5 * 1024 ** 3 * 0.5 / 28;
    const dimension = textureDimensionForBudget(imageCount, bytesPerAsset, 2048);
    expect(imageCount * dimension ** 2 * 4 / 3).toBeLessThanOrEqual(bytesPerAsset);
    expect(imageCount * (dimension * 2) ** 2 * 4 / 3).toBeGreaterThan(bytesPerAsset);
    expect(textureDimensionForBudget(imageCount, bytesPerAsset, 128)).toBe(128);
  });

  it('removes oversized encoded levels before the texture decoder sees them', () => {
    const container = createDefaultContainer();
    container.pixelWidth = 8;
    container.pixelHeight = 8;
    container.levelCount = 4;
    container.levels = [8, 4, 2, 1].map(size => ({
      levelData: new Uint8Array(size * size * 4).fill(size),
      uncompressedByteLength: size * size * 4,
    }));
    const encoded = writeKtx2(container);
    const selected = readKtx2(new Uint8Array(selectKtx2MipLevels(encoded.buffer as ArrayBuffer, 2).buffer));
    expect([selected.pixelWidth, selected.pixelHeight, selected.levelCount]).toEqual([2, 2, 2]);
    expect(selected.levels.map(level => [...level.levelData])).toEqual([
      [...new Uint8Array(16).fill(2)], [...new Uint8Array(4).fill(1)],
    ]);
  });

  it('decodes cropped non-block-aligned Basis mips as RGBA without resampling', () => {
    const container = createDefaultContainer();
    container.pixelWidth = 600;
    container.pixelHeight = 1000;
    container.levelCount = 4;
    container.supercompressionScheme = 1;
    container.levels = [0, 1, 2, 3].map(level => ({
      levelData: new Uint8Array(16).fill(level), uncompressedByteLength: 16,
    }));
    const selected = selectKtx2MipLevels(writeKtx2(container).buffer as ArrayBuffer, 128);
    const decoded = readKtx2(new Uint8Array(selected.buffer));
    expect(selected.forceRgba).toBe(true);
    expect([decoded.pixelWidth, decoded.pixelHeight]).toEqual([75, 125]);
    expect([...decoded.levels[0]!.levelData]).toEqual([...new Uint8Array(16).fill(3)]);
  });

  it('retains a legal BC base when the source is already GPU-compressed', () => {
    const container = createDefaultContainer();
    container.vkFormat = VK_FORMAT_BC7_UNORM_BLOCK;
    container.pixelWidth = 600;
    container.pixelHeight = 1000;
    container.levelCount = 4;
    container.levels = [0, 1, 2, 3].map(level => {
      const bytes = Math.ceil((600 >> level) / 4) * Math.ceil((1000 >> level) / 4) * 16;
      return { levelData: new Uint8Array(bytes).fill(level), uncompressedByteLength: bytes };
    });
    const selected = selectKtx2MipLevels(writeKtx2(container).buffer as ArrayBuffer, 128);
    const decoded = readKtx2(new Uint8Array(selected.buffer));
    expect(selected.forceRgba).toBe(false);
    expect([decoded.pixelWidth, decoded.pixelHeight]).toEqual([300, 500]);
    expect(decoded.levels[0]!.levelData).toEqual(container.levels[1]!.levelData);
  });

  it('keeps the authored lower mip chain and charges only its actual compressed footprint', () => {
    const texture = new CompressedTexture([
      { data: new Uint8Array(32), width: 2048, height: 1024 },
      { data: new Uint8Array(16), width: 1024, height: 512 },
      { data: new Uint8Array(8), width: 512, height: 256 },
    ], 2048, 1024, RGBA_S3TC_DXT1_Format);
    limitCompressedTextureMipmaps(texture, 1024);
    expect(texture.image).toEqual({ width: 1024, height: 512 });
    expect(texture.mipmaps.map(mip => [mip.width, mip.height])).toEqual([[1024, 512], [512, 256]]);
    expect(estimateResourceBytes({ geometries: [], materials: [], textures: [texture] })).toBe(24);
    texture.dispose();
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
