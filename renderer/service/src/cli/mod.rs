//! The `simforge-render` command line: one binary for every native render
//! path.
//!
//! * `serve`: the render service (protocol 5): batch jobs and closed-loop
//!   episodes.
//! * `job`: render a job offline through the same service code path.
//! * `view`: the interactive editor viewport.
//! * `dev <tool>`: internal developer tools (`parity-check`, `sky-bench`,
//!   `ktx2-gpu-variant`).
pub mod job;
pub mod serve;

const USAGE: &str = "usage: simforge-render <serve|job|view|dev> [args...]\n\
    serve  the render service (protocol 5): batch render jobs and closed-loop episodes\n\
    job    render a job offline through the service code path (also profiling/sweeps)\n\
    view   the interactive editor viewport\n\
    dev    internal tools: parity-check | sky-bench | ktx2-gpu-variant\n\
    Every subcommand takes --help.";

/// Dispatch `argv` (program name first).
pub fn main(argv: Vec<String>) -> anyhow::Result<()> {
    let mut args = argv.into_iter();
    let program = args.next().unwrap_or_else(|| "simforge-render".into()); // fallback-ok: argv[0] is only used to name the program in help text
    let Some(command) = args.next() else {
        anyhow::bail!("{USAGE}");
    };
    let rest: Vec<String> = args.collect();
    match command.as_str() {
        "serve" => serve::run(rest),
        "job" => job::run(rest),
        #[cfg(feature = "view")]
        "view" => simforge_render_view::run(
            std::iter::once(format!("{program} view"))
                .chain(rest)
                .collect(),
        ),
        #[cfg(not(feature = "view"))]
        "view" => anyhow::bail!(
            "this build of simforge-render is headless (built without the `view` feature); the interactive viewport is not available"
        ),
        "dev" => {
            let mut rest = rest.into_iter();
            let tool = rest.next().ok_or_else(|| anyhow::anyhow!("usage: simforge-render dev <parity-check|sky-bench|ktx2-gpu-variant> [args...]"))?;
            let argv: Vec<String> = std::iter::once(format!("{program} dev {tool}"))
                .chain(rest)
                .collect();
            match tool.as_str() {
                "parity-check" => render_core::dev::parity_check::run(argv),
                "sky-bench" => render_core::dev::sky_bench::run(argv),
                "ktx2-gpu-variant" => render_core::dev::ktx2_gpu_variant::run(argv),
                other => anyhow::bail!(
                    "unknown dev tool {other:?} (parity-check | sky-bench | ktx2-gpu-variant)"
                ),
            }
        }
        "--help" | "-h" | "help" => {
            println!("{USAGE}");
            Ok(())
        }
        other => anyhow::bail!("unknown subcommand {other:?}\n{USAGE}"),
    }
}
