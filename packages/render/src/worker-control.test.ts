import { describe, expect, it } from 'vitest';

import { CAMERA_PROFILE_NOT_DECLARED_STATUS } from './artifacts.js';
import { JobCompleteRequestSchema, JobLeasedResponseSchema } from './worker-control.js';

describe('leased job control digest', () => {
  it('requires a lowercase SHA-256 execution package control digest', () => {
    const digestSchema = JobLeasedResponseSchema.shape.executionPackageControlSha256;

    expect(digestSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(digestSchema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(digestSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('managed completion camera-profile evidence', () => {
  it('preserves approximation evidence and warnings in the completion manifest', () => {
    const completion = JobCompleteRequestSchema.parse({
      schema: 'simforge.render-worker-control/v2',
      type: 'job.complete',
      leaseId: 'lease-1',
      fenceToken: 'f'.repeat(32),
      intentSha256: 'a'.repeat(64),
      manifest: {
        artifacts: [{
          artifactId: 'artifact-1',
          identity: { role: 'manifest', actorId: null, sensorId: null, modality: null },
          sha256: 'b'.repeat(64),
          sizeBytes: 1,
          mediaType: 'application/json',
        }],
        effectiveConfiguration: {
          cameraProfiles: [{
            actorId: 'ego',
            sensorId: 'camera',
            outputName: 'camera-rgb',
            profileSource: 'default',
            status: CAMERA_PROFILE_NOT_DECLARED_STATUS,
          }],
        },
        warnings: [{
          code: 'camera_profile_not_declared_by_engine',
          message: `${CAMERA_PROFILE_NOT_DECLARED_STATUS}: ego/camera`,
        }],
      },
    });

    expect(completion.manifest).toMatchObject({
      effectiveConfiguration: { cameraProfiles: [{ status: CAMERA_PROFILE_NOT_DECLARED_STATUS }] },
      warnings: [{ code: 'camera_profile_not_declared_by_engine' }],
    });
  });
});
