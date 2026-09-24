//! The committed fixture corpus, `fixtures/scenario-package/`: valid packages
//! and one hostile package per refusal rule, each with its expected outcome
//! in `expectations.json`.
//!
//! The fixtures are generated here, deterministically, from the archive
//! corpus and the committed Richmond map. This test regenerates them in
//! memory and requires the committed bytes to be identical (so the writer is
//! deterministic and the corpus is current), then checks every committed
//! fixture against its expectation.
//!
//! Regenerate after an intended change:
//! `SIMFORGE_UPDATE_PACKAGE_FIXTURES=1 cargo test -p simforge-package --test fixtures`

mod support;

use std::io::Cursor;
use std::path::PathBuf;

use serde_json::{json, Value};
use simforge_package::names::blob_path;
use simforge_package::zip::{Method, ZipWriter};
use simforge_package::{verify_bytes, Form, VerifyOptions};
use support::*;

const UPDATE_ENV: &str = "SIMFORGE_UPDATE_PACKAGE_FIXTURES";

enum Expect {
    Valid(Form),
    Invalid(&'static str, &'static str),
}

struct Fixture {
    file: String,
    bytes: Vec<u8>,
    expect: Expect,
    note: &'static str,
}

fn dir() -> PathBuf {
    fixtures_root().join("scenario-package")
}

/// The thin fixture as (manifest value, receipt bytes, members in container order).
struct Parts {
    manifest: Value,
    members: Vec<(String, Vec<u8>)>,
}

impl Parts {
    fn of(bytes: &[u8]) -> Self {
        let entries = entries_of(bytes);
        let manifest = serde_json::from_slice(&entries[0].1).unwrap();
        let members = entries
            .into_iter()
            .filter(|(n, _)| n != "manifest.json" && n != "receipt.json")
            .collect();
        Self { manifest, members }
    }

    fn member(&self, path: &str) -> &[u8] {
        &self
            .members
            .iter()
            .find(|(n, _)| n.starts_with(path))
            .unwrap()
            .1
    }

    fn set(&mut self, path: &str, bytes: Vec<u8>) {
        let entry = self
            .members
            .iter_mut()
            .find(|(n, _)| n.starts_with(path))
            .unwrap();
        entry.1 = bytes;
    }

    /// Recompute members[] and every digest field from the member bytes
    /// (a timeline member is renamed to its new digest).
    fn sync(&mut self) {
        let m = &mut self.manifest;
        let mut timelines = Vec::new();
        for (name, bytes) in &mut self.members {
            let digest = sha(bytes);
            if name.starts_with("timeline/") {
                timelines.push((name.clone(), digest.clone()));
                *name = format!("timeline/{digest}.json");
            }
            match name.as_str() {
                "document.json" => m["scenario"]["contentSha256"] = json!(digest),
                "simulation/trace.json.gz" => m["simulation"]["traceGzipSha256"] = json!(digest),
                "simulation/resolution.json.gz" => {
                    m["simulation"]["resolutionSha256"] = json!(digest)
                }
                "map/closure.json" => m["map"]["browserClosureSha256"] = json!(digest),
                "actors/closure.json" => m["catalog"]["actorClosureDigest"] = json!(digest),
                "catalog/entries.json" => m["catalog"]["catalogSha256"] = json!(digest),
                "export/scenario.xosc" => m["executionPackage"]["xoscSha256"] = json!(digest),
                _ => {}
            }
        }
        for (old, new) in timelines {
            for t in m["timelines"].as_array_mut().unwrap() {
                if format!("timeline/{}.json", t["timelineSha256"].as_str().unwrap()) == old {
                    t["timelineSha256"] = json!(new);
                }
            }
        }
        let mut members: Vec<Value> = m["members"].as_array().unwrap().clone();
        for entry in &mut members {
            let path = entry["path"].as_str().unwrap().to_owned();
            let (name, bytes) = self
                .members
                .iter()
                .find(|(n, _)| {
                    *n == path || (path.starts_with("timeline/") && n.starts_with("timeline/"))
                })
                .unwrap();
            entry["path"] = json!(name);
            entry["sha256"] = json!(sha(bytes));
            entry["size"] = json!(bytes.len());
        }
        members.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        m["members"] = json!(members);
        // Container order is by role then path; timelines sort among themselves only.
    }

    fn assemble(&self, blobs: &[(String, Vec<u8>)]) -> Vec<u8> {
        assemble(&canonical_bytes(&self.manifest), None, &self.members, blobs)
    }
}

fn timeline_key(identity: &Value) -> String {
    sha(&canonical_bytes(&json!({
        "schema": "simforge.render-timeline-key/v1",
        "traceSha256": identity["traceSha256"],
        "heightFieldDigest": identity["heightFieldDigest"],
        "catalogDigest": identity["catalogDigest"],
        "samplerVersion": identity["samplerVersion"],
    })))
}

fn generate() -> Vec<Fixture> {
    let case = Case::fixture();
    let (_, thin) = case.builder(false).to_bytes().unwrap();
    let (_, full) = case.builder(true).to_bytes().unwrap();
    let minimal = {
        let mut c = case.clone();
        c.xosc = None;
        let built = c.build();
        let mut b = simforge_package::PackageBuilder::new(built.draft).unwrap();
        for (p, bytes) in built.members {
            b.member(&p, bytes).unwrap();
        }
        b.to_bytes().unwrap().1
    };
    let mut out = vec![
        Fixture {
            file: "valid/thin.scenario.zip".into(),
            bytes: thin.clone(),
            expect: Expect::Valid(Form::Thin),
            note: "thin package with receipt and derived xosc; map and actors by digest",
        },
        Fixture {
            file: "valid/full.scenario.zip".into(),
            bytes: full,
            expect: Expect::Valid(Form::Full),
            note: "the same revision, full: every non-texture map blob and the reachable actor blobs (same packageId as thin)",
        },
        Fixture {
            file: "valid/thin-minimal.scenario.zip".into(),
            bytes: minimal,
            expect: Expect::Valid(Form::Thin),
            note: "no receipt, no xosc: only required members",
        },
    ];
    let mut bad =
        |file: &str, bytes: Vec<u8>, code: &'static str, rule: &'static str, note: &'static str| {
            out.push(Fixture {
                file: format!("invalid/{file}.scenario.zip"),
                bytes,
                expect: Expect::Invalid(code, rule),
                note,
            });
        };
    const C: &str = "package_container_invalid";
    const M: &str = "package_manifest_invalid";
    const D: &str = "package_digest_mismatch";
    const V: &str = "package_version_unsupported";
    const I: &str = "package_identity_mismatch";
    const MI: &str = "package_member_invalid";
    const CL: &str = "package_closure_invalid";

    // Container rules, on a two-entry container (they fail before the manifest is read).
    let thin_entries = entries_of(&thin);
    let mini: Vec<(String, Vec<u8>)> = thin_entries
        .iter()
        .filter(|(n, _)| {
            n == "manifest.json" || n == "document.json" || n == "export/scenario.xosc"
        })
        .cloned()
        .collect();
    let raw = |f: &dyn Fn(&mut RawZip)| {
        let mut z = RawZip::from_entries(&mini);
        f(&mut z);
        z.build()
    };
    let doc = 1; // index of document.json in `mini`
    bad(
        "not-a-zip",
        b"this is not a scenario package".to_vec(),
        C,
        "not_a_zip",
        "no end-of-central-directory record",
    );
    bad(
        "name-zip-slip",
        raw(&|z| z.entries.push(RawEntry::new("../evil.json", b"{}"))),
        C,
        "name_not_allowed",
        "a member name escapes the package (zip-slip)",
    );
    bad(
        "name-unknown",
        raw(&|z| z.entries.push(RawEntry::new("notes.txt", b"hi"))),
        C,
        "name_not_allowed",
        "a name outside the section 10 allowlist",
    );
    bad(
        "duplicate-name",
        raw(&|z| {
            let e = z.entries[doc].clone();
            z.entries.push(e)
        }),
        C,
        "duplicate_name",
        "document.json twice",
    );
    bad(
        "directory-entry",
        raw(&|z| z.entries[doc].external = 0o040755 << 16),
        C,
        "directory",
        "an entry with a directory mode",
    );
    bad(
        "symlink",
        raw(&|z| z.entries[2].external = 0o120777 << 16),
        C,
        "symlink",
        "export/scenario.xosc is a symlink",
    );
    bad(
        "encrypted",
        raw(&|z| z.entries[doc].flags |= 1),
        C,
        "encrypted",
        "the encryption flag is set",
    );
    bad(
        "method-bzip2",
        raw(&|z| {
            z.entries[doc].method = 12;
            z.entries[doc].compressed = Some(z.entries[doc].data.clone())
        }),
        C,
        "method_not_allowed",
        "compression method 12",
    );
    bad(
        "multi-disk",
        raw(&|z| z.disk = 1),
        C,
        "multi_disk",
        "the end record names disk 1",
    );
    bad(
        "header-mismatch",
        raw(&|z| {
            let crc = crc32fast::hash(&z.entries[doc].data);
            z.entries[doc].crc_local = Some(crc ^ 1)
        }),
        C,
        "header_mismatch",
        "local header CRC disagrees with the central directory",
    );
    bad(
        "overlap",
        raw(&|z| z.entries[2].offset_of = Some(doc)),
        C,
        "overlap",
        "two central entries point into the same bytes",
    );
    bad(
        "prefix-data",
        raw(&|z| z.prefix = b"PREFIX..".to_vec()),
        C,
        "prefix_data",
        "bytes before the first entry",
    );
    bad(
        "trailing-data",
        raw(&|z| z.trailing = b"TRAILING".to_vec()),
        C,
        "trailing_data",
        "bytes after the end record",
    );
    bad(
        "comment",
        raw(&|z| z.comment = b"a comment".to_vec()),
        C,
        "comment",
        "an archive comment",
    );
    bad(
        "data-descriptor",
        raw(&|z| z.entries[doc].flags |= 0x8),
        C,
        "data_descriptor",
        "flag bit 3 (sizes after the data)",
    );
    bad(
        "extra-field",
        raw(&|z| {
            let x = vec![0x55, 0x54, 5, 0, 1, 0, 0, 0, 0];
            z.entries[doc].local_extra = x.clone();
            z.entries[doc].central_extra = x
        }),
        C,
        "extra_field",
        "an extended-timestamp extra field",
    );
    bad(
        "timestamp",
        raw(&|z| z.entries[doc].time = 0x6000),
        C,
        "timestamp",
        "a modification time other than 1980-01-01 00:00",
    );
    bad(
        "zip64-unneeded",
        {
            let mut w = ZipWriter::new(Cursor::new(Vec::new()), true).unwrap();
            for (n, d) in &mini {
                w.add(n, Method::Deflate, d.len() as u64, &mut &d[..])
                    .unwrap();
            }
            w.finish().unwrap().0.into_inner()
        },
        C,
        "zip64_inconsistent",
        "ZIP64 records on a container that does not need them (a ZIP64 lie)",
    );
    bad(
        "deflate-bomb",
        raw(&|z| z.entries[2].data = vec![b' '; 4 << 20]),
        "package_limit_exceeded",
        "deflate_ratio",
        "4 MiB inflated from a few KB",
    );

    // Rules that need a whole package.
    let full_raw = |f: &dyn Fn(&mut RawZip)| {
        let mut z = RawZip::from_entries(&thin_entries);
        f(&mut z);
        z.build()
    };
    let at = |name: &str| thin_entries.iter().position(|(n, _)| n == name).unwrap();
    let d = at("document.json");
    bad(
        "inflate-overrun",
        full_raw(&|z| {
            let mut longer = z.entries[d].data.clone();
            longer.extend_from_slice(b"                                ");
            let mut enc =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(6));
            std::io::Write::write_all(&mut enc, &longer).unwrap();
            z.entries[d].compressed = Some(enc.finish().unwrap());
        }),
        C,
        "inflate_overrun",
        "document.json inflates past its declared size",
    );
    bad(
        "crc-mismatch",
        full_raw(&|z| {
            let crc = crc32fast::hash(&z.entries[d].data) ^ 1;
            z.entries[d].crc_local = Some(crc);
            z.entries[d].crc_central = Some(crc);
        }),
        D,
        "crc",
        "consistent headers, wrong CRC-32",
    );
    bad(
        "manifest-not-first",
        full_raw(&|z| z.entries.swap(0, d)),
        C,
        "member_order",
        "manifest.json is not the first entry",
    );
    bad(
        "member-order",
        full_raw(&|z| z.entries.swap(d, d + 1)),
        C,
        "member_order",
        "document.json after the trace",
    );
    bad(
        "member-unlisted",
        full_raw(&|z| {
            z.entries
                .insert(d + 1, RawEntry::new("simulation/extra.json", b"{}"))
        }),
        C,
        "member_unlisted",
        "an allowlisted name the manifest does not list",
    );
    bad(
        "member-missing",
        full_raw(&|z| z.entries.retain(|e| e.name != b"catalog/entries.json")),
        C,
        "member_missing",
        "catalog/entries.json is listed but absent",
    );
    bad(
        "member-size",
        full_raw(&|z| {
            z.entries[d].data.pop();
        }),
        D,
        "member_size",
        "document.json is one byte shorter than the manifest says",
    );
    bad(
        "member-digest",
        full_raw(&|z| {
            let n = z.entries[d].data.len();
            z.entries[d].data[n - 2] ^= 0x01;
        }),
        D,
        "member_sha256",
        "document.json altered, same length",
    );
    bad(
        "receipt-mismatch",
        full_raw(&|z| {
            let r = at("receipt.json");
            let mut v: Value = serde_json::from_slice(&z.entries[r].data).unwrap();
            v["packageId"] = json!(sha(b"another package"));
            z.entries[r].data = canonical_bytes(&v);
        }),
        C,
        "receipt_invalid",
        "receipt.json names another package",
    );

    // Manifest rules (no receipt: it would name the unmodified package).
    let base = Parts::of(&thin);
    let manifest = |f: &dyn Fn(&mut Value)| {
        let mut p = Parts::of(&thin);
        f(&mut p.manifest);
        p.assemble(&[])
    };
    bad(
        "manifest-not-canonical",
        {
            let text = serde_json::to_vec_pretty(&base.manifest).unwrap();
            assemble(&text, None, &base.members, &[])
        },
        "package_manifest_not_canonical",
        "not_canonical",
        "pretty-printed manifest.json",
    );
    bad(
        "manifest-unknown-field",
        manifest(&|m| m["notes"] = json!("x")),
        M,
        "schema",
        "an unknown top-level field",
    );
    bad(
        "manifest-missing-producer",
        manifest(&|m| {
            m.as_object_mut().unwrap().remove("producer");
        }),
        M,
        "schema",
        "no producer",
    );
    bad(
        "manifest-null-optional",
        manifest(&|m| m["scenario"]["origin"] = Value::Null),
        M,
        "schema",
        "null where an optional field must be absent",
    );
    bad(
        "manifest-bad-digest",
        manifest(&|m| {
            let v = m["scenario"]["contentSha256"]
                .as_str()
                .unwrap()
                .to_uppercase();
            m["scenario"]["contentSha256"] = json!(v)
        }),
        M,
        "digest",
        "an uppercase digest",
    );
    bad(
        "manifest-digest-field",
        manifest(&|m| m["map"]["browserClosureSha256"] = json!(sha(b"x"))),
        M,
        "member_digest_field",
        "map.browserClosureSha256 is not the map/closure.json member digest",
    );
    bad(
        "manifest-required-role",
        {
            let mut p = Parts::of(&thin);
            p.members.retain(|(n, _)| n != "catalog/entries.json");
            let members: Vec<Value> = p.manifest["members"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["path"] != "catalog/entries.json")
                .cloned()
                .collect();
            p.manifest["members"] = json!(members);
            p.assemble(&[])
        },
        M,
        "required_role_missing",
        "no catalog member",
    );
    bad(
        "version-manifest-major",
        manifest(&|m| m["schema"] = json!("simforge.scenario-package/v2")),
        V,
        "version_ahead",
        "a v2 manifest",
    );
    bad(
        "version-min-cli",
        manifest(&|m| m["producer"]["minCli"] = json!("99.0.0")),
        V,
        "version_ahead",
        "producer.minCli is ahead of the reader",
    );
    bad(
        "version-trace-format",
        manifest(&|m| {
            m["simulation"]["traceFormat"] = json!(99);
            m["simulation"]["traceSchema"] = json!("simforge.trace/v99");
            m["simulation"]["groundDigest"] = json!(sha(b"ground"));
            m["map"]["groundDigest"] = json!(sha(b"ground"));
            for e in m["members"].as_array_mut().unwrap() {
                if e["path"] == "simulation/trace.json.gz" {
                    e["schema"] = json!("simforge.trace/v99");
                }
            }
        }),
        V,
        "version_ahead",
        "trace format 99",
    );
    bad(
        "version-sampler",
        manifest(&|m| m["timelines"][0]["samplerVersion"] = json!("simforge.timeline-sampler/99")),
        V,
        "version_ahead",
        "sampler 99",
    );

    // Content rules: members changed, digests re-synced, so only the content check fails.
    let content = |f: &dyn Fn(&mut Parts)| {
        let mut p = Parts::of(&thin);
        f(&mut p);
        p.sync();
        p.assemble(&[])
    };
    let json_member =
        |p: &Parts, path: &str| -> Value { serde_json::from_slice(p.member(path)).unwrap() };
    bad(
        "document-not-canonical",
        content(&|p| {
            let v = json_member(p, "document.json");
            p.set("document.json", serde_json::to_vec_pretty(&v).unwrap())
        }),
        MI,
        "not_canonical",
        "document.json pretty-printed",
    );
    bad(
        "document-version",
        content(&|p| {
            let mut v = json_member(p, "document.json");
            v["scenarioVersion"] = json!(1);
            p.set("document.json", canonical_bytes(&v))
        }),
        I,
        "document_version",
        "document scenarioVersion 1 under a v2 manifest",
    );
    bad(
        "trace-invalid",
        content(&|p| p.set("simulation/trace.json.gz", gzip(b"{}"))),
        MI,
        "trace_invalid",
        "the trace member is not a trace",
    );
    bad(
        "trace-map",
        content(&|p| p.manifest["map"]["xodrSha256"] = json!(sha(b"another map"))),
        I,
        "trace_map",
        "the trace ran on another OpenDRIVE",
    );
    bad(
        "trace-input",
        content(&|p| {
            p.manifest["simulation"]["resolvedInputDigest"] = json!(sha(b"another input"))
        }),
        I,
        "trace_input",
        "resolvedInputDigest is not the trace's inputHash",
    );
    bad(
        "resolution-mismatch",
        content(&|p| {
            let mut v: Value =
                serde_json::from_slice(&gunzip(p.member("simulation/resolution.json.gz"))).unwrap();
            v["simKey"] = json!(sha(b"another sim key"));
            p.set("simulation/resolution.json.gz", gzip(&canonical_bytes(&v)));
        }),
        I,
        "resolution_mismatch",
        "the resolution record names another simKey",
    );
    bad(
        "timeline-not-canonical",
        content(&|p| {
            let v = json_member(p, "timeline/");
            p.set("timeline/", serde_json::to_vec_pretty(&v).unwrap())
        }),
        MI,
        "not_canonical",
        "a pretty-printed timeline",
    );
    bad(
        "timeline-key",
        content(&|p| {
            let mut v = json_member(p, "timeline/");
            v["identity"]["timelineKey"] = json!(sha(b"another key"));
            p.manifest["timelines"][0]["timelineKey"] = v["identity"]["timelineKey"].clone();
            p.set("timeline/", canonical_bytes(&v));
        }),
        I,
        "timeline_key",
        "timelineKey does not recompute from the identity",
    );
    bad(
        "timeline-trace",
        content(&|p| {
            let mut v = json_member(p, "timeline/");
            v["identity"]["traceSha256"] = json!(sha(b"another trace"));
            v["trace"]["traceSha256"] = v["identity"]["traceSha256"].clone();
            let key = timeline_key(&v["identity"]);
            v["identity"]["timelineKey"] = json!(key);
            p.manifest["timelines"][0]["timelineKey"] = json!(key);
            p.set("timeline/", canonical_bytes(&v));
        }),
        I,
        "timeline_trace",
        "the timeline was sampled from another trace",
    );
    bad(
        "catalog-ids",
        content(&|p| p.manifest["catalog"]["catalogIds"] = json!(["vehicle.sedan"])),
        I,
        "catalog_ids",
        "catalogIds is not what the timeline binds",
    );
    bad(
        "map-closure-count",
        content(&|p| {
            let n = p.manifest["map"]["closure"]["memberCount"]
                .as_u64()
                .unwrap();
            p.manifest["map"]["closure"]["memberCount"] = json!(n + 1)
        }),
        I,
        "map_closure_count",
        "map.closure.memberCount is off by one",
    );
    bad(
        "map-pin-closure",
        content(&|p| p.manifest["map"]["pinClosureSha256"] = json!(sha(b"another pin"))),
        I,
        "map_pin_closure",
        "pinClosureSha256 does not recompute",
    );
    bad(
        "closure-size-conflict",
        content(&|p| {
            let mut v = json_member(p, "actors/closure.json");
            let mut dup = v["members"]["models/vehicle.sedan/model.glb"].clone();
            dup["bytes"] = json!(dup["bytes"].as_u64().unwrap() + 1);
            v["members"]["models/vehicle.sedan-copy/model.glb"] = dup;
            p.set("actors/closure.json", canonical_bytes(&v));
        }),
        CL,
        "closure_size_conflict",
        "one digest listed with two sizes",
    );
    bad(
        "actor-closure-no-catalog",
        content(&|p| {
            let mut v = json_member(p, "actors/closure.json");
            v["members"]
                .as_object_mut()
                .unwrap()
                .remove("catalog-models.json");
            p.set("actors/closure.json", canonical_bytes(&v));
        }),
        CL,
        "actor_closure_schema",
        "the actor closure has no catalog-models.json",
    );

    // Blob and form rules.
    let actors = synthetic_actors();
    let blob = |bytes: &[u8]| (blob_path(&sha(bytes)), bytes.to_vec());
    let catalog_blob = blob(&actors.blobs["catalog-models.json"]);
    let box_blob = blob(&actors.blobs["models/hazard.cardboard_box/model.glb"]);
    bad(
        "blob-unreferenced",
        base.assemble(&[blob(b"a blob no closure lists")]),
        C,
        "blob_unreferenced",
        "a blob neither closure names",
    );
    bad(
        "blob-name",
        base.assemble(&[(blob_path(&sha(b"the name")), b"other bytes".to_vec())]),
        D,
        "blob_name",
        "a blob whose bytes do not hash to its name",
    );
    bad(
        "form-incomplete",
        {
            let mut blobs = vec![catalog_blob, box_blob];
            blobs.sort();
            base.assemble(&blobs)
        },
        "package_form_incomplete",
        "blob_missing",
        "actor blobs embedded, map blobs not: neither thin nor full",
    );

    out
}

fn expectations(fixtures: &[Fixture]) -> String {
    let list: Vec<Value> = fixtures
        .iter()
        .map(|f| match &f.expect {
            Expect::Valid(form) => {
                let v = verify_bytes(&f.bytes, &VerifyOptions::new(Some(CLI)).unwrap())
                    .unwrap_or_else(|e| panic!("{}: {e}", f.file));
                json!({ "file": f.file, "valid": true, "form": form.as_str(), "packageId": v.package_id(), "note": f.note })
            }
            Expect::Invalid(code, rule) => {
                json!({ "file": f.file, "valid": false, "code": code, "rule": rule, "note": f.note })
            }
        })
        .collect();
    let doc = json!({
        "schema": "simforge.scenario-package-fixtures/v1",
        "description": "Generated by oss/native/crates/simforge-package/tests/fixtures.rs; verify each file as a reader at `readerCli`. Valid files verify to `packageId`; invalid ones are refused with `code` and `rule`.",
        "readerCli": CLI,
        "fixtures": list,
    });
    let mut text = serde_json::to_string_pretty(&doc).unwrap();
    text.push('\n');
    text
}

#[test]
fn fixtures_are_current_and_behave() {
    let fixtures = generate();
    let root = dir();
    let expect_text = expectations(&fixtures);
    if std::env::var_os(UPDATE_ENV).is_some() {
        for sub in ["valid", "invalid"] {
            let d = root.join(sub);
            if d.exists() {
                std::fs::remove_dir_all(&d).unwrap();
            }
            std::fs::create_dir_all(&d).unwrap();
        }
        for f in &fixtures {
            std::fs::write(root.join(&f.file), &f.bytes).unwrap();
        }
        std::fs::write(root.join("expectations.json"), &expect_text).unwrap();
    }
    let committed = std::fs::read_to_string(root.join("expectations.json"))
        .unwrap_or_else(|_| panic!("run with {UPDATE_ENV}=1 to create the fixtures"));
    assert_eq!(
        committed, expect_text,
        "expectations.json is stale; regenerate with {UPDATE_ENV}=1"
    );
    let mut on_disk = 0;
    for sub in ["valid", "invalid"] {
        on_disk += std::fs::read_dir(root.join(sub)).unwrap().count();
    }
    assert_eq!(
        on_disk,
        fixtures.len(),
        "stray fixture files; regenerate with {UPDATE_ENV}=1"
    );

    let options = VerifyOptions::new(Some(CLI)).unwrap();
    let mut failures = Vec::new();
    for f in &fixtures {
        let bytes = std::fs::read(root.join(&f.file)).unwrap();
        if bytes != f.bytes {
            failures.push(format!("{}: committed bytes differ from the generator (writer not deterministic, or stale)", f.file));
            continue;
        }
        match (&f.expect, verify_bytes(&bytes, &options)) {
            (Expect::Valid(form), Ok(v)) if v.form() == *form => {}
            (Expect::Valid(_), Ok(v)) => {
                failures.push(format!("{}: verified as {:?}", f.file, v.form()))
            }
            (Expect::Valid(_), Err(e)) => failures.push(format!("{}: refused: {e}", f.file)),
            (Expect::Invalid(code, rule), Err(e))
                if e.code.as_str() == *code && e.rule == *rule => {}
            (Expect::Invalid(code, rule), Err(e)) => {
                failures.push(format!("{}: expected {code}/{rule}, got {e}", f.file))
            }
            (Expect::Invalid(..), Ok(_)) => failures.push(format!("{}: accepted", f.file)),
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn thin_and_full_share_one_package_id() {
    let case = Case::fixture();
    let (thin, _) = case.builder(false).to_bytes().unwrap();
    let (full, _) = case.builder(true).to_bytes().unwrap();
    assert_eq!(thin.package_id, full.package_id);
    assert_eq!(thin.manifest_bytes, full.manifest_bytes);
    assert_eq!(thin.form, Form::Thin);
    assert_eq!(full.form, Form::Full);
    assert_eq!(full.content.embedded_texture_members, 0);
    assert_eq!(full.content.texture_members, 1);
}

#[test]
fn the_raw_builder_reproduces_the_writer() {
    // An independent ZIP encoder, given the same entries, emits the same
    // bytes: the writer's format is exactly the documented subset.
    let (_, thin) = Case::fixture().builder(false).to_bytes().unwrap();
    assert_eq!(RawZip::from_entries(&entries_of(&thin)).build(), thin);
}

#[test]
fn version_refusals_list_their_dimensions() {
    let fixtures = generate();
    let options = VerifyOptions::new(Some(CLI)).unwrap();
    let dims = |name: &str| -> Vec<String> {
        let f = fixtures.iter().find(|f| f.file.contains(name)).unwrap();
        let e = verify_bytes(&f.bytes, &options).unwrap_err();
        e.dimensions.iter().map(|d| d.dimension.clone()).collect()
    };
    assert_eq!(dims("version-manifest-major"), ["manifest"]);
    assert_eq!(dims("version-min-cli"), ["cli"]);
    assert_eq!(dims("version-trace-format"), ["traceFormat"]);
    assert_eq!(dims("version-sampler"), ["samplerVersion"]);
    // Without a CLI version (a producer re-checking its own output) the cli
    // dimension is not evaluated, and says so.
    let f = fixtures
        .iter()
        .find(|f| f.file.contains("version-min-cli"))
        .unwrap();
    let producer = VerifyOptions::new(None).unwrap();
    let v = verify_bytes(&f.bytes, &producer).unwrap();
    assert_eq!(v.inspection.cli_check, "not-evaluated");
}

#[test]
fn the_shared_canonical_json_vector_is_the_thin_manifest() {
    // fixtures/canonical-json/vectors.json carries the thin fixture's manifest
    // so the TypeScript and Rust canonical encoders are held to it.
    let vectors: Value = serde_json::from_slice(&read("canonical-json/vectors.json")).unwrap();
    let v = vectors["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "scenario-package-manifest")
        .expect("the scenario-package-manifest vector");
    let (thin, _) = Case::fixture().builder(false).to_bytes().unwrap();
    assert_eq!(
        v["canonical"].as_str().unwrap().as_bytes(),
        thin.manifest_bytes.as_slice()
    );
    assert_eq!(v["sha256"].as_str().unwrap(), thin.package_id);
}
