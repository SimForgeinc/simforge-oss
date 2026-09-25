//! Test access to the CARLA-derived model packs. Their bytes are not in git:
//! each pack is a content-addressed closure pinned in
//! `catalog/closures.lock.json`, fetched by digest into the shared asset cache
//! (`simforge-assets`, the library behind `simforge assets pull`) and laid out
//! as the pack directory. An unreachable or non-verifying asset fails the test
//! with its digest and URL; nothing is substituted.
//!
//! Shared by the crate's unit tests and `tests/walker_grounding.rs` (`#[path]`).

use std::path::{Path, PathBuf};

/// The materialized directory of pack `name` (`vehicles-carla`, `pedestrians-carla`).
pub fn pack(name: &str) -> PathBuf {
    let lock_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../catalog/closures.lock.json");
    let lock = simforge_assets::Lock::load(&lock_path)
        .unwrap_or_else(|e| panic!("model pack {name}: {e}"));
    let id = lock
        .get(name)
        .unwrap_or_else(|e| panic!("model pack {name}: {e}"));
    let store = simforge_assets::Store::from_env(Some(&lock.origin));
    store
        .materialize(&id, &mut |_| {})
        .unwrap_or_else(|e| {
            panic!(
                "model pack {name} (closure {}) could not be materialized into {}: {e}",
                id.sha256,
                store.cache_dir().display()
            )
        })
        .directory
}
