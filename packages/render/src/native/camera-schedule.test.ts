import {
  CameraProfileSchema,
  CameraCalibrationSetSchema,
  cameraCalibrationWithYawOffset,
  type CameraCalibrationView,
  type RenderSensorSourceHost,
  type RenderSourceV3,
} from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { createNativeCameraSchedule } from './camera-schedule.js';
import type { NativeSceneState } from './lowering.js';

const source: RenderSourceV3 = {
  actorId: 'ego',
  sensorId: 'dash-camera',
  outputName: 'ego-dash-camera-rgb',
  modality: 'rgb',
  transform: {
    position: { x: 2, y: 1.2, z: 0 },
    rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
  },
  attributes: {
    width: 1280, height: 720, fps: 24, horizontalFovDeg: 90, nearM: 0.05, farM: 1_000,
    cameraProfile: CameraProfileSchema.parse({}),
    profileSource: 'default',
  },
};
const host: RenderSensorSourceHost = {
  sourceId: source.outputName,
  actorId: 'ego',
  vehicleAsset: { catalogAssetId: 'vehicle.sedan' },
};

function state(tick: number, position: readonly [number, number, number], headingRad: number): NativeSceneState {
  return {
    version: 'simforge.scene-state.v1', mapId: 'richmond', tick, tickHz: 24,
    weather: { preset: 'clear' }, timeOfDay: 12,
    actors: [{
      id: 'ego', kind: tick === 0 ? 'spawn' : 'update', catalogId: 'vehicle.sedan', actorClass: 'car',
      transform: {
        position,
        rotation: [0, Math.sin(headingRad / 2), 0, Math.cos(headingRad / 2)],
      },
      velocity: [1, 0, 0],
    }],
  };
}

function rotateCameraVector(
  vector: readonly [number, number, number],
  rotation: CameraCalibrationView['extrinsics']['rotation'],
): [number, number, number] {
  const [x, y, z] = vector;
  const cr = Math.cos(rotation.rollRad); const sr = Math.sin(rotation.rollRad);
  const cp = Math.cos(rotation.pitchRad); const sp = Math.sin(rotation.pitchRad);
  const cy = Math.cos(rotation.yawRad); const sy = Math.sin(rotation.yawRad);
  const rolled: [number, number, number] = [x, cr * y - sr * z, sr * y + cr * z];
  const pitched: [number, number, number] = [cp * rolled[0] - sp * rolled[1], sp * rolled[0] + cp * rolled[1], rolled[2]];
  return [cy * pitched[0] + sy * pitched[2], pitched[1], -sy * pitched[0] + cy * pitched[2]];
}

function projectLandmark(
  calibration: CameraCalibrationView,
  actorPosition: readonly [number, number, number],
  width: number,
  height: number,
  landmark: readonly [number, number, number],
): [number, number] {
  const mount = calibration.extrinsics.position;
  const eye = [actorPosition[0] + mount.x, actorPosition[1] + mount.y, actorPosition[2] - mount.z] as const;
  const delta = landmark.map((value, index) => value - eye[index]!) as [number, number, number];
  const forward = rotateCameraVector([1, 0, 0], calibration.extrinsics.rotation);
  const up = rotateCameraVector([0, 1, 0], calibration.extrinsics.rotation);
  const right = rotateCameraVector([0, 0, 1], calibration.extrinsics.rotation);
  const dot = (axis: readonly number[]) => delta.reduce((sum, value, index) => sum + value * axis[index]!, 0);
  const depth = dot(forward);
  const fx = (width / 2) / Math.tan(calibration.intrinsics.horizontalFovDeg * Math.PI / 360);
  const fy = (height / 2) / Math.tan(calibration.intrinsics.verticalFovDeg * Math.PI / 360);
  return [width / 2 + fx * dot(right) / depth, height / 2 - fy * dot(up) / depth];
}

describe('native ego-mounted camera schedule', () => {
  it('tracks the simulated host pose and composes the dash mount along its heading', () => {
    const schedule = createNativeCameraSchedule(
      [source],
      [host],
      [state(0, [10, 2, 20], 0), state(1, [11, 2, 18], Math.PI / 2)],
    );

    expect(schedule[0]![0]!.eye).toEqual([12, 3.2, 20]);
    expect(schedule[0]![0]!.target).toEqual([62, 3.2, 20]);
    expect(schedule[1]![0]!.eye[0]).toBeCloseTo(11);
    expect(schedule[1]![0]!.eye[1]).toBeCloseTo(3.2);
    expect(schedule[1]![0]!.eye[2]).toBeCloseTo(16);
    expect(schedule[1]![0]!.target[0]).toBeCloseTo(11);
    expect(schedule[1]![0]!.target[2]).toBeCloseTo(-34);
    expect(schedule[1]![0]!.eye).not.toEqual(schedule[0]![0]!.eye);
  });

  it('reflects authored roll into the x-forward, y-right, z-up attachment', () => {
    const schedule = createNativeCameraSchedule(
      [{
        ...source,
        transform: {
          ...source.transform,
          rotation: { yawRad: 0, pitchRad: 0, rollRad: 10 * Math.PI / 180 },
        },
      }],
      [host],
      [state(0, [10, 2, 20], 0)],
    );

    expect(schedule[0]![0]!.attach.rollDeg).toBeCloseTo(-10);
  });

  it('projects known landmarks from actual calibration at nonzero yaw, pitch, and roll', () => {
    const degrees = Math.PI / 180;
    const width = 640;
    const height = 360;
    const horizontalFovDeg = 90;
    const verticalFovDeg = 2 * Math.atan(Math.tan(horizontalFovDeg * Math.PI / 360) * height / width) / degrees;
    const actual: CameraCalibrationView = {
      intrinsics: { horizontalFovDeg, verticalFovDeg, nearM: 0.05, farM: 1_000, aspectRatio: width / height },
      extrinsics: {
        position: { x: 2, y: 1.5, z: 0.5 },
        rotation: { yawRad: 20 * degrees, pitchRad: -10 * degrees, rollRad: 15 * degrees },
      },
    };
    const calibrated: RenderSourceV3 = {
      ...source,
      transform: actual.extrinsics,
      attributes: {
        ...source.attributes,
        width,
        height,
        horizontalFovDeg,
        reportedCalibration: actual,
      },
    };
    const actorPosition = [10, 2, 20] as const;
    const camera = createNativeCameraSchedule(
      [calibrated],
      [host],
      [state(0, actorPosition, 0)],
    )[0]![0]!;

    expect(camera.eye).toEqual([12, 3.5, 19.5]);
    expect(camera.target[0]).toBeCloseTo(58.2708289199);
    expect(camera.target[1]).toBeCloseTo(-5.1824088833);
    expect(camera.target[2]).toBeCloseTo(2.6587955583);
    expect(camera.attach).toMatchObject({ offsetM: [2, -0.5, 1.5] });
    expect(camera.attach.yawDeg).toBeCloseTo(-20);
    expect(camera.attach.pitchDeg).toBeCloseTo(-10);
    expect(camera.attach.rollDeg).toBeCloseTo(-15);

    const landmarks = [
      { world: [22.2052520057, 2.0180987576, 18.6135991549] as const, pixel: [400, 150] as const },
      { world: [20.1492438412, 0.9144056624, 13.53376727] as const, pixel: [240, 230] as const },
    ];
    const unperturbedReported = CameraCalibrationSetSchema.parse({ actual, reported: actual }).reported;
    for (const landmark of landmarks) {
      const actualPixel = projectLandmark(actual, actorPosition, width, height, landmark.world);
      const unperturbedReportedPixel = projectLandmark(unperturbedReported, actorPosition, width, height, landmark.world);
      expect(actualPixel[0]).toBeCloseTo(landmark.pixel[0]);
      expect(actualPixel[1]).toBeCloseTo(landmark.pixel[1]);
      expect(unperturbedReportedPixel).toEqual(actualPixel);
    }

    const yawOffsetRad = 5 * degrees;
    const reported = cameraCalibrationWithYawOffset(actual, yawOffsetRad, 'analytic reported yaw').reported;
    const actualPixel = projectLandmark(actual, actorPosition, width, height, landmarks[0]!.world);
    const reportedPixel = projectLandmark(reported, actorPosition, width, height, landmarks[0]!.world);
    expect(reported.extrinsics.rotation.yawRad - actual.extrinsics.rotation.yawRad).toBeCloseTo(yawOffsetRad);
    expect(reportedPixel[0]).not.toBeCloseTo(actualPixel[0]);
    expect(reportedPixel[1]).not.toBeCloseTo(actualPixel[1]);
  });
});
