//! The CLI's credentials for a SimForge host (`simforge login`).
//!
//! OAuth 2.0 for a public native client (RFC 8252): the authorization-code
//! grant with PKCE over a loopback redirect by default, the device
//! authorization grant (RFC 8628) when there is no browser to open. A host
//! publishes its endpoints as RFC 8414 metadata ([`host::discover`]); this
//! module knows the host's name and the protocol and nothing else.
//!
//! Tokens: a short-lived access token and a refresh token that rotates on
//! every use (the host treats a reused one as theft and revokes the session),
//! so refreshes are serialized across processes by a lock file. The tokens are
//! kept in the OS keychain or a 0600 file ([`store`]) and are never printed.
//!
//! `SIMFORGE_TOKEN` (an access token) overrides the stored login for CI and
//! headless use; it is used as given and never refreshed.

pub mod browser;
pub mod host;
pub(crate) mod http;
pub mod oauth;
pub mod store;
pub mod time;

use std::sync::Mutex;

use serde_json::{json, Value};

pub use host::{resolve_host, Host, Metadata};
use store::{Account, HostRecord, Organization, Secrets, Store};

use crate::contract::CliError;

/// An access token that overrides the stored login (CI, headless machines).
pub const TOKEN_ENV: &str = "SIMFORGE_TOKEN";
/// Refresh an access token with less than this many seconds left.
const REFRESH_MARGIN_SECS: u64 = 120;

fn env_token() -> Option<String> {
    std::env::var(TOKEN_ENV)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

pub fn not_logged_in(host: &Host) -> CliError {
    CliError::new(
        "not_logged_in",
        format!("not logged in to {}", host.name),
    )
    .with_detail(json!({
        "host": host.name,
        "hostSource": host.source,
        "hint": format!("run `simforge login{}` (or set {TOKEN_ENV})", if host.source == "default" { String::new() } else { format!(" --host {}", host.name) }),
    }))
}

fn session_invalid(host: &Host, reason: &str) -> CliError {
    CliError::new(
        "session_invalid",
        format!(
            "the saved login for {} is no longer valid: {reason}",
            host.name
        ),
    )
    .with_detail(json!({
        "host": host.name,
        "hint": format!("run `simforge login --host {}` again", host.name),
    }))
}

/// Where a credential came from.
#[derive(Debug, Clone)]
pub enum Source {
    /// `SIMFORGE_TOKEN`.
    Env,
    /// `simforge login`, with the record as of the last refresh.
    Stored(Box<HostRecord>),
}

/// A usable bearer for one host.
pub struct Credential {
    pub host: Host,
    pub metadata: Metadata,
    source: Mutex<Source>,
    token: Mutex<String>,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("host", &self.host.name)
            .finish_non_exhaustive()
    }
}

impl Credential {
    /// The current access token (for an `Authorization: Bearer` header only).
    pub fn access_token(&self) -> String {
        self.token.lock().expect("token lock").clone()
    }

    pub fn source(&self) -> Source {
        self.source.lock().expect("source lock").clone()
    }

    /// `env:SIMFORGE_TOKEN`, `keyring` or `file`.
    pub fn source_label(&self) -> String {
        match &*self.source.lock().expect("source lock") {
            Source::Env => format!("env:{TOKEN_ENV}"),
            Source::Stored(record) => record.credential_store.as_str().to_owned(),
        }
    }

    /// The host rejected `rejected` (401): refresh a stored login once and
    /// return the new token. `None` when there is nothing to refresh (an
    /// environment token, or another process already holds a newer one that
    /// is the same as `rejected`).
    pub fn refresh_after_rejection(&self, rejected: &str) -> Result<Option<String>, CliError> {
        if matches!(*self.source.lock().expect("source lock"), Source::Env) {
            return Ok(None);
        }
        let store = Store::open()?;
        let (record, secrets) = refresh_locked(&store, &self.host, Some(rejected))?;
        if secrets.access_token == rejected {
            return Ok(None);
        }
        *self.token.lock().expect("token lock") = secrets.access_token.clone();
        *self.source.lock().expect("source lock") = Source::Stored(Box::new(record));
        Ok(Some(secrets.access_token))
    }
}

/// The credential for `host`: `SIMFORGE_TOKEN`, else the stored login
/// (refreshed first when its access token is about to expire), else `None`.
pub fn credential(host: &Host) -> Result<Option<Credential>, CliError> {
    if let Some(token) = env_token() {
        let metadata = host::discover(host)?;
        return Ok(Some(Credential {
            host: host.clone(),
            metadata,
            source: Mutex::new(Source::Env),
            token: Mutex::new(token),
        }));
    }
    let store = Store::open()?;
    let Some(record) = store.record(&host.name)? else {
        return Ok(None);
    };
    if record.origin != host.origin {
        return Err(session_invalid(
            host,
            &format!("it was made against {}, not {}", record.origin, host.origin),
        ));
    }
    let (record, secrets) = if time::now() + REFRESH_MARGIN_SECS < record.access_token_expires_at {
        let secrets = store.secrets(&host.name, &record)?;
        (record, secrets)
    } else {
        refresh_locked(&store, host, None)?
    };
    Ok(Some(Credential {
        host: host.clone(),
        metadata: record.metadata.clone(),
        source: Mutex::new(Source::Stored(Box::new(record))),
        token: Mutex::new(secrets.access_token),
    }))
}

/// Refresh `host`'s stored login under its lock. A token another process
/// refreshed while this one waited is used as is (a second refresh with the
/// old refresh token would be a replay).
fn refresh_locked(
    store: &Store,
    host: &Host,
    rejected: Option<&str>,
) -> Result<(HostRecord, Secrets), CliError> {
    let _lock = store.lock(&host.name)?;
    let record = store
        .record(&host.name)?
        .ok_or_else(|| not_logged_in(host))?;
    let secrets = store.secrets(&host.name, &record)?;
    let now = time::now();
    let still_valid = now + REFRESH_MARGIN_SECS < record.access_token_expires_at;
    if still_valid && rejected != Some(secrets.access_token.as_str()) {
        return Ok((record, secrets));
    }
    if now >= record.refresh_token_expires_at {
        return Err(session_invalid(host, "its refresh token expired"));
    }
    match oauth::refresh(&record.metadata, &secrets.refresh_token) {
        Ok(tokens) => {
            let updated = apply_tokens(record, &tokens, now);
            let secrets = Secrets {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
            };
            store.update(&host.name, &updated, &secrets)?;
            Ok((updated, secrets))
        }
        Err(oauth::TokenError::OAuth {
            error, description, ..
        }) => Err(session_invalid(
            host,
            &format!(
                "the host refused the refresh ({error}{}); it was revoked, expired or replaced",
                description.map(|d| format!(": {d}")).unwrap_or_default()
            ),
        )),
        Err(oauth::TokenError::Transport(reason)) => Err(CliError::new(
            "host_unreachable",
            format!("could not refresh the login for {}: {reason}", host.name),
        )
        .with_detail(json!({ "host": host.name }))),
    }
}

/// The record after a token response: new expiries and identity.
pub fn apply_tokens(mut record: HostRecord, tokens: &oauth::Tokens, now: u64) -> HostRecord {
    record.access_token_expires_at = now + tokens.expires_in;
    record.refresh_token_expires_at = now + tokens.refresh_expires_in;
    record.scopes = split_scopes(&tokens.scope);
    record.session_id = tokens.session_id.clone();
    record.account = Account {
        id: tokens.account.id.clone(),
        email: tokens.account.email.clone(),
        name: tokens.account.name.clone(),
    };
    record.organization = Organization {
        id: tokens.organization.id.clone(),
        name: tokens.organization.name.clone(),
        workspace_id: tokens.organization.workspace_id.clone(),
    };
    record
}

pub fn split_scopes(scope: &str) -> Vec<String> {
    let mut scopes: Vec<String> = scope.split_whitespace().map(str::to_owned).collect();
    scopes.sort();
    scopes.dedup();
    scopes
}

/// How a result document names the account behind a credential (no secrets).
pub fn describe_record(record: &HostRecord) -> Value {
    json!({
        "account": record.account,
        "organization": record.organization,
        "scopes": record.scopes,
        "sessionId": record.session_id,
        "accessTokenExpiresAt": time::rfc3339(record.access_token_expires_at),
        "refreshTokenExpiresAt": time::rfc3339(record.refresh_token_expires_at),
    })
}
