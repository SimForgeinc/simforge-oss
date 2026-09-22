import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { JobLeasedResponse } from '@simforge-oss/render';
import { nativeMapMemberInputId } from '@simforge-oss/render/native';

import { createProgressForwarder, heartbeatFailureIsFatal, validateClaimedInputs } from './worker.js';

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

describe('best-effort control-plane reporting', () => {
  const record = (completed: number) => ({
    schema: 'simforge.render-progress/v1', event: 'stage.progress', stage: 'downloading', unit: 'items',
    jobId: 'usrj_x', attempt: 1, sequence: 0, timestamp: new Date().toISOString(), completed, total: 10,
  }) as never;

  it('drops failed progress records instead of failing, and coalesces queued snapshots', async () => {
    const sent: number[] = [];
    const logged: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const forwarder = createProgressForwarder(async (candidate) => {
      const completed = (candidate as { completed: number }).completed;
      if (completed === 1) {
        await gate;
        throw new Error('SimCloud control /events returned 409: {"error":"lease_invalid_or_expired"}');
      }
      sent.push(completed);
    }, () => false, (event) => logged.push(event));
    await forwarder.forward(record(1));
    for (let completed = 2; completed <= 9; completed += 1) await forwarder.forward(record(completed));
    release();
    await forwarder.flush();
    // Record 1 failed and was dropped; 2..8 were superseded by 9 while 1 was in flight.
    expect(sent).toEqual([9]);
    expect(logged).toHaveLength(1);
  });

  it('keeps a lease through heartbeat failures until its acknowledged expiry nears', () => {
    const now = 1_000_000;
    expect(heartbeatFailureIsFatal(new Error('fetch failed'), now + 600_000, 30_000, now)).toBe(false);
    expect(heartbeatFailureIsFatal(new Error('fetch failed'), now + 20_000, 30_000, now)).toBe(true);
    expect(heartbeatFailureIsFatal(new Error('control returned 409: lease_invalid_or_expired'), now + 600_000, 30_000, now)).toBe(true);
  });
});
