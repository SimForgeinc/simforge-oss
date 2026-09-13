import { describe, expect, it } from 'vitest';

import {
  MODEL_RIG_REQUIREMENTS,
  capturePayloadFromSensors,
  expectedCapturePayload,
  modelRequirementPayload,
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

  it('gives two families sharing a rig the SAME expected profile', () => {
    // The bug this prevents: A1 and A1.5 both consume the four-camera rig,
    // so a run over identical imagery must not look sensor-different just
    // because a different model asked for it. Capture identity therefore
    // excludes the family entirely.
    const a1 = modelRigRequirement('alpamayo-1')!;
    const a15 = modelRigRequirement('alpamayo-1.5')!;
    expect(a1.rigId).toBe(a15.rigId);
    expect(JSON.stringify(expectedCapturePayload(a1.rigId))).toBe(
      JSON.stringify(expectedCapturePayload(a15.rigId)),
    );
    expect(JSON.stringify(expectedCapturePayload(a1.rigId))).not.toContain('alpamayo-1"');

    // ...while their requirement identities differ, because the binding does.
    expect(JSON.stringify(modelRequirementPayload('alpamayo-1'))).not.toBe(
      JSON.stringify(modelRequirementPayload('alpamayo-1.5')),
    );
  });

  it('refuses a capture profile for a rig with no Alpamayo camera mapping', () => {
    // Otherwise it would report the Alpamayo cadence and history window for
    // a capture that was never made under them.
    expect(() => expectedCapturePayload('basic-dash-camera')).toThrow(/no Alpamayo capture profile/);
    expect(() => expectedCapturePayload('not-a-rig')).toThrow(/unknown sensor rig/);
  });

  it('emits a capture payload whose sensors come from the named preset', () => {
    // The payload must describe the geometry it names, not restate it: a
    // second copy is how a profile ends up calibrated in one file only.
    for (const requirement of MODEL_RIG_REQUIREMENTS) {
      const payload = expectedCapturePayload(requirement.rigId) as {
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

  it('gives each family a distinguishable requirement payload', () => {
    const payloads = MODEL_RIG_REQUIREMENTS.map((r) => JSON.stringify(modelRequirementPayload(r.family)));
    expect(new Set(payloads).size).toBe(payloads.length);
  });

  it('refuses an unknown family instead of returning a default profile', () => {
    expect(modelRigRequirement('not-a-model')).toBeUndefined();
    expect(() => modelRequirementPayload('not-a-model')).toThrow(/no rig requirement/);
  });
});


describe('actual capture identity', () => {
  const sensor = (id: string, cameraId: number, horizontalFovDeg: number) => ({
    id,
    type: 'dash_camera',
    cameraId,
    mount: { position: { x: 1, y: 0, z: 1.5 }, rotation: { yaw: 0, pitch: 0, roll: 0 } },
    camera: {
      horizontalFovDeg,
      verticalFovDeg: 60,
      nearM: 0.05,
      farM: 1_000,
      aspectRatio: 512 / 384,
    },
  });
  const base = {
    renderWidth: 512,
    renderHeight: 384,
    framesPerCamera: 4,
    historySteps: 16,
    coordinateFrame: 'ego-flu-x-forward',
    rigLabel: 'alpamayo-4cam',
  };

  it('changes when an author edits a camera FOV', () => {
    // The false-match this prevents: editing a camera in the scenario
    // editor while the rig id stays 'alpamayo-4cam', so a preset lookup
    // would return the same digest for a different capture.
    const asBuilt = capturePayloadFromSensors({
      ...base,
      sensors: [sensor('camera_front_wide_120fov', 1, 120)],
    });
    const edited = capturePayloadFromSensors({
      ...base,
      sensors: [sensor('camera_front_wide_120fov', 1, 90)],
    });
    expect(JSON.stringify(asBuilt)).not.toBe(JSON.stringify(edited));
  });

  it('changes when a mount moves', () => {
    const moved = capturePayloadFromSensors({
      ...base,
      sensors: [
        {
          ...sensor('camera_front_wide_120fov', 1, 120),
          mount: { position: { x: 1, y: 0, z: 2.0 }, rotation: { yaw: 0, pitch: 0, roll: 0 } },
        },
      ],
    });
    const original = capturePayloadFromSensors({
      ...base,
      sensors: [sensor('camera_front_wide_120fov', 1, 120)],
    });
    expect(JSON.stringify(moved)).not.toBe(JSON.stringify(original));
  });

  it('changes when the camera SUBSET fed to the model changes', () => {
    const four = capturePayloadFromSensors({
      ...base,
      sensors: [0, 1, 2, 6].map((id) => sensor(`cam-${id}`, id, 120)),
    });
    const two = capturePayloadFromSensors({
      ...base,
      sensors: [1, 6].map((id) => sensor(`cam-${id}`, id, 120)),
    });
    expect(JSON.stringify(four)).not.toBe(JSON.stringify(two));
  });

  it('is independent of the order the author listed sensors in', () => {
    const ordered = capturePayloadFromSensors({
      ...base,
      sensors: [0, 1, 2, 6].map((id) => sensor(`cam-${id}`, id, 120)),
    });
    const shuffled = capturePayloadFromSensors({
      ...base,
      sensors: [6, 0, 2, 1].map((id) => sensor(`cam-${id}`, id, 120)),
    });
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(ordered));
  });

  it('treats the rig name as a label, not identity', () => {
    const sensors = [sensor('camera_front_wide_120fov', 1, 120)];
    const a = capturePayloadFromSensors({ ...base, sensors, rigLabel: 'alpamayo-4cam' });
    const b = capturePayloadFromSensors({ ...base, sensors, rigLabel: 'my-custom-rig' });
    // The label is deliberately excluded from the identity payload.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('refuses a capture with no sensors or duplicate camera ids', () => {
    expect(() => capturePayloadFromSensors({ ...base, sensors: [] })).toThrow(/at least one sensor/);
    expect(() =>
      capturePayloadFromSensors({
        ...base,
        sensors: [sensor('a', 1, 120), sensor('b', 1, 120)],
      }),
    ).toThrow(/duplicate camera ids/);
  });
});
