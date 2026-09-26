//! The residency reader (the renderer's default asset source) must not hold
//! asset files open after it has handed a load its reader: the asset server
//! starts every texture load of a map at once and a loader keeps its reader
//! until it has decoded, so a map with more textures than the open-file limit
//! used to fail with "Too many open files" (os error 24).
//!
//! This test lowers its own RLIMIT_NOFILE (soft and hard) to 256 and keeps the
//! readers of 3,000 files alive at once. It is alone in this test binary, so
//! the lowered limit affects no other test.
#![cfg(unix)]

use std::path::Path;
use std::sync::{Arc, RwLock};

use bevy::asset::io::{AssetReader, Reader};
use render_core::texture_residency::{ResidencyReader, MAX_OPEN_FILES};

const LIMIT: u64 = 256;
const FILES: usize = 3_000;

#[test]
fn more_asset_files_than_the_open_file_limit_load_without_holding_them_open() {
    assert!(
        MAX_OPEN_FILES as u64 * 2 < LIMIT,
        "the bound must leave headroom under the test limit"
    );
    let dir = std::env::temp_dir().join(format!("simforge-open-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for i in 0..FILES {
        std::fs::write(
            dir.join(format!("t{i}.bin")),
            format!("texture {i}").repeat(64),
        )
        .unwrap();
    }
    let lim = libc::rlimit {
        rlim_cur: LIMIT as libc::rlim_t,
        rlim_max: LIMIT as libc::rlim_t,
    };
    // SAFETY: a plain struct we own; lowers this process's own limit.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) }, 0);

    let reader = ResidencyReader::new(dir.to_str().unwrap(), Arc::new(RwLock::new(None)));
    // The readers borrow their paths, so the names outlive them.
    let names: Vec<String> = (0..FILES).map(|i| format!("t{i}.bin")).collect();
    let bodies = bevy::tasks::block_on(async {
        let mut open: Vec<Box<dyn Reader + '_>> = Vec::with_capacity(FILES);
        for name in &names {
            let r = reader
                .read(Path::new(name))
                .await
                .unwrap_or_else(|e| panic!("read {name} with {} readers alive: {e}", open.len()));
            open.push(r);
        }
        let mut bodies = Vec::with_capacity(FILES);
        for r in &mut open {
            let mut bytes = Vec::new();
            r.read_to_end(&mut bytes).await.unwrap();
            bodies.push(bytes);
        }
        bodies
    });
    assert_eq!(bodies.len(), FILES);
    assert_eq!(
        bodies[FILES - 1],
        format!("texture {}", FILES - 1).repeat(64).into_bytes()
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
