/**
 * The simulation player's chase camera.
 *
 * Clicking an actor while the simulation plays puts the camera behind it,
 * a little above, looking the way it is going, and keeps it there as the actor
 * moves and turns. This module is the math only: where the camera should be
 * for one sampled pose, and how that pose is smoothed from frame to frame. The
 * hook in `use-chase-camera.ts` feeds it the playback sampler's pose once per
 * rendered frame and hands the result to the viewer.
 *
 * What is smoothed and what is not matters for jitter:
 *
 * - The camera's *position* follows the actor rigidly. The pose comes from the
 *   same sample the renderer drew this frame (the viewer's `onFrame` hook runs
 *   before the draw), so a rigid follow has no frame of lag to show as shake.
 *   A positional spring would only let the actor drift forward in the frame.
 * - The *yaw* the camera trails along is a critically damped spring on the
 *   heading, wrap-aware. That is what makes it swing round a corner instead of
 *   snapping, and what absorbs a walker's heading changes.
 * - The *height* reference is exponentially smoothed, so terrain bumps under
 *   the actor do not bounce the camera.
 *
 * The spring integrator is the drive camera's (`springVelocity`), the same one
 * the drive-mode chase view uses: semi-implicit, stable on a long frame, and
 * critically damped by construction, so there is no overshoot to chase.
 *
 * Scene axes are the renderer's: +X east, +Y up, +Z south, heading measured
 * CCW about +Y from +X, so forward is `(cos h, 0, -sin h)`.
 */

import { springVelocity } from "../../../drive/cameras";

/** One sampled actor, as the chase camera needs it. */
export interface ChaseSubject {
  readonly x: number;
  /** Ground height under the actor, metres (the renderer's ground-contact origin). */
  readonly y: number;
  readonly z: number;
  /**
   * Body heading from the sampler, radians. `null` (or non-finite) when the
   * source has none, in which case the direction of travel is used instead.
   */
  readonly headingRad: number | null;
  /** Signed forward speed, m/s. */
  readonly speedMps: number;
  /** -1 while the body reverses; the camera stays behind the body regardless. */
  readonly motionDirection?: -1 | 1;
  readonly dims: { readonly l: number; readonly w: number; readonly h: number };
}

/** An eye/target pair the viewer applies with `controls.setView`. */
export interface ChasePose {
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

/** How far behind, how high and how far ahead the camera sits for one actor. */
export interface ChaseRig {
  readonly distanceM: number;
  readonly heightM: number;
  readonly lookAheadM: number;
  readonly targetHeightM: number;
}

/** Below this speed an actor counts as stopped, and the camera keeps its last heading. */
export const CHASE_STOPPED_SPEED_MPS = 0.3;
/**
 * A travel direction that turns more than this in one step is a reversal
 * (drive to reverse, or the reverse), not a turn: nothing on a road turns 120°
 * between two frames. The camera then stays behind the body instead of
 * flipping to face it.
 */
export const CHASE_REVERSAL_RAD = (2 * Math.PI) / 3;
/** A jump longer than this between frames is a scrub or a respawn, not motion. */
const TELEPORT_M = 6;
/**
 * Yaw spring stiffness, 1/s². ω = 6 rad/s: a steady turn at yaw rate r trails
 * by 2r/ω, about 11° through a brisk 35°/s city corner, and the camera is
 * settled within a second of the turn ending.
 */
export const CHASE_YAW_STIFFNESS = 36;
/** Height smoothing rate, 1/s. */
const HEIGHT_RATE = 6;
/** How fast the eye climbs over rising ground behind the actor, 1/s. */
const LIFT_RATE = 20;
/** The longest step one update integrates; beyond it the rig snaps rather than lurches. */
const MAX_STEP_S = 0.1;
/** The eye never sinks below the ground under it by less than this. */
const EYE_CLEARANCE_M = 1.2;
/** The ease from the free camera into the chase pose. */
export const CHASE_ENTRY_S = 0.7;
export const CHASE_MIN_ZOOM = 0.5;
export const CHASE_MAX_ZOOM = 2.5;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Wrap to (-π, π]. */
export function wrapAngle(angle: number): number {
  const wrapped = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

/** The signed shortest turn from `from` to `to`, radians. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Heading of a scene-frame direction `(dx, dz)`: the inverse of `(cos h, -sin h)`. */
export function headingOfDirection(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/**
 * Camera geometry scaled by the actor's box, so one rule frames a walker, a
 * sedan and an articulated bus. The characteristic size is the larger of
 * length and height: a pedestrian is tall rather than long, and framing it by
 * its 0.5 m footprint would put the camera inside it.
 *
 * Every size keeps roughly the same ~12° downward look: the eye rises with the
 * distance it trails by.
 */
export function chaseRig(dims: ChaseSubject["dims"], zoom = 1): ChaseRig {
  const size = Math.max(0.5, dims.l, dims.h);
  const scale = clamp(zoom, CHASE_MIN_ZOOM, CHASE_MAX_ZOOM);
  const distanceM = clamp(1.7 * size + 2.5, 4, 36) * scale;
  return {
    distanceM,
    heightM: clamp(dims.h + 0.28 * distanceM, 1.8, 14 * scale),
    lookAheadM: clamp(0.9 * size + 2, 2.5, 14),
    targetHeightM: clamp(dims.h * 0.6, 0.8, 3),
  };
}

/**
 * Which way the camera should trail, one frame at a time.
 *
 * The sampler's body heading is the primary source: it is what the renderer
 * turns the model to, it does not flip when the actor reverses, and it holds
 * still while the actor waits. The direction of travel (from successive
 * positions) stands in only where a source has no heading. Either way:
 *
 * - a stopped actor keeps the last heading, so a car waiting at a light (or a
 *   body settling after a knock) does not swing the camera around;
 * - a reversal never flips the camera to the front: a travel direction that
 *   jumps by more than {@link CHASE_REVERSAL_RAD} is read as reversing, and
 *   the body heading (which reversal does not change) is kept.
 */
export class ChaseHeadingTracker {
  private heading: number | null = null;
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;

  /** The heading the camera currently trails, or null before the first sample. */
  get current(): number | null {
    return this.heading;
  }

  reset(): void {
    this.heading = null;
    this.hasLast = false;
  }

  resolve(subject: ChaseSubject, dtS: number): number {
    let travel: number | null = null;
    if (this.hasLast && dtS > 0) {
      const dx = subject.x - this.lastX;
      const dz = subject.z - this.lastZ;
      const moved = Math.hypot(dx, dz);
      if (moved <= TELEPORT_M && moved / dtS >= CHASE_STOPPED_SPEED_MPS) {
        travel = headingOfDirection(dx, dz);
        // A known reversal is the body moving backwards: its heading is the
        // opposite of its travel.
        if (subject.motionDirection === -1) travel = wrapAngle(travel + Math.PI);
      }
    }
    this.lastX = subject.x;
    this.lastZ = subject.z;
    this.hasLast = true;

    const bodyHeading = subject.headingRad !== null && Number.isFinite(subject.headingRad)
      ? subject.headingRad
      : null;

    if (this.heading === null) {
      this.heading = wrapAngle(bodyHeading ?? travel ?? 0);
      return this.heading;
    }

    const speed = Number.isFinite(subject.speedMps) ? Math.abs(subject.speedMps) : 0;
    const moving = speed >= CHASE_STOPPED_SPEED_MPS || travel !== null;
    if (!moving) return this.heading;

    if (bodyHeading !== null) {
      this.heading = wrapAngle(bodyHeading);
      return this.heading;
    }
    if (travel === null) return this.heading;
    // Travel direction only: a jump this large is a reversal, so keep facing
    // the way the body faces.
    if (Math.abs(angleDelta(this.heading, travel)) > CHASE_REVERSAL_RAD) {
      travel = wrapAngle(travel + Math.PI);
    }
    this.heading = travel;
    return this.heading;
  }
}

/** The unsmoothed chase pose for one subject, trailing along `yawRad`. */
export function chasePoseFor(
  subject: Pick<ChaseSubject, "x" | "z" | "dims">,
  groundY: number,
  yawRad: number,
  rig: ChaseRig,
  into: ChasePose,
): ChasePose {
  const forwardX = Math.cos(yawRad);
  const forwardZ = -Math.sin(yawRad);
  into.eyeX = subject.x - forwardX * rig.distanceM;
  into.eyeY = groundY + rig.heightM;
  into.eyeZ = subject.z - forwardZ * rig.distanceM;
  into.targetX = subject.x + forwardX * rig.lookAheadM;
  into.targetY = groundY + rig.targetHeightM;
  into.targetZ = subject.z + forwardZ * rig.lookAheadM;
  return into;
}

/**
 * The horizontal angle between where the camera looks from (eye to actor) and
 * the actor's heading, degrees. 0 is directly behind. The E2E check and the
 * tests use it to prove the camera ends up behind the actor.
 */
export function chaseTrailAngleDeg(
  eye: { readonly x: number; readonly z: number },
  actor: { readonly x: number; readonly z: number; readonly headingRad: number },
): number {
  const dx = actor.x - eye.x;
  const dz = actor.z - eye.z;
  if (Math.hypot(dx, dz) < 1e-6) return 0;
  return Math.abs(angleDelta(actor.headingRad, headingOfDirection(dx, dz))) * 180 / Math.PI;
}

const POSE_AXES = ["eyeX", "eyeY", "eyeZ", "targetX", "targetY", "targetZ"] as const;

function blankPose(): ChasePose {
  return { eyeX: 0, eyeY: 0, eyeZ: 0, targetX: 0, targetY: 0, targetZ: 0 };
}

/**
 * One chase camera: heading tracker, yaw spring, height smoothing and the ease
 * in from wherever the free camera was. Allocation-free per update.
 */
export class ChaseCameraRig {
  private readonly tracker = new ChaseHeadingTracker();
  private readonly desired = blankPose();
  private readonly output = blankPose();
  private readonly from = blankPose();
  private yaw = 0;
  private yawVelocity = 0;
  private groundY = 0;
  private eyeLift = 0;
  private settled = false;
  private entryElapsedS = 0;
  private entering = false;
  private zoomFactor = 1;

  /** The yaw the camera currently trails along, radians. */
  get yawRad(): number {
    return this.yaw;
  }

  get zoom(): number {
    return this.zoomFactor;
  }

  /** Scale the trailing distance (the wheel does this); clamped. */
  setZoom(zoom: number): void {
    this.zoomFactor = clamp(zoom, CHASE_MIN_ZOOM, CHASE_MAX_ZOOM);
  }

  /**
   * Start (or restart) a chase. `fromView` is the camera's current eye and
   * target; the first {@link CHASE_ENTRY_S} ease from it into the chase pose so
   * a click never cuts. Omit it to snap.
   */
  begin(fromView?: ChasePose): void {
    this.tracker.reset();
    this.settled = false;
    this.yawVelocity = 0;
    this.eyeLift = 0;
    this.entryElapsedS = 0;
    this.entering = Boolean(fromView);
    if (fromView) for (const axis of POSE_AXES) this.from[axis] = fromView[axis];
  }

  /**
   * Advance one rendered frame and return the pose to apply. `groundAt`
   * samples the terrain under the eye so the camera never ends up inside a
   * hillside behind the actor.
   */
  update(
    subject: ChaseSubject,
    dtS: number,
    groundAt?: (x: number, z: number) => number | null,
  ): ChasePose {
    const step = Math.min(MAX_STEP_S, Math.max(0, Number.isFinite(dtS) ? dtS : 0));
    const heading = this.tracker.resolve(subject, step);
    const firstFrame = !this.settled;
    if (!this.settled) {
      this.yaw = heading;
      this.yawVelocity = 0;
      this.groundY = subject.y;
      this.settled = true;
    } else if (step > 0) {
      this.yawVelocity = springVelocity(
        this.yawVelocity,
        angleDelta(this.yaw, heading),
        CHASE_YAW_STIFFNESS,
        step,
      );
      this.yaw = wrapAngle(this.yaw + this.yawVelocity * step);
      this.groundY += (subject.y - this.groundY) * (1 - Math.exp(-HEIGHT_RATE * step));
    }

    const desired = chasePoseFor(subject, this.groundY, this.yaw, chaseRig(subject.dims, this.zoomFactor), this.desired);
    const groundUnderEye = groundAt?.(desired.eyeX, desired.eyeZ);
    const wantedLift = groundUnderEye === null || groundUnderEye === undefined
      ? 0
      : Math.max(0, groundUnderEye + EYE_CLEARANCE_M - desired.eyeY);
    // Rising ground lifts the eye briskly (it must not sink into a slope),
    // falling ground lets it down gently; the first frame has nothing to ease from.
    const liftRate = wantedLift > this.eyeLift ? LIFT_RATE : HEIGHT_RATE;
    this.eyeLift = firstFrame || step === 0
      ? Math.max(firstFrame ? 0 : this.eyeLift, wantedLift)
      : this.eyeLift + (wantedLift - this.eyeLift) * (1 - Math.exp(-liftRate * step));
    desired.eyeY += this.eyeLift;

    if (!this.entering) {
      for (const axis of POSE_AXES) this.output[axis] = desired[axis];
      return this.output;
    }
    this.entryElapsedS += step;
    const linear = Math.min(1, this.entryElapsedS / CHASE_ENTRY_S);
    const eased = 1 - Math.pow(1 - linear, 3);
    for (const axis of POSE_AXES) {
      this.output[axis] = this.from[axis] + (desired[axis] - this.from[axis]) * eased;
    }
    if (linear >= 1) this.entering = false;
    return this.output;
  }
}
