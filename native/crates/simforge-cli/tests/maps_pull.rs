//! `simforge maps pull` against a synthetic registry built in a tempdir,
//! over `file://` and over a local HTTP server: the installed layouts and
//! receipts, the blob cache, and every tamper case refusing to install.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use simforge_cli::registry::{canonical_json, sha256_hex};

const MAP: &str = "test-town";

/// Closure members of the synthetic master: a master document, geometry,
/// a source raster and its KTX2, road sidecars and one web cell.
fn canonical_files() -> BTreeMap<&'static str, Vec<u8>> {
    BTreeMap::from([
        ("master.gltf", br#"{"asset":{"version":"2.0"}}"#.to_vec()),
        ("geometry.bin", vec![7u8; 4096]),
        ("images/road.png", b"\x89PNG source raster".to_vec()),
        ("images/road.ktx2", b"KTX2 encoded".to_vec()),
        ("map.xodr", b"<OpenDRIVE/>".to_vec()),
        ("topology-index.json.gz", b"gz bytes".to_vec()),
        ("derived/ground/ground-mesh.bin", vec![1u8; 300]),
        ("3d/0/0.glb", b"cell".to_vec()),
        ("empty.txt", Vec::new()),
    ])
}

fn web_files() -> BTreeMap<&'static str, Vec<u8>> {
    BTreeMap::from([
        ("3d/web/0.glb", b"web cell".to_vec()),
        ("images/road.ktx2", b"KTX2 encoded".to_vec()),
        ("map.xodr", b"<OpenDRIVE/>".to_vec()),
    ])
}

fn members(files: &BTreeMap<&str, Vec<u8>>) -> Value {
    Value::Object(
        files
            .iter()
            .map(|(p, b)| {
                (
                    p.to_string(),
                    json!({ "sha256": sha256_hex(b), "bytes": b.len() }),
                )
            })
            .collect(),
    )
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

/// Pretty (non-canonical) JSON on disk: digests are over the canonical form.
fn write_json(path: &Path, value: &Value) {
    write(
        path,
        serde_json::to_string_pretty(value).unwrap().as_bytes(),
    );
}

struct Fixture {
    root: PathBuf,
    closure: Value,
    web: Option<Value>,
    release: Value,
}

impl Fixture {
    fn new(root: &Path, with_web: bool) -> Self {
        let mut fixture = Fixture {
            root: root.to_path_buf(),
            closure: json!({
                "schema": "map-closure.v1",
                "kind": "canonical",
                "metadata": { "master": true },
                "members": members(&canonical_files()),
            }),
            web: with_web.then(|| {
                json!({ "schema": "map-closure.v1", "kind": "web", "toolFingerprint": "web-tool/1", "members": members(&web_files()) })
            }),
            release: Value::Null,
        };
        for bytes in canonical_files().values().chain(web_files().values()) {
            fixture.put_blob(bytes);
        }
        fixture.publish();
        fixture
    }

    fn put_blob(&self, bytes: &[u8]) {
        let digest = sha256_hex(bytes);
        write(
            &self
                .root
                .join(format!("blobs/sha256/{}/{digest}", &digest[..2])),
            bytes,
        );
    }

    fn blob_path(&self, bytes: &[u8]) -> PathBuf {
        let digest = sha256_hex(bytes);
        self.root
            .join(format!("blobs/sha256/{}/{digest}", &digest[..2]))
    }

    /// Write closure(s), release, versions and index with consistent digests.
    fn publish(&mut self) {
        let closure_key = format!("maps/{MAP}/v1/closure.json");
        write_json(&self.root.join(&closure_key), &self.closure);
        let closure_digest = sha256_hex(canonical_json(&self.closure).as_bytes());
        let mut release = json!({
            "schema": "simforge.map-release.v1",
            "name": MAP,
            "version": "v1",
            "visibility": "private",
            "createdAt": "2026-09-19T05:36:57.832Z",
            "canonical": { "key": closure_key, "digest": closure_digest },
        });
        if let Some(web) = &self.web {
            let key = format!("maps/{MAP}/v1/derived/web-abc.json");
            write_json(&self.root.join(&key), web);
            release["web"] =
                json!({ "key": key, "digest": sha256_hex(canonical_json(web).as_bytes()) });
        }
        write_json(
            &self.root.join(format!("maps/{MAP}/v1/release.json")),
            &release,
        );
        let release_digest = sha256_hex(canonical_json(&release).as_bytes());
        write_json(
            &self.root.join(format!("maps/{MAP}/versions.json")),
            &json!([{ "version": "v1", "closureDigest": closure_digest, "releaseDigest": release_digest, "createdAt": "2026-09-19T05:36:57.832Z" }]),
        );
        write_json(
            &self.root.join("index.json"),
            &json!({ MAP: { "latest": "v1", "versions": ["v1"], "summary": { "label": MAP } } }),
        );
        self.release = release;
    }

    fn url(&self) -> String {
        format!("file://{}", self.root.display())
    }
}

fn simforge() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
    for var in [
        "SIMFORGE_MAPS_REGISTRY",
        "SIMFORGE_MAPS_PUBLIC_URL",
        "SIMFORGE_MAPS_CACHE_ROOT",
        "SIMFORGE_MAPS_REGISTRY_TOKEN",
        "SIMFORGE_TOKEN",
        "SIMFORGE_HOST",
        "SIMFORGE_CONFIG_DIR",
        "XDG_DATA_HOME",
    ] {
        cmd.env_remove(var);
    }
    cmd
}

fn pull(registry: &str, spec: &str, cache: &Path, env: &[(&str, &str)]) -> (i32, Value, Value) {
    let mut cmd = simforge();
    cmd.args(["maps", "pull", spec, "--registry", registry, "--cache-root"])
        .arg(cache);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();
    let doc = if stdout.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&stdout).unwrap()
    };
    let err = stderr
        .lines()
        .last()
        .map(|l| serde_json::from_str(l).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    (out.status.code().unwrap(), doc, err)
}

/// Every installed profile directory and every leftover staging directory.
fn installed(cache: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for layout in ["dev-assets", ".corpus", "map-bundles"] {
        let Ok(entries) = std::fs::read_dir(cache.join(layout)) else {
            continue;
        };
        for entry in entries {
            out.push(format!(
                "{layout}/{}",
                entry.unwrap().file_name().to_string_lossy()
            ));
        }
    }
    out.sort();
    out
}

fn tree(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, out);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(dir, dir, &mut out);
    out
}

fn expected_receipt(fixture: &Fixture, profile: &str, files: &BTreeMap<&str, Vec<u8>>) -> String {
    let closure_digest = sha256_hex(canonical_json(&fixture.closure).as_bytes());
    let mut receipt = json!({
        "schema": "simforge.map-installation.v1",
        "name": MAP,
        "version": "v1",
        "releaseDigest": sha256_hex(canonical_json(&fixture.release).as_bytes()),
        "canonicalDigest": closure_digest,
        "profile": profile,
        "members": members(files),
    });
    if let Some(web) = &fixture.release.get("web") {
        receipt["webDigest"] = web["digest"].clone();
    }
    format!("{}\n", canonical_json(&receipt))
}

fn check_install(fixture: &Fixture, cache: &Path) {
    let all = canonical_files();
    let semantic: BTreeMap<_, _> = all
        .iter()
        .filter(|(p, _)| **p != "master.gltf" && **p != "geometry.bin" && !p.starts_with("images/"))
        .map(|(p, b)| (*p, b.clone()))
        .collect();
    let native: BTreeMap<_, _> = all
        .iter()
        .filter(|(p, _)| **p != "images/road.png")
        .map(|(p, b)| (*p, b.clone()))
        .collect();
    for (dir, profile, files) in [
        ("dev-assets", "semantic", &semantic),
        (".corpus", "native", &native),
    ] {
        let got = tree(&cache.join(dir).join(MAP));
        let mut want: BTreeMap<String, Vec<u8>> = files
            .iter()
            .map(|(p, b)| (p.to_string(), b.clone()))
            .collect();
        want.insert(
            ".map-release.json".into(),
            expected_receipt(fixture, profile, files).into_bytes(),
        );
        assert_eq!(
            got.keys().collect::<Vec<_>>(),
            want.keys().collect::<Vec<_>>(),
            "{dir}"
        );
        assert_eq!(got, want, "{dir}");
    }
    if fixture.web.is_some() {
        let mut web = semantic.clone();
        web.extend(web_files());
        let got = tree(&cache.join("map-bundles").join(MAP));
        let mut want: BTreeMap<String, Vec<u8>> = web
            .iter()
            .map(|(p, b)| (p.to_string(), b.clone()))
            .collect();
        want.insert(
            ".map-release.json".into(),
            expected_receipt(fixture, "web", &web).into_bytes(),
        );
        assert_eq!(got, want, "map-bundles");
    }
    // Hardlinked from the content-addressed cache.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let bytes = &all["geometry.bin"];
        let digest = sha256_hex(bytes);
        let cached = cache.join(format!(".blobs/sha256/{}/{digest}", &digest[..2]));
        let installed = cache.join(".corpus").join(MAP).join("geometry.bin");
        assert_eq!(
            std::fs::metadata(cached).unwrap().ino(),
            std::fs::metadata(installed).unwrap().ino()
        );
    }
}

#[test]
fn pulls_over_file_url_and_reuses_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&dir.path().join("registry"), true);
    let cache = dir.path().join("cache");

    let (code, doc, err) = pull(&fixture.url(), MAP, &cache, &[]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(doc["name"], MAP);
    assert_eq!(doc["version"], "v1", "a bare name resolves latest");
    assert_eq!(doc["registry"]["source"], "flag:--registry");
    assert_eq!(doc["registry"]["auth"], "none");
    assert_eq!(doc["registry"]["authenticated"], false);
    assert_eq!(doc["cacheRootSource"], "flag:--cache-root");
    let distinct = doc["blobs"]["distinct"].as_u64().unwrap();
    assert_eq!(doc["blobs"]["downloaded"].as_u64().unwrap(), distinct);
    assert_eq!(doc["blobs"]["reused"], 0);
    assert_eq!(doc["closure"]["members"], canonical_files().len());
    assert!(doc["materialized"]["web"].is_string());
    check_install(&fixture, &cache);
    assert_eq!(
        installed(&cache),
        vec![
            format!(".corpus/{MAP}"),
            format!("dev-assets/{MAP}"),
            format!("map-bundles/{MAP}")
        ]
    );

    let (code, doc, err) = pull(&fixture.url(), &format!("{MAP}@v1"), &cache, &[]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(doc["blobs"]["downloaded"], 0);
    assert_eq!(doc["blobs"]["reused"].as_u64().unwrap(), distinct);
    check_install(&fixture, &cache);

    // A corrupt cache entry is re-downloaded, never trusted.
    let bytes = &canonical_files()["map.xodr"];
    let digest = sha256_hex(bytes);
    let cached = cache.join(format!(".blobs/sha256/{}/{digest}", &digest[..2]));
    std::fs::remove_file(&cached).unwrap();
    std::fs::write(&cached, b"<Corrupt/>  ").unwrap();
    let (code, doc, _) = pull(&fixture.url(), MAP, &cache, &[]);
    assert_eq!(code, 0);
    assert_eq!(doc["blobs"]["downloaded"], 1);
    check_install(&fixture, &cache);
}

#[test]
fn archive_installs_source_rasters_and_a_release_without_web_installs_two_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&dir.path().join("registry"), false);
    let cache = dir.path().join("cache");
    let out = simforge()
        .args([
            "maps",
            "pull",
            MAP,
            "--archive",
            "--registry",
            &fixture.url(),
            "--cache-root",
        ])
        .arg(&cache)
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let dev = tree(&cache.join("dev-assets").join(MAP));
    assert!(dev.contains_key("images/road.png") && dev.contains_key("master.gltf"));
    assert_eq!(
        installed(&cache),
        vec![format!(".corpus/{MAP}"), format!("dev-assets/{MAP}")]
    );
}

/// A threaded static file server over `root` that records Authorization headers.
fn serve(root: PathBuf) -> (String, Arc<Mutex<Vec<Option<String>>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let auth = Arc::new(Mutex::new(Vec::new()));
    let seen = auth.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let root = root.clone();
            let seen = seen.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let mut authorization = None;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap() == 0 || header.trim().is_empty() {
                        break;
                    }
                    if let Some((k, v)) = header.split_once(':') {
                        if k.eq_ignore_ascii_case("authorization") {
                            authorization = Some(v.trim().to_owned());
                        }
                    }
                }
                seen.lock().unwrap().push(authorization);
                let file = root.join(path.trim_start_matches('/'));
                match std::fs::read(&file) {
                    Ok(body) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(&body);
                    }
                    Err(_) => {
                        let _ = write!(stream, "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                    }
                }
                let mut rest = Vec::new();
                let _ = reader.read_to_end(&mut rest);
            });
        }
    });
    (format!("http://{addr}"), auth)
}

#[test]
fn pulls_over_http_with_a_bearer_token_that_is_never_printed() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&dir.path().join("registry"), true);
    let (url, auth) = serve(fixture.root.clone());
    let cache = dir.path().join("cache");
    let out = simforge()
        .args([
            "maps",
            "pull",
            &format!("{MAP}@v1"),
            "--registry",
            &url,
            "--cache-root",
        ])
        .arg(&cache)
        .env("SIMFORGE_MAPS_REGISTRY_TOKEN", "sekrit-token-123")
        .output()
        .unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert_eq!(out.status.code(), Some(0), "{stderr}");
    assert!(!stdout.contains("sekrit") && !stderr.contains("sekrit"));
    let doc: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(
        doc["registry"]["auth"],
        "bearer (env:SIMFORGE_MAPS_REGISTRY_TOKEN)"
    );
    assert_eq!(doc["registry"]["authenticated"], true);
    let seen = auth.lock().unwrap();
    assert!(!seen.is_empty());
    assert!(seen
        .iter()
        .all(|a| a.as_deref() == Some("Bearer sekrit-token-123")));
    drop(seen);
    check_install(&fixture, &cache);
}

fn assert_refused(fixture: &Fixture, cache: &Path, code: &str) {
    let (exit, doc, err) = pull(&fixture.url(), MAP, cache, &[]);
    assert_eq!(exit, 2, "{err}");
    assert_eq!(doc, Value::Null, "nothing on stdout");
    assert_eq!(err["code"], code, "{err}");
    assert_eq!(installed(cache), Vec::<String>::new(), "nothing installed");
}

#[test]
fn a_tampered_blob_is_refused_and_nothing_is_installed() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&dir.path().join("registry"), true);
    let bytes = canonical_files()["geometry.bin"].clone();
    let mut evil = bytes.clone();
    evil[100] ^= 0xff;
    std::fs::write(fixture.blob_path(&bytes), &evil).unwrap();
    assert_refused(
        &fixture,
        &dir.path().join("cache"),
        "blob_verification_failed",
    );
}

#[test]
fn a_blob_of_the_wrong_size_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&dir.path().join("registry"), false);
    let bytes = canonical_files()["map.xodr"].clone();
    let mut longer = bytes.clone();
    longer.push(b'\n');
    std::fs::write(fixture.blob_path(&bytes), &longer).unwrap();
    let cache = dir.path().join("cache");
    assert_refused(&fixture, &cache, "blob_verification_failed");
    let (_, _, err) = pull(&fixture.url(), MAP, &cache, &[]);
    assert_eq!(err["path"], "map.xodr");
    assert_eq!(err["detail"]["actual"]["oversize"], true);
}

#[test]
fn a_closure_that_does_not_match_its_release_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&dir.path().join("registry"), false);
    let mut closure = fixture.closure.clone();
    closure["members"]["extra.txt"] = json!({ "sha256": sha256_hex(b"x"), "bytes": 1 });
    write_json(
        &fixture.root.join(format!("maps/{MAP}/v1/closure.json")),
        &closure,
    );
    assert_refused(
        &fixture,
        &dir.path().join("cache"),
        "closure_digest_mismatch",
    );
}

#[test]
fn a_release_that_does_not_match_its_record_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&dir.path().join("registry"), false);
    let mut release = fixture.release.clone();
    release["createdAt"] = json!("2026-09-20T00:00:00.000Z");
    write_json(
        &fixture.root.join(format!("maps/{MAP}/v1/release.json")),
        &release,
    );
    assert_refused(
        &fixture,
        &dir.path().join("cache"),
        "release_digest_mismatch",
    );
}

#[test]
fn an_unsafe_member_path_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = Fixture::new(&dir.path().join("registry"), false);
    fixture.closure["members"]["../escape.txt"] = json!({ "sha256": sha256_hex(b"x"), "bytes": 1 });
    fixture.put_blob(b"x");
    fixture.publish();
    assert_refused(&fixture, &dir.path().join("cache"), "unsafe_member_path");
    assert!(!dir.path().join("escape.txt").exists());
}

#[test]
fn a_public_release_of_a_private_map_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&dir.path().join("registry"), false);
    let mut release = fixture.release.clone();
    release["visibility"] = json!("public");
    write_json(
        &fixture.root.join(format!("maps/{MAP}/v1/release.json")),
        &release,
    );
    assert_refused(&fixture, &dir.path().join("cache"), "release_invalid");
}

#[test]
fn unknown_maps_and_versions_are_command_errors() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&dir.path().join("registry"), false);
    let cache = dir.path().join("cache");
    let (exit, _, err) = pull(&fixture.url(), "no-such-map", &cache, &[]);
    assert_eq!(
        (exit, err["code"].as_str()),
        (1, Some("unknown_map")),
        "{err}"
    );
    assert_eq!(err["detail"]["known"], json!([MAP]));
    let (exit, _, err) = pull(&fixture.url(), &format!("{MAP}@v9"), &cache, &[]);
    assert_eq!(
        (exit, err["code"].as_str()),
        (1, Some("unknown_version")),
        "{err}"
    );
    let (exit, _, err) = pull(&fixture.url(), "Bad_Name", &cache, &[]);
    assert_eq!(
        (exit, err["code"].as_str()),
        (1, Some("bad_value")),
        "{err}"
    );
    let (exit, _, err) = pull("s3://bucket/registry", MAP, &cache, &[]);
    assert_eq!(
        (exit, err["code"].as_str()),
        (1, Some("bad_value")),
        "{err}"
    );
    // Nothing answers: a network failure is exit 1.
    let (exit, _, err) = pull("http://127.0.0.1:9", MAP, &cache, &[]);
    assert_eq!(
        (exit, err["code"].as_str()),
        (1, Some("registry_unreachable")),
        "{err}"
    );
    assert_eq!(installed(&cache), Vec::<String>::new());
}
