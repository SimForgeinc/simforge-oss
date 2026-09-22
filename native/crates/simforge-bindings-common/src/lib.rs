//! Language-neutral glue shared by the Node, WASM and Python bindings.
//!
//! Every binding is a thin translation of host values to and from the types in
//! this crate; engine, session and compiler semantics live upstream and are
//! never re-implemented here. What this crate adds:
//!
//! - one error surface ([`error::BindingError`]) with host exception classes;
//! - the flat `f64` action row ([`action`]) shared by all hosts;
//! - asset caching / scenario parsing helpers ([`assets`]);
//! - [`runtime`]: handle types (`Scenario`, `Graph`, `Env`, `Batch`, `World`,
//!   `Policy`, `Compiled`, `Handoff`) whose methods return plain slices/owned buffers and
//!   JSON strings for metadata, so hosts copy exactly once into their own
//!   arrays and nothing aliases live engine state.

pub mod action;
pub mod assets;
pub mod error;
pub mod runtime;

pub use error::{BindingError, ErrorKind, Result};

/// Fixed-step engine rate exposed to hosts.
pub const ENGINE_HZ: u32 = simforge_session::episode::ENGINE_HZ;
pub const STATE_VECTOR_SIZE: usize = simforge_session::observation::STATE_VECTOR_SIZE;
pub const OBJECT_FEATURES: usize = simforge_session::batch::OBJECT_FEATURES;
pub const BEV_CHANNELS: usize = simforge_session::observation::BEV_CHANNELS;
/// Engine semantics version (see [`simforge_core::ENGINE_SEM_VER`]).
pub const ENGINE_SEM_VER: &str = simforge_core::ENGINE_SEM_VER;
/// Former name of [`ENGINE_SEM_VER`]; always the same value.
pub const ENGINE_VERSION: &str = simforge_core::ENGINE_SEM_VER;
/// Default padded object slab per world; matches the pre-migration client cap.
pub const DEFAULT_MAX_OBJECTS: usize = 64;
/// Binding ABI version. Every host loader compares this against the value it
/// was compiled/typed for and refuses to load a mismatch; there is exactly one
/// supported ABI at a time. Bump on any change to exported names, argument
/// layouts (action row, actor row, batch buffers) or JSON metadata shapes.
///
/// History: 2 added `TrafficHandoff` and its actor/body row layouts; 3 widened
/// world snapshot pose rows to `(N, 6)` with `longitudinalSpeedMps`.
pub const ABI_VERSION: u32 = 3;

/// Build provenance of this binary (source revision, toolchain, profile,
/// target), as JSON. Provenance ONLY: nothing may key a cache or a
/// compatibility decision on it. Trace compatibility is [`ENGINE_SEM_VER`].
///
/// `buildDigest` is `sha256(canonicalJson({abiVersion, engineSemVer, profile,
/// rustc, sourceRevision, target}))`.
pub fn engine_build_json() -> String {
    let fields = serde_json::json!({
        "engineSemVer": ENGINE_SEM_VER,
        "abiVersion": ABI_VERSION,
        "sourceRevision": env!("SIMFORGE_BUILD_SOURCE_REVISION"),
        "rustc": env!("SIMFORGE_BUILD_RUSTC"),
        "profile": env!("SIMFORGE_BUILD_PROFILE"),
        "target": env!("SIMFORGE_BUILD_TARGET"),
    });
    let digest = simforge_core::hash::content_hash(&fields).unwrap_or_default();
    let mut out = fields;
    out["buildDigest"] = serde_json::Value::String(digest);
    simforge_core::hash::canonical_json(&out).unwrap_or_default()
}
