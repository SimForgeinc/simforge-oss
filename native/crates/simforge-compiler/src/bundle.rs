//! A "map bundle" is the join of the map producers' artifacts:
//!
//! | artifact | producer | consumer here |
//! |---|---|---|
//! | `topology-index.json.gz` | map pipeline | the engine's `LaneGraph` and the lane/gate spine |
//! | `derived/topology-derived.json.gz` | map-intel | the matcher's `DerivedMapIndex` |
//! | `derived/locations.json.gz` | map-intel | crossing / parking / occlusion point features |
//! | `map.xodr` + `signals.geojson.gz` | RoadRunner export | physical signal heads and controllers |
//! | `variants/static-colliders-v1.json` | map pipeline (optional) | static map collision proxies |
//!
//! The graph is shared by `Arc` so a bundle can be cloned per world for free.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use simforge_core::engine::{StaticColliderClass, StaticMapCollider};
use simforge_core::hash::sha256_bytes;
use simforge_core::map::{LaneGraph, TopologyIndex};

use crate::error::{CompileError, CompileResult};
use crate::map_index::{normalize_derived_map_index, DerivedMapIndex, NormalizeOptions};
use crate::map_signals::{
    parse_map_signal_catalog, topology_with_map_speed_limits, MapSignalCatalog,
};

pub const TOPOLOGY_FILE: &str = "topology-index.json.gz";
pub const DERIVED_FILE: &str = "derived/topology-derived.json.gz";
pub const LOCATIONS_FILE: &str = "derived/locations.json.gz";
pub const SEARCH_INDEX_FILE: &str = "search-index.json.gz";
pub const XODR_FILE: &str = "map.xodr";
pub const SIGNALS_FILE: &str = "signals.geojson.gz";
pub const STATIC_COLLIDERS_MANIFEST: &str = "variants/manifest.json";
pub const STATIC_COLLIDERS_SCHEMA: &str = "simforge.static-map-colliders/v1";

/// Files a complete installed map must carry.
pub const REQUIRED_FILES: [&str; 5] = [
    XODR_FILE,
    SIGNALS_FILE,
    TOPOLOGY_FILE,
    DERIVED_FILE,
    LOCATIONS_FILE,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StaticColliderStatus {
    Ready,
    Unavailable,
}

/// Provenance of the static-collider layer, so a run can prove whether map
/// collision proxies were present rather than silently simulating without.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticColliderDiagnostics {
    pub digest: String,
    pub status: StaticColliderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub source_tiles: usize,
    pub accepted: usize,
    pub rejected_road_overlap: usize,
    pub ignored: usize,
    pub classes: BTreeMap<String, usize>,
}

impl StaticColliderDiagnostics {
    pub fn unavailable(warning: impl Into<String>) -> Self {
        Self {
            digest: "static-colliders-v1-unavailable".to_owned(),
            status: StaticColliderStatus::Unavailable,
            warning: Some(warning.into()),
            source_tiles: 0,
            accepted: 0,
            rejected_road_overlap: 0,
            ignored: 0,
            classes: ["building", "wall", "barrier", "prop", "road-boundary"]
                .into_iter()
                .map(|c| (c.to_owned(), 0))
                .collect(),
        }
    }
}

/// Everything a bundle can be built from, already decoded.
#[derive(Debug, Clone, Default)]
pub struct MapBundleSources {
    pub map_id: String,
    pub topology: Option<TopologyIndex>,
    /// `derived/topology-derived.json` (map-intel). Absent → self-derived index.
    pub derived: Option<Value>,
    /// `derived/locations.json`.
    pub locations: Option<Value>,
    /// `search-index.json` (junction control facts).
    pub search_index: Option<Value>,
    /// OpenDRIVE text. Together with `signals_geojson` it yields the signal catalog.
    pub xodr: Option<String>,
    pub signals_geojson: Option<Value>,
    pub static_colliders: Option<(Vec<StaticMapCollider>, StaticColliderDiagnostics)>,
}

struct Inner {
    map_id: String,
    dir: Option<PathBuf>,
    topology: TopologyIndex,
    index: DerivedMapIndex,
    graph: Arc<LaneGraph>,
    signal_catalog: MapSignalCatalog,
    static_colliders: Vec<StaticMapCollider>,
    static_collider_diagnostics: StaticColliderDiagnostics,
}

/// A loaded map: topology, lane graph, derived index, signal catalog and
/// static collision resources. Cheap to clone.
#[derive(Clone)]
pub struct MapBundle {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for MapBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MapBundle")
            .field("map_id", &self.inner.map_id)
            .field("topology_digest", &self.inner.index.topology_digest)
            .field("lanes", &self.inner.topology.lanes.len())
            .field("static_colliders", &self.inner.static_colliders.len())
            .finish()
    }
}

fn read_bytes(path: &Path, code: &str) -> CompileResult<Vec<u8>> {
    std::fs::read(path).map_err(|e| {
        CompileError::at(
            code,
            path.display().to_string(),
            format!("cannot read {}: {e}", path.display()),
        )
    })
}

fn gunzip_if_needed(bytes: Vec<u8>) -> CompileResult<Vec<u8>> {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut plain = Vec::new();
        flate2::read::MultiGzDecoder::new(bytes.as_slice())
            .read_to_end(&mut plain)
            .map_err(|e| CompileError::new("invalid_gzip", e.to_string()))?;
        Ok(plain)
    } else {
        Ok(bytes)
    }
}

fn read_json_gz(path: &Path, code: &str) -> CompileResult<Value> {
    let plain = gunzip_if_needed(read_bytes(path, code)?)?;
    serde_json::from_slice(&plain)
        .map_err(|e| CompileError::at("invalid_json", path.display().to_string(), e.to_string()))
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Read the published static-collider derivative beside the map bundle.
/// Missing or stale artifacts resolve to diagnostics: runtime mesh inspection
/// is deliberately not a fallback.
pub fn load_static_colliders(dir: &Path) -> (Vec<StaticMapCollider>, StaticColliderDiagnostics) {
    match load_static_colliders_strict(dir) {
        Ok(v) => v,
        Err(e) => (Vec::new(), StaticColliderDiagnostics::unavailable(e.reason)),
    }
}

fn load_static_colliders_strict(
    dir: &Path,
) -> CompileResult<(Vec<StaticMapCollider>, StaticColliderDiagnostics)> {
    let manifest_path = dir.join(STATIC_COLLIDERS_MANIFEST);
    if !manifest_path.is_file() {
        return Err(CompileError::new(
            "static_colliders_missing",
            "Static collision derivative is not published for this map",
        ));
    }
    let manifest: Value =
        serde_json::from_slice(&read_bytes(&manifest_path, "static_colliders_missing")?)
            .map_err(|e| CompileError::new("invalid_json", e.to_string()))?;
    let source_sha = manifest
        .get("sourceManifestSha256")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_sha256(source_sha) {
        return Err(CompileError::new(
            "static_colliders_stale",
            "Static collision derivative targets a stale map bundle",
        ));
    }
    let source_manifest = dir.join("manifest.json");
    if source_manifest.is_file()
        && sha256_bytes(&read_bytes(&source_manifest, "static_colliders_missing")?) != source_sha
    {
        return Err(CompileError::new(
            "static_colliders_stale",
            "Static collision derivative targets a stale map bundle",
        ));
    }
    let variant = manifest
        .get("variants")
        .and_then(|v| v.get("static-colliders"))
        .ok_or_else(|| {
            CompileError::new(
                "static_colliders_missing",
                "Static collision derivative is not published for this map",
            )
        })?;
    let file = variant.get("file").and_then(Value::as_str);
    let output_sha = variant
        .get("outputSha256")
        .and_then(Value::as_str)
        .unwrap_or("");
    if variant.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || file.is_none()
        || !is_sha256(output_sha)
    {
        return Err(CompileError::new(
            "static_colliders_missing",
            "Static collision derivative is not published for this map",
        ));
    }
    let artifact_path = dir.join("variants").join(file.expect("checked"));
    let bytes = read_bytes(&artifact_path, "static_colliders_missing")?;
    if sha256_bytes(&bytes) != output_sha {
        return Err(CompileError::new(
            "static_colliders_checksum",
            "Static collision artifact checksum mismatch",
        ));
    }
    let artifact: Value = serde_json::from_slice(&bytes)
        .map_err(|e| CompileError::new("invalid_json", e.to_string()))?;
    if artifact.get("schema").and_then(Value::as_str) != Some(STATIC_COLLIDERS_SCHEMA)
        || !artifact.get("mapId").is_some_and(Value::is_string)
    {
        return Err(CompileError::new(
            "static_colliders_schema",
            "Static collision artifact has an unsupported schema",
        ));
    }
    if artifact.get("sourceManifestSha256").and_then(Value::as_str) != Some(source_sha) {
        return Err(CompileError::new(
            "static_colliders_stale",
            "Static collision artifact targets a different map bundle",
        ));
    }
    let colliders: Vec<StaticMapCollider> = serde_json::from_value(
        artifact.get("colliders").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| {
        CompileError::new(
            "static_colliders_schema",
            format!("Static collision artifact has malformed collections: {e}"),
        )
    })?;
    let sources = artifact
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CompileError::new(
                "static_colliders_schema",
                "Static collision artifact has malformed collections",
            )
        })?;
    let statistics = artifact
        .get("statistics")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            CompileError::new(
                "static_colliders_schema",
                "Static collision artifact statistics do not match its contents",
            )
        })?;
    let count = |key: &str| -> CompileResult<usize> {
        statistics
            .get(key)
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .ok_or_else(|| {
                CompileError::new(
                    "static_colliders_schema",
                    "Static collision artifact statistics are malformed",
                )
            })
    };
    let accepted = count("accepted")?;
    let source_tiles = count("sourceTiles")?;
    if accepted != colliders.len() || source_tiles != sources.len() {
        return Err(CompileError::new(
            "static_colliders_schema",
            "Static collision artifact statistics do not match its contents",
        ));
    }
    let mut classes: BTreeMap<String, usize> =
        ["building", "wall", "barrier", "prop", "road-boundary"]
            .into_iter()
            .map(|c| (c.to_owned(), 0))
            .collect();
    for c in &colliders {
        let key = match c.class {
            StaticColliderClass::Building => "building",
            StaticColliderClass::Wall => "wall",
            StaticColliderClass::Barrier => "barrier",
            StaticColliderClass::Prop => "prop",
            StaticColliderClass::RoadBoundary => "road-boundary",
        };
        *classes.entry(key.to_owned()).or_insert(0) += 1;
    }
    let digest = artifact
        .get("digest")
        .and_then(Value::as_str)
        .unwrap_or(output_sha)
        .to_owned();
    Ok((
        colliders,
        StaticColliderDiagnostics {
            digest,
            status: StaticColliderStatus::Ready,
            warning: None,
            source_tiles,
            accepted,
            rejected_road_overlap: count("rejectedRoadOverlap")?,
            ignored: count("ignored")?,
            classes,
        },
    ))
}

impl MapBundle {
    /// Load an installed map directory (`dev-assets/<mapId>` layout).
    pub fn load(dir: &Path) -> CompileResult<Self> {
        let map_id = dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
            .ok_or_else(|| {
                CompileError::at(
                    "unknown_map",
                    dir.display().to_string(),
                    "map directory has no name",
                )
            })?;
        Self::load_as(dir, &map_id)
    }

    /// Load an installed map directory under an explicit map id.
    pub fn load_as(dir: &Path, map_id: &str) -> CompileResult<Self> {
        if !dir.is_dir() {
            return Err(CompileError::at(
                "unknown_map",
                "--map",
                format!("no installed map \"{map_id}\""),
            )
            .detail_entry("dir", Value::String(dir.display().to_string())));
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
            .detail_entry("missing", serde_json::json!(missing)));
        }
        let topology_bytes = gunzip_if_needed(read_bytes(
            &dir.join(TOPOLOGY_FILE),
            "missing_topology_index",
        )?)?;
        let topology = TopologyIndex::from_json_slice(&topology_bytes)?;
        let derived = read_json_gz(&dir.join(DERIVED_FILE), "missing_derived_topology")?;
        let locations = read_json_gz(&dir.join(LOCATIONS_FILE), "missing_location_catalog")?;
        let search_index = dir
            .join(SEARCH_INDEX_FILE)
            .is_file()
            .then(|| read_json_gz(&dir.join(SEARCH_INDEX_FILE), "missing_search_index"))
            .transpose()?;
        let xodr_bytes = read_bytes(&dir.join(XODR_FILE), "missing_xodr")?;
        if let Some(expected) = topology
            .source
            .as_ref()
            .and_then(|s| s.xodr_sha256.as_deref())
        {
            if !expected.is_empty() && expected != sha256_bytes(&xodr_bytes) {
                return Err(CompileError::at(
                    "map_topology_source_mismatch",
                    dir.display().to_string(),
                    format!("map \"{map_id}\" mixes different OpenDRIVE and topology versions"),
                ));
            }
        }
        let signals = read_json_gz(&dir.join(SIGNALS_FILE), "missing_signals")?;
        let static_colliders = load_static_colliders(dir);
        let mut bundle = Self::from_sources(MapBundleSources {
            map_id: map_id.to_owned(),
            topology: Some(topology),
            derived: Some(derived),
            locations: Some(locations),
            search_index,
            xodr: Some(String::from_utf8_lossy(&xodr_bytes).into_owned()),
            signals_geojson: Some(signals),
            static_colliders: Some(static_colliders),
        })?;
        Arc::get_mut(&mut bundle.inner)
            .expect("freshly built bundle is unshared")
            .dir = Some(dir.to_path_buf());
        Ok(bundle)
    }

    /// A bundle from a topology alone: self-derived index, no physical
    /// signal catalog, no static colliders.
    pub fn from_topology(map_id: &str, topology: TopologyIndex) -> CompileResult<Self> {
        Self::from_sources(MapBundleSources {
            map_id: map_id.to_owned(),
            topology: Some(topology),
            ..Default::default()
        })
    }

    /// Build from decoded sources.
    pub fn from_sources(sources: MapBundleSources) -> CompileResult<Self> {
        let MapBundleSources {
            map_id,
            topology,
            derived,
            locations,
            search_index,
            xodr,
            signals_geojson,
            static_colliders,
        } = sources;
        if map_id.is_empty() {
            return Err(CompileError::new(
                "unknown_map",
                "a map bundle needs a map id",
            ));
        }
        let mut topology = topology.ok_or_else(|| {
            CompileError::new(
                "missing_topology_index",
                "a map bundle needs a topology index",
            )
        })?;
        let signal_catalog = match (&xodr, &signals_geojson) {
            (Some(xodr), Some(signals)) => parse_map_signal_catalog(xodr, signals),
            _ => MapSignalCatalog::default(),
        };
        topology_with_map_speed_limits(&mut topology, &signal_catalog);
        let derived_value = derived.unwrap_or(Value::Object(Default::default()));
        let index = normalize_derived_map_index(
            &derived_value,
            &topology,
            &NormalizeOptions {
                map_id: Some(map_id.clone()),
                search_index: search_index.as_ref(),
                handedness: None,
                locations: locations.as_ref(),
            },
        );
        let graph = Arc::new(LaneGraph::new(topology.clone()));
        let (static_colliders, static_collider_diagnostics) =
            static_colliders.unwrap_or_else(|| {
                (
                    Vec::new(),
                    StaticColliderDiagnostics::unavailable(
                        "no static collision derivative supplied",
                    ),
                )
            });
        Ok(Self {
            inner: Arc::new(Inner {
                map_id,
                dir: None,
                topology,
                index,
                graph,
                signal_catalog,
                static_colliders,
                static_collider_diagnostics,
            }),
        })
    }

    pub fn map_id(&self) -> &str {
        &self.inner.map_id
    }

    /// The installed directory, when loaded from disk.
    pub fn dir(&self) -> Option<&Path> {
        self.inner.dir.as_deref()
    }

    pub fn topology_digest(&self) -> &str {
        &self.inner.index.topology_digest
    }

    pub fn topology(&self) -> &TopologyIndex {
        &self.inner.topology
    }

    pub fn index(&self) -> &DerivedMapIndex {
        &self.inner.index
    }

    pub fn graph(&self) -> &Arc<LaneGraph> {
        &self.inner.graph
    }

    pub fn signal_catalog(&self) -> &MapSignalCatalog {
        &self.inner.signal_catalog
    }

    pub fn static_colliders(&self) -> &[StaticMapCollider] {
        &self.inner.static_colliders
    }

    pub fn static_collider_diagnostics(&self) -> &StaticColliderDiagnostics {
        &self.inner.static_collider_diagnostics
    }

    /// The signal-binding view used by the map-signal module.
    pub fn signal_view(&self) -> crate::map_signals::SignalMapView<'_> {
        crate::map_signals::SignalMapView {
            index: &self.inner.index,
            graph: &self.inner.graph,
            topology: &self.inner.topology,
            signal_catalog: &self.inner.signal_catalog,
        }
    }
}

/// Map ids found under a dev-assets root, sorted.
pub fn available_maps(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|name| {
            is_map_id(name)
                && REQUIRED_FILES
                    .iter()
                    .all(|f| root.join(name).join(f).is_file())
        })
        .collect();
    out.sort();
    out
}

fn is_map_id(s: &str) -> bool {
    !s.is_empty()
        && s.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}
