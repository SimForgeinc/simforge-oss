//! The closure listings a package carries, and the blob index they define.
//!
//! - `map/closure.json`: the map registry release's CANONICAL closure,
//!   `map-closure.v1` kind `canonical` (`{schema, kind, members: {<path>:
//!   {sha256, bytes, ...}}, metadata: {master: true}}`), byte for byte as the
//!   registry serves it: canonical JSON whose sha256 is the release's
//!   `closureDigest` (`map.canonicalClosureSha256`). It lists the native render
//!   assets (`master.gltf`, `geometry.bin`) and every derivative built into it
//!   (ground, geometry LOD, luminaires, decals, texture tiers).
//! - `map/web-closure.json` (when the release has one): the release's web
//!   closure, kind `web` (`map.webClosureSha256`). The CLI reads a few of its
//!   web-only members ([`is_cli_web_member`]).
//! - `actors/closure.json`: `simforge.actor-assets-closure/v1`,
//!   `{schema, members: {<path>: {bytes, sha256}}, licenses?}`; its sha256 is
//!   `catalog.actorClosureDigest`.
//!
//! Blobs (`blobs/sha256/<aa>/<sha256>`) are exactly the digests these
//! listings name, each stored once.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use simforge_core::hash::sha256_bytes;

use crate::error::{PackageError, Result};
use crate::manifest::{ACTOR_CLOSURE_SCHEMA, MAP_CLOSURE_SCHEMA, MAX_SAFE_INTEGER};
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

/// Web-closure members the CLI reads besides the canonical closure: the
/// static colliders (a simulation member published web-side) and the
/// ambient turn verdicts. A full package embeds them when the web closure
/// lists them.
pub const CLI_WEB_MEMBERS_EXACT: [&str; 1] = ["derived/ambient/turn-verdicts.json.gz"];

pub fn is_cli_web_member(path: &str) -> bool {
    is_simulation_member(path) || CLI_WEB_MEMBERS_EXACT.contains(&path)
}

/// One member of a registry closure: its digest and size (other fields are
/// kept by the document, never read).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapClosureMember {
    pub sha256: String,
    pub bytes: u64,
}

/// A registry closure document (`map-closure.v1`), parsed like the
/// registry's `assertClosure`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapClosure {
    /// `canonical` or `web`.
    pub kind: String,
    /// `metadata.master`: the tiled native master format.
    pub master: bool,
    pub members: BTreeMap<String, MapClosureMember>,
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
    /// Parse `path` (`map/closure.json` or `map/web-closure.json`) and require
    /// the kind its role names.
    pub fn parse(bytes: &[u8], kind: &str, path: &str) -> Result<Self> {
        let bad = |why: String| {
            PackageError::closure("map_closure_schema", format!("{path}: {why}")).at(path)
        };
        let doc: Value = serde_json::from_slice(bytes).map_err(|e| bad(e.to_string()))?;
        let obj = doc.as_object().ok_or_else(|| bad("not an object".into()))?;
        if obj.get("schema").and_then(Value::as_str) != Some(MAP_CLOSURE_SCHEMA) {
            return Err(bad(format!("schema is not {MAP_CLOSURE_SCHEMA}")));
        }
        let found = obj.get("kind").and_then(Value::as_str).unwrap_or_default();
        if found != kind {
            return Err(bad(format!(
                "kind is {found:?}, this member holds the {kind} closure"
            )));
        }
        if kind != "canonical" && obj.get("toolFingerprint").is_none() {
            return Err(bad(format!("a {kind} closure names its toolFingerprint")));
        }
        let master = obj
            .get("metadata")
            .and_then(|m| m.get("master"))
            .and_then(Value::as_bool)
            == Some(true);
        if kind == "canonical" && !master {
            return Err(bad(
                "the canonical closure predates the map master format (metadata.master); re-ingest the map".into(),
            ));
        }
        let listed = obj
            .get("members")
            .and_then(Value::as_object)
            .filter(|m| !m.is_empty())
            .ok_or_else(|| bad("members must be a non-empty object".into()))?;
        let mut members = BTreeMap::new();
        for (p, m) in listed {
            let sha = m.get("sha256").and_then(Value::as_str).unwrap_or_default();
            let size = m.get("bytes").and_then(Value::as_u64);
            match size {
                Some(size) if is_relative_path(p) && is_hex64(sha) && size <= MAX_SAFE_INTEGER => {
                    members.insert(
                        p.clone(),
                        MapClosureMember {
                            sha256: sha.to_owned(),
                            bytes: size,
                        },
                    );
                }
                _ => return Err(bad(format!("member {p:?} is malformed"))),
            }
        }
        Ok(Self {
            kind: kind.to_owned(),
            master,
            members,
        })
    }

    pub fn member(&self, path: &str) -> Option<&MapClosureMember> {
        self.members.get(path)
    }

    pub fn total_bytes(&self) -> u64 {
        self.members.values().map(|m| m.bytes).sum()
    }
}

/// A path listed by both map closures must name the same bytes.
pub fn paths_agree(canonical: &MapClosure, web: &MapClosure) -> Result<()> {
    for (p, m) in &web.members {
        if let Some(c) = canonical.members.get(p) {
            if c.sha256 != m.sha256 {
                return Err(PackageError::closure(
                    "closure_path_conflict",
                    format!(
                        "{p} is {} in the canonical closure and {} in the web closure",
                        c.sha256, m.sha256
                    ),
                )
                .at(p.clone()));
            }
        }
    }
    Ok(())
}

/// `simforge.map-pin-closure/v1`: sha256 over `"<path> <sha256>\n"` lines of
/// the simulation members, in byte order of path, over the canonical closure
/// and the web closure together (static colliders are published web-side).
pub fn pin_closure_sha256(canonical: &MapClosure, web: Option<&MapClosure>) -> String {
    let mut sim = BTreeMap::new();
    for c in std::iter::once(canonical).chain(web) {
        for (p, m) in &c.members {
            if is_simulation_member(p) {
                sim.insert(p.as_str(), m.sha256.as_str());
            }
        }
    }
    let mut text = String::new();
    for (p, h) in sim {
        text.push_str(p);
        text.push(' ');
        text.push_str(h);
        text.push('\n');
    }
    sha256_bytes(text.as_bytes())
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

/// digest → size, over every closure listing. A digest listed twice (within
/// or across closures) must carry one size; it is one blob. A path listed by
/// both map closures must name the same bytes.
pub fn blob_index(
    canonical: &MapClosure,
    web: Option<&MapClosure>,
    actors: &ActorClosure,
) -> Result<BTreeMap<String, u64>> {
    if let Some(web) = web {
        paths_agree(canonical, web)?;
    }
    let mut index: BTreeMap<String, u64> = BTreeMap::new();
    let listed = canonical
        .members
        .iter()
        .chain(web.into_iter().flat_map(|w| w.members.iter()))
        .map(|(p, m)| (p, &m.sha256, m.bytes))
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
