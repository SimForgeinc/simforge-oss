//! Profile-aware native sensor capture with explicit cadence and product controls.
//! Fidelity and repeatability limits are measured in TICK-REALTIME-REPORT.md.

use anyhow::Result;
use clap::Parser;
use sensors::capture::{run_capture, CaptureArgs};

fn main() -> Result<()> {
    let args = CaptureArgs::parse();
    run_capture(args)
}
