import {
  contentHash,
  type AmbientTrafficOptions,
  type AmbientTrafficProfile,
  type AmbientTrafficProvenance,
  type EngineRuntime,
  type EvaluateFilters,
  type LaneGraph,
  type SimEvent,
  type SimScenarioInput,
  type SimTrace,
  type TraceEvaluation,
} from '@simforge-oss/engine';

export interface AmbientRobustnessCase {
  readonly label: string;
  readonly profile: AmbientTrafficProfile;
}

export interface AmbientRobustnessCaseReport {
  readonly label: string;
  readonly profile: AmbientTrafficProfile;
  readonly provenance: AmbientTrafficProvenance;
  readonly evaluation: TraceEvaluation;
  readonly deterministic: boolean;
  readonly authoredEventOrderPreserved: boolean;
  readonly authoredNeverFiredPreserved: boolean;
  readonly ambientCollisions: number;
  readonly runtimeMs: number;
  readonly accepted: boolean;
  readonly failures: readonly string[];
  readonly trace: SimTrace;
}

export interface AmbientRobustnessReport {
  readonly version: 1;
  readonly baseInputHash: string;
  readonly baselineEvaluation: TraceEvaluation;
  readonly baselineTrace: SimTrace;
  readonly cases: readonly AmbientRobustnessCaseReport[];
  readonly accepted: boolean;
}

export interface AmbientRobustnessOptions extends AmbientTrafficOptions {
  readonly filters?: EvaluateFilters;
  /** Measurement/reporting gate only; simulation behavior never depends on wall time. */
  readonly maxRuntimeMs?: number;
  /** Injected by CLI/Studio; omitted in deterministic tests. */
  readonly now?: () => number;
}

export const DEFAULT_AMBIENT_ROBUSTNESS_CASES: readonly AmbientRobustnessCase[] = [
  { label: 'off', profile: { version: 1, preset: 'off', seed: 'robustness-off' } },
  { label: 'light', profile: { version: 1, preset: 'light', seed: 'robustness-light' } },
  { label: 'moderate', profile: { version: 1, preset: 'moderate', seed: 'robustness-moderate' } },
];

/**
 * The Off/Light/Moderate ambient robustness matrix. Every population,
 * simulation and evaluation runs in the native engine; this campaign only
 * compares the results. It never relaxes the caller's filters and separately
 * protects the authored trigger chronology from ambient side effects.
 */
export function evaluateAmbientRobustness(
  engine: EngineRuntime,
  base: SimScenarioInput,
  graph: LaneGraph,
  cases: readonly AmbientRobustnessCase[] = DEFAULT_AMBIENT_ROBUSTNESS_CASES,
  options: AmbientRobustnessOptions = {},
): AmbientRobustnessReport {
  const { filters, maxRuntimeMs, now, ...ambientOptions } = options;
  const baseScenario = engine.scenario(base);
  const baselineTrace = engine.runSimulation(baseScenario, { graph }).trace;
  const baselineEvaluation = engine.evaluateTrace(baselineTrace, filters);
  const authoredIds = new Set(base.actors.map((actor) => actor.id));
  const authoredInteractionIds = new Set(base.interactions.map((interaction) => interaction.id));
  const baselineEvents = contentHash(authoredEventSignature(baselineTrace.events, authoredIds, authoredInteractionIds));
  const baselineNeverFired = contentHash(authoredNeverFired(baselineTrace, authoredInteractionIds));
  const reports: AmbientRobustnessCaseReport[] = [];

  for (const item of cases) {
    const generated = engine.materializeAmbientTraffic(baseScenario, graph, item.profile, ambientOptions);
    const started = now?.() ?? 0;
    const first = engine.runSimulation(generated.scenario, { graph }).trace;
    const runtimeMs = now ? now() - started : 0;
    const second = engine.runSimulation(generated.scenario, { graph }).trace;
    const deterministic = engine.traceDigest(first) === engine.traceDigest(second);
    const eventOrderPreserved = contentHash(authoredEventSignature(first.events, authoredIds, authoredInteractionIds)) === baselineEvents;
    const authoredNeverFiredPreserved = contentHash(authoredNeverFired(first, authoredInteractionIds)) === baselineNeverFired;
    const ambientIds = new Set(generated.provenance.actors.map((actor) => actor.id));
    const ambientCollisions = first.metrics.collisions.filter((collision) => ambientIds.has(collision.a) || ambientIds.has(collision.b)).length;
    const evaluation = engine.evaluateTrace(first, filters);
    const failures: string[] = [];
    if (!deterministic) failures.push('same seed produced a different trace');
    if (!eventOrderPreserved) failures.push('authored trigger/event order changed');
    if (!authoredNeverFiredPreserved) failures.push('authored trigger completion changed');
    if (ambientCollisions > 0) failures.push(`${ambientCollisions} collision(s) involved ambient actors`);
    if (baselineEvaluation.verdict === 'accept' && evaluation.verdict !== 'accept') failures.push('ambient traffic changed an accepted scenario to rejected');
    if (now && maxRuntimeMs !== undefined && runtimeMs > maxRuntimeMs) {
      failures.push(`simulation took ${runtimeMs.toFixed(1)} ms (budget ${maxRuntimeMs.toFixed(1)} ms)`);
    }
    reports.push({
      label: item.label,
      profile: item.profile,
      provenance: generated.provenance,
      evaluation,
      deterministic,
      authoredEventOrderPreserved: eventOrderPreserved,
      authoredNeverFiredPreserved,
      ambientCollisions,
      runtimeMs,
      accepted: failures.length === 0,
      failures,
      trace: first,
    });
  }

  return {
    version: 1,
    baseInputHash: contentHash(base),
    baselineEvaluation,
    baselineTrace,
    cases: reports,
    accepted: reports.every((report) => report.accepted),
  };
}

function authoredNeverFired(trace: SimTrace, interactionIds: ReadonlySet<string>): string[] {
  return [...trace.metrics.triggerNeverFired].filter((id) => interactionIds.has(id)).sort();
}

/** Authored events in record order, minus their timestamps: the chronology ambient traffic must not disturb. */
function authoredEventSignature(
  events: readonly SimEvent[],
  actorIds: ReadonlySet<string>,
  interactionIds: ReadonlySet<string>,
): unknown[] {
  const selected: unknown[] = [];
  for (const event of events) {
    const { t: _time, ...orderedIdentity } = event;
    if ('interactionId' in event && interactionIds.has(event.interactionId)) selected.push(orderedIdentity);
    else if ('actorId' in event && actorIds.has(event.actorId)) selected.push(orderedIdentity);
    else if (event.kind === 'collision' && actorIds.has(event.a) && actorIds.has(event.b)) selected.push(orderedIdentity);
  }
  return selected;
}
