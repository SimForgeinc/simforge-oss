import { describe, expect, it } from "vitest";
import { instantiateSensorRig, resolveSensorMountPreset } from "@simforge-oss/scenario";

import { DriveCameraRig, desiredCameraPose, type DriveCameraPose, type EgoPose } from "./cameras";
import {
  DASHCAM_FALLBACK_FOV_DEG,
  DASHCAM_FALLBACK_PITCH_RAD,
  dashcamMountFor,
  verticalFovDeg,
  type DashcamMount,
} from "./dashcam";

const DIMS = { l: 4.8, w: 1.9, h: 1.5 };
const ACTOR_DIMS = { length: 4.8, width: 1.9, height: 1.5 };

function pose(overrides: Partial<EgoPose> = {}): EgoPose {
  return { x: 0, y: 0, z: 0, headingRad: 0, speedMps: 0, ...overrides };
}

function blank(): DriveCameraPose {
  return { eyeX: 0, eyeY: 0, eyeZ: 0, targetX: 0, targetY: 0, targetZ: 0, fov: 0 };
}

const ORBIT = { yawRad: 0, pitchRad: 0.3, distanceM: 10 };

describe("dashcam mount", () => {
  it("uses the driven actor's own forward camera when it has one", () => {
    const sensors = instantiateSensorRig("basic-dash-camera", { class: "car", dims: ACTOR_DIMS });
    const sensor = sensors[0]!;
    if (sensor.type !== "dash_camera") throw new Error("basic-dash-camera is a camera rig");
    const mount = dashcamMountFor({ class: "car", dims: ACTOR_DIMS, sensors });
    expect(mount).toMatchObject({
      source: "sensor",
      x: sensor.mount.position.x,
      y: sensor.mount.position.y,
      z: sensor.mount.position.z,
      horizontalFovDeg: sensor.camera.horizontalFovDeg,
    });
  });

  it("falls back to the scenario's windscreen mount, scaled to the car, with a dashcam lens", () => {
    const windscreen = resolveSensorMountPreset("windscreen", { class: "van", dims: { length: 5.5, width: 2, height: 2.2 } });
    const mount = dashcamMountFor({ class: "van", dims: { length: 5.5, width: 2, height: 2.2 }, sensors: [] });
    expect(mount).toMatchObject({
      source: "windscreen",
      x: windscreen.position.x,
      y: windscreen.position.y,
      z: windscreen.position.z,
      pitchRad: DASHCAM_FALLBACK_PITCH_RAD,
      horizontalFovDeg: DASHCAM_FALLBACK_FOV_DEG,
    });
    expect(mount.pitchRad).toBeLessThan(0);
  });

  it("ignores a rear-facing camera", () => {
    const [front] = instantiateSensorRig("basic-dash-camera", { class: "car", dims: ACTOR_DIMS });
    const rear = { ...front!, mount: { ...front!.mount, rotation: { yawRad: Math.PI, pitchRad: 0, rollRad: 0 } } };
    expect(dashcamMountFor({ class: "car", dims: ACTOR_DIMS, sensors: [rear] }).source).toBe("windscreen");
  });
});

describe("dashcam view", () => {
  const mount: DashcamMount = { x: 1.5, y: 1.3, z: 0.2, yawRad: 0, pitchRad: -0.1, horizontalFovDeg: 100, source: "sensor" };

  it("sits at the mount in the car's frame and looks along its aim", () => {
    for (const headingRad of [0, Math.PI / 2, -2.4]) {
      const ego = pose({ x: 10, y: 3, z: -4, headingRad });
      const camera = desiredCameraPose("dashcam", ego, DIMS, ORBIT, blank(), { mount, aspect: 16 / 9 });
      const forward = [Math.cos(headingRad), -Math.sin(headingRad)] as const;
      const left = [-Math.sin(headingRad), -Math.cos(headingRad)] as const;
      const dx = camera.eyeX - ego.x;
      const dz = camera.eyeZ - ego.z;
      expect(dx * forward[0] + dz * forward[1]).toBeCloseTo(mount.x, 9);
      expect(dx * left[0] + dz * left[1]).toBeCloseTo(mount.z, 9);
      expect(camera.eyeY).toBeCloseTo(ego.y + mount.y, 9);
      const aimX = camera.targetX - camera.eyeX;
      const aimY = camera.targetY - camera.eyeY;
      const aimZ = camera.targetZ - camera.eyeZ;
      const length = Math.hypot(aimX, aimY, aimZ);
      expect((aimX * forward[0] + aimZ * forward[1]) / length).toBeCloseTo(Math.cos(mount.pitchRad), 9);
      expect(aimY / length).toBeCloseTo(Math.sin(mount.pitchRad), 9);
    }
  });

  it("turns the lens's horizontal field of view into the viewport's vertical one", () => {
    const camera = desiredCameraPose("dashcam", pose(), DIMS, ORBIT, blank(), { mount, aspect: 16 / 9 });
    expect(camera.fov).toBeCloseTo(verticalFovDeg(100, 16 / 9), 9);
    expect(verticalFovDeg(90, 1)).toBeCloseTo(90, 9);
    expect(verticalFovDeg(100, 16 / 9)).toBeLessThan(100);
  });

  it("is bolted to the body: the camera moves with the car on the same frame", () => {
    const rig = new DriveCameraRig();
    rig.setDashcamMount(mount);
    rig.setKind("dashcam");
    rig.update(pose(), DIMS, 1 / 60);
    const moved = pose({ x: 0.42, z: -0.03, headingRad: 0.01 });
    const applied = rig.update(moved, DIMS, 1 / 60);
    const desired = desiredCameraPose("dashcam", moved, DIMS, rig.orbit, blank(), { mount, aspect: rig.aspect });
    for (const axis of ["eyeX", "eyeY", "eyeZ", "targetX", "targetY", "targetZ"] as const) {
      expect(applied[axis]).toBeCloseTo(desired[axis], 12);
    }
  });

  it("derives a windscreen mount from the car's box when none was set", () => {
    const rig = new DriveCameraRig();
    rig.setKind("dashcam");
    const applied = rig.update(pose(), DIMS, 1 / 60);
    const windscreen = resolveSensorMountPreset("windscreen", { class: "car", dims: ACTOR_DIMS });
    expect(applied.eyeX).toBeCloseTo(windscreen.position.x, 9);
    expect(applied.eyeY).toBeCloseTo(windscreen.position.y, 9);
  });
});
