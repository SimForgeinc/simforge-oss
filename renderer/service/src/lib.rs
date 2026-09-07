//! service: long-lived native render service (WSB5).
//!
//! Map prewarmed once, then `(scene-state tick, rig, profile)` requests over
//! a local endpoint return frame sets. Transport mirrors rl-env's env-server:
//! u32-LE length-prefixed msgpack frames with a flat `{i, op}` envelope and a
//! hard 64 MiB frame cap. The endpoint is a Unix-domain socket on Unix and a
//! local named pipe on Windows ([`endpoint`]); frame payloads are handed off
//! through a memory-mapped ring file ([`shm`]) on every OS.
pub mod carla;
pub mod endpoint;
pub mod proto;
pub mod scene;
pub mod server;
pub mod shm;
