import {
  MODEL_RIG_REQUIREMENTS,
  captureProfilePayload,
  modelRequirementPayload,
  modelRigRequirement,
} from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../core/hash.js';
import {
  captureProfileHash,
  captureProfileVersion,
  modelRequirementHash,
  modelRequirementVersion,
} from '../core/model-rig-profile.js';

describe('capture identity is independent of the model', () => {
  it('gives two families sharing a rig an identical capture hash', () => {
    // The comparison bug this exists to prevent: A1 and A1.5 both consume
    // the four-camera rig, so runs over the same imagery must compare as
    // the same capture rather than as sensor-different.
    const a1 = modelRigRequirement('alpamayo-1')!;
    const a15 = modelRigRequirement('alpamayo-1.5')!;
    expect(captureProfileHash(a1.rigId)).toBe(captureProfileHash(a15.rigId));
    expect(captureProfileVersion(a1.rigId).startsWith('alpamayo-4cam@')).toBe(true);
  });

  it('still distinguishes the model bindings', () => {
    expect(modelRequirementHash('alpamayo-1')).not.toBe(modelRequirementHash('alpamayo-1.5'));
    const versions = MODEL_RIG_REQUIREMENTS.map((r) => modelRequirementVersion(r.family));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('distinguishes different rigs', () => {
    expect(captureProfileHash('alpamayo-4cam')).not.toBe(captureProfileHash('alpamayo-6cam'));
  });

  it('changes the capture hash when the rig geometry changes', () => {
    // Why the version is persisted: edit a camera template and an old
    // result must stop claiming to match the capture.
    const payload = captureProfilePayload('alpamayo-4cam') as {
      sensors: { id: string; fov?: number }[];
    };
    const edited = {
      ...payload,
      sensors: payload.sensors.map((sensor, index) =>
        index === 0 ? { ...sensor, fov: (sensor.fov ?? 90) + 1 } : sensor,
      ),
    };
    expect(sha256(canonicalJson(edited))).not.toBe(captureProfileHash('alpamayo-4cam'));
  });

  it('hashes the payloads the scenario package publishes, not private copies', () => {
    expect(captureProfileHash('alpamayo-6cam')).toBe(
      sha256(canonicalJson(captureProfilePayload('alpamayo-6cam'))),
    );
    expect(modelRequirementHash('alpamayo-2-super')).toBe(
      sha256(canonicalJson(modelRequirementPayload('alpamayo-2-super'))),
    );
  });

  it('refuses unknown inputs rather than hashing a default', () => {
    expect(() => captureProfileHash('not-a-rig')).toThrow(/unknown sensor rig/);
    expect(() => modelRequirementHash('not-a-model')).toThrow(/no rig requirement/);
  });
});
