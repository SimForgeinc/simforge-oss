//! The outer deterministic simulation: world state, fixed-step tick loop,
//! interactions, controllers, perception, signals and physical contact
//! coupling. Consumes `map` (geometry), `physics` (body integration) and
//! `trace` (records/metrics) without owning any of them.
//!
//! Entry points: [`Simulation::new`] / [`run_simulation`] for a complete
//! episode, [`Simulation::advance`] for streaming control, and
//! [`Simulation::checkpoint`] / [`Simulation::restore`] for persistence.

pub mod actor;
pub mod controllers;
pub mod cornering;
pub mod doors;
pub mod dynamics;
pub mod gear;
mod interactions;
mod motion;
mod output;
pub mod perception;
pub mod route_ref;
pub mod signals;
pub mod spatial;
pub mod static_colliders;
pub mod surface;
pub mod triggers;
pub mod visibility;
mod world;

pub use actor::{ActorIndex, AxisId, InteractionIndex};
pub use output::{
    ActorState, CheckpointOptions, LateralCommandState, PendingRetargetState, SimulationCheckpoint,
};
pub use signals::{signal_snapshot_at, SignalBook, SignalSnapshot};
pub use static_colliders::{SceneObb, StaticColliderClass, StaticMapCollider};
pub use triggers::{CollisionParty, ResolvedCondition, TriggerProgress, TriggerStatus};
pub use world::{
    run_simulation, ActionOverride, ActorAction, ActorSnapshot, AmbientReactivity, EngineResult,
    GuardMode, PairMinima, RunOptions, SessionMode, SimResult, Simulation, SimulationProgress,
    SimulationSnapshot, TickObservation, EGO_CONTROLLER_PROFILE, EGO_SENSOR_HALF_ANGLE_RAD,
    EGO_SENSOR_RANGE_M,
};
