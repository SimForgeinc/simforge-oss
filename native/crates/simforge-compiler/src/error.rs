//! The structured compiler error: `{code, path?, reason, detail?}`.
//!
//! The primary consumer is an unattended authoring/repair loop, so every
//! failure leaves as a machine code plus a dotted path into the document and a
//! closed-vocabulary `detail` object. Findings (`exit 2`: the input parsed but
//! is wrong) are distinguished from command errors by [`CompileError::findings`].

use std::fmt;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::expr::ExpressionError;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CompileError {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Map<String, Value>>,
    /// `true` when the input parsed but is wrong (the CLI's exit code 2).
    #[serde(skip)]
    pub findings: bool,
}

pub type CompileResult<T> = Result<T, CompileError>;

impl CompileError {
    pub fn new(code: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            path: None,
            reason: reason.into(),
            detail: None,
            findings: false,
        }
    }

    pub fn at(code: impl Into<String>, path: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            path: Some(path.into()),
            reason: reason.into(),
            detail: None,
            findings: false,
        }
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_detail(mut self, detail: Map<String, Value>) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn detail_entry(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.detail
            .get_or_insert_with(Map::new)
            .insert(key.to_owned(), value.into());
        self
    }

    pub fn as_findings(mut self) -> Self {
        self.findings = true;
        self
    }

    /// Internal-error shape for a failure that has no repairable vocabulary.
    pub fn internal(reason: impl fmt::Display) -> Self {
        Self::new("internal_error", reason.to_string())
    }
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.path {
            Some(path) => write!(f, "{} at {}: {}", self.code, path, self.reason),
            None => write!(f, "{}: {}", self.code, self.reason),
        }
    }
}

impl std::error::Error for CompileError {}

impl From<ExpressionError> for CompileError {
    fn from(error: ExpressionError) -> Self {
        Self::new("expression_error", error.to_string())
    }
}

impl From<simforge_core::error::CoreError> for CompileError {
    fn from(error: simforge_core::error::CoreError) -> Self {
        use simforge_core::error::CoreError;
        match error {
            CoreError::Json(e) => Self::new("invalid_json", e.to_string()),
            CoreError::Schema(e) => {
                let issues: Vec<Value> = e
                    .issues
                    .iter()
                    .map(|i| serde_json::json!({ "code": i.code, "path": i.path, "message": i.message }))
                    .collect();
                Self::new(
                    "input_invalid",
                    "the compiled input failed the engine contract",
                )
                .detail_entry("issues", Value::Array(issues))
            }
            CoreError::Topology(reason) => Self::new("topology_invalid", reason),
            CoreError::Canonical(reason) => Self::new("canonical_json", reason),
            CoreError::Engine(e) => {
                let issues = serde_json::to_value(&e.issues).unwrap_or(Value::Null);
                Self::new("engine_rejected", e.message).detail_entry("issues", issues)
            }
        }
    }
}

impl From<serde_json::Error> for CompileError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("invalid_json", error.to_string())
    }
}

impl CompileError {
    /// An engine route-build failure at a document path, keeping the engine's
    /// own code vocabulary (`route_disconnected`, `route_lane_missing`, ...).
    pub fn from_route_error(
        error: simforge_core::map::RouteBuildError,
        path: impl Into<String>,
    ) -> Self {
        let detail = error
            .detail
            .as_ref()
            .and_then(|d| serde_json::to_value(d).ok())
            .and_then(|v| match v {
                Value::Object(m) => Some(m),
                _ => None,
            });
        let mut out = Self::at(error.code.as_str(), path, error.reason);
        out.detail = detail;
        out
    }
}

/// Build a `detail` map from `(key, value)` pairs.
pub fn detail(pairs: &[(&str, Value)]) -> Map<String, Value> {
    let mut map = Map::with_capacity(pairs.len());
    for (key, value) in pairs {
        map.insert((*key).to_owned(), value.clone());
    }
    map
}
