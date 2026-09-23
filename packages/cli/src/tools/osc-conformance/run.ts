/**
 * Spec-first OpenSCENARIO conformance for one case.
 *
 * The reference is the case's hand-derived oracle (ASAM OSC XML 1.4.0 clause
 * text evaluated in closed form, `oracle.ts`). Everything else is judged
 * against it:
 *
 * 1. **Ours** — SimForge's engine executing the case (`kind: engine`). A
 *    hand-written probe (`kind: xosc`) is outside SimForge's vocabulary and has
 *    no SimForge side (`not-expressible`); it only records esmini evidence.
 * 2. **esmini** — secondary evidence only: it executes our XML 1.4 `actions`
 *    export (engine cases) or the probe itself, and is recorded as agreeing,
 *    disagreeing, or not supporting the construct.
 * 3. **Round trip** — esmini replays our XML 1.4 `trajectory-replay` export (the
 *    profile we ship). That must reproduce our trace to float noise; a miss is
 *    an exporter bug (frame, time origin, heading, reference point).
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { LaneGraph, SimTrace } from '@simforge-oss/engine';
import { engine, parseSimScenarioInput, runSimulation } from '@simforge-oss/engine/node';
import { AsamExportError, exportOpenScenarioXml14 } from '@simforge-oss/openscenario/export';

import {
  caseInput, caseTolerance, type CaseTolerance, type ConformanceCase, type EsminiVerdict, type OurVerdict,
} from './cases.js';
import { readEsminiCsv } from './esmini-csv.js';
import { endTimes, esminiDiagnostics, parseEsminiLog, startTimes } from './esmini-log.js';
import { runEsmini, type EsminiBinary } from './esmini.js';
import { evaluateActorOracle, type OracleSample } from './oracle.js';

export const ROAD_FILE = 'osc-conformance-straight.xodr';

export interface SeriesError {
  readonly max: number;
  readonly atT: number;
  readonly final: number;
}

export interface ActorComparison {
  readonly actorId: string;
  readonly samples: number;
  readonly position: SeriesError;
  readonly speed: SeriesError;
  readonly headingDeg: SeriesError;
  readonly presenceMismatches: number;
  readonly subject: { readonly x: number; readonly y: number; readonly speedMps: number };
  readonly reference: { readonly x: number; readonly y: number; readonly speedMps: number };
}

export interface EventTiming {
  readonly start: number | null;
  readonly end: number | null;
  readonly endKind?: string | null;
  readonly executions?: number;
}

export interface EventComparison {
  readonly interactionId: string;
  readonly oracle: { readonly start: number | null; readonly end?: number | null; readonly executions?: number } | null;
  readonly ours: EventTiming | null;
  readonly esmini: EventTiming | null;
}

export interface SideResult<V extends string> {
  readonly verdict: V;
  readonly actors: readonly ActorComparison[];
  readonly reasons: readonly string[];
}

export interface CaseResult {
  readonly id: string;
  readonly kind: 'engine' | 'xosc';
  readonly feature: string;
  readonly clauses: readonly string[];
  readonly decisions: readonly string[];
  readonly ours: SideResult<OurVerdict>;
  /** Our actions exporter's issue codes when it refused the case. */
  readonly exportIssueCodes: readonly string[] | null;
  readonly esmini: SideResult<EsminiVerdict> & { readonly diagnostics: readonly string[] };
  readonly events: readonly EventComparison[];
  readonly roundTrip: SideResult<'match' | 'deviation' | 'skip'>;
  readonly expected: ConformanceCase['expect'];
  /** Empty when every observed verdict equals the recorded one. */
  readonly unexpected: readonly string[];
}

/** Round-trip tolerance: esmini replaying our own trajectory. */
export const ROUND_TRIP_TOLERANCE: CaseTolerance = Object.freeze({
  positionM: 0.01,
  speedMps: Number.POSITIVE_INFINITY,
  headingDeg: 0.1,
  eventS: 0.021,
});

type Sample = { readonly x: number; readonly y: number; readonly speedMps: number; readonly headingRad: number; readonly present: boolean };
type Series = ReadonlyMap<number, Sample>;

const RAD_TO_DEG = 180 / Math.PI;
const tickKey = (t: number): number => Math.round(t * 50);
const wrapDeg = (deltaRad: number): number => Math.abs(Math.atan2(Math.sin(deltaRad), Math.cos(deltaRad))) * RAD_TO_DEG;

export const entityName = (id: string): string => `actor_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
export const eventName = (id: string): string => `event_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;

function traceSeries(trace: SimTrace, actorId: string): Series {
  const track = trace.ticks.actors[actorId];
  const out = new Map<number, Sample>();
  if (!track) return out;
  trace.ticks.t.forEach((t, index) => {
    if (t < 0) return;
    out.set(tickKey(t), {
      x: track.x[index]!, y: track.y[index]!, speedMps: track.speedMps[index]!,
      headingRad: track.headingRad[index]!, present: track.present[index] === 1,
    });
  });
  return out;
}

function csvSeries(csv: string, warmupSeconds: number, actorIds: readonly string[], nameOf: (id: string) => string): Map<string, Series> {
  const byName = readEsminiCsv(csv);
  const out = new Map<string, Series>();
  for (const id of actorIds) {
    const samples = byName.get(nameOf(id)) ?? [];
    const series = new Map<number, Sample>();
    for (const sample of samples) {
      const t = sample.t - warmupSeconds;
      if (t < -1e-9) continue;
      series.set(tickKey(t), { x: sample.x, y: sample.y, speedMps: sample.speedMps, headingRad: sample.headingRad, present: true });
    }
    out.set(id, series);
  }
  return out;
}

function oracleSeries(samples: readonly OracleSample[]): Series {
  return new Map(samples.map((sample) => [tickKey(sample.t), sample]));
}

function compareSeries(actorId: string, subject: Series | undefined, reference: Series, untilS = Number.POSITIVE_INFINITY): ActorComparison {
  let position: SeriesError = { max: 0, atT: 0, final: 0 };
  let speed: SeriesError = { max: 0, atT: 0, final: 0 };
  let heading: SeriesError = { max: 0, atT: 0, final: 0 };
  let samples = 0;
  let presenceMismatches = 0;
  let lastSubject = { x: 0, y: 0, speedMps: 0 };
  let lastReference = { x: 0, y: 0, speedMps: 0 };
  for (const [key, ref] of [...reference.entries()].sort(([a], [b]) => a - b)) {
    const t = key / 50;
    if (t > untilS + 1e-9) break;
    const got = subject?.get(key);
    const gotPresent = got?.present ?? false;
    if (gotPresent !== ref.present) { presenceMismatches += 1; continue; }
    if (!got || !ref.present) continue;
    samples += 1;
    const dPos = Math.hypot(got.x - ref.x, got.y - ref.y);
    const dSpeed = Math.abs(got.speedMps - ref.speedMps);
    const dHeading = wrapDeg(got.headingRad - ref.headingRad);
    if (dPos > position.max) position = { ...position, max: dPos, atT: t };
    if (dSpeed > speed.max) speed = { ...speed, max: dSpeed, atT: t };
    if (dHeading > heading.max) heading = { ...heading, max: dHeading, atT: t };
    position = { ...position, final: dPos };
    speed = { ...speed, final: dSpeed };
    heading = { ...heading, final: dHeading };
    lastSubject = { x: got.x, y: got.y, speedMps: got.speedMps };
    lastReference = { x: ref.x, y: ref.y, speedMps: ref.speedMps };
  }
  return { actorId, samples, position, speed, headingDeg: heading, presenceMismatches, subject: lastSubject, reference: lastReference };
}

function motionReasons(actors: readonly ActorComparison[], tolerance: CaseTolerance): string[] {
  const reasons: string[] = [];
  for (const actor of actors) {
    if (actor.samples === 0) reasons.push(`${actor.actorId}: no comparable samples`);
    if (actor.presenceMismatches > 0) reasons.push(`${actor.actorId}: presence differs on ${actor.presenceMismatches} ticks`);
    if (actor.position.max > tolerance.positionM) reasons.push(`${actor.actorId}: position error ${actor.position.max.toFixed(3)} m at t=${actor.position.atT.toFixed(2)} s (tol ${tolerance.positionM})`);
    if (actor.speed.max > tolerance.speedMps) reasons.push(`${actor.actorId}: speed error ${actor.speed.max.toFixed(3)} m/s at t=${actor.speed.atT.toFixed(2)} s (tol ${tolerance.speedMps})`);
    if (actor.headingDeg.max > tolerance.headingDeg) reasons.push(`${actor.actorId}: heading error ${actor.headingDeg.max.toFixed(3)}° at t=${actor.headingDeg.atT.toFixed(2)} s (tol ${tolerance.headingDeg})`);
  }
  return reasons;
}

function eventReasons(label: string, events: readonly EventComparison[], pick: (event: EventComparison) => EventTiming | null, tolerance: CaseTolerance): string[] {
  const reasons: string[] = [];
  for (const event of events) {
    if (!event.oracle) continue;
    const got = pick(event);
    const want = event.oracle;
    const gotStart = got?.start ?? null;
    if ((want.start === null) !== (gotStart === null)) {
      reasons.push(`${event.interactionId}: ${label} ${gotStart === null ? 'never starts' : `starts at ${gotStart.toFixed(2)} s`}, spec ${want.start === null ? 'never' : `${want.start.toFixed(2)} s`}`);
    } else if (want.start !== null && gotStart !== null && Math.abs(want.start - gotStart) > tolerance.eventS) {
      reasons.push(`${event.interactionId}: ${label} starts ${gotStart.toFixed(2)} s, spec ${want.start.toFixed(2)} s`);
    }
    if (want.executions !== undefined && got?.executions !== undefined && got.executions !== want.executions) {
      reasons.push(`${event.interactionId}: ${label} executes ${got.executions}×, spec ${want.executions}×`);
    }
    if (want.end !== undefined) {
      const gotEnd = got?.end ?? null;
      if ((want.end === null) !== (gotEnd === null)) {
        reasons.push(`${event.interactionId}: ${label} ${gotEnd === null ? 'never ends' : `ends at ${gotEnd.toFixed(2)} s`}, spec ${want.end === null ? 'never' : `${want.end.toFixed(2)} s`}`);
      } else if (want.end !== null && gotEnd !== null && Math.abs(want.end - gotEnd) > tolerance.eventS) {
        reasons.push(`${event.interactionId}: ${label} ends ${gotEnd.toFixed(2)} s, spec ${want.end.toFixed(2)} s`);
      }
    }
  }
  return reasons;
}

function ourEventTiming(trace: SimTrace, interactionId: string): EventTiming {
  const fired = trace.events.find((event) => event.kind === 'trigger_fired' && event.interactionId === interactionId);
  const ended = trace.events.find((event) =>
    (event.kind === 'interaction_completed' || event.kind === 'interaction_aborted') && event.interactionId === interactionId);
  return {
    start: fired ? fired.t : null,
    end: ended ? ended.t : null,
    endKind: ended ? (ended.kind === 'interaction_aborted' ? `aborted:${ended.reason}` : 'completed') : null,
    executions: trace.events.filter((event) => event.kind === 'trigger_fired' && event.interactionId === interactionId).length,
  };
}

function esminiEventTiming(log: string, element: string, warmupSeconds: number): EventTiming {
  const transitions = parseEsminiLog(log);
  const starts = startTimes(transitions, element);
  const ends = endTimes(transitions, element);
  return {
    start: starts.length ? starts[0]! - warmupSeconds : null,
    end: ends.length ? ends[0]!.t - warmupSeconds : null,
    endKind: ends.length ? ends[0]!.transition : null,
    executions: starts.length,
  };
}

/** esmini log lines that mean "this construct was not executed as written". */
function unsupportedMarkers(diagnostics: readonly string[]): string[] {
  return diagnostics.filter((line) => /not supported|unsupported|not implemented|ignor|unknown|Unexpected/i.test(line));
}

export interface RunCaseOptions {
  readonly testCase: ConformanceCase;
  readonly graph: LaneGraph;
  readonly esmini: EsminiBinary | null;
  readonly workDir: string;
  readonly roadXodr: string;
  readonly corpusDir: string;
}

export interface RunCaseOutput {
  readonly result: CaseResult;
  /** The actions-profile export (null for probes or when the exporter refused). */
  readonly actionsXosc: string | null;
}

export function runCase({ testCase, graph, esmini, workDir, roadXodr, corpusDir }: RunCaseOptions): RunCaseOutput {
  mkdirSync(workDir, { recursive: true });
  const kind = testCase.kind ?? 'engine';
  const tolerance = caseTolerance(testCase);
  const warmup = testCase.warmupSeconds ?? 0;
  const clip = testCase.clipSeconds;
  const oracleActors = Object.fromEntries(Object.entries(testCase.oracle.actors).map(([id, actor]) => [id, oracleSeries(evaluateActorOracle(actor, clip))]));
  const actorIds = Object.keys(testCase.oracle.actors);
  const eventIds = [...new Set([...Object.keys(testCase.oracle.events ?? {}), ...testCase.interactions.map((interaction) => String(interaction['id']))])];

  const runExternal = (xosc: string, subdir: string, nameOf: (id: string) => string) => {
    if (!esmini) return null;
    const dir = path.join(workDir, subdir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ROAD_FILE), roadXodr);
    writeFileSync(path.join(dir, 'scenario.xosc'), xosc);
    if (kind === 'xosc') cpSync(path.join(corpusDir, 'probes', 'catalogs'), path.join(dir, 'catalogs'), { recursive: true });
    const run = runEsmini(esmini, path.join(dir, 'scenario.xosc'), dir);
    const series = run.exitCode === 0 && run.csv ? csvSeries(run.csv, warmup, actorIds, nameOf) : null;
    return { run, series };
  };

  let ours: CaseResult['ours'];
  let exportIssueCodes: string[] | null = null;
  const until = testCase.compareUntilS;
  let actionsXosc: string | null = null;
  let trace: SimTrace | null = null;
  let esminiXosc: string | null = null;
  let esminiNames: (id: string) => string = entityName;
  let esminiEvent: (id: string) => string = eventName;

  if (kind === 'engine') {
    const input = parseSimScenarioInput(caseInput(testCase));
    trace = runSimulation(input, { graph, includeWarmupTrace: false }).trace;
    const actors = actorIds.map((id) => compareSeries(id, traceSeries(trace!, id), oracleActors[id]!, until));
    const exportOptions = { engine: engine(), graph, roadFile: ROAD_FILE, headerDate: '1970-01-01T00:00:00.000Z' } as const;
    try {
      actionsXosc = exportOpenScenarioXml14(input, { ...exportOptions, executionMode: 'actions' }).content;
      esminiXosc = actionsXosc;
    } catch (error) {
      if (!(error instanceof AsamExportError)) throw error;
      exportIssueCodes = [...new Set(error.issues.map((issue) => issue.code))].sort();
    }
    const events = eventIds.map((id) => ({ interactionId: id, oracle: testCase.oracle.events?.[id] ?? null, ours: ourEventTiming(trace!, id), esmini: null }));
    const reasons = [...motionReasons(actors, tolerance), ...eventReasons('ours', events, (event) => event.ours, tolerance)];
    ours = { verdict: reasons.length ? 'deviates' : 'conforms', actors, reasons };
  } else {
    // Hand-written probe for a construct outside SimForge's vocabulary. SimForge
    // does not import OpenSCENARIO, so there is no SimForge side to run: the
    // probe records esmini evidence against the oracle only.
    esminiXosc = readFileSync(path.join(corpusDir, testCase.xosc!), 'utf8');
    esminiNames = (id) => id;
    esminiEvent = (id) => id;
    ours = { verdict: 'not-expressible', actors: [], reasons: [] };
  }

  // esmini: secondary evidence against the same oracle.
  let esminiSide: CaseResult['esmini'] = { verdict: 'not-run', actors: [], reasons: esmini ? ['no executable .xosc (our exporter refused the case)'] : ['esmini not installed'], diagnostics: [] };
  const eventsWithEsmini: EventComparison[] = [];
  if (esminiXosc && esmini) {
    const external = runExternal(esminiXosc, 'esmini', esminiNames)!;
    const diagnostics = esminiDiagnostics(external.run.log);
    if (!external.series) {
      esminiSide = { verdict: 'unsupported', actors: [], reasons: [`esmini failed (exit ${external.run.exitCode}): ${external.run.stderr.slice(0, 300)}`], diagnostics };
    } else {
      const actors = actorIds.map((id) => compareSeries(id, external.series!.get(id), oracleActors[id]!, until));
      for (const id of eventIds) {
        eventsWithEsmini.push({
          interactionId: id,
          oracle: testCase.oracle.events?.[id] ?? null,
          ours: trace ? ourEventTiming(trace, id) : null,
          esmini: esminiEventTiming(external.run.log, esminiEvent(id), warmup),
        });
      }
      const reasons = [...motionReasons(actors, tolerance), ...eventReasons('esmini', eventsWithEsmini, (event) => event.esmini, tolerance)];
      const markers = unsupportedMarkers(diagnostics);
      const verdict: EsminiVerdict = reasons.length === 0 ? 'agrees' : markers.length ? 'unsupported' : 'disagrees';
      esminiSide = { verdict, actors, reasons: [...reasons, ...markers.map((marker) => `esmini: ${marker}`)], diagnostics };
    }
  }
  const events: EventComparison[] = eventsWithEsmini.length
    ? eventsWithEsmini
    : eventIds.map((id) => ({ interactionId: id, oracle: testCase.oracle.events?.[id] ?? null, ours: trace ? ourEventTiming(trace, id) : null, esmini: null }));

  // Round trip through the shipped trajectory-replay profile (engine cases only).
  let roundTrip: CaseResult['roundTrip'] = { verdict: 'skip', actors: [], reasons: [] };
  if (kind === 'engine' && trace && esmini && testCase.expect.roundTrip !== 'skip') {
    try {
      // Export exactly the input the engine executed (it canonicalises, e.g. sorts
      // interactions by id), as the execution-package compiler does; the
      // exporter binds the replay trace to that input's hash.
      const session = engine().simulation(parseSimScenarioInput(caseInput(testCase)), { graph, includeWarmupTrace: true });
      while (!session.advance(1_000_000).done) { /* run to the end of the clip */ }
      const replay = exportOpenScenarioXml14(session.input(), {
        engine: engine(), graph, roadFile: ROAD_FILE, headerDate: '1970-01-01T00:00:00.000Z',
        executionMode: 'trajectory-replay', replayTrace: session.trace(),
      });
      // esmini 3.6.0 predates OSC 1.4 and aborts on <Interpolation/>; strip it exactly
      // as SimCloud's esmini lane does (linear is esmini's Polyline default anyway).
      const external = runExternal(replay.content.replace(/\n\s*<Interpolation\/>/g, ''), 'replay', entityName)!;
      if (!external.series) {
        roundTrip = { verdict: 'deviation', actors: [], reasons: [`esmini failed (exit ${external.run.exitCode})`] };
      } else {
        const actors = actorIds.map((id) => compareSeries(id, external.series!.get(id), traceSeries(trace!, id)));
        const reasons = motionReasons(actors, ROUND_TRIP_TOLERANCE);
        roundTrip = { verdict: reasons.length ? 'deviation' : 'match', actors, reasons };
      }
    } catch (error) {
      roundTrip = { verdict: 'deviation', actors: [], reasons: [`trajectory-replay export failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  const unexpected: string[] = [];
  const expect = testCase.expect;
  if (ours.verdict !== expect.ours) unexpected.push(`ours ${ours.verdict}, recorded ${expect.ours}`);
  if (kind === 'engine') {
    const want = expect.exportIssueCodes ? [...expect.exportIssueCodes].sort() : null;
    if (JSON.stringify(want) !== JSON.stringify(exportIssueCodes)) unexpected.push(`actions export ${exportIssueCodes ? `rejected ${JSON.stringify(exportIssueCodes)}` : 'accepted'}, recorded ${want ? `rejected ${JSON.stringify(want)}` : 'accepted'}`);
  }
  if (esmini && esminiSide.verdict !== expect.esmini) unexpected.push(`esmini ${esminiSide.verdict}, recorded ${expect.esmini}`);
  const expectedRoundTrip = kind === 'engine' ? (expect.roundTrip ?? 'match') : 'skip';
  if (esmini && roundTrip.verdict !== expectedRoundTrip) unexpected.push(`round trip ${roundTrip.verdict}, recorded ${expectedRoundTrip}`);

  return {
    result: {
      id: testCase.id, kind, feature: testCase.feature, clauses: testCase.oracle.clauses, decisions: testCase.oracle.decisions ?? [],
      ours, exportIssueCodes, esmini: esminiSide, events, roundTrip, expected: expect, unexpected,
    },
    actionsXosc,
  };
}
