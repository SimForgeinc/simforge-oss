import { describe, expect, it } from "vitest";

import {
  CHASE_ENTRY_S,
  ChaseCameraRig,
  ChaseHeadingTracker,
  angleDelta,
  chasePoseFor,
  chaseRig,
  chaseTrailAngleDeg,
  headingOfDirection,
  wrapAngle,
  type ChasePose,
  type ChaseSubject,
} from "../../../../../src/scenario/editor/player/chase-camera";

const CAR = { l: 4.6, w: 1.9, h: 1.5 };
const PEDESTRIAN = { l: 0.5, w: 0.6, h: 1.8 };
const BUS = { l: 12, w: 2.55, h: 3.2 };
const DT = 1 / 60;

function subject(overrides: Partial<ChaseSubject> = {}): ChaseSubject {
  return { x: 0, y: 0, z: 0, headingRad: 0, speedMps: 10, dims: CAR, ...overrides };
}

/** Forward in the scene frame: `(cos h, -sin h)`. */
function forward(headingRad: number): { x: number; z: number } {
  return { x: Math.cos(headingRad), z: -Math.sin(headingRad) };
}

/** Drive `rig` along a sampled path, returning the pose after every frame. */
function drive(
  rig: ChaseCameraRig,
  frames: number,
  at: (frame: number) => ChaseSubject,
): Array<{ pose: ChasePose; subject: ChaseSubject }> {
  const out: Array<{ pose: ChasePose; subject: ChaseSubject }> = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const current = at(frame);
    out.push({ pose: { ...rig.update(current, DT) }, subject: current });
  }
  return out;
}

function trail(entry: { pose: ChasePose; subject: ChaseSubject }, headingRad: number): number {
  return chaseTrailAngleDeg(
    { x: entry.pose.eyeX, z: entry.pose.eyeZ },
    { x: entry.subject.x, z: entry.subject.z, headingRad },
  );
}

describe("angles", () => {
  it("wraps to (-π, π] and takes the short way round", () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2);
  });

  it("reads a heading back from a scene direction", () => {
    for (const heading of [0, 0.7, -2.4, Math.PI / 2]) {
      const { x, z } = forward(heading);
      expect(headingOfDirection(x, z)).toBeCloseTo(heading);
    }
  });
});

describe("chase geometry", () => {
  it("puts the eye behind and above the actor, looking ahead of it", () => {
    for (const heading of [0, 1.1, -2.7]) {
      const pose = chasePoseFor({ x: 5, z: -3, dims: CAR }, 2, heading, chaseRig(CAR), {} as ChasePose);
      expect(chaseTrailAngleDeg({ x: pose.eyeX, z: pose.eyeZ }, { x: 5, z: -3, headingRad: heading })).toBeLessThan(1e-6);
      expect(pose.eyeY).toBeGreaterThan(2 + CAR.h);
      // The target is ahead of the actor, and below the eye: the view looks down the road.
      const ahead = (pose.targetX - 5) * forward(heading).x + (pose.targetZ + 3) * forward(heading).z;
      expect(ahead).toBeGreaterThan(0);
      expect(pose.targetY).toBeLessThan(pose.eyeY);
    }
  });

  it("scales distance and height with the actor's box", () => {
    const walker = chaseRig(PEDESTRIAN);
    const car = chaseRig(CAR);
    const bus = chaseRig(BUS);
    expect(walker.distanceM).toBeLessThan(car.distanceM);
    expect(car.distanceM).toBeLessThan(bus.distanceM);
    expect(walker.heightM).toBeLessThan(car.heightM);
    expect(car.heightM).toBeLessThan(bus.heightM);
    // A pedestrian is framed by its height, not its 0.5 m footprint: the
    // camera must never end up inside or on top of the person.
    expect(walker.distanceM).toBeGreaterThanOrEqual(4);
    expect(walker.heightM).toBeGreaterThan(PEDESTRIAN.h);
    // Every size looks down at roughly the same angle.
    const pitch = (rig: ReturnType<typeof chaseRig>) =>
      Math.atan2(rig.heightM - rig.targetHeightM, rig.distanceM + rig.lookAheadM) * 180 / Math.PI;
    for (const rig of [walker, car, bus]) {
      expect(pitch(rig)).toBeGreaterThan(8);
      expect(pitch(rig)).toBeLessThan(20);
    }
  });

  it("zooms the trailing distance within bounds", () => {
    expect(chaseRig(CAR, 2).distanceM).toBeCloseTo(chaseRig(CAR).distanceM * 2);
    expect(chaseRig(CAR, 100).distanceM).toBeCloseTo(chaseRig(CAR).distanceM * 2.5);
    expect(chaseRig(CAR, 0).distanceM).toBeCloseTo(chaseRig(CAR).distanceM * 0.5);
  });
});

describe("heading tracker", () => {
  it("follows the sampler's body heading while the actor moves", () => {
    const tracker = new ChaseHeadingTracker();
    expect(tracker.resolve(subject({ headingRad: 0.4 }), DT)).toBeCloseTo(0.4);
    expect(tracker.resolve(subject({ x: 0.1, headingRad: 0.6 }), DT)).toBeCloseTo(0.6);
  });

  it("keeps the last heading while the actor is stopped", () => {
    const tracker = new ChaseHeadingTracker();
    tracker.resolve(subject({ headingRad: 1.2 }), DT);
    // A stopped body whose recorded heading wobbles (a knock settling, a
    // stop-spin) must not swing the camera around.
    for (const wobble of [1.9, -0.4, 3]) {
      expect(tracker.resolve(subject({ headingRad: wobble, speedMps: 0 }), DT)).toBeCloseTo(1.2);
    }
  });

  it("falls back to the direction of travel when the source has no heading", () => {
    const tracker = new ChaseHeadingTracker();
    const heading = 0.9;
    const step = forward(heading);
    for (let frame = 0; frame < 5; frame += 1) {
      tracker.resolve(subject({ x: step.x * frame * 0.2, z: step.z * frame * 0.2, headingRad: null, speedMps: Number.NaN }), DT);
    }
    expect(tracker.current).toBeCloseTo(heading);
  });

  it("does not flip when a heading-less actor starts reversing", () => {
    const tracker = new ChaseHeadingTracker();
    const heading = 0.3;
    const step = forward(heading);
    let x = 0;
    let z = 0;
    for (let frame = 0; frame < 5; frame += 1) {
      x += step.x * 0.2;
      z += step.z * 0.2;
      tracker.resolve(subject({ x, z, headingRad: null, speedMps: Number.NaN }), DT);
    }
    // Now back up along the same line.
    for (let frame = 0; frame < 10; frame += 1) {
      x -= step.x * 0.1;
      z -= step.z * 0.1;
      expect(tracker.resolve(subject({ x, z, headingRad: null, speedMps: Number.NaN }), DT)).toBeCloseTo(heading);
    }
  });

  it("uses the reported reversal to keep facing the body when travel is all it has", () => {
    const tracker = new ChaseHeadingTracker();
    const heading = -1.1;
    const step = forward(heading);
    tracker.resolve(subject({ headingRad: null, speedMps: Number.NaN }), DT);
    const resolved = tracker.resolve(
      subject({ x: -step.x * 0.1, z: -step.z * 0.1, headingRad: null, speedMps: Number.NaN, motionDirection: -1 }),
      DT,
    );
    expect(Math.abs(angleDelta(resolved, heading))).toBeLessThan(1e-6);
  });

  it("keeps the body heading, not the travel direction, while a sampled actor reverses", () => {
    const tracker = new ChaseHeadingTracker();
    const heading = 2;
    const step = forward(heading);
    tracker.resolve(subject({ headingRad: heading }), DT);
    let x = 0;
    let z = 0;
    for (let frame = 0; frame < 20; frame += 1) {
      x -= step.x * 0.05;
      z -= step.z * 0.05;
      expect(tracker.resolve(subject({ x, z, headingRad: heading, speedMps: -3, motionDirection: -1 }), DT)).toBeCloseTo(heading);
    }
  });

  it("ignores a scrub or respawn jump as a travel direction", () => {
    const tracker = new ChaseHeadingTracker();
    tracker.resolve(subject({ headingRad: null, speedMps: Number.NaN }), DT);
    const before = tracker.current;
    tracker.resolve(subject({ x: -40, z: 25, headingRad: null, speedMps: Number.NaN }), DT);
    expect(tracker.current).toBe(before);
  });
});

describe("chase rig smoothing", () => {
  it("settles directly behind a car on a straight road with no jitter", () => {
    const rig = new ChaseCameraRig();
    rig.begin();
    const heading = 0.5;
    const dir = forward(heading);
    const frames = drive(rig, 180, (frame) => subject({
      x: dir.x * frame * DT * 12,
      z: dir.z * frame * DT * 12,
      headingRad: heading,
      speedMps: 12,
    }));
    for (const entry of frames) expect(trail(entry, heading)).toBeLessThan(1e-6);
    // Constant speed along a line: the eye advances by exactly the same step
    // every frame. Any frame-to-frame variation is jitter.
    const steps = frames.slice(1).map((entry, index) =>
      Math.hypot(entry.pose.eyeX - frames[index]!.pose.eyeX, entry.pose.eyeZ - frames[index]!.pose.eyeZ));
    for (const step of steps) expect(step).toBeCloseTo(12 * DT, 6);
  });

  it("swings round a 90° turn smoothly, trailing by less than 20° and settling behind", () => {
    const rig = new ChaseCameraRig();
    rig.begin();
    const speed = 8;
    const radius = 12;
    const yawRate = speed / radius; // 0.67 rad/s, a brisk city corner.
    const turnFrames = Math.round((Math.PI / 2) / yawRate / DT);
    let x = 0;
    let z = 0;
    let heading = 0;
    const samples: Array<{ entry: { pose: ChasePose; subject: ChaseSubject }; heading: number }> = [];
    let lastYaw = rig.yawRad;
    let maxYawStep = 0;
    for (let frame = 0; frame < 60 + turnFrames + 90; frame += 1) {
      const turning = frame >= 60 && frame < 60 + turnFrames;
      if (turning) heading += yawRate * DT;
      const dir = forward(heading);
      x += dir.x * speed * DT;
      z += dir.z * speed * DT;
      const current = subject({ x, z, headingRad: heading, speedMps: speed });
      samples.push({ entry: { pose: { ...rig.update(current, DT) }, subject: current }, heading });
      if (frame > 0) maxYawStep = Math.max(maxYawStep, Math.abs(angleDelta(lastYaw, rig.yawRad)));
      lastYaw = rig.yawRad;
    }
    for (const sample of samples) expect(trail(sample.entry, sample.heading)).toBeLessThan(20);
    // Settled a second after the corner.
    for (const sample of samples.slice(-30)) expect(trail(sample.entry, sample.heading)).toBeLessThan(1);
    // No snap: the yaw never moves faster than the car turns.
    expect(maxYawStep).toBeLessThan(yawRate * DT * 1.2);
  });

  it("holds a stopped actor's heading instead of drifting", () => {
    const rig = new ChaseCameraRig();
    rig.begin();
    rig.update(subject({ headingRad: 1, speedMps: 5 }), DT);
    const frames = drive(rig, 120, () => subject({ headingRad: 1 + 0.4 * Math.random(), speedMps: 0 }));
    for (const entry of frames) expect(trail(entry, 1)).toBeLessThan(1e-6);
  });

  it("stays behind the body while it reverses", () => {
    const rig = new ChaseCameraRig();
    rig.begin();
    const heading = -0.8;
    const dir = forward(heading);
    const frames = drive(rig, 120, (frame) => subject({
      x: -dir.x * frame * DT * 3,
      z: -dir.z * frame * DT * 3,
      headingRad: heading,
      speedMps: -3,
      motionDirection: -1,
    }));
    for (const entry of frames) expect(trail(entry, heading)).toBeLessThan(1e-6);
  });

  it("frames a walker close and low, a bus far and high", () => {
    const at = (dims: ChaseSubject["dims"]) => {
      const rig = new ChaseCameraRig();
      rig.begin();
      const pose = rig.update(subject({ dims, speedMps: 1.4 }), DT);
      return { distance: Math.hypot(pose.eyeX, pose.eyeZ), height: pose.eyeY };
    };
    const walker = at(PEDESTRIAN);
    const bus = at(BUS);
    expect(walker.distance).toBeLessThan(7);
    expect(walker.height).toBeLessThan(4);
    expect(bus.distance).toBeGreaterThan(18);
    expect(bus.height).toBeGreaterThan(7);
  });

  it("eases in from the free camera instead of cutting", () => {
    const rig = new ChaseCameraRig();
    const from: ChasePose = { eyeX: 100, eyeY: 60, eyeZ: 100, targetX: 0, targetY: 0, targetZ: 0 };
    rig.begin(from);
    const first = { ...rig.update(subject(), DT) };
    expect(Math.hypot(first.eyeX - from.eyeX, first.eyeZ - from.eyeZ)).toBeLessThan(20);
    let last = first;
    let maxStep = 0;
    for (let frame = 1; frame < Math.ceil(CHASE_ENTRY_S / DT) + 5; frame += 1) {
      const next = { ...rig.update(subject(), DT) };
      maxStep = Math.max(maxStep, Math.hypot(next.eyeX - last.eyeX, next.eyeY - last.eyeY, next.eyeZ - last.eyeZ));
      last = next;
    }
    // Arrived: exactly the chase pose.
    const settled = chasePoseFor(subject(), 0, 0, chaseRig(CAR), {} as ChasePose);
    expect(last.eyeX).toBeCloseTo(settled.eyeX);
    expect(last.eyeY).toBeCloseTo(settled.eyeY);
    expect(maxStep).toBeLessThan(15);
  });

  it("lifts the eye clear of rising ground behind the actor", () => {
    const rig = new ChaseCameraRig();
    rig.begin();
    const pose = rig.update(subject(), DT, () => 20);
    expect(pose.eyeY).toBeGreaterThan(20);
  });

  it("survives a long dropped frame without launching the camera", () => {
    const rig = new ChaseCameraRig();
    rig.begin();
    rig.update(subject({ headingRad: 0 }), DT);
    const pose = rig.update(subject({ headingRad: 1.5 }), 5);
    expect(Number.isFinite(pose.eyeX)).toBe(true);
    // One step is capped: the yaw moved towards the new heading but did not overshoot it.
    expect(rig.yawRad).toBeGreaterThan(0);
    expect(rig.yawRad).toBeLessThanOrEqual(1.5);
  });
});
