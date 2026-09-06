//! One error surface for every host language.
//!
//! Each binding maps [`BindingError`] to a host exception whose *class*
//! follows [`BindingError::kind`] and whose message is the `Display` text.
//! Structured engine/schema issues stay machine-readable through
//! [`BindingError::issues_json`] so authoring repair loops keep working.

use simforge_core::error::{CoreError, SchemaError, SimEngineError};
use simforge_session::error::SessionError;

/// Host exception class selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Malformed host-side arguments (wrong array length, NaN control, …).
    Argument,
    /// The document violated the input schema.
    Schema,
    /// The engine rejected a validated document (placement, routing, …).
    Engine,
    /// A session lifecycle rule was broken (step before reset, after finish…).
    Session,
    /// The capability is not available in this build/profile (e.g. GPU in WASM).
    Unsupported,
    /// Anything else (I/O, JSON syntax, internal).
    Runtime,
}

impl ErrorKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Argument => "argument",
            ErrorKind::Schema => "schema",
            ErrorKind::Engine => "engine",
            ErrorKind::Session => "session",
            ErrorKind::Unsupported => "unsupported",
            ErrorKind::Runtime => "runtime",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BindingError {
    #[error("{0}")]
    Argument(String),
    #[error(transparent)]
    Schema(SchemaError),
    #[error(transparent)]
    Engine(SimEngineError),
    #[error(transparent)]
    Session(SessionError),
    #[error("unsupported in this runtime: {0}")]
    Unsupported(String),
    #[error("{0}")]
    Runtime(String),
}

impl BindingError {
    pub fn argument(message: impl Into<String>) -> Self {
        BindingError::Argument(message.into())
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        BindingError::Unsupported(message.into())
    }

    pub fn runtime(message: impl Into<String>) -> Self {
        BindingError::Runtime(message.into())
    }

    pub fn kind(&self) -> ErrorKind {
        match self {
            BindingError::Argument(_) => ErrorKind::Argument,
            BindingError::Schema(_) => ErrorKind::Schema,
            BindingError::Engine(_) => ErrorKind::Engine,
            BindingError::Session(SessionError::Engine(_)) => ErrorKind::Engine,
            BindingError::Session(SessionError::Core(CoreError::Schema(_))) => ErrorKind::Schema,
            BindingError::Session(SessionError::Core(CoreError::Engine(_))) => ErrorKind::Engine,
            BindingError::Session(_) => ErrorKind::Session,
            BindingError::Unsupported(_) => ErrorKind::Unsupported,
            BindingError::Runtime(_) => ErrorKind::Runtime,
        }
    }

    /// Structured issue list (`SchemaIssue[]` or `SimIssue[]`) as JSON, when
    /// the failure carries one. Hosts attach it to the exception as data.
    pub fn issues_json(&self) -> Option<String> {
        match self {
            BindingError::Schema(e) => serde_json::to_string(&e.issues).ok(),
            BindingError::Engine(e) => serde_json::to_string(&e.issues).ok(),
            BindingError::Session(SessionError::Engine(e)) => serde_json::to_string(&e.issues).ok(),
            BindingError::Session(SessionError::Core(CoreError::Schema(e))) => {
                serde_json::to_string(&e.issues).ok()
            }
            BindingError::Session(SessionError::Core(CoreError::Engine(e))) => {
                serde_json::to_string(&e.issues).ok()
            }
            _ => None,
        }
    }
}

impl From<CoreError> for BindingError {
    fn from(value: CoreError) -> Self {
        match value {
            CoreError::Schema(e) => BindingError::Schema(e),
            CoreError::Engine(e) => BindingError::Engine(e),
            other => BindingError::Runtime(other.to_string()),
        }
    }
}

impl From<SchemaError> for BindingError {
    fn from(value: SchemaError) -> Self {
        BindingError::Schema(value)
    }
}

impl From<SimEngineError> for BindingError {
    fn from(value: SimEngineError) -> Self {
        BindingError::Engine(value)
    }
}

impl From<SessionError> for BindingError {
    fn from(value: SessionError) -> Self {
        BindingError::Session(value)
    }
}

impl From<serde_json::Error> for BindingError {
    fn from(value: serde_json::Error) -> Self {
        BindingError::Runtime(format!("invalid JSON: {value}"))
    }
}

pub type Result<T, E = BindingError> = std::result::Result<T, E>;
