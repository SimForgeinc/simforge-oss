import type { RenderIntentV1 } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { ENGINE_CAPABILITIES_V1_SCHEMA, UnsupportedRenderIntentError, assertEngineSupportsIntent, type EngineCapabilityDeclaration } from './capabilities.js';

const declaration: EngineCapabilityDeclaration = {
  schema: ENGINE_CAPABILITIES_V1_SCHEMA, engineId: 'test', engineVersion: '1', backend: 'native', protocolVersion: 1,
  capabilities: ['sensor.rgb', 'artifact.manifest'], modalities: ['rgb'],
  limits: { maxSimultaneousSensors: 8, maxWidth: 4096, maxHeight: 4096, maxFramesPerSecond: 60 },
  requiresGpu: true,
};

function intent(attributes: { width: number; height: number; fps: number }): RenderIntentV1 {
  return {
    renderSpec: {
      sources: [{
        actorId: 'ego', sensorId: 'cam', outputName: 'cam', modality: 'rgb',
        transform: { position: { x: 0, y: 1, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
        attributes: { ...attributes, horizontalFovDeg: 90, nearM: 0.1, farM: 500 },
      }],
      artifacts: ['manifest'],
      capabilityIntent: { required: [], preferred: [], fidelity: 'dataset' },
    },
  } as unknown as RenderIntentV1;
}

describe('assertEngineSupportsIntent', () => {
  it('checks every camera source against the engine limits, not only the video block', () => {
    expect(() => assertEngineSupportsIntent(declaration, intent({ width: 1920, height: 1080, fps: 30 }))).not.toThrow();
    expect(() => assertEngineSupportsIntent(declaration, intent({ width: 8192, height: 4320, fps: 30 })))
      .toThrow(UnsupportedRenderIntentError);
    expect(() => assertEngineSupportsIntent(declaration, intent({ width: 1920, height: 1080, fps: 120 })))
      .toThrow(/source cam frame rate 120 exceeds engine limit/);
  });
});
