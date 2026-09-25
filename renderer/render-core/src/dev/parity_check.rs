//! `parity-check`: renderer parity fixture validation for the Bevy renderer.
//!
//! Recomputes actor world matrices and derived vehicle light states from a
//! `simforge.renderer-parity-fixture/v1` document and compares them against
//! the fixture expectations within the authored tolerances. Optionally
//! extracts the embedded scene-state, the `sceneState` input of a
//! `simforge-render job`:
//!
//! ```text
//! simforge-render dev parity-check \
//!   --fixture fixtures/renderer-contract/basic-intersection.v1.json \
//!   --extract-scene /tmp/fixture-scene.json
//! ```

use std::path::PathBuf;

use crate::fixture::{check_fixture, ParityFixture};
use clap::Parser;

#[derive(Parser, Debug)]
struct Args {
    /// Parity fixture document (simforge.renderer-parity-fixture/v1).
    #[arg(long)]
    fixture: PathBuf,
    /// Write the embedded scene-state.v1 document here (a job's `sceneState`).
    #[arg(long)]
    extract_scene: Option<PathBuf>,
}

pub fn run(args: Vec<String>) -> anyhow::Result<()> {
    let args = Args::parse_from(args);
    let fixture = ParityFixture::load(&args.fixture)?;

    if let Some(path) = &args.extract_scene {
        std::fs::write(path, serde_json::to_string_pretty(&fixture.scene_state)?)?;
        eprintln!("scene-state written to {}", path.display());
    }
    let report = check_fixture(&fixture)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !report.pass {
        std::process::exit(1);
    }
    Ok(())
}
