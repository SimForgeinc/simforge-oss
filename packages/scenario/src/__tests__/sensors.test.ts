import { describe, expect, it } from 'vitest';

import { ScenarioOperationError, ScenarioValidationError } from '../errors.js';
import { buildCanonicalRenderSpec } from '../render-spec-builders.js';
import { parseRenderSpecV3 } from '../render-spec.js';
import { parseTemplate, serializeTemplate } from '../serialize.js';
import { TemplateDocument } from '../template-document.js';
import {
  ActorSensorSchema,
  CameraCalibrationSetSchema,
  CameraProfileSchema,
  cameraCalibrationWithYawOffset,
  dashCameras,
  firstEnabledDashCamera,
  newSensorId,
  sensorAperture,
} from '../schema/v2/sensors.js';
import {
  defaultDashCamera,
  defaultLidar,
  defaultRadar,
  instantiateSensorRig,
  matchSensorMountPreset,
  SensorRigCameraTemplateSchema,
} from '../schema/v2/sensor-rigs.js';
import { ltapTemplateInput } from './v2-fixtures.js';

describe('actor-attached sensors', () => {
  it('migrates legacy actor specs to an explicit empty sensor list', () => {
    const template = parseTemplate(ltapTemplateInput());
    expect(template.roles.every((role) => Array.isArray(role.actor.sensors))).toBe(true);
    expect(template.roles[0]?.actor.sensors).toEqual([]);
  });

  it('round-trips a dash camera without losing its stable id or calibration', () => {
    const input = ltapTemplateInput();
    const camera = defaultDashCamera(
      { class: 'car', dims: { length: 4.4, width: 1.8, height: 1.6 } },
      'front-dash-camera',
    );
    input.roles![0]!.actor.sensors = [camera];

    const first = parseTemplate(input);
    const second = parseTemplate(JSON.parse(serializeTemplate(first)));
    expect(firstEnabledDashCamera(second.roles[0]!.actor)?.id).toBe('front-dash-camera');
    expect(firstEnabledDashCamera(second.roles[0]!.actor)?.profile).toMatchObject({
      profileId: 'generic-rgb@1',
      fidelity: 'generic-uncalibrated',
      acquisition: { shutter: 'global' },
      outputStage: 'linear',
      encoding: { transfer: 'srgb', bitDepth: 8 },
    });
    expect(firstEnabledDashCamera(first.roles[0]!.actor)?.profileSource).toBe('default');
    expect(firstEnabledDashCamera(second.roles[0]!.actor)?.profileSource).toBe('default');

    const spec = buildCanonicalRenderSpec({
      content: first,
      selections: [{ actorId: first.roles[0]!.id, sensorId: camera.id, modalities: ['rgb'] }],
      clip: { startSeconds: 0, endSeconds: 1 },
      video: null,
      artifacts: [],
      staticSemantics: false,
      fidelity: 'dataset',
    });
    const source = spec.sources.find((candidate) => candidate.modality === 'rgb');
    expect(source?.attributes).toMatchObject({
      cameraProfile: {
        profileId: 'generic-rgb@1',
        outputStage: 'linear',
        encoding: { transfer: 'srgb', bitDepth: 8 },
      },
      profileSource: 'default',
    });
    expect(spec.capabilityIntent.required).not.toContain('camera.output.linear_rgb');
    expect(spec.capabilityIntent.preferred).toContain('camera.output.linear_rgb');

    const withoutProfile = JSON.parse(JSON.stringify(spec));
    delete withoutProfile.sources[0].attributes.cameraProfile;
    delete withoutProfile.sources[0].attributes.profileSource;
    expect(parseRenderSpecV3(withoutProfile).sources[0]?.attributes).toMatchObject({
      cameraProfile: { profileId: 'generic-rgb@1' },
      profileSource: 'default',
    });
    const explicitProfile = JSON.parse(JSON.stringify(spec));
    explicitProfile.sources[0].attributes.cameraProfile = CameraProfileSchema.parse({});
    delete explicitProfile.sources[0].attributes.profileSource;
    expect(parseRenderSpecV3(explicitProfile).sources[0]?.attributes).toMatchObject({
      cameraProfile: { profileId: 'generic-rgb@1' },
      profileSource: 'authored',
    });

    const sensorWithoutSource = JSON.parse(JSON.stringify(camera));
    sensorWithoutSource.profile = CameraProfileSchema.parse({});
    delete sensorWithoutSource.profileSource;
    expect(ActorSensorSchema.parse(sensorWithoutSource)).toMatchObject({ profileSource: 'authored' });

    expect(ActorSensorSchema.parse({
      ...sensorWithoutSource,
      profileSource: 'default',
    })).toMatchObject({ profileSource: 'authored' });

    const depthSpec = buildCanonicalRenderSpec({
      content: first,
      selections: [{ actorId: first.roles[0]!.id, sensorId: camera.id, modalities: ['depth'] }],
      clip: { startSeconds: 0, endSeconds: 1 },
      video: null,
      artifacts: [],
      staticSemantics: false,
      fidelity: 'dataset',
    });
    expect(depthSpec.capabilityIntent.preferred).toContain('camera.output.linear_rgb');

    const resolvedCamera = firstEnabledDashCamera(second.roles[0]!.actor)!;
    const authoredCamera = {
      ...resolvedCamera,
      profile: resolvedCamera.profile,
      profileSource: 'authored' as const,
    };
    const authoredTemplate = parseTemplate({
      ...second,
      roles: second.roles.map((role, index) => index === 0
        ? { ...role, actor: { ...role.actor, sensors: [authoredCamera] } }
        : role),
    });
    const authoredSpec = buildCanonicalRenderSpec({
      content: authoredTemplate,
      selections: [{ actorId: authoredTemplate.roles[0]!.id, sensorId: authoredCamera.id, modalities: ['rgb'] }],
      clip: { startSeconds: 0, endSeconds: 1 },
      video: null,
      artifacts: [],
      staticSemantics: false,
      fidelity: 'dataset',
    });
    expect(authoredSpec.sources[0]?.attributes).toMatchObject({ profileSource: 'authored' });
    expect(authoredSpec.capabilityIntent.required).toContain('camera.output.linear_rgb');
    expect(authoredSpec.capabilityIntent.preferred).not.toContain('camera.output.linear_rgb');
  });

  it('keeps mixed-rig preferred capabilities disjoint from authored requirements', () => {
    const input = ltapTemplateInput();
    const materialized = defaultDashCamera(
      { class: 'car', dims: { length: 4.4, width: 1.8, height: 1.6 } },
      'default-camera',
    );
    const { profile, profileSource: _profileSource, ...withoutProfile } = materialized;
    input.roles![0]!.actor.sensors = [
      withoutProfile,
      { ...withoutProfile, id: 'authored-camera', profile },
    ];
    const template = parseTemplate(input);
    const cameras = template.roles[0]!.actor.sensors;
    expect(cameras.map((sensor) => sensor.type === 'dash_camera' ? sensor.profileSource : null))
      .toEqual(['default', 'authored']);

    const spec = buildCanonicalRenderSpec({
      content: template,
      selections: cameras.map((sensor) => ({ actorId: template.roles[0]!.id, sensorId: sensor.id, modalities: ['rgb'] })),
      clip: { startSeconds: 0, endSeconds: 1 },
      video: null,
      artifacts: [],
      staticSemantics: false,
      fidelity: 'dataset',
    });
    expect(spec.capabilityIntent.required).toEqual(expect.arrayContaining([
      'camera.projection.pinhole',
      'camera.shutter.global',
      'camera.output.linear_rgb',
    ]));
    for (const required of spec.capabilityIntent.required) {
      expect(spec.capabilityIntent.preferred).not.toContain(required);
    }
  });

  it('uses actual calibration for rendering and reported calibration for consumers', () => {
    const input = ltapTemplateInput();
    const camera = defaultDashCamera(
      { class: 'car', dims: { length: 4.4, width: 1.8, height: 1.6 } },
      'calibrated-camera',
    );
    const actual = { intrinsics: camera.camera, extrinsics: camera.mount };
    camera.calibration = cameraCalibrationWithYawOffset(actual, 0.1, 'T08 reported yaw');
    input.roles![0]!.actor.sensors = [camera];
    const template = parseTemplate(input);
    const spec = buildCanonicalRenderSpec({
      content: template,
      selections: [{ actorId: template.roles[0]!.id, sensorId: camera.id, modalities: ['rgb'] }],
      clip: { startSeconds: 0, endSeconds: 1 },
      video: null,
      artifacts: [],
      staticSemantics: false,
      fidelity: 'dataset',
    });
    const source = spec.sources[0]!;
    if (source.modality !== 'rgb') throw new Error('expected RGB source');

    expect(source.transform).toEqual(actual.extrinsics);
    expect(source.attributes.reportedCalibration?.extrinsics.rotation.yawRad)
      .toBeCloseTo(actual.extrinsics.rotation.yawRad + 0.1);
    expect(source.attributes.calibrationSource).toBe('authored');
    expect(source.attributes.calibrationPerturbation).toMatchObject({ kind: 'yaw-offset', yawOffsetRad: 0.1 });
    expect(spec.capabilityIntent.required).toContain('camera.reported-calibration-override');
    expect(spec.capabilityIntent.preferred).not.toContain('camera.reported-calibration-override');

    expect(CameraCalibrationSetSchema.safeParse({
      ...camera.calibration,
      reported: actual,
    }).success).toBe(false);
    expect(CameraCalibrationSetSchema.safeParse({
      actual: {
        ...actual,
        extrinsics: { ...actual.extrinsics, rotation: { ...actual.extrinsics.rotation, yawRad: 0.2 } },
      },
      reported: {
        ...actual,
        extrinsics: { ...actual.extrinsics, rotation: { ...actual.extrinsics.rotation, yawRad: 0.3 } },
      },
      perturbation: { kind: 'yaw-offset', yawOffsetRad: 0.1, label: 'decimal yaw' },
    }).success).toBe(true);
    const wrapped = cameraCalibrationWithYawOffset({
      ...actual,
      extrinsics: { ...actual.extrinsics, rotation: { ...actual.extrinsics.rotation, yawRad: 3.1 } },
    }, 0.1, 'wrapped yaw');
    expect(wrapped.reported.extrinsics.rotation.yawRad).toBeCloseTo(3.2 - 2 * Math.PI);

    const explicitUnperturbed = { ...camera, id: 'explicit-unperturbed', calibration: { actual, reported: actual } };
    const explicitTemplate = parseTemplate({
      ...input,
      roles: input.roles!.map((role, index) => index === 0
        ? { ...role, actor: { ...role.actor, sensors: [explicitUnperturbed] } }
        : role),
    });
    const explicitSpec = buildCanonicalRenderSpec({
      content: explicitTemplate,
      selections: [{ actorId: explicitTemplate.roles[0]!.id, sensorId: explicitUnperturbed.id, modalities: ['rgb'] }],
      clip: { startSeconds: 0, endSeconds: 1 },
      video: null,
      artifacts: [],
      staticSemantics: false,
      fidelity: 'dataset',
    });
    expect(explicitSpec.capabilityIntent.required).toContain('camera.reported-calibration-override');
    expect(ActorSensorSchema.safeParse({
      ...camera,
      mount: { ...camera.mount, position: { ...camera.mount.position, x: camera.mount.position.x + 1 } },
    }).success).toBe(false);

    const rigMount = {
      anchor: { longitudinal: 'front' as const, vertical: 'top' as const, lateral: 'center' as const },
      offset: { x: -0.35, y: -0.25, z: 0 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    };
    const rigCamera = SensorRigCameraTemplateSchema.parse({
      ...camera,
      mount: rigMount,
      calibration: {
        actual: { intrinsics: camera.camera, extrinsics: rigMount },
        reported: {
          intrinsics: camera.camera,
          extrinsics: { ...rigMount, rotation: { ...rigMount.rotation, yawRad: 0.1 } },
        },
        perturbation: { kind: 'yaw-offset', yawOffsetRad: 0.1, label: 'T08 reported yaw' },
      },
    });
    const [instantiated] = instantiateSensorRig(
      { id: 'calibrated-rig', name: 'Calibrated rig', sensors: [rigCamera] },
      { class: 'car', dims: { length: 4.4, width: 1.8, height: 1.6 } },
      () => 'instantiated-camera',
    );
    expect(instantiated?.mount).toEqual(instantiated?.type === 'dash_camera' ? instantiated.calibration?.actual.extrinsics : null);
    expect(instantiated?.type === 'dash_camera' ? instantiated.calibration?.reported.extrinsics.rotation.yawRad : null)
      .toBeCloseTo(0.1);
  });

  it('requires rolling-shutter profiles to declare their readout span', () => {
    expect(() => CameraProfileSchema.parse({ acquisition: { shutter: 'rolling' } }))
      .toThrow(/readoutSpanS/);
  });

  it('classifies an explicit custom-rig profile as authored', () => {
    expect(SensorRigCameraTemplateSchema.parse({
      id: 'rig-camera',
      type: 'dash_camera',
      mount: {
        position: { x: 1, y: 1, z: 0 },
        rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
      },
      profile: CameraProfileSchema.parse({}),
    })).toMatchObject({ profileSource: 'authored' });
  });

  it('builds active sensors against the authored dimensions of a non-reference vehicle', () => {
    const bus = { class: 'bus', dims: { length: 12.4, width: 2.55, height: 3.3 } } as const;
    const lidar = ActorSensorSchema.parse(defaultLidar(bus, 'bus-roof-lidar'));
    const radar = ActorSensorSchema.parse(defaultRadar(bus, 'bus-front-radar'));

    // Every default lands on a named mount, so these are the resolved
    // `roof-centre` and `front-bumper` positions for this box, not free numbers.
    expect(lidar).toMatchObject({
      type: 'lidar',
      mount: { position: { x: 0, y: 3.45, z: 0 } },
      field: { horizontalFovDeg: 360 },
    });
    expect(matchSensorMountPreset(lidar.mount, bus)?.id).toBe('roof-centre');
    expect(radar).toMatchObject({
      type: 'radar',
      mount: { position: { x: 6.2, y: 0.5, z: 0 } },
      field: { horizontalFovDeg: 40, verticalFovDeg: 20 },
    });
    expect(matchSensorMountPreset(radar.mount, bus)?.id).toBe('front-bumper');
  });

  it('mints ids that identify the sensor modality', () => {
    expect(newSensorId('dash_camera')).toMatch(/^dash-camera-/);
    expect(newSensorId('lidar')).toMatch(/^lidar-/);
    expect(newSensorId('radar')).toMatch(/^radar-/);
  });

  it('rejects duplicate sensor ids but permits cameras and large rigs on every actor class', () => {
    const duplicate = ltapTemplateInput();
    const camera = defaultDashCamera({ class: 'car' }, 'same-camera');
    duplicate.roles![0]!.actor.sensors = [camera, camera];
    expect(() => parseTemplate(duplicate)).toThrow(ScenarioValidationError);

    const unrestricted = ltapTemplateInput();
    unrestricted.roles![0]!.actor = {
      class: 'pedestrian',
      sensors: Array.from({ length: 40 }, (_, index) =>
        defaultDashCamera({ class: 'pedestrian' }, `pedestrian-camera-${index}`)),
    };
    const parsed = parseTemplate(unrestricted);
    expect(parsed.roles[0]?.actor.sensors).toHaveLength(40);
    expect(parsed.roles[0]?.actor.sensors.every((sensor) => sensor.type === 'dash_camera')).toBe(true);
  });

  it('discovers enabled dash cameras deterministically', () => {
    const first = defaultDashCamera({ class: 'car' }, 'first');
    const disabled = { ...defaultDashCamera({ class: 'car' }, 'disabled'), enabled: false };
    const last = defaultDashCamera({ class: 'car' }, 'last');
    expect(dashCameras({ sensors: [first, disabled, last] }).map((sensor) => sensor.id))
      .toEqual(['first', 'last']);
  });

  it('supports add, update, remove and undo through TemplateDocument', () => {
    const doc = TemplateDocument.fromJSON(ltapTemplateInput());
    const camera = defaultDashCamera(doc.role('ego')!.actor, 'ego-dash-camera');
    doc.addActorSensor('ego', camera);
    expect(doc.actorSensor('ego', camera.id)).toEqual(camera);

    doc.replaceActorSensor('ego', camera.id, {
      ...camera,
      camera: { ...camera.camera, horizontalFovDeg: 110 },
    });
    // `sensors` is now a union over modalities, so read the angular envelope
    // through the shared accessor rather than a camera-only field.
    expect(sensorAperture(doc.actorSensor('ego', camera.id)!).horizontalFovDeg).toBe(110);

    doc.removeActorSensor('ego', camera.id);
    expect(doc.actorSensor('ego', camera.id)).toBeUndefined();
    expect(doc.undo()).toBe(true);
    expect(sensorAperture(doc.actorSensor('ego', camera.id)!).horizontalFovDeg).toBe(110);
    expect(() => doc.removeActorSensor('ego', 'missing')).toThrow(ScenarioOperationError);
  });
});
