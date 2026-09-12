/**
 * Drive cameras.
 *
 * Four views over one car, all expressed as an eye/target pair so the viewer's
 * camera rig can be driven with `setView` and nothing else. Chase and orbit are
 * spring-damped: the target pose is recomputed every frame from the car's pose
 * and the camera is pulled towards it, which is what makes a chase camera lag
 * into corners and settle without ringing. Hood and cockpit are rigidly bolted
 * to the body — a spring there reads as a loose camera mount.
 *
 * The springs are critically damped by construction (damping = 2*sqrt(k)), so
 * there is exactly one tuning number per view and no overshoot to chase.
 */

/** The four views, in the order the camera key cycles them. */
export const DRIVE_CAMERA_KINDS = ['chase', 'hood', 'cockpit', 'orbit'] as const;
export type DriveCameraKind = (typeof DRIVE_CAMERA_KINDS)[number];

/** Where the car is, this rendered frame. Ground-contact origin, as the renderer uses. */
export interface EgoPose {
  x: number;
  y: number;
  z: number;
  headingRad: number;
  /** Signed forward speed, m/s; the chase camera pulls back with it. */
  speedMps: number;
}

/** Body extents in metres, so the same rig frames a hatchback and a bus. */
export interface EgoDims {
  l: number;
  w: number;
  h: number;
}

/** A camera pose the viewer can apply directly. */
export interface DriveCameraPose {
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  fov: number;
}

/** User-controlled orbit state, in the orbit view only. */
export interface OrbitState {
  /** Yaw offset from the car's heading, radians. */
  yawRad: number;
  /** Elevation above the horizon, radians, clamped by the caller's drag handler. */
  pitchRad: number;
  /** Eye distance from the car, metres. */
  distanceM: number;
}

/** Chase distance at a standstill, in car lengths, plus the metres added at speed. */
const CHASE_BASE_LENGTHS = 1.6;
const CHASE_SPEED_STRETCH_M = 3.2;
/** Speed at which the chase camera has pulled back by the full stretch. */
const CHASE_STRETCH_REFERENCE_MPS = 32;
const CHASE_HEIGHT_LENGTHS = 0.55;
const CHASE_LOOK_AHEAD_M = 7;
const CHASE_FOV = 62;
/** Hood camera: just above the bonnet, ahead of the screen pillar. */
const HOOD_FOV = 68;
/** Cockpit: driver's eye, offset to the left of centre as a left-hand-drive car is. */
const COCKPIT_FOV = 72;
const ORBIT_FOV = 55;
export const ORBIT_MIN_DISTANCE_M = 4;
export const ORBIT_MAX_DISTANCE_M = 60;
export const ORBIT_MIN_PITCH_RAD = -0.15;
export const ORBIT_MAX_PITCH_RAD = 1.35;

/** Spring stiffness, 1/s². Chase is deliberately looser than orbit. */
const CHASE_EYE_STIFFNESS = 46;
const CHASE_TARGET_STIFFNESS = 90;
const ORBIT_STIFFNESS = 120;

/**
 * The pose a view asks for, before any smoothing.
 *
 * Scene axes: +X east, +Z south, heading measured CCW about +Y from +X, so the
 * forward vector is `(cos h, 0, -sin h)` — the same convention the lane index
 * and the actor renderer use.
 */
export function desiredCameraPose(
  kind: DriveCameraKind,
  pose: EgoPose,
  dims: EgoDims,
  orbit: OrbitState,
  into: DriveCameraPose,
): DriveCameraPose {
  const forwardX = Math.cos(pose.headingRad);
  const forwardZ = -Math.sin(pose.headingRad);
  const rightX = -forwardZ;
  const rightZ = forwardX;

  if (kind === 'chase') {
    const stretch = Math.min(1, Math.abs(pose.speedMps) / CHASE_STRETCH_REFERENCE_MPS);
    const distance = dims.l * CHASE_BASE_LENGTHS + stretch * CHASE_SPEED_STRETCH_M;
    into.eyeX = pose.x - forwardX * distance;
    into.eyeY = pose.y + dims.h + dims.l * CHASE_HEIGHT_LENGTHS;
    into.eyeZ = pose.z - forwardZ * distance;
    into.targetX = pose.x + forwardX * CHASE_LOOK_AHEAD_M;
    into.targetY = pose.y + dims.h * 0.75;
    into.targetZ = pose.z + forwardZ * CHASE_LOOK_AHEAD_M;
    into.fov = CHASE_FOV;
    return into;
  }

  if (kind === 'hood') {
    const ahead = dims.l * 0.32;
    into.eyeX = pose.x + forwardX * ahead;
    into.eyeY = pose.y + dims.h * 0.92;
    into.eyeZ = pose.z + forwardZ * ahead;
    into.targetX = into.eyeX + forwardX * CHASE_LOOK_AHEAD_M;
    into.targetY = into.eyeY - 0.6;
    into.targetZ = into.eyeZ + forwardZ * CHASE_LOOK_AHEAD_M;
    into.fov = HOOD_FOV;
    return into;
  }

  if (kind === 'cockpit') {
    const seatBack = dims.l * 0.06;
    const seatLeft = dims.w * 0.22;
    into.eyeX = pose.x - forwardX * seatBack - rightX * seatLeft;
    into.eyeY = pose.y + dims.h * 0.78;
    into.eyeZ = pose.z - forwardZ * seatBack - rightZ * seatLeft;
    into.targetX = into.eyeX + forwardX * CHASE_LOOK_AHEAD_M;
    into.targetY = into.eyeY - 0.45;
    into.targetZ = into.eyeZ + forwardZ * CHASE_LOOK_AHEAD_M;
    into.fov = COCKPIT_FOV;
    return into;
  }

  const yaw = pose.headingRad + orbit.yawRad;
  const pitch = Math.max(ORBIT_MIN_PITCH_RAD, Math.min(ORBIT_MAX_PITCH_RAD, orbit.pitchRad));
  const distance = Math.max(ORBIT_MIN_DISTANCE_M, Math.min(ORBIT_MAX_DISTANCE_M, orbit.distanceM));
  const ground = Math.cos(pitch) * distance;
  into.eyeX = pose.x - Math.cos(yaw) * ground;
  into.eyeY = pose.y + dims.h * 0.6 + Math.sin(pitch) * distance;
  into.eyeZ = pose.z + Math.sin(yaw) * ground;
  into.targetX = pose.x;
  into.targetY = pose.y + dims.h * 0.6;
  into.targetZ = pose.z;
  into.fov = ORBIT_FOV;
  return into;
}

/**
 * The velocity of one critically damped spring axis after `dtS`.
 *
 * Semi-implicit integration, which stays stable when a dropped frame hands us a
 * long step — the explicit form launched the camera into orbit on the first
 * frame after a tab regained focus. The caller integrates the position, which
 * is one multiply and keeps this allocation-free.
 */
export function springVelocity(
  velocity: number,
  displacement: number,
  stiffness: number,
  dtS: number,
): number {
  const damping = 2 * Math.sqrt(stiffness);
  return (velocity + stiffness * displacement * dtS) / (1 + damping * dtS);
}

/** Longest frame a spring integrates in one go; beyond it the camera snaps instead of lurching. */
const MAX_SPRING_STEP_S = 0.1;

/**
 * A smoothed camera over the four views.
 *
 * Holds the eye/target spring state so a view switch keeps continuity where it
 * should (chase to orbit glides) and snaps where a spring would be wrong
 * (into and out of the rigid interior views).
 */
export class DriveCameraRig {
  private readonly desired: DriveCameraPose = blankPose();
  private readonly smoothed: DriveCameraPose = blankPose();
  /** Spring velocity per smoothed axis, indexed by {@link AXES}. */
  private readonly velocity = new Float64Array(6);
  private kind: DriveCameraKind = 'chase';
  private settled = false;

  readonly orbit: OrbitState = { yawRad: -Math.PI / 2, pitchRad: 0.35, distanceM: 12 };

  get cameraKind(): DriveCameraKind {
    return this.kind;
  }

  /** Switch view; the next update snaps when the new view is rigidly mounted. */
  setKind(kind: DriveCameraKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    if (kind === 'hood' || kind === 'cockpit') this.settled = false;
  }

  /** Next view in the cycle order, already applied. */
  cycle(): DriveCameraKind {
    const index = DRIVE_CAMERA_KINDS.indexOf(this.kind);
    this.setKind(DRIVE_CAMERA_KINDS[(index + 1) % DRIVE_CAMERA_KINDS.length]!);
    return this.kind;
  }

  /** Drop all smoothing, so a respawn does not fly the camera across the map. */
  reset(): void {
    this.settled = false;
    this.velocity.fill(0);
  }

  /** Advance the rig and return the pose to hand the viewer. Never allocates. */
  update(pose: EgoPose, dims: EgoDims, dtS: number): DriveCameraPose {
    const desired = desiredCameraPose(this.kind, pose, dims, this.orbit, this.desired);
    this.smoothed.fov = desired.fov;
    // Interior views are bolted to the body, and the first frame after a spawn
    // or a respawn has no meaningful previous pose to spring away from.
    if (this.kind === 'hood' || this.kind === 'cockpit' || !this.settled) {
      for (const axis of AXES) this.smoothed[axis] = desired[axis];
      this.velocity.fill(0);
      this.settled = true;
      return this.smoothed;
    }

    const step = Math.min(MAX_SPRING_STEP_S, Math.max(0, dtS));
    for (let index = 0; index < AXES.length; index += 1) {
      const axis = AXES[index]!;
      const stiffness = this.kind === 'orbit'
        ? ORBIT_STIFFNESS
        : index < 3 ? CHASE_EYE_STIFFNESS : CHASE_TARGET_STIFFNESS;
      const current = this.smoothed[axis];
      const next = springVelocity(this.velocity[index]!, desired[axis] - current, stiffness, step);
      this.velocity[index] = next;
      this.smoothed[axis] = current + next * step;
    }
    return this.smoothed;
  }
}

/** Smoothed axes in spring order: the three eye components, then the three target components. */
const AXES = ['eyeX', 'eyeY', 'eyeZ', 'targetX', 'targetY', 'targetZ'] as const;

function blankPose(): DriveCameraPose {
  return { eyeX: 0, eyeY: 0, eyeZ: 0, targetX: 0, targetY: 0, targetZ: 0, fov: CHASE_FOV };
}
