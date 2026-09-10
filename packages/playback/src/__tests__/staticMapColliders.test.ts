import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  loadStaticMapColliders,
  requireReadyStaticColliderBundle,
  resetStaticColliderCacheForTests,
  type StaticColliderBundle,
} from '../staticMapColliders';

const SOURCE_BYTES = new TextEncoder().encode('{"map":"test"}\n');
const SOURCE_HASH = createHash('sha256').update(SOURCE_BYTES).digest('hex');
const DIGEST = `sha256-${'b'.repeat(64)}`;

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'simforge.static-map-colliders/v1',
    mapId: 'test-map',
    sourceManifestSha256: SOURCE_HASH,
    sources: [{ id: 'tile-0', file: 'tile.glb', declaredBytes: 1234 }],
    colliders: [{
      id: 'tile-0/1',
      class: 'building',
      obb: { center: { x: 10, z: 20 }, lengthM: 8, widthM: 6, headingRad: 0 },
    }],
    statistics: {
      sourceTiles: 1,
      accepted: 1,
      rejectedRoadOverlap: 0,
      ignored: 2,
      classes: { building: 1, wall: 0, barrier: 0, prop: 0, 'road-boundary': 0 },
    },
    digest: DIGEST,
    ...overrides,
  };
}

function fixtureFetcher(value: Record<string, unknown>, calls: string[]): typeof fetch {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const outputSha256 = createHash('sha256').update(bytes).digest('hex');
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/3d/manifest.json')) return new Response(SOURCE_BYTES);
    if (url.endsWith('/variants/manifest.json')) return Response.json({
      sourceManifestSha256: SOURCE_HASH,
      variants: { 'static-colliders': { schemaVersion: 1, file: 'static-colliders-v1.json', digest: DIGEST, outputSha256 } },
    });
    return new Response(bytes);
  }) as typeof fetch;
}

describe('precomputed static map colliders', () => {
  it('loads and validates one compact artifact, then reuses the map cache', async () => {
    resetStaticColliderCacheForTests();
    const calls: string[] = [];
    const fetcher = fixtureFetcher(artifact(), calls);
    const first = await loadStaticMapColliders('/dev-assets/test-map/3d/manifest.json', fetcher);
    const second = await loadStaticMapColliders('/dev-assets/test-map/3d/manifest.json', fetcher);

    expect(first).toBe(second);
    expect(first.colliders).toEqual([{
      id: 'tile-0/1', class: 'building',
      obb: { center: { x: 10, z: 20 }, lengthM: 8, widthM: 6, headingRad: 0 },
    }]);
    expect(first.diagnostics).toMatchObject({ status: 'ready', accepted: 1, sourceTiles: 1, digest: DIGEST });
    expect(calls).toHaveLength(3);
    expect(calls.every((url) => !url.endsWith('.glb'))).toBe(true);
  });

  it('drops a map-wide road-boundary slab from an already-published artifact', async () => {
    resetStaticColliderCacheForTests();
    const slab = {
      id: 'canonical-master/2426', class: 'road-boundary',
      obb: { center: { x: 171.5, z: -115.9 }, lengthM: 429.7, widthM: 452.1, headingRad: 0 },
    };
    const kerb = {
      id: 'canonical-master/7', class: 'road-boundary',
      obb: { center: { x: 40, z: -20 }, lengthM: 12, widthM: 0.2, headingRad: 0.3 },
    };
    const building = { id: 'canonical-master/2518', class: 'building', obb: { center: { x: 259, z: -252 }, lengthM: 5.5, widthM: 4.8, headingRad: 0.58 } };
    const fetcher = fixtureFetcher(artifact({
      sources: [{ id: 'canonical-master', file: 'master.gltf', declaredBytes: 1 }],
      colliders: [slab, building, kerb],
      statistics: { sourceTiles: 1, accepted: 3, rejectedRoadOverlap: 0, ignored: 981, classes: { building: 1, wall: 0, barrier: 0, prop: 0, 'road-boundary': 2 } },
    }), []);
    const result = await loadStaticMapColliders('/dev-assets/rfs/3d/manifest.json', fetcher);
    expect(result.colliders).toEqual([building, kerb]);
    expect(result.diagnostics).toMatchObject({ status: 'ready', accepted: 2, ignored: 982, classes: { building: 1, 'road-boundary': 1 } });
  });

  it('fails immediately with diagnostics when the derivative is absent', async () => {
    resetStaticColliderCacheForTests();
    const result = await loadStaticMapColliders('/dev-assets/missing/3d/manifest.json', (async () => new Response('', { status: 404 })) as typeof fetch);
    expect(result.colliders).toEqual([]);
    expect(result.diagnostics).toMatchObject({ status: 'unavailable', warning: expect.stringContaining('(404)') });
  });

  it('rejects malformed and map-mismatched artifacts without GLB fallback', async () => {
    resetStaticColliderCacheForTests();
    const calls: string[] = [];
    const malformed = artifact({ sourceManifestSha256: 'd'.repeat(64) });
    const result = await loadStaticMapColliders('/dev-assets/test-map/3d/manifest.json', fixtureFetcher(malformed, calls));
    expect(result.colliders).toEqual([]);
    expect(result.diagnostics.warning).toContain('different map bundle');
    expect(calls).toHaveLength(3);
  });
});

describe('legacy static map collider runtime', () => {
  const readyBundle = {
    colliders: [{
      id: 'building-1',
      class: 'building',
      obb: { center: { x: 12, z: 4 }, lengthM: 10, widthM: 8, headingRad: 0 },
    }],
    diagnostics: {
      digest: 'sha256-ready',
      status: 'ready',
      sourceTiles: 1,
      accepted: 1,
      rejectedRoadOverlap: 0,
      ignored: 0,
      classes: { building: 1, wall: 0, barrier: 0, prop: 0, 'road-boundary': 0 },
    },
  } satisfies StaticColliderBundle;

  it('fails closed when verified collision data is unavailable', () => {
    const unavailable = {
      colliders: [],
      diagnostics: {
        ...readyBundle.diagnostics,
        status: 'unavailable',
        warning: 'Static collision derivative is not published for this map',
        accepted: 0,
        classes: { building: 0, wall: 0, barrier: 0, prop: 0, 'road-boundary': 0 },
      },
    } satisfies StaticColliderBundle;
    expect(() => requireReadyStaticColliderBundle(unavailable)).toThrow(
      'Static map collision data is unavailable: Static collision derivative is not published for this map',
    );
  });

});
