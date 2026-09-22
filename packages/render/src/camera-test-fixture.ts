import { CameraProfileSchema, RenderIntentV1Schema, type RenderIntentV1 } from '@simforge-oss/scenario';

export function cameraIntent(profileSource: 'default' | 'authored' = 'default'): RenderIntentV1 {
  return RenderIntentV1Schema.parse({
    schema: 'simforge.render-intent/v1',
    intentId: 'camera-profile-explicitness',
    executionPackage: { id: 'camera-profile-explicitness', sourceInputDigest: 'a'.repeat(64) },
    scenarioRevision: {
      revisionId: 'camera-profile-explicitness', scenarioSha256: 'b'.repeat(64),
      openScenario: { sha256: 'c'.repeat(64), sizeBytes: 1 },
      map: { mapId: 'map', revisionId: 'map', sha256: 'd'.repeat(64) },
    },
    sensorHosts: [{
      sourceId: 'camera-rgb',
      actorId: 'ego',
      vehicleAsset: { catalogAssetId: 'vehicle.generic.sedan' },
    }],
    renderSpec: {
      schema: 'simforge.render-spec/v3',
      sources: [{
        actorId: 'ego', sensorId: 'camera', outputName: 'camera-rgb', modality: 'rgb',
        transform: { position: { x: 0, y: 1, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
        attributes: {
          width: 320, height: 180, fps: 24, horizontalFovDeg: 90, nearM: 0.1, farM: 100,
          cameraProfile: CameraProfileSchema.parse({}),
          profileSource,
        },
      }],
      clip: { startSeconds: 0, endSeconds: 1 },
      artifacts: ['manifest'],
      capabilityIntent: {
        required: ['sensor.rgb', 'artifact.manifest', ...(profileSource === 'authored' ? ['camera.output.linear_rgb'] : [])],
        preferred: profileSource === 'default' ? ['camera.output.linear_rgb'] : [],
        fidelity: 'dataset',
      },
      authoredEnvironment: { weather: 'clear', timeOfDay: 'noon', surfacePatches: [] },
    },
    assets: [],
    seed: 1,
  });
}
