import { MODEL_RIG_REQUIREMENTS, modelRigProfilePayload } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../core/hash.js';
import { modelRigProfileHash, modelRigProfileVersion } from '../core/model-rig-profile.js';

describe('model rig profile hash', () => {
  it('is stable and distinct per family', () => {
    const first = modelRigProfileHash('alpamayo-1');
    expect(modelRigProfileHash('alpamayo-1')).toBe(first);
    expect(first).toHaveLength(64);

    const hashes = MODEL_RIG_REQUIREMENTS.map((r) => modelRigProfileHash(r.family));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('changes when the rig geometry changes', () => {
    // This is the whole reason the version is persisted: edit a camera
    // template and an old result must stop claiming to match the profile.
    // Proven against the real payload with one sensor's FOV altered.
    const payload = modelRigProfilePayload('alpamayo-1') as {
      sensors: { id: string; fov?: number }[];
    };
    const edited = {
      ...payload,
      sensors: payload.sensors.map((sensor, index) =>
        index === 0 ? { ...sensor, fov: (sensor.fov ?? 90) + 1 } : sensor,
      ),
    };
    expect(sha256(canonicalJson(edited))).not.toBe(modelRigProfileHash('alpamayo-1'));
  });

  it('hashes the payload the scenario package publishes, not a private copy', () => {
    // If these ever disagree, the manifest's version would not describe the
    // profile a caller can read.
    expect(modelRigProfileHash('alpamayo-2-super')).toBe(
      sha256(canonicalJson(modelRigProfilePayload('alpamayo-2-super'))),
    );
  });

  it('tags a version a manifest and a badge can both carry', () => {
    const version = modelRigProfileVersion('alpamayo-1');
    const [family, short] = version.split('@');
    expect(family).toBe('alpamayo-1');
    expect(short).toHaveLength(12);
    expect(modelRigProfileHash('alpamayo-1').startsWith(short!)).toBe(true);
  });

  it('refuses an unknown family rather than hashing a default', () => {
    expect(() => modelRigProfileHash('not-a-model')).toThrow(/no rig requirement/);
  });
});
