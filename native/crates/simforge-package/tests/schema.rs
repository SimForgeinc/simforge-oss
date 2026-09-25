//! `contracts/scenario-package/*.schema.json` agree with the reader.
//!
//! A small validator covers exactly the JSON Schema keywords the two
//! contracts use; each `pattern` maps to a Rust predicate (an unknown
//! pattern fails the test, so a schema edit cannot silently skip a check).
//! Every valid fixture's manifest and receipt must validate, a maximal
//! manifest (every optional field present) must pass both the schema and the
//! typed reader, and the schema-level hostile manifests must fail.

mod support;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use simforge_package::Manifest;
use support::*;

fn contracts() -> PathBuf {
    let mut dir = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    loop {
        let candidate = dir.join("contracts/scenario-package");
        if candidate.is_dir() {
            return candidate;
        }
        assert!(dir.pop(), "no contracts/scenario-package above the crate");
    }
}

fn load(name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(contracts().join(name)).unwrap()).unwrap()
}

fn positive_int(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit())
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    let d = |r: std::ops::Range<usize>| b.get(r).is_some_and(|x| x.iter().all(u8::is_ascii_digit));
    b.len() >= 20
        && d(0..4)
        && b[4] == b'-'
        && d(5..7)
        && b[7] == b'-'
        && d(8..10)
        && b[10] == b'T'
        && d(11..13)
        && b[13] == b':'
        && d(14..16)
        && b[16] == b':'
        && d(17..19)
        && b[b.len() - 1] == b'Z'
        && (b.len() == 20 || (b[19] == b'.' && (22..=30).contains(&b.len()) && d(20..b.len() - 1)))
}

fn pattern(p: &str, s: &str) -> bool {
    match p {
        "^[0-9a-f]{64}$" => is_hex(s, 64),
        "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$" => {
            semver::Version::parse(s).is_ok()
        }
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$" => timestamp(s),
        "^[A-Za-z0-9_-]{1,128}$" => {
            (1..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }
        "^[^\\u0000-\\u001f\\u007f-\\u009f]*$" => !s.chars().any(char::is_control),
        "^[A-Za-z0-9._:-]+$" => token(s),
        "^[a-z][a-z0-9-]{0,63}$" => {
            s.len() <= 64
                && s.starts_with(|c: char| c.is_ascii_lowercase())
                && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        }
        "^simforge\\.scenario\\.v[1-9][0-9]*$" => s.strip_prefix("simforge.scenario.v").is_some_and(positive_int),
        "^simforge\\.trace/v[1-9][0-9]*$" => s.strip_prefix("simforge.trace/v").is_some_and(positive_int),
        "^simforge\\.timeline-sampler/[1-9][0-9]*$" => {
            s.strip_prefix("simforge.timeline-sampler/").is_some_and(positive_int)
        }
        "^timeline/[0-9a-f]{64}\\.json$" => {
            s.strip_prefix("timeline/").and_then(|r| r.strip_suffix(".json")).is_some_and(|h| is_hex(h, 64))
        }
        "^sha256:[0-9a-f]{64}$" => s.strip_prefix("sha256:").is_some_and(|h| is_hex(h, 64)),
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" => {
            s.len() == 36
                && s.split('-').map(str::len).eq([8, 4, 4, 4, 12])
                && s.split('-').all(|g| is_hex(g, g.len()))
        }
        "^[a-z0-9-]+\\.[A-Za-z0-9._:-]{1,128}$" => s.split_once('.').is_some_and(|(ns, name)| {
            !ns.is_empty()
                && ns.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && name.len() <= 128
                && token(name)
        }),
        other => panic!("schema pattern {other:?} has no predicate in tests/schema.rs; add one"),
    }
}

/// Validate `v` against `s` (subset of 2020-12). Returns the first error path.
fn validate(root: &Value, s: &Value, v: &Value, at: &str) -> Result<(), String> {
    let fail = |why: &str| Err(format!("{at}: {why}"));
    if let Some(r) = s.get("$ref").and_then(Value::as_str) {
        let name = r.strip_prefix("#/$defs/").expect("local refs only");
        return validate(root, &root["$defs"][name], v, at);
    }
    if let Some(c) = s.get("const") {
        if v != c {
            return fail(&format!("not {c}"));
        }
    }
    if let Some(e) = s.get("enum").and_then(Value::as_array) {
        if !e.contains(v) {
            return fail("not in enum");
        }
    }
    if let Some(one) = s.get("oneOf").and_then(Value::as_array) {
        let ok = one
            .iter()
            .filter(|b| validate(root, b, v, at).is_ok())
            .count();
        if ok != 1 {
            return fail(&format!("matches {ok} of oneOf"));
        }
    }
    if let Some(t) = s.get("type").and_then(Value::as_str) {
        let ok = match t {
            "object" => v.is_object(),
            "array" => v.is_array(),
            "string" => v.is_string(),
            "integer" => v.is_u64() || v.is_i64(),
            "number" => v.is_number(),
            "boolean" => v.is_boolean(),
            "null" => v.is_null(),
            _ => panic!("type {t}"),
        };
        if !ok {
            return fail(&format!("not {t}"));
        }
    }
    if let Some(x) = v.as_str() {
        let n = x.chars().count() as u64;
        if s.get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|m| n < m)
            || s.get("maxLength")
                .and_then(Value::as_u64)
                .is_some_and(|m| n > m)
        {
            return fail("length");
        }
        if let Some(p) = s.get("pattern").and_then(Value::as_str) {
            if !pattern(p, x) {
                return fail(&format!("does not match {p}"));
            }
        }
    }
    if let Some(x) = v.as_f64() {
        if s.get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|m| x < m)
            || s.get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|m| x > m)
            || s.get("exclusiveMinimum")
                .and_then(Value::as_f64)
                .is_some_and(|m| x <= m)
        {
            return fail("range");
        }
    }
    if let Some(o) = v.as_object() {
        let props = s.get("properties").and_then(Value::as_object);
        for r in s
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !o.contains_key(r.as_str().unwrap()) {
                return fail(&format!("missing {r}"));
            }
        }
        for (k, child) in o {
            if let Some(p) = s
                .get("propertyNames")
                .and_then(|p| p.get("pattern"))
                .and_then(Value::as_str)
            {
                if !pattern(p, k) {
                    return fail(&format!("property name {k:?}"));
                }
            }
            match props.and_then(|p| p.get(k)) {
                Some(ps) => validate(root, ps, child, &format!("{at}.{k}"))?,
                None if s.get("additionalProperties") == Some(&Value::Bool(false)) => {
                    return fail(&format!("unexpected {k}"))
                }
                None => {}
            }
        }
    }
    if let Some(a) = v.as_array() {
        if s.get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|m| (a.len() as u64) < m)
        {
            return fail("too few items");
        }
        if s.get("uniqueItems") == Some(&Value::Bool(true)) {
            for (i, x) in a.iter().enumerate() {
                if a[..i].contains(x) {
                    return fail("duplicate item");
                }
            }
        }
        if let Some(items) = s.get("items") {
            for (i, x) in a.iter().enumerate() {
                validate(root, items, x, &format!("{at}[{i}]"))?;
            }
        }
    }
    Ok(())
}

fn check(schema: &Value, v: &Value) -> Result<(), String> {
    validate(schema, schema, v, "$")
}

fn fixture_json(file: &str, member: &str) -> Option<Value> {
    let bytes = std::fs::read(fixtures_root().join("scenario-package").join(file)).unwrap();
    entries_of(&bytes)
        .into_iter()
        .find(|(n, _)| n == member)
        .map(|(_, b)| serde_json::from_slice(&b).unwrap())
}

#[test]
fn valid_fixtures_conform() {
    let manifest_schema = load("manifest.v1.schema.json");
    let receipt_schema = load("receipt.v1.schema.json");
    let expectations: Value =
        serde_json::from_slice(&read("scenario-package/expectations.json")).unwrap();
    let valid: Vec<String> = expectations["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["valid"] == true)
        .map(|f| f["file"].as_str().unwrap().to_owned())
        .collect();
    assert!(valid.len() >= 5);
    for file in valid.iter().map(String::as_str) {
        let m = fixture_json(file, "manifest.json").unwrap();
        check(&manifest_schema, &m).unwrap_or_else(|e| panic!("{file}: {e}"));
        if let Some(r) = fixture_json(file, "receipt.json") {
            check(&receipt_schema, &r).unwrap_or_else(|e| panic!("{file} receipt: {e}"));
        }
    }
}

#[test]
fn a_maximal_manifest_passes_schema_and_reader() {
    // Every optional field present: a Rust field the schema lacks (or the
    // reverse) fails one side.
    let schema = load("manifest.v1.schema.json");
    let mut m = fixture_json("valid/thin.scenario.zip", "manifest.json").unwrap();
    let h = |s: &str| sha(s.as_bytes());
    m["scenario"]["origin"] = json!({
        "documentId": "doc_1", "revisionId": "rev_7", "revisionNumber": 7, "committedAt": "2026-09-21T18:02:11.5Z"
    });
    m["engine"]["build"] = json!({
        "engineVersion": "0.9.0", "abiVersion": 3, "buildDigest": h("b"), "addonSha256": h("a"), "sourceRevision": "abc123"
    });
    m["simulation"]["trafficStepKey"] = json!("step:1");
    m["simulation"]["sumo"] =
        json!({ "networkSha256": h("n"), "runtimeVersion": "1.20.0", "wasmSha256": h("w") });
    m["provenance"]["authorDisplayName"] = json!("Ada");
    m["extensions"] = json!({ "simcloud.exportJob": { "id": 1 } });
    let tl = m["timelines"][0]["timelineSha256"].clone();
    m["render"] = json!({
        "mode": "reproduce-exactly", "renderer": "native-bevy", "imageDigest": format!("sha256:{}", h("i")),
        "runtimeVersion": "0.2.0", "rendererBuild": "rb-1",
        "gpu": { "model": "RTX 5080", "driverVersion": "580.1", "vramGiB": 16 },
        "profile": { "id": "showcase", "width": 1920, "height": 1080, "fps": 30, "capturePolicy": "every-frame", "textureTier": "512-bc7" },
        "timelineSha256": tl,
        "sourceOutputs": { "frameManifestSha256": h("f"), "videoSha256": h("v") }
    });
    let pin = canonical_bytes(&m["render"]);
    m["members"].as_array_mut().unwrap().push(json!({
        "path": "render/pin.json", "role": "render-pin", "sha256": sha(&pin), "size": pin.len(),
        "mediaType": "application/vnd.simforge.render-pin+json", "schema": "simforge.render-pin/v1"
    }));
    m["members"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    check(&schema, &m).unwrap();
    Manifest::from_value(m.clone())
        .unwrap_or_else(|e| panic!("reader refuses the maximal manifest: {e}"));
    // And the minimal fixture passes the reader too (the schema already checked).
    let min = fixture_json("valid/thin-minimal.scenario.zip", "manifest.json").unwrap();
    Manifest::from_value(min).unwrap();
}

#[test]
fn schema_level_hostile_manifests_fail() {
    let schema = load("manifest.v1.schema.json");
    for name in [
        "manifest-unknown-field",
        "manifest-missing-producer",
        "manifest-null-optional",
        "manifest-bad-digest",
        "version-manifest-major",
    ] {
        let m = fixture_json(&format!("invalid/{name}.scenario.zip"), "manifest.json").unwrap();
        assert!(check(&schema, &m).is_err(), "{name} passes the schema");
    }
    // A member whose role does not match its path.
    let mut m = fixture_json("valid/thin.scenario.zip", "manifest.json").unwrap();
    m["members"][0]["role"] = json!("catalog");
    assert!(check(&schema, &m).is_err());
}
