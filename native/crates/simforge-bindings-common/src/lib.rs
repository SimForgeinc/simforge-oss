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
pub const ENGINE_VERSION: &str = simforge_core::ENGINE_VERSION;
/// Default padded object slab per world; matches the pre-migration client cap.
pub const DEFAULT_MAX_OBJECTS: usize = 64;
/// Binding ABI version. Every host loader compares this against the value it
/// was compiled/typed for and refuses to load a mismatch; there is exactly one
/// supported ABI at a time. Bump on any change to exported names, argument
/// layouts (action row, actor row, batch buffers) or JSON metadata shapes.
///
/// History: 2 added `TrafficHandoff` and its actor/body row layouts.
pub const ABI_VERSION: u32 = 2;
