//! The command tree. One module per top-level command; each exposes clap
//! argument types and `run(args, ctx) -> CmdResult`.

use clap::{Subcommand, ValueEnum};
use serde_json::json;

use crate::contract::{CliError, CmdResult, Ctx};

pub mod assets;
mod authoring_support;
pub mod doctor;
pub mod env;
pub mod instantiate;
pub mod locations;
pub mod maps;
pub mod package;
pub mod render;
pub mod simulate;
pub mod sites;
pub mod skills;
pub mod timeline;

/// Commands whose surface is fixed but whose implementation has not landed.
/// `--help` marks them `"status": "planned"` and running one fails loudly
/// with `not_implemented` (exit 1). Each command's PR removes its entry.
pub const PLANNED: &[&str] = &[];

/// The one render preset definition lives in the renderer
/// (`render_core::render_config::Preset`); these are its names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Preset {
    /// The fastest configuration that keeps every effect of the look; only quality levels are lower.
    Training,
    /// About 90-95% of the engine's maximum perceptual quality.
    Showcase,
}

impl Preset {
    pub fn as_str(self) -> &'static str {
        match self {
            Preset::Training => "training",
            Preset::Showcase => "showcase",
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Check this machine: GPU adapter, ffmpeg, cache roots, disk, registry reachability.
    Doctor(doctor::DoctorArgs),
    /// Content-addressed map releases.
    #[command(subcommand)]
    Maps(maps::MapsCommand),
    /// The actor-asset closure (vehicle, walker and prop models) with its attribution.
    #[command(subcommand)]
    Assets(assets::AssetsCommand),
    /// Render timelines built from canonical traces.
    #[command(subcommand)]
    Timeline(timeline::TimelineCommand),
    /// Render a workspace offline: frames, id/depth/seg, lidar/radar, results.json, video.
    Render(render::RenderArgs),
    /// Re-simulate a workspace from its resolution (labelled "re-simulated").
    Simulate(simulate::SimulateArgs),
    /// Closed-loop episodes.
    #[command(subcommand)]
    Env(env::EnvCommand),
    /// simforge.scenario-package/v1 containers.
    #[command(subcommand)]
    Package(package::PackageCommand),
    /// The agent skills bundled with this binary.
    #[command(subcommand)]
    Skills(skills::SkillsCommand),
    /// Concrete sites for a template's anchor on installed maps.
    #[command(subcommand)]
    Sites(sites::SitesCommand),
    /// Template x site x draw -> one concrete scenario instance.
    Instantiate(instantiate::InstantiateArgs),
    /// Query an installed map's location catalog: handles, never road ids.
    #[command(subcommand)]
    Locations(locations::LocationsCommand),
}

pub fn dispatch(command: Command, ctx: &Ctx) -> CmdResult {
    match command {
        Command::Doctor(args) => doctor::run(args, ctx),
        Command::Maps(cmd) => maps::run(cmd, ctx),
        Command::Assets(cmd) => assets::run(cmd, ctx),
        Command::Timeline(cmd) => timeline::run(cmd, ctx),
        Command::Render(args) => render::run(args, ctx),
        Command::Simulate(args) => simulate::run(args, ctx),
        Command::Env(cmd) => env::run(cmd, ctx),
        Command::Package(cmd) => package::run(cmd, ctx),
        Command::Skills(cmd) => skills::run(cmd, ctx),
        Command::Sites(cmd) => sites::run(cmd, ctx),
        Command::Instantiate(args) => instantiate::run(args, ctx),
        Command::Locations(cmd) => locations::run(cmd, ctx),
    }
}

/// The loud failure for a [`PLANNED`] command.
pub fn not_implemented(command: &str) -> CliError {
    debug_assert!(
        PLANNED.contains(&command),
        "{command} is not listed in PLANNED"
    );
    CliError::new(
        "not_implemented",
        format!(
            "`simforge {command}` is part of the CLI surface but is not implemented in this build"
        ),
    )
    .with_path(command.to_owned())
    .with_detail(json!({ "version": env!("CARGO_PKG_VERSION") }))
}
