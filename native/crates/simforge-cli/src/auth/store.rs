//! Where `simforge login` keeps a host's credentials.
//!
//! Two stores, and the one in use is always stated (`login`, `auth status`):
//!
//! - `keyring`: the OS credential store (macOS Keychain, Windows Credential
//!   Manager, the Secret Service on Linux), service `simforge-cli`, one entry
//!   per host;
//! - `file`: `<config dir>/credentials/<host>.json`, mode 0600 in a 0700
//!   directory.
//!
//! `auto` (the default) uses the keychain when it accepts the entry and the
//! file otherwise, and says so with the keychain's own error. Nothing moves
//! between stores silently: the store a host was saved to is the only one it
//! is read from.
//!
//! Non-secret facts about a login (account, organization, scopes, expiries,
//! the store) live in `<config dir>/hosts.json`; tokens never do.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::host::{Host, Metadata};
use crate::contract::CliError;
use crate::paths::Resolved;

/// Forces a store for `login` (`keyring`, `file` or `auto`).
pub const STORE_ENV: &str = "SIMFORGE_CREDENTIAL_STORE";
/// Overrides the config directory.
pub const CONFIG_DIR_ENV: &str = "SIMFORGE_CONFIG_DIR";
/// The keychain service name.
pub const KEYRING_SERVICE: &str = "simforge-cli";
const HOSTS_SCHEMA: &str = "simforge.cli-hosts/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoreKind {
    Keyring,
    File,
}

impl StoreKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StoreKind::Keyring => "keyring",
            StoreKind::File => "file",
        }
    }
}

/// `--credential-store`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum StoreChoice {
    /// The OS keychain when it accepts the entry, else the 0600 file (stated in the output).
    Auto,
    /// The OS keychain only; fail if it is unavailable.
    Keyring,
    /// A 0600 file under the config directory.
    File,
}

impl StoreChoice {
    /// The flag, else `SIMFORGE_CREDENTIAL_STORE`, else `auto`.
    pub fn resolve(flag: Option<StoreChoice>) -> Result<(StoreChoice, String), CliError> {
        if let Some(choice) = flag {
            return Ok((choice, "flag:--credential-store".into()));
        }
        match std::env::var(STORE_ENV)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
        {
            None => Ok((StoreChoice::Auto, "default".into())),
            Some(value) => StoreChoice::from_str(&value, true)
                .map(|choice| (choice, format!("env:{STORE_ENV}")))
                .map_err(|_| {
                    CliError::new(
                        "bad_value",
                        format!("{STORE_ENV} must be auto, keyring or file, not {value:?}"),
                    )
                    .with_path(STORE_ENV)
                }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Organization {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// What `hosts.json` records about one host's login (no secrets).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecord {
    pub origin: String,
    pub account: Account,
    pub organization: Organization,
    pub scopes: Vec<String>,
    pub session_id: String,
    /// Unix seconds.
    pub access_token_expires_at: u64,
    pub refresh_token_expires_at: u64,
    pub logged_in_at: u64,
    pub credential_store: StoreKind,
    /// Why the file store was used when the keychain was tried first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_store_reason: Option<String>,
    pub metadata: Metadata,
}

#[derive(Debug, Serialize, Deserialize)]
struct HostsFile {
    schema: String,
    hosts: BTreeMap<String, HostRecord>,
}

/// The two tokens of a session. Never printed, never in `hosts.json`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    pub access_token: String,
    pub refresh_token: String,
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secrets { <redacted> }")
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// `SIMFORGE_CONFIG_DIR`, `$XDG_CONFIG_HOME/simforge`, `%APPDATA%\simforge`
/// (Windows), then `~/.config/simforge`.
pub fn config_dir() -> Result<Resolved<PathBuf>, CliError> {
    let absolute = |v: String| Some(PathBuf::from(v)).filter(|p| p.is_absolute());
    if let Some(path) = env_nonempty(CONFIG_DIR_ENV).and_then(absolute) {
        return Ok(Resolved {
            value: path,
            source: format!("env:{CONFIG_DIR_ENV}"),
        });
    }
    if let Some(path) = env_nonempty("XDG_CONFIG_HOME").and_then(absolute) {
        return Ok(Resolved {
            value: path.join("simforge"),
            source: "env:XDG_CONFIG_HOME".into(),
        });
    }
    if cfg!(windows) {
        if let Some(path) = env_nonempty("APPDATA").and_then(absolute) {
            return Ok(Resolved {
                value: path.join("simforge"),
                source: "env:APPDATA".into(),
            });
        }
    }
    let home = env_nonempty("HOME")
        .or_else(|| env_nonempty("USERPROFILE"))
        .ok_or_else(|| {
            CliError::new(
                "no_home",
                "neither SIMFORGE_CONFIG_DIR, XDG_CONFIG_HOME nor HOME is set, so there is no config directory for credentials",
            )
        })?;
    Ok(Resolved {
        value: Path::new(&home).join(".config").join("simforge"),
        source: "home".into(),
    })
}

fn io_error(path: &Path, error: std::io::Error) -> CliError {
    CliError::new("io_error", format!("{}: {error}", path.display()))
        .with_path(path.display().to_string())
}

/// Create `dir` (and parents) owner-only.
fn private_dir(dir: &Path) -> Result<(), CliError> {
    std::fs::create_dir_all(dir).map_err(|e| io_error(dir, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| io_error(dir, e))?;
    }
    Ok(())
}

/// Write `bytes` to `path` owner-only (0600) by temp file and rename.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), CliError> {
    let parent = path.parent().expect("a credentials path has a parent");
    private_dir(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("write"),
        std::process::id()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|e| io_error(&temporary, e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|e| io_error(&temporary, e))?;
        }
        file.write_all(bytes).map_err(|e| io_error(&temporary, e))?;
        file.sync_all().map_err(|e| io_error(&temporary, e))?;
        std::fs::rename(&temporary, path).map_err(|e| io_error(path, e))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// A file-system-safe name for a host key (`127.0.0.1:3300` → `127.0.0.1_3300`).
fn host_file_stem(host: &str) -> String {
    host.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub struct Store {
    dir: PathBuf,
    pub dir_source: String,
}

impl Store {
    pub fn open() -> Result<Self, CliError> {
        let dir = config_dir()?;
        Ok(Self {
            dir: dir.value,
            dir_source: dir.source,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn hosts_path(&self) -> PathBuf {
        self.dir.join("hosts.json")
    }

    pub fn credentials_path(&self, host: &str) -> PathBuf {
        self.dir
            .join("credentials")
            .join(format!("{}.json", host_file_stem(host)))
    }

    fn read_hosts(&self) -> Result<HostsFile, CliError> {
        let path = self.hosts_path();
        match std::fs::read(&path) {
            Ok(bytes) => {
                let file: HostsFile = serde_json::from_slice(&bytes).map_err(|e| {
                    CliError::new(
                        "credentials_invalid",
                        format!("{} is not a valid hosts file: {e}", path.display()),
                    )
                    .with_path(path.display().to_string())
                })?;
                if file.schema != HOSTS_SCHEMA {
                    return Err(CliError::new(
                        "credentials_invalid",
                        format!(
                            "{} has unsupported schema {:?}",
                            path.display(),
                            file.schema
                        ),
                    )
                    .with_path(path.display().to_string()));
                }
                Ok(file)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HostsFile {
                schema: HOSTS_SCHEMA.into(),
                hosts: BTreeMap::new(),
            }),
            Err(e) => Err(io_error(&path, e)),
        }
    }

    fn write_hosts(&self, file: &HostsFile) -> Result<(), CliError> {
        let bytes = serde_json::to_vec_pretty(file).expect("hosts file serializes");
        write_private(&self.hosts_path(), &bytes)
    }

    /// Serialize credential changes for `host` across processes: a refresh
    /// rotates the refresh token, and two processes refreshing with the same
    /// one would look like a replay and revoke the session.
    pub fn lock(&self, host: &str) -> Result<File, CliError> {
        private_dir(&self.dir)?;
        let path = self.dir.join(format!(".{}.lock", host_file_stem(host)));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| io_error(&path, e))?;
        fs4::FileExt::lock(&file).map_err(|e| io_error(&path, e))?;
        Ok(file)
    }

    pub fn record(&self, host: &str) -> Result<Option<HostRecord>, CliError> {
        Ok(self.read_hosts()?.hosts.remove(host))
    }

    /// Save a new login: the secrets into the chosen store, then the record.
    /// Returns the record as written (with the store that took the secrets).
    pub fn save(
        &self,
        host: &Host,
        mut record: HostRecord,
        secrets: &Secrets,
        choice: StoreChoice,
    ) -> Result<HostRecord, CliError> {
        let (kind, reason) = match choice {
            StoreChoice::File => (StoreKind::File, None),
            StoreChoice::Keyring => {
                keyring_set(&host.name, secrets).map_err(|reason| {
                    CliError::new(
                        "keyring_unavailable",
                        format!("the OS keychain did not accept the credentials: {reason}"),
                    )
                    .with_detail(json!({
                        "hint": "use --credential-store file (a 0600 file under the config directory)",
                    }))
                })?;
                (StoreKind::Keyring, None)
            }
            StoreChoice::Auto => match keyring_set(&host.name, secrets) {
                Ok(()) => (StoreKind::Keyring, None),
                Err(reason) => (
                    StoreKind::File,
                    Some(format!("the OS keychain is unavailable: {reason}")),
                ),
            },
        };
        let mut hosts = self.read_hosts()?;
        let previous = hosts.hosts.get(&host.name).map(|r| r.credential_store);
        match kind {
            StoreKind::File => {
                let bytes = serde_json::to_vec(secrets).expect("secrets serialize");
                write_private(&self.credentials_path(&host.name), &bytes)?;
                // An earlier login's keychain entry must not outlive this one.
                if previous == Some(StoreKind::Keyring) {
                    keyring_delete(&host.name).map_err(|reason| {
                        CliError::new(
                            "keyring_unavailable",
                            format!("the earlier login's OS keychain entry for {} could not be deleted: {reason}", host.name),
                        )
                    })?;
                }
            }
            StoreKind::Keyring => {
                remove_if_present(&self.credentials_path(&host.name))?;
            }
        }
        record.credential_store = kind;
        record.credential_store_reason = reason;
        hosts.hosts.insert(host.name.clone(), record.clone());
        self.write_hosts(&hosts)?;
        Ok(record)
    }

    /// The tokens of `host`'s login, from the store it was saved to.
    pub fn secrets(&self, host: &str, record: &HostRecord) -> Result<Secrets, CliError> {
        match record.credential_store {
            StoreKind::Keyring => keyring_get(host).map_err(|reason| {
                CliError::new(
                    "credentials_missing",
                    format!("the login for {host} is recorded, but its tokens could not be read from the OS keychain: {reason}"),
                )
                .with_detail(json!({ "hint": format!("run `simforge login --host {host}` again") }))
            }),
            StoreKind::File => {
                let path = self.credentials_path(host);
                let bytes = std::fs::read(&path).map_err(|e| {
                    CliError::new(
                        "credentials_missing",
                        format!("the login for {host} is recorded, but {} could not be read: {e}", path.display()),
                    )
                    .with_path(path.display().to_string())
                    .with_detail(json!({ "hint": format!("run `simforge login --host {host}` again") }))
                })?;
                serde_json::from_slice(&bytes).map_err(|e| {
                    CliError::new(
                        "credentials_invalid",
                        format!("{} is not a valid credentials file: {e}", path.display()),
                    )
                    .with_path(path.display().to_string())
                })
            }
        }
    }

    /// Replace `host`'s tokens and expiries after a refresh, in the same store.
    pub fn update(
        &self,
        host: &str,
        record: &HostRecord,
        secrets: &Secrets,
    ) -> Result<(), CliError> {
        match record.credential_store {
            StoreKind::Keyring => keyring_set(host, secrets).map_err(|reason| {
                CliError::new(
                    "keyring_unavailable",
                    format!("the OS keychain did not accept the refreshed credentials: {reason}"),
                )
            })?,
            StoreKind::File => {
                let bytes = serde_json::to_vec(secrets).expect("secrets serialize");
                write_private(&self.credentials_path(host), &bytes)?;
            }
        }
        let mut hosts = self.read_hosts()?;
        hosts.hosts.insert(host.to_owned(), record.clone());
        self.write_hosts(&hosts)
    }

    /// Forget `host`: its record and its tokens, from whichever store.
    pub fn delete(&self, host: &str) -> Result<Option<HostRecord>, CliError> {
        let mut hosts = self.read_hosts()?;
        let removed = hosts.hosts.remove(host);
        if let Some(record) = &removed {
            if record.credential_store == StoreKind::Keyring {
                keyring_delete(host).map_err(|reason| {
                    CliError::new(
                        "keyring_unavailable",
                        format!("the OS keychain entry for {host} could not be deleted: {reason}"),
                    )
                })?;
            }
        }
        remove_if_present(&self.credentials_path(host))?;
        if removed.is_some() {
            self.write_hosts(&hosts)?;
        }
        Ok(removed)
    }

    /// How `auth status` describes where a login's tokens are.
    pub fn describe(&self, host: &str, record: &HostRecord) -> Value {
        match record.credential_store {
            StoreKind::Keyring => json!({
                "kind": "keyring",
                "service": KEYRING_SERVICE,
                "account": host,
            }),
            StoreKind::File => json!({
                "kind": "file",
                "path": self.credentials_path(host),
                "mode": if cfg!(unix) { "0600" } else { "user profile ACL" },
                "reason": record.credential_store_reason,
            }),
        }
    }
}

fn remove_if_present(path: &Path) -> Result<(), CliError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(path, e)),
    }
}

fn keyring_entry(host: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, host).map_err(|e| e.to_string())
}

fn keyring_set(host: &str, secrets: &Secrets) -> Result<(), String> {
    let text = serde_json::to_string(secrets).expect("secrets serialize");
    keyring_entry(host)?
        .set_password(&text)
        .map_err(|e| e.to_string())
}

fn keyring_get(host: &str) -> Result<Secrets, String> {
    let text = keyring_entry(host)?
        .get_password()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("the keychain entry is not valid: {e}"))
}

fn keyring_delete(host: &str) -> Result<(), String> {
    match keyring_entry(host)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_keys_become_safe_file_names() {
        assert_eq!(host_file_stem("dev.simforge.ai"), "dev.simforge.ai");
        assert_eq!(host_file_stem("127.0.0.1:3300"), "127.0.0.1_3300");
        assert_eq!(host_file_stem("[::1]:80"), "___1__80");
    }

    #[test]
    fn secrets_never_debug_print() {
        let secrets = Secrets {
            access_token: "sfc_at_secret".into(),
            refresh_token: "sfc_rt_secret".into(),
        };
        assert!(!format!("{secrets:?}").contains("secret\""));
        assert!(!format!("{secrets:?}").contains("sfc_"));
    }
}
