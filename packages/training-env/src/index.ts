/**
 * @simforge-oss/training-env — Gymnasium-semantics environment contracts over
 * the SimForge native runtime, plus the versioned causal ground-truth channel
 * and the world-session/truth-stream documents.
 *
 * This root is host-neutral: documents, codecs and the session façades that
 * take an already-loaded native module. Bind them with `./node` (N-API addon,
 * synchronous `sessions()`) or `./browser` (WASM, `loadSessions()`).
 */

export { SessionRuntime } from './runtime.js';

export { EnvSession, SessionBatch, decodeStepResult } from './session.js';
export type { EnvSessionOptions, SessionBatchOptions, SignalBookState } from './session.js';

export { PolicySession } from './policy-session.js';
export type { PolicySessionOptions, PolicyStepResult } from './policy-session.js';

export {
  CAUSAL_CHANNEL_VERSION,
  CONFLICT_GENESIS_DISTANCE_M,
  CONFLICT_GENESIS_TTC_S,
  parseCausalChannel,
  serializeCausalChannel,
} from './causal.js';
export type {
  CausalChannel,
  CausalConflictGenesis,
  CausalFrame,
  CausalLosTransition,
  CausalTraceEnvelope,
  CausalTriggerRecord,
} from './causal.js';

export { BEV_CHANNELS, DEFAULT_BEV_CONFIG, DEFAULT_OBSERVATION_CONFIG, DEFAULT_REWARD_CONFIG } from './types.js';
export type {
  BevConfig,
  BevRaster,
  EnvAction,
  EpisodeConfig,
  Observation,
  ObservationConfig,
  PairMinima,
  PerceivedObject,
  RewardConfig,
  RewardTerms,
  StepInfo,
  StepResult,
} from './types.js';

export { FALLBACK_POLICIES, ZERO_CONTROL } from './policy-step.js';
export type {
  ActionControl,
  ActionTrajectory,
  DeadlineReport,
  ExecutorFrame,
  FallbackPolicy,
  PolicyAction,
  TrajectoryExecution,
  TrajectoryPoint,
} from './policy-step.js';

export { WorldSession, TruthSubscription, replayWorldSessionLog, WORLD_SESSION_LOG_VERSION } from './world-session.js';
export type {
  AdvanceResult,
  BatchOp,
  CommandOutcome,
  ReplayResult,
  SpawnRequest,
  WorldActorState,
  WorldCommand,
  WorldLogEntry,
  WorldSessionLog,
  WorldSessionOptions,
  WorldSnapshot,
} from './world-session.js';

export { encodeTruthFrame, TruthStreamClient, WORLD_TRUTH_QUEUE_CAPACITY } from './truth-stream.js';
export type { TruthActor, TruthActorCatalogEntry, TruthFrame, TruthSubscriptionStats } from './truth-stream.js';
