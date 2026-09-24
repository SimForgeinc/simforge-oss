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

function fixtureFetcher(value: Record<string, unknown>, calls: string[], schemaVersion = 1): typeof fetch {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const outputSha256 = createHash('sha256').update(bytes).digest('hex');
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/3d/manifest.json')) return new Response(SOURCE_BYTES);
    if (url.endsWith('/variants/manifest.json')) return Response.json({
      sourceManifestSha256: SOURCE_HASH,
      variants: { 'static-colliders': { schemaVersion, file: `static-colliders-v${schemaVersion}.json`, digest: DIGEST, outputSha256 } },
    });
    return new Response(bytes);
  }) as typeof fetch;
}

describe('precomputed static map colliders', () => {
  it('loads a v2 artifact with every collider\'s vertical extent', async () => {
    resetStaticColliderCacheForTests();
    const pole = { id: 'canonical-master/1', class: 'prop', obb: { center: { x: 1, z: 2 }, lengthM: 0.4, widthM: 0.4, headingRad: 0 }, vertical: { minY: 7.1, maxY: 14 } };
    const v2 = artifact({
      schema: 'simforge.static-map-colliders/v2', colliders: [pole], overheadClearanceM: 4.6,
      statistics: { sourceTiles: 1, accepted: 1, rejectedRoadOverlap: 0, rejectedOverhead: 3, ignored: 2, classes: { building: 0, wall: 0, barrier: 0, prop: 1, 'road-boundary': 0 } },
    });
    const bundle = await loadStaticMapColliders('/dev-assets/v2-map/3d/manifest.json', fixtureFetcher(v2, [], 2));
    expect(bundle.diagnostics).toMatchObject({ status: 'ready', accepted: 1, rejectedOverhead: 3 });
    expect(bundle.colliders).toEqual([pole]);
  });

  it('fails closed on a v2 collider without an extent, or a v1 collider with one', async () => {
    resetStaticColliderCacheForTests();
    const flat = { id: 'canonical-master/1', class: 'prop', obb: { center: { x: 1, z: 2 }, lengthM: 0.4, widthM: 0.4, headingRad: 0 } };
    const v2 = await loadStaticMapColliders('/dev-assets/v2-flat/3d/manifest.json',
      fixtureFetcher(artifact({ schema: 'simforge.static-map-colliders/v2', colliders: [flat] }), [], 2));
    expect(v2.diagnostics.status).toBe('unavailable');
    expect(v2.diagnostics.warning).toMatch(/missing or invalid vertical extent/);
    const v1 = await loadStaticMapColliders('/dev-assets/v1-tall/3d/manifest.json',
      fixtureFetcher(artifact({ colliders: [{ ...flat, vertical: { minY: 0, maxY: 3 } }] }), []));
    expect(v1.diagnostics.warning).toMatch(/unexpected vertical extent/);
    // A v2 artifact advertised as v1 is refused by its schema string.
    const mislabelled = await loadStaticMapColliders('/dev-assets/v2-as-v1/3d/manifest.json',
      fixtureFetcher(artifact({ schema: 'simforge.static-map-colliders/v2' }), []));
    expect(mislabelled.diagnostics.warning).toMatch(/unsupported schema/);
  });

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
    // Props are the bulk of every artifact now that unnamed static geometry is
    // solid by default (Garching: 6159 of 6206). Only the slab may be dropped
    // here: a class-wide filter would silently empty the map again.
    const hydrant = { id: 'canonical-master/3001', class: 'prop', obb: { center: { x: 41, z: -22 }, lengthM: 0.4, widthM: 0.4, headingRad: 0 } };
    const fetcher = fixtureFetcher(artifact({
      sources: [{ id: 'canonical-master', file: 'master.gltf', declaredBytes: 1 }],
      colliders: [slab, building, hydrant, kerb],
      statistics: { sourceTiles: 1, accepted: 4, rejectedRoadOverlap: 0, ignored: 981, classes: { building: 1, wall: 0, barrier: 0, prop: 1, 'road-boundary': 2 } },
    }), []);
    const result = await loadStaticMapColliders('/dev-assets/rfs/3d/manifest.json', fetcher);
    expect(result.colliders).toEqual([building, hydrant, kerb]);
    expect(result.diagnostics).toMatchObject({ status: 'ready', accepted: 3, ignored: 982, classes: { building: 1, prop: 1, 'road-boundary': 1 } });
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
