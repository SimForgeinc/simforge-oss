/**
 * The driving simulator's per-frame vehicle telemetry.
 *
 * One value per rendered frame, produced from the world session's truth frame
 * and consumed by the HUD, the camera rig and the engine-audio graph. It is the
 * shared contract between those three, so it lives in its own module with no
 * imports: the audio unit tests run in a node environment and the HUD reads it
 * from a ref inside a requestAnimationFrame callback.
 *
 * Every field is required. A consumer that has to test each field for presence
 * cannot be written without inventing a fallback, and three consumers inventing
 * three different fallbacks is how a speedometer and a tachometer end up
 * disagreeing about the same car.
 */
export interface DriveTelemetry {
  /** Forward ground speed, m/s. Negative while reversing. */
  speedMps: number;
  /** Engine speed, rev/min. */
  rpm: number;
  /** Selected gear: 1..n forward, 0 neutral, -1 reverse. */
  gear: number;
  /** Applied throttle, 0..1, after the driver command reached the physics step. */
  throttle: number;
  /** Applied brake, 0..1. */
  brake: number;
  /** Applied steering, -1 (full left) .. 1 (full right), as a fraction of the steering lock. */
  steer: number;
  /** The same steering as an actual road-wheel angle, radians, signed like `steer`. */
  steerRad: number;
  /** Wheel angular speeds, rad/s, ordered front-left, front-right, rear-left, rear-right. */
  wheelSpeeds: readonly [number, number, number, number];
  /** Fraction of the available axle friction circle in use, 0..1 and briefly above it while sliding. */
  tyreUtilization: { front: number; rear: number };
  /** Longitudinal acceleration in g, positive under acceleration. */
  longitudinalG: number;
  /** Lateral acceleration in g, positive to the right of travel. */
  lateralG: number;
  /** The car's contact patches are off the drivable surface. */
  offRoad: boolean;
  /**
   * Summed normal impulse from collisions resolved on the physics tick this
   * frame carries, N·s, and 0 on the overwhelming majority of frames. Both the
   * HUD's impact flash and the audio graph's impact one-shot scale with it.
   */
  collisionImpulseNs: number;
}

/**
 * Telemetry for a car that exists but has not been stepped yet. Consumers keep
 * one mutable telemetry object for the session's lifetime and copy fields into
 * it, so this is a factory rather than a frozen constant.
 */
export function emptyDriveTelemetry(): DriveTelemetry {
  return {
    speedMps: 0,
    rpm: 0,
    gear: 0,
    throttle: 0,
    brake: 0,
    steer: 0,
    steerRad: 0,
    wheelSpeeds: [0, 0, 0, 0],
    tyreUtilization: { front: 0, rear: 0 },
    longitudinalG: 0,
    lateralG: 0,
    offRoad: false,
    collisionImpulseNs: 0,
  };
}
