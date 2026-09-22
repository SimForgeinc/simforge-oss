/**
 * Drive cameras.
 *
 * Six views over one car, all expressed as an eye/target pair so the viewer's
 * camera rig can be driven with `setView` and nothing else. Chase, bird's-eye
 * and orbit are spring-damped: the target pose is recomputed every frame from
 * the car's pose and the camera is pulled towards it, which is what makes a
 * chase camera lag into corners and settle without ringing. Hood, cockpit and
 * dashcam are rigidly bolted to the body — a spring there reads as a loose
 * camera mount.
 *
 * The springs are critically damped by construction (damping = 2*sqrt(k)), so
 * there is exactly one tuning number per view and no overshoot to chase.
 */

import { dashcamMountForDims, verticalFovDeg, type DashcamMount } from './dashcam';

/**
 * The six views, in the order the camera key cycles them: trailing (chase),
 * driver (cockpit), hood, dashcam, bird's-eye, then the free orbit.
 */
export const DRIVE_CAMERA_KINDS = ['chase', 'cockpit', 'hood', 'dashcam', 'birdseye', 'orbit'] as const;
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
/**
 * Bird's-eye: straight down from well above the roof, heading-up. The eye is
 * trailed a hair behind the car so the view direction is never exactly
 * vertical, which keeps the viewer's world-up from degenerating and makes the
 * car's nose point to the top of the screen.
 */
const BIRDSEYE_HEIGHT_M = 42;
const BIRDSEYE_TRAIL_M = 1.5;
const BIRDSEYE_FOV = 55;
const ORBIT_FOV = 55;
export const ORBIT_MIN_DISTANCE_M = 4;
export const ORBIT_MAX_DISTANCE_M = 60;
export const ORBIT_MIN_PITCH_RAD = -0.15;
export const ORBIT_MAX_PITCH_RAD = 1.35;

/** How far ahead of the dashcam its target sits; any distance names the same ray. */
const DASHCAM_TARGET_M = 20;

/** Views bolted to the body: no spring, and a switch into one snaps. */
function rigidView(kind: DriveCameraKind): boolean {
  return kind === 'hood' || kind === 'cockpit' || kind === 'dashcam';
}

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
  dashcam?: { mount: DashcamMount; aspect: number },
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

  if (kind === 'dashcam') {
    // Sensor frame to scene: +X forward, +Y up, +Z left of the car.
    const { mount, aspect } = dashcam ?? { mount: dashcamMountForDims(dims), aspect: 16 / 9 };
    const leftX = -rightX;
    const leftZ = -rightZ;
    into.eyeX = pose.x + forwardX * mount.x + leftX * mount.z;
    into.eyeY = pose.y + mount.y;
    into.eyeZ = pose.z + forwardZ * mount.x + leftZ * mount.z;
    const flat = Math.cos(mount.pitchRad);
    const aimX = flat * (Math.cos(mount.yawRad) * forwardX + Math.sin(mount.yawRad) * leftX);
    const aimZ = flat * (Math.cos(mount.yawRad) * forwardZ + Math.sin(mount.yawRad) * leftZ);
    into.targetX = into.eyeX + aimX * DASHCAM_TARGET_M;
    into.targetY = into.eyeY + Math.sin(mount.pitchRad) * DASHCAM_TARGET_M;
    into.targetZ = into.eyeZ + aimZ * DASHCAM_TARGET_M;
    into.fov = verticalFovDeg(mount.horizontalFovDeg, aspect);
    return into;
  }

  if (kind === 'birdseye') {
    into.eyeX = pose.x - forwardX * BIRDSEYE_TRAIL_M;
    into.eyeY = pose.y + BIRDSEYE_HEIGHT_M;
    into.eyeZ = pose.z - forwardZ * BIRDSEYE_TRAIL_M;
    into.targetX = pose.x;
    into.targetY = pose.y;
    into.targetZ = pose.z;
    into.fov = BIRDSEYE_FOV;
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
 * A smoothed camera over the five views.
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
  private dashcam: DashcamMount | null = null;
  /** The box-derived mount used while none is set, and the box it was derived from. */
  private fallbackDashcam: { dims: EgoDims; mount: DashcamMount } | null = null;

  /** The viewport's width over height; the dashcam's lens is specified horizontally. */
  aspect = 16 / 9;

  readonly orbit: OrbitState = { yawRad: -Math.PI / 2, pitchRad: 0.35, distanceM: 12 };

  get cameraKind(): DriveCameraKind {
    return this.kind;
  }

  /** Switch view; the next update snaps when the new view is rigidly mounted. */
  setKind(kind: DriveCameraKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    if (rigidView(kind)) this.settled = false;
  }

  /**
   * Where the dashcam view is mounted on the car (see `dashcamMountFor`);
   * null derives a windscreen mount from the car's box.
   */
  setDashcamMount(mount: DashcamMount | null): void {
    this.dashcam = mount;
  }

  /** Next view in the cycle order, already applied. */
  cycle(): DriveCameraKind {
    const index = DRIVE_CAMERA_KINDS.indexOf(this.kind);
    this.setKind(DRIVE_CAMERA_KINDS[(index + 1) % DRIVE_CAMERA_KINDS.length]!);
    return this.kind;
  }

  private dashcamMount(dims: EgoDims): DashcamMount {
    if (this.dashcam) return this.dashcam;
    const cached = this.fallbackDashcam;
    if (cached && cached.dims.l === dims.l && cached.dims.w === dims.w && cached.dims.h === dims.h) return cached.mount;
    const mount = dashcamMountForDims(dims);
    this.fallbackDashcam = { dims: { ...dims }, mount };
    return mount;
  }

  /** Drop all smoothing, so a respawn does not fly the camera across the map. */
  reset(): void {
    this.settled = false;
    this.velocity.fill(0);
  }

  /** Advance the rig and return the pose to hand the viewer. Never allocates. */
  update(pose: EgoPose, dims: EgoDims, dtS: number): DriveCameraPose {
    const desired = desiredCameraPose(
      this.kind,
      pose,
      dims,
      this.orbit,
      this.desired,
      this.kind === 'dashcam' ? { mount: this.dashcamMount(dims), aspect: this.aspect } : undefined,
    );
    this.smoothed.fov = desired.fov;
    // Mounted views are bolted to the body, and the first frame after a spawn
    // or a respawn has no meaningful previous pose to spring away from.
    if (rigidView(this.kind) || !this.settled) {
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
