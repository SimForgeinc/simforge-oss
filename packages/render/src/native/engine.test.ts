import { describe, expect, it } from 'vitest';

import { CameraProfileSchema, type RenderIntentV1, type RenderSensorSourceHost, type RenderSourceV3 } from '@simforge-oss/scenario';

import {
  UnsupportedRenderIntentError,
  assertEngineSupportsIntent,
} from '../capabilities.js';
import {
  createRenderEngine,
  resolveBinary,
  resolveEffectiveCameraProfile,
  resolveNativeCaptureProfile,
} from './engine.js';
import { createNativeCameraSchedule } from './camera-schedule.js';
import type { NativeSceneState } from './lowering.js';
import { stripRgbaPadding } from './service-client.js';

const profile = CameraProfileSchema.parse({});
const intent: RenderIntentV1 = {
  schema: 'simforge.render-intent/v1',
  intentId: 'camera-capabilities',
  executionPackage: { id: 'camera-capabilities', sourceInputDigest: 'a'.repeat(64) },
  scenarioRevision: {
    revisionId: 'camera-capabilities', scenarioSha256: 'b'.repeat(64),
    openScenario: { sha256: 'c'.repeat(64), sizeBytes: 1 },
    map: { mapId: 'map', revisionId: 'map', sha256: 'd'.repeat(64) },
  },
  sensorHosts: [],
  renderSpec: {
    schema: 'simforge.render-spec/v3',
    sources: [{
      actorId: 'ego', sensorId: 'camera', outputName: 'camera-rgb', modality: 'rgb',
      transform: { position: { x: 0, y: 1, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
      attributes: { width: 320, height: 180, fps: 24, horizontalFovDeg: 90, nearM: 0.1, farM: 100, cameraProfile: profile, profileSource: 'default' },
    }],
    clip: { startSeconds: 0, endSeconds: 1 },
    artifacts: ['manifest'],
    capabilityIntent: { required: ['sensor.rgb', 'artifact.manifest'], preferred: [], fidelity: 'dataset' },
    authoredEnvironment: { weather: 'clear', timeOfDay: 'noon', surfacePatches: [] },
  },
  assets: [],
  seed: 1,
};

function rejectionReasons(candidate: RenderIntentV1): readonly string[] {
  try {
    assertEngineSupportsIntent(createRenderEngine({ binary: '/bin/true' }).capabilities, candidate);
  } catch (error) {
    if (error instanceof UnsupportedRenderIntentError) return error.reasons;
    throw error;
  }
  throw new Error('expected render intent rejection');
}

function withProfile(cameraProfile: typeof profile): RenderIntentV1 {
  const source = intent.renderSpec.sources[0]!;
  if (source.modality !== 'rgb') throw new Error('test source must be RGB');
  return {
    ...intent,
    renderSpec: { ...intent.renderSpec, sources: [{ ...source, attributes: { ...source.attributes, cameraProfile, profileSource: 'authored' } }] },
  };
}

describe('native retained engine adapter', () => {
  it('declares cameras, cast lidar/radar, and the artifact contract - not camera derivatives', () => {
    const engine = createRenderEngine({ binary: '/bin/true' });
    expect(engine.capabilities).toMatchObject({
      engineId: 'bevy-retained',
      backend: 'native',
      modalities: ['rgb', 'lidar', 'radar'],
      requiresGpu: true,
      features: {
        'full-mount-rotation': {
          support: 'supported',
          evidenceTier: 'integrated',
          note: 'GPU rendered-horizon proof pending',
        },
        'principal-point-offset': {
          support: 'unsupported',
          evidenceTier: 'declared',
          effective: { xPx: 0, yPx: 0 },
          note: 'ServiceCamera has no principal-point input; Bevy sub_camera_view is the Phase 2/4 route',
        },
      },
    });
    expect(engine.capabilities.capabilities).toEqual(expect.arrayContaining([
      'sensor.rgb', 'sensor.lidar', 'sensor.radar', 'artifact.video', 'artifact.manifest', 'artifact.trace', 'artifact.sensor_archive',
      'full-mount-rotation',
    ]));
    expect(engine.capabilities.capabilities).not.toEqual(expect.arrayContaining([
      'sensor.depth', 'sensor.semantic', 'sensor.instance',
    ]));
    expect(engine.capabilities.approximations).toBeUndefined();
    expect(assertEngineSupportsIntent(engine.capabilities, intent)).toEqual({ warnings: [] });
  });

  it('resolves the retained service binary from explicit options', () => {
    expect(resolveBinary({ binary: '/opt/native-render-service' })).toBe('/opt/native-render-service');
  });

  it('uses a stable sensor profile for dataset capture and cinematic metering for review', () => {
    expect(resolveNativeCaptureProfile('dataset')).toEqual({ profile: 'sensor', autoMeter: false });
    expect(resolveNativeCaptureProfile('review')).toEqual({ profile: 'cinematic', autoMeter: true });
    expect(resolveNativeCaptureProfile('dataset', true)).toEqual({ profile: 'sensor', autoMeter: false });
    expect(resolveNativeCaptureProfile('review', false)).toEqual({ profile: 'cinematic', autoMeter: false });
  });

  it('reports the generic sensor profile instead of overstating a custom request', () => {
    const custom = CameraProfileSchema.parse({
      profileId: 'device-x@1',
      fidelity: 'device-fitted',
      encoding: { transfer: 'linear', bitDepth: 12 },
    });
    expect(resolveEffectiveCameraProfile(custom, 'sensor')).toMatchObject({
      effective: { profileId: 'generic-rgb@1', fidelity: 'generic-uncalibrated' },
      differences: ['cameraProfile: generic-rgb@1 sensor profile used instead of requested profile'],
    });
    expect(resolveEffectiveCameraProfile(custom, 'cinematic')).toEqual({
      effective: null,
      differences: ['cameraProfile: not applied by cinematic review capture'],
    });
  });

  it('rejects rolling shutter with a stable capability reason', () => {
    const rolling = CameraProfileSchema.parse({ acquisition: { shutter: 'rolling', readoutSpanS: 0.01 } });
    expect(rejectionReasons(withProfile(rolling))).toContain('missing capability camera.shutter.rolling');
  });

  it('rejects PTC noise with a stable capability reason', () => {
    const ptc = CameraProfileSchema.parse({ detector: { noise: 'ptc' } });
    expect(rejectionReasons(withProfile(ptc))).toContain('missing capability camera.noise.ptc');
  });

  it('rejects raw output requested as a required capability', () => {
    const raw: RenderIntentV1 = {
      ...intent,
      renderSpec: {
        ...intent.renderSpec,
        capabilityIntent: {
          ...intent.renderSpec.capabilityIntent,
          required: [...intent.renderSpec.capabilityIntent.required, 'camera.output.raw'],
        },
      },
    };
    expect(rejectionReasons(raw)).toContain('missing capability camera.output.raw');
  });

  it('rejects authored principal-point offsets and records the centred effective value', () => {
    const offset = CameraProfileSchema.parse({
      projection: { principalPointOffsetPx: { x: 12, y: -7 } },
    });
    expect(rejectionReasons(withProfile(offset))).toContain('missing capability camera.principal_point_offset');
    expect(resolveEffectiveCameraProfile(offset, 'sensor').effective?.projection.principalPointOffsetPx).toBeUndefined();
    expect(createRenderEngine({ binary: '/bin/true' }).capabilities.features?.['principal-point-offset']?.effective)
      .toEqual({ xPx: 0, yPx: 0 });
  });

  it('rejects reported calibration overrides when an engine does not declare support', () => {
    const engine = createRenderEngine({ binary: '/bin/true' });
    const candidate: RenderIntentV1 = {
      ...intent,
      renderSpec: {
        ...intent.renderSpec,
        capabilityIntent: {
          ...intent.renderSpec.capabilityIntent,
          required: [...intent.renderSpec.capabilityIntent.required, 'camera.reported-calibration-override'],
        },
      },
    };
    const unsupported = {
      ...engine.capabilities,
      capabilities: engine.capabilities.capabilities.filter(
        (capability) => capability !== 'camera.reported-calibration-override',
      ),
    };

    expect(() => assertEngineSupportsIntent(unsupported, candidate)).toThrowError(
      expect.objectContaining({ reasons: ['missing capability camera.reported-calibration-override'] }),
    );
    expect(() => assertEngineSupportsIntent(engine.capabilities, candidate)).not.toThrow();
  });

  it('keeps T08 native camera requests fixed while reported calibration changes', () => {
    const source = intent.renderSpec.sources[0]! as RenderSourceV3;
    if (source.modality !== 'rgb') throw new Error('test source must be RGB');
    const reportedCalibration = {
      intrinsics: {
        horizontalFovDeg: 90,
        verticalFovDeg: 58.7155,
        aspectRatio: 16 / 9,
        nearM: 0.1,
        farM: 100,
      },
      extrinsics: source.transform,
    };
    const control: RenderSourceV3 = {
      ...source,
      attributes: { ...source.attributes, reportedCalibration },
    };
    const perturbed: RenderSourceV3 = {
      ...source,
      attributes: {
        ...source.attributes,
        reportedCalibration: {
          ...reportedCalibration,
          extrinsics: {
            ...reportedCalibration.extrinsics,
            rotation: { ...reportedCalibration.extrinsics.rotation, yawRad: 0.1 },
          },
        },
        calibrationPerturbation: { kind: 'yaw-offset', yawOffsetRad: 0.1, label: 'T08 reported yaw' },
      },
    };
    const host: RenderSensorSourceHost = {
      sourceId: source.outputName,
      actorId: source.actorId,
      vehicleAsset: { catalogAssetId: 'vehicle.sedan' },
    };
    const state: NativeSceneState = {
      version: 'simforge.scene-state.v1', mapId: 'map', tick: 0, tickHz: 24,
      weather: { preset: 'clear' }, timeOfDay: 12,
      actors: [{
        id: source.actorId, kind: 'spawn', catalogId: 'vehicle.sedan', actorClass: 'car',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, velocity: [0, 0, 0],
      }],
    };

    expect(createNativeCameraSchedule([perturbed], [host], [state]))
      .toEqual(createNativeCameraSchedule([control], [host], [state]));
    expect(perturbed.attributes.reportedCalibration)
      .not.toEqual(control.attributes.reportedCalibration);
  });

  it('reports every unsupported camera feature in a combination', () => {
    const combined = withProfile(CameraProfileSchema.parse({
      detector: { noise: 'ptc' },
      acquisition: { shutter: 'rolling', readoutSpanS: 0.01 },
    }));
    const unsupported: RenderIntentV1 = {
      ...combined,
      renderSpec: {
        ...combined.renderSpec,
        capabilityIntent: {
          ...combined.renderSpec.capabilityIntent,
          required: [...combined.renderSpec.capabilityIntent.required, 'camera.output.raw'],
        },
      },
    };
    expect(rejectionReasons(unsupported)).toEqual(expect.arrayContaining([
      'missing capability camera.output.raw',
      'missing capability camera.shutter.rolling',
      'missing capability camera.noise.ptc',
    ]));
  });

  it.each([
    ['brown-conrady', 'camera.projection.brown_conrady'],
    ['kannala-brandt', 'camera.projection.kannala_brandt'],
  ] as const)('rejects authored non-pinhole projection %s with a structured reason', (model, capability) => {
    expect(rejectionReasons(withProfile(CameraProfileSchema.parse({ projection: { model } })))).toEqual([
      `missing capability ${capability}`,
    ]);
  });

  it('accepts pinhole as the native projection family', () => {
    expect(() => assertEngineSupportsIntent(
      createRenderEngine({ binary: '/bin/true' }).capabilities,
      withProfile(CameraProfileSchema.parse({ projection: { model: 'pinhole' } })),
    )).not.toThrow();
  });

  it('removes wgpu row padding before rawvideo encoding', () => {
    const width = 65;
    const height = 2;
    const stride = 512;
    const padded = Buffer.alloc(stride * height, 0xee);
    padded.fill(1, 0, width * 4);
    padded.fill(2, stride, stride + width * 4);
    const packed = stripRgbaPadding(padded, width, height);
    expect(packed).toHaveLength(width * height * 4);
    expect([...packed.subarray(0, width * 4)]).toEqual(new Array(width * 4).fill(1));
    expect([...packed.subarray(width * 4)]).toEqual(new Array(width * 4).fill(2));
  });
});
