//! `simforge-session`: session semantics over the native `simforge_core`
//! engine.
//!
//! - [`env::EnvSession`] — finite Gymnasium-semantics episodes: reset/seed,
//!   warm-up exclusion, zero-order-hold decisions at a fixed decision rate,
//!   observation/reward/terminated/truncated, causal channel and complete
//!   checkpoint/restore.
//! - [`batch::SessionBatch`] — N independent worlds stepped together on CPU
//!   threads with typed per-world results and flat N-major buffers.
//! - [`policy::PolicyExecutor`] — trajectory / control actions with
//!   declarative deadlines, explicit fallbacks and the pure-pursuit
//!   [`trajectory::TrajectoryFollower`] driving the engine's own plant.
//! - [`world::WorldSession`] — command-driven live/clip worlds with atomic
//!   spawn/despawn/batch/act, replayable logs, checkpoints and bounded
//!   pull-based truth subscribers.
//!
//! Local stepping is typed end to end; serialisation appears only at the
//! control/checkpoint boundary (serde on configs, checkpoints, logs, frames).

pub mod batch;
pub mod causal;
pub mod env;
pub mod episode;
pub mod error;
pub mod observation;
pub mod policy;
pub mod reward;
pub mod trajectory;
pub mod world;

pub use batch::{FlatBatch, SessionBatch, OBJECT_FEATURES};
pub use causal::{CausalChannel, CausalChannelCollector, CausalFrame};
pub use env::{resolve_ego_id, EnvCheckpoint, EnvSession, StepInfo, StepResult};
pub use episode::{
    BevConfig, EpisodeConfig, GoalSpec, ObservationConfig, ResolvedEpisode, RewardConfig, ENGINE_HZ,
};
pub use error::{Result, SessionError};
pub use policy::{
    resolve_deadline, speed_setpoint_override, AppliedSource, DeadlineReport, ExecutorFrame,
    FallbackPolicy, PolicyAction, PolicyExecutor, PolicyExecutorConfig, ResolvedDecision,
    TrajectoryExecution, TrajectoryPoint, ZERO_CONTROL,
};
pub use reward::{RewardOutcome, RewardTerms};
pub use trajectory::{
    anchor_plan_to_world, FollowerCommand, TrackedPose, TrajectoryFollower,
    TrajectoryFollowerConfig, TrajectoryPlanPoint,
};
pub use world::{
    replay_world_session_log, AdvanceResult, BatchOp, CommandOutcome, ReplayResult, SpawnPose,
    SpawnRequest, TruthActor, TruthFrame, TruthSubscription, TruthSubscriptionStats,
    WorldActorState, WorldCheckpoint, WorldCommand, WorldLogEntry, WorldMode, WorldSession,
    WorldSessionLog, WorldSessionOptions, WorldSnapshot, WORLD_SESSION_LOG_VERSION,
    WORLD_TRUTH_QUEUE_CAPACITY,
};
