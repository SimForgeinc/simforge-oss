//! Compiled map bundles, template materialisation and situation operations.
//!
//! Authoring documents cross as JSON once per compile; results are typed,
//! normalised [`Scenario`]s plus serialisable manifests/witnesses. Nothing here
//! interprets documents itself: every operation is the compiler's own.

use std::path::Path;

use simforge_compiler::ambient::{
    apply_ambient_traffic, resolve_ambient_traffic_profile, AmbientReservation,
    AmbientTrafficOptions, AmbientTrafficProfile,
};
use simforge_compiler::map_signals::{
    build_site_signal_plan, resolve_site_signal_program, SiteSignalRef,
};
use simforge_compiler::materialize::{instantiate, MaterializeOptions, Observation, SiteSelection};
use simforge_compiler::sites::{match_on_map, SiteMatchOptions};
use simforge_compiler::situation::{
    apply_situation_transaction, compare_situation, compile_situation, parse_situation,
    rehearse_situation, solve_situation, PolicyContext, SituationCompileOptions, SituationProgram,
    SituationRehearsalOptions, SituationSolveOptions, SituationTransaction,
    VerifiedStaticGeometryBinding,
};
use simforge_compiler::template::SignalApproach;
use simforge_compiler::{
    parse_template, ActorCatalog, CompileError, ExternalCatalogEntry, MapBundle, MapBundleSources,
    MatchedSite,
};
use simforge_core::engine::ActionOverride;
use simforge_core::map::TopologyIndex;
use simforge_core::rng::Seed;

use super::{Graph, Scenario};
use crate::action::decode_action_json;
use crate::error::{BindingError, Result};

impl From<CompileError> for BindingError {
    fn from(value: CompileError) -> Self {
        BindingError::Runtime(value.to_string())
    }
}

fn json_arg<T: serde::de::DeserializeOwned>(what: &str, text: &str) -> Result<T> {
    serde_json::from_str(text).map_err(|e| BindingError::argument(format!("{what}: {e}")))
}

/// A compiled immutable map: native graph + catalog/signal/derived facts.
#[derive(Clone)]
pub struct MapAsset {
    bundle: MapBundle,
    graph: Graph,
}

impl MapAsset {
    /// Load an installed map directory from the immutable corpus layout.
    pub fn load(dir: &Path) -> Result<Self> {
        Self::from_bundle(MapBundle::load(dir)?)
    }

    /// Bundle a bare topology sidecar (plain or gzip) under `map_id`.
    pub fn from_topology_bytes(map_id: &str, bytes: &[u8]) -> Result<Self> {
        Self::from_bundle(MapBundle::from_topology(
            map_id,
            TopologyIndex::decode(bytes)?,
        )?)
    }

    /// Bundle from in-memory sources: `sources_json` = `{mapId, derived?,
    /// locations?, searchIndex?, xodr?, signalsGeojson?, staticColliders?}`
    /// plus the topology sidecar bytes. `staticColliders` is the decoded
    /// `colliders` array of a `static-colliders-v1` artifact; absent means the
    /// bundle carries none and its diagnostics say so.
    pub fn from_sources(sources_json: &str, topology: &[u8]) -> Result<Self> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Sources {
            map_id: String,
            derived: Option<serde_json::Value>,
            locations: Option<serde_json::Value>,
            search_index: Option<serde_json::Value>,
            xodr: Option<String>,
            signals_geojson: Option<serde_json::Value>,
            static_colliders: Option<Vec<simforge_core::engine::StaticMapCollider>>,
        }
        let s: Sources = json_arg("map bundle sources", sources_json)?;
        let static_colliders = s.static_colliders.map(|colliders| {
            let mut classes: std::collections::BTreeMap<String, usize> =
                ["building", "wall", "barrier", "prop", "road-boundary"]
                    .into_iter()
                    .map(|c| (c.to_owned(), 0))
                    .collect();
            for c in &colliders {
                let key = serde_json::to_value(&c.class)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default();
                *classes.entry(key).or_insert(0) += 1;
            }
            let digest = simforge_core::hash::sha256_bytes(
                serde_json::to_string(&colliders)
                    .unwrap_or_default()
                    .as_bytes(),
            );
            let diagnostics = simforge_compiler::StaticColliderDiagnostics {
                digest,
                status: simforge_compiler::bundle::StaticColliderStatus::Ready,
                warning: None,
                source_tiles: 0,
                accepted: colliders.len(),
                rejected_road_overlap: 0,
                ignored: 0,
                classes,
            };
            (colliders, diagnostics)
        });
        let bundle = MapBundle::from_sources(MapBundleSources {
            map_id: s.map_id,
            topology: Some(TopologyIndex::decode(topology)?),
            derived: s.derived,
            locations: s.locations,
            search_index: s.search_index,
            xodr: s.xodr,
            signals_geojson: s.signals_geojson,
            static_colliders,
        })?;
        Self::from_bundle(bundle)
    }

    fn from_bundle(bundle: MapBundle) -> Result<Self> {
        let digest = bundle.topology_digest().to_owned();
        let graph = Graph::new(
            std::sync::Arc::clone(bundle.graph()),
            bundle.static_colliders().to_vec(),
            digest,
        );
        Ok(Self { bundle, graph })
    }

    pub fn map_id(&self) -> &str {
        self.bundle.map_id()
    }
    pub fn digest(&self) -> &str {
        self.bundle.topology_digest()
    }
    pub fn graph(&self) -> &Graph {
        &self.graph
    }
    #[inline]
    pub fn bundle(&self) -> &MapBundle {
        &self.bundle
    }

    /// The map's real signal programs and road controls (`{signalPrograms, roadControls}`).
    pub fn control_plan_json(&self) -> Result<String> {
        let plan =
            simforge_compiler::map_signals::build_map_control_plan(&self.bundle.signal_view());
        Ok(serde_json::to_string(&plan)?)
    }
    /// The merged `TopologyIndex` (map speed limits applied).
    pub fn topology_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self.bundle.topology())?)
    }
    pub fn signal_catalog_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self.bundle.signal_catalog())?)
    }
    /// Exact physical-head, controller, junction and movement reverse indices.
    pub fn signal_control_index_json(&self) -> Result<String> {
        let plan =
            simforge_compiler::map_signals::build_map_control_plan(&self.bundle.signal_view());
        let heads: Vec<String> = self
            .bundle
            .signal_catalog()
            .heads
            .iter()
            .map(|head| head.id.clone())
            .collect();
        let index = simforge_compiler::signal_plan::build_signal_control_index(
            &plan.signal_programs,
            &heads,
        );
        Ok(serde_json::to_string(&index)?)
    }
    /// The matcher's `DerivedMapIndex`.
    pub fn index_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self.bundle.index())?)
    }
    pub fn static_collider_diagnostics_json(&self) -> Result<String> {
        Ok(serde_json::to_string(
            self.bundle.static_collider_diagnostics(),
        )?)
    }
}

/// One materialised instance.
pub struct Compiled {
    pub scenario: Scenario,
    manifest_json: String,
    observations_json: String,
}

impl Compiled {
    pub fn manifest_json(&self) -> &str {
        &self.manifest_json
    }
    /// Lowered observations (`LoweredObservation[]`).
    pub fn observations_json(&self) -> &str {
        &self.observations_json
    }
}

fn seed_string(seed: Option<Seed>) -> Option<String> {
    seed.map(|s| match s {
        Seed::Text(t) => t,
        Seed::Number(n) => simforge_core::hash::js_number_to_string(n),
    })
}

/// `{drawIndex?, seed?, variant?, ambient?, ambientSettleSeconds?, catalogEntries?, observations?}`.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaterializeJson {
    draw_index: Option<i64>,
    seed: Option<serde_json::Value>,
    variant: Option<VariantJson>,
    ambient: Option<AmbientTrafficProfile>,
    ambient_settle_seconds: Option<f64>,
    #[serde(default)]
    catalog_entries: Vec<ExternalCatalogEntry>,
    #[serde(default)]
    observations: Vec<Observation>,
}

/// Wire form of `CatalogVariantApplication` (the compiler type is Serialize-only).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VariantJson {
    id: String,
    title: String,
    weather: String,
    time_of_day: String,
    traffic: String,
    visibility: String,
}

impl From<VariantJson> for simforge_compiler::materialize::CatalogVariantApplication {
    fn from(v: VariantJson) -> Self {
        Self {
            id: v.id,
            title: v.title,
            weather: v.weather,
            time_of_day: v.time_of_day,
            traffic: v.traffic,
            visibility: v.visibility,
        }
    }
}

fn materialize_options(text: Option<&str>, seed: Option<Seed>) -> Result<MaterializeOptions> {
    let o: MaterializeJson = match text {
        None => MaterializeJson::default(),
        Some(text) => json_arg("materialize options", text)?,
    };
    let mut options = MaterializeOptions::new();
    options.catalog =
        ActorCatalog::with_external(&o.catalog_entries).map_err(BindingError::argument)?;
    options.observations = o.observations;
    if let Some(d) = o.draw_index {
        options.draw_index = d;
    }
    options.seed = match seed {
        Some(seed) => seed_string(Some(seed)),
        None => match o.seed {
            None => None,
            Some(v) => seed_string(crate::assets::seed_from_json(&v)?),
        },
    };
    options.variant = o.variant.map(Into::into);
    options.ambient = o.ambient;
    if let Some(s) = o.ambient_settle_seconds {
        options.ambient_settle_seconds = s;
    }
    Ok(options)
}

/// Materialise template x map x site x seed. `site_id = None` picks the
/// top-ranked site; map-bound documents skip matching.
pub fn compile_template(
    template_json: &str,
    map: &MapAsset,
    site_id: Option<&str>,
    seed: Option<Seed>,
    options_json: Option<&str>,
) -> Result<Compiled> {
    let document: serde_json::Value = json_arg("template", template_json)?;
    let options = materialize_options(options_json, seed)?;
    let selection = site_id.map_or(SiteSelection::Auto, SiteSelection::Id);
    let result = instantiate(&document, map.bundle(), selection, &options)?;
    Ok(Compiled {
        scenario: Scenario::from_input(result.input),
        manifest_json: serde_json::to_string(&result.manifest)?,
        observations_json: serde_json::to_string(&result.observations)?,
    })
}

/// Rank sites for a template on one map; returns the `SiteMatch` JSON
/// (`{mapId, report: MatchReport, notes}`). `options_json`: `{minScore?, maxSites?, exactCatalogSiteResolution?}`.
pub fn match_sites(
    template_json: &str,
    map: &MapAsset,
    options_json: Option<&str>,
) -> Result<String> {
    #[derive(Default, serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Options {
        min_score: Option<f64>,
        max_sites: Option<usize>,
        exact_catalog_site_resolution: Option<bool>,
    }
    let document: serde_json::Value = json_arg("template", template_json)?;
    let template = parse_template(&document)?;
    let o: Options = match options_json {
        None => Options::default(),
        Some(text) => json_arg("site match options", text)?,
    };
    let options = SiteMatchOptions {
        min_score: o.min_score,
        max_sites: o.max_sites,
        exact_catalog_site_resolution: o.exact_catalog_site_resolution.unwrap_or(false),
    };
    Ok(serde_json::to_string(&match_on_map(
        &template,
        map.bundle(),
        &options,
    )?)?)
}

/// One grounded matched site, kept native so the validator's per-reference
/// signal lookups never re-run the matcher.
#[derive(Clone)]
pub struct Site {
    site: MatchedSite,
}

impl Site {
    pub fn site_id(&self) -> &str {
        &self.site.site_id
    }
    pub fn map_id(&self) -> &str {
        &self.site.map_id
    }
    /// The full `MatchedSite` (camelCase JSON).
    pub fn to_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.site)?)
    }
    #[inline]
    pub fn inner(&self) -> &MatchedSite {
        &self.site
    }
}

/// Resolve one site for a template on `map`: `site_id = None` is the
/// top-ranked site; an explicit id may name a matcher-rejected site.
pub fn find_site(template_json: &str, map: &MapAsset, site_id: Option<&str>) -> Result<Site> {
    let document: serde_json::Value = json_arg("template", template_json)?;
    let template = parse_template(&document)?;
    let site = simforge_compiler::sites::find_site(
        &template,
        map.bundle(),
        site_id.map_or(SiteSelection::Auto, SiteSelection::Id),
    )?;
    Ok(Site { site })
}

impl MapAsset {
    /// `SiteSignalPlan` JSON for the site's origin junction.
    pub fn site_signal_plan_json(&self, site: &Site) -> Result<String> {
        Ok(serde_json::to_string(&build_site_signal_plan(
            &self.bundle.signal_view(),
            site.inner(),
        ))?)
    }

    /// Resolve an authored signal reference (`{"handle": id}` or
    /// `{"featureId": id, "approach": "subject"|"opposing"|"left"|"right"}`)
    /// to the concrete engine program id, or `None` when unbound.
    pub fn resolve_site_signal_program(
        &self,
        site: &Site,
        ref_json: &str,
    ) -> Result<Option<String>> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields, untagged)]
        enum RefJson {
            Handle {
                handle: String,
            },
            Feature {
                feature_id: String,
                approach: String,
            },
        }
        let r: RefJson = json_arg("site signal ref", ref_json)?;
        let view = self.bundle.signal_view();
        let plan = build_site_signal_plan(&view, site.inner());
        let r = match &r {
            RefJson::Handle { handle } => SiteSignalRef::Handle(handle),
            RefJson::Feature {
                feature_id,
                approach,
            } => {
                let approach = match approach.as_str() {
                    "subject" => SignalApproach::Subject,
                    "opposing" => SignalApproach::Opposing,
                    "left" => SignalApproach::Left,
                    "right" => SignalApproach::Right,
                    other => {
                        return Err(BindingError::argument(format!(
                        "site signal ref: unknown approach {other:?} (subject|opposing|left|right)"
                    )))
                    }
                };
                SiteSignalRef::Feature {
                    feature_id,
                    approach,
                }
            }
        };
        Ok(resolve_site_signal_program(&view, site.inner(), &plan, &r))
    }
}

/// Site ids in `map` that satisfy the template's requirements (ranked).
pub fn find_sites(template_json: &str, map: &MapAsset) -> Result<Vec<String>> {
    let document: serde_json::Value = json_arg("template", template_json)?;
    let template = parse_template(&document)?;
    let matched = match_on_map(
        &template,
        map.bundle(),
        &SiteMatchOptions {
            max_sites: Some(100),
            ..Default::default()
        },
    )?;
    Ok(matched
        .report
        .sites
        .into_iter()
        .map(|s| s.site_id)
        .collect())
}

/* -------------------------------------------------------------- identity */

/// `{templateId, paramsVersion}`: the replay-key identity of a template.
pub fn template_identity_json(template_json: &str) -> Result<String> {
    let document: serde_json::Value = json_arg("template", template_json)?;
    let template = parse_template(&document)?;
    Ok(serde_json::json!({"templateId": template.template_id(), "paramsVersion": simforge_compiler::params_version(&template)}).to_string())
}

/// `AdaptNote[]` JSON (`{path, reason, severity: "note"|"error", code?}`) from
/// adapting a template onto the matcher vocabulary; needs no map.
pub fn adapt_template_notes_json(template_json: &str) -> Result<String> {
    let document: serde_json::Value = json_arg("template", template_json)?;
    let template = parse_template(&document)?;
    Ok(serde_json::to_string(
        &simforge_compiler::anchor::adapt::adapt_template(&template).notes,
    )?)
}

/// `sha256(templateId|paramsVersion|siteId|drawIndex)`, the per-cell seed.
pub fn cell_seed(
    template_id: &str,
    params_version: &str,
    site_id: &str,
    draw_index: i64,
) -> String {
    simforge_compiler::cell_seed(template_id, params_version, site_id, draw_index)
}

/* ------------------------------------------------------------ situations */

/// `{materialize?: <materialize options>, siteId?: string, geometryBindings?: [...], runtime?: <run option overrides>}`.
/// Portable programs are grounded at `siteId` (or the top-ranked site when
/// absent); map-bound programs skip matching.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SituationJson {
    materialize: Option<serde_json::Value>,
    site_id: Option<String>,
    geometry_bindings: Option<Vec<VerifiedStaticGeometryBinding>>,
    runtime: Option<serde_json::Value>,
    /// Solve only: `[1, 256]`.
    max_evaluations: Option<usize>,
    /// Solve only.
    relative_resolution: Option<f64>,
    /// Compare only: roles whose reactive change must be named.
    reactive_role_ids: Option<Vec<String>>,
}

struct SituationSetup {
    compile: SituationCompileOptions,
    runtime: Option<simforge_core::engine::RunOptions>,
    max_evaluations: usize,
    relative_resolution: Option<f64>,
    reactive_role_ids: Vec<String>,
}

fn situation_setup(
    program: &SituationProgram,
    map: &MapAsset,
    options_json: Option<&str>,
) -> Result<SituationSetup> {
    let o: SituationJson = match options_json {
        None => SituationJson::default(),
        Some(text) => json_arg("situation options", text)?,
    };
    let materialize = materialize_options(
        o.materialize
            .as_ref()
            .map(serde_json::Value::to_string)
            .as_deref(),
        None,
    )?;
    let site = if program.template.is_portable() {
        Some(simforge_compiler::sites::find_site(
            &program.template,
            map.bundle(),
            o.site_id
                .as_deref()
                .map_or(SiteSelection::Auto, SiteSelection::Id),
        )?)
    } else {
        None
    };
    let runtime = match o.runtime {
        None => None,
        Some(v) => Some(map.graph().run_options(Some(&v.to_string()))?),
    };
    Ok(SituationSetup {
        compile: SituationCompileOptions {
            materialize,
            site,
            geometry_bindings: o.geometry_bindings.unwrap_or_default(),
        },
        runtime,
        max_evaluations: o.max_evaluations.unwrap_or(32),
        relative_resolution: o.relative_resolution,
        reactive_role_ids: o.reactive_role_ids.unwrap_or_default(),
    })
}

fn parse_program(document_json: &str) -> Result<SituationProgram> {
    let value: serde_json::Value = json_arg("situation", document_json)?;
    Ok(parse_situation(&value)?)
}

/// Host policy for declared policy roles: receives the `PolicyContext` as
/// JSON `{tS, dtS, actorId, actor}` and returns an action object JSON or
/// `null` (which is a rehearsal failure per the compiler's contract).
pub type PolicyCallback<'a> = dyn FnMut(&str) -> Result<Option<String>> + 'a;

fn policy_hook<'a>(
    cb: &'a mut PolicyCallback<'a>,
) -> impl FnMut(&PolicyContext<'_>) -> Option<ActionOverride> + 'a {
    move |ctx| {
        let request = serde_json::json!({"tS": ctx.t_s, "dtS": ctx.dt_s, "actorId": ctx.actor_id, "actor": ctx.actor}).to_string();
        match cb(&request) {
            Ok(Some(text)) => serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| decode_action_json(&v).ok()),
            _ => None,
        }
    }
}

/// Compile a situation document; returns the executable scenario and the `BoundSituation` JSON.
pub fn compile_situation_json(
    document_json: &str,
    map: &MapAsset,
    options_json: Option<&str>,
) -> Result<(Scenario, String)> {
    let program = parse_program(document_json)?;
    let setup = situation_setup(&program, map, options_json)?;
    let bound = compile_situation(&program, map.bundle(), &setup.compile)?;
    let scenario = Scenario::from_input(bound.execution.input.clone());
    Ok((scenario, serde_json::to_string(&bound)?))
}

/// Rehearse (simulate) a situation; returns `SituationRehearsal` JSON.
pub fn rehearse_situation_json(
    document_json: &str,
    map: &MapAsset,
    options_json: Option<&str>,
    policy: Option<&mut PolicyCallback<'_>>,
) -> Result<String> {
    let program = parse_program(document_json)?;
    let setup = situation_setup(&program, map, options_json)?;
    let mut hook = policy.map(|cb| policy_hook(cb));
    let mut options = SituationRehearsalOptions {
        compile: setup.compile,
        runtime: setup.runtime,
        policy: hook.as_mut().map(|h| h as &mut _),
    };
    Ok(serde_json::to_string(&rehearse_situation(
        &program,
        map.bundle(),
        &mut options,
    )?)?)
}

/// Bounded deterministic solve; `on_evaluation` receives each evaluated
/// `{program, rehearsal}` JSON and may abort by returning an error.
pub fn solve_situation_json(
    document_json: &str,
    map: &MapAsset,
    options_json: Option<&str>,
    policy: Option<&mut PolicyCallback<'_>>,
    on_evaluation: Option<&mut dyn FnMut(&str) -> Result<()>>,
) -> Result<String> {
    let program = parse_program(document_json)?;
    let setup = situation_setup(&program, map, options_json)?;
    let mut hook = policy.map(|cb| policy_hook(cb));
    let mut on_eval = on_evaluation.map(|cb| {
        move |program: &SituationProgram,
              rehearsal: &simforge_compiler::situation::SituationRehearsal|
              -> simforge_compiler::CompileResult<()> {
            let doc = serde_json::json!({"program": program, "rehearsal": rehearsal}).to_string();
            cb(&doc).map_err(|e| CompileError::new("solver_callback_failed", e.to_string()))
        }
    });
    let mut options = SituationSolveOptions {
        rehearsal: SituationRehearsalOptions {
            compile: setup.compile,
            runtime: setup.runtime,
            policy: hook.as_mut().map(|h| h as &mut _),
        },
        max_evaluations: setup.max_evaluations,
        relative_resolution: setup.relative_resolution,
        on_evaluation: on_eval.as_mut().map(|f| f as &mut _),
    };
    Ok(serde_json::to_string(&solve_situation(
        &program,
        map.bundle(),
        &mut options,
    )?)?)
}

/// Compare a declared transaction against the base program; returns `SituationComparison` JSON.
pub fn compare_situation_json(
    document_json: &str,
    transaction_json: &str,
    map: &MapAsset,
    options_json: Option<&str>,
    policy: Option<&mut PolicyCallback<'_>>,
) -> Result<String> {
    let program = parse_program(document_json)?;
    let transaction: SituationTransaction = json_arg("situation transaction", transaction_json)?;
    let setup = situation_setup(&program, map, options_json)?;
    let mut hook = policy.map(|cb| policy_hook(cb));
    let mut options = SituationRehearsalOptions {
        compile: setup.compile,
        runtime: setup.runtime,
        policy: hook.as_mut().map(|h| h as &mut _),
    };
    Ok(serde_json::to_string(&compare_situation(
        &program,
        &transaction,
        map.bundle(),
        &mut options,
        &setup.reactive_role_ids,
    )?)?)
}

/// Apply a transaction without simulating; returns `SituationTransactionResult` JSON.
pub fn apply_situation_transaction_json(
    document_json: &str,
    transaction_json: &str,
) -> Result<String> {
    let program = parse_program(document_json)?;
    let transaction: SituationTransaction = json_arg("situation transaction", transaction_json)?;
    Ok(serde_json::to_string(&apply_situation_transaction(
        &program,
        &transaction,
    )?)?)
}

/* --------------------------------------------------------------- ambient */

/// Materialise an ambient-traffic profile onto `scenario` over `graph`.
/// `options_json`: `{reservations: [{x, z, radiusM}], excludedLaneRsls, allowAuthoredCorridor, extraTravelSeconds, targetMultiplier, cohortRadiusBonusM}`.
pub fn materialize_ambient_traffic(
    scenario: &Scenario,
    graph: &Graph,
    profile_json: &str,
    options_json: Option<&str>,
) -> Result<(Scenario, String)> {
    let profile: AmbientTrafficProfile = json_arg("ambient profile", profile_json)?;
    let resolved = resolve_ambient_traffic_profile(&profile)?;
    let options = match options_json {
        None => AmbientTrafficOptions::default(),
        Some(text) => {
            #[derive(Default, serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Reservation {
                x: f64,
                z: f64,
                radius_m: f64,
            }
            #[derive(Default, serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields, default)]
            struct Options {
                reservations: Vec<Reservation>,
                excluded_lane_rsls: Vec<String>,
                allow_authored_corridor: bool,
                extra_travel_seconds: f64,
                target_multiplier: f64,
                cohort_radius_bonus_m: f64,
            }
            let o: Options = json_arg("ambient options", text)?;
            AmbientTrafficOptions {
                reservations: o
                    .reservations
                    .iter()
                    .map(|r| AmbientReservation {
                        x: r.x,
                        z: r.z,
                        radius_m: r.radius_m,
                    })
                    .collect(),
                excluded_lane_rsls: o.excluded_lane_rsls,
                allow_authored_corridor: o.allow_authored_corridor,
                extra_travel_seconds: o.extra_travel_seconds,
                target_multiplier: o.target_multiplier,
                cohort_radius_bonus_m: o.cohort_radius_bonus_m,
            }
        }
    };
    let result = apply_ambient_traffic(scenario.input(), graph.lane_graph(), &resolved, &options)?;
    Ok((
        Scenario::from_input(result.input),
        serde_json::to_string(&result.provenance)?,
    ))
}
