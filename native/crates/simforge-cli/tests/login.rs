//! `simforge login` / `logout` / `auth status` / `whoami`, and `maps list/pull`
//! with the logged-in account's registry, against a fake SimForge host: RFC
//! 8414 metadata, the loopback authorization-code grant with PKCE, the device
//! grant with `slow_down`, rotating refresh tokens with reuse detection,
//! revocation, userinfo, and an authenticated map registry whose blobs
//! redirect to a separate "object store" path.
//!
//! Every run is hermetic: its own config directory, the file credential
//! store (never the machine's keychain), and no inherited host or token.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAP: &str = "test-town";

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn canonical(value: &Value) -> String {
    simforge_core::hash::canonical_json(value).unwrap()
}

// ------------------------------------------------------------------ the fake host

#[derive(Default)]
struct HostState {
    /// code -> (challenge, redirect_uri)
    codes: HashMap<String, (String, String)>,
    /// session id -> revoked
    sessions: HashMap<String, bool>,
    /// access token -> (session, valid)
    access: HashMap<String, (String, bool)>,
    /// refresh token -> (session, spent)
    refresh: HashMap<String, (String, bool)>,
    access_ttl: u64,
    next: u32,
    device_polls: u32,
    device_approve_after: u32,
    device_slow_down_once: bool,
    device_denied: bool,
    refreshes: u32,
    revocations: u32,
    reuse_detected: u32,
    registry_requests: u32,
    /// Authorization headers seen on the redirected blob downloads.
    direct_auth: Vec<Option<String>>,
    /// Authorization headers seen on the registry.
    registry_auth: Vec<Option<String>>,
    /// device_name the CLI announced.
    device_names: Vec<String>,
}

struct FakeHost {
    origin: String,
    name: String,
    state: Arc<Mutex<HostState>>,
}

fn form_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                out.push(u8::from_str_radix(&value[i + 1..i + 3], 16).unwrap());
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8(out).unwrap()
}

fn parse_form(body: &str) -> HashMap<String, String> {
    body.split('&')
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (form_decode(k), form_decode(v)))
        .collect()
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let target = parts.next()?.to_owned();
    let mut authorization = None;
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 || header.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = header.split_once(':') {
            if k.eq_ignore_ascii_case("authorization") {
                authorization = Some(v.trim().to_owned());
            }
            if k.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    let path = target.split_once('?').map_or(target.as_str(), |(p, _)| p);
    Some(Request {
        method,
        path: path.to_owned(),
        authorization,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

fn reply(stream: &mut TcpStream, status: &str, headers: &[(&str, String)], body: &[u8]) {
    let mut head = format!(
        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n",
        body.len()
    );
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

fn json_reply(stream: &mut TcpStream, status: &str, value: Value) {
    reply(
        stream,
        status,
        &[("content-type", "application/json".into())],
        value.to_string().as_bytes(),
    );
}

impl FakeHost {
    fn start(registry_root: PathBuf) -> FakeHost {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let origin = format!("http://{addr}");
        let state = Arc::new(Mutex::new(HostState {
            access_ttl: 3600,
            device_approve_after: 2,
            ..HostState::default()
        }));
        let shared = state.clone();
        let base = origin.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let state = shared.clone();
                let origin = base.clone();
                let root = registry_root.clone();
                std::thread::spawn(move || {
                    if let Some(request) = read_request(&mut stream) {
                        handle(&mut stream, request, &state, &origin, &root);
                    }
                });
            }
        });
        FakeHost {
            name: addr.to_string(),
            origin,
            state,
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, HostState> {
        self.state.lock().unwrap()
    }

    /// The account page's "Revoke": every token of every session stops working.
    fn revoke_all_sessions(&self) {
        let mut state = self.state();
        for revoked in state.sessions.values_mut() {
            *revoked = true;
        }
    }
}

fn issue(state: &mut HostState, session: &str) -> Value {
    state.next += 1;
    let access = format!("sfc_at_test{}", state.next);
    let refresh = format!("sfc_rt_test{}", state.next);
    state
        .access
        .insert(access.clone(), (session.to_owned(), true));
    state
        .refresh
        .insert(refresh.clone(), (session.to_owned(), false));
    json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": state.access_ttl,
        "refresh_token": refresh,
        "refresh_expires_in": 2_592_000,
        "scope": "maps:read",
        "session_id": session,
        "account": { "id": "user-1", "email": "qa@example.test", "name": "QA" },
        "organization": { "id": "org-1", "name": "QA Org", "workspace_id": "ws-1" },
    })
}

fn new_session(state: &mut HostState) -> String {
    state.next += 1;
    let session = format!("cls_{}", state.next);
    state.sessions.insert(session.clone(), false);
    session
}

fn bearer_session(state: &HostState, authorization: &Option<String>) -> Option<String> {
    let token = authorization.as_deref()?.strip_prefix("Bearer ")?;
    let (session, valid) = state.access.get(token)?;
    (*valid && !state.sessions.get(session).copied().unwrap_or(true)).then(|| session.clone())
}

fn oauth_error(stream: &mut TcpStream, error: &str) {
    json_reply(
        stream,
        "400 Bad Request",
        json!({ "error": error, "error_description": error }),
    );
}

fn handle(
    stream: &mut TcpStream,
    request: Request,
    state: &Mutex<HostState>,
    origin: &str,
    root: &Path,
) {
    let path = request.path.as_str();
    if path == "/.well-known/oauth-authorization-server" {
        return json_reply(
            stream,
            "200 OK",
            json!({
                "issuer": origin,
                "authorization_endpoint": format!("{origin}/cli/authorize"),
                "token_endpoint": format!("{origin}/api/cli/token"),
                "device_authorization_endpoint": format!("{origin}/api/cli/device/code"),
                "revocation_endpoint": format!("{origin}/api/cli/revoke"),
                "userinfo_endpoint": format!("{origin}/api/cli/userinfo"),
                "scopes_supported": ["maps:read"],
                "response_types_supported": ["code"],
                "code_challenge_methods_supported": ["S256"],
                "simforge_maps_registry": format!("{origin}/api/cli/registry"),
                "simforge_cli_sessions_page": format!("{origin}/dashboard/account#cli-sessions"),
            }),
        );
    }
    let mut state = state.lock().unwrap();
    match (request.method.as_str(), path) {
        ("POST", "/api/cli/device/code") => {
            let form = parse_form(&request.body);
            state
                .device_names
                .push(form.get("device_name").cloned().unwrap_or_default());
            json_reply(
                stream,
                "200 OK",
                json!({
                    "device_code": "sfc_dc_test",
                    "user_code": "BCDF-GHJK",
                    "verification_uri": format!("{origin}/cli/device"),
                    "verification_uri_complete": format!("{origin}/cli/device?user_code=BCDF-GHJK"),
                    "expires_in": 60,
                    "interval": 1,
                }),
            )
        }
        ("POST", "/api/cli/token") => {
            let form = parse_form(&request.body);
            assert_eq!(
                form.get("client_id").map(String::as_str),
                Some("simforge-cli")
            );
            match form.get("grant_type").map(String::as_str) {
                Some("authorization_code") => {
                    let code = form.get("code").cloned().unwrap_or_default();
                    let Some((challenge, redirect)) = state.codes.remove(&code) else {
                        return oauth_error(stream, "invalid_grant");
                    };
                    let verifier = form.get("code_verifier").cloned().unwrap_or_default();
                    let computed = base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .encode(Sha256::digest(verifier.as_bytes()));
                    if computed != challenge || form.get("redirect_uri") != Some(&redirect) {
                        return oauth_error(stream, "invalid_grant");
                    }
                    let session = new_session(&mut state);
                    let body = issue(&mut state, &session);
                    json_reply(stream, "200 OK", body)
                }
                Some("urn:ietf:params:oauth:grant-type:device_code") => {
                    state.device_polls += 1;
                    if state.device_slow_down_once {
                        state.device_slow_down_once = false;
                        return oauth_error(stream, "slow_down");
                    }
                    if state.device_denied {
                        return oauth_error(stream, "access_denied");
                    }
                    if state.device_polls <= state.device_approve_after {
                        return oauth_error(stream, "authorization_pending");
                    }
                    let session = new_session(&mut state);
                    let body = issue(&mut state, &session);
                    json_reply(stream, "200 OK", body)
                }
                Some("refresh_token") => {
                    state.refreshes += 1;
                    let token = form.get("refresh_token").cloned().unwrap_or_default();
                    let Some((session, spent)) = state.refresh.get(&token).cloned() else {
                        return oauth_error(stream, "invalid_grant");
                    };
                    if spent {
                        state.reuse_detected += 1;
                        state.sessions.insert(session, true);
                        return oauth_error(stream, "invalid_grant");
                    }
                    if state.sessions.get(&session).copied().unwrap_or(true) {
                        return oauth_error(stream, "invalid_grant");
                    }
                    state.refresh.insert(token, (session.clone(), true));
                    let body = issue(&mut state, &session);
                    json_reply(stream, "200 OK", body)
                }
                _ => oauth_error(stream, "unsupported_grant_type"),
            }
        }
        ("POST", "/api/cli/revoke") => {
            let form = parse_form(&request.body);
            let token = form.get("token").cloned().unwrap_or_default();
            let session = state
                .refresh
                .get(&token)
                .map(|(s, _)| s.clone())
                .or_else(|| state.access.get(&token).map(|(s, _)| s.clone()));
            if let Some(session) = session {
                state.sessions.insert(session, true);
                state.revocations += 1;
            }
            json_reply(stream, "200 OK", json!({}))
        }
        ("GET", "/api/cli/userinfo") => match bearer_session(&state, &request.authorization) {
            Some(session) => json_reply(
                stream,
                "200 OK",
                json!({
                    "account": { "id": "user-1", "email": "qa@example.test", "name": "QA" },
                    "organization": { "id": "org-1", "name": "QA Org", "workspace_id": "ws-1" },
                    "scopes": ["maps:read"],
                    "session": { "id": session, "device_name": "test-box", "created_at": "2026-09-25T00:00:00Z" },
                    "access_token_expires_at": "2026-09-25T01:00:00Z",
                }),
            ),
            None => json_reply(
                stream,
                "401 Unauthorized",
                json!({ "error": "invalid_token" }),
            ),
        },
        (_, p) if p.starts_with("/api/cli/registry/") => {
            state.registry_requests += 1;
            state.registry_auth.push(request.authorization.clone());
            if bearer_session(&state, &request.authorization).is_none() {
                return json_reply(
                    stream,
                    "401 Unauthorized",
                    json!({ "error": "invalid_token" }),
                );
            }
            let key = p.trim_start_matches("/api/cli/registry/");
            if key.starts_with("blobs/") {
                return reply(
                    stream,
                    "302 Found",
                    &[("location", format!("{origin}/direct/{key}"))],
                    b"",
                );
            }
            match std::fs::read(root.join(key)) {
                Ok(bytes) => reply(
                    stream,
                    "200 OK",
                    &[("content-type", "application/json".into())],
                    &bytes,
                ),
                Err(_) => json_reply(stream, "404 Not Found", json!({ "error": "not_found" })),
            }
        }
        ("GET", p) if p.starts_with("/direct/") => {
            state.direct_auth.push(request.authorization.clone());
            match std::fs::read(root.join(p.trim_start_matches("/direct/"))) {
                Ok(bytes) => reply(stream, "200 OK", &[], &bytes),
                Err(_) => reply(stream, "404 Not Found", &[], b""),
            }
        }
        _ => json_reply(stream, "404 Not Found", json!({ "error": "not_found" })),
    }
}

// ------------------------------------------------------------------ the registry fixture

fn write(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

/// One private map release (`test-town@v1`) with two blobs.
fn registry_fixture(root: &Path) {
    let files: [(&str, &[u8]); 2] = [
        ("master.gltf", b"{\"asset\":{\"version\":\"2.0\"}}"),
        ("geometry.bin", b"\x00\x01\x02\x03geometry"),
    ];
    let mut members = serde_json::Map::new();
    for (path, bytes) in files {
        let digest = sha256_hex(bytes);
        write(
            &root.join(format!("blobs/sha256/{}/{digest}", &digest[..2])),
            bytes,
        );
        members.insert(
            path.into(),
            json!({ "sha256": digest, "bytes": bytes.len() }),
        );
    }
    let closure = json!({ "schema": "map-closure.v1", "kind": "canonical", "metadata": { "master": true }, "members": members });
    let key = format!("maps/{MAP}/v1/closure.json");
    write(&root.join(&key), canonical(&closure).as_bytes());
    let release = json!({
        "schema": "simforge.map-release.v1", "name": MAP, "version": "v1", "visibility": "private",
        "createdAt": "2026-09-19T05:36:57.832Z",
        "canonical": { "key": key, "digest": sha256_hex(canonical(&closure).as_bytes()) },
    });
    write(
        &root.join(format!("maps/{MAP}/v1/release.json")),
        canonical(&release).as_bytes(),
    );
    write(
        &root.join(format!("maps/{MAP}/versions.json")),
        json!([{ "version": "v1", "closureDigest": sha256_hex(canonical(&closure).as_bytes()), "releaseDigest": sha256_hex(canonical(&release).as_bytes()), "createdAt": "2026-09-19T05:36:57.832Z" }]).to_string().as_bytes(),
    );
    write(
        &root.join("index.json"),
        json!({ MAP: { "latest": "v1", "versions": ["v1"], "summary": { "label": "Test Town" } } })
            .to_string()
            .as_bytes(),
    );
}

// ------------------------------------------------------------------ the CLI

struct Env {
    dir: tempfile::TempDir,
    host: FakeHost,
}

impl Env {
    fn new() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        registry_fixture(&root);
        let host = FakeHost::start(root);
        Env { dir, host }
    }

    fn config(&self) -> PathBuf {
        self.dir.path().join("config")
    }

    fn cache(&self) -> PathBuf {
        self.dir.path().join("cache")
    }

    fn cmd(&self) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
        for var in [
            "SIMFORGE_MAPS_REGISTRY",
            "SIMFORGE_MAPS_PUBLIC_URL",
            "SIMFORGE_MAPS_REGISTRY_TOKEN",
            "SIMFORGE_MAPS_CACHE_ROOT",
            "SIMFORGE_TOKEN",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "BROWSER",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "SSH_CONNECTION",
            "SSH_CLIENT",
            "SSH_TTY",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            cmd.env_remove(var);
        }
        cmd.env("HOME", self.dir.path())
            .env("SIMFORGE_CONFIG_DIR", self.config())
            .env("SIMFORGE_CREDENTIAL_STORE", "file")
            .env("SIMFORGE_HOST", &self.host.origin);
        cmd
    }

    fn run(&self, args: &[&str]) -> (i32, Value, String) {
        let out = self.cmd().args(args).output().unwrap();
        parse(out)
    }

    /// `simforge login` through a "browser" that the test drives: the BROWSER
    /// command records the URL; `approve` decides what the loopback receives.
    fn browser_login(
        &self,
        approve: impl FnOnce(&FakeHost, &HashMap<String, String>),
    ) -> (i32, Value, String) {
        let url_file = self.dir.path().join("browser-url");
        let _ = std::fs::remove_file(&url_file);
        let script = self.dir.path().join("browser.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\nprintf '%s' \"$1\" > '{}'\n", url_file.display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let child: Child = self
            .cmd()
            .args(["login", "--timeout", "30", "--device-name", "test-box"])
            .env("BROWSER", &script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let url = loop {
            if let Ok(url) = std::fs::read_to_string(&url_file) {
                if !url.is_empty() {
                    break url;
                }
            }
            assert!(
                Instant::now() < deadline,
                "the CLI never opened the browser"
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        let (base, query) = url.split_once('?').unwrap();
        assert_eq!(base, format!("{}/cli/authorize", self.host.origin));
        approve(&self.host, &parse_form(query));
        parse(child.wait_with_output().unwrap())
    }
}

fn parse(out: Output) -> (i32, Value, String) {
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();
    for text in [&stdout, &stderr] {
        assert!(
            !text.contains("sfc_at_") && !text.contains("sfc_rt_"),
            "a token was printed: {text}"
        );
    }
    let doc = if stdout.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&stdout).unwrap()
    };
    (out.status.code().unwrap(), doc, stderr)
}

fn stderr_error(stderr: &str) -> Value {
    serde_json::from_str(stderr.lines().last().expect("an error line")).unwrap()
}

fn events(stderr: &str) -> Vec<Value> {
    stderr
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("event").is_some())
        .collect()
}

/// GET `url` on the loopback (what the browser does after approval).
fn visit(url: &str) -> u16 {
    let rest = url.strip_prefix("http://").unwrap();
    let (authority, path) = rest.split_once('/').unwrap();
    let mut stream = TcpStream::connect(authority).unwrap();
    write!(
        stream,
        "GET /{path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.split_whitespace().nth(1).unwrap().parse().unwrap()
}

/// Approve: the host mints a code bound to the request's challenge and
/// redirect, and the browser lands on the loopback with it.
fn approve(host: &FakeHost, query: &HashMap<String, String>) {
    assert_eq!(query["client_id"], "simforge-cli");
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["scope"], "maps:read");
    assert_eq!(query["device_name"], "test-box");
    let redirect = query["redirect_uri"].clone();
    assert!(
        redirect.starts_with("http://127.0.0.1:") && redirect.ends_with("/callback"),
        "{redirect}"
    );
    host.state().codes.insert(
        "sfc_ac_test".into(),
        (query["code_challenge"].clone(), redirect.clone()),
    );
    assert_eq!(
        visit(&format!(
            "{redirect}?code=sfc_ac_test&state={}",
            encode(&query["state"])
        )),
        200
    );
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        out.push(path.clone());
        if path.is_dir() {
            out.extend(walk(&path));
        }
    }
    out
}

// ------------------------------------------------------------------ tests

#[test]
fn browser_login_keeps_tokens_in_a_0600_file_and_never_prints_them() {
    let env = Env::new();
    let (code, doc, stderr) = env.browser_login(|host, query| {
        // A request without the CLI's state is ignored, not accepted and not fatal.
        let redirect = &query["redirect_uri"];
        assert_eq!(
            visit(&format!("{redirect}?code=sfc_ac_forged&state=forged-state")),
            400
        );
        approve(host, query);
    });
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(doc["method"], "browser");
    assert_eq!(doc["host"], env.host.name);
    assert_eq!(doc["account"]["email"], "qa@example.test");
    assert_eq!(doc["organization"]["name"], "QA Org");
    assert_eq!(doc["scopes"], json!(["maps:read"]));
    assert_eq!(doc["credentialStore"]["kind"], "file");
    assert_eq!(
        doc["credentialStore"]["choiceSource"],
        "env:SIMFORGE_CREDENTIAL_STORE"
    );
    assert_eq!(doc["flow"]["browser"]["opened"], true);
    assert!(events(&stderr)
        .iter()
        .any(|e| e["event"] == "login.browser"));

    let credentials = PathBuf::from(doc["credentialStore"]["path"].as_str().unwrap());
    assert!(credentials.starts_with(env.config()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&credentials)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(credentials.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    let hosts = std::fs::read_to_string(env.config().join("hosts.json")).unwrap();
    assert!(!hosts.contains("sfc_"), "hosts.json must hold no token");
    assert!(std::fs::read_to_string(&credentials)
        .unwrap()
        .contains("sfc_rt_"));
}

#[test]
fn a_denied_browser_login_fails_loudly_and_stores_nothing() {
    let env = Env::new();
    let (code, _, stderr) = env.browser_login(|_, query| {
        let redirect = &query["redirect_uri"];
        assert_eq!(
            visit(&format!(
                "{redirect}?error=access_denied&state={}",
                encode(&query["state"])
            )),
            200
        );
    });
    assert_eq!(code, 1);
    assert_eq!(stderr_error(&stderr)["code"], "login_denied");
    assert!(!env.config().join("hosts.json").exists());
}

#[test]
fn device_login_honours_slow_down_and_states_why_it_was_chosen() {
    let env = Env::new();
    env.host.state().device_slow_down_once = true;
    // An SSH session with no BROWSER: device sign-in, and it says so.
    let (code, doc, stderr) = env.run_with(
        &[("SSH_CONNECTION", "10.0.0.1 5000 10.0.0.2 22")],
        &["login", "--timeout", "60", "--device-name", "ssh-box"],
    );
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(doc["method"], "device");
    assert!(
        doc["methodReason"]
            .as_str()
            .unwrap()
            .contains("SSH_CONNECTION"),
        "{doc}"
    );
    assert_eq!(doc["flow"]["slowDowns"], 1);
    let events = events(&stderr);
    assert!(
        events.iter().any(|e| e["event"] == "login.method"),
        "{stderr}"
    );
    let prompt = events
        .iter()
        .find(|e| e["event"] == "login.device")
        .expect("device prompt");
    assert_eq!(prompt["userCode"], "BCDF-GHJK");
    assert_eq!(
        prompt["verificationUri"],
        format!("{}/cli/device", env.host.origin)
    );
    assert_eq!(env.host.state().device_names, vec!["ssh-box".to_owned()]);

    // --device is explicit; a denial is an error.
    let env = Env::new();
    env.host.state().device_denied = true;
    let (code, _, stderr) = env.run(&["login", "--device", "--timeout", "30"]);
    assert_eq!(code, 1);
    assert_eq!(stderr_error(&stderr)["code"], "login_denied");
}

impl Env {
    fn run_with(&self, vars: &[(&str, &str)], args: &[&str]) -> (i32, Value, String) {
        let mut cmd = self.cmd();
        for (k, v) in vars {
            cmd.env(k, v);
        }
        parse(cmd.args(args).output().unwrap())
    }

    fn device_login(&self) {
        let (code, _, stderr) = self.run(&["login", "--device", "--timeout", "30"]);
        assert_eq!(code, 0, "{stderr}");
    }
}

#[test]
fn status_and_whoami_refresh_with_rotation_and_report_the_store() {
    let env = Env::new();
    // Access tokens that are always "about to expire": every command refreshes.
    env.host.state().access_ttl = 30;
    env.device_login();
    for command in [&["auth", "status"][..], &["whoami"], &["auth", "status"]] {
        let (code, doc, stderr) = env.run(command);
        assert_eq!(code, 0, "{command:?}: {stderr}");
        assert_eq!(doc["verified"], true);
        assert_eq!(doc["account"]["email"], "qa@example.test");
        assert_eq!(doc["organization"]["name"], "QA Org");
        assert_eq!(doc["scopes"], json!(["maps:read"]));
        assert_eq!(doc["host"], env.host.name);
        assert_eq!(doc["credentialStore"]["kind"], "file");
        assert_eq!(doc["credentialSource"], "file");
        assert!(doc["accessTokenExpiresAt"].is_string());
    }
    let state = env.host.state();
    assert_eq!(state.refreshes, 3, "one rotation per command");
    assert_eq!(
        state.reuse_detected, 0,
        "a spent refresh token was presented again"
    );
}

#[test]
fn logged_in_maps_list_and_pull_use_the_account_registry() {
    let env = Env::new();
    env.device_login();
    let (code, doc, stderr) = env.run(&["maps", "list"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(doc["registry"]["authenticated"], true);
    assert_eq!(
        doc["registry"]["url"],
        format!("{}/api/cli/registry", env.host.origin)
    );
    assert_eq!(
        doc["registry"]["source"],
        format!("account:{}", env.host.name)
    );
    assert_eq!(doc["registry"]["account"], "qa@example.test");
    assert_eq!(doc["maps"][0]["name"], MAP);
    assert_eq!(doc["maps"][0]["versions"][0]["version"], "v1");

    let cache = env.cache();
    let (code, doc, stderr) = env.run(&[
        "maps",
        "pull",
        &format!("{MAP}@v1"),
        "--cache-root",
        cache.to_str().unwrap(),
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(doc["registry"]["authenticated"], true);
    assert_eq!(doc["blobs"]["downloaded"], 2);
    let state = env.host.state();
    assert!(state.registry_auth.iter().all(|a| a
        .as_deref()
        .is_some_and(|a| a.starts_with("Bearer sfc_at_"))));
    // The bearer never follows the redirect to the object store.
    assert_eq!(state.direct_auth.len(), 2);
    assert!(
        state.direct_auth.iter().all(Option::is_none),
        "{:?}",
        state.direct_auth
    );
}

#[test]
fn an_expired_access_token_is_refreshed_once_mid_pull() {
    let env = Env::new();
    env.device_login();
    // The host stops accepting the current access token (expired early).
    for (_, valid) in env.host.state().access.values_mut() {
        *valid = false;
    }
    let cache = env.cache();
    let (code, doc, stderr) =
        env.run(&["maps", "pull", MAP, "--cache-root", cache.to_str().unwrap()]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(doc["version"], "v1");
    assert_eq!(env.host.state().refreshes, 1);
}

#[test]
fn a_revoked_session_is_refused_and_nothing_is_cached() {
    let env = Env::new();
    env.device_login();
    env.host.revoke_all_sessions();
    let cache = env.cache();
    let (code, doc, stderr) = env.run(&[
        "maps",
        "pull",
        &format!("{MAP}@v1"),
        "--cache-root",
        cache.to_str().unwrap(),
    ]);
    assert_eq!(code, 1, "{doc}");
    let error = stderr_error(&stderr);
    assert_eq!(error["code"], "unauthorized", "{error}");
    assert!(
        error["reason"].as_str().unwrap().contains("simforge login"),
        "{error}"
    );
    assert_eq!(
        walk(&cache),
        Vec::<PathBuf>::new(),
        "a refused pull must write nothing"
    );
    // status says so too.
    let (code, _, stderr) = env.run(&["auth", "status"]);
    assert_eq!(code, 1);
    assert_eq!(stderr_error(&stderr)["code"], "session_invalid");
}

#[test]
fn logout_revokes_on_the_host_and_forgets_the_tokens() {
    let env = Env::new();
    env.device_login();
    let credentials = env.config().join("credentials");
    assert!(walk(&credentials).iter().any(|p| p.is_file()));
    let (code, doc, stderr) = env.run(&["logout"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(doc["revoked"], true);
    assert_eq!(env.host.state().revocations, 1);
    assert!(!walk(&credentials).iter().any(|p| p.is_file()));
    let (code, _, stderr) = env.run(&["whoami"]);
    assert_eq!(code, 1);
    assert_eq!(stderr_error(&stderr)["code"], "not_logged_in");
    // Not logged in to a host named explicitly: an error, never the public registry.
    let (code, _, stderr) = env.run(&["maps", "list"]);
    assert_eq!(code, 1);
    assert_eq!(stderr_error(&stderr)["code"], "not_logged_in");
}

#[test]
fn simforge_token_overrides_the_stored_login() {
    let env = Env::new();
    let token = {
        let mut state = env.host.state();
        let session = new_session(&mut state);
        issue(&mut state, &session)["access_token"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (code, doc, stderr) = env.run_with(&[("SIMFORGE_TOKEN", &token)], &["auth", "status"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(doc["credentialSource"], "env:SIMFORGE_TOKEN");
    assert_eq!(doc["credentialStore"]["kind"], "env");
    let (code, doc, stderr) = env.run_with(&[("SIMFORGE_TOKEN", &token)], &["maps", "list"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(doc["registry"]["auth"], "account (env:SIMFORGE_TOKEN)");
    // login refuses while the override is set.
    let (code, _, stderr) = env.run_with(&[("SIMFORGE_TOKEN", &token)], &["login", "--device"]);
    assert_eq!(code, 1);
    assert_eq!(stderr_error(&stderr)["path"], "SIMFORGE_TOKEN");
}

#[test]
fn a_host_that_serves_no_metadata_is_named_in_the_error() {
    let env = Env::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten().take(2) {
            let _ = read_request(&mut stream);
            reply(&mut stream, "404 Not Found", &[], b"");
        }
    });
    let (code, _, stderr) = env.run(&["login", "--device", "--host", &format!("http://{addr}")]);
    assert_eq!(code, 1);
    assert_eq!(stderr_error(&stderr)["code"], "host_unsupported");
    // Plain http to a non-loopback host is refused before any request.
    let (code, _, stderr) = env.run(&["login", "--host", "http://example.com"]);
    assert_eq!(code, 1);
    assert_eq!(stderr_error(&stderr)["code"], "bad_value");
}
