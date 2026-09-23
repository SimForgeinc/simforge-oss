import { describe, expect, it } from 'vitest';

import { JobLeasedResponseSchema } from './worker-control.js';

describe('leased job control digest', () => {
  it('requires a lowercase SHA-256 execution package control digest', () => {
    const digestSchema = JobLeasedResponseSchema.shape.executionPackageControlSha256;

    expect(digestSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(digestSchema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(digestSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('lease shape compatibility', () => {
  it('accepts an optional controlFeatures list and inputs without a download URL', () => {
    expect(JobLeasedResponseSchema.shape.controlFeatures.parse(undefined)).toBeUndefined();
    expect(JobLeasedResponseSchema.shape.controlFeatures.parse(['native-evidence.scene-source'])).toEqual(['native-evidence.scene-source']);
    const input = JobLeasedResponseSchema.shape.inputs.element;
    expect(input.parse({ inputId: 'map.tile.000000', relativePath: 'master.gltf', sha256: 'a'.repeat(64), sizeBytes: 1 }).download).toBeUndefined();
  });
});
