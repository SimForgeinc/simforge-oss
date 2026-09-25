//! The CLI contract (oss/AGENTS.md "CLI contract"), in one place.
//!
//! - **stdout is the result**: exactly one JSON document, pretty-printed only
//!   with `--pretty`. Nothing else is ever written there.
//! - **stderr carries the structured error**: one JSON line
//!   `{code, path?, reason, detail?}`, no progress chatter.
//! - **Exit codes**: `0` ok; `1` the command could not run (bad flags, missing
//!   file, unreachable registry); `2` it ran and found something wrong with
//!   its input (a failed verification, a failed doctor check). Callers key
//!   repair loops off the 1/2 distinction, so it must never blur.

use std::io::Write;

use serde::Serialize;
use serde_json::Value;

/// Process exit codes. The numeric values are the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[repr(i32)]
pub enum Exit {
    Ok = 0,
    CommandError = 1,
    Findings = 2,
}

impl Exit {
    pub fn code(self) -> i32 {
        self as i32
    }
}

/// The exit-code table as the help surface prints it.
pub fn exit_code_table() -> Value {
    serde_json::json!({
        "0": "ok",
        "1": "command error: the command could not run",
        "2": "findings: the command ran and found something wrong with its input",
    })
}

/// A structured failure. `exit` is [`Exit::CommandError`] unless the command
/// ran and is reporting findings about its input.
#[derive(Debug, Clone)]
pub struct CliError {
    pub code: String,
    pub path: Option<String>,
    pub reason: String,
    pub detail: Option<Value>,
    pub exit: Exit,
}

impl CliError {
    /// A "could not run" error (exit 1).
    pub fn new(code: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            path: None,
            reason: reason.into(),
            detail: None,
            exit: Exit::CommandError,
        }
    }

    /// A "ran and found something wrong with the input" error (exit 2).
    pub fn findings(code: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            exit: Exit::Findings,
            ..Self::new(code, reason)
        }
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn to_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("code".into(), Value::String(self.code.clone()));
        if let Some(path) = &self.path {
            map.insert("path".into(), Value::String(path.clone()));
        }
        map.insert("reason".into(), Value::String(self.reason.clone()));
        if let Some(detail) = &self.detail {
            map.insert("detail".into(), detail.clone());
        }
        Value::Object(map)
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.reason)
    }
}

impl std::error::Error for CliError {}

/// What a command produced: the stdout document and the exit code. A command
/// that ran and found problems returns `Exit::Findings` *with* its report on
/// stdout (e.g. `doctor` with a failing check), rather than an error.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub value: Value,
    pub exit: Exit,
}

impl Outcome {
    pub fn ok(value: Value) -> Self {
        Self {
            value,
            exit: Exit::Ok,
        }
    }

    pub fn findings(value: Value) -> Self {
        Self {
            value,
            exit: Exit::Findings,
        }
    }

    /// A long-running command that already wrote its one stdout document
    /// (`env serve` prints its ready line while it serves); nothing more is
    /// emitted when it returns.
    pub fn already_emitted(exit: Exit) -> Self {
        Self {
            value: Value::Null,
            exit,
        }
    }
}

pub type CmdResult = Result<Outcome, CliError>;

/// Flags every command shares.
#[derive(Debug, Clone, Copy, Default)]
pub struct Ctx {
    pub pretty: bool,
}

/// Write the result document to stdout.
pub fn emit(value: &Value, pretty: bool) {
    let text = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
    .expect("a serde_json::Value always serializes");
    let mut out = std::io::stdout().lock();
    // A closed stdout (`simforge ... | head -c0`) is the caller's choice, not an error to report.
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}

/// Write a structured error to stderr (always one compact JSON line).
pub fn emit_error(error: &CliError) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{}", error.to_json());
    let _ = err.flush();
}
