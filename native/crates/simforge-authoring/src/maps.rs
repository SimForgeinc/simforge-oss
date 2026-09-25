//! Installed maps, by name, for authoring.
//!
//! Authoring reads the semantic profile `simforge maps pull` installs:
//! `<maps root>/dev-assets/<mapId>/` (`map.xodr`, `signals.geojson.gz`,
//! `topology-index.json.gz`, `derived/topology-derived.json.gz`,
//! `derived/locations.json.gz`). `SCEN_DEV_ASSETS` points somewhere else
//! explicitly (fixtures, a map build's output). Nothing is downloaded here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};
use simforge_bindings_common::runtime::MapAsset;
use simforge_compiler::CompileError;

/// The files that make a directory an installed map.
pub const REQUIRED_FILES: [&str; 5] = [
    "map.xodr",
    "signals.geojson.gz",
    "topology-index.json.gz",
    "derived/topology-derived.json.gz",
    "derived/locations.json.gz",
];
pub const DERIVED_FILE: &str = "derived/topology-derived.json.gz";
pub const LOCATIONS_FILE: &str = "derived/locations.json.gz";

/// Where installed maps are, and why that place was chosen.
#[derive(Debug, Clone)]
pub struct MapRoot {
    pub dir: PathBuf,
    /// `env:SCEN_DEV_ASSETS`, or the maps root's own source plus `/dev-assets`.
    pub source: String,
}

impl MapRoot {
    /// `SCEN_DEV_ASSETS` when set, else `<maps_root>/dev-assets`.
    pub fn resolve(maps_root: &Path, maps_root_source: &str) -> Self {
        if let Some(dir) = std::env::var_os("SCEN_DEV_ASSETS").filter(|v| !v.is_empty()) {
            return Self {
                dir: absolute(Path::new(&dir)),
                source: "env:SCEN_DEV_ASSETS".into(),
            };
        }
        Self {
            dir: maps_root.join("dev-assets"),
            source: maps_root_source.to_owned(),
        }
    }

    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: absolute(&dir.into()),
            source: "explicit".into(),
        }
    }

    fn display(&self) -> String {
        self.dir.display().to_string()
    }

    /// `dev-assets/<mapId>`; refuses an id that is not a map name.
    pub fn map_dir(&self, map_id: &str) -> Result<PathBuf, CompileError> {
        if !is_map_id(map_id) {
            return Err(CompileError::at(
                "unknown_map",
                "--map",
                format!("invalid map identifier \"{map_id}\""),
            ));
        }
        Ok(self.dir.join(map_id))
    }

    /// Complete installed maps, sorted.
    pub fn available(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out: Vec<String> = entries
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter(|name| is_map_id(name))
            .filter(|name| {
                let dir = self.dir.join(name);
                dir.is_dir() && REQUIRED_FILES.iter().all(|f| dir.join(f).is_file())
            })
            .collect();
        out.sort();
        out
    }

    /// Fail with the installed names when `map_id` is not a complete map.
    pub fn assert_known(&self, map_id: &str) -> Result<PathBuf, CompileError> {
        let dir = self.map_dir(map_id)?;
        if !dir.is_dir() {
            return Err(CompileError::at(
                "unknown_map",
                "--map",
                format!("no installed map \"{map_id}\""),
            )
            .detail_entry("known", json!(self.available()))
            .detail_entry("devAssets", Value::String(self.display()))
            .detail_entry(
                "hint",
                Value::String(format!(
                    "install it with `simforge maps pull {map_id}@<version>`"
                )),
            ));
        }
        let missing: Vec<&str> = REQUIRED_FILES
            .iter()
            .copied()
            .filter(|f| !dir.join(f).is_file())
            .collect();
        if !missing.is_empty() {
            return Err(CompileError::at(
                "map_not_present",
                "--map",
                format!("map \"{map_id}\" is incomplete"),
            )
            .detail_entry("devAssets", Value::String(self.display()))
            .detail_entry("missing", json!(missing)));
        }
        Ok(dir)
    }

    /// `--map` / `--maps` / `--all-maps` into an ordered id list.
    pub fn select(
        &self,
        map: Option<&str>,
        maps: &[String],
        all_maps: bool,
    ) -> Result<Vec<String>, CompileError> {
        if all_maps {
            return Ok(self.available());
        }
        if !maps.is_empty() {
            for id in maps {
                self.assert_known(id)?;
            }
            return Ok(maps.to_vec());
        }
        if let Some(id) = map {
            self.assert_known(id)?;
            return Ok(vec![id.to_owned()]);
        }
        Err(CompileError::at(
            "missing_option",
            "--map",
            "one of --map, --maps or --all-maps is required",
        ))
    }

    /// Load (and memoise per process) an installed map: lane graph, matcher
    /// index, signal catalog, static colliders and ground, exactly as every
    /// simulating host loads it.
    pub fn load(&self, map_id: &str) -> Result<Arc<MapAsset>, CompileError> {
        let dir = self.assert_known(map_id)?;
        static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<MapAsset>>>> = OnceLock::new();
        let cache = CACHE.get_or_init(Default::default);
        if let Some(hit) = cache.lock().expect("map cache").get(&dir) {
            return Ok(Arc::clone(hit));
        }
        let asset = Arc::new(MapAsset::load(&dir).map_err(|e| binding_error(e, &dir))?);
        cache
            .lock()
            .expect("map cache")
            .insert(dir, Arc::clone(&asset));
        Ok(asset)
    }
}

/// A binding-layer failure as a structured error. The compiler's own errors
/// cross that layer as `"<code> at <path>: <reason>"`; recover the parts.
pub fn binding_error(error: simforge_bindings_common::BindingError, dir: &Path) -> CompileError {
    let text = error.to_string();
    split_compile_message(&text)
        .unwrap_or_else(|| CompileError::at("map_load_failed", dir.display().to_string(), text))
}

/// Parse `"<code> at <path>: <reason>"` / `"<code>: <reason>"` (the
/// `CompileError` display form) back into its parts.
pub fn split_compile_message(text: &str) -> Option<CompileError> {
    let (head, reason) = text.split_once(": ")?;
    let (code, path) = match head.split_once(" at ") {
        Some((code, path)) => (code, Some(path)),
        None => (head, None),
    };
    if code.is_empty() || !code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        return None;
    }
    let mut error = CompileError::new(code, reason);
    if let Some(path) = path {
        error = error.with_path(path);
    }
    Some(error)
}

pub fn is_map_id(s: &str) -> bool {
    !s.is_empty()
        && s.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

use crate::paths::resolve as absolute;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_ids() {
        assert!(is_map_id("richmond-field-station"));
        assert!(is_map_id("san-ramon-25-p2"));
        assert!(!is_map_id("Richmond"));
        assert!(!is_map_id("a--b"));
        assert!(!is_map_id("-a"));
        assert!(!is_map_id("../x"));
    }

    #[test]
    fn compile_messages_round_trip() {
        let e =
            split_compile_message("unknown_site at --site: site \"x\" was not produced").unwrap();
        assert_eq!(e.code, "unknown_site");
        assert_eq!(e.path.as_deref(), Some("--site"));
        assert_eq!(e.reason, "site \"x\" was not produced");
        assert!(split_compile_message("invalid JSON: eof").is_none());
    }
}
