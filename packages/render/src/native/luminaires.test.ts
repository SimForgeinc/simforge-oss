import { describe, expect, it } from 'vitest';

import { NATIVE_LUMINAIRES_MANIFEST, orderNativeFixtures, planNativeLuminaires } from './luminaires.js';

const MASTER = 'a'.repeat(64);
const manifest = {
  schema: 'simforge.map-luminaires.v1', buildKey: 'b'.repeat(64),
  source: { master: { path: 'master.gltf', sha256: MASTER } }, builder: { revision: 1, fingerprint: 'f' }, rejected: 0,
  fixtures: [
    { sourceId: 'n1', sourceName: '{x}StreetLight_30ft', position: [100, 8, 0], headingRad: 0.5, rule: 'head' },
    { sourceId: 'n2', sourceName: '{y}Luminaire_Head02', position: [10, 6, 0], headingRad: 0, rule: 'lamp-head' },
  ],
};
function source(value: unknown, masterSha256 = MASTER) {
  const files: Record<string, { sha256: string; text: string }> = {
    'master.gltf': { sha256: masterSha256, text: '{}' },
    ...(value === undefined ? {} : { [NATIVE_LUMINAIRES_MANIFEST]: { sha256: 'c'.repeat(64), text: JSON.stringify(value) } }),
  };
  return { sha256: (uri: string) => files[uri]?.sha256, readText: async (uri: string) => files[uri]!.text };
}

describe('native street luminaires', () => {
  it('reads the derivative as the service fixtures, and refuses one from another master', async () => {
    expect(await planNativeLuminaires(source(undefined))).toBeUndefined();
    const plan = await planNativeLuminaires(source(manifest));
    expect(plan?.fixtures).toEqual([
      { source_id: 'n1', source_name: '{x}StreetLight_30ft', position: [100, 8, 0], heading_rad: 0.5, rule: 'head' },
      { source_id: 'n2', source_name: '{y}Luminaire_Head02', position: [10, 6, 0], heading_rad: 0, rule: 'lamp-head' },
    ]);
    await expect(planNativeLuminaires(source(manifest, 'd'.repeat(64)))).rejects.toThrow(/native_luminaires_master_mismatch/);
    await expect(planNativeLuminaires(source({ ...manifest, fixtures: [{ sourceId: 'n1', position: [0, 0], headingRad: 0 }] })))
      .rejects.toThrow(/native_luminaires_invalid: fixture 0/);
  });

  it('orders fixtures nearest to the camera path first', async () => {
    const plan = (await planNativeLuminaires(source(manifest)))!;
    const ordered = orderNativeFixtures(plan.fixtures, [[0, 1.5, 0], [95, 1.5, 0]]);
    // n1 passes within 6.6 m of the second eye, n2 within 10.1 m of the first.
    expect(ordered.fixtures.map((f) => f.source_id)).toEqual(['n1', 'n2']);
    expect(ordered.observer).toEqual([0, 1.5, 0]);
    expect(orderNativeFixtures(plan.fixtures, [[0, 1.5, 0]]).fixtures.map((f) => f.source_id)).toEqual(['n2', 'n1']);
  });
});
