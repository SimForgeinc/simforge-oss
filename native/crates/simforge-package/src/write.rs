//! The writer. It computes `manifest.members` from the bytes it is given,
//! runs the same content checks as the verifier, and only then streams the
//! container, so it never emits a package the reader would refuse.
//!
//! Determinism (section 3.2): for one build of this crate, the same manifest
//! draft, members, blobs and receipt input give byte-identical containers.
//! The hosted exporter (via the Node binding) and the CLI share this code.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};
use simforge_core::hash::sha256_bytes;

use crate::check::{check_contents, ContentInput, ContentReport};
use crate::closure::{ActorClosure, ACTOR_CATALOG_PATH};
use crate::error::{ErrorCode, PackageError, Result};
use crate::manifest::{BlobCount, Manifest, MemberEntry};
use crate::names::{blob_is_precompressed, blob_path, is_hex64, Role, MANIFEST_PATH, RECEIPT_PATH};
use crate::receipt::{Form, Receipt, ReceiptInput};
use crate::zip::{zip64_required, Limits, Method, ZipWriter};

/// Where a blob's bytes come from. Files are streamed, never loaded whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobSource {
    Bytes(Vec<u8>),
    File(PathBuf),
}

#[derive(Debug, Clone)]
struct Blob {
    size: u64,
    source: BlobSource,
}

/// The result of a write.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub package_id: String,
    pub form: Form,
    pub container_bytes: u64,
    pub zip64: bool,
    pub embedded_blobs: BlobCount,
    #[serde(skip)]
    pub manifest: Manifest,
    #[serde(skip)]
    pub manifest_bytes: Vec<u8>,
    pub receipt: Option<Receipt>,
    pub content: ContentReport,
}

#[derive(Debug, Clone)]
pub struct PackageBuilder {
    draft: Map<String, Value>,
    members: BTreeMap<String, Vec<u8>>,
    blobs: BTreeMap<String, Blob>,
    receipt: Option<ReceiptInput>,
    limits: Limits,
}

impl PackageBuilder {
    /// Start from a manifest draft: the whole v1 manifest except `members`,
    /// which the builder computes from the member bytes.
    pub fn new(draft: Value) -> Result<Self> {
        let Value::Object(draft) = draft else {
            return Err(PackageError::argument(
                "draft",
                "the manifest draft must be a JSON object",
            ));
        };
        if draft.contains_key("members") {
            return Err(PackageError::argument(
                "draft_members",
                "the manifest draft must not carry members[]; the writer computes it from the member bytes",
            ));
        }
        Ok(Self {
            draft,
            members: BTreeMap::new(),
            blobs: BTreeMap::new(),
            receipt: None,
            limits: Limits::default(),
        })
    }

    pub fn from_draft_json(json: &str) -> Result<Self> {
        let value = serde_json::from_str(json).map_err(|e| {
            PackageError::argument("draft", format!("the manifest draft is not JSON: {e}"))
        })?;
        Self::new(value)
    }

    /// Limits the output must satisfy (the reader's defaults unless changed).
    pub fn limits(&mut self, limits: Limits) -> &mut Self {
        self.limits = limits;
        self
    }

    /// Add a listed member (`document.json`, `timeline/<sha>.json`, ...).
    pub fn member(&mut self, path: &str, bytes: Vec<u8>) -> Result<&mut Self> {
        if Role::of_path(path).is_none() {
            return Err(PackageError::argument(
                "member_path",
                format!("{path:?} is not a member path of simforge.scenario-package/v1"),
            ));
        }
        if self.members.contains_key(path) {
            return Err(PackageError::argument(
                "member_duplicate",
                format!("{path} was added twice"),
            ));
        }
        self.members.insert(path.to_owned(), bytes);
        Ok(self)
    }

    /// Embed a blob held in memory. Returns its digest. The same bytes added
    /// twice are one blob.
    pub fn blob(&mut self, bytes: Vec<u8>) -> String {
        let sha = sha256_bytes(&bytes);
        self.blobs.entry(sha.clone()).or_insert(Blob {
            size: bytes.len() as u64,
            source: BlobSource::Bytes(bytes),
        });
        sha
    }

    /// Embed a blob from a file whose digest the caller asserts. The digest
    /// is proven while the file is streamed; a mismatch fails the write.
    pub fn blob_file(&mut self, sha256: &str, path: &Path) -> Result<&mut Self> {
        if !is_hex64(sha256) {
            return Err(PackageError::argument(
                "blob",
                format!("{sha256:?} is not a sha256"),
            ));
        }
        let size = std::fs::metadata(path)?.len();
        self.blobs.entry(sha256.to_owned()).or_insert(Blob {
            size,
            source: BlobSource::File(path.to_owned()),
        });
        Ok(self)
    }

    pub fn receipt(&mut self, receipt: ReceiptInput) -> &mut Self {
        self.receipt = Some(receipt);
        self
    }

    /// The manifest this builder writes: the draft plus computed members.
    pub fn manifest(&self) -> Result<Manifest> {
        let mut value = self.draft.clone();
        let members: Vec<Value> = self
            .members
            .iter()
            .map(|(path, bytes)| {
                let role = Role::of_path(path).expect("checked on insert");
                serde_json::json!({
                    "path": path,
                    "role": role,
                    "sha256": sha256_bytes(bytes),
                    "size": bytes.len() as u64,
                    "mediaType": role.media_type(),
                })
            })
            .collect();
        value.insert("members".to_owned(), Value::Array(members));
        let mut manifest: Manifest = serde_json::from_value(Value::Object(value))
            .map_err(|e| PackageError::manifest("schema", e.to_string()))?;
        let schemas: Vec<Option<String>> = manifest
            .members
            .iter()
            .map(|m| manifest.expected_member_schema(m.role))
            .collect();
        for (m, schema) in manifest.members.iter_mut().zip(schemas) {
            m.schema = schema;
        }
        // The same strict path the reader takes: typed round trip + invariants.
        Manifest::from_value(
            serde_json::to_value(&manifest)
                .map_err(|e| PackageError::manifest("schema", e.to_string()))?,
        )?;
        // And the draft itself must not carry values the typed form drops.
        let mut roundtrip = serde_json::to_value(&manifest).expect("serialisable");
        let mut given = Value::Object(self.draft.clone());
        if let (Value::Object(a), Value::Object(b)) = (&mut roundtrip, &mut given) {
            a.remove("members");
            b.remove("members");
        }
        if simforge_core::hash::canonical_json(&roundtrip).ok()
            != simforge_core::hash::canonical_json(&given).ok()
        {
            return Err(PackageError::manifest(
                "schema",
                "the draft carries a value the manifest cannot represent (null for an absent optional, or a non-integer count)",
            ));
        }
        Ok(manifest)
    }

    fn catalog_models(&self) -> Result<Option<Vec<u8>>> {
        let Some(bytes) = self.members.get("actors/closure.json") else {
            return Ok(None);
        };
        let closure = ActorClosure::parse(bytes).map_err(|e| e.at("actors/closure.json"))?;
        let sha = &closure.members[ACTOR_CATALOG_PATH].sha256;
        let Some(blob) = self.blobs.get(sha) else {
            return Ok(None);
        };
        if blob.size > self.limits.max_member_bytes {
            return Err(PackageError::new(
                ErrorCode::LimitExceeded,
                "member_size",
                format!("{ACTOR_CATALOG_PATH} is {} bytes", blob.size),
            ));
        }
        let bytes = match &blob.source {
            BlobSource::Bytes(b) => b.clone(),
            BlobSource::File(p) => std::fs::read(p)?,
        };
        if sha256_bytes(&bytes) != *sha {
            return Err(PackageError::argument(
                "blob_digest",
                format!("the {ACTOR_CATALOG_PATH} blob does not hash to {sha}"),
            ));
        }
        Ok(Some(bytes))
    }

    /// Check everything, then write the container to `out` (from offset 0).
    pub fn write_to<W: Write + Seek>(&self, out: W) -> Result<(WriteOutcome, W)> {
        let manifest = self.manifest()?;
        let manifest_bytes = manifest.to_canonical_bytes()?;
        let package_id = sha256_bytes(&manifest_bytes);
        for (path, bytes) in &self.members {
            if bytes.len() as u64 > self.limits.max_member_bytes {
                return Err(PackageError::new(
                    ErrorCode::LimitExceeded,
                    "member_size",
                    format!(
                        "{path} is {} bytes; the limit is {}",
                        bytes.len(),
                        self.limits.max_member_bytes
                    ),
                )
                .at(path.clone()));
            }
        }
        let blob_sizes: BTreeMap<String, u64> = self
            .blobs
            .iter()
            .map(|(k, b)| (k.clone(), b.size))
            .collect();
        let catalog_models = self.catalog_models()?;
        let content = check_contents(&ContentInput {
            manifest: &manifest,
            members: &self.members,
            blobs: &blob_sizes,
            catalog_models: catalog_models.as_deref(),
            max_member_bytes: self.limits.max_member_bytes,
        })?;
        let receipt = self
            .receipt
            .as_ref()
            .map(|input| {
                Receipt::new(
                    input,
                    &package_id,
                    content.form,
                    content.embedded_blobs.clone(),
                )
            })
            .transpose()?;
        let receipt_bytes = receipt
            .as_ref()
            .map(Receipt::to_canonical_bytes)
            .transpose()?;

        let mut order: Vec<&MemberEntry> = manifest.members.iter().collect();
        order.sort_by(|a, b| (a.role.rank(), &a.path).cmp(&(b.role.rank(), &b.path)));
        let count = 1 + usize::from(receipt_bytes.is_some()) + order.len() + self.blobs.len();
        let total: u64 = manifest_bytes.len() as u64
            + receipt_bytes.as_ref().map_or(0, |r| r.len() as u64)
            + self.members.values().map(|b| b.len() as u64).sum::<u64>()
            + self.blobs.values().map(|b| b.size).sum::<u64>();
        let zip64 = zip64_required(count, total);
        let mut zip = ZipWriter::new(out, zip64)?;
        zip.add(
            MANIFEST_PATH,
            Method::Deflate,
            manifest_bytes.len() as u64,
            &mut &manifest_bytes[..],
        )?;
        if let Some(r) = &receipt_bytes {
            zip.add(RECEIPT_PATH, Method::Deflate, r.len() as u64, &mut &r[..])?;
        }
        for m in order {
            let bytes = &self.members[&m.path];
            let method = if m.role.stored() {
                Method::Store
            } else {
                Method::Deflate
            };
            zip.add(&m.path, method, bytes.len() as u64, &mut &bytes[..])?;
        }
        for (sha, blob) in &self.blobs {
            let name = blob_path(sha);
            let written = match &blob.source {
                BlobSource::Bytes(bytes) => {
                    let method = if blob_is_precompressed(&bytes[..bytes.len().min(16)]) {
                        Method::Store
                    } else {
                        Method::Deflate
                    };
                    zip.add(&name, method, blob.size, &mut &bytes[..])?
                }
                BlobSource::File(path) => {
                    let mut file = BufReader::new(File::open(path)?);
                    let mut head = [0u8; 16];
                    let n = read_head(&mut file, &mut head)?;
                    file.seek(SeekFrom::Start(0))?;
                    let method = if blob_is_precompressed(&head[..n]) {
                        Method::Store
                    } else {
                        Method::Deflate
                    };
                    zip.add(&name, method, blob.size, &mut file)?
                }
            };
            if &written.sha256 != sha {
                return Err(PackageError::argument(
                    "blob_digest",
                    format!("the blob given as {sha} hashes to {}", written.sha256),
                )
                .at(name));
            }
        }
        let (out, container_bytes) = zip.finish()?;
        let limit = match content.form {
            Form::Thin => self.limits.max_thin_bytes,
            Form::Full => self.limits.max_full_bytes,
        };
        if container_bytes > limit {
            return Err(PackageError::new(
                ErrorCode::TooLarge,
                "container_size",
                format!(
                    "the {} package is {container_bytes} bytes; readers accept at most {limit}",
                    content.form.as_str()
                ),
            ));
        }
        Ok((
            WriteOutcome {
                package_id,
                form: content.form,
                container_bytes,
                zip64,
                embedded_blobs: content.embedded_blobs.clone(),
                manifest,
                manifest_bytes,
                receipt,
                content,
            },
            out,
        ))
    }

    /// Write into memory.
    pub fn to_bytes(&self) -> Result<(WriteOutcome, Vec<u8>)> {
        let (outcome, cursor) = self.write_to(io::Cursor::new(Vec::new()))?;
        Ok((outcome, cursor.into_inner()))
    }

    /// Write to `path` via a sibling temporary file, renamed into place only
    /// after the container is complete.
    pub fn write_file(&self, path: &Path) -> Result<WriteOutcome> {
        let partial = path.with_extension("zip.partial");
        let result = (|| {
            let file = File::create(&partial)?;
            let (outcome, file) = self.write_to(io::BufWriter::new(file))?;
            file.into_inner()
                .map_err(|e| PackageError::io(e.into_error()))?
                .sync_all()?;
            Ok(outcome)
        })();
        match result {
            Ok(outcome) => {
                std::fs::rename(&partial, path)?;
                Ok(outcome)
            }
            Err(e) => {
                let _ = std::fs::remove_file(&partial);
                Err(e)
            }
        }
    }
}

fn read_head(r: &mut dyn Read, buf: &mut [u8]) -> Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(n)
}
