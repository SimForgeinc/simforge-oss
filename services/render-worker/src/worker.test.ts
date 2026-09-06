import { describe, expect, it } from 'vitest';

import type { JobLeasedResponse } from '@simforge-oss/render';
import { nativeMapMemberInputId } from '@simforge-oss/render/native';

import { validateClaimedInputs } from './worker.js';

type Input = JobLeasedResponse['inputs'][number];

const XOSC = { sha256: 'a'.repeat(64), sizeBytes: 42 };

function member(relativePath: string, sizeBytes: number, overrides: Partial<Input> = {}): Input {
  return {
    inputId: nativeMapMemberInputId(relativePath),
    relativePath,
    sha256: relativePath.length.toString(16).padStart(2, '0').repeat(32),
    sizeBytes,
    download: { url: `https://example.test/${relativePath}`, headers: {} },
    ...overrides,
  };
}

const xosc: Input = { inputId: 'scenario.xosc', ...XOSC, download: { url: 'https://example.test/xosc', headers: {} } };
const master = member('master.gltf', 1000);
const geometry = member('geometry.bin', 900);
const texture = member('images/road.ktx2', 148);

/** Intent declares `declared` per member; the lease serves `inputs` (defaults to the declaration). */
function lease(declared: Input[], inputs: Input[] = declared): Pick<JobLeasedResponse, 'intent' | 'inputs'> {
  return {
    intent: {
      scenarioRevision: { openScenario: XOSC },
      assets: declared.map(({ inputId, sha256, sizeBytes }) => ({ assetId: inputId, kind: 'map', sha256, sizeBytes })),
    } as JobLeasedResponse['intent'],
    inputs: [xosc, ...inputs],
  };
}

describe('native map closure admission', () => {
  it('rejects a lease missing a declared member', () => {
    expect(() => validateClaimedInputs(lease([master, geometry, texture], [master, texture]))).toThrow(
      `invalid missing claimed input ${geometry.inputId}`,
    );
  });

  it('rejects a served member whose digest drifted from its declaration', () => {
    const drifted = member('geometry.bin', 900, { sha256: 'f'.repeat(64) });
    expect(() => validateClaimedInputs(lease([master, geometry, texture], [master, drifted, texture]))).toThrow(
      `invalid claimed input metadata for ${geometry.inputId}`,
    );
  });

  it('rejects members the intent never declared, including undeclared tile ids', () => {
    const stray = member('geometry.bin', 900, { inputId: 'map.tile.000001' });
    expect(() => validateClaimedInputs(lease([master, texture], [master, stray, texture]))).toThrow(
      'invalid unreferenced claimed input map.tile.000001',
    );
  });

  it('rejects duplicate claimed members', () => {
    expect(() => validateClaimedInputs(lease([master, geometry], [master, geometry, geometry]))).toThrow(
      `invalid duplicate claimed input ${geometry.inputId}`,
    );
  });

  it('rejects a declared closure without master.gltf', () => {
    expect(() => validateClaimedInputs(lease([geometry, texture]))).toThrow(
      'invalid missing native map member map.tile.000000',
    );
  });

  it('rejects a member whose declared id was not derived from its served path', () => {
    const relocated = member('geometry.bin', 900, { relativePath: 'other.bin' });
    expect(() => validateClaimedInputs(lease([master, relocated, texture]))).toThrow(
      /does not derive from its path other\.bin/,
    );
  });

  it('rejects a member escaping the map root', () => {
    expect(() => validateClaimedInputs(lease([master, member('../geometry.bin', 900)]))).toThrow(
      'invalid unsafe native map member path: ../geometry.bin',
    );
  });

  it('rejects a member served without a path to reconstruct', () => {
    expect(() => validateClaimedInputs(lease([master, geometry], [master, { ...geometry, relativePath: undefined }]))).toThrow(
      `invalid native map member ${geometry.inputId} without relativePath`,
    );
  });
});
