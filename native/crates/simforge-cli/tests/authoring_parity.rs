//! Authoring commands against their parity goldens.
//!
//! Each golden under `tests/fixtures/authoring-parity/` is a case the
//! differential runner (`packages/cli/parity/authoring-parity.mjs` in the
//! platform repo) proved equal between the TypeScript and the Rust CLI, over
//! the public Richmond fixture (`fixtures/golden-traces/maps`). This test
//! replays the argv through the built binary and requires the same exit
//! code and stderr error, and the same sha256 of the canonical stdout
//! document and of each written file (gzip members inflated first). `<OUT>`
//! is the case's output directory, `<MAPS>` the maps root, `<ROOT>` the SDK
//! root (the working directory every case runs in).
//!
//! Re-record (after an intentional change, from the platform checkout):
//! `node oss/packages/cli/parity/authoring-parity.mjs --rust <simforge> \
//!   --fixture-maps --maps richmond-field-station --record \
//!   oss/native/crates/simforge-cli/tests/fixtures/authoring-parity`

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Map, Value};
use simforge_core::hash::{canonical_json, sha256};

fn sdk_root() -> PathBuf {
    // crates/simforge-cli -> native -> the SDK root (oss/ before the split).
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .find(|p| p.join("fixtures").join("golden-traces").is_dir())
        .expect("SDK root with fixtures/golden-traces")
        .to_path_buf()
}

/// The fixture maps as a dev-assets root (`map.xodr.gz` inflated).
fn fixture_maps(dst: &Path) {
    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let src = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if src.is_dir() {
                copy(&src, &to.join(&name));
            } else if name == "map.xodr.gz" {
                let mut text = Vec::new();
                flate2::read::GzDecoder::new(std::fs::File::open(&src).unwrap())
                    .read_to_end(&mut text)
                    .unwrap();
                std::fs::write(to.join("map.xodr"), text).unwrap();
            } else {
                std::fs::copy(&src, to.join(&name)).unwrap();
            }
        }
    }
    copy(&sdk_root().join("fixtures/golden-traces/maps"), dst);
}

fn rewrite(value: Value, from: &str, to: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace(from, to)),
        Value::Array(items) => Value::Array(items.into_iter().map(|v| rewrite(v, from, to)).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, rewrite(v, from, to)))
                .collect(),
        ),
        other => other,
    }
}

fn parse_json(bytes: &[u8]) -> Value {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Value::Null;
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| serde_json::json!({ "unparseable": trimmed }))
}

fn read_tree(dir: &Path) -> Value {
    fn walk(root: &Path, dir: &Path, out: &mut Map<String, Value>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
                continue;
            }
            let mut bytes = std::fs::read(&path).unwrap();
            if bytes.starts_with(&[0x1f, 0x8b]) {
                let mut plain = Vec::new();
                flate2::read::GzDecoder::new(&bytes[..]).read_to_end(&mut plain).unwrap();
                bytes = plain;
            }
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            let value = parse_json(&bytes);
            out.insert(rel, if value.is_null() { serde_json::json!({ "empty": true }) } else { value });
        }
    }
    let mut out = Map::new();
    walk(dir, dir, &mut out);
    Value::Object(out)
}

/// Wall clock is not part of a golden (`elapsedMs` of a batch summary).
fn mask_volatile(mut value: Value) -> Value {
    if value.get("kind").and_then(Value::as_str) == Some("scenario-batch-summary") && value.get("elapsedMs").is_some() {
        value["elapsedMs"] = Value::String("<ms>".into());
    }
    value
}

fn canonical(value: &Value) -> String {
    canonical_json(value).expect("canonical JSON")
}

#[test]
fn authoring_commands_match_their_parity_goldens() {
    let goldens = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/authoring-parity");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&goldens)
        .expect("golden dir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no goldens in {}", goldens.display());

    let tmp = tempfile::tempdir().unwrap();
    let maps = tmp.path().join("maps");
    fixture_maps(&maps);
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let maps_text = maps.display().to_string();
    let root_text = sdk_root().display().to_string();

    let mut failures = Vec::new();
    for golden_file in &files {
        let name = golden_file.file_stem().unwrap().to_string_lossy().into_owned();
        let golden: Value = serde_json::from_slice(&std::fs::read(golden_file).unwrap()).unwrap();
        let out = tmp.path().join("out").join(&name);
        std::fs::create_dir_all(&out).unwrap();
        let out_text = out.display().to_string();
        let argv: Vec<String> = golden["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().replace("{OUT}", &out_text))
            .collect();
        let simforge = |args: &[String]| {
            Command::new(env!("CARGO_BIN_EXE_simforge"))
                .args(args)
                .current_dir(sdk_root())
                .env("HOME", &home)
                .env("SCEN_DEV_ASSETS", &maps)
                .env_remove("SIMFORGE_MAPS_CACHE_ROOT")
                .env_remove("XDG_DATA_HOME")
                .output()
                .expect("run simforge")
        };
        // `pre`: commands run first in the same output directory (a batch
        // that resumes the cells an earlier run wrote).
        for pre in golden["pre"].as_array().into_iter().flatten() {
            let pre: Vec<String> = pre
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap().replace("{OUT}", &out_text))
                .collect();
            simforge(&pre);
        }
        let output = simforge(&argv);
        let stderr_line = String::from_utf8_lossy(&output.stderr)
            .lines()
            .filter(|l| l.starts_with('{'))
            .last()
            .map(str::to_owned)
            .unwrap_or_default();
        let result = serde_json::json!({
            "stdout": parse_json(&output.stdout),
            "stderr": parse_json(stderr_line.as_bytes()),
            "files": read_tree(&out),
        });
        let result = rewrite(rewrite(result, &out_text, "<OUT>"), &maps_text, "<MAPS>");
        let result = rewrite(result, &root_text, "<ROOT>");
        let files: Map<String, Value> = result["files"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(sha256(&canonical(&mask_volatile(v.clone()))))))
            .collect();
        let mut actual = serde_json::json!({
            "argv": golden["argv"],
            "exit": output.status.code(),
            "stdoutSha256": sha256(&canonical(&mask_volatile(result["stdout"].clone()))),
            "stderr": result["stderr"],
            "files": files,
        });
        if golden.get("pre").is_some() {
            actual["pre"] = golden["pre"].clone();
        }
        if canonical(&actual) != canonical(&golden) {
            failures.push(format!("{name}: expected {golden} got {actual}"));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ from their goldens: {failures:?}", failures.len(), files.len());
}
