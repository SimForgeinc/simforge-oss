//! Session-level errors.
//!
//! Engine rejections (`SimEngineError`) and core contract failures
//! (`CoreError`) pass through unchanged; everything the session layer itself
//! refuses (mis-configured episodes, stepping a finished episode, a checkpoint
//! built for another scenario) has its own variant so bindings can map it to
//! a precise host exception.

use simforge_core::error::{CoreError, SimEngineError};

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Engine(#[from] SimEngineError),
    #[error(transparent)]
    Core(#[from] CoreError),
    /// An `EpisodeConfig` / `WorldSessionOptions` field is outside its contract.
    #[error("invalid session configuration: {0}")]
    Config(String),
    /// `step()` before `reset()`.
    #[error("step() called on an un-reset EnvSession")]
    NotReset,
    /// `step()` after `terminated || truncated`; post-episode stepping is undefined.
    #[error("step() called on a finished EnvSession")]
    Finished,
    /// The metric-subject actor is absent from the world.
    #[error("ego actor {0} missing from the world")]
    MissingEgo(String),
    /// A checkpoint does not belong to this session's scenario/config.
    #[error("checkpoint mismatch: {0}")]
    Checkpoint(String),
    /// A trajectory-follower / policy-executor contract violation.
    #[error("policy execution: {0}")]
    Policy(String),
    /// A world-session command was malformed at the API (not a rejected
    /// command outcome, which is data).
    #[error("world session: {0}")]
    World(String),
}

pub type Result<T, E = SessionError> = std::result::Result<T, E>;
