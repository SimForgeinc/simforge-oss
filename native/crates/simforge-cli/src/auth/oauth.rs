//! The two sign-in grants and the token endpoint calls.
//!
//! - **Browser** (default): authorization code + PKCE S256 over a loopback
//!   redirect (RFC 8252 section 7.3): `http://127.0.0.1:<random port>/callback`,
//!   a random `state` checked on return, the code exchanged with its verifier.
//! - **Device** (`--device`, SSH, no display): the device authorization grant
//!   (RFC 8628): a URL and a short code the user approves from any browser,
//!   polled at the interval the host sets (`slow_down` adds 5 s).
//!
//! Progress goes to stderr as JSON lines with an `event` field (the prompt a
//! person or an agent must act on); stdout stays the one result document.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::host::{Host, Metadata, CLIENT_ID};
use super::http;
use crate::contract::CliError;

const TOKEN_TIMEOUT: Duration = Duration::from_secs(30);
const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// Consecutive failed polls (network) tolerated before the device login fails.
const MAX_POLL_TRANSPORT_ERRORS: u32 = 5;

/// What `login` tells the host about this machine (shown on the approval page
/// and in the account's CLI sessions; never authoritative for anything).
#[derive(Debug, Clone)]
pub struct Client {
    pub device_name: String,
    pub version: &'static str,
    pub platform: String,
}

impl Client {
    pub fn new(device_name: Option<String>) -> Self {
        Self {
            device_name: device_name
                .map(|n| n.trim().to_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(hostname),
            version: env!("CARGO_PKG_VERSION"),
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        }
    }
}

/// This machine's host name, or `unknown`.
pub fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: `buf` is valid for `buf.len()` bytes and gethostname
        // NUL-terminates within that length on success.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if rc == 0 {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            let name = String::from_utf8_lossy(&buf[..end]).trim().to_owned();
            if !name.is_empty() {
                return name;
            }
        }
    }
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

/// Write one progress event (a JSON line) to stderr.
pub fn event(value: Value) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{value}");
    let _ = err.flush();
}

fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the OS random source is available");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// A PKCE verifier (43 chars, 256 bits) and its S256 challenge.
pub fn pkce() -> (String, String) {
    let verifier = random_b64(32);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountInfo {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrganizationInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// A successful token response (RFC 6749 section 5.1 plus the session's identity).
#[derive(Clone, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
    pub refresh_token: String,
    pub refresh_expires_in: u64,
    pub scope: String,
    pub session_id: String,
    pub account: AccountInfo,
    pub organization: OrganizationInfo,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens")
            .field("session_id", &self.session_id)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

/// Why a token request did not yield tokens.
#[derive(Debug)]
pub enum TokenError {
    /// The host answered with an OAuth error (`invalid_grant`, `authorization_pending`, ...).
    OAuth {
        status: u16,
        error: String,
        description: Option<String>,
    },
    /// The request did not complete, or the answer was not a token response.
    Transport(String),
}

impl TokenError {
    pub fn into_cli(self, host: &Host, what: &str) -> CliError {
        match self {
            TokenError::OAuth {
                status,
                error,
                description,
            } => CliError::new(
                "auth_rejected",
                format!(
                    "{} refused the {what}: {error}{}",
                    host.name,
                    description.map(|d| format!(" ({d})")).unwrap_or_default()
                ),
            )
            .with_detail(json!({ "host": host.name, "status": status, "error": error })),
            TokenError::Transport(reason) => CliError::new(
                "host_unreachable",
                format!("the {what} with {} failed: {reason}", host.name),
            )
            .with_detail(json!({ "host": host.name })),
        }
    }
}

fn token_request(metadata: &Metadata, form: &[(&str, &str)]) -> Result<Tokens, TokenError> {
    let reply = http::post_form(&metadata.token_endpoint, form, TOKEN_TIMEOUT)
        .map_err(TokenError::Transport)?;
    let body = reply.json();
    if reply.status == 200 {
        let body =
            body.ok_or_else(|| TokenError::Transport("the token response is not JSON".into()))?;
        let tokens: Tokens = serde_json::from_value(body)
            .map_err(|e| TokenError::Transport(format!("the token response is incomplete: {e}")))?;
        if !tokens.token_type.eq_ignore_ascii_case("bearer") {
            return Err(TokenError::Transport(format!(
                "unsupported token type {:?}",
                tokens.token_type
            )));
        }
        return Ok(tokens);
    }
    match body
        .as_ref()
        .and_then(|b| b.get("error"))
        .and_then(Value::as_str)
    {
        Some(error) => Err(TokenError::OAuth {
            status: reply.status,
            error: error.to_owned(),
            description: body
                .as_ref()
                .and_then(|b| b.get("error_description"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        None => Err(TokenError::Transport(format!(
            "the token endpoint answered HTTP {}",
            reply.status
        ))),
    }
}

/// `grant_type=refresh_token`: a new access token and a new refresh token
/// (the presented one is spent).
pub fn refresh(metadata: &Metadata, refresh_token: &str) -> Result<Tokens, TokenError> {
    token_request(
        metadata,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CLIENT_ID),
        ],
    )
}

/// RFC 7009 revocation of `token` (the whole session behind it).
pub fn revoke(metadata: &Metadata, token: &str, hint: &str) -> Result<(), String> {
    let reply = http::post_form(
        &metadata.revocation_endpoint,
        &[
            ("token", token),
            ("token_type_hint", hint),
            ("client_id", CLIENT_ID),
        ],
        TOKEN_TIMEOUT,
    )?;
    if reply.status == 200 {
        Ok(())
    } else {
        Err(format!(
            "the revocation endpoint answered HTTP {}",
            reply.status
        ))
    }
}

/// What the host says about the session behind an access token.
pub enum UserInfo {
    Ok(Value),
    /// 401/403: the token is not (or no longer) accepted.
    Rejected {
        status: u16,
        error: Option<String>,
    },
}

pub fn userinfo(metadata: &Metadata, access_token: &str) -> Result<UserInfo, String> {
    let reply = http::get(
        &metadata.userinfo_endpoint,
        Some(access_token),
        TOKEN_TIMEOUT,
    )?;
    match reply.status {
        200 => reply
            .json()
            .map(UserInfo::Ok)
            .ok_or_else(|| "the userinfo response is not JSON".into()),
        401 | 403 => Ok(UserInfo::Rejected {
            status: reply.status,
            error: reply
                .json()
                .and_then(|b| b.get("error").and_then(Value::as_str).map(str::to_owned)),
        }),
        other => Err(format!("the userinfo endpoint answered HTTP {other}")),
    }
}

// ------------------------------------------------------------------ query strings

fn form_encode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| {
            format!(
                "{}={}",
                crate::net::encode_uri_component(k),
                crate::net::encode_uri_component(v)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn percent_decode(value: &str) -> String {
    let hex = |b: u8| char::from(b).to_digit(16);
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => match (
                bytes.get(i + 1).copied().and_then(hex),
                bytes.get(i + 2).copied().and_then(hex),
            ) {
                (Some(hi), Some(lo)) => {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
                _ => out.push(b'%'),
            },
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (percent_decode(k), percent_decode(v)),
            None => (percent_decode(pair), String::new()),
        })
        .collect()
}

// ------------------------------------------------------------------ browser grant

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>SimForge CLI</title>\
<body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem\">\
<h1 style=\"font-size:1.25rem\">{title}</h1><p>{body}</p></body>";

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn respond(stream: &mut TcpStream, status: &str, title: &str, body: &str) {
    let page = DONE_PAGE
        .replace("{title}", &html_escape(title))
        .replace("{body}", &html_escape(body));
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.flush();
}

/// The request target of one HTTP request on `stream` (`GET <target> HTTP/1.1`).
fn read_target(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf);
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    (parts.next()? == "GET").then_some(())?;
    parts.next().map(str::to_owned)
}

pub struct BrowserOutcome {
    pub tokens: Tokens,
    /// `opened by <launcher>`, or why it could not be opened.
    pub browser: Value,
}

/// The authorization-code grant with PKCE over a loopback redirect.
pub fn browser_grant(
    host: &Host,
    metadata: &Metadata,
    client: &Client,
    scopes: &str,
    timeout: Duration,
) -> Result<BrowserOutcome, CliError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| {
        CliError::new(
            "loopback_unavailable",
            format!("could not listen on 127.0.0.1 for the sign-in redirect: {e}"),
        )
        .with_detail(json!({ "hint": "use `simforge login --device`" }))
    })?;
    let port = listener.local_addr().map(|a| a.port()).map_err(|e| {
        CliError::new(
            "loopback_unavailable",
            format!("could not read the loopback port: {e}"),
        )
    })?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let (verifier, challenge) = pkce();
    let state = random_b64(32);
    let url = format!(
        "{}?{}",
        metadata.authorization_endpoint,
        form_encode(&[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", &redirect_uri),
            ("scope", scopes),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("device_name", &client.device_name),
            ("client_version", client.version),
            ("client_platform", &client.platform),
        ])
    );
    let browser = match super::browser::open(&url) {
        Ok(launcher) => {
            event(json!({
                "event": "login.browser",
                "host": host.name,
                "url": url,
                "message": format!("Opened your browser to sign in to {} and approve this CLI. If it did not open, visit the URL.", host.name),
            }));
            json!({ "opened": true, "launcher": launcher })
        }
        Err(reason) => {
            event(json!({
                "event": "login.browser_unavailable",
                "host": host.name,
                "url": url,
                "reason": reason,
                "message": format!("Could not open a browser ({reason}). Open this URL in a browser on this machine to sign in: {url}"),
            }));
            json!({ "opened": false, "reason": reason })
        }
    };
    listener
        .set_nonblocking(true)
        .map_err(|e| CliError::new("loopback_unavailable", e.to_string()))?;
    let deadline = Instant::now() + timeout;
    let code = loop {
        if Instant::now() >= deadline {
            return Err(CliError::new(
                "login_timeout",
                format!("no approval arrived within {} s", timeout.as_secs()),
            )
            .with_detail(json!({ "host": host.name, "hint": "run `simforge login` again, or `simforge login --device` if this machine's browser cannot reach 127.0.0.1" })));
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(e) => return Err(CliError::new("loopback_unavailable", e.to_string())),
        };
        let _ = stream.set_nonblocking(false);
        let Some(target) = read_target(&mut stream) else {
            continue;
        };
        let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
        if path != "/callback" {
            respond(
                &mut stream,
                "404 Not Found",
                "Not found",
                "This address only receives the SimForge sign-in redirect.",
            );
            continue;
        }
        let params = parse_query(query);
        let get = |k: &str| {
            params
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        // Anything without our state is not the answer to our request: ignore
        // it and keep waiting, so a stray or hostile request cannot end the login.
        if !get("state").is_some_and(|s| constant_time_eq(s.as_bytes(), state.as_bytes())) {
            respond(&mut stream, "400 Bad Request", "Sign-in not recognized", "This response does not match the sign-in the CLI started. Return to your terminal.");
            continue;
        }
        if let Some(error) = get("error") {
            let description = get("error_description").unwrap_or("").to_owned();
            respond(
                &mut stream,
                "200 OK",
                "Sign-in not approved",
                "The CLI was not approved. You can close this tab.",
            );
            let code = if error == "access_denied" {
                "login_denied"
            } else {
                "auth_rejected"
            };
            return Err(CliError::new(
                code,
                format!(
                    "{} did not approve the CLI: {error}{}",
                    host.name,
                    if description.is_empty() {
                        String::new()
                    } else {
                        format!(" ({description})")
                    }
                ),
            )
            .with_detail(json!({ "host": host.name, "error": error })));
        }
        match get("code") {
            Some(code) if !code.is_empty() => {
                respond(
                    &mut stream,
                    "200 OK",
                    "SimForge CLI approved",
                    "You are signed in. You can close this tab and return to your terminal.",
                );
                break code.to_owned();
            }
            _ => {
                respond(
                    &mut stream,
                    "400 Bad Request",
                    "Sign-in incomplete",
                    "The response carried no authorization code.",
                );
                continue;
            }
        }
    };
    let tokens = token_request(
        metadata,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect_uri),
            ("code_verifier", &verifier),
            ("client_id", CLIENT_ID),
        ],
    )
    .map_err(|e| e.into_cli(host, "authorization code exchange"))?;
    Ok(BrowserOutcome { tokens, browser })
}

// ------------------------------------------------------------------ device grant

#[derive(Debug, Deserialize)]
struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default = "default_interval")]
    interval: u64,
}

fn default_interval() -> u64 {
    5
}

pub struct DeviceOutcome {
    pub tokens: Tokens,
    pub verification_uri: String,
    pub polls: u32,
    pub slow_downs: u32,
}

/// The device authorization grant (RFC 8628).
pub fn device_grant(
    host: &Host,
    metadata: &Metadata,
    client: &Client,
    scopes: &str,
    timeout: Duration,
) -> Result<DeviceOutcome, CliError> {
    let reply = http::post_form(
        &metadata.device_authorization_endpoint,
        &[
            ("client_id", CLIENT_ID),
            ("scope", scopes),
            ("device_name", &client.device_name),
            ("client_version", client.version),
            ("client_platform", &client.platform),
        ],
        TOKEN_TIMEOUT,
    )
    .map_err(|reason| {
        CliError::new(
            "host_unreachable",
            format!(
                "the device authorization request to {} failed: {reason}",
                host.name
            ),
        )
    })?;
    if reply.status != 200 {
        let error = reply
            .json()
            .and_then(|b| b.get("error").and_then(Value::as_str).map(str::to_owned));
        return Err(CliError::new(
            "auth_rejected",
            format!(
                "{} refused the device authorization request (HTTP {}{})",
                host.name,
                reply.status,
                error.map(|e| format!(", {e}")).unwrap_or_default()
            ),
        )
        .with_detail(json!({ "host": host.name, "status": reply.status })));
    }
    let device: DeviceAuthorization = reply
        .json()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or_else(|| {
            CliError::new(
                "host_metadata_invalid",
                format!(
                    "{} answered an invalid device authorization response",
                    host.name
                ),
            )
        })?;
    let prefix = format!("{}/", host.origin);
    let complete = device
        .verification_uri_complete
        .clone()
        .filter(|u| u.starts_with(&prefix));
    if !device.verification_uri.starts_with(&prefix) {
        return Err(CliError::new(
            "host_metadata_invalid",
            format!("{} named a verification page on another origin", host.name),
        )
        .with_detail(json!({ "verificationUri": device.verification_uri })));
    }
    event(json!({
        "event": "login.device",
        "host": host.name,
        "verificationUri": device.verification_uri,
        "verificationUriComplete": complete,
        "userCode": device.user_code,
        "expiresIn": device.expires_in,
        "message": format!(
            "To approve this CLI, open {} in any browser, sign in to {} and enter the code {}.",
            complete.as_deref().unwrap_or(&device.verification_uri), host.name, device.user_code
        ),
    }));
    let deadline = Instant::now() + timeout.min(Duration::from_secs(device.expires_in));
    let mut interval = device.interval.max(1);
    let mut polls = 0u32;
    let mut slow_downs = 0u32;
    let mut transport_errors = 0u32;
    loop {
        std::thread::sleep(Duration::from_secs(interval));
        if Instant::now() >= deadline {
            return Err(CliError::new(
                "login_timeout",
                format!("the code {} was not approved in time", device.user_code),
            )
            .with_detail(
                json!({ "host": host.name, "hint": "run `simforge login --device` again" }),
            ));
        }
        polls += 1;
        match token_request(
            metadata,
            &[
                ("grant_type", DEVICE_CODE_GRANT),
                ("device_code", &device.device_code),
                ("client_id", CLIENT_ID),
            ],
        ) {
            Ok(tokens) => {
                return Ok(DeviceOutcome {
                    tokens,
                    verification_uri: device.verification_uri,
                    polls,
                    slow_downs,
                })
            }
            Err(TokenError::OAuth { error, .. }) if error == "authorization_pending" => {
                transport_errors = 0;
            }
            Err(TokenError::OAuth { error, .. }) if error == "slow_down" => {
                transport_errors = 0;
                interval += 5;
                slow_downs += 1;
            }
            Err(TokenError::OAuth { error, .. }) if error == "access_denied" => {
                return Err(CliError::new(
                    "login_denied",
                    format!("the code {} was denied on {}", device.user_code, host.name),
                )
                .with_detail(json!({ "host": host.name })))
            }
            Err(TokenError::OAuth { error, .. }) if error == "expired_token" => {
                return Err(CliError::new(
                    "login_timeout",
                    format!(
                        "the code {} expired before it was approved",
                        device.user_code
                    ),
                )
                .with_detail(
                    json!({ "host": host.name, "hint": "run `simforge login --device` again" }),
                ))
            }
            // A dropped poll is retried at the same interval, a few times.
            Err(TokenError::Transport(_)) if transport_errors < MAX_POLL_TRANSPORT_ERRORS => {
                transport_errors += 1;
            }
            Err(e) => return Err(e.into_cli(host, "device code exchange")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_the_s256_of_the_verifier() {
        let (verifier, challenge) = pkce();
        assert_eq!(verifier.len(), 43);
        assert_eq!(challenge.len(), 43);
        // RFC 7636 appendix B.
        let rfc = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(
            b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        ));
        assert_eq!(rfc, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn queries_decode_form_encoding() {
        let params = parse_query("code=a%2Bb&state=x+y&error_description=Access%20denied&empty");
        assert_eq!(params[0], ("code".into(), "a+b".into()));
        assert_eq!(params[1], ("state".into(), "x y".into()));
        assert_eq!(
            params[2],
            ("error_description".into(), "Access denied".into())
        );
        assert_eq!(params[3], ("empty".into(), String::new()));
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
    }

    #[test]
    fn state_comparison_is_exact() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
