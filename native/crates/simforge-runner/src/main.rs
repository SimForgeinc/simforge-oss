//! `simforge-runner` executable. See `cli.rs` for the command contract and
//! `workloads/` for the engines linked into this binary.

use std::io::Write;

use simforge_runner::{cli, workloads};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let result = cli::parse(args).and_then(|invocation| {
        workloads::registry().and_then(|engines| cli::execute(invocation, &engines, &mut out))
    });
    let _ = out.flush();
    if let Err(error) = result {
        let report = serde_json::to_string(&error.report()).unwrap_or_else(|_| {
            format!("{{\"code\":\"{}\",\"reason\":\"{}\"}}", error.code(), error)
        });
        let _ = writeln!(std::io::stderr(), "{report}");
        std::process::exit(error.exit_class() as i32);
    }
}
