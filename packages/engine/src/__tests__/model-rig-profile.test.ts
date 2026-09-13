import {
  MODEL_RIG_REQUIREMENTS,
  capturePayloadFromSensors,
  modelRequirementPayload,
  sensorRigPreset,
} from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../core/hash.js';
import {
  captureHashFromSensors,
  captureVersionFromSensors,
  modelRequirementHash,
  modelRequirementVersion,
} from '../core/model-rig-profile.js';

function captureInput(rigId: string) {
  const preset = sensorRigPreset(rigId);
  const requirement = MODEL_RIG_REQUIREMENTS.find((entry) => entry.rigId === rigId);
  if (!preset || !requirement) throw new Error(`missing fixture for ${rigId}`);
  return {
    sensors: preset.sensors.map((sensor, index) => ({
      id: sensor.id,
      type: sensor.type,
      cameraId: requirement.cameraIds[index] ?? index,
      mount: sensor.mount,
      ...(sensor.type === 'dash_camera' ? { camera: sensor.camera } : {}),
    })),
    renderWidth: requirement.renderWidth,
    renderHeight: requirement.renderHeight,
    framesPerCamera: requirement.framesPerCamera,
    historySteps: requirement.historySteps,
    coordinateFrame: requirement.coordinateFrame,
    rigLabel: rigId,
  };
}

describe('capture identity is independent of the model', () => {
  it('gives two families sharing a rig an identical capture hash', () => {
    const input = captureInput('alpamayo-4cam');
    expect(captureHashFromSensors(input)).toBe(captureHashFromSensors({ ...input, rigLabel: 'another-label' }));
    expect(captureVersionFromSensors(input).startsWith('capture@')).toBe(true);
  });

  it('still distinguishes the model bindings', () => {
    expect(modelRequirementHash('alpamayo-1')).not.toBe(modelRequirementHash('alpamayo-1.5'));
    const versions = MODEL_RIG_REQUIREMENTS.map((r) => modelRequirementVersion(r.family));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('distinguishes different rigs', () => {
    expect(captureHashFromSensors(captureInput('alpamayo-4cam'))).not.toBe(
      captureHashFromSensors(captureInput('alpamayo-6cam')),
    );
  });

  it('changes the capture hash when the rig geometry changes', () => {
    const input = captureInput('alpamayo-4cam');
    const edited = {
      ...input,
      sensors: input.sensors.map((sensor, index) =>
        index === 0 && sensor.camera
          ? { ...sensor, camera: { ...sensor.camera as object, horizontalFovDeg: 91 } }
          : sensor,
      ),
    };
    expect(captureHashFromSensors(edited)).not.toBe(captureHashFromSensors(input));
  });

  it('hashes the payloads the scenario package publishes', () => {
    const input = captureInput('alpamayo-6cam');
    expect(captureHashFromSensors(input)).toBe(sha256(canonicalJson(capturePayloadFromSensors(input))));
    expect(modelRequirementHash('alpamayo-2-super')).toBe(
      sha256(canonicalJson(modelRequirementPayload('alpamayo-2-super'))),
    );
  });

  it('refuses unknown inputs rather than hashing a default', () => {
    expect(() => captureHashFromSensors({ ...captureInput('alpamayo-4cam'), sensors: [] })).toThrow(
      /at least one sensor/,
    );
    expect(() => modelRequirementHash('not-a-model')).toThrow(/no rig requirement/);
  });
});
