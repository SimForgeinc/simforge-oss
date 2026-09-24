//! Shared test inputs: real archive-corpus artifacts (a stored trace, its
//! timeline, a stored document), the committed Richmond Field Station map,
//! and small synthetic closures; plus a raw ZIP builder, independent of the
//! production writer, for hostile containers.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use flate2::write::{DeflateEncoder, GzEncoder};
use flate2::Compression;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use simforge_core::hash::canonical_json;
use simforge_package::closure::is_simulation_member;
use simforge_package::zip::{Method, ZipWriter};
use simforge_package::{PackageBuilder, ReceiptInput, Role};

pub const CLI: &str = "0.2.0";

pub fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `fixtures/` of the SDK tree, wherever the crate lives (it is moved by the
/// repository split, so the path is found, not hard-coded).
pub fn fixtures_root() -> PathBuf {
    let mut dir = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    loop {
        let candidate = dir.join("fixtures");
        if candidate.join("archive-corpus/corpus.json").is_file() {
            return candidate;
        }
        assert!(
            dir.pop(),
            "no fixtures/archive-corpus above {}",
            env!("CARGO_MANIFEST_DIR")
        );
    }
}

pub fn read(rel: &str) -> Vec<u8> {
    let path = fixtures_root().join(rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

pub fn canonical_bytes(value: &Value) -> Vec<u8> {
    canonical_json(value).unwrap().into_bytes()
}

pub fn canonicalize(bytes: &[u8]) -> Vec<u8> {
    canonical_bytes(&serde_json::from_slice(bytes).unwrap())
}

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::new(9));
    enc.write_all(bytes).unwrap();
    enc.finish().unwrap()
}

pub fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .unwrap();
    out
}

/* ---------------------------------------------------------------- map closure */

/// `role()` of `closure.ts`.
pub fn map_role(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    if path == "3d/manifest.json" || path.ends_with("/manifest.json") {
        "manifest"
    } else if path.starts_with("3d/env/") {
        "environment"
    } else if matches!(ext, "gltf" | "glb" | "bin") {
        "geometry"
    } else if matches!(ext, "webp" | "png" | "jpg" | "jpeg" | "ktx2") {
        "texture"
    } else if matches!(ext, "js" | "wasm") {
        "runtime"
    } else {
        "metadata"
    }
}

fn media_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "json" => "application/json",
        "gz" => "application/gzip",
        "xodr" => "application/xml",
        "ktx2" => "image/ktx2",
        _ => "application/octet-stream",
    }
}

/// A `uniscenario.browser-asset-set/v1` listing, canonical.
pub fn map_closure(files: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let members: Vec<Value> = files
        .iter()
        .map(|(path, bytes)| {
            let collider = path.split('/').any(|s| {
                s.starts_with("collider")
                    || s.starts_with("static-collider.")
                    || s == "static-collider"
            });
            json!({
                "relativePath": path,
                "sha256": sha(bytes),
                "byteLength": bytes.len(),
                "mediaType": media_type(path),
                "role": map_role(path),
                "required": !collider,
            })
        })
        .collect();
    canonical_bytes(
        &json!({ "contractVersion": "uniscenario.browser-asset-set/v1", "members": members }),
    )
}

pub fn pin_closure(files: &BTreeMap<String, Vec<u8>>) -> String {
    let mut text = String::new();
    for (path, bytes) in files {
        if is_simulation_member(path) {
            text.push_str(&format!("{path} {}\n", sha(bytes)));
        }
    }
    sha(text.as_bytes())
}

/// Every file of the committed Richmond Field Station closure (`map.xodr` inflated).
pub fn richmond_files() -> BTreeMap<String, Vec<u8>> {
    let root = fixtures_root().join("golden-traces/maps/richmond-field-station");
    let mut out = BTreeMap::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = std::fs::read(&path).unwrap();
            if rel == "map.xodr.gz" {
                out.insert("map.xodr".to_owned(), gunzip(&bytes));
            } else {
                out.insert(rel, bytes);
            }
        }
    }
    out
}

/* ---------------------------------------------------------------- actor closure */

pub struct Actors {
    pub closure: Vec<u8>,
    pub blobs: BTreeMap<String, Vec<u8>>, // path -> bytes
}

/// A synthetic `simforge.actor-assets-closure/v1`: a catalog table, the box
/// model the fixture's timeline binds, and a sedan nothing binds.
pub fn synthetic_actors() -> Actors {
    let catalog = canonical_bytes(&json!({
        "version": 1,
        "hazard.cardboard_box": {
            "model": { "glbPath": "models/hazard.cardboard_box/model.glb" },
            "tintable": false,
            "scaleToDims": true
        },
        "vehicle.sedan": {
            "model": { "glbPath": "models/vehicle.sedan/model.glb" },
            "tintable": true,
            "scaleToDims": true
        }
    }));
    let mut blobs = BTreeMap::new();
    blobs.insert("catalog-models.json".to_owned(), catalog);
    blobs.insert(
        "models/hazard.cardboard_box/model.glb".to_owned(),
        b"glTF\x02\x00\x00\x00synthetic fixture model: hazard.cardboard_box".to_vec(),
    );
    blobs.insert(
        "models/vehicle.sedan/model.glb".to_owned(),
        b"glTF\x02\x00\x00\x00synthetic fixture model: vehicle.sedan".to_vec(),
    );
    let members: serde_json::Map<String, Value> = blobs
        .iter()
        .map(|(p, b)| (p.clone(), json!({ "bytes": b.len(), "sha256": sha(b) })))
        .collect();
    let closure = canonical_bytes(
        &json!({ "schema": "simforge.actor-assets-closure/v1", "members": members }),
    );
    Actors { closure, blobs }
}

/* ---------------------------------------------------------------- package inputs */

/// One scenario revision's worth of package inputs.
#[derive(Clone)]
pub struct Case {
    pub title: String,
    pub trace_gz: Vec<u8>,
    pub trace_sha256: String,
    pub trace_format: u32,
    pub input_hash: String,
    pub engine_sem_ver: String,
    pub release: String,
    pub timeline: Vec<u8>,
    pub document: Vec<u8>,
    pub map_files: BTreeMap<String, Vec<u8>>,
    pub xosc: Option<Vec<u8>>,
    pub actors_closure: Vec<u8>,
    pub actor_blobs: BTreeMap<String, Vec<u8>>,
}

pub struct Built {
    pub draft: Value,
    pub members: BTreeMap<String, Vec<u8>>,
}

impl Case {
    /// An archive-corpus trace entry with an archived timeline, on Richmond.
    pub fn from_corpus(
        trace_id: &str,
        document_id: &str,
        map_files: BTreeMap<String, Vec<u8>>,
    ) -> Case {
        let corpus: Value = serde_json::from_slice(&read("archive-corpus/corpus.json")).unwrap();
        let entries = corpus["entries"].as_array().unwrap();
        let entry = entries.iter().find(|e| e["id"] == trace_id).unwrap();
        let doc_entry = entries.iter().find(|e| e["id"] == document_id).unwrap();
        let trace_gz = read(&format!(
            "archive-corpus/{}",
            entry["path"].as_str().unwrap()
        ));
        let timeline_raw = read(&format!(
            "archive-corpus/{}",
            entry["timeline"]["path"].as_str().unwrap()
        ));
        let header = serde_json::from_slice::<Value>(&gunzip(&trace_gz)).unwrap()["header"].clone();
        let actors = synthetic_actors();
        Case {
            title: format!("Archive corpus {trace_id}"),
            trace_sha256: entry["expect"]["identity"].as_str().unwrap().to_owned(),
            trace_format: header["traceVersion"].as_u64().unwrap() as u32,
            input_hash: header["inputHash"].as_str().unwrap().to_owned(),
            engine_sem_ver: header["engineVersion"].as_str().unwrap().to_owned(),
            release: entry["release"]
                .as_str()
                .unwrap()
                .trim_start_matches('v')
                .to_owned(),
            trace_gz,
            timeline: canonicalize(&timeline_raw),
            document: canonicalize(&read(&format!(
                "archive-corpus/{}",
                doc_entry["path"].as_str().unwrap()
            ))),
            map_files,
            xosc: None,
            actors_closure: actors.closure,
            actor_blobs: actors.blobs,
        }
    }

    /// The committed fixture scenario: `rc73-engine090-richmond-small` with a
    /// three-member map closure (the real OpenDRIVE, the 3D manifest, one
    /// texture that full packages leave out).
    pub fn fixture() -> Case {
        let rich = richmond_files();
        let mut files = BTreeMap::new();
        files.insert(
            "3d/manifest.json".to_owned(),
            rich["3d/manifest.json"].clone(),
        );
        files.insert("map.xodr".to_owned(), rich["map.xodr"].clone());
        let ktx = b"\xabKTX 20\xbb\r\n\x1a\nsynthetic fixture texture".to_vec();
        files.insert(format!("3d/variants/objects/{}.ktx2", sha(&ktx)), ktx);
        let mut case = Case::from_corpus(
            "rc73-engine090-richmond-small",
            "rc73-doc-child-reveal",
            files,
        );
        case.title = "Fixture: cardboard box on the Richmond Field Station loop".to_owned();
        case.xosc = Some(
            b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<OpenSCENARIO><FileHeader description=\"fixture\"/></OpenSCENARIO>\n"
                .to_vec(),
        );
        case
    }

    pub fn timeline_value(&self) -> Value {
        serde_json::from_slice(&self.timeline).unwrap()
    }

    pub fn catalog_ids(&self) -> Vec<String> {
        let tl = self.timeline_value();
        let mut ids: Vec<String> = tl["actors"]
            .as_array()
            .unwrap()
            .iter()
            .chain(tl["props"].as_array().unwrap())
            .map(|a| a["catalogId"].as_str().unwrap().to_owned())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    pub fn resolution_gz(&self) -> Vec<u8> {
        gzip(&canonical_bytes(&json!({
            "contract": "simforge.sim-resolution/v1",
            "simKey": sha(format!("fixture sim key {}", self.trace_sha256).as_bytes()),
            "resolvedInputDigest": self.input_hash,
            "trafficProvider": "native",
            "siteId": "fixture"
        })))
    }

    /// Reachable actor blobs of the synthetic catalog for this case's ids.
    pub fn referenced_actor_blobs(&self) -> (u64, u64) {
        let mut paths = vec!["catalog-models.json".to_owned()];
        for id in self.catalog_ids() {
            let p = format!("models/{id}/model.glb");
            if self.actor_blobs.contains_key(&p) {
                paths.push(p);
            }
        }
        (
            paths.len() as u64,
            paths.iter().map(|p| self.actor_blobs[p].len() as u64).sum(),
        )
    }

    pub fn build(&self) -> Built {
        let tl = self.timeline_value();
        let id = &tl["identity"];
        let timeline_sha = sha(&self.timeline);
        let map_closure_bytes = map_closure(&self.map_files);
        let catalog_entries = canonical_bytes(&json!(self
            .catalog_ids()
            .iter()
            .map(|id| json!({ "id": id }))
            .collect::<Vec<_>>()));
        let resolution = self.resolution_gz();
        let (count, bytes) = self.referenced_actor_blobs();
        let draft = json!({
            "schema": "simforge.scenario-package/v1",
            "producer": { "app": "simforge-fixtures", "appVersion": "0.2.0", "minCli": "0.2.0" },
            "scenario": {
                "title": self.title,
                "documentSchema": "simforge.scenario.v2",
                "scenarioVersion": 2,
                "contentSha256": sha(&self.document),
                "simContentSha256": sha(format!("fixture sim content {}", self.trace_sha256).as_bytes())
            },
            "engine": {
                "engineSemVer": self.engine_sem_ver,
                "solverVersion": self.engine_sem_ver,
                "pipelineRevision": 2,
                "build": { "engineVersion": self.engine_sem_ver },
                "release": self.release
            },
            "simulation": {
                "simKey": sha(format!("fixture sim key {}", self.trace_sha256).as_bytes()),
                "traceFormat": self.trace_format,
                "traceSchema": format!("simforge.trace/v{}", self.trace_format),
                "traceSha256": self.trace_sha256,
                "traceGzipSha256": sha(&self.trace_gz),
                "authoredTraceSha256": self.trace_sha256,
                "resolvedInputDigest": self.input_hash,
                "resolutionSha256": sha(&resolution),
                "trafficProvider": "native",
                "trafficStepKey": null,
                "trafficSha256": null,
                "sumo": null,
                "groundDigest": null,
                "producerKind": "runner",
                "simulatedAt": "2026-08-09T00:00:00Z"
            },
            "timelines": [{
                "version": tl["version"],
                "samplerVersion": id["samplerVersion"],
                "timelineKey": id["timelineKey"],
                "timelineSha256": timeline_sha,
                "heightFieldDigest": id["heightFieldDigest"],
                "catalogDigest": id["catalogDigest"]
            }],
            "executionPackage": self.xosc.as_ref().map(|x| json!({
                "contract": "uniscenario.execution-package/v1",
                "xoscSha256": sha(x)
            })),
            "map": {
                "mapVersionId": "usmap_fixture_richmond",
                "sourceMapId": "richmond-field-station",
                "label": "Richmond Field Station (fixture)",
                "xodrSha256": sha(&self.map_files["map.xodr"]),
                "coordinateSystemSha256": sha(b"fixture coordinate system"),
                "mapClosureDigest": "5b611c7574bd90ac50419b42f8e47c467bcaf2b106b18b87f16ceb7ef6976155",
                "pinClosureSha256": pin_closure(&self.map_files),
                "browserClosureSha256": sha(&map_closure_bytes),
                "heightSourceDigest": id["heightFieldDigest"],
                "groundDigest": null,
                "closure": {
                    "memberCount": self.map_files.len(),
                    "bytes": self.map_files.values().map(Vec::len).sum::<usize>()
                }
            },
            "catalog": {
                "assetCatalogVersionId": "uscat_fixture",
                "catalogSha256": sha(&catalog_entries),
                "actorClosureDigest": sha(&self.actors_closure),
                "actorClosureSchema": "simforge.actor-assets-closure/v1",
                "catalogIds": self.catalog_ids(),
                "referencedActorBlobs": { "count": count, "bytes": bytes }
            },
            "render": null,
            "provenance": {
                "installationKind": "cli",
                "installationId": "00000000-0000-4000-8000-000000000001",
                "authorDisplayName": null
            },
            "extensions": {}
        });
        let mut members = BTreeMap::new();
        members.insert("document.json".to_owned(), self.document.clone());
        members.insert("simulation/trace.json.gz".to_owned(), self.trace_gz.clone());
        members.insert("simulation/resolution.json.gz".to_owned(), resolution);
        members.insert(
            format!("timeline/{timeline_sha}.json"),
            self.timeline.clone(),
        );
        members.insert("map/closure.json".to_owned(), map_closure_bytes);
        members.insert(
            "actors/closure.json".to_owned(),
            self.actors_closure.clone(),
        );
        members.insert("catalog/entries.json".to_owned(), catalog_entries);
        if let Some(x) = &self.xosc {
            members.insert("export/scenario.xosc".to_owned(), x.clone());
        }
        Built { draft, members }
    }

    pub fn builder(&self, full: bool) -> PackageBuilder {
        let built = self.build();
        let mut b = PackageBuilder::new(built.draft).unwrap();
        for (path, bytes) in built.members {
            b.member(&path, bytes).unwrap();
        }
        if full {
            for (path, bytes) in &self.map_files {
                if map_role(path) != "texture" {
                    b.blob(bytes.clone());
                }
            }
            let mut reach = vec!["catalog-models.json".to_owned()];
            reach.extend(
                self.catalog_ids()
                    .iter()
                    .map(|id| format!("models/{id}/model.glb")),
            );
            for p in reach {
                if let Some(bytes) = self.actor_blobs.get(&p) {
                    b.blob(bytes.clone());
                }
            }
        }
        b.receipt(ReceiptInput {
            exported_at: "2026-09-24T00:00:00Z".to_owned(),
            exporter_release: "0.2.0-fixture".to_owned(),
            texture_tier: full.then(|| "256-uastc".to_owned()),
        });
        b
    }
}

/* ---------------------------------------------------------------- assembly without checks */

/// Container entries in writer order, from any manifest and members,
/// skipping every content check (for hostile fixtures).
pub fn assemble(
    manifest: &[u8],
    receipt: Option<&[u8]>,
    members: &[(String, Vec<u8>)],
    blobs: &[(String, Vec<u8>)],
) -> Vec<u8> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()), false).unwrap();
    w.add(
        "manifest.json",
        Method::Deflate,
        manifest.len() as u64,
        &mut &manifest[..],
    )
    .unwrap();
    if let Some(r) = receipt {
        w.add("receipt.json", Method::Deflate, r.len() as u64, &mut &r[..])
            .unwrap();
    }
    for (path, bytes) in members {
        let method = if Role::of_path(path).is_some_and(Role::stored) {
            Method::Store
        } else {
            Method::Deflate
        };
        w.add(path, method, bytes.len() as u64, &mut &bytes[..])
            .unwrap();
    }
    for (name, bytes) in blobs {
        w.add(name, Method::Deflate, bytes.len() as u64, &mut &bytes[..])
            .unwrap();
    }
    w.finish().unwrap().0.into_inner()
}

/// Entries of a container in physical order: (name, inflated bytes).
pub fn entries_of(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut r =
        simforge_package::zip::ZipReader::open(Cursor::new(bytes), &Default::default()).unwrap();
    let names: Vec<String> = r.entries().iter().map(|e| e.name.clone()).collect();
    names
        .into_iter()
        .map(|n| {
            let (b, _) = r.read(&n, u64::MAX).unwrap();
            (n, b)
        })
        .collect()
}

/* ---------------------------------------------------------------- raw ZIP */

/// One entry of a hand-built ZIP. Defaults reproduce the strict writer.
#[derive(Clone)]
pub struct RawEntry {
    pub name: Vec<u8>,
    pub data: Vec<u8>,
    pub method: u16,
    /// Compressed bytes; `None` derives them from `data` and `method`.
    pub compressed: Option<Vec<u8>>,
    pub flags: u16,
    pub time: u16,
    pub date: u16,
    pub crc_local: Option<u32>,
    pub crc_central: Option<u32>,
    pub size_override: Option<u32>,
    pub external: u32,
    pub made_by: u16,
    pub version: u16,
    pub local_extra: Vec<u8>,
    pub central_extra: Vec<u8>,
    /// Central-directory offset override (index of another entry to point at).
    pub offset_of: Option<usize>,
}

impl RawEntry {
    pub fn new(name: &str, data: &[u8]) -> Self {
        let method = if Role::of_path(name).is_some_and(Role::stored) {
            0
        } else {
            8
        };
        Self {
            name: name.as_bytes().to_vec(),
            data: data.to_vec(),
            method,
            compressed: None,
            flags: 0x0800,
            time: 0,
            date: 0x0021,
            crc_local: None,
            crc_central: None,
            size_override: None,
            external: 0o100644 << 16,
            made_by: 0x0314,
            version: 20,
            local_extra: Vec::new(),
            central_extra: Vec::new(),
            offset_of: None,
        }
    }
}

#[derive(Default, Clone)]
pub struct RawZip {
    pub entries: Vec<RawEntry>,
    pub prefix: Vec<u8>,
    pub trailing: Vec<u8>,
    pub comment: Vec<u8>,
    pub disk: u16,
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::new(6));
    enc.write_all(data).unwrap();
    enc.finish().unwrap()
}

impl RawZip {
    pub fn from_entries(entries: &[(String, Vec<u8>)]) -> Self {
        Self {
            entries: entries.iter().map(|(n, d)| RawEntry::new(n, d)).collect(),
            ..Default::default()
        }
    }

    pub fn build(&self) -> Vec<u8> {
        let mut out = self.prefix.clone();
        let mut offsets = Vec::new();
        let mut central = Vec::new();
        for e in &self.entries {
            let compressed = e.compressed.clone().unwrap_or_else(|| match e.method {
                8 => deflate(&e.data),
                _ => e.data.clone(),
            });
            let crc = crc32fast::hash(&e.data);
            let size = e.size_override.unwrap_or(e.data.len() as u32);
            offsets.push(out.len() as u32);
            let header_at = out.len() as u32;
            let mut h = Vec::new();
            h.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            h.extend_from_slice(&e.version.to_le_bytes());
            h.extend_from_slice(&e.flags.to_le_bytes());
            h.extend_from_slice(&e.method.to_le_bytes());
            h.extend_from_slice(&e.time.to_le_bytes());
            h.extend_from_slice(&e.date.to_le_bytes());
            h.extend_from_slice(&e.crc_local.unwrap_or(crc).to_le_bytes());
            h.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
            h.extend_from_slice(&size.to_le_bytes());
            h.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            h.extend_from_slice(&(e.local_extra.len() as u16).to_le_bytes());
            h.extend_from_slice(&e.name);
            h.extend_from_slice(&e.local_extra);
            out.extend_from_slice(&h);
            out.extend_from_slice(&compressed);
            central.push((e.clone(), crc, compressed.len() as u32, size, header_at));
        }
        let cd_offset = out.len() as u32;
        for (e, crc, csize, size, at) in &central {
            let offset = e.offset_of.map_or(*at, |i| offsets[i]);
            let mut c = Vec::new();
            c.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            c.extend_from_slice(&e.made_by.to_le_bytes());
            c.extend_from_slice(&e.version.to_le_bytes());
            c.extend_from_slice(&e.flags.to_le_bytes());
            c.extend_from_slice(&e.method.to_le_bytes());
            c.extend_from_slice(&e.time.to_le_bytes());
            c.extend_from_slice(&e.date.to_le_bytes());
            c.extend_from_slice(&e.crc_central.unwrap_or(*crc).to_le_bytes());
            c.extend_from_slice(&csize.to_le_bytes());
            c.extend_from_slice(&size.to_le_bytes());
            c.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            c.extend_from_slice(&(e.central_extra.len() as u16).to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&e.external.to_le_bytes());
            c.extend_from_slice(&offset.to_le_bytes());
            c.extend_from_slice(&e.name);
            c.extend_from_slice(&e.central_extra);
            out.extend_from_slice(&c);
        }
        let cd_size = out.len() as u32 - cd_offset;
        let n = self.entries.len() as u16;
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&self.disk.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&(self.comment.len() as u16).to_le_bytes());
        out.extend_from_slice(&self.comment);
        out.extend_from_slice(&self.trailing);
        out
    }
}
