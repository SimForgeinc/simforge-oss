//! `simforge-authoring`: the logic behind the `simforge` CLI's authoring
//! commands (`template`, `sites`, `instantiate`, `variation`, `batch`,
//! `catalog`, `locations`), over maps installed by `simforge maps pull`.
//!
//! Every semantic step (matching, materialisation, lifting, simulation,
//! evaluation) is the compiler's and the engine's own; this crate adds the
//! authoring file formats, the ranked views the CLI prints, and the pieces of
//! authoring that are not engine semantics (the location query, the scenario
//! catalog, batch planning and evidence checks). Errors are the compiler's
//! structured `{code, path?, reason, detail?}` with `findings` selecting exit 2.

pub mod batch;
pub mod engine;
pub mod evaluate;
pub mod evidence;
pub mod instance;
pub mod jsfmt;
pub mod json;
pub mod jsvalue;
pub mod locations;
pub mod maps;
pub mod metrics;
pub mod paths;
pub mod sites;
pub mod template;
pub mod template_new;
pub mod validate;
pub mod variation;

pub use simforge_compiler::CompileError;
