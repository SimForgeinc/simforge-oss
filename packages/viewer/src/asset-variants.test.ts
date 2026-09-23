import { describe, expect, it } from 'vitest';
import { allowsSourceAssetFallback, isCityAssetVariantManifest, probeTextureCapabilities, selectAssetVariant, selectTextureTier, type CityAssetVariantManifest } from './asset-variants';

const manifest: CityAssetVariantManifest = {
  schemaVersion: 1,
  sourceManifestSha256: 'abc',
  variants: {
    'geometry-only': {
      id: 'geometry-only', generatedAt: '2026-01-01T00:00:00Z',
      generator: { name: 'test', version: '1', command: 'test' },
      files: { 'tiles/road.glb': { file: 'variants/geometry-only/road.glb', sourceSha256: 'a', outputSha256: 'b', bytes: 12 } },
    },
    ktx2: {
      id: 'ktx2', generatedAt: '2026-01-01T00:00:00Z',
      generator: { name: 'test', version: '1', command: 'test' },
      files: { 'tiles/road.glb': { file: 'variants/ktx2/road.glb', sourceSha256: 'a', outputSha256: 'c', bytes: 9 } },
    },
  },
};

describe('city asset variants', () => {
  it('serves the source asset when nothing better is asked for or available', () => {
    expect(selectAssetVariant(manifest, 'tiles/road.glb', 'auto', { ktx2Ready: false }).variant).toBe('original');
    expect(selectAssetVariant(manifest, 'tiles/missing.glb', 'geometry-only', { ktx2Ready: false })).toEqual({ variant: 'original', file: 'tiles/missing.glb' });
    expect(selectAssetVariant(null, 'tiles/road.glb', 'geometry-only', { ktx2Ready: false }).variant).toBe('original');
  });

  it('honours an explicit geometry-only request, which the progressive road bootstrap makes', () => {
    expect(selectAssetVariant(manifest, 'tiles/road.glb', 'geometry-only', { ktx2Ready: false })).toEqual({
      variant: 'geometry-only',
      file: 'variants/geometry-only/road.glb',
      fallbackFile: undefined,
      sha256: 'b',
    });
  });

  it('never selects KTX2 without an initialized transcoder', () => {
    expect(selectAssetVariant(manifest, 'tiles/road.glb', 'ktx2', { ktx2Ready: false }).variant).toBe('original');
    expect(selectAssetVariant(manifest, 'tiles/road.glb', 'auto', { ktx2Ready: true }).variant).toBe('ktx2');
  });

  it('falls back to the source asset only when a derivative was the thing that failed', () => {
    expect(allowsSourceAssetFallback('geometry-only')).toBe(true);
    expect(allowsSourceAssetFallback('ktx2')).toBe(true);
    expect(allowsSourceAssetFallback('original')).toBe(false);
    expect(allowsSourceAssetFallback('textures-512-bc7')).toBe(false);
  });

  it('rejects derivative paths that escape the map asset root', () => {
    const unsafe = structuredClone(manifest);
    unsafe.variants['geometry-only']!.files['tiles/road.glb']!.file = '../source/road.glb';
    expect(selectAssetVariant(unsafe, 'tiles/road.glb', 'geometry-only', { ktx2Ready: false }).variant).toBe('original');
    const unsafeFallback = structuredClone(manifest);
    unsafeFallback.variants['geometry-only']!.files['tiles/road.glb']!.fallbackFile = 'https://example.invalid/road.glb';
    expect(selectAssetVariant(unsafeFallback, 'tiles/road.glb', 'geometry-only', { ktx2Ready: false })).toEqual({
      variant: 'geometry-only',
      file: 'variants/geometry-only/road.glb',
      fallbackFile: undefined,
      sha256: 'b',
    });
  });

  it('validates the versioned manifest envelope', () => {
    expect(isCityAssetVariantManifest(manifest)).toBe(true);
    expect(isCityAssetVariantManifest({ schemaVersion: 2, variants: {} })).toBe(false);
  });
});

it('selects only native formats exposed by the actual context and reports codec and device downgrades', () => {
  const extensions = new Set(['WEBGL_compressed_texture_astc']);
  let maxTextureSize = 4096;
  const gl = {
    MAX_TEXTURE_SIZE: 0x0d33,
    getParameter: () => maxTextureSize,
    getExtension: (name: string) => extensions.has(name) ? {} : null,
  } as unknown as WebGL2RenderingContext;
  expect(selectTextureTier('medium', probeTextureCapabilities(gl))).toMatchObject({ actual: 'medium', codec: 'astc', variantId: 'textures-512-astc', downgradeReason: null });
  extensions.clear();
  expect(selectTextureTier('medium', probeTextureCapabilities(gl))).toMatchObject({ actual: 'medium', codec: 'uastc', variantId: 'textures-512-uastc', downgradeReason: expect.stringContaining('unavailable') });
  maxTextureSize = 256;
  expect(selectTextureTier('medium', probeTextureCapabilities(gl))).toMatchObject({ actual: 'low', codec: 'uastc', longestEdgePx: 256, downgradeReason: expect.stringContaining('MAX_TEXTURE_SIZE') });
  maxTextureSize = 4096;
  maxTextureSize = 128;
  expect(() => selectTextureTier('medium', probeTextureCapabilities(gl))).toThrow('minimum Low');
});

it('cooks Low for the GPU too: BC7, then ASTC, then ETC2, and transcodes UASTC only when none is exposed', () => {
  const extensions = new Set(['EXT_texture_compression_bptc', 'WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc']);
  const gl = {
    MAX_TEXTURE_SIZE: 0x0d33,
    getParameter: () => 4096,
    getExtension: (name: string) => extensions.has(name) ? {} : null,
  } as unknown as WebGL2RenderingContext;
  expect(selectTextureTier('low', probeTextureCapabilities(gl))).toMatchObject({ actual: 'low', codec: 'bc7', variantId: 'textures-256-bc7', downgradeReason: null });
  extensions.delete('EXT_texture_compression_bptc');
  expect(selectTextureTier('low', probeTextureCapabilities(gl))).toMatchObject({ codec: 'astc', variantId: 'textures-256-astc', downgradeReason: null });
  extensions.delete('WEBGL_compressed_texture_astc');
  expect(selectTextureTier('low', probeTextureCapabilities(gl))).toMatchObject({ codec: 'etc2', variantId: 'textures-256-etc2', downgradeReason: null });
  expect(selectTextureTier('medium', probeTextureCapabilities(gl))).toMatchObject({ codec: 'etc2', variantId: 'textures-512-etc2' });
  extensions.clear();
  expect(selectTextureTier('low', probeTextureCapabilities(gl))).toMatchObject({ codec: 'uastc', variantId: 'textures-256-uastc', downgradeReason: expect.stringContaining('transcoding portable UASTC') });
});
