//! Content digests. Every input, checkpoint and artifact the runner touches is
//! identified by `sha256` + byte length, matching the cloud worker's
//! `{sha256, sizeBytes}` input/artifact contract.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::error::{Result, RunnerError};

/// A lowercase hex sha256 with its byte length.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDigest {
    pub sha256: String,
    pub size_bytes: u64,
}

pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(TABLE[(byte >> 4) as usize] as char);
        out.push(TABLE[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Streams a file through sha256 with a fixed 1 MiB buffer.
pub fn hash_file(path: &Path) -> Result<ContentDigest> {
    let file = File::open(path).map_err(|source| RunnerError::io(path, source))?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut size_bytes = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|source| RunnerError::io(path, source))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size_bytes += read as u64;
    }
    Ok(ContentDigest {
        sha256: hex(&hasher.finalize()),
        size_bytes,
    })
}

/// Verifies a file against an expected digest, returning the actual digest.
pub fn verify_file(path: &Path, expected: &ContentDigest) -> Result<ContentDigest> {
    let actual = hash_file(path)?;
    if actual != *expected {
        return Err(RunnerError::Integrity {
            path: path.to_path_buf(),
            expected_sha256: expected.sha256.clone(),
            expected_size: expected.size_bytes,
            actual_sha256: actual.sha256,
            actual_size: actual.size_bytes,
        });
    }
    Ok(actual)
}

/// Canonical JSON: keys sorted (serde_json's default `BTreeMap` map), no
/// whitespace, UTF-8. This is the byte form hashed for manifest identity.
pub fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let value = serde_json::to_value(value).map_err(|source| RunnerError::Json {
        path: "<memory>".into(),
        source,
    })?;
    serde_json::to_vec(&value).map_err(|source| RunnerError::Json {
        path: "<memory>".into(),
        source,
    })
}

pub fn canonical_sha256<T: Serialize>(value: &T) -> Result<String> {
    Ok(sha256_hex(&canonical_json(value)?))
}
