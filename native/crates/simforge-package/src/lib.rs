//! `simforge-package`: SimForge scenario packages, `simforge.scenario-package/v1`
//! (`docs/engineering/scenario-package.md`).
//!
//! A scenario package is the self-contained, verifiable form of one authored
//! scenario revision: the document, the trace it was simulated to, its render
//! timeline(s), and every digest needed to replay that motion elsewhere. Its
//! id is the sha256 of its canonical manifest. Thin packages name the map and
//! actor closures by digest; full packages also embed their blobs. Both forms
//! of one revision share one id.
//!
//! - [`PackageBuilder`] writes a package (the CLI, and the hosted exporter
//!   through the Node binding, so both emit byte-identical containers);
//! - [`PackageReader`] opens one (structure, manifest, version skew), then
//!   [`PackageReader::verify`] hashes every member and runs every cross-check;
//!   [`PackageReader::extract_to`] unpacks a verified package;
//! - [`verify_bytes`] / [`verify_file`] / [`inspect_bytes`] are the one-call forms.
//!
//! Every refusal is a [`PackageError`] with a stable `code` and the exact `rule`.

pub mod check;
pub mod closure;
pub mod error;
pub mod manifest;
pub mod names;
pub mod receipt;
pub mod skew;
pub mod verify;
pub mod write;
pub mod zip;

pub use check::{ContentReport, TimelineReport, TraceReport};
pub use error::{ErrorCode, PackageError, Result, SkewDimension};
pub use manifest::{Manifest, MemberEntry, Producer, SCHEMA};
pub use names::Role;
pub use receipt::{Form, Receipt, ReceiptInput, RECEIPT_SCHEMA};
pub use skew::ReaderSupport;
pub use verify::{
    container_order, display_id, file_name, inspect_bytes, verify_bytes, verify_file, Inspection,
    PackageReader, Verification, VerifyOptions,
};
pub use write::{BlobSource, PackageBuilder, WriteOutcome};
pub use zip::Limits;

/// `application/vnd.simforge.scenario-package+zip`.
pub const MEDIA_TYPE: &str = "application/vnd.simforge.scenario-package+zip";
