//! `simforge-compiler` — the SIMFORGE scenario/world compiler.
//!
//! `template × map × site × draw -> SimScenarioInput` with identity:
//!
//! - [`template`]: the typed authored v2 document (expressions parsed,
//!   defaults materialised).
//! - [`expr`] / [`params`]: the closed numeric expression language and the
//!   seeded per-cell parameter draw.
//! - [`map_index`] / [`bundle`]: the matcher's derived view of a map and the
//!   join of every map producer artifact (`MapBundle`).
//! - [`anchor`]: `LogicalAnchor -> ranked MatchedSite[]`, a pure function of
//!   `(anchor, derived index)`.
//! - [`map_signals`] / [`signal_plan`]: physical signal furniture bound to
//!   engine programs, and authored map signal plans compiled onto them.
//! - [`catalog`] / [`perception`]: asset metadata and the sensor/atmosphere
//!   lowering.
//! - [`ambient`]: generated background traffic and its warm-up.
//! - [`materialize`] / [`sites`]: concrete instance compilation and site selection.
//! - [`situation`]: source-bound transactions, rehearsal, solving and comparison.
//!
//! The engine, solvers, physics and map geometry live in `simforge_core`; this
//! crate produces their input and never re-implements them.

pub mod ambient;
pub mod anchor;
pub mod bundle;
pub mod catalog;
pub mod error;
pub mod expr;
pub mod geometry;
pub mod invariants;
pub mod map_index;
pub mod map_signals;
pub mod materialize;
pub mod params;
pub mod perception;
pub mod signal_plan;
pub mod sites;
pub mod situation;
pub mod template;

pub use ambient::{
    apply_ambient_traffic, prune_dangling_after_interactions, resolve_ambient_traffic_profile,
    settle_ambient_traffic, AmbientSettleOptions, AmbientSettleProvenance, AmbientTrafficOptions,
    AmbientTrafficProfile, AmbientTrafficProvenance, ResolvedAmbientTrafficProfile,
};
pub use anchor::matcher::{match_anchor, match_anchor_report, MatchOptions};
pub use anchor::{MatchReport, MatchedSite, MATCH_SEMANTICS_VERSION};
pub use bundle::{available_maps, MapBundle, MapBundleSources, StaticColliderDiagnostics};
pub use catalog::{ActorCatalog, ExternalCatalogEntry};
pub use error::{CompileError, CompileResult};
pub use expr::{evaluate_expr, parse_expr, ExprScope, NumberOrExpr};
pub use materialize::{
    instantiate, materialize, materialize_map_bound, InstanceManifest, MaterializeOptions,
    MaterializeResult, Note, SiteSelection,
};
pub use params::{cell_seed, params_version, resolve_params, ParamDraw};
pub use sites::{find_site, match_on_map, match_on_maps, SiteMatch, SiteMatchOptions};
pub use situation::{
    apply_situation_transaction, compare_situation, compile_situation, parse_situation,
    rehearse_situation, solve_situation, SituationCompileOptions, SituationProgram,
    SituationRehearsalOptions, SituationSolveOptions, SituationTransaction,
    VerifiedStaticGeometryBinding,
};
pub use template::{parse_template, ScenarioTemplate, SCENARIO_TEMPLATE_VERSION};
