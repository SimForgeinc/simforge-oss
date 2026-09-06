/**
 * `EngineRuntime` — the host-neutral façade over the native runtime module.
 *
 * Every simulation, evaluation and trace digest goes through the native
 * bindings; this class only converts between TypeScript documents and the
 * JSON/typed-array boundary. Node binds it to `native()` in `./node.ts`, the
 * browser to the initialised WASM module in `./browser.ts`.
 */

import { guard } from '@simforge-oss/native-runtime/shared';

import type { TopologyIndex } from './map/topology.js';
import type {
  NativeLaneGraph,
  NativeMapBundle,
  NativeModule,
  NativeScenarioInput,
  NativeSeed,
  NativeSimulation,
  NativeTrace,
} from './native-module.js';
import type { AmbientTrafficOptions, AmbientTrafficProfile, AmbientTrafficProvenance } from './ambient/profile.js';
import type { SimIssue } from './errors.js';
import type { ArrivalSolution, RunOptions, SimResult } from './result.js';
import type { SceneState } from './scene-state/schema.js';
import type { SimScenarioInput } from './schema/input.js';
import type { EvaluateFilters, InvariantCheckOptions, InvariantResidualReport, TraceEvaluation } from './trace/evaluate.js';
import { encodeTraceGz } from './trace/gzip.js';
import type { BlindReviewPacket, IntentEvaluation, IntentRubricInput } from './trace/intent-rubric.js';
import type { EpisodeMetrics, SimTrace } from './trace/trace.js';

/** A native lane graph; the only lane-geometry authority consumers query. */
export type LaneGraph = NativeLaneGraph;
/** A validated, normalised scenario shared by reference with every session built from it. */
export type ScenarioInput = NativeScenarioInput;
/** A compiled immutable map. */
export type NativeMap = NativeMapBundle;

export type ScenarioSource = SimScenarioInput | ScenarioInput | string | Uint8Array;
export type TopologySource = TopologyIndex | Uint8Array;
export type TraceSource = SimTrace | Uint8Array | string;

const encoder = new TextEncoder();

function isNativeScenario(value: ScenarioSource): value is ScenarioInput {
  return typeof value === 'object' && !(value instanceof Uint8Array) && typeof (value as ScenarioInput).toJson === 'function';
}

/** A validated current-format trace held by the native runtime. */
export class TraceHandle {
  constructor(readonly native: NativeTrace) {}

  /** `sha256(canonicalJson(quantize(trace)))`. */
  digest(): string {
    return guard(() => this.native.digest());
  }

  /** Quantised canonical JSON — the bytes a determinism test compares. */
  canonicalJson(): string {
    return guard(() => this.native.toJson());
  }

  serialize(): Uint8Array {
    return encoder.encode(this.canonicalJson());
  }

  /** The quantised trace as a document. */
  toTrace(): SimTrace {
    return JSON.parse(this.canonicalJson()) as SimTrace;
  }

  /** Gzipped canonical JSON — the `.trace.json.gz` payload. */
  encodeGz(): Promise<Uint8Array> {
    return encodeTraceGz(this.serialize());
  }

  metrics(): EpisodeMetrics {
    return JSON.parse(guard(() => this.native.metricsJson())) as EpisodeMetrics;
  }

  sceneState(): SceneState {
    return JSON.parse(guard(() => this.native.sceneStateJson())) as SceneState;
  }

  evaluate(filters?: EvaluateFilters): TraceEvaluation {
    const filtersJson = filters === undefined ? null : JSON.stringify(filters);
    return JSON.parse(guard(() => this.native.evaluateJson(filtersJson))) as TraceEvaluation;
  }

  evaluateIntentRubric(rubric: IntentRubricInput): IntentEvaluation {
    return JSON.parse(guard(() => this.native.intentRubricJson(JSON.stringify(rubric)))) as IntentEvaluation;
  }

  blindReviewPacket(rubric: IntentRubricInput): BlindReviewPacket {
    return JSON.parse(guard(() => this.native.blindReviewPacketJson(JSON.stringify(rubric)))) as BlindReviewPacket;
  }

  /** Tier-2 residuals of a v2 template's declared invariants against this trace. */
  checkInvariants(template: unknown, options: InvariantCheckOptions): InvariantResidualReport[] {
    return JSON.parse(guard(() => this.native.invariantsJson(JSON.stringify(template), JSON.stringify(options)))) as InvariantResidualReport[];
  }
}

export interface SimulationProgress {
  readonly ticksAdvanced: number;
  readonly done: boolean;
}

/**
 * A stepped native world. `advance` runs bounded tick batches; the recorded
 * trace, resolved input and issues are readable between batches without
 * advancing or finalising, so a host can publish incremental playback.
 */
export class SimulationHandle {
  constructor(readonly native: NativeSimulation) {}

  get done(): boolean {
    return this.native.done;
  }

  /** Simulation time, negative during warm-up. */
  get tS(): number {
    return this.native.tS;
  }

  /** Run up to `maxTicks` ticks; `actions` holds per-actor overrides for the whole batch (`null` = choreography). */
  advance(maxTicks: number, actions: Float64Array | null = null): SimulationProgress {
    const [ticksAdvanced, done] = guard(() => this.native.advance(maxTicks, actions));
    return { ticksAdvanced: ticksAdvanced ?? 0, done: done === 1 };
  }

  /** The trace recorded so far; the complete clip trace once `done`. */
  trace(): SimTrace {
    return JSON.parse(guard(() => this.native.traceJson())) as SimTrace;
  }

  /** The exact executed input; `contentHash(input)` is `trace.header.inputHash`. */
  input(): SimScenarioInput {
    return JSON.parse(guard(() => this.native.inputJson())) as SimScenarioInput;
  }

  issues(): SimIssue[] {
    return JSON.parse(guard(() => this.native.issuesJson())) as SimIssue[];
  }

  arrival(): ArrivalSolution[] {
    return JSON.parse(guard(() => this.native.arrivalJson())) as ArrivalSolution[];
  }

  /** The whole-clip result; an `engine` error before `done`. */
  result(): SimResult {
    return JSON.parse(guard(() => this.native.resultJson())) as SimResult;
  }

  checkpoint(): Uint8Array {
    return guard(() => this.native.checkpoint());
  }

  restore(checkpoint: Uint8Array): void {
    guard(() => this.native.restore(checkpoint));
  }
}

export interface RunSimulationOptions extends RunOptions {
  readonly graph: LaneGraph;
}

export class EngineRuntime {
  constructor(readonly module: NativeModule) {}

  /** Engine semantic version and binding ABI version reported by the loaded module. */
  version(): { readonly engineVersion: string; readonly abiVersion: number } {
    return { engineVersion: this.module.engineVersion(), abiVersion: this.module.abiVersion() };
  }

  /** Decode a topology index (object or plain/gzip bytes) into a native lane graph. */
  laneGraph(topology: TopologySource): LaneGraph {
    const bytes = topology instanceof Uint8Array ? topology : encoder.encode(JSON.stringify(topology));
    return guard(() => this.module.LaneGraph.fromTopology(bytes));
  }

  /** A map bundle from a bare topology: self-derived index, no physical signal catalog. */
  mapFromTopology(mapId: string, topology: TopologySource): NativeMap {
    const bytes = topology instanceof Uint8Array ? topology : encoder.encode(JSON.stringify(topology));
    return guard(() => this.module.MapBundle.fromTopology(mapId, bytes));
  }

  /** Validate a scenario document (raw input or `scenario-instance` envelope). */
  scenario(source: ScenarioSource): ScenarioInput {
    if (isNativeScenario(source)) return source;
    const document = typeof source === 'string' || source instanceof Uint8Array ? source : JSON.stringify(source);
    return guard(() => this.module.ScenarioInput.parse(document));
  }

  /** Whole-clip deterministic run. */
  runSimulation(input: ScenarioSource, options: RunSimulationOptions): SimResult {
    const { graph, ...overrides } = options;
    const scenario = this.scenario(input);
    const optionsJson = Object.keys(overrides).length === 0 ? null : JSON.stringify(overrides);
    return JSON.parse(guard(() => this.module.runSimulation(scenario, graph, optionsJson))) as SimResult;
  }

  /** Feasibility guards alone — schema plus route/lane/spawn guards at t = 0 — without running the clip. */
  checkFeasibility(input: ScenarioSource, graph: LaneGraph): SimIssue[] {
    const scenario = this.scenario(input);
    return JSON.parse(guard(() => this.module.checkFeasibility(scenario, graph))) as SimIssue[];
  }

  /** A stepped world over `graph` (whose bundle carries the map's static colliders). Trace capture is on by default. */
  simulation(input: ScenarioSource, options: RunSimulationOptions): SimulationHandle {
    const { graph, ...overrides } = options;
    const scenario = this.scenario(input);
    const optionsJson = JSON.stringify({ captureTrace: true, ...overrides });
    return new SimulationHandle(guard(() => new this.module.Simulation(scenario, graph, optionsJson)));
  }

  /**
   * Generate background road users for any validated input (empty-world
   * previews, verified base instances); `compileTemplate` runs the same native
   * materialiser for templates. `preset: 'off'` returns the input unchanged.
   */
  materializeAmbientTraffic(
    input: ScenarioSource,
    graph: LaneGraph,
    profile: AmbientTrafficProfile,
    options: AmbientTrafficOptions = {},
  ): { readonly scenario: ScenarioInput; readonly provenance: AmbientTrafficProvenance } {
    const scenario = this.scenario(input);
    const optionsJson = Object.keys(options).length === 0 ? null : JSON.stringify(options);
    const [generated, provenanceJson] = guard(() => this.module.materializeAmbientTraffic(scenario, graph, JSON.stringify(profile), optionsJson));
    return { scenario: generated, provenance: JSON.parse(provenanceJson) as AmbientTrafficProvenance };
  }

  /** Parse plain or gzip trace bytes, or re-validate an in-memory trace document. */
  trace(source: TraceSource): TraceHandle {
    const bytes = source instanceof Uint8Array ? source : encoder.encode(typeof source === 'string' ? source : JSON.stringify(source));
    return new TraceHandle(guard(() => this.module.Trace.parse(bytes)));
  }

  traceDigest(source: TraceSource): string {
    return this.trace(source).digest();
  }

  evaluateTrace(source: TraceSource, filters?: EvaluateFilters): TraceEvaluation {
    return this.trace(source).evaluate(filters);
  }

  sceneState(source: TraceSource): SceneState {
    return this.trace(source).sceneState();
  }

  /** Flat action slot names in `ACTION_WIDTH` order, as the binding reports them. */
  actionFields(): string[] {
    return this.module.actionFields();
  }
}

export type { NativeSeed };
