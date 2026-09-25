//! Planning failures. `code` is the TypeScript engine's error code (the
//! prefix of its `Error` message), so evidence and repair loops key off the
//! same strings on both sides; `message` is the full TypeScript message.

use serde_json::{json, Value};

use crate::contract::CliError;

#[derive(Debug, Clone, PartialEq)]
pub struct PlanError {
    pub code: &'static str,
    pub message: String,
    pub detail: Option<Value>,
}

impl PlanError {
    /// `code: detail` (the TypeScript `new Error(`${code}: ${detail}`)` shape).
    pub fn new(code: &'static str, detail: impl std::fmt::Display) -> Self {
        Self {
            code,
            message: format!("{code}: {detail}"),
            detail: None,
        }
    }

    /// A message that is the bare code (`new Error('code')`).
    pub fn bare(code: &'static str) -> Self {
        Self {
            code,
            message: code.to_owned(),
            detail: None,
        }
    }

    /// A message that does not start with the code.
    pub fn message(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }

    /// The CLI contract error: the map or the job's inputs are wrong (exit 2).
    pub fn into_cli(self) -> CliError {
        let error = CliError::findings(self.code, self.message);
        match self.detail {
            Some(detail) => error.with_detail(detail),
            None => error,
        }
    }
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PlanError {}

/// A condition the run proceeds through but must report (never silent).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Warning {
    pub code: &'static str,
    pub message: String,
}

impl Warning {
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "message": self.message })
    }
}

pub type PlanResult<T> = Result<T, PlanError>;
