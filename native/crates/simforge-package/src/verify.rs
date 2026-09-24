//! The reader: open (structure, manifest, skew), then verify (every member
//! hashed, closures, blobs, cross-checks), then read or extract.
//!
//! Order follows scenario-package.md section 5.1: nothing is hashed before
//! the container structure and the manifest are proven, and a package ahead
//! of this reader is refused before any member is read.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use simforge_core::hash::sha256_bytes;

use crate::check::{check_contents, ContentInput, ContentReport};
use crate::closure::{ActorClosure, ACTOR_CATALOG_PATH};
use crate::error::{ErrorCode, PackageError, Result};
use crate::manifest::Manifest;
use crate::names::{blob_digest, blob_path, MANIFEST_PATH, RECEIPT_PATH};
use crate::receipt::{Form, Receipt};
use crate::skew::{self, ReaderSupport};
use crate::zip::{Limits, ZipReader};

const MAX_RECEIPT_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyOptions {
    pub limits: Limits,
    pub reader: ReaderSupport,
}

impl VerifyOptions {
    /// Default limits, this build's contracts, read as CLI `cli_version`
    /// (`None`: a producer checking its own output; `producer.minCli` is then
    /// reported as not evaluated).
    pub fn new(cli_version: Option<&str>) -> Result<Self> {
        Ok(Self {
            limits: Limits::default(),
            reader: ReaderSupport::current(cli_version)?,
        })
    }
}

/// What `open` proves without hashing member data.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub package_id: String,
    pub display_id: String,
    pub form: Form,
    pub container_bytes: u64,
    pub zip64: bool,
    pub entries: usize,
    pub manifest: Manifest,
    pub receipt: Option<Receipt>,
    /// `passed`, or `not-evaluated` when no CLI version was given.
    pub cli_check: &'static str,
}

/// A fully verified package.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    #[serde(flatten)]
    pub inspection: Inspection,
    pub content: ContentReport,
}

impl Verification {
    pub fn package_id(&self) -> &str {
        &self.inspection.package_id
    }
    pub fn form(&self) -> Form {
        self.inspection.form
    }
    pub fn manifest(&self) -> &Manifest {
        &self.inspection.manifest
    }
}

/// `pkg_<first 12 hex>`.
pub fn display_id(package_id: &str) -> String {
    format!("pkg_{}", &package_id[..12.min(package_id.len())])
}

/// `<title-slug>.<first 12 hex>.scenario.zip`.
pub fn file_name(title: &str, package_id: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= 60 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "scenario" } else { slug };
    format!(
        "{slug}.{}.scenario.zip",
        &package_id[..12.min(package_id.len())]
    )
}

pub struct PackageReader<R: Read + Seek> {
    zip: ZipReader<R>,
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
    package_id: String,
    receipt: Option<Receipt>,
    form: Form,
    limits: Limits,
    cli_evaluated: bool,
}

impl PackageReader<BufReader<File>> {
    pub fn open_file(path: &Path, options: &VerifyOptions) -> Result<Self> {
        let file = File::open(path)?;
        Self::open(BufReader::new(file), options)
    }
}

impl<R: Read + Seek> PackageReader<R> {
    /// Structural checks, manifest (canonical, schema, invariants), skew,
    /// and the member listing against the container. No member data is read
    /// except `manifest.json` and `receipt.json`.
    pub fn open(inner: R, options: &VerifyOptions) -> Result<Self> {
        let limits = options.limits.clone();
        let mut zip = ZipReader::open(inner, &limits)?;
        match zip.entries().first() {
            Some(e) if e.name == MANIFEST_PATH => {}
            _ => {
                return Err(PackageError::container(
                    "member_order",
                    "manifest.json must be the first entry",
                ))
            }
        }
        let (manifest_bytes, _) = zip.read(MANIFEST_PATH, limits.max_manifest_bytes)?;
        let raw: Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| PackageError::manifest("not_json", "manifest.json is not JSON"))?;
        skew::check_manifest_major(&raw, &options.reader)?;
        drop(raw);
        let manifest = Manifest::parse(&manifest_bytes)?;
        skew::check(&manifest, &options.reader)?;
        let package_id = sha256_bytes(&manifest_bytes);

        // The listing: manifest, receipt?, members in role order, blobs sorted.
        let has_receipt = zip.entry(RECEIPT_PATH).is_some();
        let mut blobs: Vec<&str> = Vec::new();
        for e in zip.entries() {
            if e.name == MANIFEST_PATH || e.name == RECEIPT_PATH {
                continue;
            }
            if blob_digest(&e.name).is_some() {
                blobs.push(&e.name);
            } else if manifest.member(&e.name).is_none() {
                return Err(PackageError::container(
                    "member_unlisted",
                    format!(
                        "{:?} is in the container but not in manifest.members",
                        e.name
                    ),
                )
                .at(e.name.clone()));
            }
        }
        for m in &manifest.members {
            let Some(e) = zip.entry(&m.path) else {
                return Err(PackageError::container(
                    "member_missing",
                    format!("{} is listed but not in the container", m.path),
                )
                .at(m.path.clone()));
            };
            if e.size != m.size {
                return Err(PackageError::digest(
                    "member_size",
                    format!(
                        "{} is {} bytes in the container, the manifest says {}",
                        m.path, e.size, m.size
                    ),
                )
                .at(m.path.clone()));
            }
            if e.size > limits.max_member_bytes {
                return Err(PackageError::new(
                    ErrorCode::LimitExceeded,
                    "member_size",
                    format!(
                        "{} is {} bytes; the limit is {}",
                        m.path, e.size, limits.max_member_bytes
                    ),
                )
                .at(m.path.clone()));
            }
        }
        let mut listed: Vec<&crate::manifest::MemberEntry> = manifest.members.iter().collect();
        listed.sort_by(|a, b| (a.role.rank(), &a.path).cmp(&(b.role.rank(), &b.path)));
        let mut sorted_blobs = blobs.clone();
        sorted_blobs.sort_unstable();
        let expected: Vec<&str> = std::iter::once(MANIFEST_PATH)
            .chain(has_receipt.then_some(RECEIPT_PATH))
            .chain(listed.iter().map(|m| m.path.as_str()))
            .chain(sorted_blobs.iter().copied())
            .collect();
        let actual: Vec<&str> = zip.entries().iter().map(|e| e.name.as_str()).collect();
        if expected != actual {
            let at = expected
                .iter()
                .zip(&actual)
                .find(|(a, b)| a != b)
                .map(|(_, b)| (*b).to_owned())
                .unwrap_or_default();
            return Err(PackageError::container(
                "member_order",
                "entries are not in the canonical order (manifest, receipt, members by role, blobs by digest)",
            )
            .at(at));
        }
        let form = if blobs.is_empty() {
            Form::Thin
        } else {
            Form::Full
        };
        if form == Form::Thin && zip.len() > limits.max_thin_bytes {
            return Err(PackageError::new(
                ErrorCode::TooLarge,
                "container_size",
                format!(
                    "a thin package of {} bytes exceeds the limit of {}",
                    zip.len(),
                    limits.max_thin_bytes
                ),
            ));
        }
        let receipt = if has_receipt {
            let (bytes, _) = zip.read(RECEIPT_PATH, MAX_RECEIPT_BYTES)?;
            Some(Receipt::parse(&bytes)?)
        } else {
            None
        };
        if let Some(r) = &receipt {
            if r.package_id != package_id || r.form != form {
                return Err(PackageError::container(
                    "receipt_invalid",
                    "receipt.json does not describe this package",
                )
                .at(RECEIPT_PATH));
            }
        }
        Ok(Self {
            zip,
            manifest,
            manifest_bytes,
            package_id,
            receipt,
            form,
            limits,
            cli_evaluated: options.reader.cli_version.is_some(),
        })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn manifest_bytes(&self) -> &[u8] {
        &self.manifest_bytes
    }
    pub fn package_id(&self) -> &str {
        &self.package_id
    }
    pub fn receipt(&self) -> Option<&Receipt> {
        self.receipt.as_ref()
    }
    /// The container's form: thin when it holds no `blobs/`.
    pub fn form(&self) -> Form {
        self.form
    }

    pub fn inspection(&self) -> Inspection {
        Inspection {
            package_id: self.package_id.clone(),
            display_id: display_id(&self.package_id),
            form: self.form,
            container_bytes: self.zip.len(),
            zip64: self.zip.zip64(),
            entries: self.zip.entries().len(),
            manifest: self.manifest.clone(),
            receipt: self.receipt.clone(),
            cli_check: if self.cli_evaluated {
                "passed"
            } else {
                "not-evaluated"
            },
        }
    }

    /// A listed member's bytes, proven against its manifest digest.
    pub fn read_member(&mut self, path: &str) -> Result<Vec<u8>> {
        let m = self.manifest.member(path).cloned().ok_or_else(|| {
            PackageError::argument("member_path", format!("{path} is not a listed member"))
        })?;
        let (bytes, sha) = self.zip.read(path, self.limits.max_member_bytes)?;
        if sha != m.sha256 {
            return Err(PackageError::digest(
                "member_sha256",
                format!("{path} does not match its recorded hash"),
            )
            .at(path));
        }
        Ok(bytes)
    }

    /// Stream a blob into `sink`, proving it hashes to its name.
    pub fn copy_blob(&mut self, sha256: &str, sink: &mut dyn Write) -> Result<u64> {
        let name = blob_path(sha256);
        let size = self.zip.entry(&name).map(|e| e.size).ok_or_else(|| {
            PackageError::argument("blob", format!("blob {sha256} is not embedded"))
        })?;
        let got = self.zip.stream(&name, sink)?;
        if got != sha256 {
            return Err(PackageError::digest(
                "blob_name",
                format!("{name} holds bytes that hash to {got}"),
            )
            .at(name));
        }
        Ok(size)
    }

    /// Embedded blob digests, sorted.
    pub fn blob_digests(&self) -> Vec<String> {
        self.zip
            .entries()
            .iter()
            .filter_map(|e| blob_digest(&e.name).map(str::to_owned))
            .collect()
    }

    /// Hash every member and blob, then run every content check.
    pub fn verify(&mut self) -> Result<Verification> {
        let mut members = BTreeMap::new();
        let paths: Vec<String> = self
            .manifest
            .members
            .iter()
            .map(|m| m.path.clone())
            .collect();
        for path in paths {
            let bytes = self.read_member(&path)?;
            members.insert(path, bytes);
        }
        let catalog_sha = ActorClosure::parse(&members["actors/closure.json"])
            .map_err(|e| e.at("actors/closure.json"))?
            .members[ACTOR_CATALOG_PATH]
            .sha256
            .clone();
        let mut blobs = BTreeMap::new();
        let mut catalog_models = None;
        for sha in self.blob_digests() {
            let size = if sha == catalog_sha {
                let mut bytes = Vec::new();
                let n = self.copy_blob(&sha, &mut bytes)?;
                catalog_models = Some(bytes);
                n
            } else {
                self.copy_blob(&sha, &mut io::sink())?
            };
            blobs.insert(sha, size);
        }
        let content = check_contents(&ContentInput {
            manifest: &self.manifest,
            members: &members,
            blobs: &blobs,
            catalog_models: catalog_models.as_deref(),
            max_member_bytes: self.limits.max_member_bytes,
        })?;
        debug_assert_eq!(content.form, self.form);
        if let Some(r) = &self.receipt {
            r.check_against(&self.package_id, content.form, &content.embedded_blobs)?;
        }
        Ok(Verification {
            inspection: self.inspection(),
            content,
        })
    }

    /// Verify, then write the package into `dir` (created; must not exist or
    /// be empty): `manifest.json`, `receipt.json`, every member at its path,
    /// and blobs at `blobs/sha256/<aa>/<sha256>`. Names are allowlisted, so
    /// no path is taken from user text; every byte is re-proven while written.
    pub fn extract_to(&mut self, dir: &Path) -> Result<Verification> {
        let verification = self.verify()?;
        if dir.exists() && fs::read_dir(dir)?.next().is_some() {
            return Err(PackageError::argument(
                "extract_dir",
                format!("{} is not empty", dir.display()),
            ));
        }
        let write = |rel: &str, bytes: &[u8]| -> Result<()> {
            let path = dir.join(rel);
            fs::create_dir_all(path.parent().expect("member paths have a parent"))?;
            fs::write(path, bytes)?;
            Ok(())
        };
        write(MANIFEST_PATH, &self.manifest_bytes)?;
        if let Some(r) = &self.receipt {
            write(RECEIPT_PATH, &r.to_canonical_bytes()?)?;
        }
        let paths: Vec<String> = self
            .manifest
            .members
            .iter()
            .map(|m| m.path.clone())
            .collect();
        for path in paths {
            let bytes = self.read_member(&path)?;
            write(&path, &bytes)?;
        }
        for sha in self.blob_digests() {
            let rel = blob_path(&sha);
            let path: PathBuf = dir.join(&rel);
            fs::create_dir_all(path.parent().expect("blob paths have a parent"))?;
            let partial = path.with_extension("partial");
            let mut out = BufWriter::new(File::create(&partial)?);
            self.copy_blob(&sha, &mut out)?;
            out.flush()?;
            drop(out);
            fs::rename(partial, path)?;
        }
        Ok(verification)
    }
}

/// Open and fully verify a container held in memory.
pub fn verify_bytes(bytes: &[u8], options: &VerifyOptions) -> Result<Verification> {
    PackageReader::open(io::Cursor::new(bytes), options)?.verify()
}

/// Open and fully verify a container file.
pub fn verify_file(path: &Path, options: &VerifyOptions) -> Result<Verification> {
    PackageReader::open_file(path, options)?.verify()
}

/// Open a container (structure, manifest, skew) without hashing member data.
pub fn inspect_bytes(bytes: &[u8], options: &VerifyOptions) -> Result<Inspection> {
    Ok(PackageReader::open(io::Cursor::new(bytes), options)?.inspection())
}

/// The role order a writer and reader agree on, exposed for tooling.
pub fn container_order(manifest: &Manifest) -> Vec<String> {
    let mut listed: Vec<_> = manifest.members.iter().collect();
    listed.sort_by(|a, b| (a.role.rank(), &a.path).cmp(&(b.role.rank(), &b.path)));
    listed.into_iter().map(|m| m.path.clone()).collect()
}
