//! `simforge-render`: the SimForge Renderer. See `render_service::cli`.
fn main() -> anyhow::Result<()> {
    render_service::cli::main(std::env::args().collect())
}
