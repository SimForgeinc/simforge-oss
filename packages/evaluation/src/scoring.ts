/**
 * SimForge-native closed-loop scoring over policy_step episode traces.
 *
 * Consumes the rich JSONL trace written by the gym episode runner
 * (one `reset` record, one record per decision carrying the decoded ego
 * state vector `sv`, the perception object list `objs` and the reward
 * breakdown `terms`, then a `summary` line) and produces a
 * route-completion × infraction-penalty driving score with per-event
 * records (tick + position), TTC minima and comfort (accel/jerk) metrics.
 *
 * Model-independent by construction: everything here is a pure function of
 * the trace plus the authored scenario context — no engine, no wall clock.
 * Deterministic traces therefore score identically forever.
 *
 * Terminal collision/goal classification mirrors the policy-eval server's
 * wire metrics (`col`/`goal` in eval-server.ts): the shared helpers
 * {@link collisionFromReward} / {@link goalFromReward} are the single
 * source of that rule.
 *
 * Boundary semantics (unit-tested exactly):
 * - thresholds on instantaneous values are strict (`>` / `<`);
 * - durations and accumulations fire inclusively (`>=`);
 * - `elapsed == deadline` is on time upstream (policy_step contract), so a
 *   `miss` flag in the trace is authoritative here.
 */

/* ------------------------------------------------------------ trace shapes */

import { ACTOR_KINDS, canonicalJson, isRoadActorKind, sha256, type ActorKind } from '@simforge-oss/engine';

import {
  footprintContainment,
  offRoadMetricVersion,
  type DrivableArea,
} from './replay-context/drivable.js';
import { bindLane, detectLaneTransitions, type LaneContext } from './replay-context/lanes.js';

/** Perception object row on the wire: [id, rangeM, bearingRad, rangeRateMps, lineOfSight]. */
export type TraceObj = readonly [string, number, number, number, number];

/** Optional per-decision signal annotation (red-light scoring input). */
export interface TraceSignalState {
  /** Governing head state for the ego's approach. */
  readonly state: 'red' | 'yellow' | 'green';
  /** Signed distance to the stop line along the route, metres (<= 0 once crossed). */
  readonly distM: number;
}

export interface TraceResetRecord {
  readonly seed: number | string;
  readonly session?: number;
  readonly t: number;
  readonly sv: readonly number[] | null;
  readonly objs: readonly TraceObj[];
  readonly deadline_ms?: number;
  readonly fallback?: string;
  readonly policy?: string;
}

export interface TraceStepRecord {
  readonly step: number;
  readonly t: number;
  readonly a?: unknown;
  readonly miss: number;
  readonly applied?: string;
  readonly rw: number;
  readonly term: number;
  readonly trunc: number;
  readonly sv: readonly number[] | null;
  /** [progress, proximity, comfort] — the wire's non-terminal reward terms. */
  readonly terms?: readonly number[] | null;
  /** Complete kernel terms; compact `terms` is retained only for archived traces. */
  readonly reward_terms?: Readonly<Record<string, number | boolean>>;
  readonly objs: readonly TraceObj[];
  readonly collision?: { readonly partnerId: string; readonly partnerKind: string; readonly side?: 'front' | 'lateral' | 'rear' } | null;
  readonly events?: readonly { readonly kind: string; readonly a?: string; readonly b?: string; readonly contactSides?: readonly ('front' | 'lateral' | 'rear')[] }[];
  /** Optional signal annotation; enables the red-light checker when present. */
  readonly sig?: TraceSignalState | null;
  /**
   * Executor telemetry when the decision drove a trajectory: the ego's WORLD
   * pose, which is what drivable-area containment needs. Absent on
   * speed-setpoint decisions, and its absence makes containment unavailable
   * rather than passing.
   */
  readonly ex?: { readonly x: number; readonly y: number; readonly headingRad: number } | null;
}

export interface ParsedTrace {
  readonly reset: TraceResetRecord | null;
  readonly steps: readonly TraceStepRecord[];
  readonly summary: Record<string, unknown> | null;
}

export const EPISODE_TRACE_SCHEMA = 'simforge.episode-trace/v2';

/** Verify the kernel chain, including reset/warm-up and the sealed completion record. */
export function verifyEpisodeTrace(records: readonly Record<string, unknown>[]): string {
  const reset = records[0]?.['reset'] as Record<string, unknown> | undefined;
  if (reset?.['schema'] !== EPISODE_TRACE_SCHEMA) throw new Error(`expected ${EPISODE_TRACE_SCHEMA} reset record`);
  let chain = '';
  let step = 0;
  for (const [index, row] of records.entries()) {
    if ('summary' in row) {
      const summary = row['summary'] as Record<string, unknown>;
      if (index !== records.length - 1 || row['episode_digest'] !== chain || summary['episodeDigest'] !== chain) throw new Error('invalid episode completion record');
      continue;
    }
    if (index > 0 && row['step'] !== step++) throw new Error(`non-contiguous episode trace at record ${index}`);
    const { digest, timing: _timing, ...deterministic } = row;
    if (deterministic['dl']) deterministic['dl'] = { ...deterministic['dl'] as Record<string, unknown>, el: null };
    chain = sha256(chain + canonicalJson(deterministic));
    if (digest !== chain) throw new Error(`episode trace digest mismatch at record ${index}`);
  }
  if (!records.at(-1)?.['summary']) throw new Error('episode trace is not sealed: call Episode.finish() first');
  return chain;
}

function episodeObjects(value: unknown): TraceObj[] {
  return (value as { id: string; rangeM: number; bearingRad: number; rangeRateMps: number; lineOfSight: boolean }[] ?? [])
    .map((object) => [object.id, object.rangeM, object.bearingRad, object.rangeRateMps, object.lineOfSight ? 1 : 0]);
}

/** The same scoring projection as gym's tools/episode_trace.py; raw v2 evidence stays untouched. */
function parseEpisodeTrace(records: readonly Record<string, unknown>[]): ParsedTrace {
  const digest = verifyEpisodeTrace(records);
  const reset = records[0]!['reset'] as Record<string, unknown>;
  const observation = reset['observation'] as Record<string, unknown>;
  const warmup = records.filter((row) => row['phase'] === 'warmup');
  const start = warmup.at(-1);
  const core = records.at(-1)!['summary'] as Record<string, unknown>;
  return {
    reset: {
      seed: reset['seed'] as number | string,
      t: (start?.['t'] ?? reset['t']) as number,
      sv: (start?.['sv'] ?? observation['stateVector'] ?? null) as readonly number[] | null,
      // Reset object handles have no scorer IDs; warm-up rows do.
      objs: start ? episodeObjects(start['objs']) : [],
      ...(typeof reset['deadline_ms'] === 'number' ? { deadline_ms: reset['deadline_ms'] } : {}),
      ...(typeof reset['fallback'] === 'string' ? { fallback: reset['fallback'] } : {}),
      policy: 'policy',
    },
    steps: records.filter((row) => row['phase'] === 'policy').map((row, index) => ({
      step: index, t: row['t'] as number, a: row['a'],
      miss: row['miss'] as number, applied: row['applied'] as string,
      rw: row['rw'] as number, term: row['term'] as number, trunc: row['trunc'] as number,
      sv: row['sv'] as readonly number[] | null,
      terms: row['terms'] as readonly number[],
      ...(row['reward_terms'] ? { reward_terms: row['reward_terms'] as NonNullable<TraceStepRecord['reward_terms']> } : {}),
      objs: episodeObjects(row['objs']),
      ex: (row['ex'] ?? (Array.isArray(row['sv']) && row['sv'].length >= 4
        ? { x: row['sv'][0], y: row['sv'][1], headingRad: Math.atan2(row['sv'][3], row['sv'][2]) } : null)) as NonNullable<TraceStepRecord['ex']> | null,
      collision: (row['collision'] ?? null) as TraceStepRecord['collision'],
      events: row['events'] as TraceStepRecord['events'],
      // Native signal approaches lack signed stop-line distance: not scorer sig.
    })),
    summary: {
      mode: core['mode'], status: core['status'], steps: core['decisions'],
      term_reason: core['termReason'],
      terminated: ['collision', 'offroad', 'red_crossing', 'goal'].includes(core['termReason'] as string),
      truncated: core['truncation'] !== null,
      deadline_misses: core['deadlineMisses'],
      episode_digest: digest, source_episode_digest: digest, source_schema: EPISODE_TRACE_SCHEMA,
    },
  };
}

/** Parse an episode-runner trace (JSONL). Unknown keys pass through untouched. */
export function parseTraceJsonl(text: string): ParsedTrace {
  const records = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
  if ((records[0]?.['reset'] as Record<string, unknown> | undefined)?.['schema'] === EPISODE_TRACE_SCHEMA) return parseEpisodeTrace(records);
  let reset: TraceResetRecord | null = null;
  let summary: Record<string, unknown> | null = null;
  const steps: TraceStepRecord[] = [];
  for (const doc of records) {
    if (doc['reset'] !== undefined) {
      reset = doc['reset'] as TraceResetRecord;
    } else if (doc['summary'] !== undefined) {
      summary = doc['summary'] as Record<string, unknown>;
    } else if (typeof doc['step'] === 'number') {
      steps.push(doc as unknown as TraceStepRecord);
    }
  }
  steps.sort((a, b) => a.step - b.step);
  return { reset, steps, summary };
}

/* -------------------------------------------- terminal reward classification */

/** The reward view both the eval server and the trace scorer classify from. */
export interface TerminalRewardView {
  readonly terminated: boolean;
  readonly reward: number;
  /** Named terms; terminal `collision` / `goal` present only when they fired. */
  readonly rewardTerms: Readonly<Record<string, number>>;
  readonly authoritativeTerms?: boolean;
}

/**
 * Collision rule shared with the policy-eval server's `col` wire metric:
 * native terms are authoritative. Only archived callers without named native
 * facts use the old deeply-negative-terminal fallback.
 */
export function collisionFromReward(view: TerminalRewardView): boolean {
  if (view.authoritativeTerms) return 'collision' in view.rewardTerms;
  return (
    'collision' in view.rewardTerms ||
    (view.terminated && view.reward <= -1 && !('goal' in view.rewardTerms))
  );
}

/** Goal rule shared with the policy-eval server's `goal` wire metric. */
export function goalFromReward(view: TerminalRewardView): boolean {
  return Boolean(view.rewardTerms['goal']);
}

/** Residuals smaller than this are shaping noise, not terminal bonuses. */
const TERMINAL_RESIDUAL_EPS = 1e-6;

/**
 * Prefer the complete named kernel breakdown. Archived traces with only
 * `rw` and three shaping terms retain their original terminal-residual reader.
 */
export function rewardViewFromStep(step: TraceStepRecord): TerminalRewardView {
  if (step.reward_terms) return {
    terminated: step.term === 1, reward: step.rw, authoritativeTerms: true,
    rewardTerms: Object.fromEntries(Object.entries(step.reward_terms).filter((entry): entry is [string, number] => typeof entry[1] === 'number')),
  };
  const [progress = 0, proximity = 0, comfort = 0] = step.terms ?? [];
  const residual = step.rw - (progress + proximity + comfort);
  return {
    terminated: step.term === 1,
    reward: step.rw,
    rewardTerms: {
      progress,
      proximity,
      comfort,
      ...(step.term === 1 && residual < -TERMINAL_RESIDUAL_EPS ? { collision: residual } : {}),
      ...(step.term === 1 && residual > TERMINAL_RESIDUAL_EPS ? { goal: residual } : {}),
    },
  };
}

/* ----------------------------------------------------------- configuration */

export type InfractionType =
  | 'collision-vehicle'
  | 'collision-pedestrian'
  | 'collision-static'
  | 'off-road'
  | 'lane-departure'
  | 'wrong-way'
  | 'red-light'
  | 'stuck'
  | 'speeding';

export type ScoreEventType =
  | InfractionType
  | 'lane-transition'
  | 'ttc-critical'
  | 'accel-bound'
  | 'jerk-bound'
  | 'deadline-miss'
  | 'goal-reached';

export interface ScoreEvent {
  readonly type: ScoreEventType;
  /** Decision index (trace `step`). */
  readonly tick: number;
  readonly tS: number;
  readonly severity: 'info' | 'warning' | 'infraction';
  readonly position: { x: number; y: number } | null;
  readonly data?: Record<string, unknown>;
}

/** Multiplicative penalty factor applied once per infraction event. */
export interface PenaltyFactors {
  collisionVehicle: number;
  collisionPedestrian: number;
  collisionStatic: number;
  offRoad: number;
  laneDeparture: number;
  wrongWay: number;
  redLight: number;
  stuck: number;
  speeding: number;
}

export interface ScoringConfig {
  penalties: PenaltyFactors;
  /** Off-road when |lane-relative lateral offset| exceeds this (strict >), metres. */
  offRoadLateralM: number;
  /** Hysteresis: an off-road episode clears when |offset| <= offRoadLateralM - offRoadClearM. */
  offRoadClearM: number;
  /** Wrong-way when cumulative reverse route-arc progress reaches this (>=), metres. */
  wrongWayReverseM: number;
  /** Reverse progress only counts while moving faster than this, m/s. */
  wrongWayMinSpeedMps: number;
  /** Stopped when speed is below this (strict <), m/s. */
  stuckSpeedMps: number;
  /** Stuck fires when continuously stopped for at least this long (>=), seconds. */
  stuckTimeoutS: number;
  /**
   * How long an undecided (`ambiguous`) run may last and still be a lane
   * CHANGE rather than a departure, seconds. A crossing is bounded; riding a
   * lane line is not a crossing.
   */
  laneChangeMaxS: number;
  /** Speeding when speed > limit × (1 + tolerance) (strict >). */
  speedingToleranceFrac: number;
  /** Speeding fires when continuously over for at least this long (>=), seconds. */
  speedingMinDurationS: number;
  /** ttc-critical when the step's minimum TTC drops below this (strict <), seconds. */
  ttcCriticalS: number;
  /** Comfort bounds: events fire when exceeded (strict >). */
  comfortMaxAccelMps2: number;
  comfortMaxJerkMps3: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  penalties: {
    // CARLA-leaderboard-shaped factors, SimForge event vocabulary.
    collisionVehicle: 0.6,
    collisionPedestrian: 0.5,
    collisionStatic: 0.65,
    offRoad: 0.75,
    laneDeparture: 0.75,
    wrongWay: 0.7,
    redLight: 0.7,
    stuck: 0.8,
    speeding: 0.9,
  },
  offRoadLateralM: 3.0,
  offRoadClearM: 0.5,
  laneChangeMaxS: 4.0,
  wrongWayReverseM: 1.0,
  wrongWayMinSpeedMps: 0.5,
  stuckSpeedMps: 0.3,
  stuckTimeoutS: 8,
  speedingToleranceFrac: 0.1,
  speedingMinDurationS: 1.0,
  ttcCriticalS: 1.5,
  comfortMaxAccelMps2: 3.5,
  comfortMaxJerkMps3: 8,
};

/** Authored facts about the scenario an episode ran in. */
export interface ScenarioScoringContext {
  /** Decisions per second the trace was recorded at. */
  readonly decisionHz: number;
  /** Actor id → authored kind ('vehicle' | 'pedestrian' | 'bicycle' | …). */
  readonly actorKinds?: Readonly<Record<string, string>>;
  /** Authored speed limit for the ego's corridor; null disables the speeding checker. */
  readonly speedLimitMps?: number | null;
  /**
   * Authored route-completion denominator, metres. Route completion is
   * clamp(Δ route-arc / expectedRouteM); null scores completion as 1
   * (unassessed) unless the episode reached an explicit goal.
   */
  readonly expectedRouteM?: number | null;
  /**
   * `v2` scores off-road as footprint containment in {@link drivableArea} and
   * reports the centreline rule separately as `lane-departure`. `v1` keeps
   * off-road as the centreline rule and never emits `lane-departure`.
   *
   * Defaults to `v1`: an existing caller's numbers do not change meaning
   * because this code shipped.
   */
  readonly metricVersion?: 'v1' | 'v2';
  /** Authoritative drivable polygons, in the ego's frame. Absent -> unavailable. */
  readonly drivableArea?: DrivableArea | null;
  /**
   * Authoritative lane rails. Present WITH `metricAuthority.laneCentrelines`
   * they move lane-departure onto rail containment, where a lane change is a
   * change of binding rather than a permanent excursion.
   */
  readonly laneContext?: LaneContext | null;
  /** Ego box for the footprint; defaults to the engine's own default dims. */
  readonly egoDims?: { readonly lengthM: number; readonly widthM: number };
  /** Absolute time of decision 0, for polygons that declare a time support. */
  readonly originUs?: number | null;
  /**
   * Infractions the SCENE cannot support a claim about, declared by the caller.
   *
   * A metric with no authority behind it is unavailable, not zero: a ClipGT
   * scene whose lane speed limits are unset cannot say a drive was speeding,
   * and one with no travel-direction authority cannot say it went the wrong
   * way. Reported in {@link EpisodeScore.unavailable} and never counted.
   */
  readonly unavailableInfractions?: readonly InfractionType[];
  /** Opt-in instrument; missing safety authority remains unavailable, never a pass. */
  readonly alpasimStyle?: {
    readonly authoredRoute: readonly (readonly [number, number])[];
    readonly egoId?: string;
    /** Geometric contact-side findings from an authoritative contact observer, keyed by decision. */
    readonly collisionSides?: Readonly<Record<number, readonly ('front' | 'lateral' | 'rear')[]>>;
  };
}

/* ---------------------------------------------------------------- scoring */

export interface EpisodeScore {
  /** routeCompletion × penaltyProduct, in [0, 1]. */
  readonly drivingScore: number;
  readonly 'alpasim-style-score'?: AlpasimStyleScore;
  readonly routeCompletion: number;
  readonly penaltyProduct: number;
  readonly infractions: Readonly<Record<InfractionType, number>>;
  readonly ttc: { readonly minTtcS: number | null; readonly criticalCount: number };
  readonly comfort: {
    readonly maxAbsAccelMps2: number;
    readonly maxAbsJerkMps3: number;
    readonly accelViolations: number;
    readonly jerkViolations: number;
  };
  readonly terminal: { readonly collision: boolean; readonly goal: boolean; readonly truncated: boolean };
  readonly steps: number;
  readonly deadlineMisses: number;
  readonly events: readonly ScoreEvent[];
  /**
   * Which metric definition produced this score.
   *
   * `v1` is the lane-relative centreline rule. Anything else is the off-road
   * instrument the bundle's own geometry identifies (`simforge.offroad/v2` for
   * the lane-union ingestion whose ground-truth control failed and which is
   * retained for reproducibility, `simforge.offroad/v3` for the authoritative
   * road-boundary outline), so a score record names the instrument that
   * produced it and two ingestions are never conflated.
   */
  readonly metricVersion: string;
  /**
   * Infractions this episode could not be assessed for, sorted.
   *
   * NOT the same as zero. A consumer that reads `infractions['off-road'] === 0`
   * as clean must check this first; the manifest carries it for that reason.
   */
  readonly unavailable: readonly InfractionType[];
  /** Worst footprint excursion beyond the drivable surface, metres; null when unassessed. */
  readonly worstOffRoadM: number | null;
  /**
   * Per-sample containment accounting: decisions offered, decided, and left
   * undecidable. `assessed + unavailableSamples` need not equal `offered` when
   * containment is not enabled at all.
   */
  readonly offRoad: {
    readonly offered: number;
    readonly assessed: number;
    readonly unavailableSamples: number;
  } | null;
  /** Rail-bound lane accounting; null when lane-departure used the centreline rule. */
  readonly laneDeparture: {
    readonly bound: number;
    readonly unavailableSamples: number;
    readonly worstOffsetM: number | null;
    /** Diagnostic lane transitions observed; never penalised. */
    readonly transitions: number;
  } | null;
}

const INFRACTION_TYPES: readonly InfractionType[] = [
  'collision-vehicle',
  'collision-pedestrian',
  'collision-static',
  'off-road',
  'lane-departure',
  'wrong-way',
  'red-light',
  'stuck',
  'speeding',
];

function penaltyFor(type: InfractionType, p: PenaltyFactors): number {
  switch (type) {
    case 'collision-vehicle': return p.collisionVehicle;
    case 'collision-pedestrian': return p.collisionPedestrian;
    case 'collision-static': return p.collisionStatic;
    case 'off-road': return p.offRoad;
    case 'lane-departure': return p.laneDeparture;
    case 'wrong-way': return p.wrongWay;
    case 'red-light': return p.redLight;
    case 'stuck': return p.stuck;
    case 'speeding': return p.speeding;
  }
}

function collisionTypeForKind(kind: string | undefined): InfractionType {
  if (kind === 'pedestrian') return 'collision-pedestrian';
  if (ACTOR_KINDS.some((entry) => entry === kind) && isRoadActorKind(kind as ActorKind)) return 'collision-vehicle';
  return 'collision-static';
}

/** Minimum time-to-collision across closing perceived objects; null when nothing closes. */
export function stepMinTtcS(objs: readonly TraceObj[]): number | null {
  let min: number | null = null;
  for (const [, rangeM, , rangeRateMps] of objs) {
    if (rangeRateMps >= 0) continue; // opening or holding
    const ttc = rangeM / -rangeRateMps;
    if (min === null || ttc < min) min = ttc;
  }
  return min;
}

export function resolveScoringConfig(overrides?: Partial<ScoringConfig>): ScoringConfig {
  return {
    ...DEFAULT_SCORING_CONFIG,
    ...overrides,
    penalties: { ...DEFAULT_SCORING_CONFIG.penalties, ...(overrides?.penalties ?? {}) },
  };
}

export interface AlpasimStyleScore {
  readonly name: 'alpasim-style-score';
  readonly version: 'simforge.alpasim-style-score/v1';
  readonly label: 'not an AlpaSim result';
  readonly value: number | null;
  readonly progress: number | null;
  readonly hardFailures: readonly string[];
  readonly unavailable: readonly string[];
  readonly maxLateralM: number | null;
}

/** Geometric fault is front OR lateral contact, not legal responsibility. */
export function alpasimStyleScore(facts: {
  progress: number | null; collisionAtFault: boolean | null; offroad: boolean | null; maxLateralM: number | null;
}): AlpasimStyleScore {
  const finite = (value: number | null) => value !== null && Number.isFinite(value);
  const hardFailures = [
    ...(facts.collisionAtFault === true ? ['front-or-lateral-collision'] : []),
    ...(facts.offroad === true ? ['offroad'] : []),
    ...(finite(facts.maxLateralM) && facts.maxLateralM! >= 4 ? ['lateral-corridor-exit'] : []),
  ];
  const unavailable = [
    ...(!finite(facts.progress) ? ['progress'] : []),
    ...(facts.collisionAtFault === null ? ['collision-side-attribution'] : []),
    ...(facts.offroad === null ? ['authoritative-offroad'] : []),
    ...(!finite(facts.maxLateralM) ? ['authored-route-corridor'] : []),
  ];
  return {
    name: 'alpasim-style-score', version: 'simforge.alpasim-style-score/v1', label: 'not an AlpaSim result',
    value: hardFailures.length ? 0 : unavailable.length ? null : Math.min(Math.max(facts.progress!, 0) / 0.8, 1),
    progress: finite(facts.progress) ? facts.progress : null, hardFailures, unavailable,
    maxLateralM: finite(facts.maxLateralM) ? facts.maxLateralM : null,
  };
}

/** Nearest authored segment's perpendicular error; longitudinal endpoint overshoot is not lateral exit. */
export function authoredRouteLateralM(route: readonly (readonly [number, number])[], x: number, y: number): number | null {
  let nearest = Infinity;
  let lateral: number | null = null;
  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = route[i - 1]!;
    const [bx, by] = route[i]!;
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (length * length)));
    const distance = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (distance < nearest) {
      nearest = distance;
      lateral = Math.abs(dx * (y - ay) - dy * (x - ax)) / length;
    }
  }
  return lateral;
}

/** Score one episode trace against its authored scenario context. */
export function scoreEpisode(
  trace: ParsedTrace,
  ctx: ScenarioScoringContext,
  overrides?: Partial<ScoringConfig>,
): EpisodeScore {
  if (!Number.isFinite(ctx.decisionHz) || ctx.decisionHz <= 0) {
    throw new Error(`decisionHz must be positive, got ${String(ctx.decisionHz)}`);
  }
  const cfg = resolveScoringConfig(overrides);
  const dtS = 1 / ctx.decisionHz;
  const events: ScoreEvent[] = [];
  const counts: Record<InfractionType, number> = {
    'collision-vehicle': 0,
    'collision-pedestrian': 0,
    'collision-static': 0,
    'off-road': 0,
    'lane-departure': 0,
    'wrong-way': 0,
    'red-light': 0,
    'stuck': 0,
    'speeding': 0,
  };

  const push = (
    type: ScoreEventType,
    step: TraceStepRecord,
    severity: ScoreEvent['severity'],
    data?: Record<string, unknown>,
  ): void => {
    const sv = step.sv;
    const position = sv && sv.length >= 2 ? { x: sv[0]!, y: sv[1]! } : null;
    // A metric declared unavailable cannot also produce a finding: counting a
    // speeding event while reporting speeding as unevaluable would launder an
    // unsupported claim into the record. The event is dropped with the claim.
    if (severity === 'infraction' && unavailable.has(type as InfractionType)) return;
    events.push({ type, tick: step.step, tS: step.t, severity, position, ...(data ? { data } : {}) });
    if (severity === 'infraction') counts[type as InfractionType] += 1;
  };

  // Route-completion baseline: the reset record's route arc when present.
  const s0 = trace.reset?.sv?.[8] ?? trace.steps[0]?.sv?.[8] ?? null;

  const requested = ctx.metricVersion ?? 'v1';
  const drivableArea = requested === 'v2' ? (ctx.drivableArea ?? null) : null;
  // The instrument names itself from the geometry it was handed; with none, the
  // score is the v1 centreline definition and says so.
  const metricVersion: string = drivableArea ? offRoadMetricVersion(drivableArea) : requested;
  const containmentEnabled = requested === 'v2';
  // DEFAULT_ACTOR_DIMS' car: the spec's own dims when the caller supplies them.
  const egoDims = ctx.egoDims ?? { lengthM: 4.5, widthM: 1.9 };
  const unavailable = new Set<InfractionType>(ctx.unavailableInfractions ?? []);
  let containmentAssessed = 0;
  let containmentUnavailableSamples = 0;
  const laneContext = containmentEnabled ? (ctx.laneContext ?? null) : null;
  let laneSamplesBound = 0;
  let laneSamplesUnavailable = 0;
  let worstLaneOffsetM: number | null = null;
  let undecidedRun = 0;
  let undecidedReported = false;
  let laneTransitions = 0;
  let worstOffRoadM: number | null = null;

  // Checker state.
  let offRoadActive = false;
  let laneDepartureActive = false;
  let reverseAccumM = 0;
  let wrongWayActive = false;
  let stoppedSteps = 0;
  let stuckActive = false;
  let overSpeedSteps = 0;
  let speedingActive = false;
  let ttcCriticalActive = false;
  let accelActive = false;
  let jerkActive = false;
  let prevAccel: number | null = null;
  let prevS: number | null = s0;
  let prevSig: TraceSignalState | null = null;

  let minTtcS: number | null = null;
  let maxAbsAccel = 0;
  let maxAbsJerk = 0;
  let accelViolations = 0;
  let jerkViolations = 0;
  let deadlineMisses = 0;
  let terminalCollision = false;
  let terminalGoal = false;
  let truncated = false;
  let lastS: number | null = s0;

  for (const step of trace.steps) {
    const sv = step.sv;
    const speed = sv?.[4] ?? 0;
    const accel = sv?.[5] ?? 0;
    const latOff = sv?.[6] ?? 0;
    const routeS = sv?.[8] ?? null;

    if (step.miss === 1) {
      deadlineMisses += 1;
      push('deadline-miss', step, 'info', { applied: step.applied ?? null });
    }

    // The centreline rule. Under v1 it IS off-road; under v2 it is
    // lane-departure, and off-road is the containment question below.
    const centrelineType: InfractionType = containmentEnabled ? 'lane-departure' : 'off-road';
    if (laneContext) {
      // Rail containment, reported DIAGNOSTICALLY.
      //
      // A lane-boundary crossing is a lane TRANSITION, not an unsafe act: which
      // crossings are illegitimate depends on the route the vehicle was meant
      // to take, the markings it crossed and the rules in force, none of which
      // a reconstructed scene establishes. So this emits `lane-transition`
      // information and never an infraction; lane-departure stays unavailable
      // until a scene declares that authority. Penalising a legitimate lane
      // change would fail a stock replay for driving the way the human drove.
      const pose = step.ex ?? null;
      const binding = pose ? bindLane(laneContext, pose.x, pose.y) : null;
      if (!binding) {
        laneSamplesUnavailable += 1;
      } else if (binding.kind === 'contained') {
        laneSamplesBound += 1;
        const offset = binding.lateralOffsetM ?? 0;
        worstLaneOffsetM = Math.max(worstLaneOffsetM ?? 0, Math.abs(offset));
        undecidedRun = 0;
      } else {
        // `ambiguous`, `outside` and `out-of-support` are all undecided at this
        // layer; the transition pass below says which.
        laneSamplesUnavailable += 1;
        undecidedRun += dtS;
        if (undecidedRun > cfg.laneChangeMaxS && !undecidedReported) {
          undecidedReported = true;
          push('lane-transition', step, 'info', {
            reason: 'undecided_run_exceeded',
            seconds: Number(undecidedRun.toFixed(3)),
            kind: binding.kind,
            candidateLaneIds: [...binding.candidateLaneIds],
          });
        }
      }
    } else if (!laneDepartureActive && Math.abs(latOff) > cfg.offRoadLateralM) {
      laneDepartureActive = true;
      push(centrelineType, step, 'infraction', { lateralOffsetM: latOff });
    } else if (laneDepartureActive && Math.abs(latOff) <= cfg.offRoadLateralM - cfg.offRoadClearM) {
      laneDepartureActive = false;
    }

    // v2 off-road: did the FOOTPRINT leave the drivable surface. A decision
    // whose containment cannot be decided leaves the metric unavailable rather
    // than contributing a pass.
    if (containmentEnabled) {
      const pose = step.ex ?? null;
      // Time support is this layer's check, not the geometry's: the decision
      // clock lives here. Static geometry (timeSupportUs null) applies to the
      // whole clip, which is what ClipGT lane geometry is.
      const tUs =
        ctx.originUs != null && Number.isFinite(step.t) ? Math.round(ctx.originUs + step.t * 1e6) : null;
      const outsideSupport =
        drivableArea?.timeSupportUs != null &&
        tUs != null &&
        (tUs < drivableArea.timeSupportUs.startUs || tUs > drivableArea.timeSupportUs.endUs);
      if (!drivableArea || !pose || outsideSupport) {
        containmentUnavailableSamples += 1;
      } else {
        // The replay-context module owns this geometry and its verdicts,
        // including that unavailability WINS over off-road: a corner past the
        // labelled extent makes the sample unknown, because a kerb strike and
        // the end of annotation are indistinguishable there.
        const containment = footprintContainment(drivableArea, {
          x: pose.x,
          y: pose.y,
          headingRad: pose.headingRad,
          lengthM: egoDims.lengthM,
          widthM: egoDims.widthM,
        });
        if (containment.unavailable) {
          containmentUnavailableSamples += 1;
        } else {
          containmentAssessed += 1;
          // Assessed-and-clean is 0, not null: null means the question was
          // never asked, and a consumer must be able to tell those apart.
          worstOffRoadM = Math.max(worstOffRoadM ?? 0, containment.worstOutsideM);
          if (!offRoadActive && !containment.inside) {
            offRoadActive = true;
            push('off-road', step, 'infraction', {
              cornersOutside: containment.cornersOutside,
              worstOutsideM: containment.worstOutsideM,
            });
          } else if (offRoadActive && containment.inside) {
            // No hysteresis band: containment is a geometric fact, not a
            // thresholded proxy, so re-entry is re-entry.
            offRoadActive = false;
          }
        }
      }
    }

    // Wrong-way: accumulate reverse route-arc progress while moving.
    if (routeS !== null && prevS !== null) {
      const ds = routeS - prevS;
      if (ds < 0 && speed > cfg.wrongWayMinSpeedMps) {
        reverseAccumM += -ds;
        if (!wrongWayActive && reverseAccumM >= cfg.wrongWayReverseM) {
          wrongWayActive = true;
          push('wrong-way', step, 'infraction', { reverseM: reverseAccumM });
        }
      } else if (ds > 0) {
        reverseAccumM = 0;
        wrongWayActive = false;
      }
    }
    if (routeS !== null) {
      prevS = routeS;
      lastS = routeS;
    }

    // Stuck: continuous stopped time, one event per stuck period. Duration
    // is steps × dt (one multiply), never a float accumulator, so the >=
    // boundary is exact at every decision rate that divides the engine tick.
    if (speed < cfg.stuckSpeedMps) {
      stoppedSteps += 1;
      if (!stuckActive && stoppedSteps * dtS >= cfg.stuckTimeoutS) {
        stuckActive = true;
        push('stuck', step, 'infraction', { stoppedS: stoppedSteps * dtS });
      }
    } else {
      stoppedSteps = 0;
      stuckActive = false;
    }

    // Speeding vs the authored limit, sustained (steps × dt, as above).
    if (ctx.speedLimitMps != null && ctx.speedLimitMps > 0) {
      const bound = ctx.speedLimitMps * (1 + cfg.speedingToleranceFrac);
      if (speed > bound) {
        overSpeedSteps += 1;
        if (!speedingActive && overSpeedSteps * dtS >= cfg.speedingMinDurationS) {
          speedingActive = true;
          push('speeding', step, 'infraction', { speedMps: speed, limitMps: ctx.speedLimitMps });
        }
      } else {
        overSpeedSteps = 0;
        speedingActive = false;
      }
    }

    // Red light: stop-line crossing (dist goes positive → non-positive) on red.
    const sig = step.sig ?? null;
    if (sig && prevSig && prevSig.state === 'red' && prevSig.distM > 0 && sig.distM <= 0) {
      push('red-light', step, 'infraction', { crossedAtDistM: sig.distM });
    }
    prevSig = sig;

    // TTC minima over closing perceived objects.
    const ttc = stepMinTtcS(step.objs);
    if (ttc !== null) {
      if (minTtcS === null || ttc < minTtcS) minTtcS = ttc;
      if (ttc < cfg.ttcCriticalS) {
        if (!ttcCriticalActive) {
          ttcCriticalActive = true;
          push('ttc-critical', step, 'warning', { ttcS: ttc });
        }
      } else {
        ttcCriticalActive = false;
      }
    } else {
      ttcCriticalActive = false;
    }

    // Comfort: accel and jerk bounds (decision-rate finite difference).
    const absAccel = Math.abs(accel);
    if (absAccel > maxAbsAccel) maxAbsAccel = absAccel;
    if (absAccel > cfg.comfortMaxAccelMps2) {
      accelViolations += 1;
      if (!accelActive) {
        accelActive = true;
        push('accel-bound', step, 'warning', { accelMps2: accel });
      }
    } else {
      accelActive = false;
    }
    if (prevAccel !== null) {
      const jerk = (accel - prevAccel) * ctx.decisionHz;
      const absJerk = Math.abs(jerk);
      if (absJerk > maxAbsJerk) maxAbsJerk = absJerk;
      if (absJerk > cfg.comfortMaxJerkMps3) {
        jerkViolations += 1;
        if (!jerkActive) {
          jerkActive = true;
          push('jerk-bound', step, 'warning', { jerkMps3: jerk });
        }
      } else {
        jerkActive = false;
      }
    }
    prevAccel = accel;

    // Terminal classification (shared rule with the eval server).
    if (step.term === 1) {
      const view = rewardViewFromStep(step);
      if (collisionFromReward(view)) {
        terminalCollision = true;
        const partner = step.objs[0] ?? null;
        const kind = step.collision?.partnerKind ?? (partner ? ctx.actorKinds?.[partner[0]] : undefined);
        push(collisionTypeForKind(kind), step, 'infraction', {
          partnerId: step.collision?.partnerId ?? partner?.[0] ?? null,
          partnerKind: kind ?? null,
          penalty: view.rewardTerms.collision ?? null,
        });
      }
      if (goalFromReward(view)) {
        terminalGoal = true;
        push('goal-reached', step, 'info', { bonus: view.rewardTerms.goal ?? null });
      }
    }
    if (step.trunc === 1) truncated = true;
  }

  // Route completion.
  let routeCompletion: number;
  if (terminalGoal) {
    routeCompletion = 1;
  } else if (ctx.expectedRouteM != null && ctx.expectedRouteM > 0 && s0 !== null && lastS !== null) {
    routeCompletion = Math.min(1, Math.max(0, (lastS - s0) / ctx.expectedRouteM));
  } else {
    routeCompletion = 1; // unassessed
  }

  let penaltyProduct = 1;
  for (const type of INFRACTION_TYPES) {
    const n = counts[type];
    if (n > 0) penaltyProduct *= penaltyFor(type, cfg.penalties) ** n;
  }

  // An episode where NOTHING could be assessed for containment has no off-road
  // answer at all; one partly assessed keeps the events it did find and still
  // declares the gap.
  // Unavailability is PER SAMPLE. A single undecidable decision - a corner past
  // the labelled extent - does not discard an otherwise assessed episode; only
  // an episode with nothing assessable has no off-road answer at all.
  if (containmentEnabled && containmentAssessed === 0) unavailable.add('off-road');
  // Rail-bound lane-departure has the same rule as containment: nothing bound
  // means no answer, some bound means an answer plus its gaps.
  // Transitions come from the lane module's own detector, which distinguishes a
  // real lateral move from a SEGMENT ADVANCE: ClipGT tiles a lane into ~38 m
  // pieces, so a bound-id change every few seconds is what driving straight
  // looks like. Counting id changes reported 17 lane changes on a drive with
  // one, and coverage alone reported zero, because this drive's change lands
  // exactly where a segment ends - it needs both tests, which is why this calls
  // the module rather than repeating either.
  if (laneContext) {
    const poses = trace.steps.flatMap((step) => (step.ex ? [{ x: step.ex.x, y: step.ex.y }] : []));
    for (const transition of detectLaneTransitions(laneContext, poses)) {
      if (transition.kind === 'lane-transition') laneTransitions += 1;
      const step = trace.steps[transition.atIndex];
      if (!step) continue;
      push('lane-transition', step, 'info', {
        kind: transition.kind,
        fromLaneId: transition.fromLaneId,
        toLaneId: transition.toLaneId,
      });
    }
  }

  // Rail binding tells you WHERE the vehicle was, not whether it was allowed to
  // be there. Availability of the geometry is scoped to validated support and
  // its hash; it is not a certification of legality, so lane-departure remains
  // unavailable under a rail binding alone.
  if (laneContext) unavailable.add('lane-departure');
  let namedScore: AlpasimStyleScore | undefined;
  if (ctx.alpasimStyle) {
    let maxLateralM: number | null = null;
    let corridorComplete = trace.steps.length > 0;
    let collisionAtFault: boolean | null = false;
    for (const step of trace.steps) {
      const x = step.ex?.x ?? step.sv?.[0], y = step.ex?.y ?? step.sv?.[1];
      const lateral = x !== undefined && y !== undefined ? authoredRouteLateralM(ctx.alpasimStyle.authoredRoute, x, y) : null;
      if (lateral === null) corridorComplete = false;
      else maxLateralM = Math.max(maxLateralM ?? 0, lateral);
      if (collisionFromReward(rewardViewFromStep(step))) {
        const contacts = ctx.alpasimStyle.egoId
          ? step.events?.filter((event) => event.kind === 'collision' && (event.a === ctx.alpasimStyle!.egoId || event.b === ctx.alpasimStyle!.egoId))
          : undefined;
        const sides = contacts?.length
          ? contacts.map((event) => event.contactSides?.[event.a === ctx.alpasimStyle!.egoId ? 0 : 1])
          : step.collision?.side ? [step.collision.side] : ctx.alpasimStyle.collisionSides?.[step.step];
        if (sides?.some((side) => side === 'front' || side === 'lateral')) collisionAtFault = true;
        else if ((!sides?.length || sides.some((side) => side !== 'rear')) && collisionAtFault !== true) collisionAtFault = null;
      }
    }
    const offroad = containmentEnabled && drivableArea?.confidence === 'authoritative'
      ? counts['off-road'] > 0 ? true : containmentAssessed === trace.steps.length && trace.steps.length > 0 && !unavailable.has('off-road') ? false : null
      : null;
    namedScore = alpasimStyleScore({
      progress: terminalGoal || (ctx.expectedRouteM != null && ctx.expectedRouteM > 0 && s0 !== null && lastS !== null) ? routeCompletion : null,
      collisionAtFault, offroad,
      maxLateralM: corridorComplete || (maxLateralM !== null && maxLateralM >= 4) ? maxLateralM : null,
    });
  }

  return {
    drivingScore: routeCompletion * penaltyProduct,
    ...(namedScore ? { 'alpasim-style-score': namedScore } : {}),
    routeCompletion,
    penaltyProduct,
    infractions: counts,
    ttc: { minTtcS, criticalCount: events.filter((e) => e.type === 'ttc-critical').length },
    comfort: {
      maxAbsAccelMps2: maxAbsAccel,
      maxAbsJerkMps3: maxAbsJerk,
      accelViolations,
      jerkViolations,
    },
    terminal: { collision: terminalCollision, goal: terminalGoal, truncated },
    steps: trace.steps.length,
    deadlineMisses,
    events,
    metricVersion,
    unavailable: [...unavailable].sort(),
    worstOffRoadM,
    laneDeparture: laneContext
      ? {
          bound: laneSamplesBound,
          unavailableSamples: laneSamplesUnavailable,
          worstOffsetM: worstLaneOffsetM,
          transitions: laneTransitions,
        }
      : null,
    offRoad: containmentEnabled
      ? {
          offered: trace.steps.length,
          assessed: containmentAssessed,
          unavailableSamples: containmentUnavailableSamples,
        }
      : null,
  };
}
