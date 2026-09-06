/**
 * `@simforge-oss/engine` — host-neutral contracts of the SimForge engine.
 *
 * The simulation itself runs in the native runtime. This entry carries what
 * both hosts share: the `SimScenarioInput` authoring contract (zod), the trace,
 * metrics, evaluation, scene-state and signal documents the runtime emits,
 * coordinate-frame helpers, canonical hashing and the ambient/SUMO interchange
 * formats. Execution façades live in `./node` (N-API) and `./browser` (WASM):
 *
 * ```ts
 * import { buildLaneGraph, runSimulation, evaluateTrace } from '@simforge-oss/engine/node';
 * const graph = buildLaneGraph(topologyBytes);
 * const { trace } = runSimulation(parseSimScenarioInput(doc), { graph });
 * const verdict = evaluateTrace(trace);
 * ```
 */

/* ------------------------------------------------------------- the contract */
export {
  simScenarioInputSchema,
  parseSimScenarioInput,
  safeParseSimScenarioInput,
  normalizeSimScenarioInput,
  resolvePhysicsConfig,
  ACTOR_KINDS,
  MOTION_PHYSICS_MODES,
  DEFAULT_MOTION_PHYSICS_MODE,
  DYNAMIC_V1_DEFAULT_SUBSTEP_S,
  DEFAULT_ACTOR_DIMS,
  CONTROL_INDICATIONS,
  isPedestrianLikeKind,
  isRoadActorKind,
  actorSchema,
  actorRulesSchema,
  arrivalSpecSchema,
  conditionSchema,
  dynamicsSchema,
  interactionSchema,
  laneRefSchema,
  occluderSchema,
  occlusionPairSchema,
  nearMissCriterionSchema,
  operationalConditionsSchema,
  motionPhysicsModeSchema,
  physicsConfigSchema,
  vehiclePhysicsProfileSchema,
  poseSchema,
  regionSchema,
  routeSpecSchema,
  roadControlSchema,
  signalProgramSchema,
  surfacePatchSchema,
  staticPropSchema,
  triggerSchema,
  verbSchema,
} from './schema/input.js';
export type {
  ActorKind,
  ActorRules,
  ArrivalPoint,
  ArrivalSpec,
  Condition,
  ControlIndication,
  Dims,
  Dynamics,
  Interaction,
  LaneChangeTarget,
  LaneRef,
  Occluder,
  OcclusionPair,
  NearMissCriterion,
  OperationalConditions,
  MotionPhysicsMode,
  PhysicsConfig,
  ResolvedPhysicsConfig,
  VehiclePhysicsProfile,
  Pose,
  Region,
  RoadControl,
  RouteSpec,
  ScenePoint,
  SignalProgram,
  SimActor,
  SimSchemaIssue,
  SimScenarioInput,
  SimScenarioInputSpec,
  SpeedTarget,
  StaticProp,
  SurfacePatch,
  Trigger,
  TurnRelation,
  VerbSpec,
} from './schema/input.js';
export { pruneDanglingAfterInteractions } from './schema/repair.js';
export type { RemovedDanglingInteraction } from './schema/repair.js';
export { SURFACE_KINDS, SURFACE_KIND_FRICTION_SCALE } from './environment.js';
export type { SurfaceKind } from './environment.js';
export { actorPhysicsBackend, actorPhysicsBackends, physicsBackendCounts } from './physics-provenance.js';

/* ------------------------------------------------------------------ frames */
export { localFromScene, toSceneXZ, sceneHeading } from './frames.js';
export type { SceneXZ } from './frames.js';

/* -------------------------------------------------------------------- maps */
export { pointOf } from './map/topology.js';
export { decodeTopologyIndex } from './map/decode-topology.js';
export type { TopologyIndexFile } from './map/decode-topology.js';
export type {
  LaneRsl,
  PolylinePoint,
  TopologyAdjacentLane,
  TopologyGate,
  TopologyIndex,
  TopologyJunction,
  TopologyLane,
  TopologyLaneChangePermission,
  TurnRelationName,
} from './map/topology.js';

/* ------------------------------------------------------------- run results */
export type { ArrivalSolution, RunOptions, SimResult, StaticColliderClass, StaticMapCollider } from './result.js';

/* ----------------------------------------------------------------- signals */
export { DEFAULT_DARK_DWELL_S, DEFAULT_DARK_FALLBACK, SIGNAL_SNAPSHOT_TICK_HZ } from './signals.js';
export type { ControlBindingRepair, SignalPhase, SignalSnapshot, SignalState, StopLineAuthority, StopLineBinding } from './signals.js';

/* ------------------------------------------------------------------- trace */
export { traceToSceneFrame, TRACE_FORMAT_VERSION, TRACE_PRECISION } from './trace/trace.js';
export type {
  ActorTrack,
  ActorPhysicsTrack,
  ActorPhysicsBackendProvenance,
  TraceActorMetadata,
  DeclaredOcclusionMetric,
  DeclaredOcclusionStatus,
  EpisodeMetrics,
  InvariantResidual,
  OccluderIneffective,
  MinTtcRecord,
  MinPathTtcRecord,
  MinPetRecord,
  CriticalitySamples,
  PairMinDistance,
  RevealToConflict,
  SceneTrace,
  SignalTrack,
  SimEvent,
  SimTrace,
  TraceHeader,
  PhysicsTraceProvenance,
} from './trace/trace.js';
export { decodeTraceGz, encodeTraceGz, gunzipBytes, gzipBytes, isGzipBytes } from './trace/gzip.js';
export { DEFAULT_MAX_DECEL_MPS2, DEFAULT_TRIVIAL_PET_S, DEFAULT_TRIVIAL_TTC_S } from './trace/evaluate.js';
export type { EvaluateFilters, InvariantCheckOptions, InvariantResidualReport, RejectCode, RejectFinding, TraceEvaluation } from './trace/evaluate.js';
export { intentCriterionSchema, intentRubricSchema } from './trace/intent-rubric.js';
export type {
  BehaviorSummary,
  BlindReviewPacket,
  CriterionStatus,
  CriterionVerdict,
  IntentCriterion,
  IntentCriterionInput,
  IntentEvaluation,
  IntentRubric,
  IntentRubricInput,
  TraceEvidence,
} from './trace/intent-rubric.js';

/* -------------------------------------------------------------- perception */
export {
  atmosphereSchema,
  detectionModelSchema,
  emissiveGlareSchema,
  mapDivergenceSchema,
  mapDivergenceKindSchema,
  perceptionConfigSchema,
  simSensorSchema,
  sensorApertureSchema,
  sensorMountSchema,
  DEFAULT_PERCEPTION_CONFIG,
  MAP_DIVERGENCE_KINDS,
} from './perception/schema.js';
export type {
  Atmosphere,
  DetectionModel,
  EmissiveGlare,
  MapDivergence,
  MapDivergenceExtent,
  MapDivergenceKind,
  PerceptionConfig,
  SensorAperture,
  SensorMount,
  SimSensor,
} from './perception/schema.js';
export {
  sensorChannelKey,
  SENSOR_TRACE_PRECISION,
  SENSOR_TRACE_REASON_LEGEND,
  SENSOR_TRACE_STATUS_LEGEND,
} from './trace/sensor-track.js';
export type {
  DetectionGap,
  DetectionReason,
  DetectionStatusCode,
  DetectionStatusName,
  MapDivergenceMetric,
  MapDivergenceTrack,
  PerceptionMetrics,
  SensorPerceptionMetric,
  SensorTargetTrack,
  SensorTrack,
} from './trace/sensor-track.js';

/* ------------------------------------------------------------------ errors */
export { SimEngineError, issue } from './errors.js';
export type { SimIssue, SimIssueCode, SimIssueSeverity } from './errors.js';

/* -------------------------------------------------------------------- util */
export { canonicalJson, contentHash, sha256, sha256Bytes } from './core/hash.js';
export { obbAt, obbOverlap, obbCorners, obbSeparation, sweptObbTimeOfImpact, type SweptObbResult } from './core/math.js';
export type { Obb, Vec2 } from './core/math.js';

/* --------------------------------------------------------- ambient traffic */
export {
  AMBIENT_TRAFFIC_EXTENSION_KEY,
  ambientTrafficProfileFromExtensions,
  ambientTrafficProfileSchema,
  defaultAmbientTrafficProfile,
  resolveAmbientTrafficProfile,
} from './ambient/profile.js';
export type {
  AmbientActorProvenance,
  AmbientCandidate,
  AmbientCandidatePool,
  AmbientReservation,
  AmbientScreeningReason,
  AmbientTrafficOptions,
  AmbientTrafficProfile,
  AmbientTrafficProvenance,
  AmbientTrafficResult,
  ResolvedAmbientTrafficProfile,
} from './ambient/profile.js';
export {
  MATERIALIZED_TRAFFIC_SCHEMA,
  MATERIALIZED_TRAFFIC_TIME_PRECISION,
  MATERIALIZED_TRAFFIC_MAX_ACTORS,
  MATERIALIZED_TRAFFIC_MAX_ACTOR_STATES,
  MaterializedTrafficRecorder,
  createDisabledMaterializedTrafficArtifact,
  decodeMaterializedTrafficArtifact,
  encodeMaterializedTrafficArtifact,
  materializedTrafficActorSchema,
  materializedTrafficActorStateSchema,
  materializedTrafficArtifactEnvelope,
  materializedTrafficArtifactSchema,
  materializedTrafficFrameCount,
  materializedTrafficSignalSchema,
  materializedTrafficSignalStateSchema,
  materializedTrafficTime,
  parseMaterializedTrafficArtifact,
  validateMaterializedTrafficBinding,
} from './ambient/materialized-traffic.js';
export type {
  MaterializedTrafficActor,
  MaterializedTrafficActorState,
  MaterializedTrafficArtifact,
  MaterializedTrafficArtifactEnvelope,
  MaterializedTrafficBinding,
  MaterializedTrafficFrame,
  MaterializedTrafficFrameActor,
  MaterializedTrafficProvider,
  MaterializedTrafficSignal,
  MaterializedTrafficSignalState,
} from './ambient/materialized-traffic.js';
export {
  buildSumoRouteDocument,
  sumoActorIdHash,
  sumoNetworkHeadingToScene,
  sumoNetworkToScene,
  sumoNumericSeed,
  sumoSceneHeadingToNetwork,
  sumoSceneToNetwork,
  sumoVehicleId,
  validateSumoNetworkManifest,
  validateSumoRuntimeManifest,
} from './ambient/sumo.js';
export {
  buildSumoAuthoredOccupancies,
  buildSumoRoadOccupancyIndex,
  sumoAuthoredOccupanciesAt,
  sumoAuthoredOccupancySourcesAt,
} from './ambient/authored-occupancy.js';
export type {
  SumoAuthoredOccupancy,
  SumoAuthoredOccupancyKind,
  SumoAuthoredOccupancySource,
  SumoRoadOccupancyIndex,
} from './ambient/authored-occupancy.js';
export type {
  SumoNetworkManifest,
  SumoNetworkPoint,
  SumoNetworkWorldTransform,
  SumoRouteDocumentOptions,
  SumoRuntimeManifest,
  SumoScenePoint,
} from './ambient/sumo.js';

/* ------------------------------------------------------- native module shape */
export type {
  NativeBatchResult,
  NativeBevShape,
  NativeCompileResult,
  NativeEnvSession,
  NativeLaneGraph,
  NativeMapBundle,
  NativeModule,
  NativePolicyHook,
  NativePolicySession,
  NativePolicyStepResult,
  NativeScenarioInput,
  NativeSeed,
  NativeSessionBatch,
  NativeSite,
  NativePlacementRoute,
  NativeRoute,
  NativeSimulation,
  NativeStepResult,
  NativeTrace,
  NativeTrafficHandoff,
  NativeTruthSubscription,
  NativeWorldSession,
  NativeWorldSnapshot,
} from './native-module.js';

/* ------------------------------------------------------ host-neutral façade */
export { EngineRuntime, SimulationHandle, TraceHandle } from './runtime.js';
export type { LaneGraph, NativeMap, RunSimulationOptions, ScenarioInput, ScenarioSource, SimulationProgress, TopologySource, TraceSource } from './runtime.js';
