/**
 * Spec-derived oracles for the OpenSCENARIO conformance suite.
 *
 * This is deliberately NOT a scenario player. Each case states, by hand, the
 * piecewise motion the ASAM OpenSCENARIO XML 1.4.0 text prescribes (which
 * transition, when it starts, how long it lasts, what shape it has) and the
 * discrete time every event must start; this module only evaluates those
 * closed-form shape functions and integrates them on a straight road. No
 * other implementation's opinion enters the expected values.
 *
 * Shape functions (ASAM OSC XML 1.4.0, enumeration `DynamicsShape`), with
 * τ ∈ [0, 1] the normalised progress through the transition:
 *   step        target reached instantaneously ("does not consume simulation time")
 *
 * Sampling convention (decision D-01): the sample at tick t_k is the state
 * before actions triggered at t_k are applied; those actions act over the
 * step [t_k, t_k+1]. For continuous shapes this is automatic (zero progress at
 * t_k); for step changes and deletions the new state first shows at t_k+1.
 *   linear      f = f0 + Δ·τ
 *   cubic       f = f0 + Δ·(3τ² − 2τ³)        (cubic with zero gradient at both ends)
 *   sinusoidal  f = f0 + Δ·(1 − cos πτ)/2     (A·sin + B with zero gradient at both ends)
 *
 * For `dynamicsDimension="distance"` τ is travelled distance over the
 * transition distance (the shape is "a function of … distance"), so the time
 * course follows from ds/dt = v(s); it is integrated here with RK4 at 1 ms.
 */

export type OracleShape = 'step' | 'linear' | 'cubic' | 'sinusoidal';

export function shapeProgress(shape: OracleShape, tau: number): number {
  const p = Math.min(1, Math.max(0, tau));
  switch (shape) {
    // "Does not consume simulation time": in effect from the step that starts at
    // the trigger tick; the trigger-tick sample itself is pre-action (D-01).
    case 'step': return tau > 0 ? 1 : 0;
    case 'linear': return p;
    case 'cubic': return p * p * (3 - 2 * p);
    case 'sinusoidal': return (1 - Math.cos(Math.PI * p)) / 2;
  }
}

/** A longitudinal segment starting at `t0`. Without a transition the speed is held. */
export interface SpeedSegment {
  readonly t0: number;
  /** Speed at t0; omitted = the speed the previous segment reached at t0. */
  readonly from?: number;
  readonly to?: number;
  readonly shape?: OracleShape;
  /** Transition length in seconds (time-domain shapes). */
  readonly durationS?: number;
  /** Transition length in metres (distance-domain shapes). */
  readonly distanceM?: number;
}

export interface LateralSegment {
  readonly t0: number;
  /** World y at the start; omitted = the y reached by the previous segment. */
  readonly fromY?: number;
  readonly toY: number;
  readonly shape: OracleShape;
  readonly durationS: number;
}

export interface ActorOracle {
  readonly x0: number;
  readonly y0: number;
  /** +1 travels +x, −1 travels −x. */
  readonly direction?: 1 | -1;
  readonly v0: number;
  readonly longitudinal?: readonly SpeedSegment[];
  readonly lateral?: readonly LateralSegment[];
  /** Entity removed from the simulation at this time (DeleteEntityAction). */
  readonly deletedAtS?: number;
}

export interface EventOracle {
  /** Discrete start time; `null` = must never start within the clip. */
  readonly start: number | null;
  /** Discrete end (completeState) time, when the clause defines one. */
  readonly end?: number | null;
  /** Number of executions (startTransitions) within the clip, when asserted. */
  readonly executions?: number;
}

export interface CaseOracle {
  /** ASAM OSC XML 1.4.0 clauses the expected values are derived from. */
  readonly clauses: readonly string[];
  /** How the numbers were derived, in prose, so a reviewer can redo them. */
  readonly derivation: string;
  readonly actors: Readonly<Record<string, ActorOracle>>;
  readonly events?: Readonly<Record<string, EventOracle>>;
  /**
   * Where the spec leaves the choice to the implementation, the id of the
   * decision in the semantics-decisions table this oracle adopts.
   */
  readonly decisions?: readonly string[];
}

export interface OracleSample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly speedMps: number;
  readonly headingRad: number;
  readonly present: boolean;
}

const INTEGRATION_STEP_S = 0.001;

function speedAt(segments: readonly SpeedSegment[], v0: number, t: number, distanceSinceSegment: number, startSpeeds: readonly number[]): number {
  let index = -1;
  // Only segments already entered by the integrator (their start speed known).
  for (let i = 0; i < segments.length; i += 1) if (segments[i]!.t0 <= t + 1e-12 && startSpeeds[i] !== undefined) index = i;
  if (index < 0) return v0;
  const segment = segments[index]!;
  const from = startSpeeds[index]!;
  if (segment.to === undefined || segment.shape === undefined) return from;
  const delta = segment.to - from;
  if (segment.shape === 'step') return t > segment.t0 + 1e-12 ? segment.to : from;
  if (segment.distanceM !== undefined) return from + delta * shapeProgress(segment.shape, distanceSinceSegment / segment.distanceM);
  const duration = segment.durationS ?? 0;
  if (duration <= 0) return segment.to;
  return from + delta * shapeProgress(segment.shape, (t - segment.t0) / duration);
}

function lateralAt(segments: readonly LateralSegment[], y0: number, t: number): { y: number; dy: number } {
  let y = y0;
  let dy = 0;
  for (const segment of segments) {
    if (t < segment.t0) break;
    const from = segment.fromY ?? y;
    const tau = (t - segment.t0) / segment.durationS;
    y = from + (segment.toY - from) * shapeProgress(segment.shape, tau);
    const h = 1e-4;
    // At the trigger tick the sample is pre-action (D-01): no lateral velocity yet.
    dy = segment.shape === 'step' || tau >= 1 || tau <= 0
      ? 0
      : ((segment.toY - from) * (shapeProgress(segment.shape, tau + h / segment.durationS) - shapeProgress(segment.shape, tau))) / h;
  }
  return { y, dy };
}

/**
 * Evaluate an actor oracle on the 20 ms grid `0, 0.02, …, clipSeconds`.
 * Path length integrates the prescribed speed (RK4, 1 ms); x advances by the
 * part of it not spent laterally; speed and lateral offset are the
 * closed-form shape functions.
 */
export function evaluateActorOracle(oracle: ActorOracle, clipSeconds: number): OracleSample[] {
  const segments = [...(oracle.longitudinal ?? [])].sort((a, b) => a.t0 - b.t0);
  const lateral = [...(oracle.lateral ?? [])].sort((a, b) => a.t0 - b.t0);
  const direction = oracle.direction ?? 1;
  const out: OracleSample[] = [];
  const startSpeeds: number[] = [];
  let travelled = 0;
  // Longitudinal (x) progress. Speed is the length of the velocity vector
  // (7.4.1.1: the default strategy controls "the length of the vehicle's speed
  // vector"), so a lateral motion takes its share: dx/dt = sqrt(v² − ẏ²).
  let longitudinal = 0;
  let segmentStartTravel = 0;
  let segmentIndex = -1;
  let t = 0;
  const totalSteps = Math.round(clipSeconds / INTEGRATION_STEP_S);
  const speedNow = (time: number, dist: number) => speedAt(segments, oracle.v0, time, dist - segmentStartTravel, startSpeeds);
  for (let step = 0; step <= totalSteps; step += 1) {
    t = step * INTEGRATION_STEP_S;
    // Enter any segment whose start time has arrived; its `from` is the speed reached so far.
    while (segmentIndex + 1 < segments.length && segments[segmentIndex + 1]!.t0 <= t + 1e-12) {
      const reached = segmentIndex < 0 ? oracle.v0 : speedNow(t, travelled);
      segmentIndex += 1;
      startSpeeds[segmentIndex] = segments[segmentIndex]!.from ?? reached;
      segmentStartTravel = travelled;
    }
    if (step % 20 === 0) {
      const present = oracle.deletedAtS === undefined || t <= oracle.deletedAtS + 1e-9;
      const { y, dy } = lateralAt(lateral, oracle.y0, t);
      const v = speedNow(t, travelled);
      const vx = v * direction;
      const heading = Math.atan2(dy, vx === 0 ? direction : vx);
      out.push({ t: Math.round(t * 1000) / 1000, x: oracle.x0 + direction * longitudinal, y, speedMps: v, headingRad: heading, present });
    }
    if (step === totalSteps) break;
    const h = INTEGRATION_STEP_S;
    const k1 = speedNow(t, travelled);
    const k2 = speedNow(t + h / 2, travelled + (h / 2) * k1);
    const k3 = speedNow(t + h / 2, travelled + (h / 2) * k2);
    const k4 = speedNow(t + h, travelled + h * k3);
    const pathStep = (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    const lateralRate = lateralAt(lateral, oracle.y0, t + h / 2).dy;
    const pathSpeed = pathStep / h;
    longitudinal += Math.sqrt(Math.max(0, pathSpeed * pathSpeed - lateralRate * lateralRate)) * h;
    travelled += pathStep;
  }
  return out;
}
