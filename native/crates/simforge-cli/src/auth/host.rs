//! Which SimForge host the CLI talks to, and what that host publishes.
//!
//! The CLI knows a host's name and the protocol, nothing else: every endpoint
//! comes from the host's OAuth 2.0 authorization server metadata (RFC 8414)
//! at `/.well-known/oauth-authorization-server`, and every endpoint must be
//! on the host's own origin, so a token is never sent anywhere else.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::contract::CliError;

/// The public SimForge host.
pub const DEFAULT_HOST: &str = "simforge.ai";
/// Overrides the default host.
pub const HOST_ENV: &str = "SIMFORGE_HOST";
/// This CLI's OAuth client id (a public client: no secret).
pub const CLIENT_ID: &str = "simforge-cli";
/// Where a host publishes its metadata (RFC 8414).
pub const METADATA_PATH: &str = "/.well-known/oauth-authorization-server";
/// The scope `maps list`/`maps pull` need, and what `login` asks for by default.
pub const MAPS_READ: &str = "maps:read";

const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Host {
    /// `host[:port]`, lowercase: the key credentials are stored under.
    pub name: String,
    /// `https://host[:port]` (`http://` only for a loopback host).
    pub origin: String,
    /// `flag:--host`, `env:SIMFORGE_HOST` or `default`.
    pub source: String,
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// `--host`, then `SIMFORGE_HOST`, then `simforge.ai`.
pub fn resolve_host(flag: Option<&str>) -> Result<Host, CliError> {
    let (raw, source, path) = match flag {
        Some(value) => (value.to_owned(), "flag:--host".to_owned(), "--host"),
        None => match env_nonempty(HOST_ENV) {
            Some(value) => (value, format!("env:{HOST_ENV}"), HOST_ENV),
            None => (DEFAULT_HOST.to_owned(), "default".to_owned(), "--host"),
        },
    };
    let (name, origin) = parse_host(&raw).map_err(|reason| {
        CliError::new("bad_value", reason)
            .with_path(path)
            .with_detail(json!({ "value": raw }))
    })?;
    Ok(Host {
        name,
        origin,
        source,
    })
}

/// `simforge.ai`, `https://dev.simforge.ai`, `http://127.0.0.1:3300` → (name, origin).
pub fn parse_host(raw: &str) -> Result<(String, String), String> {
    let raw = raw.trim().trim_end_matches('/');
    let (scheme, rest) = match raw.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("https".to_owned(), raw),
    };
    let malformed = || {
        format!(
            "invalid host {raw:?}: give a host name such as simforge.ai or dev.simforge.ai (https:// optional), without a path"
        )
    };
    if rest.is_empty()
        || rest.chars().any(|c| {
            matches!(c, '/' | '?' | '#' | '@' | '\\') || c.is_whitespace() || c.is_control()
        })
    {
        return Err(malformed());
    }
    let authority = rest.to_ascii_lowercase();
    let (hostname, port) = if let Some(end) = authority.strip_prefix('[').and_then(|r| r.find(']'))
    {
        let hostname = &authority[..end + 2];
        (hostname, authority[end + 2..].strip_prefix(':'))
    } else {
        match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority.as_str(), None),
        }
    };
    if hostname.is_empty()
        || port.is_some_and(|p| {
            p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) || p.parse::<u16>().is_err()
        })
    {
        return Err(malformed());
    }
    let loopback = matches!(hostname, "127.0.0.1" | "localhost" | "[::1]");
    match scheme.as_str() {
        "https" => {}
        "http" if loopback => {}
        "http" => {
            return Err(format!(
                "invalid host {raw:?}: http:// is allowed only for a loopback host; use https://"
            ))
        }
        other => {
            return Err(format!(
                "invalid host {raw:?}: unsupported scheme {other}://"
            ))
        }
    }
    Ok((authority.clone(), format!("{scheme}://{authority}")))
}

/// The host's published endpoints (RFC 8414 plus two SimForge fields).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Metadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub device_authorization_endpoint: String,
    pub revocation_endpoint: String,
    pub userinfo_endpoint: String,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
    /// The account-aware map registry (the map-registry protocol; bearer auth).
    pub simforge_maps_registry: String,
    /// The account page listing this user's CLI sessions, with Revoke.
    pub simforge_cli_sessions_page: String,
}

impl Metadata {
    fn endpoints(&self) -> [(&'static str, &str); 7] {
        [
            ("authorization_endpoint", &self.authorization_endpoint),
            ("token_endpoint", &self.token_endpoint),
            (
                "device_authorization_endpoint",
                &self.device_authorization_endpoint,
            ),
            ("revocation_endpoint", &self.revocation_endpoint),
            ("userinfo_endpoint", &self.userinfo_endpoint),
            ("simforge_maps_registry", &self.simforge_maps_registry),
            (
                "simforge_cli_sessions_page",
                &self.simforge_cli_sessions_page,
            ),
        ]
    }

    /// Every endpoint on the host's own origin; the issuer is the origin.
    pub fn validate(&self, host: &Host) -> Result<(), CliError> {
        let bad = |field: &str, value: &str, why: &str| {
            CliError::new(
                "host_metadata_invalid",
                format!("{} publishes an unusable {field}: {why}", host.name),
            )
            .with_detail(json!({ "host": host.name, "field": field, "value": value }))
        };
        if self.issuer.trim_end_matches('/') != host.origin {
            return Err(bad(
                "issuer",
                &self.issuer,
                "it is not the host's own origin",
            ));
        }
        let prefix = format!("{}/", host.origin);
        for (field, value) in self.endpoints() {
            if !value.starts_with(&prefix) || value.chars().any(char::is_whitespace) {
                return Err(bad(field, value, "it is not on the host's own origin"));
            }
        }
        Ok(())
    }
}

/// Fetch and validate the host's metadata.
pub fn discover(host: &Host) -> Result<Metadata, CliError> {
    let url = format!("{}{METADATA_PATH}", host.origin);
    let reply = super::http::get(&url, None, TIMEOUT).map_err(|reason| {
        CliError::new(
            "host_unreachable",
            format!("could not reach {}: {reason}", host.name),
        )
        .with_detail(json!({ "host": host.name, "url": url }))
    })?;
    if reply.status == 404 {
        return Err(CliError::new(
            "host_unsupported",
            format!(
                "{} does not offer SimForge CLI sign-in (no OAuth metadata at {METADATA_PATH})",
                host.name
            ),
        )
        .with_detail(json!({ "host": host.name, "url": url })));
    }
    if reply.status != 200 {
        return Err(CliError::new(
            "host_error",
            format!(
                "{} answered HTTP {} for its OAuth metadata",
                host.name, reply.status
            ),
        )
        .with_detail(json!({ "host": host.name, "url": url, "status": reply.status })));
    }
    let metadata: Metadata = serde_json::from_slice(&reply.body).map_err(|e| {
        CliError::new(
            "host_metadata_invalid",
            format!("{} published invalid OAuth metadata: {e}", host.name),
        )
        .with_detail(json!({ "host": host.name, "url": url }))
    })?;
    metadata.validate(host)?;
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_normalize_to_an_https_origin() {
        assert_eq!(
            parse_host("simforge.ai").unwrap(),
            ("simforge.ai".into(), "https://simforge.ai".into())
        );
        assert_eq!(
            parse_host("https://Dev.SimForge.ai/").unwrap(),
            ("dev.simforge.ai".into(), "https://dev.simforge.ai".into())
        );
        assert_eq!(
            parse_host("http://127.0.0.1:3300").unwrap(),
            ("127.0.0.1:3300".into(), "http://127.0.0.1:3300".into())
        );
        assert_eq!(
            parse_host("http://[::1]:8080").unwrap(),
            ("[::1]:8080".into(), "http://[::1]:8080".into())
        );
    }

    #[test]
    fn hosts_refuse_paths_credentials_and_plain_http() {
        for bad in [
            "http://simforge.ai",
            "https://simforge.ai/cli",
            "user@simforge.ai",
            "simforge.ai:99999",
            "simforge.ai:",
            "ftp://simforge.ai",
            "",
            "simforge .ai",
        ] {
            assert!(parse_host(bad).is_err(), "{bad} accepted");
        }
    }

    fn metadata(origin: &str) -> Metadata {
        Metadata {
            issuer: origin.into(),
            authorization_endpoint: format!("{origin}/cli/authorize"),
            token_endpoint: format!("{origin}/api/cli/token"),
            device_authorization_endpoint: format!("{origin}/api/cli/device/code"),
            revocation_endpoint: format!("{origin}/api/cli/revoke"),
            userinfo_endpoint: format!("{origin}/api/cli/userinfo"),
            scopes_supported: vec![MAPS_READ.into()],
            simforge_maps_registry: format!("{origin}/api/cli/registry"),
            simforge_cli_sessions_page: format!("{origin}/account/cli-sessions"),
        }
    }

    #[test]
    fn metadata_must_stay_on_the_host() {
        let host = Host {
            name: "simforge.ai".into(),
            origin: "https://simforge.ai".into(),
            source: "default".into(),
        };
        assert!(metadata("https://simforge.ai").validate(&host).is_ok());
        let mut foreign = metadata("https://simforge.ai");
        foreign.token_endpoint = "https://simforge.ai.evil.example/token".into();
        assert!(foreign.validate(&host).is_err());
        let mut issuer = metadata("https://simforge.ai");
        issuer.issuer = "https://other.example".into();
        assert!(issuer.validate(&host).is_err());
    }
}
