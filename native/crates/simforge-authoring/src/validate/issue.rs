//! `ClauseResult`: the one issue shape shared by the validator and the
//! matcher, so the site picker, the CLI and a repair loop read one list.

use serde::Serialize;
use serde_json::Value;
use simforge_core::hash::cmp_locale;

/// How bad an issue is. `error` blocks; `warning` and `info` do not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

impl Severity {
    fn rank(self) -> u8 {
        match self {
            Self::Error => 0,
            Self::Warning => 1,
            Self::Info => 2,
        }
    }
}

/// One finding: a failed clause, or a failed check.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    /// Dotted/indexed path into the template (`choreography.interactions.3.dynamics`).
    pub path: String,
    pub severity: Severity,
    pub code: String,
    /// One sentence, addressed to whoever has to fix it.
    pub message: String,
    /// What the check wanted, when that is worth showing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<Value>,
    /// What it found (may be `null`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<Value>,
}

impl Issue {
    pub fn new(
        severity: Severity,
        code: impl Into<String>,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            path: path.into(),
            severity,
            code: code.into(),
            message: message.into(),
            required: None,
            actual: None,
        }
    }

    pub fn detail(mut self, required: Option<Value>, actual: Option<Value>) -> Self {
        self.required = required;
        self.actual = actual;
        self
    }
}

/// Sort issues so output is diff-stable: severity, then path, then code
/// (`localeCompare`), stable otherwise.
pub fn sort_issues(issues: &mut [Issue]) {
    issues.sort_by(|a, b| {
        a.severity
            .rank()
            .cmp(&b.severity.rank())
            .then_with(|| cmp_locale(&a.path, &b.path))
            .then_with(|| cmp_locale(&a.code, &b.code))
    });
}
