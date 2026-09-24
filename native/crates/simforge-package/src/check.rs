//! Content checks shared by the writer and the verifier, so a package the
//! writer emits is exactly a package the verifier accepts. Inputs are member
//! bytes already proven against their manifest digests.
//!
//! The cross-checks (scenario-package.md section 5.1) and the form rules
//! (section 8, as resolved there):
//!
//! - document canonical, its `scenarioVersion` the manifest's;
//! - trace: stored format, identity, `engineGraphDigest = map.xodrSha256`,
//!   `inputHash = simulation.resolvedInputDigest`;
//! - resolution record: contract, `simKey`, `resolvedInputDigest`, `trafficProvider`;
//! - each timeline: canonical, identity equals its `timelines[]` entry, the
//!   key recomputes, it is of this trace and this map's height source;
//!   `catalog.catalogIds` is exactly the ids the timelines bind;
//! - map closure: canonical, counts, `map.xodr` digest, pin-closure digest;
//! - blobs: every blob is named by a closure listing, at the listed size;
//!   none → thin; any → full, which must then hold every non-texture map
//!   member and every actor blob reachable from `catalogIds`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

use serde::Serialize;
use serde_json::Value;
use simforge_core::hash::{canonical_json_of, content_hash_of};
use simforge_core::trace::timeline::{RenderTimeline, SAMPLER_VERSION, TIMELINE_KEY_SCHEMA};
use simforge_core::trace::SimTrace;

use crate::closure::{blob_index, ActorClosure, MapClosure, MapMemberRole, ACTOR_CATALOG_PATH};
use crate::error::{ErrorCode, PackageError, Result};
use crate::manifest::{parse_canonical, BlobCount, Manifest, RESOLUTION_SCHEMA};
use crate::names::blob_path;
use crate::receipt::Form;

pub(crate) struct ContentInput<'a> {
    pub manifest: &'a Manifest,
    /// Listed members' bytes, keyed by path.
    pub members: &'a BTreeMap<String, Vec<u8>>,
    /// Embedded blobs: digest → size (content already proven to hash to the digest).
    pub blobs: &'a BTreeMap<String, u64>,
    /// The embedded `catalog-models.json` blob, when there is one.
    pub catalog_models: Option<&'a [u8]>,
    pub max_member_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceReport {
    /// `traceVersion` of the stored bytes.
    pub stored_format: u32,
    /// Read through the in-memory upgrader chain.
    pub upgraded: bool,
    pub trace_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineReport {
    pub timeline_sha256: String,
    pub timeline_key: String,
    pub sampler_version: String,
    /// False when the reader's sampler is newer: the timeline is kept as
    /// evidence and a current one is derived from the trace.
    pub current_sampler: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentReport {
    pub form: Form,
    pub trace: TraceReport,
    pub timelines: Vec<TimelineReport>,
    pub embedded_blobs: BlobCount,
    pub map_members: u64,
    pub texture_members: u64,
    pub embedded_texture_members: u64,
    /// Checks this form cannot perform, stated rather than skipped silently.
    pub not_verifiable: Vec<String>,
}

fn member<'a>(input: &'a ContentInput<'_>, path: &str) -> &'a [u8] {
    input
        .members
        .get(path)
        .map(Vec::as_slice)
        .expect("listed members were read before the content checks")
}

fn gunzip(bytes: &[u8], path: &str, max: u64) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut dec = flate2::read::GzDecoder::new(bytes).take(max + 1);
    dec.read_to_end(&mut out)
        .map_err(|e| PackageError::member("gzip", format!("{path} is not gzip: {e}")).at(path))?;
    if out.len() as u64 > max {
        return Err(PackageError::new(
            ErrorCode::LimitExceeded,
            "member_size",
            format!("{path} inflates past {max} bytes"),
        )
        .at(path));
    }
    Ok(out)
}

fn canonical(bytes: &[u8], path: &str) -> Result<Value> {
    parse_canonical(bytes, path).map_err(|e| match e {
        Some(_) => {
            PackageError::member("not_canonical", format!("{path} is not canonical JSON")).at(path)
        }
        None => PackageError::member("not_json", format!("{path} is not JSON")).at(path),
    })
}

fn mismatch(rule: &'static str, path: &str, message: String) -> PackageError {
    PackageError::identity(rule, message).at(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyPreimage<'a> {
    schema: &'a str,
    trace_sha256: &'a str,
    height_field_digest: &'a str,
    catalog_digest: Option<&'a str>,
    sampler_version: &'a str,
}

pub(crate) fn check_contents(input: &ContentInput<'_>) -> Result<ContentReport> {
    let m = input.manifest;
    let sim = &m.simulation;

    // document
    let doc = canonical(member(input, "document.json"), "document.json")?;
    if doc.get("scenarioVersion").and_then(Value::as_u64)
        != Some(u64::from(m.scenario.scenario_version))
    {
        return Err(mismatch(
            "document_version",
            "document.json",
            format!(
                "document.json scenarioVersion is not the manifest's {}",
                m.scenario.scenario_version
            ),
        ));
    }

    // trace
    let path = "simulation/trace.json.gz";
    let json = gunzip(member(input, path), path, input.max_member_bytes)?;
    let mut trace = SimTrace::from_json_slice(&json)
        .map_err(|e| PackageError::member("trace_invalid", format!("{path}: {e}")).at(path))?;
    let stored_format = trace
        .upgrade
        .as_ref()
        .map_or(trace.header.trace_version, |u| u.source_trace_version);
    if stored_format != sim.trace_format {
        return Err(mismatch(
            "trace_format",
            path,
            format!(
                "the trace is format {stored_format}, the manifest says {}",
                sim.trace_format
            ),
        ));
    }
    trace
        .bind_recorded_identity(&sim.trace_sha256)
        .map_err(|e| mismatch("trace_sha256", path, format!("simulation.traceSha256: {e}")))?;
    if trace.header.engine_graph_digest != m.map.xodr_sha256 {
        return Err(mismatch(
            "trace_map",
            path,
            format!(
                "the trace ran on OpenDRIVE {}, the package map is {}",
                trace.header.engine_graph_digest, m.map.xodr_sha256
            ),
        ));
    }
    if trace.header.input_hash != sim.resolved_input_digest {
        return Err(mismatch(
            "trace_input",
            path,
            format!(
                "the trace inputHash {} is not simulation.resolvedInputDigest {}",
                trace.header.input_hash, sim.resolved_input_digest
            ),
        ));
    }
    let trace_report = TraceReport {
        stored_format,
        upgraded: trace.upgrade.is_some(),
        trace_sha256: sim.trace_sha256.clone(),
    };
    drop(trace);
    drop(json);

    // resolution record
    let path = "simulation/resolution.json.gz";
    let res: Value =
        serde_json::from_slice(&gunzip(member(input, path), path, input.max_member_bytes)?)
            .map_err(|e| {
                PackageError::member("resolution_invalid", format!("{path}: {e}")).at(path)
            })?;
    let field = |k: &str| res.get(k).and_then(Value::as_str);
    if field("contract") != Some(RESOLUTION_SCHEMA) {
        return Err(PackageError::member(
            "resolution_invalid",
            format!("{path} is not a {RESOLUTION_SCHEMA} record"),
        )
        .at(path));
    }
    for (k, want) in [
        ("simKey", sim.sim_key.as_str()),
        ("resolvedInputDigest", sim.resolved_input_digest.as_str()),
        ("trafficProvider", sim.traffic_provider.as_str()),
    ] {
        if field(k) != Some(want) {
            return Err(mismatch(
                "resolution_mismatch",
                path,
                format!("the resolution record's {k} is not the manifest's {want}"),
            ));
        }
    }

    // traffic
    if let Some(bytes) = input.members.get("simulation/materialized-traffic.json") {
        serde_json::from_slice::<Value>(bytes).map_err(|e| {
            PackageError::member("traffic_invalid", format!("materialized traffic: {e}"))
                .at("simulation/materialized-traffic.json")
        })?;
    }

    // timelines
    let current_sampler = crate::manifest::sampler_number(SAMPLER_VERSION).expect("well-formed");
    let mut bound_ids = BTreeSet::new();
    let mut timelines = Vec::new();
    for t in &m.timelines {
        let path = format!("timeline/{}.json", t.timeline_sha256);
        let bytes = member(input, &path);
        canonical(bytes, &path)?;
        let tl = RenderTimeline::inspect_json_slice(bytes).map_err(|e| {
            PackageError::member("timeline_invalid", format!("{path}: {e}")).at(&path)
        })?;
        let id = &tl.identity;
        if tl.version != t.version
            || id.sampler_version != t.sampler_version
            || id.timeline_key != t.timeline_key
            || id.height_field_digest != t.height_field_digest
            || id.catalog_digest != t.catalog_digest
        {
            return Err(mismatch(
                "timeline_ref",
                &path,
                format!("{path}'s identity is not its timelines[] entry"),
            ));
        }
        // The document digest (`sha256(canonicalJson(timeline))` of the typed
        // timeline) must be the member digest: no field the reader drops.
        let typed = tl
            .sha256()
            .map_err(|e| PackageError::member("timeline_invalid", e.to_string()).at(&path))?;
        if typed != t.timeline_sha256 {
            return Err(mismatch(
                "timeline_sha256",
                &path,
                format!("{path} re-encodes to {typed}: it carries fields a timeline does not have"),
            ));
        }
        let key = content_hash_of(&KeyPreimage {
            schema: TIMELINE_KEY_SCHEMA,
            trace_sha256: &id.trace_sha256,
            height_field_digest: &id.height_field_digest,
            catalog_digest: id.catalog_digest.as_deref(),
            sampler_version: &id.sampler_version,
        })
        .map_err(|e| PackageError::member("timeline_invalid", e.to_string()).at(&path))?;
        if key != id.timeline_key {
            return Err(mismatch(
                "timeline_key",
                &path,
                format!("{path}: timelineKey does not recompute from its identity (got {key})"),
            ));
        }
        if id.trace_sha256 != sim.trace_sha256 || tl.trace.trace_sha256 != sim.trace_sha256 {
            return Err(mismatch(
                "timeline_trace",
                &path,
                format!(
                    "{path} was sampled from trace {}, not {}",
                    id.trace_sha256, sim.trace_sha256
                ),
            ));
        }
        if id.height_field_digest != m.map.height_source_digest {
            return Err(mismatch(
                "timeline_height",
                &path,
                format!("{path}'s height field is not map.heightSourceDigest"),
            ));
        }
        bound_ids.extend(tl.actors.iter().map(|a| a.catalog_id.clone()));
        bound_ids.extend(tl.props.iter().map(|p| p.catalog_id.clone()));
        let n = crate::manifest::sampler_number(&t.sampler_version).expect("validated");
        timelines.push(TimelineReport {
            timeline_sha256: t.timeline_sha256.clone(),
            timeline_key: t.timeline_key.clone(),
            sampler_version: t.sampler_version.clone(),
            current_sampler: n == current_sampler,
        });
    }
    let bound: Vec<String> = bound_ids.into_iter().collect();
    if bound != m.catalog.catalog_ids {
        return Err(mismatch(
            "catalog_ids",
            "catalog/entries.json",
            format!(
                "catalog.catalogIds {:?} is not the ids the timelines bind {:?}",
                m.catalog.catalog_ids, bound
            ),
        ));
    }

    // closures and catalog
    let path = "map/closure.json";
    let map_bytes = member(input, path);
    let map = MapClosure::parse(map_bytes)?;
    canonical(map_bytes, path).map_err(|_| {
        PackageError::closure("not_canonical", "map/closure.json is not canonical JSON").at(path)
    })?;
    if map.members.len() as u64 != m.map.closure.member_count
        || map.total_bytes() != m.map.closure.bytes
    {
        return Err(mismatch(
            "map_closure_count",
            path,
            format!(
                "map/closure.json lists {} members / {} bytes, the manifest says {} / {}",
                map.members.len(),
                map.total_bytes(),
                m.map.closure.member_count,
                m.map.closure.bytes
            ),
        ));
    }
    match map.member("map.xodr") {
        Some(x) if x.sha256 == m.map.xodr_sha256 => {}
        _ => {
            return Err(mismatch(
                "map_xodr",
                path,
                "map/closure.json's map.xodr is not map.xodrSha256".to_owned(),
            ))
        }
    }
    let pin = map.pin_closure_sha256();
    if pin != m.map.pin_closure_sha256 {
        return Err(mismatch(
            "map_pin_closure",
            path,
            format!("the simulation members digest to {pin}, not map.pinClosureSha256"),
        ));
    }
    let actors = ActorClosure::parse(member(input, "actors/closure.json"))
        .map_err(|e| e.at("actors/closure.json"))?;
    canonical(
        member(input, "catalog/entries.json"),
        "catalog/entries.json",
    )?;
    if let Some(r) = &m.render {
        let want =
            canonical_json_of(r).map_err(|e| PackageError::member("render_pin", e.to_string()))?;
        if member(input, "render/pin.json") != want.as_bytes() {
            return Err(mismatch(
                "render_pin",
                "render/pin.json",
                "render/pin.json is not canonicalJson(manifest.render)".to_owned(),
            ));
        }
    }

    // blobs and form
    let index = blob_index(&map, &actors)?;
    let mut embedded = BlobCount { count: 0, bytes: 0 };
    for (sha, size) in input.blobs {
        match index.get(sha) {
            None => {
                return Err(PackageError::container(
                    "blob_unreferenced",
                    format!("blob {sha} is named by neither closure listing"),
                )
                .at(blob_path(sha)))
            }
            Some(listed) if listed != size => {
                return Err(PackageError::digest(
                    "blob_size",
                    format!("blob {sha} is {size} bytes; the closures list {listed}"),
                )
                .at(blob_path(sha)))
            }
            Some(_) => {
                embedded.count += 1;
                embedded.bytes += size;
            }
        }
    }
    let textures = map
        .members
        .iter()
        .filter(|x| x.role == MapMemberRole::Texture);
    let texture_members = textures.clone().count() as u64;
    let embedded_texture_members = textures
        .filter(|x| input.blobs.contains_key(&x.sha256))
        .count() as u64;
    let mut not_verifiable = Vec::new();
    let form = if input.blobs.is_empty() {
        not_verifiable.push(
            "catalog.referencedActorBlobs: catalog-models.json is not embedded in a thin package"
                .to_owned(),
        );
        Form::Thin
    } else {
        let incomplete = |path: &str, sha: &str| {
            PackageError::new(
                ErrorCode::FormIncomplete,
                "blob_missing",
                format!("a full package must embed {path} ({sha})"),
            )
            .at(path)
        };
        for x in map
            .members
            .iter()
            .filter(|x| x.role != MapMemberRole::Texture)
        {
            if !input.blobs.contains_key(&x.sha256) {
                return Err(incomplete(&format!("map/{}", x.relative_path), &x.sha256));
            }
        }
        let catalog = &actors.members[ACTOR_CATALOG_PATH];
        let Some(models) = input
            .catalog_models
            .filter(|_| input.blobs.contains_key(&catalog.sha256))
        else {
            return Err(incomplete(
                &format!("actors/{ACTOR_CATALOG_PATH}"),
                &catalog.sha256,
            ));
        };
        let reachable = actors.reachable(models, &m.catalog.catalog_ids)?;
        let mut distinct = BTreeMap::new();
        for p in &reachable {
            let a = &actors.members[p];
            if !input.blobs.contains_key(&a.sha256) {
                return Err(incomplete(&format!("actors/{p}"), &a.sha256));
            }
            distinct.insert(a.sha256.clone(), a.bytes);
        }
        let referenced = BlobCount {
            count: distinct.len() as u64,
            bytes: distinct.values().sum(),
        };
        if referenced != m.catalog.referenced_actor_blobs {
            return Err(mismatch(
                "referenced_actor_blobs",
                "actors/closure.json",
                format!(
                    "catalogIds reach {} blobs / {} bytes, the manifest says {} / {}",
                    referenced.count,
                    referenced.bytes,
                    m.catalog.referenced_actor_blobs.count,
                    m.catalog.referenced_actor_blobs.bytes
                ),
            ));
        }
        Form::Full
    };
    Ok(ContentReport {
        form,
        trace: trace_report,
        timelines,
        embedded_blobs: embedded,
        map_members: map.members.len() as u64,
        texture_members,
        embedded_texture_members,
        not_verifiable,
    })
}
