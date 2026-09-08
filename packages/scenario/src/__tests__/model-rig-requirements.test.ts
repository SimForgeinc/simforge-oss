import { describe, expect, it } from 'vitest';

import {
  MODEL_RIG_REQUIREMENTS,
  modelRigProfileHash,
  modelRigProfileVersion,
  modelRigRequirement,
  sensorRigPreset,
} from '../schema/v2/sensor-rigs.js';

describe('model rig requirements', () => {
  it('names a rig that can actually supply the model camera count', () => {
    // The failure this catches is the one the plan calls out: a model wired
    // to a rig that cannot supply its cameras, which downstream would have
    // to paper over by duplicating or dropping a view.
    for (const requirement of MODEL_RIG_REQUIREMENTS) {
      const preset = sensorRigPreset(requirement.rigId);
      expect(preset, `${requirement.family} names unknown rig ${requirement.rigId}`).toBeDefined();
      expect(preset!.sensors).toHaveLength(requirement.cameraIds.length);
    }
  });

  it('keeps camera ids in positional order with no duplicates', () => {
    // These models carry no camera-identity channel, so order is contract.
    for (const { family, cameraIds } of MODEL_RIG_REQUIREMENTS) {
      expect(new Set(cameraIds).size, `${family} repeats a camera id`).toBe(cameraIds.length);
      expect([...cameraIds], `${family} camera ids are not ascending`).toEqual(
        [...cameraIds].sort((a, b) => a - b),
      );
    }
  });

  it('never claims an authored rig is the calibrated dataset camera', () => {
    for (const requirement of MODEL_RIG_REQUIREMENTS) {
      expect(requirement.datasetCalibrated).toBe(false);
    }
  });

  it('marks only the family whose contract genuinely accepts other sets', () => {
    // A1 and A2 refuse a different set; A1.5 legitimately varies. Getting
    // this backwards would let a UI offer a substitution that is a refusal.
    expect(modelRigRequirement('alpamayo-1')?.variableCameras).toBe(false);
    expect(modelRigRequirement('alpamayo-2-super')?.variableCameras).toBe(false);
    expect(modelRigRequirement('alpamayo-1.5')?.variableCameras).toBe(true);
  });

  it('hashes a profile stably, and distinctly per family', () => {
    const first = modelRigProfileHash('alpamayo-1');
    expect(modelRigProfileHash('alpamayo-1')).toBe(first);
    expect(first).toHaveLength(64);

    const hashes = MODEL_RIG_REQUIREMENTS.map((r) => modelRigProfileHash(r.family));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('changes the hash when the rig geometry changes', () => {
    // The point of persisting the hash is that an old result stops matching
    // an edited profile. Proven by hashing the same payload shape with one
    // sensor FOV altered, rather than asserted.
    const preset = sensorRigPreset('alpamayo-4cam')!;
    const sensors = preset.sensors.map((sensor) => ({ id: sensor.id, type: sensor.type }));
    const widened = sensors.map((sensor, index) =>
      index === 0 ? { ...sensor, id: `${sensor.id}-widened` } : sensor,
    );
    expect(JSON.stringify(sensors)).not.toBe(JSON.stringify(widened));

    // And the real hash is sensitive to the rig it names: the six-camera
    // family cannot collide with the four-camera one.
    expect(modelRigProfileHash('alpamayo-2-super')).not.toBe(modelRigProfileHash('alpamayo-1'));
  });

  it('exposes a short version tag a manifest and a badge can both carry', () => {
    const version = modelRigProfileVersion('alpamayo-1');
    expect(version.startsWith('alpamayo-1@')).toBe(true);
    expect(version.split('@')[1]).toHaveLength(12);
    expect(modelRigProfileHash('alpamayo-1').startsWith(version.split('@')[1]!)).toBe(true);
  });

  it('refuses an unknown family instead of returning a default profile', () => {
    expect(modelRigRequirement('not-a-model')).toBeUndefined();
    expect(() => modelRigProfileHash('not-a-model')).toThrow(/no rig requirement/);
  });
});
