//! `simforge login`, `simforge logout`, `simforge auth status` and
//! `simforge whoami`: the CLI's session on a SimForge host.

use std::time::Duration;

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use crate::auth::oauth::{self, Client};
use crate::auth::store::{
    Account, HostRecord, Organization, Secrets, Store, StoreChoice, StoreKind,
};
use crate::auth::{self, host, time, Source};
use crate::contract::{CliError, CmdResult, Ctx, Outcome};

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// SimForge host to sign in to (simforge.ai, staging.simforge.ai, dev.simforge.ai). Default: SIMFORGE_HOST, then simforge.ai.
    #[arg(long, value_name = "HOST")]
    pub host: Option<String>,
    /// Sign in with a code instead of a local browser: print a URL and a short code to approve from any browser (SSH, headless machines).
    #[arg(long)]
    pub device: bool,
    /// A scope to request (repeatable). Default: maps:read.
    #[arg(long = "scope", value_name = "SCOPE")]
    pub scopes: Vec<String>,
    /// Where to keep the tokens. Default: SIMFORGE_CREDENTIAL_STORE, then auto (the OS keychain, else a 0600 file; the output says which and why).
    #[arg(long, value_enum, value_name = "STORE")]
    pub credential_store: Option<StoreChoice>,
    /// The name the approval page and the CLI sessions list show for this machine. Default: the host name.
    #[arg(long, value_name = "NAME")]
    pub device_name: Option<String>,
    /// Seconds to wait for the approval.
    #[arg(long, value_name = "SECONDS", default_value_t = 600)]
    pub timeout: u64,
}

#[derive(Debug, Args)]
pub struct HostArgs {
    /// SimForge host. Default: SIMFORGE_HOST, then simforge.ai.
    #[arg(long, value_name = "HOST")]
    pub host: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    /// The account, organization, scopes, expiry, host and credential store of this machine's login, checked with the host.
    Status(HostArgs),
}

pub fn run_auth(command: AuthCommand, ctx: &Ctx) -> CmdResult {
    match command {
        AuthCommand::Status(args) => status(args, ctx),
    }
}

// ------------------------------------------------------------------ login

pub fn login(args: LoginArgs, _ctx: &Ctx) -> CmdResult {
    let host = auth::resolve_host(args.host.as_deref())?;
    if std::env::var(auth::TOKEN_ENV).is_ok_and(|v| !v.trim().is_empty()) {
        return Err(CliError::new(
            "conflicting_arguments",
            format!(
                "{} is set, and it overrides any stored login; unset it to log in",
                auth::TOKEN_ENV
            ),
        )
        .with_path(auth::TOKEN_ENV));
    }
    let (store_choice, store_source) = StoreChoice::resolve(args.credential_store)?;
    let mut scopes: Vec<String> = if args.scopes.is_empty() {
        vec![host::MAPS_READ.to_owned()]
    } else {
        args.scopes.clone()
    };
    scopes.sort();
    scopes.dedup();
    if let Some(bad) = scopes.iter().find(|s| {
        s.is_empty()
            || !s
                .bytes()
                .all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')
    }) {
        return Err(
            CliError::new("bad_value", format!("invalid scope {bad:?}")).with_path("--scope")
        );
    }
    let metadata = host::discover(&host)?;
    if let Some(unknown) = scopes
        .iter()
        .find(|s| !metadata.scopes_supported.contains(s))
    {
        return Err(CliError::new(
            "bad_value",
            format!("{} does not offer the scope {unknown}", host.name),
        )
        .with_path("--scope")
        .with_detail(json!({ "supported": metadata.scopes_supported })));
    }
    let scope = scopes.join(" ");
    let client = Client::new(args.device_name.clone());
    let timeout = Duration::from_secs(args.timeout.max(1));

    // Which flow, and why: stated in the result and on stderr, never switched silently.
    let (method, method_reason) = if args.device {
        ("device", "flag:--device".to_owned())
    } else if let Some(reason) = auth::browser::unavailable_reason() {
        ("device", format!("no browser can be opened here: {reason}"))
    } else {
        ("browser", "default".to_owned())
    };
    if method == "device" && !args.device {
        oauth::event(json!({
            "event": "login.method",
            "method": "device",
            "reason": method_reason,
            "message": format!("Using device sign-in because {}. Pass --device to choose it explicitly.", method_reason.trim_start_matches("no browser can be opened here: ")),
        }));
    }
    let (tokens, flow) = if method == "device" {
        let outcome = oauth::device_grant(&host, &metadata, &client, &scope, timeout)?;
        let flow = json!({
            "verificationUri": outcome.verification_uri,
            "polls": outcome.polls,
            "slowDowns": outcome.slow_downs,
        });
        (outcome.tokens, flow)
    } else {
        let outcome = oauth::browser_grant(&host, &metadata, &client, &scope, timeout)?;
        (outcome.tokens, json!({ "browser": outcome.browser }))
    };

    let store = Store::open()?;
    // A login replaces this host's previous one; the old session is revoked
    // on the host so it does not linger in the account's CLI sessions.
    let previous = store.record(&host.name)?;
    let now = time::now();
    let record = auth::apply_tokens(
        HostRecord {
            origin: host.origin.clone(),
            account: Account {
                id: String::new(),
                email: String::new(),
                name: String::new(),
            },
            organization: Organization {
                id: String::new(),
                name: String::new(),
                workspace_id: None,
            },
            scopes: Vec::new(),
            session_id: String::new(),
            access_token_expires_at: 0,
            refresh_token_expires_at: 0,
            logged_in_at: now,
            credential_store: StoreKind::File,
            credential_store_reason: None,
            metadata: metadata.clone(),
        },
        &tokens,
        now,
    );
    let secrets = Secrets {
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
    };
    let replaced = match previous {
        Some(old) if old.session_id != record.session_id => {
            let revoked = store
                .secrets(&host.name, &old)
                .map_err(|e| e.reason)
                .and_then(|s| oauth::revoke(&old.metadata, &s.refresh_token, "refresh_token"));
            Some(json!({
                "sessionId": old.session_id,
                "revoked": revoked.is_ok(),
                "reason": revoked.err(),
            }))
        }
        _ => None,
    };
    let record = store.save(&host, record, &secrets, store_choice)?;
    if let Some(reason) = &record.credential_store_reason {
        oauth::event(json!({
            "event": "login.credential_store",
            "kind": "file",
            "path": store.credentials_path(&host.name),
            "reason": reason,
            "message": format!("{reason}; the tokens are in {} (mode 0600).", store.credentials_path(&host.name).display()),
        }));
    }

    let mut out = auth::describe_record(&record);
    out["host"] = json!(host.name);
    out["hostSource"] = json!(host.source);
    out["method"] = json!(method);
    out["methodReason"] = json!(method_reason);
    out["flow"] = flow;
    out["credentialStore"] = store.describe(&host.name, &record);
    out["credentialStore"]["choice"] = json!(format!("{store_choice:?}").to_lowercase());
    out["credentialStore"]["choiceSource"] = json!(store_source);
    out["mapsRegistry"] = json!(metadata.simforge_maps_registry);
    out["sessionsPage"] = json!(metadata.simforge_cli_sessions_page);
    out["replaced"] = replaced.unwrap_or(Value::Null);
    Ok(Outcome::ok(out))
}

// ------------------------------------------------------------------ logout

pub fn logout(args: HostArgs, _ctx: &Ctx) -> CmdResult {
    let host = auth::resolve_host(args.host.as_deref())?;
    let store = Store::open()?;
    let Some(record) = store.record(&host.name)? else {
        return Err(auth::not_logged_in(&host));
    };
    // Logging out always forgets the tokens here; a revocation the host did
    // not confirm is an error that names the page to finish it on.
    let revoked = store
        .secrets(&host.name, &record)
        .map_err(|e| e.reason)
        .and_then(|secrets| {
            oauth::revoke(&record.metadata, &secrets.refresh_token, "refresh_token")
        });
    store.delete(&host.name)?;
    let mut out = json!({
        "host": host.name,
        "account": record.account,
        "organization": record.organization,
        "sessionId": record.session_id,
        "deleted": { "credentialStore": record.credential_store.as_str() },
    });
    match revoked {
        Ok(()) => {
            out["revoked"] = json!(true);
            Ok(Outcome::ok(out))
        }
        Err(reason) => Err(CliError::new(
            "logout_incomplete",
            format!(
                "deleted the local credentials for {}, but the host did not confirm the revocation ({reason}); revoke the session on {}",
                host.name, record.metadata.simforge_cli_sessions_page
            ),
        )
        .with_detail(json!({
            "host": host.name,
            "sessionId": record.session_id,
            "localDeleted": true,
            "serverRevoked": false,
            "sessionsPage": record.metadata.simforge_cli_sessions_page,
        }))),
    }
}

// ------------------------------------------------------------------ status

pub fn status(args: HostArgs, _ctx: &Ctx) -> CmdResult {
    let host = auth::resolve_host(args.host.as_deref())?;
    let Some(credential) = auth::credential(&host)? else {
        return Err(auth::not_logged_in(&host));
    };
    let token = credential.access_token();
    let answer = match oauth::userinfo(&credential.metadata, &token) {
        Ok(oauth::UserInfo::Rejected { status, .. }) => {
            match credential.refresh_after_rejection(&token)? {
                Some(fresh) => oauth::userinfo(&credential.metadata, &fresh),
                None => Ok(oauth::UserInfo::Rejected {
                    status,
                    error: None,
                }),
            }
        }
        other => other,
    }
    .map_err(|reason| {
        CliError::new(
            "host_unreachable",
            format!("could not check the login with {}: {reason}", host.name),
        )
        .with_detail(json!({ "host": host.name }))
    })?;
    let info = match answer {
        oauth::UserInfo::Ok(info) => info,
        oauth::UserInfo::Rejected { status, error } => {
            return Err(CliError::new(
                "session_invalid",
                format!(
                    "{} no longer accepts this login (HTTP {status}{})",
                    host.name,
                    error.map(|e| format!(", {e}")).unwrap_or_default()
                ),
            )
            .with_detail(json!({
                "host": host.name,
                "source": credential.source_label(),
                "hint": format!("run `simforge login --host {}` again", host.name),
            })))
        }
    };
    let mut out = json!({
        "host": host.name,
        "hostSource": host.source,
        "loggedIn": true,
        "verified": true,
        "account": info.get("account"),
        "organization": info.get("organization"),
        "scopes": info.get("scopes"),
        "sessionId": info.pointer("/session/id"),
        "deviceName": info.pointer("/session/device_name"),
        "accessTokenExpiresAt": info.get("access_token_expires_at"),
        "credentialSource": credential.source_label(),
        "mapsRegistry": credential.metadata.simforge_maps_registry,
        "sessionsPage": credential.metadata.simforge_cli_sessions_page,
    });
    match credential.source() {
        Source::Env => {
            out["credentialStore"] =
                json!({ "kind": "env", "variable": auth::TOKEN_ENV, "refreshes": false });
        }
        Source::Stored(record) => {
            let store = Store::open()?;
            out["credentialStore"] = store.describe(&host.name, &record);
            out["refreshTokenExpiresAt"] = json!(time::rfc3339(record.refresh_token_expires_at));
            out["loggedInAt"] = json!(time::rfc3339(record.logged_in_at));
        }
    }
    Ok(Outcome::ok(out))
}

/// `simforge whoami` is `simforge auth status`.
pub fn whoami(args: HostArgs, ctx: &Ctx) -> CmdResult {
    status(args, ctx)
}
