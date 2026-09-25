//! The two closure listings a package carries, and the blob index they define.
//!
//! - `map/closure.json`: `uniscenario.browser-asset-set/v1`, canonical JSON of
//!   `{contractVersion, members: [{relativePath, sha256, byteLength, mediaType, role, required}]}`
//!   (`closure.ts` `planUploadedMapClosure`); its sha256 is `map.browserClosureSha256`.
//! - `actors/closure.json`: `simforge.actor-assets-closure/v1`,
//!   `{schema, members: {<path>: {bytes, sha256}}}`; its sha256 is `catalog.actorClosureDigest`.
//!
//! Blobs (`blobs/sha256/<aa>/<sha256>`) are exactly the digests these two
//! listings name, each stored once.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use simforge_core::hash::sha256_bytes;

use crate::error::{PackageError, Result};
use crate::manifest::{ACTOR_CLOSURE_SCHEMA, BROWSER_ASSET_SET_SCHEMA, MAX_SAFE_INTEGER};
use crate::names::is_hex64;

/// `catalog-models.json`: the actor-closure member the renderer resolves catalog ids through.
pub const ACTOR_CATALOG_PATH: &str = "catalog-models.json";

/// The simulation members of a map version (`SIMULATION_MAP_MEMBERS`,
/// `@simforge-oss/compiler`): exact paths, then path prefixes.
pub const SIMULATION_MEMBERS_EXACT: [&str; 6] = [
    "map.xodr",
    "topology-index.json.gz",
    "signals.geojson.gz",
    "derived/topology-derived.json.gz",
    "derived/locations.json.gz",
    "derived/ground/ground-mesh.bin",
];
/// The ground surface a trace v5 is simulated on (`header.groundDigest` = its sha256).
pub const GROUND_MEMBER: &str = "derived/ground/ground-mesh.bin";

pub const SIMULATION_MEMBER_PREFIXES: [&str; 1] = ["3d/variants/static-colliders"];

pub fn is_simulation_member(path: &str) -> bool {
    SIMULATION_MEMBERS_EXACT.contains(&path)
        || SIMULATION_MEMBER_PREFIXES
            .iter()
            .any(|p| path.starts_with(p))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MapMemberRole {
    Manifest,
    Environment,
    Geometry,
    Texture,
    Runtime,
    Metadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MapClosureMember {
    pub relative_path: String,
    pub sha256: String,
    pub byte_length: u64,
    pub media_type: String,
    pub role: MapMemberRole,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MapClosure {
    pub contract_version: String,
    pub members: Vec<MapClosureMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActorClosureMember {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActorClosure {
    pub schema: String,
    pub members: BTreeMap<String, ActorClosureMember>,
    /// Per-member licence records (`{license, attribution?, source?}`), keyed
    /// by member path; closures from `793ec86c…` on carry them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub licenses: Option<BTreeMap<String, Value>>,
}

/// `validateRelativePath` of `closure.ts`: relative, `/`-separated, no empty,
/// `.` or `..` segments, no backslash, no control characters, no URL scheme.
pub fn is_relative_path(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 1024
        && !v.starts_with('/')
        && !v.contains('\\')
        && !v.chars().any(|c| c.is_control())
        && !v.contains("://")
        && v.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

impl MapClosure {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let closure: MapClosure = serde_json::from_slice(bytes).map_err(|e| {
            PackageError::closure("map_closure_schema", format!("map/closure.json: {e}"))
        })?;
        if closure.contract_version != BROWSER_ASSET_SET_SCHEMA {
            return Err(PackageError::closure(
                "map_closure_schema",
                format!(
                    "map/closure.json contractVersion is {:?}",
                    closure.contract_version
                ),
            ));
        }
        if closure.members.is_empty()
            || !closure
                .members
                .windows(2)
                .all(|w| w[0].relative_path < w[1].relative_path)
        {
            return Err(PackageError::closure(
                "map_closure_schema",
                "map/closure.json members must be non-empty, sorted by relativePath and unique",
            ));
        }
        for m in &closure.members {
            if !is_relative_path(&m.relative_path)
                || !is_hex64(&m.sha256)
                || m.byte_length > MAX_SAFE_INTEGER
                || m.media_type.is_empty()
            {
                return Err(PackageError::closure(
                    "map_closure_schema",
                    format!("map/closure.json member {:?} is malformed", m.relative_path),
                ));
            }
        }
        Ok(closure)
    }

    pub fn member(&self, path: &str) -> Option<&MapClosureMember> {
        self.members
            .binary_search_by(|m| m.relative_path.as_str().cmp(path))
            .ok()
            .map(|i| &self.members[i])
    }

    pub fn total_bytes(&self) -> u64 {
        self.members.iter().map(|m| m.byte_length).sum()
    }

    /// `simforge.map-pin-closure/v1`: sha256 over `"<relativePath> <sha256>\n"`
    /// lines of the simulation members, in byte order of path.
    pub fn pin_closure_sha256(&self) -> String {
        let mut text = String::new();
        for m in self
            .members
            .iter()
            .filter(|m| is_simulation_member(&m.relative_path))
        {
            text.push_str(&m.relative_path);
            text.push(' ');
            text.push_str(&m.sha256);
            text.push('\n');
        }
        sha256_bytes(text.as_bytes())
    }
}

impl ActorClosure {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let closure: ActorClosure = serde_json::from_slice(bytes).map_err(|e| {
            PackageError::closure("actor_closure_schema", format!("actors/closure.json: {e}"))
        })?;
        if closure.schema != ACTOR_CLOSURE_SCHEMA {
            return Err(PackageError::closure(
                "actor_closure_schema",
                format!("actors/closure.json schema is {:?}", closure.schema),
            ));
        }
        for (path, m) in &closure.members {
            if !is_relative_path(path) || !is_hex64(&m.sha256) || m.bytes > MAX_SAFE_INTEGER {
                return Err(PackageError::closure(
                    "actor_closure_schema",
                    format!("actors/closure.json member {path:?} is malformed"),
                ));
            }
        }
        for (path, record) in closure.licenses.iter().flatten() {
            let named = record
                .get("license")
                .and_then(Value::as_str)
                .is_some_and(|l| !l.is_empty());
            if !closure.members.contains_key(path) || !named {
                return Err(PackageError::closure(
                    "actor_closure_schema",
                    format!("actors/closure.json licenses[{path:?}] names no member or no licence"),
                ));
            }
        }
        if !closure.members.contains_key(ACTOR_CATALOG_PATH) {
            return Err(PackageError::closure(
                "actor_closure_schema",
                format!("actors/closure.json lists no {ACTOR_CATALOG_PATH}"),
            ));
        }
        Ok(closure)
    }

    /// Closure member paths that `catalog_ids` reach through
    /// `catalog-models.json` (the renderer's `vehicle_model.rs` shape:
    /// `{<catalogId>: {model: {glbPath}, animations?: {<motion>: {glbPath}}}}`,
    /// optionally under a `models`/`entries`/`vehicles` wrapper). Always
    /// includes `catalog-models.json` itself. An id the table does not list
    /// is procedural and reaches nothing; an id under the table's `withheld`
    /// key is an error (`actor_model_withheld`), as is a path that is not a
    /// closure member.
    pub fn reachable(
        &self,
        catalog_models: &[u8],
        catalog_ids: &[String],
    ) -> Result<BTreeSet<String>> {
        let bad = |m: String| {
            PackageError::closure("actor_catalog", format!("{ACTOR_CATALOG_PATH}: {m}"))
        };
        let raw: Value =
            serde_json::from_slice(catalog_models).map_err(|e| bad(format!("not JSON ({e})")))?;
        let Value::Object(root) = &raw else {
            return Err(bad("expected an object".to_owned()));
        };
        let table = ["models", "entries", "vehicles"]
            .iter()
            .find_map(|k| root.get(*k).and_then(Value::as_object))
            .unwrap_or(root);
        let mut out = BTreeSet::from([ACTOR_CATALOG_PATH.to_owned()]);
        let mut add = |id: &str, what: &str, path: Option<&Value>| -> Result<()> {
            let Some(Value::String(path)) = path else {
                return Err(bad(format!("{id} {what} has no glbPath")));
            };
            if !self.members.contains_key(path) {
                return Err(bad(format!(
                    "binds {id} {what} to {path}, which is not a closure member"
                )));
            }
            out.insert(path.clone());
            Ok(())
        };
        // Models the closure lists as `withheld` (no redistribution licence;
        // hosted-only) are refused by name, never treated as procedural.
        let withheld = root.get("withheld").and_then(Value::as_object);
        for id in catalog_ids {
            if withheld.is_some_and(|w| w.contains_key(id)) {
                return Err(PackageError::closure(
                    "actor_model_withheld",
                    format!("{ACTOR_CATALOG_PATH}: {id} is withheld from this closure (native_actor_model_withheld); a package that binds it cannot be full"),
                ));
            }
            let Some(entry) = table.get(id) else { continue };
            let Value::Object(entry) = entry else {
                return Err(bad(format!("entry {id} is not an object")));
            };
            let model = match entry.get("model") {
                Some(Value::Object(m)) => m,
                Some(_) => return Err(bad(format!("entry {id} model is not an object"))),
                None => entry,
            };
            add(id, "model", model.get("glbPath"))?;
            if let Some(animations) = entry.get("animations") {
                let Value::Object(animations) = animations else {
                    return Err(bad(format!("entry {id} animations is not an object")));
                };
                for (name, a) in animations {
                    add(id, &format!("animation {name}"), a.get("glbPath"))?;
                }
            }
        }
        Ok(out)
    }
}

/// digest → size, over both closures. A digest listed twice (within or
/// across closures) must carry one size; it is one blob.
pub fn blob_index(map: &MapClosure, actors: &ActorClosure) -> Result<BTreeMap<String, u64>> {
    let mut index: BTreeMap<String, u64> = BTreeMap::new();
    let listed = map
        .members
        .iter()
        .map(|m| (&m.relative_path, &m.sha256, m.byte_length))
        .chain(actors.members.iter().map(|(p, m)| (p, &m.sha256, m.bytes)));
    for (path, sha, size) in listed {
        match index.get(sha) {
            Some(prev) if *prev != size => {
                return Err(PackageError::closure(
                    "closure_size_conflict",
                    format!("{sha} is listed as {prev} bytes and as {size} bytes (at {path})"),
                )
                .at(path.clone()))
            }
            _ => {
                index.insert(sha.clone(), size);
            }
        }
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn withheld_models_are_refused_by_name() {
        let sha = "a".repeat(64);
        let closure = ActorClosure::parse(
            format!(
                r#"{{"schema":"simforge.actor-assets-closure/v1","members":{{"catalog-models.json":{{"bytes":1,"sha256":"{sha}"}},"models/car/model.glb":{{"bytes":1,"sha256":"{sha}"}}}}}}"#
            )
            .as_bytes(),
        )
        .unwrap();
        let catalog = br#"{"vehicle.car":{"model":{"glbPath":"models/car/model.glb"}},"withheld":{"animal.cat":{"reason":"licence unconfirmed"}}}"#;
        let ok = closure
            .reachable(catalog, &["vehicle.car".to_owned()])
            .unwrap();
        assert!(ok.contains("models/car/model.glb"));
        let err = closure
            .reachable(
                catalog,
                &["animal.cat".to_owned(), "vehicle.car".to_owned()],
            )
            .unwrap_err();
        assert_eq!(err.rule, "actor_model_withheld");
        assert!(err.message.contains("animal.cat"));
    }

    #[test]
    fn licence_tables_are_accepted_and_checked() {
        let sha = "a".repeat(64);
        let doc = |licenses: &str| {
            format!(
                r#"{{"schema":"simforge.actor-assets-closure/v1","members":{{"catalog-models.json":{{"bytes":1,"sha256":"{sha}"}}}},"licenses":{licenses}}}"#
            )
        };
        let ok = ActorClosure::parse(
            doc(r#"{"catalog-models.json":{"license":"Apache-2.0","attribution":"SimForge, Inc."}}"#).as_bytes(),
        )
        .unwrap();
        assert!(ok.licenses.is_some());
        for bad in [
            r#"{"models/x.glb":{"license":"CC-BY-4.0"}}"#,
            r#"{"catalog-models.json":{"attribution":"no licence"}}"#,
        ] {
            let err = ActorClosure::parse(doc(bad).as_bytes()).unwrap_err();
            assert_eq!(err.rule, "actor_closure_schema");
        }
    }
}
