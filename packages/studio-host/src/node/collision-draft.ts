/**
 * Generated collision drafts: the native acceptance run both Studio hosts and
 * the autogen service share.
 *
 * A collision generator (the AI-search builder, the batch generator, their
 * planning probes) emits `ScenarioEditorActorDraft` actors: spawn point,
 * blueprint, timed waypoints in xodr-local metres. Nothing executes that
 * shape. What executes — in the editor, the compiler worker and the renderer —
 * is a map-bound `ScenarioTemplateV2` whose `scene_absolute` roles carry exact
 * `customTimedRoute`s, materialised by the native compiler and stepped by the
 * native engine. The draft is lowered to that template once
 * (`collision-draft-lowering.ts`), and the acceptance verdict is read off a
 * real native run of the very document the host persists:
 * `resolveExecutionInput` (the compiler worker's own path) then
 * `runSimulation` over the map's lane graph. Motion, contact, dimensions,
 * actor rules and timing semantics are the runtime's; this module only runs
 * and reads the trace.
 */

import { resolveExecutionInput } from "@simforge-oss/compiler/node";
import type { SimIssue, SimScenarioInput, SimTrace } from "@simforge-oss/engine";
import { runSimulation } from "@simforge-oss/engine/node";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";

import type {
  CollisionDraftActor,
  CollisionDraftMapBinding,
  CollisionDraftPoint,
  CollisionDraftTimedPoint,
  LoweredCollisionDraft,
} from "./collision-draft-lowering";

/** Engine marker every report carries: the native runtime executed the candidate. */
export const COLLISION_DRAFT_VALIDATION_ENGINE = "simforge-native" as const;

// ── Draft geometry ──────────────────────────────────────────────────────────

function spawnPointOf(actor: CollisionDraftActor): CollisionDraftPoint | null {
  if (actor.spawn_point) return { x: actor.spawn_point.x, y: actor.spawn_point.y };
  const timed = actor.timed_waypoints?.[0];
  if (timed) return { x: timed.x, y: timed.y };
  const path = actor.path_placement?.[0];
  if (path) return { x: path.x, y: path.y };
  return null;
}

/** Timed waypoints in time order, with the spawn as the `t = 0` keyframe unless the first waypoint already is it. */
function timedRouteOf(actor: CollisionDraftActor): CollisionDraftTimedPoint[] {
  const timed = [...(actor.timed_waypoints ?? [])].sort((a, b) => a.time - b.time);
  if (!actor.spawn_point) return timed.map((p) => ({ x: p.x, y: p.y, time: p.time }));
  const spawn = { x: actor.spawn_point.x, y: actor.spawn_point.y, time: 0 };
  const first = timed[0];
  if (first && first.x === spawn.x && first.y === spawn.y && first.time <= 1e-9) {
    return timed.map((p) => ({ x: p.x, y: p.y, time: p.time }));
  }
  return [spawn, ...timed.map((p) => ({ x: p.x, y: p.y, time: p.time }))];
}

function pathRouteOf(actor: CollisionDraftActor): CollisionDraftPoint[] {
  const points: CollisionDraftPoint[] = [];
  const push = (p: CollisionDraftPoint | null | undefined) => {
    if (!p) return;
    const last = points[points.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) points.push({ x: p.x, y: p.y });
  };
  push(actor.spawn_point);
  for (const p of actor.path_placement ?? []) push(p);
  push(actor.destination_point);
  return points;
}

type DraftRoute =
  | { kind: "timed"; points: CollisionDraftTimedPoint[] }
  | { kind: "path"; points: CollisionDraftPoint[] }
  | { kind: "none" };

function draftRouteOf(actor: CollisionDraftActor): DraftRoute {
  if (actor.is_static === true || actor.kind === "prop") return { kind: "none" };
  if (actor.placement_mode === "timed_path" && actor.timed_waypoints?.length) {
    return { kind: "timed", points: timedRouteOf(actor) };
  }
  if (actor.placement_mode === "path") {
    const points = pathRouteOf(actor);
    if (points.length >= 2) return { kind: "path", points };
  }
  return { kind: "none" };
}

function polylineArcLengthM(points: readonly CollisionDraftPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}


// ── Validation report (mirrors both hosts' ScenarioValidationReport) ───────

/**
 * The authored outcome a candidate is judged against — the scenario
 * intention's `outcome`. Planning probes always request `collision` (they
 * prove the conflict geometry converges); the assembled candidate is judged
 * against the outcome the generator authored for it.
 */
export type CollisionDraftOutcome = "collision" | "collision_avoidance" | "near_miss" | "nominal";

export type CollisionDraftCheckId =
  /** `collision`: the intended pair made the planned contact. */
  | "collision_occurred"
  | "collision_in_region"
  | "collision_timing"
  /** Non-contact outcomes: the subject touched nothing. */
  | "contact_absent"
  /** `collision_avoidance` / `near_miss`: the runtime scored a real conflict between the intended pair. */
  | "conflict_approached"
  | "conflict_in_region"
  | "conflict_timing"
  | "subject_spawn_offset"
  | "target_spawn_offset"
  | "route_resolvable"
  | "maneuver_executed"
  | "kinematic_lint";

export interface CollisionDraftCheck {
  id: CollisionDraftCheckId;
  kind?: "kinematic_lint";
  status: "pass" | "fail" | "warn";
  label: string;
  detail: string;
  measuredValue: number | null;
  threshold: number | null;
}

export interface CollisionDraftActorDiagnostic {
  actorId: string;
  label: string;
  role: string;
  spawnPoint: CollisionDraftPoint | null;
  pathArcLengthM: number;
  expectedSpeedKph: number;
  spawnOffsetM: number | null;
  reachedConflict: boolean;
  timeToConflictS: number | null;
}

export interface CollisionDraftValidationReport<F extends string = string> {
  schemaVersion: 1;
  engine: typeof COLLISION_DRAFT_VALIDATION_ENGINE;
  verdict: "pass" | "fail";
  family: F;
  /** The authored outcome the verdict judged. */
  outcome: CollisionDraftOutcome;
  generatedAt: string;
  simulatedDurationS: number;
  fixedDeltaS: number;
  intendedPair: { subjectActorId: string; targetActorId: string };
  intendedLocation: CollisionDraftPoint | null;
  regionRadiusM: number;
  collision: {
    occurred: boolean;
    timeS: number | null;
    point: CollisionDraftPoint | null;
    closingSpeedKph: number | null;
    actorAId: string | null;
    actorBId: string | null;
  };
  minPairwiseDistanceM: number;
  checks: CollisionDraftCheck[];
  actorDiagnostics: CollisionDraftActorDiagnostic[];
  reasons: string[];
  repair: { attempted: boolean; attempts: number; succeeded: boolean; strategies: string[] } | null;
}

export interface CollisionConflictHint {
  /** Planned conflict point (planner output), xodr-local metres. */
  conflictPoint: CollisionDraftPoint;
  /** Planned time-of-impact, seconds since scenario start. */
  arrivalTimeS: number;
  /**
   * Authoritative turn relation of the subject's planned gate (Tier-0 plans),
   * from `topology.gates[].turnRelation`. `maneuver_executed` consults this
   * instead of inferring the turn from waypoint headings. Null on Tier-1 plans.
   */
  subjectTurnRelation?: "Left" | "Right" | "Straight" | "UTurnLeft" | "UTurnRight" | null;
  /** Absolute accept window (seconds); replaces the relative tolerance when present. */
  acceptWindowS?: { min: number; max: number };
}

/** One native-produced pose sample; `x`/`y` xodr-local, `yaw` radians. */
export interface CollisionDraftFrame {
  timestamp: number;
  actors: Array<{ id: string; x: number; y: number; yaw: number; speed: number }>;
}

export interface CollisionDraftLintViolation {
  actorId: string;
  kind: string;
  peakValue: number;
  threshold: number;
  severity: "violation" | "warning";
}

/** The host's plausibility lint over native frames (its thresholds live beside its shared contracts). */
export type CollisionDraftLint = (
  frames: CollisionDraftFrame[],
  actorKinds: Record<string, "vehicle" | "walker">,
) => { violations: readonly CollisionDraftLintViolation[] };

export interface ValidateCollisionDraftArgs<F extends string> {
  family: F;
  /** The authored outcome to judge (`ScenarioIntention.outcome`); planning probes request `collision`. */
  outcome: CollisionDraftOutcome;
  actors: readonly CollisionDraftActor[];
  /** The planned subject (sensor-carrying principal); `null` when the draft has none. */
  subjectActorId: string | null;
  map: CollisionDraftMapBinding;
  /**
   * The lowered authored candidate to execute — exactly what the host persists,
   * from `lowerCollisionDraftCandidate` over the same `actors`.
   */
  lowered: LoweredCollisionDraft;
  /** Intended scenario location, xodr-local metres; falls back to the conflict hint. */
  intendedLocation: CollisionDraftPoint | null;
  /** Planner output. Null when the builder fell back to heuristic placement. */
  conflict: CollisionConflictHint | null;
  durationS: number;
  lint: CollisionDraftLint;
  /** Wall clock; defaults to `new Date()`. */
  now?: () => Date;
}

// ── Tolerances ──────────────────────────────────────────────────────────────

/** A collision must land within this radius of the intended location. */
const REGION_RADIUS_M = 35;
/** Allowed slack between observed contact time and planned arrival time. */
const TIMING_TOLERANCE_S = 3;
/** A contact before this is a spawn overlap, not a planned collision. */
const MIN_COLLISION_TIME_S = 2;
/** A contact further than this from the planned time-of-impact is not the planned collision. */
const COLLISION_ARRIVAL_TOL_S = 4;
/** Beyond this, an actor's spawn-to-location distance is flagged (warn only). */
const SPAWN_OFFSET_WARN_M = 220;
/** A resolvable route needs at least this much arc length. */
const MIN_ROUTE_ARC_M = 2;
/** Minimum net subject heading change for a turn family to count as a turn (~60°). */
const MANEUVER_MIN_TURN_RAD = Math.PI / 3;
/**
 * A non-contact outcome's conflict evidence: the runtime's footprint gap
 * between the intended pair closed to this (a near miss must; an avoidance
 * may instead show a TTC sample at or under `CONFLICT_TTC_S`). Mirrors the
 * native session's conflict-genesis thresholds.
 */
const CONFLICT_CLEARANCE_M = 5;
const CONFLICT_TTC_S = 3;

/**
 * Classify a contact time: windowed (`acceptWindowS`) accepts `min ≤ t ≤ max`;
 * otherwise a contact before `MIN_COLLISION_TIME_S` is a spawn overlap and one
 * more than `COLLISION_ARRIVAL_TOL_S` off the planned arrival is mistimed.
 */
export function classifyContactTime(
  contactS: number,
  opts: { acceptWindowS?: { min: number; max: number } | null; plannedArrivalS?: number | null },
): "ok" | "too_early" | "mistimed" {
  const { acceptWindowS = null, plannedArrivalS = null } = opts;
  if (acceptWindowS) {
    if (contactS < acceptWindowS.min) return "too_early";
    if (contactS > acceptWindowS.max) return "mistimed";
    return "ok";
  }
  if (contactS < MIN_COLLISION_TIME_S) return "too_early";
  if (plannedArrivalS != null && Math.abs(contactS - plannedArrivalS) > COLLISION_ARRIVAL_TOL_S) return "mistimed";
  return "ok";
}

// ── Native run ──────────────────────────────────────────────────────────────

interface NativeContact {
  timeS: number;
  point: CollisionDraftPoint;
  closingSpeedMps: number;
}

/** The runtime's closest footprint approach of the intended pair (`metrics.minDistance`). */
interface NativeApproach {
  timeS: number;
  gapM: number;
  /** Midpoint of the pair's poses at `timeS`. */
  point: CollisionDraftPoint;
}

interface NativeRun {
  input: SimScenarioInput;
  trace: SimTrace;
  issues: SimIssue[];
}

function distance(a: CollisionDraftPoint, b: CollisionDraftPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function samePair(pair: readonly [string, string], a: string, b: string): boolean {
  return (pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a);
}

/** Index of the last recorded tick at or before `t` (ticks are monotonic). */
function tickIndexAt(t: number, ticks: readonly number[]): number {
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (ticks[mid]! <= t + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Midpoint of the two roles' poses at the tick at or before `t`; null when either track is absent. */
function pairMidpointAt(trace: SimTrace, roleA: string, roleB: string, t: number): CollisionDraftPoint | null {
  const a = trace.ticks.actors[roleA];
  const b = trace.ticks.actors[roleB];
  if (!a || !b) return null;
  const i = tickIndexAt(t, trace.ticks.t);
  return { x: (a.x[i]! + b.x[i]!) / 2, y: (a.y[i]! + b.y[i]!) / 2 };
}

/** The first native contact between the two roles, with the pose-derived contact point and closing rate. */
function firstContact(trace: SimTrace, roleA: string, roleB: string): NativeContact | null {
  let first: { t: number } | null = null;
  for (const c of trace.metrics.collisions) {
    if (!samePair([c.a, c.b], roleA, roleB)) continue;
    if (!first || c.t < first.t) first = c;
  }
  if (!first) return null;
  const a = trace.ticks.actors[roleA];
  const b = trace.ticks.actors[roleB];
  if (!a || !b) return null;
  const i = tickIndexAt(first.t, trace.ticks.t);
  const pa = { x: a.x[i]!, y: a.y[i]! };
  const pb = { x: b.x[i]!, y: b.y[i]! };
  const va = { x: Math.cos(a.headingRad[i]!) * a.speedMps[i]!, y: Math.sin(a.headingRad[i]!) * a.speedMps[i]! };
  const vb = { x: Math.cos(b.headingRad[i]!) * b.speedMps[i]!, y: Math.sin(b.headingRad[i]!) * b.speedMps[i]! };
  const sep = { x: pb.x - pa.x, y: pb.y - pa.y };
  const sepLen = Math.hypot(sep.x, sep.y) || 1;
  const closing = ((va.x - vb.x) * sep.x + (va.y - vb.y) * sep.y) / sepLen;
  return {
    timeS: first.t,
    point: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 },
    closingSpeedMps: Math.max(0, closing),
  };
}

/** The first native contact involving `role` with any other actor. */
function firstContactOf(trace: SimTrace, role: string): { t: number; other: string } | null {
  let first: { t: number; other: string } | null = null;
  for (const c of trace.metrics.collisions) {
    if (c.a !== role && c.b !== role) continue;
    if (!first || c.t < first.t) first = { t: c.t, other: c.a === role ? c.b : c.a };
  }
  return first;
}

/** The runtime's closest approach of the pair; null when it did not score the pair. */
function closestApproach(trace: SimTrace, roleA: string, roleB: string): NativeApproach | null {
  const entry = trace.metrics.minDistance.find((row) => samePair(row.pair, roleA, roleB));
  if (!entry || !Number.isFinite(entry.minDistanceM)) return null;
  const point = pairMidpointAt(trace, roleA, roleB, entry.t);
  return point ? { timeS: entry.t, gapM: entry.minDistanceM, point } : null;
}

/**
 * The pair's smallest native TTC (plain or crossing-route) sampled at or after
 * `fromS`; null when the runtime recorded no finite sample for the pair.
 */
function minPairTtc(trace: SimTrace, roleA: string, roleB: string, fromS: number): { value: number; t: number } | null {
  const samples = trace.metrics.criticalitySamples;
  if (!samples) return null;
  let best: { value: number; t: number } | null = null;
  for (const series of [...samples.ttc, ...samples.pathTTC]) {
    if (!samePair(series.pair, roleA, roleB)) continue;
    for (let i = 0; i < series.t.length; i++) {
      const t = series.t[i]!;
      const value = series.value[i]!;
      if (t < fromS || !Number.isFinite(value)) continue;
      if (!best || value < best.value) best = { value, t };
    }
  }
  return best;
}

/** Native pose samples as lint frames, keyed by draft actor id, over `t ≤ endS`. */
function framesFromTrace(
  trace: SimTrace,
  actorIdByRole: ReadonlyMap<string, string>,
  endS: number,
): CollisionDraftFrame[] {
  const frames: CollisionDraftFrame[] = [];
  const roles = Object.keys(trace.ticks.actors);
  for (let i = 0; i < trace.ticks.t.length; i++) {
    const t = trace.ticks.t[i]!;
    if (t > endS + 1e-9) break;
    const actors: CollisionDraftFrame["actors"] = [];
    for (const role of roles) {
      const id = actorIdByRole.get(role);
      const track = trace.ticks.actors[role]!;
      if (!id || track.present[i] !== 1) continue;
      actors.push({ id, x: track.x[i]!, y: track.y[i]!, yaw: track.headingRad[i]!, speed: track.speedMps[i]! });
    }
    frames.push({ timestamp: t, actors });
  }
  return frames;
}

function runNatively(template: ScenarioTemplateV2, map: CollisionDraftMapBinding): NativeRun | { failure: string } {
  try {
    const resolved = resolveExecutionInput(template, map.bundle, "disabled");
    const result = runSimulation(resolved.resolvedInput, { graph: map.bundle.graph });
    return { input: result.input, trace: result.trace, issues: result.issues };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

// ── Report assembly ─────────────────────────────────────────────────────────

function resolveIntendedPair(
  actors: readonly CollisionDraftActor[],
  subjectActorId: string | null,
): { subject: CollisionDraftActor; target: CollisionDraftActor } | null {
  const subject = subjectActorId ? actors.find((a) => a.id === subjectActorId) : undefined;
  if (!subject) return null;
  // The conflicting principal: a pedestrian first, then the first non-subject
  // traffic/pedestrian actor the builder placed, then anything else.
  const target =
    actors.find((a) => a.role === "pedestrian" && a.id !== subject.id) ??
    actors.find((a) => a.id !== subject.id && (a.role === "traffic" || a.role === "pedestrian")) ??
    actors.find((a) => a.id !== subject.id);
  return target ? { subject, target } : null;
}

function declaredViolating(actor: CollisionDraftActor | undefined): boolean {
  const metadata = actor?.behaviorMetadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  const behaviorClass = (metadata as Record<string, unknown>).behavior_class;
  if (typeof behaviorClass !== "string") return false;
  const normalized = behaviorClass.trim().toLowerCase();
  return normalized === "violating" || normalized === "adversarial";
}

function lintUnit(kind: string): string {
  switch (kind) {
    case "longitudinal_acceleration":
    case "longitudinal_deceleration":
    case "lateral_acceleration":
    case "speed_discontinuity":
      return "m/s²";
    case "longitudinal_jerk":
      return "m/s³";
    case "speed":
      return "m/s";
    case "position_discontinuity":
      return "m";
    case "heading_discontinuity":
      return "rad";
    default:
      return "";
  }
}

const TURN_FAMILIES: Readonly<Record<string, "Left" | "Right">> = {
  unprotected_left_turn: "Left",
  right_turn_hook: "Right",
};

/**
 * Accept or reject a generated draft by executing its authored candidate
 * natively and judging the runtime's contacts, closest approach, TTC samples
 * and pose samples against the authored `outcome`:
 *
 *   - `collision`: the intended pair makes the planned contact — timed off the
 *     planned arrival (spawn overlaps rejected), near the intended location.
 *   - `collision_avoidance`: the subject touches nothing, and the pair's
 *     native evidence shows a real conflict (closest approach within
 *     `CONFLICT_CLEARANCE_M`, or a TTC within `CONFLICT_TTC_S`) near the
 *     intended location.
 *   - `near_miss`: the subject touches nothing, and the pair's closest
 *     approach itself is within `CONFLICT_CLEARANCE_M` near the location.
 *   - `nominal`: the subject touches nothing; no conflict is required.
 *
 * Route, maneuver and kinematic gates apply to every outcome. Synchronous:
 * the native runtime is.
 */
export function validateCollisionDraft<F extends string>(
  args: ValidateCollisionDraftArgs<F>,
): CollisionDraftValidationReport<F> {
  if (
    args.outcome !== "collision" && args.outcome !== "collision_avoidance"
    && args.outcome !== "near_miss" && args.outcome !== "nominal"
  ) {
    throw new TypeError("Native draft acceptance requires an explicit authored outcome");
  }
  const now = (args.now ?? (() => new Date()))().toISOString();
  const pair = resolveIntendedPair(args.actors, args.subjectActorId);
  const intendedLocation = args.intendedLocation ?? args.conflict?.conflictPoint ?? null;

  const baseReport: CollisionDraftValidationReport<F> = {
    schemaVersion: 1,
    engine: COLLISION_DRAFT_VALIDATION_ENGINE,
    verdict: "fail",
    family: args.family,
    outcome: args.outcome,
    generatedAt: now,
    simulatedDurationS: args.durationS,
    fixedDeltaS: 0,
    intendedPair: { subjectActorId: pair?.subject.id ?? "", targetActorId: pair?.target.id ?? "" },
    intendedLocation,
    regionRadiusM: REGION_RADIUS_M,
    collision: { occurred: false, timeS: null, point: null, closingSpeedKph: null, actorAId: null, actorBId: null },
    minPairwiseDistanceM: Infinity,
    checks: [],
    actorDiagnostics: [],
    reasons: [],
    repair: null,
  };

  if (!pair) {
    return {
      ...baseReport,
      reasons: ["intended_pair_unresolved: draft has no subject + conflicting actor to evaluate"],
      checks: [{
        id: "route_resolvable",
        status: "fail",
        label: "Actors",
        detail: "Could not identify a sensor-carrying subject and a conflicting actor in the draft.",
        measuredValue: null,
        threshold: null,
      }],
    };
  }

  const { template, roleIdByActorId } = args.lowered;
  const actorIdByRole = new Map([...roleIdByActorId].map(([actorId, roleId]) => [roleId, actorId] as const));

  const checks: CollisionDraftCheck[] = [];
  const reasons: string[] = [];
  const principals = [pair.subject, pair.target];
  const routeByActor = new Map(args.actors.map((actor) => [actor.id, draftRouteOf(actor)] as const));
  const arcByActor = new Map(
    args.actors.map((actor) => {
      const route = routeByActor.get(actor.id)!;
      return [actor.id, polylineArcLengthM(route.kind === "none" ? [] : route.points)] as const;
    }),
  );

  // route_resolvable — every principal needs an authored trajectory the runtime can execute.
  const unresolved = principals.filter((a) => {
    const route = routeByActor.get(a.id)!;
    if (route.kind === "none") return true;
    if (route.kind === "timed") return route.points.length < 2;
    return (arcByActor.get(a.id) ?? 0) < MIN_ROUTE_ARC_M;
  });
  const run = runNatively(template, args.map);
  const executionErrors = "failure" in run
    ? [run.failure]
    : run.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.code} at ${issue.path}: ${issue.reason}`);
  if (unresolved.length === 0 && executionErrors.length === 0) {
    checks.push({
      id: "route_resolvable",
      status: "pass",
      label: "Routes",
      detail: "Every principal actor has an authored trajectory the native runtime executed.",
      measuredValue: null,
      threshold: MIN_ROUTE_ARC_M,
    });
  } else {
    const who = unresolved.map((a) => a.label).join(", ");
    const detail = unresolved.length > 0
      ? `No authored trajectory for: ${who}. Builder likely fell back to heuristic placement.`
      : `The native runtime rejected the candidate: ${executionErrors.join("; ")}`;
    checks.push({ id: "route_resolvable", status: "fail", label: "Routes", detail, measuredValue: null, threshold: MIN_ROUTE_ARC_M });
    reasons.push(
      unresolved.length > 0
        ? `route_resolvable: ${who} has no planned path — the planner returned null and the draft used heuristic placement.`
        : `route_resolvable: native execution rejected the candidate — ${executionErrors.join("; ")}`,
    );
  }

  const spawnOffsetChecks = () => {
    const entries: Array<["subject_spawn_offset" | "target_spawn_offset", CollisionDraftActor]> = [
      ["subject_spawn_offset", pair.subject],
      ["target_spawn_offset", pair.target],
    ];
    for (const [id, actor] of entries) {
      const sp = spawnPointOf(actor);
      if (!sp || !intendedLocation) continue;
      const off = distance(sp, intendedLocation);
      checks.push({
        id,
        status: off <= SPAWN_OFFSET_WARN_M ? "pass" : "warn",
        label: "Spawn",
        detail: `${actor.label} spawns ${off.toFixed(0)} m from the specified location.`,
        measuredValue: off,
        threshold: SPAWN_OFFSET_WARN_M,
      });
    }
  };

  /** Per-actor view keyed on the observed conflict moment: contact for `collision`, the scored approach otherwise. */
  const diagnostics = (conflictAt: { timeS: number } | null): CollisionDraftActorDiagnostic[] =>
    principals.map((a) => {
      const sp = spawnPointOf(a);
      return {
        actorId: a.id,
        label: a.label,
        role: a.role,
        spawnPoint: sp,
        pathArcLengthM: arcByActor.get(a.id) ?? 0,
        expectedSpeedKph: a.speed_kph ?? 0,
        spawnOffsetM: sp && intendedLocation ? distance(sp, intendedLocation) : null,
        reachedConflict: conflictAt != null,
        timeToConflictS: conflictAt?.timeS ?? null,
      };
    });

  // The outcome's headline check: the one that can only pass on native evidence.
  const headline: { id: CollisionDraftCheckId; label: string } =
    args.outcome === "collision"
      ? { id: "collision_occurred", label: "Collision" }
      : args.outcome === "nominal"
        ? { id: "contact_absent", label: "Contact" }
        : { id: "conflict_approached", label: "Conflict" };

  if ("failure" in run) {
    checks.push({
      id: headline.id,
      status: "fail",
      label: headline.label,
      detail: `${pair.subject.label} and ${pair.target.label} were not executed: ${run.failure}`,
      measuredValue: null,
      threshold: 0,
    });
    reasons.push(`${headline.id}: the native runtime could not execute the candidate — ${run.failure}`);
    spawnOffsetChecks();
    return { ...baseReport, checks, reasons, actorDiagnostics: diagnostics(null) };
  }

  const subjectRole = roleIdByActorId.get(pair.subject.id)!;
  const targetRole = roleIdByActorId.get(pair.target.id)!;
  const rawContact = firstContact(run.trace, subjectRole, targetRole);
  const plannedArrivalS = args.conflict?.arrivalTimeS ?? null;
  const acceptWin = args.conflict?.acceptWindowS ?? null;
  // The runtime's own closest approach for the pair; null when it did not score the pair.
  const approach = closestApproach(run.trace, subjectRole, targetRole);
  const minPairwiseDistanceM = approach?.gapM ?? Infinity;
  const gapStr = approach ? `${approach.gapM.toFixed(1)} m` : "unknown";

  /** The pair contact the report carries (`collision`): the planned one for `collision`, any for the rest. */
  let contact: NativeContact | null = null;
  /** The moment the requested conflict was observed, for timing and diagnostics. */
  let conflictAt: { timeS: number } | null = null;

  if (args.outcome === "collision") {
    // A contact at/near t=0 is a spawn overlap and a contact far from the planned
    // time-of-impact is not the planned collision; neither is a valid generated
    // collision. `contact` is gated on validity so every downstream check treats
    // those as "no collision"; `rawContact` only explains why.
    const contactClass = rawContact ? classifyContactTime(rawContact.timeS, { acceptWindowS: acceptWin, plannedArrivalS }) : "ok";
    const tooEarly = contactClass === "too_early";
    const mistimed = contactClass === "mistimed";
    contact = rawContact && !tooEarly && !mistimed ? rawContact : null;
    conflictAt = contact;

    // collision_occurred — the headline check.
    if (contact) {
      checks.push({
        id: "collision_occurred",
        status: "pass",
        label: "Collision",
        detail: `${pair.subject.label} and ${pair.target.label} make contact at t=${contact.timeS.toFixed(2)}s (closing ${(contact.closingSpeedMps * 3.6).toFixed(1)} kph).`,
        measuredValue: contact.timeS,
        threshold: args.durationS,
      });
    } else {
      let detail: string;
      let reason: string;
      let measured: number | null;
      if (tooEarly && rawContact) {
        if (acceptWin) {
          detail = `${pair.subject.label} and ${pair.target.label} contact at t=${rawContact.timeS.toFixed(2)}s — outside the accepted [${acceptWin.min},${acceptWin.max}]s window (too early).`;
          reason = `collision_occurred: contact at t=${rawContact.timeS.toFixed(2)}s is outside the accepted [${acceptWin.min},${acceptWin.max}]s window (before min ${acceptWin.min}s) — not the planned collision.`;
        } else {
          detail = `${pair.subject.label} and ${pair.target.label} overlap at spawn (t=${rawContact.timeS.toFixed(2)}s) — actors placed on top of each other, not a planned collision.`;
          reason = `collision_occurred: spawn overlap at t=${rawContact.timeS.toFixed(2)}s (< ${MIN_COLLISION_TIME_S}s) — the planner did not give the actors a run-up; this is a start-state overlap, not the requested collision.`;
        }
        measured = rawContact.timeS;
      } else if (mistimed && rawContact) {
        if (acceptWin) {
          detail = `${pair.subject.label} and ${pair.target.label} contact at t=${rawContact.timeS.toFixed(2)}s — outside the accepted [${acceptWin.min},${acceptWin.max}]s window (too late).`;
          reason = `collision_occurred: contact at t=${rawContact.timeS.toFixed(2)}s is outside the accepted [${acceptWin.min},${acceptWin.max}]s window (after max ${acceptWin.max}s) — not the planned collision.`;
        } else {
          detail = `${pair.subject.label} and ${pair.target.label} contact at t=${rawContact.timeS.toFixed(2)}s, far from the planned ${plannedArrivalS?.toFixed(1)}s.`;
          reason = `collision_occurred: contact at t=${rawContact.timeS.toFixed(2)}s is ${Math.abs(rawContact.timeS - (plannedArrivalS ?? 0)).toFixed(1)}s off the planned ${plannedArrivalS?.toFixed(1)}s (tol ${COLLISION_ARRIVAL_TOL_S}s) — not the planned collision.`;
        }
        measured = rawContact.timeS;
      } else {
        detail = `${pair.subject.label} and ${pair.target.label} never make contact (closest approach ${gapStr}).`;
        reason = `collision_occurred: the requested conflict between ${pair.subject.label} and ${pair.target.label} did not happen — they missed by ${gapStr}. Likely a timing or geometry mismatch in the planned routes.`;
        measured = approach?.gapM ?? null;
      }
      checks.push({ id: "collision_occurred", status: "fail", label: "Collision", detail, measuredValue: measured, threshold: 0 });
      reasons.push(reason);
    }

    // collision_in_region — contact must land near the asked-for location.
    if (contact && intendedLocation) {
      const off = distance(contact.point, intendedLocation);
      if (off <= REGION_RADIUS_M) {
        checks.push({
          id: "collision_in_region",
          status: "pass",
          label: "Location",
          detail: `Contact is ${off.toFixed(1)} m from the specified location.`,
          measuredValue: off,
          threshold: REGION_RADIUS_M,
        });
      } else {
        checks.push({
          id: "collision_in_region",
          status: "fail",
          label: "Location",
          detail: `Contact is ${off.toFixed(1)} m from the specified location (max ${REGION_RADIUS_M} m).`,
          measuredValue: off,
          threshold: REGION_RADIUS_M,
        });
        reasons.push(`collision_in_region: the collision happened ${off.toFixed(1)} m away from the location the prompt specified (tolerance ${REGION_RADIUS_M} m).`);
      }
    }

    // collision_timing — observed vs planned time-of-impact (soft when no planner).
    if (contact && args.conflict) {
      const drift = Math.abs(contact.timeS - args.conflict.arrivalTimeS);
      checks.push({
        id: "collision_timing",
        status: drift <= TIMING_TOLERANCE_S ? "pass" : "warn",
        label: "Timing",
        detail: `Contact at t=${contact.timeS.toFixed(2)}s vs planned ${args.conflict.arrivalTimeS.toFixed(2)}s (drift ${drift.toFixed(2)}s).`,
        measuredValue: drift,
        threshold: TIMING_TOLERANCE_S,
      });
    }
  } else {
    // Non-contact outcomes report any pair contact as the collision the
    // candidate must not have produced.
    contact = rawContact;

    // contact_absent — the subject touched nothing, whatever the timing: a
    // spawn overlap, the intended target or a background actor all fail.
    const subjectContact = firstContactOf(run.trace, subjectRole);
    if (subjectContact) {
      const otherId = actorIdByRole.get(subjectContact.other);
      const other = args.actors.find((actor) => actor.id === otherId)?.label ?? subjectContact.other;
      checks.push({
        id: "contact_absent",
        status: "fail",
        label: "Contact",
        detail: `${pair.subject.label} contacts ${other} at t=${subjectContact.t.toFixed(2)}s in a ${args.outcome} scene.`,
        measuredValue: subjectContact.t,
        threshold: 0,
      });
      reasons.push(`contact_absent: ${pair.subject.label} hit ${other} at t=${subjectContact.t.toFixed(2)}s — a ${args.outcome} scene must resolve without subject contact.`);
    } else {
      checks.push({
        id: "contact_absent",
        status: "pass",
        label: "Contact",
        detail: `${pair.subject.label} makes no contact (closest approach to ${pair.target.label} ${gapStr}).`,
        measuredValue: approach?.gapM ?? null,
        threshold: 0,
      });
    }

    // conflict_approached — the runtime must have scored a real conflict
    // between the pair: a footprint gap within CONFLICT_CLEARANCE_M (the near
    // miss itself), or for an avoidance a TTC sample within CONFLICT_TTC_S
    // before the subject's reaction opened the gap. Evidence before the
    // run-up (`MIN_COLLISION_TIME_S` or the window's min) is a spawn
    // placement, not the planned conflict. A nominal scene plans no conflict.
    if (args.outcome !== "nominal") {
      const minStartS = acceptWin?.min ?? MIN_COLLISION_TIME_S;
      const approachOk = approach != null && approach.timeS >= minStartS && approach.gapM <= CONFLICT_CLEARANCE_M;
      const ttc = args.outcome === "collision_avoidance" && approach && !approachOk
        ? minPairTtc(run.trace, subjectRole, targetRole, minStartS)
        : null;
      const ttcOk = ttc != null && ttc.value <= CONFLICT_TTC_S;
      if (approachOk || ttcOk) {
        conflictAt = approachOk ? approach : { timeS: ttc!.t + ttc!.value };
        checks.push({
          id: "conflict_approached",
          status: "pass",
          label: "Conflict",
          detail: approachOk
            ? `${pair.subject.label} and ${pair.target.label} close to ${approach!.gapM.toFixed(2)} m at t=${approach!.timeS.toFixed(2)}s.`
            : `${pair.subject.label} and ${pair.target.label} reach a ${ttc!.value.toFixed(2)} s TTC at t=${ttc!.t.toFixed(2)}s before the gap opens to ${gapStr}.`,
          measuredValue: approach!.gapM,
          threshold: CONFLICT_CLEARANCE_M,
        });
      } else {
        let detail: string;
        let reason: string;
        if (!approach) {
          detail = `The native runtime scored no closest approach between ${pair.subject.label} and ${pair.target.label}.`;
          reason = `conflict_approached: the runtime recorded no closest approach for ${pair.subject.label} and ${pair.target.label} — the pair was never in conflict.`;
        } else if (approach.timeS < minStartS) {
          detail = `${pair.subject.label} and ${pair.target.label} are closest (${gapStr}) at t=${approach.timeS.toFixed(2)}s — a spawn placement, not the planned conflict (run-up ${minStartS}s).`;
          reason = `conflict_approached: closest approach at t=${approach.timeS.toFixed(2)}s (< ${minStartS}s) is a start-state placement, not the requested conflict.`;
        } else if (args.outcome === "near_miss") {
          detail = `${pair.subject.label} and ${pair.target.label} miss by ${gapStr} (max ${CONFLICT_CLEARANCE_M} m for a near miss).`;
          reason = `conflict_approached: the requested near miss between ${pair.subject.label} and ${pair.target.label} did not happen — closest approach ${gapStr} exceeds ${CONFLICT_CLEARANCE_M} m, the actors never really conflicted.`;
        } else {
          const ttcStr = ttc ? `${ttc.value.toFixed(2)} s` : "none";
          detail = `${pair.subject.label} and ${pair.target.label} miss by ${gapStr} (min TTC ${ttcStr}); no conflict to avoid (gap ≤ ${CONFLICT_CLEARANCE_M} m or TTC ≤ ${CONFLICT_TTC_S} s).`;
          reason = `conflict_approached: the requested conflict between ${pair.subject.label} and ${pair.target.label} did not happen — closest approach ${gapStr}, min TTC ${ttcStr}; there was nothing for the subject to avoid.`;
        }
        checks.push({
          id: "conflict_approached",
          status: "fail",
          label: "Conflict",
          detail,
          measuredValue: approach?.gapM ?? null,
          threshold: CONFLICT_CLEARANCE_M,
        });
        reasons.push(reason);
      }

      // conflict_in_region — the closest approach must land near the asked-for location.
      if (conflictAt && approach && intendedLocation) {
        const off = distance(approach.point, intendedLocation);
        if (off <= REGION_RADIUS_M) {
          checks.push({
            id: "conflict_in_region",
            status: "pass",
            label: "Location",
            detail: `Closest approach is ${off.toFixed(1)} m from the specified location.`,
            measuredValue: off,
            threshold: REGION_RADIUS_M,
          });
        } else {
          checks.push({
            id: "conflict_in_region",
            status: "fail",
            label: "Location",
            detail: `Closest approach is ${off.toFixed(1)} m from the specified location (max ${REGION_RADIUS_M} m).`,
            measuredValue: off,
            threshold: REGION_RADIUS_M,
          });
          reasons.push(`conflict_in_region: the conflict happened ${off.toFixed(1)} m away from the location the prompt specified (tolerance ${REGION_RADIUS_M} m).`);
        }
      }

      // conflict_timing — observed vs planned conflict moment (soft: a yield legitimately delays it).
      if (conflictAt && args.conflict) {
        const drift = Math.abs(conflictAt.timeS - args.conflict.arrivalTimeS);
        checks.push({
          id: "conflict_timing",
          status: drift <= TIMING_TOLERANCE_S ? "pass" : "warn",
          label: "Timing",
          detail: `Conflict at t=${conflictAt.timeS.toFixed(2)}s vs planned ${args.conflict.arrivalTimeS.toFixed(2)}s (drift ${drift.toFixed(2)}s).`,
          measuredValue: drift,
          threshold: TIMING_TOLERANCE_S,
        });
      }
    }
  }

  spawnOffsetChecks();

  // maneuver_executed — the subject must actually perform the family-defining
  // maneuver; a straight head-on satisfies the other checks, so without this an
  // `unprotected_left_turn` that never turns falsely passes. The planner's gate
  // relation (XODR-derived) is authoritative when present; the net heading
  // change of the authored route is the fallback for gate-less plans.
  const expectedTurn = TURN_FAMILIES[args.family];
  if (!expectedTurn) {
    checks.push({
      id: "maneuver_executed",
      status: "pass",
      label: "Maneuver",
      detail: `No turn maneuver required for ${args.family}.`,
      measuredValue: null,
      threshold: null,
    });
  } else if (args.conflict?.subjectTurnRelation) {
    const planned = args.conflict.subjectTurnRelation;
    const ok = planned === expectedTurn;
    checks.push({
      id: "maneuver_executed",
      status: ok ? "pass" : "fail",
      label: "Maneuver",
      detail: ok
        ? `${pair.subject.label} traverses a ${planned} gate (XODR-authoritative; ${args.family}).`
        : `${pair.subject.label}'s planned route is a ${planned} gate, not the ${expectedTurn} gate the family requires.`,
      measuredValue: null,
      threshold: null,
    });
  } else {
    const subjectRoute = routeByActor.get(pair.subject.id)!;
    const poly: readonly CollisionDraftPoint[] = subjectRoute.kind === "none" ? [] : subjectRoute.points;
    let headingChangeRad = 0;
    if (poly.length >= 3) {
      const seg = (a: CollisionDraftPoint, b: CollisionDraftPoint) => Math.atan2(b.y - a.y, b.x - a.x);
      let d = seg(poly[poly.length - 2]!, poly[poly.length - 1]!) - seg(poly[0]!, poly[1]!);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      headingChangeRad = Math.abs(d);
    }
    const deg = (headingChangeRad * 180) / Math.PI;
    const ok = headingChangeRad >= MANEUVER_MIN_TURN_RAD;
    checks.push({
      id: "maneuver_executed",
      status: ok ? "pass" : "fail",
      label: "Maneuver",
      detail: ok
        ? `${pair.subject.label} executes a ${deg.toFixed(0)}° turn (${args.family}; heading-fallback, no gate).`
        : `${pair.subject.label} only changes heading ${deg.toFixed(0)}° — not a ${args.family} (a straight head-on is not a turn).`,
      measuredValue: deg,
      threshold: (MANEUVER_MIN_TURN_RAD * 180) / Math.PI,
    });
  }

  // kinematic_lint — the host's plausibility thresholds over the runtime's own
  // pose samples, judged on the run-up to first contact. Props are outside the
  // lint's vehicle/walker domain.
  const lintable = args.actors.filter((actor) => actor.kind !== "prop");
  const lintableIds = new Set(lintable.map((actor) => actor.id));
  const actorKinds: Record<string, "vehicle" | "walker"> = {};
  for (const actor of lintable) actorKinds[actor.id] = actor.kind === "walker" ? "walker" : "vehicle";
  const lintEndS = rawContact?.timeS ?? run.trace.ticks.t[run.trace.ticks.t.length - 1] ?? 0;
  const frames = framesFromTrace(run.trace, actorIdByRole, lintEndS).map((frame) => ({
    ...frame,
    actors: frame.actors.filter((actor) => lintableIds.has(actor.id)),
  }));
  const lintReport = args.lint(frames, actorKinds);
  if (lintReport.violations.length === 0) {
    checks.push({
      id: "kinematic_lint",
      kind: "kinematic_lint",
      status: "pass",
      label: "Kinematics",
      detail: "Native actor motion has no kinematic plausibility findings.",
      measuredValue: null,
      threshold: null,
    });
  } else {
    const actorsById = new Map(args.actors.map((actor) => [actor.id, actor] as const));
    for (const finding of lintReport.violations) {
      const actor = actorsById.get(finding.actorId);
      const isDeclared = declaredViolating(actor);
      const annotation = finding.severity === "violation" && isDeclared ? " (declared-violating)" : "";
      const status = finding.severity === "warning" ? "warn" : isDeclared ? "pass" : "fail";
      const unit = lintUnit(finding.kind);
      const kindLabel = finding.kind.replaceAll("_", " ");
      checks.push({
        id: "kinematic_lint",
        kind: "kinematic_lint",
        status,
        label: "Kinematics",
        detail: `${actor?.label ?? finding.actorId}: ${kindLabel} ${finding.severity} peaks at ${finding.peakValue.toFixed(2)} ${unit} (threshold ${finding.threshold.toFixed(2)} ${unit})${annotation}.`,
        measuredValue: finding.peakValue,
        threshold: finding.threshold,
      });
      if (status === "fail") {
        reasons.push(
          `kinematic_lint: ${actor?.label ?? finding.actorId} has an unexplained ${kindLabel} violation (peak ${finding.peakValue.toFixed(2)} ${unit}, threshold ${finding.threshold.toFixed(2)} ${unit}).`,
        );
      }
    }
  }

  const hardFail = checks.some(
    (c) =>
      c.status === "fail" &&
      (c.id === "collision_occurred" ||
        c.id === "collision_in_region" ||
        c.id === "contact_absent" ||
        c.id === "conflict_approached" ||
        c.id === "conflict_in_region" ||
        c.id === "route_resolvable" ||
        c.id === "maneuver_executed" ||
        c.id === "kinematic_lint"),
  );

  return {
    ...baseReport,
    verdict: hardFail ? "fail" : "pass",
    simulatedDurationS: run.input.clipSeconds,
    fixedDeltaS: run.input.dt,
    collision: contact
      ? {
          occurred: true,
          timeS: contact.timeS,
          point: contact.point,
          closingSpeedKph: contact.closingSpeedMps * 3.6,
          actorAId: pair.subject.id,
          actorBId: pair.target.id,
        }
      : baseReport.collision,
    minPairwiseDistanceM: contact ? 0 : minPairwiseDistanceM,
    checks,
    actorDiagnostics: diagnostics(conflictAt),
    reasons,
  };
}
