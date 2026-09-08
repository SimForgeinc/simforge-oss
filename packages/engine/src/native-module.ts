/**
 * The host-neutral shape of the native runtime module.
 *
 * `@simforge-oss/native-runtime` (Node N-API) and `@simforge-oss/native-runtime/browser`
 * (WASM) expose the same classes and free functions; this interface names the
 * subset the engine and session façades bind to, so one façade implementation
 * serves both hosts. Exact implemented signatures live in
 * `native/crates/simforge-bindings-node/src/lib.rs` and the WASM equivalent.
 */

/** JS seed values the bindings accept. */
export type NativeSeed = number | string;

export interface NativeLaneGraph {
  /** `source.xodrSha256` of the topology; empty for synthetic topologies. */
  readonly digest: string;
  /** SHA-256 of the topology bytes the graph was decoded from. */
  readonly byteDigest: string;
  readonly laneCount: number;
  readonly laneIds: string[];
  laneLengthM(rsl: string): number;
  /** `[rsl, s, d]` of the nearest drivable lane, or `null`. */
  nearestLane(x: number, y: number, maxDistM?: number | null): [string, number, number] | null;
  laneWidthAt(rsl: string, s: number): number;
  /** `[x, y, headingRad]` at storage arc length `s` (clamped) along the lane. */
  sampleLane(rsl: string, s: number, reversed?: boolean | null): Float64Array;
  /** `[s, d]` projection of a point onto the lane polyline. */
  projectOntoLane(rsl: string, x: number, y: number): Float64Array;
  /** Directed successors as `[rsl, reversed]` pairs. */
  successors(rsl: string, reversed?: boolean | null): [string, boolean][];
  /** Whether nominal travel runs against storage order (`null` in junctions). */
  nominalReversed(rsl: string): boolean | null;
  /** The decoded `TopologyLane` record as JSON. */
  laneJson(rsl: string): string;
  /** Downstream-covering lane chain from a placement, or `null` when the topology cannot supply it. */
  defaultPlacementRoute(startRsl: string, startStorageS: number, requiredDownstreamM: number): NativePlacementRoute | null;
  /** Lane rsls of a turn-following route (`turns` are `TurnRelation` names), or `null`. */
  followRoute(startRsl: string, turns: string[], maxLengthM: number, startReversed?: boolean | null, strictTurns?: boolean): string[] | null;
  /** Build a `RouteSpec` JSON into a route handle; throws an `argument` error carrying the `RouteBuildError` JSON (`{code, reason, detail?}`). */
  route(specJson: string): NativeRoute;
  /** The lane's `TurnRelation` name, or `null` outside junctions. */
  turnRelationOf(rsl: string): string | null;
}

export interface NativePlacementRoute {
  readonly lanes: string[];
  readonly downstreamM: number;
}

/** A built route: the geometry the engine follows and the exporter samples. */
export interface NativeRoute {
  readonly lengthM: number;
  /** Lane chain of the route; empty for polyline routes. */
  readonly laneRsls: string[];
  /** `[x, y, headingRad]` in the engine frame at arc length `s` (clamped). */
  poseAt(s: number): Float64Array;
  /** `RouteSnapshot` JSON. */
  snapshotJson(): string;
  /** `[s, d]`: arc length of the closest point on the route, and its signed lateral offset. */
  projectPoint(x: number, y: number): Float64Array;
  /** `[s, d]` with an explicit coarse scan step; 0.5 m is stop-line-grade. */
  projectPointWithStep(x: number, y: number, stepM: number): Float64Array;
  /** Lane width at arc length `s` (clamped) - the basis of a lane-change separation. */
  widthAt(s: number): number;
  /** `RouteLegSnapshot[]`-shaped JSON: `[{rsl, reversed, sStartM, lengthM, turnRelation}]`. */
  legsJson(): string;
  /** `{x, y, headingRad, rsl, laneS, storageS, reversed, legIndex}` JSON at `s`. */
  poseJson(s: number): string;
  /** Re-base onto the lateral neighbour at `s`; `null` when the map has none there. */
  retargetToNeighbour(s: number, side: 'left' | 'right', legalOnly?: boolean | null, maxLengthM?: number | null): NativeNeighbourRetarget | null;
}

/** A route re-based onto its lateral neighbour, plus where the actor lands on it. */
export interface NativeNeighbourRetarget {
  readonly route: NativeRoute;
  /** `{s, separationM, legal, targetRsl}` JSON. */
  readonly detailJson: string;
}

export interface NativeScenarioInput {
  toJson(): string;
  withSeed(seed: NativeSeed): NativeScenarioInput;
  withClipSeconds(clipSeconds: number): NativeScenarioInput;
  readonly contentHash: string;
  readonly mapId: string;
  /** The authored seed as JSON (`number | string`). */
  readonly seedJson: string;
  readonly clipSeconds: number;
  readonly warmupSeconds: number;
  readonly dt: number;
  readonly metricSubject: string | null;
  readonly actorIds: string[];
  readonly physicsMode: string;
}

export interface NativeMapBundle {
  readonly mapId: string;
  readonly digest: string;
  readonly graph: NativeLaneGraph;
  /** `MapControlPlan` JSON derived from the bundle's signal catalog. */
  controlPlanJson(): string;
  /** The merged `TopologyIndex` (map speed limits applied) as JSON. */
  topologyJson(): string;
  /** The `MapSignalCatalog` as JSON. */
  signalCatalogJson(): string;
  /** The normalised `DerivedMapIndex` as JSON. */
  indexJson(): string;
  /** `StaticColliderDiagnostics` JSON: whether map collision proxies were present. */
  staticColliderDiagnosticsJson(): string;
  /** `SignalControlIndex` JSON: exact head/movement/controller/junction reverse indices of the map control plan. */
  signalControlIndexJson(): string;
  /** `SiteSignalPlan` JSON for a matched site handle. */
  siteSignalPlanJson(site: NativeSite): string;
  /** Program id an authored signal reference (`SiteSignalRef` JSON) resolves to at a matched site, or `null`. */
  resolveSiteSignalProgram(site: NativeSite, refJson: string): string | null;
}

/** One matched site as the native matcher holds it; `toJson()` is the full `MatchedSite` document. */
export interface NativeSite {
  readonly siteId: string;
  readonly mapId: string;
  toJson(): string;
}

export interface NativeCompileResult {
  readonly input: NativeScenarioInput;
  /** `InstanceManifest` JSON (notes included). */
  readonly manifestJson: string;
  /** Lowered observations `{id, condition}[]` JSON. */
  readonly observationsJson: string;
}

export interface NativeTrace {
  digest(): string;
  /** Quantised canonical JSON of the trace. */
  toJson(): string;
  sceneStateJson(): string;
  metricsJson(): string;
  /** `TraceEvaluation` JSON; `filtersJson` is an optional camelCase `EvaluateFilters` patch. */
  evaluateJson(filtersJson?: string | null): string;
  /** `IntentEvaluation` JSON for an `IntentRubric` document. */
  intentRubricJson(rubricJson: string): string;
  /** `BlindReviewPacket` JSON for an `IntentRubric` document. */
  blindReviewPacketJson(rubricJson: string): string;
  /** Tier-2 `InvariantResidualReport[]` JSON for a v2 template's `invariants`; `optionsJson` = `{scope, arrival, speedLimitKph}`. */
  invariantsJson(templateJson: string, optionsJson: string): string;
}

/** One decision's result; every typed array is an owned copy. */
export interface NativeStepResult {
  readonly tS: number;
  readonly reward: number;
  readonly terminated: boolean;
  readonly truncated: boolean;
  readonly stateVector: Float64Array;
  readonly objects: Float32Array;
  readonly objectCount: number;
  readonly objectIds: string[];
  readonly bev?: Float32Array;
  readonly rewardTerms: Float64Array;
  readonly infoJson: string;
}

export interface NativeBevShape {
  readonly height: number;
  readonly width: number;
  readonly channels: number;
}

export interface NativeEnvSession {
  readonly ego: string;
  readonly decisionHz: number;
  readonly decisionTicks: number;
  readonly clipSeconds: number;
  readonly maxObjects: number;
  readonly bevShape: NativeBevShape | null | undefined;
  reset(seed?: NativeSeed | null): NativeStepResult;
  /** `action` is one flat `Float64Array(ACTION_WIDTH)` row (NaN = unset) or `null` for choreography. */
  step(action?: Float64Array | null): NativeStepResult;
  checkpoint(): Uint8Array;
  restore(checkpoint: Uint8Array): NativeStepResult;
  /** `[tS, x, y, yawRad, speedMps]`. */
  egoPose(): Float64Array;
  /** Actors in the world at the observation instant; throws before `reset()`. */
  readonly actorCount: number;
  /** Canonical ids in snapshot order — the row order of `actors()`, `present()` and `actorDims`; throws before `reset()`. */
  readonly actorIds: string[];
  readonly actorKinds: string[];
  /** `Float64Array(N * 3)` rows `[lengthM, widthM, heightM]`. */
  readonly actorDims: Float64Array;
  /** `Float64Array(N * ACTOR_ROW)` rows `[x, y, headingRad, speedMps, accelMps2, lateralOffsetM, lateralRateMps, s]`, xodr-local, at the observation instant. */
  actors(): Float64Array;
  present(): Uint8Array;
  signalBookJson(): string;
  /** The accumulated `CausalChannel` of the current episode as JSON. */
  causalChannelJson(): string;
}

export interface NativeBatchResult {
  readonly size: number;
  readonly tS: Float64Array;
  readonly reward: Float64Array;
  readonly terminated: Uint8Array;
  readonly truncated: Uint8Array;
  readonly stateVector: Float64Array;
  readonly objects: Float32Array;
  readonly objectCount: Uint32Array;
  readonly rewardTerms: Float64Array;
  readonly bev?: Float32Array;
}

export interface NativeSessionBatch {
  readonly size: number;
  readonly egos: string[];
  readonly decisionHz: number;
  readonly maxObjects: number;
  readonly bevShape: NativeBevShape | null | undefined;
  resetAll(seeds?: NativeSeed[] | null): NativeBatchResult;
  resetWorlds(worlds: number[] | Uint32Array, seeds?: (NativeSeed | null)[] | null): NativeBatchResult;
  /** `actions` is `Float64Array(N * ACTION_WIDTH)`; `mask[i] == 0` skips world `i`. */
  stepBatch(actions: Float64Array, mask?: Uint8Array | null): NativeBatchResult;
  objectIds(world: number): string[];
  infoJson(world: number): string;
  checkpoint(world: number): Uint8Array;
  restore(world: number, checkpoint: Uint8Array): void;
}

export interface NativeWorldSnapshot {
  readonly tS: number;
  readonly tick: number;
  readonly done: boolean;
  readonly actorIds: string[];
  readonly kinds: string[];
  readonly laneRsls: (string | null | undefined)[];
  readonly present: Uint8Array;
  /** `(N, 5)` rows `[x, z, headingRad, speedMps, s]` in the scene frame. */
  readonly pose: Float64Array;
}

export interface NativeTruthSubscription {
  /** Every queued tick frame as `u32le length || msgpack(TruthFrame)`, oldest first. */
  drainFrames(): Uint8Array[];
  readonly dropped: number;
  readonly queued: number;
  readonly active: boolean;
  close(): void;
}

export interface NativeWorldSession {
  readonly time: number;
  readonly tick: number;
  readonly digest: string;
  /** Apply one `WorldCommand` JSON; returns the `CommandOutcome` JSON. */
  command(commandJson: string, clientId?: string | null, seq?: number | null): string;
  /** Advance engine ticks; returns the `AdvanceResult` JSON. */
  advance(ticks: number): string;
  snapshot(): NativeWorldSnapshot;
  subscribe(capacity?: number | null): NativeTruthSubscription;
  logJson(): string;
  checkpoint(): Uint8Array;
  restore(checkpoint: Uint8Array): void;
}

export interface NativePolicyStepResult {
  readonly step: NativeStepResult;
  readonly deadlineLimitMs?: number;
  readonly deadlineElapsedMs?: number;
  readonly deadlineMiss: boolean;
  /** `policy | repeat-last | zero-control | scripted`. */
  readonly applied: string;
  readonly executorJson?: string;
}

export interface NativePolicySession {
  readonly ego: string;
  readonly execution: string;
  reset(seed?: NativeSeed | null): NativeStepResult;
  actControl(throttle: number, brake: number, steer: number, elapsedMs?: number | null): NativePolicyStepResult;
  /** `points` is `Float64Array(K * 5)` rows `[x, y, headingRad, speedMps, tS]` in the ego frame at issuance. */
  actTrajectory(points: Float64Array, elapsedMs?: number | null): NativePolicyStepResult;
  checkpoint(): Uint8Array;
  egoPose(): Float64Array;
}

/** Bare engine world: explicit per-actor action batches, no episode semantics. */
export interface NativeSimulation {
  readonly tS: number;
  readonly dtS: number;
  readonly tickIndex: number;
  readonly done: boolean;
  readonly actorCount: number;
  readonly actorIds: string[];
  readonly actorKinds: string[];
  /** `Float64Array(N * 3)` rows `[lengthM, widthM, heightM]`. */
  readonly actorDims: Float64Array;
  actorIndex(id: string): number;
  /** `actions` rows are `[actorIndex, ...ACTION_WIDTH slots]`; returns `[ticksAdvanced, done ? 1 : 0]`. */
  advance(maxTicks: number, actions?: Float64Array | null): Float64Array | number[];
  /** `Float64Array(N * ACTOR_ROW)` rows `[x, y, headingRad, speedMps, accelMps2, lateralOffsetM, lateralRateMps, s]`, xodr-local. */
  actors(): Float64Array;
  present(): Uint8Array;
  laneRsls(): (string | null | undefined)[];
  minimaJson(): string;
  drainEventsJson(): string;
  signalStateJson(): string;
  checkpoint(): Uint8Array;
  restore(checkpoint: Uint8Array): void;
  /** The trace recorded so far (captured warmup included when requested) without advancing or finalising the world. */
  traceJson(): string;
  /** The exact normalised, control/arrival-resolved `SimScenarioInput` this world executes. */
  inputJson(): string;
  /** `SimIssue[]` JSON raised so far. */
  issuesJson(): string;
  /** `ArrivalSolution[]` JSON of the arrival solve. */
  arrivalJson(): string;
  /** `SimResult` JSON once `done`; an `engine` error before that. */
  resultJson(): string;
}

/**
 * Contact-ownership handoff between an external traffic provider (browser
 * SUMO) and the native contact solver. Poses are scene ground-plane `x/z`;
 * released bodies stay owned by physics until `clear()`.
 */
export interface NativeTrafficHandoff {
  readonly bodyCount: number;
  /** Traffic actors currently owned by physics. */
  readonly trafficBodyCount: number;
  /** `StaticMapCollider[]` JSON (scene-frame OBBs) released bodies collide with; retained across `clear()`. */
  setStaticColliders(collidersJson: string): void;
  clear(): void;
  /**
   * One provider interval. `authored`/`traffic` are `Float64Array(N * HANDOFF_ACTOR_ROW)` rows
   * `[x, z, headingRad, speedMps, lengthM, widthM, present, static]` with one id and kind per row.
   * Returns the number of traffic actors released to physics during this step.
   */
  step(
    dtS: number,
    authoredIds: string[],
    authoredKinds: string[],
    authored: Float64Array,
    trafficIds: string[],
    trafficKinds: string[],
    traffic: Float64Array,
  ): number;
  /** Released body ids in `bodies()` row order. */
  bodyIds(): string[];
  /** `Float64Array(N * HANDOFF_BODY_ROW)` rows `[origin, x, z, headingRad, speedMps, angularVelocityRadS]`; `origin` 0 = traffic, 1 = authored. */
  bodies(): Float64Array;
}

/** Per-tick action supplier for declared policy roles during situation rehearsal. */
export type NativePolicyHook = (contextJson: string) => string | null;

export interface NativeModule {
  readonly LaneGraph: { fromTopology(data: Uint8Array): NativeLaneGraph };
  readonly ScenarioInput: { parse(document: string | Uint8Array): NativeScenarioInput };
  readonly MapBundle: {
    load(path: string): NativeMapBundle;
    fromTopology(mapId: string, topology: Uint8Array): NativeMapBundle;
    /** `sourcesJson` = `{mapId, derived?, locations?, searchIndex?, xodr?, signalsGeojson?}`. */
    /** `sourcesJson` = `{mapId, xodr?, derived?, locations?, signalsGeojson?, staticColliders?: StaticMapCollider[]}`. */
    fromSources(sourcesJson: string, topology: Uint8Array): NativeMapBundle;
  };
  readonly Trace: { parse(data: Uint8Array): NativeTrace };
  readonly EnvSession: new (
    input: NativeScenarioInput,
    graph: NativeLaneGraph,
    episodeJson?: string | null,
    maxObjects?: number | null,
  ) => NativeEnvSession;
  readonly SessionBatch: new (
    inputs: NativeScenarioInput[],
    graphs: NativeLaneGraph[],
    episodeJson?: string | null,
    threads?: number | null,
    maxObjects?: number | null,
  ) => NativeSessionBatch;
  readonly WorldSession: new (input: NativeScenarioInput, graph: NativeLaneGraph, optionsJson?: string | null) => NativeWorldSession;
  readonly PolicySession: new (
    input: NativeScenarioInput,
    graph: NativeLaneGraph,
    episodeJson?: string | null,
    deadlineMs?: number | null,
    fallback?: string | null,
    execution?: string | null,
    maxObjects?: number | null,
  ) => NativePolicySession;
  readonly Simulation: new (input: NativeScenarioInput, graph: NativeLaneGraph, optionsJson?: string | null) => NativeSimulation;
  readonly TrafficHandoff: new () => NativeTrafficHandoff;

  /** `site` is a matcher site id; `null` = the top-ranked site. */
  compileTemplate(templateJson: string, bundle: NativeMapBundle, site: string | null, seed?: NativeSeed | null, optionsJson?: string | null): NativeCompileResult;
  /** Match one site by id (`null` = top-ranked; an explicit id may name a rejected site) as a native handle. */
  findSite(templateJson: string, bundle: NativeMapBundle, siteId: string | null): NativeSite;
  /** The engine's own motion envelope for an actor class, as JSON. */
  motionLimitsJson(kind: string): string;
  /** `AdaptNote[]` JSON: clauses the anchor adapter drops or rewrites before matching. */
  adaptTemplateNotesJson(templateJson: string): string;
  /** `{templateId, paramsVersion}` JSON - the replay-key identity of a template. */
  templateIdentityJson(templateJson: string): string;
  /** `sha256(templateId|paramsVersion|siteId|drawIndex)`, the per-cell parameter seed. */
  cellSeed(templateId: string, paramsVersion: string, siteId: string, drawIndex: number): string;
  findSites(templateJson: string, bundle: NativeMapBundle): string[];
  /** Returns `[scenarioInput, boundSituationJson]`. */
  compileSituation(documentJson: string, bundle: NativeMapBundle, optionsJson?: string | null): [NativeScenarioInput, string];
  /** `SituationRehearsal` JSON. `policy` supplies actions for declared policy roles: `(contextJson) => actionJson | null`. */
  rehearseSituation(documentJson: string, bundle: NativeMapBundle, optionsJson?: string | null, policy?: NativePolicyHook | null): string;
  /** `SituationSolveResult` JSON; `onEvaluation` receives `{program, rehearsal}` JSON per evaluation and a throw aborts the solve. */
  solveSituation(documentJson: string, bundle: NativeMapBundle, optionsJson?: string | null, onEvaluation?: ((evaluationJson: string) => void) | null, policy?: NativePolicyHook | null): string;
  /** `SituationComparison` JSON. */
  compareSituation(documentJson: string, transactionJson: string, bundle: NativeMapBundle, optionsJson?: string | null, policy?: NativePolicyHook | null): string;
  /** `{mapId, report: MatchReport, notes}` JSON; `optionsJson` = `{minScore?, maxSites?, exactCatalogSiteResolution?}`. */
  matchSites(templateJson: string, bundle: NativeMapBundle, optionsJson?: string | null): string;
  /** Run a whole clip; returns the `SimResult` JSON document. */
  runSimulation(input: NativeScenarioInput, graph: NativeLaneGraph, optionsJson?: string | null): string;
  /** Feasibility guards alone (schema + route/lane/spawn guards at t = 0), no run; returns `SimIssue[]` JSON. */
  checkFeasibility(input: NativeScenarioInput, graph: NativeLaneGraph): string;
  replayWorldLog(logJson: string, input: NativeScenarioInput, graph: NativeLaneGraph): string;
  /**
   * Append generated background road users to any validated input (not only inside `compileTemplate`).
   * `profileJson` is an `AmbientTrafficProfile`; `optionsJson` is an `AmbientTrafficOptions` document.
   * Returns the generated scenario and its `AmbientTrafficProvenance` JSON.
   */
  materializeAmbientTraffic(input: NativeScenarioInput, graph: NativeLaneGraph, profileJson: string, optionsJson?: string | null): [NativeScenarioInput, string];

  canonicalJson(document: string): string;
  contentHash(document: string): string;
  sha256Hex(data: Uint8Array): string;
  engineVersion(): string;
  abiVersion(): number;
  actionFields(): string[];
}
