import { describe, expect, it } from 'vitest';

import {
  BrowserRenderLoweringError,
  RENDER_SPEC_V3_SCHEMA,
  lowerRenderSpecToBrowser,
  lowerRenderSpecToCarla,
  parseRenderSpecV3,
  resolveCaptureManifest,
  type RenderSpecV3,
} from '../render-spec.js';

const authoredEnvironment = {
  weather: 'cloudy' as const,
  timeOfDay: 'dusk' as const,
  surfacePatches: [],
};

const transform = {
  position: { x: 1, y: 2, z: 3 },
  rotation: { yawRad: 0.2, pitchRad: -0.1, rollRad: 0.05 },
};

const cameraAttributes = {
  width: 1280,
  height: 720,
  fps: 30,
  horizontalFovDeg: 90,
  nearM: 0.1,
  farM: 500,
};

function cameraSource(sensorId = 'camera', modality: 'rgb' | 'depth' | 'semantic' | 'instance' = 'rgb') {
  return {
    actorId: 'ego',
    sensorId,
    outputName: `${sensorId}-${modality}`,
    transform,
    modality,
    attributes: cameraAttributes,
  };
}

function baseSpec(sources: unknown[] = [cameraSource()]): unknown {
  return {
    schema: RENDER_SPEC_V3_SCHEMA,
    sources,
    clip: { startSeconds: 1, endSeconds: 3 },
    video: {
      width: 1280,
      height: 720,
      fps: 30,
      container: 'webm',
      codec: 'vp9',
      quality: 'standard',
    },
    artifacts: ['video', 'manifest', 'frames', 'sensorArchive'],
    capabilityIntent: {
      required: ['environment.authored', 'timing.fixed_step'],
      preferred: [],
      fidelity: 'dataset',
    },
    authoredEnvironment,
  };
}

const lidarSource = {
  actorId: 'ego',
  sensorId: 'lidar',
  outputName: 'lidar-points',
  transform,
  modality: 'lidar' as const,
  attributes: {
    channels: 64,
    rangeM: 250,
    pointsPerSecond: 1_000_000,
    rotationFrequencyHz: 20,
    upperFovDeg: 15,
    lowerFovDeg: -25,
  },
};

const radarSource = {
  actorId: 'ego',
  sensorId: 'radar',
  outputName: 'radar-points',
  transform,
  modality: 'radar' as const,
  attributes: {
    horizontalFovDeg: 40,
    verticalFovDeg: 20,
    rangeM: 200,
    pointsPerSecond: 15_000,
  },
};

describe('render-spec/v3 parsing', () => {
  it('accepts heterogeneous resolved sources', () => {
    const parsed = parseRenderSpecV3(baseSpec([
      cameraSource(),
      cameraSource('camera', 'depth'),
      lidarSource,
      radarSource,
    ]));
    expect(parsed.sources.map((source) => source.modality)).toEqual(['rgb', 'depth', 'lidar', 'radar']);
  });

  it('rejects duplicate source identities, empty sources, and more than 64 sources', () => {
    expect(() => parseRenderSpecV3(baseSpec([cameraSource(), cameraSource()])))
      .toThrow(/duplicate actor\/sensor\/modality capture source/);
    expect(() => parseRenderSpecV3(baseSpec([]))).toThrow(/Too small/);
    const sources = Array.from({ length: 65 }, (_, index) => cameraSource(`camera-${index}`));
    expect(() => parseRenderSpecV3(baseSpec(sources))).toThrow(/Too big/);
  });

  it('accepts only the simforge namespace tag', () => {
    expect(() => parseRenderSpecV3({ ...(baseSpec() as Record<string, unknown>), schema: 'uniscenario.render-spec/v3' }))
      .toThrow();
  });

  it('requires video configuration exactly when video is an artifact', () => {
    const missing = baseSpec() as Record<string, unknown>;
    delete missing.video;
    expect(() => parseRenderSpecV3(missing)).toThrow(/video configuration must be present if and only if/);

    const extra = baseSpec() as Record<string, unknown>;
    extra.artifacts = ['manifest'];
    expect(() => parseRenderSpecV3(extra)).toThrow(/video configuration must be present if and only if/);
  });

  it('rejects out-of-range and inconsistent modality attributes', () => {
    expect(() => parseRenderSpecV3(baseSpec([{
      ...cameraSource(),
      attributes: { ...cameraAttributes, width: 63 },
    }]))).toThrow();
    expect(() => parseRenderSpecV3(baseSpec([{
      ...lidarSource,
      attributes: { ...lidarSource.attributes, channels: 257 },
    }]))).toThrow();
    expect(() => parseRenderSpecV3(baseSpec([{
      ...lidarSource,
      attributes: { ...lidarSource.attributes, upperFovDeg: -30 },
    }]))).toThrow(/upperFovDeg must be greater than lowerFovDeg/);
    expect(() => parseRenderSpecV3(baseSpec([{
      ...radarSource,
      attributes: { ...radarSource.attributes, horizontalFovDeg: 181 },
    }]))).toThrow();
  });
});

describe('render spec adapters', () => {
  it('lowers byte-for-byte to the managed v1 sensor array', () => {
    const spec = parseRenderSpecV3(baseSpec([cameraSource(), lidarSource, radarSource]));
    expect(lowerRenderSpecToCarla(spec)).toEqual([
      {
        id: 'camera-rgb',
        attachTo: 'ego',
        transform: { x: 1, y: -3, z: 2, pitch: 0.1, yaw: 0.2, roll: 0.05 },
        kind: 'rgb',
        attachment: 'rigid',
        attributes: {
          width: 1280,
          height: 720,
          fov: Math.PI / 2,
          clipNear: 0.1,
          clipFar: 500,
          enablePostprocessEffects: true,
        },
      },
      {
        id: 'lidar-points',
        attachTo: 'ego',
        transform: { x: 1, y: -3, z: 2, pitch: 0.1, yaw: 0.2, roll: 0.05 },
        kind: 'lidar',
        attachment: 'rigid',
        attributes: {
          channels: 64,
          range: 250,
          pointsPerSecond: 1_000_000,
          rotationFrequency: 20,
          upperFov: Math.PI / 12,
          lowerFov: -5 * Math.PI / 36,
        },
      },
      {
        id: 'radar-points',
        attachTo: 'ego',
        transform: { x: 1, y: -3, z: 2, pitch: 0.1, yaw: 0.2, roll: 0.05 },
        kind: 'radar',
        attachment: 'rigid',
        attributes: {
          horizontalFov: 2 * Math.PI / 9,
          verticalFov: Math.PI / 9,
          range: 200,
          pointsPerSecond: 15_000,
        },
      },
    ]);
  });

  it('rejects dishonest semantic browser plans with a stable error code', () => {
    const spec = parseRenderSpecV3(baseSpec([cameraSource('camera', 'semantic')]));
    try {
      lowerRenderSpecToBrowser(spec);
      throw new Error('expected semantic lowering to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserRenderLoweringError);
      expect((error as BrowserRenderLoweringError).code).toBe('semantic_requires_static_semantics');
    }

    const capable = parseRenderSpecV3({
      ...(baseSpec([cameraSource('camera', 'semantic')]) as object),
      capabilityIntent: {
        required: ['map.static_semantics'],
        preferred: [],
        fidelity: 'dataset',
      },
    });
    expect(lowerRenderSpecToBrowser(capable).passes[0]).toMatchObject({
      modality: 'semantic',
      sensorId: 'camera',
      width: 1280,
    });
  });
});

describe('multi-source resolved capture manifest', () => {
  it('accepts submitted v3 source identities and transforms without an authored-sensor snapshot', () => {
    const spec = parseRenderSpecV3(baseSpec([cameraSource(), lidarSource]));
    const manifest = resolveCaptureManifest(spec, {
      createdAt: '2026-08-18T12:00:00.000Z',
      scenarioRevision: { id: 'revision-1', contentSha256: 'a'.repeat(64) },
      playbackEvidence: {
        inputSha256: 'b'.repeat(64),
        traceSha256: 'c'.repeat(64),
        engineVersion: 'test-engine',
        traceVersion: 1,
        bounds: { startSeconds: 0, endSeconds: 10, verified: true },
        identity: { complete: true, hashBound: true },
      },
      mapEvidence: { mapId: 'test-map' },
      renderer: {
        id: 'browser',
        version: '1',
        availableCapabilities: [
          'environment.authored',
          'timing.fixed_step',
          'sensor.rgb',
          'sensor.lidar',
          'artifact.video',
          'artifact.manifest',
          'artifact.frames',
          'artifact.sensor_archive',
        ],
      },
      revisionEnvironment: {
        authoritativeEnvironment: authoredEnvironment,
        operationalConditions: {
          weather: 'clear',
          timeOfDay: 'day',
          traffic: 'light',
          visibility: 'unrestricted',
          effects: { visibilityRangeM: 1_000, frictionScale: 1, trafficSpeedFactor: 1 },
        },
      },
      captureSource: {
        kind: 'execution-package',
        executionPackageId: 'usepkg_1',
        executionPackageSha256: 'd'.repeat(64),
        xoscSha256: 'e'.repeat(64),
      },
    });
    expect(manifest.renderSpec.schema).toBe(RENDER_SPEC_V3_SCHEMA);
    expect(manifest.resolvedSources).toHaveLength(2);
    expect(manifest.resolvedSources).toEqual(spec.sources);
    expect(Object.isFrozen(manifest.resolvedSources[0])).toBe(true);
    // A package-sourced capture must name the immutable bytes it replayed; that claim is the only
    // thing that distinguishes it from a recording of the live editor simulation.
    expect(manifest.captureSource).toEqual({
      kind: 'execution-package',
      executionPackageId: 'usepkg_1',
      executionPackageSha256: 'd'.repeat(64),
      xoscSha256: 'e'.repeat(64),
    });
  });
});
