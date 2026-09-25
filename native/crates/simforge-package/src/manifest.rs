//! The `simforge.scenario-package/v1` manifest: types, strict parsing,
//! canonical encoding and the package id.
//!
//! ```text
//! manifestBytes = canonicalJson(manifest)     // simforge.canonical-json/v1
//! packageId     = sha256(manifestBytes)
//! ```
//!
//! Every object is closed (`deny_unknown_fields`); the only open object is
//! `extensions`. A field that must be understood bumps the manifest to v2.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use simforge_core::hash::{canonical_json, canonical_json_of, sha256_bytes};

use crate::error::{ErrorCode, PackageError, Result};
use crate::names::{is_allowed_name, is_hex64, Role, MANIFEST_PATH, RECEIPT_PATH};

pub const SCHEMA: &str = "simforge.scenario-package/v1";
pub const SCHEMA_PREFIX: &str = "simforge.scenario-package/v";
pub const MAJOR: u64 = 1;
pub const ACTOR_CLOSURE_SCHEMA: &str = "simforge.actor-assets-closure/v1";
pub const RESOLUTION_SCHEMA: &str = "simforge.sim-resolution/v1";
pub const BROWSER_ASSET_SET_SCHEMA: &str = "uniscenario.browser-asset-set/v1";
pub const RENDER_PIN_SCHEMA: &str = "simforge.render-pin/v1";
pub const SAMPLER_PREFIX: &str = "simforge.timeline-sampler/";
/// Largest integer a JavaScript reader represents exactly.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    pub schema: String,
    pub producer: Producer,
    pub scenario: ScenarioRef,
    pub engine: EngineRef,
    pub simulation: SimulationRef,
    pub timelines: Vec<TimelineRef>,
    pub execution_package: Option<ExecutionPackageRef>,
    pub map: MapRef,
    pub catalog: CatalogRef,
    pub members: Vec<MemberEntry>,
    pub render: Option<RenderRef>,
    pub provenance: Provenance,
    pub extensions: BTreeMap<String, Value>,
}

/// Who wrote the package, and the oldest CLI that can read it (PLAN §2.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Producer {
    /// `simcloud`, `simforge-cli`, `local-studio`, ...: `^[a-z][a-z0-9-]{0,63}$`.
    pub app: String,
    /// Semver of the producing app.
    pub app_version: String,
    /// Semver: a reader older than this refuses the package.
    pub min_cli: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ScenarioRef {
    pub title: String,
    pub document_schema: String,
    pub scenario_version: u32,
    pub content_sha256: String,
    pub sim_content_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ScenarioOrigin>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ScenarioOrigin {
    pub document_id: String,
    pub revision_id: String,
    pub revision_number: u32,
    pub committed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EngineRef {
    pub engine_sem_ver: String,
    pub solver_version: String,
    pub pipeline_revision: u32,
    pub build: EngineBuild,
    pub release: String,
}

/// `sim_results.engine_build`, the recorded fields only. Provenance.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EngineBuild {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abi_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addon_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProducerKind {
    Inline,
    Runner,
    Cli,
    Editor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SimulationRef {
    pub sim_key: String,
    pub trace_format: u32,
    pub trace_schema: String,
    pub trace_sha256: String,
    pub trace_gzip_sha256: String,
    pub authored_trace_sha256: String,
    pub resolved_input_digest: String,
    pub resolution_sha256: String,
    pub traffic_provider: String,
    pub traffic_step_key: Option<String>,
    pub traffic_sha256: Option<String>,
    pub sumo: Option<SumoRef>,
    pub ground_digest: Option<String>,
    pub producer_kind: ProducerKind,
    pub simulated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SumoRef {
    pub network_sha256: String,
    pub runtime_version: String,
    pub wasm_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TimelineRef {
    pub version: String,
    pub sampler_version: String,
    pub timeline_key: String,
    pub timeline_sha256: String,
    pub height_field_digest: String,
    pub catalog_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExecutionPackageRef {
    pub contract: String,
    pub xosc_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CountBytes {
    pub member_count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MapRef {
    pub map_version_id: String,
    pub source_map_id: String,
    pub label: String,
    pub xodr_sha256: String,
    pub coordinate_system_sha256: String,
    pub map_closure_digest: String,
    pub pin_closure_sha256: String,
    pub browser_closure_sha256: String,
    pub height_source_digest: String,
    pub ground_digest: Option<String>,
    pub closure: CountBytes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BlobCount {
    pub count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogRef {
    pub asset_catalog_version_id: Option<String>,
    pub catalog_sha256: String,
    pub actor_closure_digest: String,
    pub actor_closure_schema: String,
    pub catalog_ids: Vec<String>,
    pub referenced_actor_blobs: BlobCount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MemberEntry {
    pub path: String,
    pub role: Role,
    pub sha256: String,
    pub size: u64,
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RenderMode {
    ReproduceExactly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RendererKind {
    NativeBevy,
    Carla,
}

/// Reproduce-exactly pin (section 6). `render/pin.json` holds exactly
/// `canonicalJson(render)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RenderRef {
    pub mode: RenderMode,
    pub renderer: RendererKind,
    pub image_digest: String,
    pub runtime_version: String,
    pub renderer_build: String,
    pub gpu: RenderGpu,
    pub profile: RenderProfile,
    pub timeline_sha256: String,
    pub source_outputs: Option<RenderSourceOutputs>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RenderGpu {
    pub model: String,
    pub driver_version: String,
    #[serde(rename = "vramGiB")]
    pub vram_gib: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RenderProfile {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub capture_policy: String,
    pub texture_tier: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RenderSourceOutputs {
    pub frame_manifest_sha256: String,
    pub video_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallationKind {
    LocalStudio,
    Simcloud,
    Cli,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Provenance {
    pub installation_kind: InstallationKind,
    pub installation_id: String,
    pub author_display_name: Option<String>,
}

/* ------------------------------------------------------------------ encoding */

fn not_canonical(what: &str) -> PackageError {
    PackageError::new(
        ErrorCode::ManifestNotCanonical,
        "not_canonical",
        format!("{what} is not canonical JSON (simforge.canonical-json/v1)"),
    )
}

/// Parse JSON bytes and require them to be exactly their own canonical form.
pub fn parse_canonical(bytes: &[u8], what: &str) -> Result<Value, Option<PackageError>> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| None)?;
    match canonical_json(&value) {
        Ok(text) if text.as_bytes() == bytes => Ok(value),
        _ => Err(Some(not_canonical(what))),
    }
}

impl Manifest {
    /// `canonicalJson(manifest)`: the exact bytes of `manifest.json`.
    pub fn to_canonical_bytes(&self) -> Result<Vec<u8>> {
        canonical_json_of(self)
            .map(String::into_bytes)
            .map_err(|e| PackageError::manifest("unencodable", e.to_string()))
    }

    /// `sha256(canonicalJson(manifest))`.
    pub fn package_id(&self) -> Result<String> {
        Ok(sha256_bytes(&self.to_canonical_bytes()?))
    }

    /// Strictly parse `manifest.json` bytes that are already known to be a v1
    /// manifest (see [`crate::skew::manifest_major`]): canonical bytes, closed
    /// schema, every invariant of [`Manifest::validate`].
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let value = parse_canonical(bytes, MANIFEST_PATH).map_err(|e| {
            e.unwrap_or_else(|| PackageError::manifest("not_json", "manifest.json is not JSON"))
        })?;
        Self::from_value(value)
    }

    /// Typed parse of a decoded manifest, then validation. The typed form
    /// must re-encode to the same value (so `null` where a field is absent,
    /// or a float where an integer belongs, is refused rather than dropped).
    pub fn from_value(value: Value) -> Result<Self> {
        let manifest: Manifest = serde_json::from_value(value.clone())
            .map_err(|e| PackageError::manifest("schema", e.to_string()))?;
        let again = canonical_json_of(&manifest)
            .map_err(|e| PackageError::manifest("unencodable", e.to_string()))?;
        let given = canonical_json(&value)
            .map_err(|e| PackageError::manifest("unencodable", e.to_string()))?;
        if again != given {
            return Err(PackageError::manifest(
                "schema",
                "the manifest carries a value its typed form cannot represent (null for an absent optional, or a non-integer count)",
            ));
        }
        manifest.validate()?;
        Ok(manifest)
    }

    /// Member entry by path.
    pub fn member(&self, path: &str) -> Option<&MemberEntry> {
        self.members
            .binary_search_by(|m| m.path.as_str().cmp(path))
            .ok()
            .map(|i| &self.members[i])
    }

    pub fn members_with_role(&self, role: Role) -> impl Iterator<Item = &MemberEntry> {
        self.members.iter().filter(move |m| m.role == role)
    }

    /// The contract string a member of `role` must carry in `schema`.
    pub fn expected_member_schema(&self, role: Role) -> Option<String> {
        match role {
            Role::Document => Some(self.scenario.document_schema.clone()),
            Role::Trace => Some(self.simulation.trace_schema.clone()),
            Role::Resolution => Some(RESOLUTION_SCHEMA.to_owned()),
            Role::Timeline => {
                Some(simforge_core::trace::timeline::RENDER_TIMELINE_VERSION.to_owned())
            }
            Role::MapClosure => Some(BROWSER_ASSET_SET_SCHEMA.to_owned()),
            Role::ActorClosure => Some(self.catalog.actor_closure_schema.clone()),
            Role::RenderPin => Some(RENDER_PIN_SCHEMA.to_owned()),
            Role::Traffic | Role::Catalog | Role::Xosc => None,
        }
    }

    /// Every schema and self-consistency rule that needs no member bytes.
    pub fn validate(&self) -> Result<()> {
        let bad = |rule: &'static str, msg: String| Err(PackageError::manifest(rule, msg));
        if self.schema != SCHEMA {
            return bad(
                "schema",
                format!("schema is {:?}, expected {SCHEMA}", self.schema),
            );
        }
        // producer
        let p = &self.producer;
        let app_ok = p.app.len() <= 64
            && p.app.starts_with(|c: char| c.is_ascii_lowercase())
            && p.app
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !app_ok {
            return bad(
                "producer",
                format!("producer.app {:?} is not ^[a-z][a-z0-9-]{{0,63}}$", p.app),
            );
        }
        for (field, v) in [
            ("producer.appVersion", &p.app_version),
            ("producer.minCli", &p.min_cli),
        ] {
            if semver::Version::parse(v).is_err() {
                return bad(
                    "producer",
                    format!("{field} {v:?} is not a semantic version"),
                );
            }
        }
        // scenario
        let s = &self.scenario;
        plain_text("scenario.title", &s.title, 1, 200)?;
        if s.document_schema != format!("simforge.scenario.v{}", s.scenario_version) {
            return bad(
                "scenario",
                format!(
                    "scenario.documentSchema {:?} does not name scenarioVersion {}",
                    s.document_schema, s.scenario_version
                ),
            );
        }
        digest("scenario.contentSha256", &s.content_sha256)?;
        digest("scenario.simContentSha256", &s.sim_content_sha256)?;
        if let Some(o) = &s.origin {
            id("scenario.origin.documentId", &o.document_id)?;
            id("scenario.origin.revisionId", &o.revision_id)?;
            timestamp("scenario.origin.committedAt", &o.committed_at)?;
        }
        // engine
        let e = &self.engine;
        if semver::Version::parse(&e.engine_sem_ver).is_err() {
            return bad(
                "engine",
                format!(
                    "engine.engineSemVer {:?} is not a semantic version",
                    e.engine_sem_ver
                ),
            );
        }
        plain_text("engine.solverVersion", &e.solver_version, 1, 64)?;
        plain_text("engine.release", &e.release, 1, 64)?;
        for (field, v) in [
            ("engine.build.engineVersion", &e.build.engine_version),
            ("engine.build.sourceRevision", &e.build.source_revision),
        ] {
            if let Some(v) = v {
                plain_text(field, v, 1, 128)?;
            }
        }
        for (field, v) in [
            ("engine.build.buildDigest", &e.build.build_digest),
            ("engine.build.addonSha256", &e.build.addon_sha256),
        ] {
            if let Some(v) = v {
                digest(field, v)?;
            }
        }
        // simulation
        let sim = &self.simulation;
        for (field, v) in [
            ("simulation.simKey", &sim.sim_key),
            ("simulation.traceSha256", &sim.trace_sha256),
            ("simulation.traceGzipSha256", &sim.trace_gzip_sha256),
            ("simulation.authoredTraceSha256", &sim.authored_trace_sha256),
            ("simulation.resolvedInputDigest", &sim.resolved_input_digest),
            ("simulation.resolutionSha256", &sim.resolution_sha256),
        ] {
            digest(field, v)?;
        }
        if sim.trace_format == 0
            || sim.trace_schema != format!("simforge.trace/v{}", sim.trace_format)
        {
            return bad(
                "simulation",
                format!(
                    "simulation.traceSchema {:?} does not name traceFormat {}",
                    sim.trace_schema, sim.trace_format
                ),
            );
        }
        if !is_token(&sim.traffic_provider, 32) {
            return bad(
                "simulation",
                format!(
                    "simulation.trafficProvider {:?} is not a token",
                    sim.traffic_provider
                ),
            );
        }
        if let Some(k) = &sim.traffic_step_key {
            if !is_token(k, 256) {
                return bad(
                    "simulation",
                    "simulation.trafficStepKey is not a token".to_owned(),
                );
            }
        }
        if let Some(d) = &sim.traffic_sha256 {
            digest("simulation.trafficSha256", d)?;
        }
        if let Some(sumo) = &sim.sumo {
            digest("simulation.sumo.networkSha256", &sumo.network_sha256)?;
            digest("simulation.sumo.wasmSha256", &sumo.wasm_sha256)?;
            plain_text(
                "simulation.sumo.runtimeVersion",
                &sumo.runtime_version,
                1,
                64,
            )?;
        }
        // From trace format 5 the digest is present exactly when the
        // simulation ran on a ground surface; whether the map has one is
        // checked against map/closure.json (check.rs, rule ground_digest).
        match (&sim.ground_digest, sim.trace_format >= 5) {
            (Some(d), true) => digest("simulation.groundDigest", d)?,
            (None, _) => {}
            (Some(_), false) => {
                return bad(
                    "ground_digest",
                    "simulation.groundDigest must be null before trace format 5".to_owned(),
                )
            }
        }
        if self.map.ground_digest != sim.ground_digest {
            return bad(
                "ground_digest",
                "map.groundDigest must equal simulation.groundDigest".to_owned(),
            );
        }
        timestamp("simulation.simulatedAt", &sim.simulated_at)?;
        // timelines
        if self.timelines.is_empty() {
            return bad(
                "timelines",
                "timelines[] must list at least one timeline".to_owned(),
            );
        }
        let mut shas = BTreeSet::new();
        let mut keys = BTreeSet::new();
        for (i, t) in self.timelines.iter().enumerate() {
            plain_text(&format!("timelines[{i}].version"), &t.version, 1, 64)?;
            if sampler_number(&t.sampler_version).is_none() {
                return bad(
                    "timelines",
                    format!(
                        "timelines[{i}].samplerVersion {:?} is not {SAMPLER_PREFIX}<n>",
                        t.sampler_version
                    ),
                );
            }
            digest(&format!("timelines[{i}].timelineKey"), &t.timeline_key)?;
            digest(
                &format!("timelines[{i}].timelineSha256"),
                &t.timeline_sha256,
            )?;
            digest(
                &format!("timelines[{i}].heightFieldDigest"),
                &t.height_field_digest,
            )?;
            if let Some(d) = &t.catalog_digest {
                digest(&format!("timelines[{i}].catalogDigest"), d)?;
            }
            if !shas.insert(&t.timeline_sha256) || !keys.insert(&t.timeline_key) {
                return bad("timelines", format!("timelines[{i}] repeats a timeline"));
            }
        }
        if let Some(x) = &self.execution_package {
            plain_text("executionPackage.contract", &x.contract, 1, 128)?;
            digest("executionPackage.xoscSha256", &x.xosc_sha256)?;
        }
        // map
        let m = &self.map;
        id("map.mapVersionId", &m.map_version_id)?;
        plain_text("map.sourceMapId", &m.source_map_id, 1, 128)?;
        plain_text("map.label", &m.label, 1, 200)?;
        for (field, v) in [
            ("map.xodrSha256", &m.xodr_sha256),
            ("map.coordinateSystemSha256", &m.coordinate_system_sha256),
            ("map.mapClosureDigest", &m.map_closure_digest),
            ("map.pinClosureSha256", &m.pin_closure_sha256),
            ("map.browserClosureSha256", &m.browser_closure_sha256),
            ("map.heightSourceDigest", &m.height_source_digest),
        ] {
            digest(field, v)?;
        }
        safe_integer("map.closure.bytes", m.closure.bytes)?;
        if m.closure.member_count == 0 {
            return bad(
                "map",
                "map.closure.memberCount must be at least 1".to_owned(),
            );
        }
        // catalog
        let c = &self.catalog;
        if let Some(v) = &c.asset_catalog_version_id {
            id("catalog.assetCatalogVersionId", v)?;
        }
        digest("catalog.catalogSha256", &c.catalog_sha256)?;
        digest("catalog.actorClosureDigest", &c.actor_closure_digest)?;
        if c.actor_closure_schema != ACTOR_CLOSURE_SCHEMA {
            return bad(
                "catalog",
                format!(
                    "catalog.actorClosureSchema {:?} is not {ACTOR_CLOSURE_SCHEMA}",
                    c.actor_closure_schema
                ),
            );
        }
        for (i, cid) in c.catalog_ids.iter().enumerate() {
            if !is_token(cid, 128) {
                return bad(
                    "catalog",
                    format!("catalog.catalogIds[{i}] {cid:?} is not a catalog id"),
                );
            }
        }
        if !c.catalog_ids.windows(2).all(|w| w[0] < w[1]) {
            return bad(
                "catalog",
                "catalog.catalogIds must be sorted and unique".to_owned(),
            );
        }
        safe_integer(
            "catalog.referencedActorBlobs.bytes",
            c.referenced_actor_blobs.bytes,
        )?;
        // members
        if !self.members.windows(2).all(|w| w[0].path < w[1].path) {
            return bad(
                "members",
                "members[] must be sorted by path and unique".to_owned(),
            );
        }
        for mem in &self.members {
            let at = |e: PackageError| e.at(mem.path.clone());
            if !is_allowed_name(&mem.path) || mem.path == MANIFEST_PATH || mem.path == RECEIPT_PATH
            {
                return Err(at(PackageError::manifest(
                    "member_path",
                    format!("{:?} cannot be a listed member", mem.path),
                )));
            }
            let Some(role) = Role::of_path(&mem.path) else {
                return Err(at(PackageError::manifest(
                    "member_path",
                    format!(
                        "{:?} is not a member path of v1 (blobs are listed by the closures)",
                        mem.path
                    ),
                )));
            };
            if role != mem.role {
                return Err(at(PackageError::manifest(
                    "member_role",
                    format!(
                        "{:?} has role {}, expected {}",
                        mem.path,
                        mem.role.as_str(),
                        role.as_str()
                    ),
                )));
            }
            digest(&format!("members[{}].sha256", mem.path), &mem.sha256).map_err(at)?;
            safe_integer(&format!("members[{}].size", mem.path), mem.size).map_err(at)?;
            if mem.media_type != role.media_type() {
                return Err(at(PackageError::manifest(
                    "member_media_type",
                    format!(
                        "{:?} has media type {:?}, expected {:?}",
                        mem.path,
                        mem.media_type,
                        role.media_type()
                    ),
                )));
            }
            if mem.schema != self.expected_member_schema(role) {
                return Err(at(PackageError::manifest(
                    "member_schema",
                    format!(
                        "{:?} declares schema {:?}, expected {:?}",
                        mem.path,
                        mem.schema,
                        self.expected_member_schema(role)
                    ),
                )));
            }
        }
        for role in Role::ORDER {
            if role.required() && self.members_with_role(role).next().is_none() {
                return bad(
                    "required_role_missing",
                    format!("the package has no {} member", role.as_str()),
                );
            }
        }
        self.validate_member_digests()?;
        // render
        match (&self.render, self.members_with_role(Role::RenderPin).next()) {
            (Some(r), Some(_)) => {
                if !r.image_digest.strip_prefix("sha256:").is_some_and(is_hex64) {
                    return bad(
                        "render",
                        "render.imageDigest is not sha256:<hex>".to_owned(),
                    );
                }
                plain_text("render.runtimeVersion", &r.runtime_version, 1, 128)?;
                plain_text("render.rendererBuild", &r.renderer_build, 1, 128)?;
                plain_text("render.gpu.model", &r.gpu.model, 1, 128)?;
                plain_text("render.gpu.driverVersion", &r.gpu.driver_version, 1, 64)?;
                if !(r.gpu.vram_gib.is_finite() && r.gpu.vram_gib > 0.0) {
                    return bad("render", "render.gpu.vramGiB must be positive".to_owned());
                }
                plain_text("render.profile.id", &r.profile.id, 1, 128)?;
                plain_text(
                    "render.profile.capturePolicy",
                    &r.profile.capture_policy,
                    1,
                    64,
                )?;
                plain_text("render.profile.textureTier", &r.profile.texture_tier, 1, 64)?;
                digest("render.timelineSha256", &r.timeline_sha256)?;
                if !shas.contains(&r.timeline_sha256) {
                    return bad(
                        "render",
                        "render.timelineSha256 is not a packaged timeline".to_owned(),
                    );
                }
                if let Some(o) = &r.source_outputs {
                    digest(
                        "render.sourceOutputs.frameManifestSha256",
                        &o.frame_manifest_sha256,
                    )?;
                    if let Some(v) = &o.video_sha256 {
                        digest("render.sourceOutputs.videoSha256", v)?;
                    }
                }
            }
            (None, None) => {}
            _ => {
                return bad(
                    "render",
                    "render must be set exactly when render/pin.json is a member".to_owned(),
                )
            }
        }
        // provenance
        if !is_uuid(&self.provenance.installation_id) {
            return bad(
                "provenance",
                "provenance.installationId is not a lowercase UUID".to_owned(),
            );
        }
        if let Some(name) = &self.provenance.author_display_name {
            plain_text("provenance.authorDisplayName", name, 1, 200)?;
        }
        for key in self.extensions.keys() {
            if !is_extension_key(key) {
                return bad(
                    "extensions",
                    format!("extension key {key:?} is not namespaced (<vendor>.<name>)"),
                );
            }
        }
        Ok(())
    }

    /// Member digests that the manifest also records in a typed field.
    fn validate_member_digests(&self) -> Result<()> {
        let sim = &self.simulation;
        let expect: [(&str, Option<&String>); 7] = [
            ("document.json", Some(&self.scenario.content_sha256)),
            ("simulation/trace.json.gz", Some(&sim.trace_gzip_sha256)),
            (
                "simulation/resolution.json.gz",
                Some(&sim.resolution_sha256),
            ),
            ("map/closure.json", Some(&self.map.browser_closure_sha256)),
            (
                "actors/closure.json",
                Some(&self.catalog.actor_closure_digest),
            ),
            ("catalog/entries.json", Some(&self.catalog.catalog_sha256)),
            (
                "simulation/materialized-traffic.json",
                sim.traffic_sha256.as_ref(),
            ),
        ];
        for (path, want) in expect {
            match (self.member(path), want) {
                (Some(m), Some(want)) if &m.sha256 == want => {}
                (None, None) => {}
                (Some(m), Some(want)) => {
                    return Err(PackageError::manifest(
                        "member_digest_field",
                        format!(
                            "{path} has sha256 {} but the manifest records {want}",
                            m.sha256
                        ),
                    )
                    .at(path))
                }
                (Some(_), None) => {
                    return Err(PackageError::manifest(
                        "member_digest_field",
                        format!("{path} is a member but its digest field is null"),
                    )
                    .at(path))
                }
                (None, Some(_)) => {
                    return Err(PackageError::manifest(
                        "member_digest_field",
                        format!("the manifest records a digest for {path}, which is not a member"),
                    )
                    .at(path))
                }
            }
        }
        match (self.member("export/scenario.xosc"), &self.execution_package) {
            (Some(m), Some(x)) if m.sha256 == x.xosc_sha256 => {}
            (None, None) => {}
            _ => {
                return Err(PackageError::manifest(
                    "member_digest_field",
                    "executionPackage must be set exactly when export/scenario.xosc is a member, with its digest",
                )
                .at("export/scenario.xosc"))
            }
        }
        let timeline_members: BTreeSet<&str> = self
            .members_with_role(Role::Timeline)
            .map(|m| {
                let sha = &m.path["timeline/".len()..m.path.len() - ".json".len()];
                if m.sha256 != sha {
                    Err(PackageError::manifest(
                        "member_digest_field",
                        format!(
                            "{} has sha256 {}, not the digest its name carries",
                            m.path, m.sha256
                        ),
                    )
                    .at(m.path.clone()))
                } else {
                    Ok(sha)
                }
            })
            .collect::<Result<_>>()?;
        let listed: BTreeSet<&str> = self
            .timelines
            .iter()
            .map(|t| t.timeline_sha256.as_str())
            .collect();
        if timeline_members != listed {
            return Err(PackageError::manifest(
                "member_digest_field",
                "timelines[] and the timeline/ members must name the same timelines",
            ));
        }
        Ok(())
    }
}

/* ------------------------------------------------------------------ field rules */

fn digest(field: &str, v: &str) -> Result<()> {
    if is_hex64(v) {
        Ok(())
    } else {
        Err(PackageError::manifest(
            "digest",
            format!("{field} {v:?} is not a lowercase hex sha256"),
        ))
    }
}

fn safe_integer(field: &str, v: u64) -> Result<()> {
    if v <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(PackageError::manifest(
            "integer",
            format!("{field} exceeds 2^53 - 1"),
        ))
    }
}

/// Display text: no control characters, bounded length in characters.
pub(crate) fn plain_text(field: &str, v: &str, min: usize, max: usize) -> Result<()> {
    let n = v.chars().count();
    if n < min || n > max || v.chars().any(char::is_control) {
        return Err(PackageError::manifest(
            "text",
            format!("{field} must be {min}..={max} characters of plain text"),
        ));
    }
    Ok(())
}

/// `^[A-Za-z0-9._:-]{1,max}$`-style opaque token.
pub(crate) fn is_token(v: &str, max: usize) -> bool {
    !v.is_empty()
        && v.len() <= max
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// Opaque row ids (`usmap_…`, uuids): `^[A-Za-z0-9_-]{1,128}$`.
fn id(field: &str, v: &str) -> Result<()> {
    if !v.is_empty()
        && v.len() <= 128
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(())
    } else {
        Err(PackageError::manifest(
            "id",
            format!("{field} {v:?} is not an id (^[A-Za-z0-9_-]{{1,128}}$)"),
        ))
    }
}

/// RFC 3339 UTC: `YYYY-MM-DDTHH:MM:SS[.fraction]Z`.
pub(crate) fn timestamp(field: &str, v: &str) -> Result<()> {
    let b = v.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
    let ok = b.len() >= 20
        && digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19)
        && b[b.len() - 1] == b'Z'
        && (b.len() == 20
            || (b[19] == b'.' && b.len() >= 22 && b.len() <= 30 && digits(20..b.len() - 1)));
    if ok {
        Ok(())
    } else {
        Err(PackageError::manifest(
            "timestamp",
            format!("{field} {v:?} is not an RFC 3339 UTC timestamp"),
        ))
    }
}

fn is_uuid(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => matches!(c, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// `<vendor>.<name>`: lowercase dotted namespace, then a name.
fn is_extension_key(v: &str) -> bool {
    let Some((ns, name)) = v.split_once('.') else {
        return false;
    };
    !ns.is_empty()
        && ns
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && is_token(name, 128)
}

/// `simforge.timeline-sampler/<n>` → n.
pub fn sampler_number(v: &str) -> Option<u32> {
    let n = v.strip_prefix(SAMPLER_PREFIX)?;
    if n.is_empty() || n.starts_with('0') || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        for ok in ["2026-09-21T18:02:11Z", "2026-09-21T18:02:11.123Z"] {
            assert!(timestamp("t", ok).is_ok(), "{ok}");
        }
        for bad in [
            "2026-09-21 18:02:11Z",
            "2026-09-21T18:02:11+00:00",
            "2026-09-21T18:02:11.Z",
            "",
        ] {
            assert!(timestamp("t", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn samplers() {
        assert_eq!(sampler_number("simforge.timeline-sampler/3"), Some(3));
        assert_eq!(sampler_number("simforge.timeline-sampler/03"), None);
        assert_eq!(sampler_number("simforge.timeline-sampler/"), None);
    }

    #[test]
    fn extension_keys() {
        assert!(is_extension_key("simcloud.exportJob"));
        assert!(!is_extension_key("exportJob"));
        assert!(!is_extension_key("SimCloud.x"));
    }
}
