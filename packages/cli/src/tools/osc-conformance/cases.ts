/**
 * Conformance case files (`fixtures/osc-conformance/cases/*.case.json`).
 *
 * Every case carries a hand-derived ORACLE: the motion and event timing the
 * ASAM OpenSCENARIO XML 1.4.0 text prescribes for the scenario it describes,
 * with the clauses cited. That oracle is the only reference.
 *
 * `engine` cases are authored in SimForge's vocabulary (`SimScenarioInput`),
 * because that is where our execution semantics live:
 *
 *   case → SimScenarioInput → our engine (dt 0.02) → trace   ⟶ vs oracle (primary)
 *   case → our XML 1.4 actions export → esmini         ⟶ vs oracle (evidence)
 *   case → our XML 1.4 trajectory-replay export → esmini ⟶ vs our trace (exporter check)
 *
 * `xosc` probes are hand-written files for constructs SimForge cannot
 * express; they check that the live importer says so loudly, and record
 * whether esmini follows the spec.
 */

import type { CaseOracle } from './oracle.js';
import { laneCenterY, DEFAULT_STRAIGHT_ROAD } from './road.js';

/** How SimForge's engine relates to the spec-derived oracle. */
export type OurVerdict =
  /** Our engine reproduces the oracle within tolerance. */
  | 'conforms'
  /** It does not; `finding` names the bug or documented deviation. */
  | 'deviates'
  /** The OSC construct has no SimForge equivalent (xosc probes); import must say so. */
  | 'not-expressible';

/** How esmini relates to the same oracle. Evidence only, never the reference. */
export type EsminiVerdict = 'agrees' | 'disagrees' | 'unsupported' | 'not-run';

/** Back-compat alias used by the report. */
export type ExpectedVerdict = OurVerdict;

export interface CaseTolerance {
  /** Planar position error, metres (max over the clip). */
  readonly positionM: number;
  /** Speed error, m/s (max over the clip). */
  readonly speedMps: number;
  /** Heading error, degrees (max over the clip). */
  readonly headingDeg: number;
  /** Event start/end time error, seconds. One 20 ms tick plus float slack by default. */
  readonly eventS: number;
}

export const DEFAULT_TOLERANCE: CaseTolerance = Object.freeze({
  positionM: 0.25,
  speedMps: 0.25,
  headingDeg: 1,
  eventS: 0.021,
});

export interface CaseActor {
  readonly id: string;
  readonly kind?: 'car' | 'truck' | 'van' | 'bus' | 'pedestrian' | 'static_object';
  /** OpenDRIVE lane id on the straight road (negative = +x travel). */
  readonly lane: number;
  /** Distance along the road, metres. */
  readonly s: number;
  readonly speedMps: number;
  readonly dims?: { readonly l: number; readonly w: number; readonly h: number };
  /**
   * `initial` (default) pins the free-flow cruise target to the initial speed,
   * which is OSC's default longitudinal strategy ("keep current speed").
   * `omit` leaves the engine default (lane speed limit × speedFactor).
   */
  readonly cruise?: 'initial' | 'omit';
  /** Raw overrides merged over the generated actor (e.g. `behavior.rules`). */
  readonly overrides?: Record<string, unknown>;
}

export interface ImportExpectation {
  /** Actors the live importer (analyzeOpenScenarioImport) must translate. */
  readonly actors: number;
  /** Diagnostic codes it must report (subset match), proving loss is loud. */
  readonly diagnostics: readonly string[];
  /** Or: the import must fail with this OpenScenarioImportError code. */
  readonly errorCode?: string;
  /**
   * Expected scene-frame poses of the translated actors, in order. The scene
   * frame is y-up with `z = -y_osc` (packages/engine/src/frames.ts); heading
   * is frame-invariant.
   */
  readonly scenePoses?: readonly { readonly x: number; readonly z: number; readonly headingRad: number }[];
}

export interface ConformanceCase {
  readonly id: string;
  /**
   * `engine` (default): authored as SimScenarioInput; the .xosc is our actions export.
   * `xosc`: a hand-written .xosc probe for a construct outside our vocabulary.
   */
  readonly kind?: 'engine' | 'xosc';
  /** For `xosc` probes: path under fixtures/osc-conformance/. */
  readonly xosc?: string;
  /** OSC version the case targets (default 1.4). */
  readonly oscVersion?: string;
  /** One line: which OpenSCENARIO feature this case isolates. */
  readonly feature: string;
  /** OpenSCENARIO elements exercised (for the feature matrix). */
  readonly osc: readonly string[];
  readonly description: string;
  readonly clipSeconds: number;
  readonly warmupSeconds?: number;
  readonly actors: readonly CaseActor[];
  readonly interactions: readonly Record<string, unknown>[];
  readonly tolerance?: Partial<CaseTolerance>;
  /** Compare motion only up to this clip time (e.g. up to a collision). */
  readonly compareUntilS?: number;
  /** The spec-derived expected behaviour. The only reference. */
  readonly oracle: CaseOracle;
  readonly expect: {
    readonly ours: OurVerdict;
    /** Finding id in docs/engineering/openscenario-conformance.md. */
    readonly finding?: string;
    /** When our actions exporter refuses the case: its issue codes (sorted). */
    readonly exportIssueCodes?: readonly string[];
    /** Recorded esmini agreement with the oracle (a change is flagged for review). */
    readonly esmini: EsminiVerdict;
    readonly esminiNote?: string;
    /** Whether esmini replaying our trajectory-replay export must match our trace. */
    readonly roundTrip?: 'match' | 'deviation' | 'skip';
    readonly import?: ImportExpectation;
    readonly note?: string;
  };
}

const OPERATIONAL_CONDITIONS = Object.freeze({
  effects: { frictionScale: 1, trafficSpeedFactor: 1, visibilityRangeM: 10_000 },
  timeOfDay: 'day',
  traffic: 'moderate',
  visibility: 'unrestricted',
  weather: 'clear',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isRecord(value) && isRecord(out[key]) ? deepMerge(out[key] as Record<string, unknown>, value) : value;
  }
  return out;
}

/** Expand a case into the raw (unparsed) engine input. */
export function caseInput(testCase: ConformanceCase): Record<string, unknown> {
  const actors = testCase.actors.map((actor) => {
    const forward = actor.lane < 0;
    const y = laneCenterY(actor.lane);
    const x = forward ? actor.s : DEFAULT_STRAIGHT_ROAD.lengthM - actor.s;
    const base: Record<string, unknown> = {
      id: actor.id,
      kind: actor.kind ?? 'car',
      ...(actor.dims ? { dims: actor.dims } : {}),
      initial: {
        laneRef: { rsl: `1:0:${actor.lane}`, s: forward ? actor.s : DEFAULT_STRAIGHT_ROAD.lengthM - actor.s, tFrac: 0 },
        // Scene frame: z = -y.
        pose: { x, z: -y, headingRad: forward ? 0 : Math.PI },
        speedMps: actor.speedMps,
      },
      behavior: {
        route: { kind: 'follow', startRsl: `1:0:${actor.lane}`, turns: [] },
        // OSC's default longitudinal control strategy keeps the current speed;
        // pin the cruise target to the initial speed so the engine does too.
        ...(actor.cruise === 'omit' ? {} : { cruiseSpeedMps: actor.speedMps }),
      },
    };
    return actor.overrides ? deepMerge(base, actor.overrides) : base;
  });
  return {
    schemaVersion: 1,
    mapId: 'osc-conformance-straight',
    clipSeconds: testCase.clipSeconds,
    warmupSeconds: testCase.warmupSeconds ?? 0,
    dt: 0.02,
    seed: `osc-conformance:${testCase.id}`,
    operationalConditions: OPERATIONAL_CONDITIONS,
    metricSubject: testCase.actors[0]?.id,
    actors,
    interactions: testCase.interactions,
  };
}

export function caseTolerance(testCase: ConformanceCase): CaseTolerance {
  return { ...DEFAULT_TOLERANCE, ...testCase.tolerance };
}
