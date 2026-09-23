import { contentHash, type SimTrace } from '@simforge-oss/engine';

import { compareNormalizedTraces } from './compare.js';
import { mapEntities, normalizeCanonicalTrace, headingDeltaRad } from './normalize.js';
import { COMMON_DURATION_S, type DualTraceFrame, type NormalizedTrace } from './types.js';

/**
 * Motion comparison between two authoritative simulations of the same scenario (a re-simulation
 * under another engine, an older result the author kept, a map re-pin). Both are canonical traces on
 * the same fixed-step clock, so the comparison is exact and per tick over the WHOLE clip; the
 * strict-trajectory-v1 comparator (`compareNormalizedTraces`) adds its verdict for clips it can
 * sample (its common timeline is 20 s at 50 Hz).
 *
 * "Identical" means every actor stays within 1 mm and 0.05 degrees on every tick, is present on the
 * same ticks, and the events, collisions and signal edges agree exactly. Anything else is a change,
 * summarised by its largest position error and what it touched.
 */
export const SIMULATION_MOTION_DIFF_FORMAT = 'simforge.motion-diff/v1';
export const MOTION_IDENTICAL_POSITION_M = 1e-3;
export const MOTION_IDENTICAL_HEADING_RAD = (0.05 * Math.PI) / 180;
const MAX_LISTED_ACTORS = 50;
const TICK_EPS_S = 1e-6;

export interface SimulationMotionDiff {
  readonly format: typeof SIMULATION_MOTION_DIFF_FORMAT;
  readonly baseTraceHash: string;
  readonly candidateTraceHash: string;
  readonly identical: boolean;
  readonly maxPositionErrorM: number;
  readonly maxHeadingErrorDeg: number;
  /** The actor and clip time of the largest position error (null when nothing moved). */
  readonly worst: { readonly actorId: string; readonly tS: number; readonly positionErrorM: number } | null;
  readonly actors: {
    readonly compared: number;
    readonly changedCount: number;
    /** Sorted; at most 50 ids. */
    readonly changed: readonly string[];
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
  readonly eventsChanged: number;
  readonly collisionsChanged: number;
  readonly signalsChanged: number;
  readonly durationS: { readonly base: number; readonly candidate: number };
  /** The strict-trajectory-v1 comparator's verdict, or why it could not run. */
  readonly strict: {
    readonly profile: 'strict-trajectory-v1';
    readonly verdict: 'pass' | 'fail' | 'not-run';
    readonly reportHash: string | null;
    readonly errorFindings: number;
    readonly reason: string | null;
  };
}

function tickGridsMatch(a: SimTrace, b: SimTrace): boolean {
  if (Math.abs(a.header.dt - b.header.dt) > TICK_EPS_S) return false;
  const n = Math.min(a.ticks.t.length, b.ticks.t.length);
  for (let i = 0; i < n; i += 1) if (Math.abs(a.ticks.t[i]! - b.ticks.t[i]!) > TICK_EPS_S) return false;
  return true;
}

function eventKeys(trace: SimTrace): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of trace.events) {
    const actors = 'actorId' in event ? [event.actorId] : 'a' in event && 'b' in event ? [String(event.a), String(event.b)].sort() : [];
    const key = `${event.kind}|${actors.join(',')}|${Math.round(event.t / trace.header.dt)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function collisionKeys(trace: SimTrace): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of trace.metrics.collisions) {
    const key = `${[item.a, item.b].sort().join(',')}|${Math.round(item.t / trace.header.dt)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function signalKeys(trace: SimTrace): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [signalId, track] of Object.entries(trace.ticks.signals ?? {})) {
    let previous: string | undefined;
    for (let index = 0; index < trace.ticks.t.length; index += 1) {
      const state = track.phase[index] as string | undefined;
      if (state !== undefined && state !== previous) {
        const key = `${signalId}|${state}|${index}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      previous = state;
    }
  }
  return counts;
}

/** Size of the multiset symmetric difference. */
function changedCount(a: Map<string, number>, b: Map<string, number>): number {
  let changed = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) changed += Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0));
  return changed;
}

function asExternal(trace: NormalizedTrace): NormalizedTrace {
  return { ...trace, side: 'external' };
}

function strictVerdict(base: SimTrace, candidate: SimTrace): SimulationMotionDiff['strict'] {
  const profile = 'strict-trajectory-v1' as const;
  if (Math.abs(base.header.clipSeconds - COMMON_DURATION_S) > TICK_EPS_S
      || Math.abs(candidate.header.clipSeconds - COMMON_DURATION_S) > TICK_EPS_S) {
    return {
      profile, verdict: 'not-run', reportHash: null, errorFindings: 0,
      reason: `the comparator samples a ${COMMON_DURATION_S} s clip; these clips are ${base.header.clipSeconds} s and ${candidate.header.clipSeconds} s (the per-tick comparison covers them in full)`,
    };
  }
  try {
    const canonical = normalizeCanonicalTrace(base);
    const external = asExternal(normalizeCanonicalTrace(candidate));
    const mapping = mapEntities(base.header.actorIds, candidate.header.actorIds.map((id) => ({ id })));
    const report = compareNormalizedTraces(canonical, external, mapping, { profile });
    return {
      profile,
      verdict: report.verdict,
      reportHash: report.reportHash,
      errorFindings: report.findings.filter((finding) => finding.severity === 'error').length,
      reason: null,
    };
  } catch (error) {
    return { profile, verdict: 'not-run', reportHash: null, errorFindings: 0, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Compare two canonical traces of one scenario. Throws when their clocks differ (not comparable). */
export function diffSimulationTraces(base: SimTrace, candidate: SimTrace): SimulationMotionDiff {
  if (!tickGridsMatch(base, candidate)) {
    throw new Error(`simulation traces are on different clocks (dt ${base.header.dt} vs ${candidate.header.dt}); they cannot be compared tick by tick`);
  }
  const baseIds = new Set(base.header.actorIds);
  const candidateIds = new Set(candidate.header.actorIds);
  const added = [...candidateIds].filter((id) => !baseIds.has(id)).sort();
  const removed = [...baseIds].filter((id) => !candidateIds.has(id)).sort();
  const shared = [...baseIds].filter((id) => candidateIds.has(id)).sort();
  const ticks = Math.max(base.ticks.t.length, candidate.ticks.t.length);
  let maxPosition = 0;
  let maxHeading = 0;
  let worst: SimulationMotionDiff['worst'] = null;
  const changed: string[] = [];
  for (const id of shared) {
    const a = base.ticks.actors[id];
    const b = candidate.ticks.actors[id];
    if (!a || !b) throw new Error(`trace is missing the track of listed actor ${id}`);
    let actorChanged = false;
    for (let i = 0; i < ticks; i += 1) {
      const presentA = i < a.present.length && Boolean(a.present[i]);
      const presentB = i < b.present.length && Boolean(b.present[i]);
      if (presentA !== presentB) {
        actorChanged = true;
        continue;
      }
      if (!presentA) continue;
      const error = Math.hypot(a.x[i]! - b.x[i]!, a.y[i]! - b.y[i]!);
      const heading = Math.abs(headingDeltaRad(a.headingRad[i]!, b.headingRad[i]!));
      if (error > MOTION_IDENTICAL_POSITION_M || heading > MOTION_IDENTICAL_HEADING_RAD) actorChanged = true;
      if (heading > maxHeading) maxHeading = heading;
      if (error > maxPosition) {
        maxPosition = error;
        worst = { actorId: id, tS: base.ticks.t[i] ?? candidate.ticks.t[i] ?? i * base.header.dt, positionErrorM: error };
      }
    }
    if (actorChanged) changed.push(id);
  }
  const eventsChanged = changedCount(eventKeys(base), eventKeys(candidate));
  const collisionsChanged = changedCount(collisionKeys(base), collisionKeys(candidate));
  const signalsChanged = changedCount(signalKeys(base), signalKeys(candidate));
  const identical = changed.length === 0 && added.length === 0 && removed.length === 0
    && eventsChanged === 0 && collisionsChanged === 0 && signalsChanged === 0
    && base.ticks.t.length === candidate.ticks.t.length;
  return {
    format: SIMULATION_MOTION_DIFF_FORMAT,
    baseTraceHash: contentHash(base),
    candidateTraceHash: contentHash(candidate),
    identical,
    maxPositionErrorM: maxPosition,
    maxHeadingErrorDeg: (maxHeading * 180) / Math.PI,
    worst: maxPosition > 0 ? worst : null,
    actors: {
      compared: shared.length,
      changedCount: changed.length,
      changed: changed.slice(0, MAX_LISTED_ACTORS),
      added: added.slice(0, MAX_LISTED_ACTORS),
      removed: removed.slice(0, MAX_LISTED_ACTORS),
    },
    eventsChanged,
    collisionsChanged,
    signalsChanged,
    durationS: { base: base.header.clipSeconds, candidate: candidate.header.clipSeconds },
    strict: strictVerdict(base, candidate),
  };
}

/** One line for a chip: "Motion identical" or "max 1.2 m · 2 actors · 1 event changed". */
export function describeSimulationMotionDiff(diff: SimulationMotionDiff): string {
  if (diff.identical) return 'Motion identical';
  const parts: string[] = [];
  if (diff.maxPositionErrorM > MOTION_IDENTICAL_POSITION_M) {
    parts.push(`max ${diff.maxPositionErrorM >= 0.1 ? diff.maxPositionErrorM.toFixed(1) : diff.maxPositionErrorM.toFixed(3)} m`);
  }
  const actors = diff.actors.changedCount + diff.actors.added.length + diff.actors.removed.length;
  if (actors > 0) parts.push(`${actors} actor${actors === 1 ? '' : 's'}`);
  const events = diff.eventsChanged + diff.collisionsChanged;
  if (events > 0) parts.push(`${events} event${events === 1 ? '' : 's'}`);
  if (diff.signalsChanged > 0) parts.push(`${diff.signalsChanged} signal edge${diff.signalsChanged === 1 ? '' : 's'}`);
  if (parts.length === 0) parts.push('timing');
  return `${parts.join(' · ')} changed`;
}

/**
 * Both simulations side by side, for the Compare view: the frame shape of `DualTracePlaybackData`
 * (base = `canonical`, candidate = `external`) over the whole clip, decimated to `sampleHz`.
 */
export interface SimulationDualPlayback {
  readonly sampleHz: number;
  readonly durationS: number;
  readonly baseTraceHash: string;
  readonly candidateTraceHash: string;
  readonly frames: readonly DualTraceFrame[];
}

export function buildSimulationDualPlayback(base: SimTrace, candidate: SimTrace, sampleHz = 10): SimulationDualPlayback {
  if (!tickGridsMatch(base, candidate)) throw new Error('simulation traces are on different clocks');
  const stride = Math.max(1, Math.round(1 / (sampleHz * base.header.dt)));
  const ids = [...new Set([...base.header.actorIds, ...candidate.header.actorIds])].sort();
  const ticks = Math.max(base.ticks.t.length, candidate.ticks.t.length);
  const pose = (trace: SimTrace, id: string, i: number) => {
    const track = trace.ticks.actors[id];
    if (!track || i >= track.x.length) return null;
    return { x: track.x[i]!, y: track.y[i]!, z: 0, headingRad: track.headingRad[i]!, present: Boolean(track.present[i]) };
  };
  const frames: DualTraceFrame[] = [];
  for (let i = 0; i < ticks; i += stride) {
    frames.push({
      t: base.ticks.t[i] ?? candidate.ticks.t[i] ?? i * base.header.dt,
      actors: Object.fromEntries(ids.map((id) => {
        const canonical = pose(base, id, i);
        const external = pose(candidate, id, i);
        return [id, {
          canonical,
          external,
          positionErrorM: canonical?.present && external?.present
            ? Math.hypot(canonical.x - external.x, canonical.y - external.y)
            : null,
        }];
      })),
    });
  }
  return {
    sampleHz: 1 / (stride * base.header.dt),
    durationS: Math.max(base.header.clipSeconds, candidate.header.clipSeconds),
    baseTraceHash: contentHash(base),
    candidateTraceHash: contentHash(candidate),
    frames,
  };
}
