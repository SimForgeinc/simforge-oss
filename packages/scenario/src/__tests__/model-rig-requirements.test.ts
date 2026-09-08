import { describe, expect, it } from 'vitest';

import {
  MODEL_RIG_REQUIREMENTS,
  modelRigProfilePayload,
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

  it('emits a payload whose sensors come from the named preset', () => {
    // The payload must describe the geometry it names, not restate it: a
    // second copy is how a profile ends up calibrated in one file only.
    for (const requirement of MODEL_RIG_REQUIREMENTS) {
      const payload = modelRigProfilePayload(requirement.family) as {
        rigId: string;
        cameraIds: number[];
        sensors: { id: string }[];
      };
      const preset = sensorRigPreset(requirement.rigId)!;
      expect(payload.rigId).toBe(requirement.rigId);
      expect(payload.cameraIds).toEqual([...requirement.cameraIds]);
      expect(payload.sensors.map((s) => s.id)).toEqual(preset.sensors.map((s) => s.id));
    }
  });

  it('gives each family a distinguishable payload', () => {
    const payloads = MODEL_RIG_REQUIREMENTS.map((r) => JSON.stringify(modelRigProfilePayload(r.family)));
    expect(new Set(payloads).size).toBe(payloads.length);
  });

  it('refuses an unknown family instead of returning a default profile', () => {
    expect(modelRigRequirement('not-a-model')).toBeUndefined();
    expect(() => modelRigProfilePayload('not-a-model')).toThrow(/no rig requirement/);
  });
});
