//! Shared glue between the authoring commands and `simforge-authoring`.

use serde_json::Value;
use simforge_authoring::maps::MapRoot;
use simforge_authoring::CompileError;

use crate::contract::{CliError, Exit};
use crate::paths;

/// A compiler/authoring error in the CLI contract: same code, path, reason
/// and detail; `findings` selects exit 2.
pub fn cli_error(error: CompileError) -> CliError {
    let mut out = if error.findings {
        CliError::findings(error.code, error.reason)
    } else {
        CliError::new(error.code, error.reason)
    };
    if let Some(path) = error.path {
        out = out.with_path(path);
    }
    if let Some(detail) = error.detail {
        out = out.with_detail(Value::Object(detail));
    }
    out
}

/// Installed maps: `SCEN_DEV_ASSETS`, else `<maps root>/dev-assets` (the
/// layout `simforge maps pull` writes).
pub fn map_root() -> Result<MapRoot, CliError> {
    let root = paths::maps_root(None)?;
    Ok(MapRoot::resolve(&root.value, &root.source))
}

pub fn exit_for(ok: bool) -> Exit {
    if ok {
        Exit::Ok
    } else {
        Exit::Findings
    }
}
