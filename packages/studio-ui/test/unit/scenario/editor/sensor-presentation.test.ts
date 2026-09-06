import { describe, expect, it } from "vitest";
import {
  BUILT_IN_SENSOR_RIGS,
  defaultDashCamera,
  defaultLidar,
  instantiateSensorRig,
  sensorRigPreset,
  type ActorSpec,
} from "@simforge-oss/scenario";

import { polar } from "../../../../src/scenario/editor/inspector/SensorCoverageDiagram";
import {
  appliedRigPreset,
  matchAimPreset,
  mountPresetFor,
  SENSOR_AIM_PRESETS,
  sensorCountSummary,
  sensorCounts,
} from "../../../../src/scenario/editor/inspector/sensor-presentation";

function car(overrides: Partial<ActorSpec> = {}): ActorSpec {
  return {
    class: "car",
    static: false,
    sensors: [],
    dims: { length: 4.5, width: 1.8, height: 1.5 },
    ...overrides,
  } as ActorSpec;
}

describe("sensor aim vocabulary", () => {
  /**
   * The sign of yaw is the one thing in this feature that cannot be checked by
   * eye without a scenario open, and getting it backwards points every side
   * camera at the wrong kerb. The built-in Tesla rig is the fixed reference:
   * its "Left Forward" camera is authored at -60°.
   */
  it("treats negative yaw as the vehicle's left, matching the Tesla rig", () => {
    const rig = sensorRigPreset("tesla-hw3");
    expect(rig).toBeDefined();
    const sensors = instantiateSensorRig(rig!, car());
    const leftForward = sensors.find((sensor) => sensor.label === "Left Forward");
    expect(leftForward).toBeDefined();
    expect(leftForward!.mount.rotation.yawRad).toBeLessThan(0);

    expect(SENSOR_AIM_PRESETS.find((preset) => preset.id === "left")?.yawDeg).toBe(-90);
    expect(SENSOR_AIM_PRESETS.find((preset) => preset.id === "right")?.yawDeg).toBe(90);
  });

  it("plots a left-aimed sensor to the left of the plan", () => {
    const left = polar(0, 0, 10, -Math.PI / 2);
    const right = polar(0, 0, 10, Math.PI / 2);
    const forward = polar(0, 0, 10, 0);

    // Plan coordinates are SVG-style: x grows right, y grows down.
    expect(left.x).toBeCloseTo(-10);
    expect(right.x).toBeCloseTo(10);
    expect(forward.y).toBeCloseTo(-10);
  });

  it("names an exact aim and leaves an arbitrary one unnamed", () => {
    expect(matchAimPreset(-Math.PI / 2)?.id).toBe("left");
    expect(matchAimPreset(0)?.id).toBe("forward");
    expect(matchAimPreset(-60 * (Math.PI / 180))).toBeUndefined();
  });
});

describe("sensor summaries", () => {
  it("omits the modalities that are absent", () => {
    const counts = sensorCounts([{ type: "dash_camera" }, { type: "dash_camera" }, { type: "radar" }]);
    expect(counts).toMatchObject({ camera: 2, lidar: 0, radar: 1, total: 3 });
    expect(sensorCountSummary(counts)).toBe("2 cameras · 1 radar");
    expect(sensorCountSummary(sensorCounts([{ type: "lidar" }]))).toBe("1 LiDAR");
  });
});

describe("fitted rig recognition", () => {
  it("recognises a rig it just instantiated, despite freshly minted ids", () => {
    const actor = car();
    const sensors = instantiateSensorRig("waymo-5th-gen", actor);
    const fitted = car({ sensors });
    expect(appliedRigPreset(sensors, fitted, BUILT_IN_SENSOR_RIGS)?.id).toBe("waymo-5th-gen");
  });

  it("reports no rig once the author has edited one of its sensors", () => {
    const actor = car();
    const sensors = instantiateSensorRig("waymo-5th-gen", actor).map((sensor, index) => (
      index === 0
        ? { ...sensor, mount: { ...sensor.mount, position: { x: 0, y: 3, z: 0 } } }
        : sensor
    ));
    expect(appliedRigPreset(sensors, car({ sensors }), BUILT_IN_SENSOR_RIGS)).toBeUndefined();
  });

  it("reports no rig for a hand-assembled suite", () => {
    const actor = car();
    const sensors = [defaultDashCamera(actor)];
    expect(appliedRigPreset(sensors, car({ sensors }), BUILT_IN_SENSOR_RIGS)?.id)
      .not.toBe("waymo-5th-gen");
  });
});

describe("mount presets", () => {
  it("names the position a default LiDAR lands on", () => {
    const actor = car();
    const lidar = defaultLidar(actor);
    expect(mountPresetFor(lidar, actor)?.id).toBe("roof-centre");
  });

  it("leaves a hand-placed mount unnamed", () => {
    const actor = car();
    const lidar = defaultLidar(actor);
    const moved = { ...lidar, mount: { ...lidar.mount, position: { x: 0.31, y: 1.11, z: 0.27 } } };
    expect(mountPresetFor(moved, actor)).toBeUndefined();
  });
});
