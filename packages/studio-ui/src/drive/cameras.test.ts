import { describe, expect, it } from "vitest";

import {
  DRIVE_CAMERA_KINDS,
  DriveCameraRig,
  desiredCameraPose,
  springVelocity,
  type DriveCameraPose,
  type EgoPose,
} from "./cameras";

const DIMS = { l: 4.5, w: 1.9, h: 1.45 };

function pose(overrides: Partial<EgoPose> = {}): EgoPose {
  return { x: 0, y: 0, z: 0, headingRad: 0, speedMps: 0, ...overrides };
}

function blank(): DriveCameraPose {
  return { eyeX: 0, eyeY: 0, eyeZ: 0, targetX: 0, targetY: 0, targetZ: 0, fov: 0 };
}

/** Forward in scene axes: heading is CCW about +Y from +X, so +Z is behind an east-facing car. */
function forwardDot(camera: DriveCameraPose, ego: EgoPose): number {
  const dx = camera.targetX - camera.eyeX;
  const dz = camera.targetZ - camera.eyeZ;
  return dx * Math.cos(ego.headingRad) + dz * -Math.sin(ego.headingRad);
}

describe("desired camera poses", () => {
  it("puts the chase camera behind and above the car, looking where it is going", () => {
    const ego = pose({ headingRad: 0 });
    const camera = desiredCameraPose("chase", ego, DIMS, orbit(), blank());
    expect(camera.eyeX).toBeLessThan(0);
    expect(camera.eyeY).toBeGreaterThan(DIMS.h);
    expect(forwardDot(camera, ego)).toBeGreaterThan(0);
  });

  it("follows the car's heading rather than a world axis", () => {
    for (const headingRad of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const ego = pose({ headingRad });
      const camera = desiredCameraPose("chase", ego, DIMS, orbit(), blank());
      const behindX = camera.eyeX - ego.x;
      const behindZ = camera.eyeZ - ego.z;
      // The eye must sit opposite the forward vector, i.e. its dot product with
      // forward is negative and its magnitude is the chase distance.
      expect(behindX * Math.cos(headingRad) + behindZ * -Math.sin(headingRad)).toBeLessThan(0);
      expect(Math.hypot(behindX, behindZ)).toBeGreaterThan(DIMS.l);
    }
  });

  it("pulls the chase camera back with speed", () => {
    const still = desiredCameraPose("chase", pose(), DIMS, orbit(), blank());
    const fast = desiredCameraPose("chase", pose({ speedMps: 30 }), DIMS, orbit(), blank());
    expect(Math.hypot(fast.eyeX, fast.eyeZ)).toBeGreaterThan(Math.hypot(still.eyeX, still.eyeZ));
  });

  it("keeps the interior views inside the body and the exterior views outside it", () => {
    const ego = pose({ headingRad: 1.1 });
    for (const kind of ["hood", "cockpit"] as const) {
      const camera = desiredCameraPose(kind, ego, DIMS, orbit(), blank());
      expect(Math.hypot(camera.eyeX - ego.x, camera.eyeZ - ego.z)).toBeLessThan(DIMS.l / 2);
      expect(camera.eyeY).toBeGreaterThan(DIMS.h * 0.5);
      expect(camera.eyeY).toBeLessThan(DIMS.h * 1.1);
      expect(forwardDot(camera, ego)).toBeGreaterThan(0);
    }
    const chase = desiredCameraPose("chase", ego, DIMS, orbit(), blank());
    expect(Math.hypot(chase.eyeX - ego.x, chase.eyeZ - ego.z)).toBeGreaterThan(DIMS.l);
  });

  it("seats the cockpit camera left of centre, behind the hood camera", () => {
    const ego = pose({ headingRad: 0 });
    const hood = desiredCameraPose("hood", ego, DIMS, orbit(), blank());
    const cockpit = desiredCameraPose("cockpit", ego, DIMS, orbit(), blank());
    expect(cockpit.eyeX).toBeLessThan(hood.eyeX);
    // Left of travel for an east-facing car is -Z.
    expect(cockpit.eyeZ).toBeLessThan(0);
  });

  it("orbits around the car and clamps the caller's pitch and distance", () => {
    const ego = pose({ x: 10, z: -4 });
    const camera = desiredCameraPose("orbit", ego, DIMS, { yawRad: 0.7, pitchRad: 9, distanceM: 500 }, blank());
    expect(camera.targetX).toBe(ego.x);
    expect(camera.targetZ).toBe(ego.z);
    const radius = Math.hypot(camera.eyeX - ego.x, camera.eyeZ - ego.z);
    expect(radius).toBeLessThanOrEqual(60);
    expect(camera.eyeY - ego.y).toBeLessThan(60);
    expect(camera.eyeY).toBeGreaterThan(ego.y);
  });

  it("writes into the supplied pose so the render loop never allocates", () => {
    const into = blank();
    expect(desiredCameraPose("chase", pose(), DIMS, orbit(), into)).toBe(into);
  });
});

describe("spring", () => {
  it("stays stable and settles for a long frame", () => {
    let value = 0;
    let velocity = 0;
    for (let step = 0; step < 200; step += 1) {
      velocity = springVelocity(velocity, 10 - value, 46, 0.5);
      value += velocity * 0.5;
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThan(20);
    }
    expect(value).toBeCloseTo(10, 3);
  });
});

function orbit() {
  return { yawRad: -Math.PI / 2, pitchRad: 0.35, distanceM: 12 };
}

describe("camera rig", () => {
  it("starts settled on the exact pose so a spawn does not fly the camera in", () => {
    const rig = new DriveCameraRig();
    const ego = pose({ x: 120, z: -40, headingRad: 0.4 });
    const first = rig.update(ego, DIMS, 1 / 60);
    const desired = desiredCameraPose("chase", ego, DIMS, rig.orbit, blank());
    expect(first.eyeX).toBeCloseTo(desired.eyeX, 6);
    expect(first.eyeZ).toBeCloseTo(desired.eyeZ, 6);
  });

  it("lags a moving car and converges on the chase pose", () => {
    const rig = new DriveCameraRig();
    rig.update(pose(), DIMS, 1 / 60);
    const moving = pose({ x: 40, speedMps: 20 });
    const lagging = rig.update(moving, DIMS, 1 / 60);
    const desired = desiredCameraPose("chase", moving, DIMS, rig.orbit, blank());
    expect(Math.abs(lagging.eyeX - desired.eyeX)).toBeGreaterThan(1);
    for (let frame = 0; frame < 240; frame += 1) rig.update(moving, DIMS, 1 / 60);
    const settled = rig.update(moving, DIMS, 1 / 60);
    expect(settled.eyeX).toBeCloseTo(desired.eyeX, 2);
    expect(settled.eyeY).toBeCloseTo(desired.eyeY, 2);
  });

  it("does not ring around the target on the way there", () => {
    const rig = new DriveCameraRig();
    const start = rig.update(pose(), DIMS, 1 / 60).eyeX;
    const moved = pose({ x: 30 });
    const desired = desiredCameraPose("chase", moved, DIMS, rig.orbit, blank());
    let maximum = -Infinity;
    for (let frame = 0; frame < 600; frame += 1) {
      maximum = Math.max(maximum, rig.update(moved, DIMS, 1 / 60).eyeX);
    }
    // Critical damping leaves a rounding-scale overshoot from the discrete
    // step; an underdamped spring would swing several percent past and be
    // visible as a bouncing camera.
    const travel = Math.abs(desired.eyeX - start);
    expect(maximum - desired.eyeX).toBeLessThan(travel * 0.002);
  });

  it("bolts the interior views to the body with no smoothing lag", () => {
    const rig = new DriveCameraRig();
    rig.setKind("cockpit");
    rig.update(pose(), DIMS, 1 / 60);
    const jumped = pose({ x: 90, z: 12, headingRad: 2 });
    const applied = rig.update(jumped, DIMS, 1 / 60);
    const desired = desiredCameraPose("cockpit", jumped, DIMS, rig.orbit, blank());
    expect(applied.eyeX).toBeCloseTo(desired.eyeX, 6);
    expect(applied.eyeZ).toBeCloseTo(desired.eyeZ, 6);
  });

  it("cycles through every view and returns to the first", () => {
    const rig = new DriveCameraRig();
    const seen = [rig.cameraKind];
    for (let step = 1; step < DRIVE_CAMERA_KINDS.length; step += 1) seen.push(rig.cycle());
    expect(seen).toEqual([...DRIVE_CAMERA_KINDS]);
    expect(rig.cycle()).toBe(DRIVE_CAMERA_KINDS[0]);
  });

  it("snaps instead of sweeping across the map after a respawn", () => {
    const rig = new DriveCameraRig();
    rig.update(pose(), DIMS, 1 / 60);
    rig.reset();
    const elsewhere = pose({ x: 500, z: 500 });
    const applied = rig.update(elsewhere, DIMS, 1 / 60);
    const desired = desiredCameraPose("chase", elsewhere, DIMS, rig.orbit, blank());
    expect(applied.eyeX).toBeCloseTo(desired.eyeX, 6);
  });
});
