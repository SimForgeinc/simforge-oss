import { describe, expect, it } from 'vitest';
import { ScenarioSplitRequestSchema, ScenarioSplitSchema, parseScenarioSplit, scenarioSplitDigest, verifyScenarioSplits, type ScenarioSplit } from '../scenario-split.js';

function fixture(splitId: string, purpose: ScenarioSplit['purpose'], map: string, site: string, from: number): ScenarioSplit {
  const value: ScenarioSplit = {
    schema: 'simforge.scenario-split/v1', splitId, purpose,
    cells: [{ template: 'template.json', map, site, seeds: { from, to: from + 1 } }],
    admission: { generatedAt: '2026-09-22T00:00:00.000Z', compilerVersion: 'test', nativeAddonSha256: 'a'.repeat(64), proofs: [{ cell: 0, checks: ['geometry', 'occlusion', 'solvability'], status: 'admitted', siteKey: `${map}/${site}`, receipt: { path: 'receipt.json', sha256: 'b'.repeat(64) } }] },
    materialization: { episodes: { path: 'episodes.json', sha256: 'c'.repeat(64) }, count: 2 }, digest: '',
  };
  value.digest = scenarioSplitDigest(value);
  return value;
}

describe('frozen split independence', () => {
  it('requires both independent seeds and physical sites, not only one of them', () => {
    const train = fixture('train', 'train', 'yale', 'site-a', 0);
    const seedLeak = fixture('val', 'val', 'yale', 'site-b', 1);
    const siteLeak = fixture('val', 'val', 'yale', 'site-a', 100);
    expect(() => verifyScenarioSplits([train, seedLeak])).toThrow(/seed overlap/);
    expect(() => verifyScenarioSplits([train, siteLeak])).toThrow(/site overlap/);
    expect(verifyScenarioSplits([train, fixture('val', 'val', 'yale', 'site-b', 100)]).map((split) => split.splitId)).toEqual(['train', 'val']);
  });

  it('treats San Ramon versions as one geography even with different sites and seeds', () => {
    const train = fixture('train', 'train', 'san-ramon-phase-1', 'a', 0);
    const test = fixture('test', 'test', 'san-ramon-25-p2', 'b', 200);
    expect(() => verifyScenarioSplits([train, test])).toThrow(/geography overlap/);
  });

  it('refuses missing, duplicate and falsely counted admission proofs', () => {
    const split = fixture('train', 'train', 'yale', 'site-a', 0);
    expect(ScenarioSplitSchema.safeParse({ ...split, admission: { ...split.admission, proofs: [] } }).success).toBe(false);
    expect(ScenarioSplitSchema.safeParse({ ...split, admission: { ...split.admission, proofs: [split.admission.proofs[0], split.admission.proofs[0]] } }).success).toBe(false);
    expect(ScenarioSplitSchema.safeParse({ ...split, materialization: { ...split.materialization, count: 1 } }).success).toBe(false);
  });

  it('refuses changed frozen contents and default/repeated draws', () => {
    const split = fixture('train', 'train', 'yale', 'site-a', 0);
    expect(() => parseScenarioSplit({ ...split, splitId: 'changed' })).toThrow(/digest mismatch/);
    const request = { schema: split.schema, splitId: split.splitId, purpose: split.purpose, cells: [{ ...split.cells[0], drawIndex: -1 }] };
    expect(ScenarioSplitRequestSchema.safeParse(request).success).toBe(false);
    expect(ScenarioSplitRequestSchema.safeParse({ ...request, cells: [{ ...split.cells[0], seeds: [0, 0] }] }).success).toBe(false);
  });

  it('permits shared test/control draws only with the exact pinned test parent', () => {
    const test = fixture('test', 'test', 'belmont', 'a', 200);
    const control = fixture('control', 'control', 'belmont', 'a', 200);
    control.pairedWith = { splitId: test.splitId, digest: test.digest, manifest: 'test.split.json', intervention: 'remove-hazards' };
    control.digest = scenarioSplitDigest(control);
    expect(verifyScenarioSplits([test, control]).map((split) => split.purpose)).toEqual(['test', 'control']);
    expect(() => verifyScenarioSplits([fixture('train', 'train', 'yale', 'x', 0), control])).toThrow(/paired test split/);
    control.pairedWith.digest = 'd'.repeat(64);
    control.digest = scenarioSplitDigest(control);
    expect(() => verifyScenarioSplits([test, control])).toThrow(/paired test split/);
  });
});
