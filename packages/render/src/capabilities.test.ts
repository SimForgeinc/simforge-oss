import { describe, expect, it } from 'vitest';

import { CAMERA_PROFILE_NOT_DECLARED_STATUS, RenderArtifactManifestSchema } from './artifacts.js';
import { assertEngineSupportsIntent, type EngineCapabilityDeclaration } from './capabilities.js';
import { cameraIntent } from './camera-test-fixture.js';

export function cameraEngine(
  backend: EngineCapabilityDeclaration['backend'],
  capabilities: EngineCapabilityDeclaration['capabilities'],
): EngineCapabilityDeclaration {
  return {
    schema: 'simforge.render-engine-capabilities/v1',
    engineId: backend,
    engineVersion: 'test',
    backend,
    protocolVersion: 1,
    capabilities,
    modalities: ['rgb'],
    limits: { maxSimultaneousSensors: 1, maxWidth: 4096, maxHeight: 4096, maxFramesPerSecond: 120 },
    requiresGpu: false,
  };
}

describe('camera profile request explicitness', () => {
  it('records an undeclared default profile as approximated manifest evidence', () => {
    const support = assertEngineSupportsIntent(
      cameraEngine('browser', ['sensor.rgb', 'artifact.manifest']),
      cameraIntent(),
    );
    expect(support).toMatchObject({
      effectiveConfiguration: {
        cameraProfiles: [{ profileSource: 'default', status: CAMERA_PROFILE_NOT_DECLARED_STATUS }],
      },
      warnings: [{ code: 'camera_profile_not_declared_by_engine' }],
    });
    expect(() => RenderArtifactManifestSchema.parse({
      schema: 'simforge.render-artifact-manifest/v1',
      intentSha256: 'a'.repeat(64),
      engine: { engineId: 'browser', engineVersion: 'test', backend: 'browser' },
      startedAt: '2026-09-22T00:00:00.000Z',
      completedAt: '2026-09-22T00:00:01.000Z',
      artifacts: [],
      ...support,
    })).not.toThrow();
  });
});
