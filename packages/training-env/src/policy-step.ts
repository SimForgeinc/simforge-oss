/**
 * Policy-step vocabulary: the actions a driving policy issues, the fallback
 * applied on a deadline miss, and the per-decision deadline report.
 *
 * Deadline enforcement is *declarative*: the caller (or a real-time gateway)
 * measures its own inference latency and reports it as `elapsedMs`; the native
 * `PolicySession` resolves the miss deterministically, so the same requests
 * produce byte-identical episodes. Fallback semantics on a miss (the supplied
 * action is discarded):
 *
 *   'repeat-last'  — re-apply the last *applied* action of this episode
 *                    (policy or fallback); before any applied action it
 *                    degrades to 'scripted'.
 *   'zero-control' — control passthrough of all zeros (coast, wheel centred).
 *   'scripted'     — no override this decision; the authored choreography
 *                    drives the ego.
 *
 * These documents are the JSON the native `simforge-session::policy` module
 * serialises (`PolicyAction`, `FallbackPolicy`, `TrajectoryExecution`,
 * `DeadlineReport`); the wire framing of the retired Node env-server is gone.
 */

/**
 * One trajectory sample in the *ego frame at plan issuance*: x forward along
 * the ego heading, y left (90° CCW), heading relative to the ego yaw
 * (radians), signed speed (m/s, negative = reverse), `t` seconds from
 * issuance. Samples are strictly future (`t > 0`) — the first point is not
 * the current pose.
 */
export interface TrajectoryPoint {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly speed: number;
  readonly t: number;
}

/**
 * Trajectory action. Execution is a session property (`PolicySession.execution`):
 *
 * - `'pure-pursuit'` (default): the executor anchors the plan to the world
 *   frame at the pose of the observation this act responds to and tracks it
 *   until a *different* plan replaces it (zero-order hold).
 * - `'speed-setpoint'` (v1 reduction, kept for regression comparability): the
 *   target speed is taken from the earliest point with `t > 0`; steering stays
 *   with the authored route logic.
 */
export interface ActionTrajectory {
  readonly kind: 'trajectory';
  readonly points: readonly TrajectoryPoint[];
}

/** Low-level control action, passed through to the vehicle backend. */
export interface ActionControl {
  readonly kind: 'control';
  readonly throttle: number;
  readonly brake: number;
  readonly steer: number;
}

export type PolicyAction = ActionTrajectory | ActionControl;

/** Fallback applied when a decision misses its deadline. */
export type FallbackPolicy = 'repeat-last' | 'zero-control' | 'scripted';
export const FALLBACK_POLICIES: readonly FallbackPolicy[] = ['repeat-last', 'zero-control', 'scripted'];

/** How a session executes trajectory actions (see {@link ActionTrajectory}). */
export type TrajectoryExecution = 'pure-pursuit' | 'speed-setpoint';

/** Per-decision deadline verdict. */
export interface DeadlineReport {
  /** Effective limit for this decision; null = no deadline. */
  readonly limitMs: number | null;
  /** Caller-reported inference latency; null = unreported. */
  readonly elapsedMs: number | null;
  readonly miss: boolean;
  /** What actually drove the ego: the policy's action or a fallback. */
  readonly applied: 'policy' | FallbackPolicy;
}

/** The all-zero control fallback. */
export const ZERO_CONTROL: ActionControl = { kind: 'control', throttle: 0, brake: 0, steer: 0 };

/** Pure-pursuit executor telemetry the native session reports beside a decision (`executorJson`). */
export interface ExecutorFrame {
  /** Ego pose the command was computed from (world frame). */
  readonly x: number;
  readonly y: number;
  readonly headingRad: number;
  readonly speedMps: number;
  /** Signed cross-track error to the anchored plan, +left, metres. */
  readonly crossTrackErrorM: number;
  /** Along-track arc position, metres. */
  readonly alongTrackM: number;
  /** Plan age, seconds since issuance. */
  readonly planAgeS: number;
  /** Applied setpoints: speed, feedforward accel, direction. */
  readonly targetSpeedMps: number;
  readonly targetAccelerationMps2: number;
  readonly motionDirection: -1 | 1;
  /** Pure-pursuit preview point + heading (world frame). */
  readonly previewPoint: { readonly x: number; readonly y: number };
  readonly previewHeadingRad: number;
}
