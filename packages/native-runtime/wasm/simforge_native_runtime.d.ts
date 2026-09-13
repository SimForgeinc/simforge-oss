/* tslint:disable */
/* eslint-disable */

export class BatchResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    get bev(): Float32Array | undefined;
    set bev(value: Float32Array | null | undefined);
    objectCount: Uint32Array;
    objects: Float32Array;
    rewardTerms: Float64Array;
    reward: Float64Array;
    size: number;
    stateVector: Float64Array;
    tS: Float64Array;
    terminated: Uint8Array;
    truncated: Uint8Array;
}

export class CompileResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly input: ScenarioInput;
    readonly manifestJson: string;
    readonly observationsJson: string;
}

export class EnvSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `Float64Array(N * ACTOR_ROW)` rows `[x, y, headingRad, speedMps, accelMps2, lateralOffsetM, lateralRateMps, s]` (xodr-local) at the observation instant.
     */
    actors(): Float64Array;
    /**
     * The accumulated `CausalChannel` of the current episode as JSON.
     */
    causalChannelJson(): string;
    checkpoint(): Uint8Array;
    egoPose(): Float64Array;
    constructor(input: ScenarioInput, graph: LaneGraph, episode_json?: string | null, max_objects?: number | null);
    present(): Uint8Array;
    reset(seed: any): StepResult;
    restore(checkpoint: Uint8Array): StepResult;
    signalBookJson(): string;
    /**
     * `action`: `Float64Array(ACTION_WIDTH)` (NaN = unset) or `null`.
     */
    step(action?: Float64Array | null): StepResult;
    /**
     * Actors in the world at the observation instant; throws before `reset()`.
     */
    readonly actorCount: number;
    /**
     * `Float64Array(N * 3)` rows `[l, w, h]`.
     */
    readonly actorDims: Float64Array;
    /**
     * Canonical ids in snapshot order (the row order of `actors()`/`present()`/`actorDims`); throws before `reset()`.
     */
    readonly actorIds: any[];
    readonly actorKinds: any[];
    /**
     * `Uint32Array [height, width, channels]` or `null`.
     */
    readonly bevShape: any;
    readonly clipSeconds: number;
    readonly decisionHz: number;
    readonly decisionTicks: number;
    readonly ego: string;
    readonly maxObjects: number;
}

export class LaneGraph {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `{lanes: string[], downstreamM}` or `null` when no route provides the runway.
     */
    defaultPlacementRoute(start_rsl: string, start_storage_s: number, required_downstream_m: number): any;
    /**
     * Lane rsls walking successors consuming `turns`; `null` when `strictTurns` finds a turn unavailable.
     */
    followRoute(start_rsl: string, turns: string[], max_length_m: number, start_reversed?: boolean | null, strict_turns?: boolean | null): any;
    static fromTopology(data: Uint8Array): LaneGraph;
    laneJson(rsl: string): string;
    laneLengthM(rsl: string): number;
    laneWidthAt(rsl: string, s: number): number;
    /**
     * `[rsl, s, d]` or `null`.
     */
    nearestLane(x: number, y: number, max_dist_m?: number | null): any;
    nominalReversed(rsl: string): boolean | undefined;
    /**
     * `[s, d]` projection of a point onto the lane polyline.
     */
    projectOntoLane(rsl: string, x: number, y: number): Float64Array;
    /**
     * Resolve a `RouteSpec` document to a route handle; throws the `RouteBuildError` JSON on failure.
     */
    route(spec_json: string): Route;
    /**
     * `[x, y, headingRad]` at arc length `s` measured along the traversal direction (`reversed` = from the last polyline point, storage `len - s`).
     */
    sampleLane(rsl: string, s: number, reversed?: boolean | null): Float64Array;
    /**
     * Directed successors as `[[rsl, reversed], ...]`.
     */
    successors(rsl: string, reversed?: boolean | null): Array<any>;
    turnRelationOf(rsl: string): string | undefined;
    readonly byteDigest: string;
    readonly digest: string;
    readonly laneCount: number;
    readonly laneIds: any[];
}

export class MapBundle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    controlPlanJson(): string;
    /**
     * Bundle from in-memory sources: `sourcesJson = {mapId, derived?, locations?, searchIndex?, xodr?, signalsGeojson?}` plus the topology sidecar bytes.
     */
    static fromSources(sources_json: string, topology: Uint8Array): MapBundle;
    static fromTopology(map_id: string, topology: Uint8Array): MapBundle;
    indexJson(): string;
    /**
     * Filesystem map corpora do not exist in the browser; fetch the artifacts
     * and use `fromTopology` (or the Node binding).
     */
    static load(_path: string): MapBundle;
    resolveSiteSignalProgram(site: Site, ref_json: string): string | undefined;
    signalCatalogJson(): string;
    signalControlIndexJson(): string;
    siteSignalPlanJson(site: Site): string;
    staticColliderDiagnosticsJson(): string;
    topologyJson(): string;
    readonly digest: string;
    readonly graph: LaneGraph;
    readonly mapId: string;
}

export class PolicySession {
    free(): void;
    [Symbol.dispose](): void;
    actControl(throttle: number, brake: number, steer: number, elapsed_ms?: number | null): PolicyStepResult;
    actTrajectory(points: Float64Array, elapsed_ms?: number | null): PolicyStepResult;
    checkpoint(): Uint8Array;
    egoPose(): Float64Array;
    constructor(input: ScenarioInput, graph: LaneGraph, episode_json?: string | null, deadline_ms?: number | null, fallback?: string | null, execution?: string | null, max_objects?: number | null);
    reset(seed: any): StepResult;
    restore(checkpoint: Uint8Array): StepResult;
    readonly ego: string;
    readonly execution: string;
}

export class PolicyStepResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    applied: string;
    get deadlineElapsedMs(): number | undefined;
    set deadlineElapsedMs(value: number | null | undefined);
    get deadlineLimitMs(): number | undefined;
    set deadlineLimitMs(value: number | null | undefined);
    deadlineMiss: boolean;
    get executorJson(): string | undefined;
    set executorJson(value: string | null | undefined);
    step: StepResult;
}

/**
 * A resolved route: engine-frame geometry plus its persisted snapshot.
 */
export class Route {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `[x, y, headingRad]` at arc length `s` (clamped).
     */
    poseAt(s: number): Float64Array;
    snapshotJson(): string;
    /**
     * Empty for polyline routes.
     */
    readonly laneRsls: any[];
    readonly lengthM: number;
}

export class ScenarioInput {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Validate a scenario JSON document (string or bytes).
     */
    static parse(document: any): ScenarioInput;
    toJson(): string;
    withClipSeconds(clip_seconds: number): ScenarioInput;
    withSeed(seed: any): ScenarioInput;
    readonly actorIds: any[];
    readonly clipSeconds: number;
    readonly contentHash: string;
    readonly dt: number;
    readonly mapId: string;
    readonly metricSubject: string | undefined;
    readonly physicsMode: string;
    readonly seedJson: string;
    readonly warmupSeconds: number;
}

export class SessionBatch {
    free(): void;
    [Symbol.dispose](): void;
    checkpoint(world: number): Uint8Array;
    infoJson(world: number): string;
    /**
     * `inputs`/`graphs` are same-length arrays of `ScenarioInput`/`LaneGraph`.
     * WASM has no threads: worlds step sequentially with identical results.
     */
    constructor(inputs: ScenarioInput[], graphs: LaneGraph[], episode_json?: string | null, max_objects?: number | null);
    objectIds(world: number): any[];
    resetAll(seeds: any): BatchResult;
    resetWorlds(worlds: Uint32Array, seeds: any): BatchResult;
    restore(world: number, checkpoint: Uint8Array): void;
    stepBatch(actions: Float64Array, mask?: Uint8Array | null): BatchResult;
    readonly bevShape: any;
    readonly decisionHz: number;
    readonly egos: any[];
    readonly maxObjects: number;
    readonly size: number;
}

export class Simulation {
    free(): void;
    [Symbol.dispose](): void;
    actorIndex(id: string): number;
    actors(): Float64Array;
    /**
     * `actions`: `Float64Array(K * (1 + ACTION_WIDTH))` rows `[actorIndex, ...action]`; returns `[ticksAdvanced, done ? 1 : 0]`.
     */
    advance(max_ticks: number, actions?: Float64Array | null): Uint32Array;
    arrivalJson(): string;
    checkpoint(): Uint8Array;
    drainEventsJson(): string;
    inputJson(): string;
    issuesJson(): string;
    laneRsls(): any[];
    minimaJson(): string;
    constructor(input: ScenarioInput, graph: LaneGraph, options_json?: string | null);
    present(): Uint8Array;
    restore(checkpoint: Uint8Array): void;
    /**
     * The completed run's `SimResult` JSON; errors until `done`.
     */
    resultJson(): string;
    signalStateJson(): string;
    /**
     * Recorded trace prefix; does not advance or finalize the simulation.
     */
    traceJson(): string;
    readonly actorCount: number;
    readonly actorDims: Float64Array;
    readonly actorIds: any[];
    readonly actorKinds: any[];
    readonly done: boolean;
    readonly dtS: number;
    readonly tS: number;
    readonly tickIndex: number;
}

/**
 * One grounded matched site (native handle; `toJson()` for the `MatchedSite` document).
 */
export class Site {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    toJson(): string;
    readonly mapId: string;
    readonly siteId: string;
}

/**
 * One decision's result; typed arrays are owned copies.
 */
export class StepResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    get bev(): Float32Array | undefined;
    set bev(value: Float32Array | null | undefined);
    infoJson: string;
    objectCount: number;
    objectIds: any[];
    objects: Float32Array;
    rewardTerms: Float64Array;
    reward: number;
    stateVector: Float64Array;
    tS: number;
    terminated: boolean;
    truncated: boolean;
}

export class Trace {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    behaviorSummaryJson(limits_json?: string | null): string;
    blindReviewPacketJson(rubric_json: string): string;
    digest(): string;
    evaluateJson(filters_json?: string | null): string;
    intentRubricJson(rubric_json: string): string;
    invariantsJson(template_json: string, options_json?: string | null): string;
    metricsJson(): string;
    static parse(data: Uint8Array): Trace;
    sceneStateJson(): string;
    toJson(): string;
}

/**
 * Contact-ownership handoff between an external traffic provider (browser
 * SUMO) and the native contact solver. Poses are scene ground-plane `x/z`;
 * released bodies stay owned until `clear()`.
 */
export class TrafficHandoff {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `Float64Array(N * handoffBodyRow())` rows `[origin, x, z, headingRad, speedMps, angularVelocityRadS]`; `origin` 0 = traffic, 1 = authored.
     */
    bodies(): Float64Array;
    /**
     * Released body ids in `bodies()` row order.
     */
    bodyIds(): any[];
    /**
     * Return every actor to its owner.
     */
    clear(): void;
    constructor();
    /**
     * `StaticMapCollider[]` JSON (scene-frame OBBs) released bodies collide with; retained across `clear()`.
     */
    setStaticColliders(colliders_json: string): void;
    /**
     * One provider interval. `authored`/`traffic` are `Float64Array(N * handoffActorRow())` rows
     * `[x, z, headingRad, speedMps, lengthM, widthM, present, static]` with one id and kind per row.
     * Returns the number of traffic actors released to physics during this step.
     */
    step(dt_s: number, authored_ids: string[], authored_kinds: string[], authored: Float64Array, traffic_ids: string[], traffic_kinds: string[], traffic: Float64Array): number;
    readonly bodyCount: number;
    /**
     * Traffic actors currently owned by physics.
     */
    readonly trafficBodyCount: number;
}

export class TruthSubscription {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    close(): void;
    /**
     * Every queued frame as `Uint8Array` = `u32le length || msgpack(TruthFrame)`.
     */
    drainFrames(): any[];
    drain(): any[];
    readonly active: boolean;
    readonly dropped: number;
    readonly queued: number;
}

export class WorldSession {
    free(): void;
    [Symbol.dispose](): void;
    advance(ticks: number): string;
    checkpoint(): Uint8Array;
    command(command_json: string, client_id?: string | null, seq?: number | null): string;
    logJson(): string;
    constructor(input: ScenarioInput, graph: LaneGraph, options_json?: string | null);
    restore(checkpoint: Uint8Array): void;
    /**
     * Hold one actor's pedals and wheel until replaced; pass `null` for
     * `throttle`, `brake` and `steer` together to release the actor back to
     * its scenario controller. Returns the `CommandOutcome` JSON.
     */
    setDriverCommand(actor_id: string, throttle?: number | null, brake?: number | null, steer?: number | null, handbrake?: boolean | null, client_id?: string | null, seq?: number | null): string;
    snapshot(): WorldSnapshot;
    subscribe(capacity?: number | null): TruthSubscription;
    readonly digest: string;
    readonly tick: number;
    readonly time: number;
}

export class WorldSnapshot {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    actorIds: any[];
    done: boolean;
    kinds: any[];
    laneRsls: any[];
    /**
     * `(N, 5)` rows `[x, z, headingRad, speedMps, s]`, scene frame.
     */
    pose: Float64Array;
    present: Uint8Array;
    tS: number;
    tick: number;
}

/**
 * Binding ABI version; the JS loader refuses any other value.
 */
export function abiVersion(): number;

export function actionFields(): any[];

export function actionWidth(): number;

export function actorRow(): number;

/**
 * `AdaptNote[]` JSON (`{path, reason, severity, code?}`); needs no map.
 */
export function adaptTemplateNotesJson(template_json: string): string;

/**
 * `SituationTransactionResult` JSON (no simulation).
 */
export function applySituationTransaction(document_json: string, transaction_json: string): string;

export function canonicalJson(document: string): string;

/**
 * `sha256(templateId|paramsVersion|siteId|drawIndex)`, the per-cell seed.
 */
export function cellSeed(template_id: string, params_version: string, site_id: string, draw_index: number): string;

/**
 * The `t = 0` feasibility guards alone; `SimIssue[]` JSON (no clip run).
 */
export function checkFeasibility(input: ScenarioInput, graph: LaneGraph): string;

/**
 * `SituationComparison` JSON. Options add `reactiveRoleIds?`.
 */
export function compareSituation(document_json: string, transaction_json: string, bundle: MapBundle, options_json?: string | null, policy?: Function | null): string;

/**
 * Returns `[ScenarioInput, boundSituationJson]`.
 */
export function compileSituation(document_json: string, bundle: MapBundle, options_json?: string | null): Array<any>;

/**
 * `site = null` picks the top-ranked matched site; map-bound documents skip matching.
 */
export function compileTemplate(template_json: string, bundle: MapBundle, site: string | null | undefined, seed: any, options_json?: string | null): CompileResult;

export function contentHash(document: string): string;

export function engineHz(): number;

export function engineVersion(): string;

/**
 * Resolve one site: `siteId = null` picks the top-ranked site.
 */
export function findSite(template_json: string, bundle: MapBundle, site_id?: string | null): Site;

export function findSites(template_json: string, bundle: MapBundle): any[];

/**
 * Row width of `TrafficHandoff.step` actor inputs.
 */
export function handoffActorRow(): number;

/**
 * Row width of `TrafficHandoff.bodies()`.
 */
export function handoffBodyRow(): number;

/**
 * Ranked `SiteMatch` JSON; `optionsJson = {minScore?, maxSites?, exactCatalogSiteResolution?}`.
 */
export function matchSites(template_json: string, bundle: MapBundle, options_json?: string | null): string;

/**
 * Returns `[ScenarioInput, provenanceJson]`.
 */
export function materializeAmbientTraffic(input: ScenarioInput, graph: LaneGraph, profile_json: string, options_json?: string | null): Array<any>;

export function objectFeatures(): number;

/**
 * `SituationRehearsal` JSON. `optionsJson = {materialize?, siteId?, geometryBindings?, runtime?}`.
 */
export function rehearseSituation(document_json: string, bundle: MapBundle, options_json?: string | null, policy?: Function | null): string;

export function replayWorldLog(log_json: string, input: ScenarioInput, graph: LaneGraph): string;

export function runSimulation(input: ScenarioInput, graph: LaneGraph, options_json?: string | null): string;

export function sha256Hex(data: Uint8Array): string;

/**
 * `SituationSolveResult` JSON; `onEvaluation` receives each `{program, rehearsal}` JSON.
 */
export function solveSituation(document_json: string, bundle: MapBundle, options_json?: string | null, on_evaluation?: Function | null, policy?: Function | null): string;

export function stateVectorSize(): number;

/**
 * `{templateId, paramsVersion}`: the replay-key identity of a template.
 */
export function templateIdentityJson(template_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_batchresult_free: (a: number, b: number) => void;
    readonly __wbg_compileresult_free: (a: number, b: number) => void;
    readonly __wbg_envsession_free: (a: number, b: number) => void;
    readonly __wbg_get_batchresult_bev: (a: number) => any;
    readonly __wbg_get_batchresult_objectCount: (a: number) => any;
    readonly __wbg_get_batchresult_objects: (a: number) => any;
    readonly __wbg_get_batchresult_reward: (a: number) => any;
    readonly __wbg_get_batchresult_rewardTerms: (a: number) => any;
    readonly __wbg_get_batchresult_size: (a: number) => number;
    readonly __wbg_get_batchresult_stateVector: (a: number) => any;
    readonly __wbg_get_batchresult_tS: (a: number) => any;
    readonly __wbg_get_batchresult_terminated: (a: number) => any;
    readonly __wbg_get_batchresult_truncated: (a: number) => any;
    readonly __wbg_get_policystepresult_applied: (a: number) => [number, number];
    readonly __wbg_get_policystepresult_deadlineElapsedMs: (a: number) => [number, number];
    readonly __wbg_get_policystepresult_deadlineLimitMs: (a: number) => [number, number];
    readonly __wbg_get_policystepresult_deadlineMiss: (a: number) => number;
    readonly __wbg_get_policystepresult_executorJson: (a: number) => [number, number];
    readonly __wbg_get_policystepresult_step: (a: number) => number;
    readonly __wbg_get_stepresult_bev: (a: number) => any;
    readonly __wbg_get_stepresult_infoJson: (a: number) => [number, number];
    readonly __wbg_get_stepresult_objectCount: (a: number) => number;
    readonly __wbg_get_stepresult_objectIds: (a: number) => [number, number];
    readonly __wbg_get_stepresult_objects: (a: number) => any;
    readonly __wbg_get_stepresult_reward: (a: number) => number;
    readonly __wbg_get_stepresult_rewardTerms: (a: number) => any;
    readonly __wbg_get_stepresult_stateVector: (a: number) => any;
    readonly __wbg_get_stepresult_tS: (a: number) => number;
    readonly __wbg_get_stepresult_terminated: (a: number) => number;
    readonly __wbg_get_stepresult_truncated: (a: number) => number;
    readonly __wbg_get_worldsnapshot_actorIds: (a: number) => [number, number];
    readonly __wbg_get_worldsnapshot_done: (a: number) => number;
    readonly __wbg_get_worldsnapshot_kinds: (a: number) => [number, number];
    readonly __wbg_get_worldsnapshot_laneRsls: (a: number) => [number, number];
    readonly __wbg_get_worldsnapshot_pose: (a: number) => any;
    readonly __wbg_get_worldsnapshot_present: (a: number) => any;
    readonly __wbg_get_worldsnapshot_tS: (a: number) => number;
    readonly __wbg_get_worldsnapshot_tick: (a: number) => number;
    readonly __wbg_lanegraph_free: (a: number, b: number) => void;
    readonly __wbg_mapbundle_free: (a: number, b: number) => void;
    readonly __wbg_policysession_free: (a: number, b: number) => void;
    readonly __wbg_policystepresult_free: (a: number, b: number) => void;
    readonly __wbg_route_free: (a: number, b: number) => void;
    readonly __wbg_scenarioinput_free: (a: number, b: number) => void;
    readonly __wbg_sessionbatch_free: (a: number, b: number) => void;
    readonly __wbg_set_batchresult_bev: (a: number, b: number) => void;
    readonly __wbg_set_batchresult_objectCount: (a: number, b: any) => void;
    readonly __wbg_set_batchresult_objects: (a: number, b: any) => void;
    readonly __wbg_set_batchresult_reward: (a: number, b: any) => void;
    readonly __wbg_set_batchresult_rewardTerms: (a: number, b: any) => void;
    readonly __wbg_set_batchresult_size: (a: number, b: number) => void;
    readonly __wbg_set_batchresult_stateVector: (a: number, b: any) => void;
    readonly __wbg_set_batchresult_tS: (a: number, b: any) => void;
    readonly __wbg_set_batchresult_terminated: (a: number, b: any) => void;
    readonly __wbg_set_batchresult_truncated: (a: number, b: any) => void;
    readonly __wbg_set_policystepresult_applied: (a: number, b: number, c: number) => void;
    readonly __wbg_set_policystepresult_deadlineElapsedMs: (a: number, b: number, c: number) => void;
    readonly __wbg_set_policystepresult_deadlineLimitMs: (a: number, b: number, c: number) => void;
    readonly __wbg_set_policystepresult_deadlineMiss: (a: number, b: number) => void;
    readonly __wbg_set_policystepresult_executorJson: (a: number, b: number, c: number) => void;
    readonly __wbg_set_policystepresult_step: (a: number, b: number) => void;
    readonly __wbg_set_stepresult_bev: (a: number, b: number) => void;
    readonly __wbg_set_stepresult_infoJson: (a: number, b: number, c: number) => void;
    readonly __wbg_set_stepresult_objectCount: (a: number, b: number) => void;
    readonly __wbg_set_stepresult_objectIds: (a: number, b: number, c: number) => void;
    readonly __wbg_set_stepresult_objects: (a: number, b: any) => void;
    readonly __wbg_set_stepresult_reward: (a: number, b: number) => void;
    readonly __wbg_set_stepresult_rewardTerms: (a: number, b: any) => void;
    readonly __wbg_set_stepresult_stateVector: (a: number, b: any) => void;
    readonly __wbg_set_stepresult_tS: (a: number, b: number) => void;
    readonly __wbg_set_stepresult_terminated: (a: number, b: number) => void;
    readonly __wbg_set_stepresult_truncated: (a: number, b: number) => void;
    readonly __wbg_set_worldsnapshot_actorIds: (a: number, b: number, c: number) => void;
    readonly __wbg_set_worldsnapshot_done: (a: number, b: number) => void;
    readonly __wbg_set_worldsnapshot_kinds: (a: number, b: number, c: number) => void;
    readonly __wbg_set_worldsnapshot_laneRsls: (a: number, b: number, c: number) => void;
    readonly __wbg_set_worldsnapshot_pose: (a: number, b: any) => void;
    readonly __wbg_set_worldsnapshot_present: (a: number, b: any) => void;
    readonly __wbg_set_worldsnapshot_tS: (a: number, b: number) => void;
    readonly __wbg_set_worldsnapshot_tick: (a: number, b: number) => void;
    readonly __wbg_simulation_free: (a: number, b: number) => void;
    readonly __wbg_site_free: (a: number, b: number) => void;
    readonly __wbg_stepresult_free: (a: number, b: number) => void;
    readonly __wbg_trace_free: (a: number, b: number) => void;
    readonly __wbg_traffichandoff_free: (a: number, b: number) => void;
    readonly __wbg_truthsubscription_free: (a: number, b: number) => void;
    readonly __wbg_worldsession_free: (a: number, b: number) => void;
    readonly __wbg_worldsnapshot_free: (a: number, b: number) => void;
    readonly abiVersion: () => number;
    readonly actionFields: () => [number, number];
    readonly actionWidth: () => number;
    readonly actorRow: () => number;
    readonly adaptTemplateNotesJson: (a: number, b: number) => [number, number, number, number];
    readonly applySituationTransaction: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly canonicalJson: (a: number, b: number) => [number, number, number, number];
    readonly cellSeed: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly checkFeasibility: (a: number, b: number) => [number, number, number, number];
    readonly compareSituation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly compileSituation: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly compileTemplate: (a: number, b: number, c: number, d: number, e: number, f: any, g: number, h: number) => [number, number, number];
    readonly compileresult_input: (a: number) => number;
    readonly compileresult_manifestJson: (a: number) => [number, number];
    readonly compileresult_observationsJson: (a: number) => [number, number];
    readonly contentHash: (a: number, b: number) => [number, number, number, number];
    readonly engineHz: () => number;
    readonly engineVersion: () => [number, number];
    readonly envsession_actorCount: (a: number) => [number, number, number];
    readonly envsession_actorDims: (a: number) => [number, number, number];
    readonly envsession_actorIds: (a: number) => [number, number, number, number];
    readonly envsession_actorKinds: (a: number) => [number, number, number, number];
    readonly envsession_actors: (a: number) => [number, number, number];
    readonly envsession_bevShape: (a: number) => any;
    readonly envsession_causalChannelJson: (a: number) => [number, number, number, number];
    readonly envsession_checkpoint: (a: number) => [number, number, number];
    readonly envsession_clipSeconds: (a: number) => number;
    readonly envsession_decisionHz: (a: number) => number;
    readonly envsession_decisionTicks: (a: number) => number;
    readonly envsession_ego: (a: number) => [number, number];
    readonly envsession_egoPose: (a: number) => [number, number, number];
    readonly envsession_maxObjects: (a: number) => number;
    readonly envsession_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly envsession_present: (a: number) => [number, number, number];
    readonly envsession_reset: (a: number, b: any) => [number, number, number];
    readonly envsession_restore: (a: number, b: number, c: number) => [number, number, number];
    readonly envsession_signalBookJson: (a: number) => [number, number, number, number];
    readonly envsession_step: (a: number, b: number) => [number, number, number];
    readonly findSite: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly findSites: (a: number, b: number, c: number) => [number, number, number, number];
    readonly handoffActorRow: () => number;
    readonly handoffBodyRow: () => number;
    readonly lanegraph_byteDigest: (a: number) => [number, number];
    readonly lanegraph_defaultPlacementRoute: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly lanegraph_digest: (a: number) => [number, number];
    readonly lanegraph_followRoute: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly lanegraph_fromTopology: (a: number, b: number) => [number, number, number];
    readonly lanegraph_laneCount: (a: number) => number;
    readonly lanegraph_laneIds: (a: number) => [number, number];
    readonly lanegraph_laneJson: (a: number, b: number, c: number) => [number, number, number, number];
    readonly lanegraph_laneLengthM: (a: number, b: number, c: number) => [number, number, number];
    readonly lanegraph_laneWidthAt: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly lanegraph_nearestLane: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly lanegraph_nominalReversed: (a: number, b: number, c: number) => [number, number, number];
    readonly lanegraph_projectOntoLane: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly lanegraph_route: (a: number, b: number, c: number) => [number, number, number];
    readonly lanegraph_sampleLane: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly lanegraph_successors: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly lanegraph_turnRelationOf: (a: number, b: number, c: number) => [number, number, number, number];
    readonly mapbundle_controlPlanJson: (a: number) => [number, number, number, number];
    readonly mapbundle_digest: (a: number) => [number, number];
    readonly mapbundle_fromSources: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mapbundle_fromTopology: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mapbundle_graph: (a: number) => number;
    readonly mapbundle_indexJson: (a: number) => [number, number, number, number];
    readonly mapbundle_load: (a: number, b: number) => [number, number, number];
    readonly mapbundle_mapId: (a: number) => [number, number];
    readonly mapbundle_resolveSiteSignalProgram: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly mapbundle_signalCatalogJson: (a: number) => [number, number, number, number];
    readonly mapbundle_signalControlIndexJson: (a: number) => [number, number, number, number];
    readonly mapbundle_siteSignalPlanJson: (a: number, b: number) => [number, number, number, number];
    readonly mapbundle_staticColliderDiagnosticsJson: (a: number) => [number, number, number, number];
    readonly mapbundle_topologyJson: (a: number) => [number, number, number, number];
    readonly matchSites: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly materializeAmbientTraffic: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly objectFeatures: () => number;
    readonly policysession_actControl: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly policysession_actTrajectory: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly policysession_checkpoint: (a: number) => [number, number, number];
    readonly policysession_ego: (a: number) => [number, number];
    readonly policysession_egoPose: (a: number) => [number, number, number];
    readonly policysession_execution: (a: number) => [number, number];
    readonly policysession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly policysession_reset: (a: number, b: any) => [number, number, number];
    readonly policysession_restore: (a: number, b: number, c: number) => [number, number, number];
    readonly rehearseSituation: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly replayWorldLog: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly route_laneRsls: (a: number) => [number, number];
    readonly route_lengthM: (a: number) => number;
    readonly route_poseAt: (a: number, b: number) => any;
    readonly route_snapshotJson: (a: number) => [number, number, number, number];
    readonly runSimulation: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scenarioinput_actorIds: (a: number) => [number, number];
    readonly scenarioinput_clipSeconds: (a: number) => number;
    readonly scenarioinput_contentHash: (a: number) => [number, number, number, number];
    readonly scenarioinput_dt: (a: number) => number;
    readonly scenarioinput_mapId: (a: number) => [number, number];
    readonly scenarioinput_metricSubject: (a: number) => [number, number];
    readonly scenarioinput_parse: (a: any) => [number, number, number];
    readonly scenarioinput_physicsMode: (a: number) => [number, number];
    readonly scenarioinput_seedJson: (a: number) => [number, number];
    readonly scenarioinput_toJson: (a: number) => [number, number, number, number];
    readonly scenarioinput_warmupSeconds: (a: number) => number;
    readonly scenarioinput_withClipSeconds: (a: number, b: number) => [number, number, number];
    readonly scenarioinput_withSeed: (a: number, b: any) => [number, number, number];
    readonly sessionbatch_bevShape: (a: number) => any;
    readonly sessionbatch_checkpoint: (a: number, b: number) => [number, number, number];
    readonly sessionbatch_decisionHz: (a: number) => number;
    readonly sessionbatch_egos: (a: number) => [number, number];
    readonly sessionbatch_infoJson: (a: number, b: number) => [number, number, number, number];
    readonly sessionbatch_maxObjects: (a: number) => number;
    readonly sessionbatch_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly sessionbatch_objectIds: (a: number, b: number) => [number, number, number, number];
    readonly sessionbatch_resetAll: (a: number, b: any) => [number, number, number];
    readonly sessionbatch_resetWorlds: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly sessionbatch_restore: (a: number, b: number, c: number, d: number) => [number, number];
    readonly sessionbatch_size: (a: number) => number;
    readonly sessionbatch_stepBatch: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly sha256Hex: (a: number, b: number) => [number, number];
    readonly simulation_actorCount: (a: number) => number;
    readonly simulation_actorDims: (a: number) => any;
    readonly simulation_actorIds: (a: number) => [number, number];
    readonly simulation_actorIndex: (a: number, b: number, c: number) => [number, number, number];
    readonly simulation_actorKinds: (a: number) => [number, number];
    readonly simulation_actors: (a: number) => any;
    readonly simulation_advance: (a: number, b: number, c: number) => [number, number, number];
    readonly simulation_arrivalJson: (a: number) => [number, number, number, number];
    readonly simulation_checkpoint: (a: number) => [number, number, number];
    readonly simulation_done: (a: number) => number;
    readonly simulation_drainEventsJson: (a: number) => [number, number, number, number];
    readonly simulation_dtS: (a: number) => number;
    readonly simulation_inputJson: (a: number) => [number, number, number, number];
    readonly simulation_issuesJson: (a: number) => [number, number, number, number];
    readonly simulation_laneRsls: (a: number) => [number, number];
    readonly simulation_minimaJson: (a: number) => [number, number, number, number];
    readonly simulation_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly simulation_present: (a: number) => any;
    readonly simulation_restore: (a: number, b: number, c: number) => [number, number];
    readonly simulation_resultJson: (a: number) => [number, number, number, number];
    readonly simulation_signalStateJson: (a: number) => [number, number, number, number];
    readonly simulation_tS: (a: number) => number;
    readonly simulation_tickIndex: (a: number) => number;
    readonly simulation_traceJson: (a: number) => [number, number, number, number];
    readonly site_mapId: (a: number) => [number, number];
    readonly site_siteId: (a: number) => [number, number];
    readonly site_toJson: (a: number) => [number, number, number, number];
    readonly solveSituation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly stateVectorSize: () => number;
    readonly templateIdentityJson: (a: number, b: number) => [number, number, number, number];
    readonly trace_behaviorSummaryJson: (a: number, b: number, c: number) => [number, number, number, number];
    readonly trace_blindReviewPacketJson: (a: number, b: number, c: number) => [number, number, number, number];
    readonly trace_digest: (a: number) => [number, number, number, number];
    readonly trace_evaluateJson: (a: number, b: number, c: number) => [number, number, number, number];
    readonly trace_intentRubricJson: (a: number, b: number, c: number) => [number, number, number, number];
    readonly trace_invariantsJson: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly trace_metricsJson: (a: number) => [number, number, number, number];
    readonly trace_parse: (a: number, b: number) => [number, number, number];
    readonly trace_sceneStateJson: (a: number) => [number, number, number, number];
    readonly trace_toJson: (a: number) => [number, number, number, number];
    readonly traffichandoff_bodies: (a: number) => any;
    readonly traffichandoff_bodyCount: (a: number) => number;
    readonly traffichandoff_bodyIds: (a: number) => [number, number];
    readonly traffichandoff_clear: (a: number) => void;
    readonly traffichandoff_new: () => number;
    readonly traffichandoff_setStaticColliders: (a: number, b: number, c: number) => [number, number];
    readonly traffichandoff_step: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number];
    readonly traffichandoff_trafficBodyCount: (a: number) => number;
    readonly truthsubscription_active: (a: number) => number;
    readonly truthsubscription_close: (a: number) => void;
    readonly truthsubscription_drain: (a: number) => [number, number, number, number];
    readonly truthsubscription_drainFrames: (a: number) => [number, number, number, number];
    readonly truthsubscription_dropped: (a: number) => number;
    readonly truthsubscription_queued: (a: number) => number;
    readonly worldsession_advance: (a: number, b: number) => [number, number, number, number];
    readonly worldsession_checkpoint: (a: number) => [number, number, number];
    readonly worldsession_command: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly worldsession_digest: (a: number) => [number, number];
    readonly worldsession_logJson: (a: number) => [number, number, number, number];
    readonly worldsession_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly worldsession_restore: (a: number, b: number, c: number) => [number, number];
    readonly worldsession_setDriverCommand: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number, number];
    readonly worldsession_snapshot: (a: number) => number;
    readonly worldsession_subscribe: (a: number, b: number) => [number, number, number];
    readonly worldsession_tick: (a: number) => number;
    readonly worldsession_time: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
