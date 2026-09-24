import { describe, expect, it } from 'vitest';

import { NATIVE_ROAD_DECALS_MANIFEST, planNativeRoadDecals } from './road-decals.js';

const MASTER = 'a'.repeat(64);
function source(manifest: unknown, masterSha256 = MASTER) {
  const files: Record<string, { sha256: string; text: string }> = {
    'master.gltf': { sha256: masterSha256, text: '{}' },
    ...(manifest === undefined ? {} : { [NATIVE_ROAD_DECALS_MANIFEST]: { sha256: 'c'.repeat(64), text: JSON.stringify(manifest) } }),
  };
  return { sha256: (uri: string) => files[uri]?.sha256, readText: async (uri: string) => files[uri]!.text };
}
const manifest = {
  schema: 'simforge.map-road-decals.v1', buildKey: 'b'.repeat(64), opacityScale: 0.2,
  source: { master: { path: 'master.gltf', sha256: MASTER } }, materials: [{ index: 3, name: 'OilPath01_Road_Roads_Road_Layer1' }],
};

describe('native road decal derivative', () => {
  it('is absent when the map carries none', async () => {
    expect(await planNativeRoadDecals(source(undefined))).toBeUndefined();
  });
  it('plans the manifest member and reports what it applies', async () => {
    expect(await planNativeRoadDecals(source(manifest))).toEqual({
      members: [NATIVE_ROAD_DECALS_MANIFEST], manifestSha256: 'c'.repeat(64), buildKey: 'b'.repeat(64), opacityScale: 0.2, materials: 1,
    });
  });
  it('refuses a derivative built from another master, never renders authored opacity silently', async () => {
    await expect(planNativeRoadDecals(source(manifest, 'd'.repeat(64)))).rejects.toThrow(/native_road_decals_master_mismatch/);
    await expect(planNativeRoadDecals(source({ ...manifest, opacityScale: 3 }))).rejects.toThrow(/opacityScale/);
  });
});
