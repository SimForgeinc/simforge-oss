import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { JobLeasedResponse } from '@simforge-oss/render';

import { validateClaimedInputs } from './worker.js';

const SHA = 'a'.repeat(64);
const MASTER = { inputId: 'map.tile.000000', relativePath: 'master.gltf' };

function resource(relativePath: string) {
  return { inputId: `map.resource.${createHash('sha256').update(relativePath).digest('hex')}`, relativePath };
}

function claim(...members: Array<{ inputId: string; relativePath?: string }>): Pick<JobLeasedResponse, 'intent' | 'inputs'> {
  return {
    intent: {
      scenarioRevision: { openScenario: { sha256: SHA, sizeBytes: 42 } },
      assets: [{ assetId: 'map.native-corpus', kind: 'map', sha256: 'b'.repeat(64), sizeBytes: members.length * 512 }],
    } as JobLeasedResponse['intent'],
    inputs: [
      { inputId: 'scenario.xosc', sha256: SHA, sizeBytes: 42, download: { url: 'https://example.test/scenario.xosc', headers: {} } },
      ...members.map((member) => ({
        ...member,
        sha256: 'c'.repeat(64),
        sizeBytes: 512,
        download: { url: `https://example.test/${member.inputId}`, headers: {} },
      })),
    ],
  };
}

describe('native-corpus lease inputs', () => {
  it('rejects a resource whose path does not match its identity', () => {
    const substituted = { ...resource('geometry/data.bin'), relativePath: 'geometry/other.bin' };
    expect(() => validateClaimedInputs(claim(MASTER, substituted))).toThrow();
  });

  it('rejects a resource alias for the master path', () => {
    expect(() => validateClaimedInputs(claim(MASTER, resource('master.gltf')))).toThrow();
  });

  it('requires the master even when valid resources are present', () => {
    expect(() => validateClaimedInputs(claim(resource('geometry/data.bin')))).toThrow();
  });

  it('rejects tile identities the native master engine does not consume', () => {
    expect(() => validateClaimedInputs(claim(MASTER, {
      inputId: 'map.tile.000001', relativePath: 'other.gltf',
    }))).toThrow();
  });

  it('rejects unrelated claimed inputs', () => {
    expect(() => validateClaimedInputs(claim(MASTER, { inputId: 'map.browser' }))).toThrow();
  });

  it('requires aggregate authorization for implicit resources', () => {
    const job = claim(resource('geometry/data.bin'));
    job.intent.assets = [];
    expect(() => validateClaimedInputs(job)).toThrow();
  });

  it('preserves content binding for explicitly declared resources', () => {
    const member = resource('geometry/data.bin');
    const job = claim(member);
    job.intent.assets = [{ assetId: member.inputId, kind: 'map', sha256: 'd'.repeat(64), sizeBytes: 512 }];
    expect(() => validateClaimedInputs(job)).toThrow();
  });
});
