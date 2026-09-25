//! The template DOCUMENT upgrader chain, Rust half.
//!
//! A stored document keeps the `scenarioVersion` it was written with. Readers
//! bring it up to [`SCENARIO_TEMPLATE_VERSION`] on read, one pure step per
//! version, then parse it strictly ([`crate::template::parse_template`] calls
//! [`upgrade_template_document`] first). Writers only write the current version.
//!
//! This table mirrors the template steps (from v2 on) of the TypeScript chain,
//! `SCENARIO_UPGRADE_STEPS` in `packages/scenario/src/upgrade/chain.ts`.
//! `pnpm scenario:contract:check` parses [`TEMPLATE_UPGRADE_STEPS`] from this
//! file and fails CI when the two tables, or the two version constants,
//! disagree. Keep every entry in the literal form
//! `TemplateUpgradeStep { from: N, to: N + 1 as a literal, description: .., upgrade: .. }`.
//!
//! v1 SCENE documents are not templates. Converting one is a TypeScript-only
//! importer step (`readScenarioDocument` / `migrateToTemplate` in
//! `@simforge-oss/scenario`); this compiler rejects them loudly.

use serde_json::Value;

use crate::error::{CompileError, CompileResult};
use crate::template::SCENARIO_TEMPLATE_VERSION;

/// The `scenarioVersion` of v1 scene documents (TypeScript importer only).
pub const SCENE_DOCUMENT_VERSION: u32 = 1;
/// The first `scenarioVersion` that is a template.
pub const FIRST_TEMPLATE_VERSION: u32 = 2;

/// One pure upgrade step: a vN template in, the equivalent vN+1 template out.
pub struct TemplateUpgradeStep {
    pub from: u32,
    pub to: u32,
    pub description: &'static str,
    /// Pure: no clock, map or environment. Receives the document as stored.
    pub upgrade: fn(Value) -> CompileResult<Value>,
}

/// Every template upgrade step, in order: exactly one step from each version
/// in `FIRST_TEMPLATE_VERSION..SCENARIO_TEMPLATE_VERSION`, each going up by one.
///
/// Empty today: v2 is the only template version.
pub const TEMPLATE_UPGRADE_STEPS: &[TemplateUpgradeStep] = &[];

fn scenario_version(value: &Value) -> CompileResult<u32> {
    let Some(object) = value.as_object() else {
        return Err(CompileError::new(
            "template_invalid",
            "a scenario document must be a JSON object",
        )
        .as_findings());
    };
    let version = object.get("scenarioVersion").and_then(Value::as_u64);
    match version.and_then(|v| u32::try_from(v).ok()) {
        Some(version) => Ok(version),
        None => Err(CompileError::at(
            "template_invalid",
            "scenarioVersion",
            "not a scenario document: scenarioVersion must be a non-negative integer",
        )
        .as_findings()),
    }
}

/// Bring a stored template document up to [`SCENARIO_TEMPLATE_VERSION`].
///
/// A current document is returned unchanged. Errors (all `template_invalid`,
/// path `scenarioVersion`, with `detail.version`):
/// - a v1 scene: convert it with the TypeScript importer first;
/// - a version newer than this build: this installation must be upgraded;
/// - a version no step starts from.
pub fn upgrade_template_document(value: Value) -> CompileResult<Value> {
    let from = scenario_version(&value)?;
    let reject = |reason: &str, message: String| {
        CompileError::at("template_invalid", "scenarioVersion", message)
            .detail_entry("reason", Value::String(reason.to_owned()))
            .detail_entry("version", Value::from(from))
            .detail_entry("supported", Value::from(SCENARIO_TEMPLATE_VERSION))
            .as_findings()
    };
    if from == SCENE_DOCUMENT_VERSION {
        return Err(reject(
            "scene_document",
            format!(
                "scenarioVersion {from} is a v1 scene document, not a template; the native compiler reads templates (v{FIRST_TEMPLATE_VERSION}+) only. Convert it with the TypeScript importer first (readScenarioDocument / migrateToTemplate in @simforge-oss/scenario)"
            ),
        ));
    }
    if from > SCENARIO_TEMPLATE_VERSION {
        return Err(reject(
            "scenario_version_newer",
            format!(
                "this scenario was saved by a newer SimForge (document schema v{from}); this compiler reads up to v{SCENARIO_TEMPLATE_VERSION}. Upgrade SimForge to compile it"
            ),
        ));
    }
    let mut document = value;
    let mut version = from;
    while version < SCENARIO_TEMPLATE_VERSION {
        let Some(step) = TEMPLATE_UPGRADE_STEPS
            .iter()
            .find(|step| step.from == version)
        else {
            return Err(reject(
                "scenario_version_unknown",
                format!(
                    "unsupported scenario format: document schema v{version}; this compiler upgrades templates v{FIRST_TEMPLATE_VERSION} through v{SCENARIO_TEMPLATE_VERSION}"
                ),
            ));
        };
        document = (step.upgrade)(document)?;
        let produced = scenario_version(&document)?;
        if produced != step.to {
            return Err(CompileError::internal(format!(
                "template upgrade step v{} -> v{} produced scenarioVersion {produced}",
                step.from, step.to
            )));
        }
        version = step.to;
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::template::parse_template;
    use serde_json::json;

    /// The committed LTAP example (a v2 template without a `simulation` block).
    fn minimal_template(version: u64) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../../examples/ltap-opposing.template.json"
        ))
        .expect("example template");
        value["scenarioVersion"] = json!(version);
        value
    }

    fn reason(error: &CompileError) -> Option<&str> {
        error.detail.as_ref()?.get("reason")?.as_str()
    }

    #[test]
    fn template_upgrade_passes_a_current_document_through_unchanged() {
        let value = minimal_template(u64::from(SCENARIO_TEMPLATE_VERSION));
        assert_eq!(upgrade_template_document(value.clone()).unwrap(), value);
        assert!(parse_template(&value).is_ok());
    }

    #[test]
    fn template_upgrade_rejects_a_newer_version_naming_it() {
        let newer = u64::from(SCENARIO_TEMPLATE_VERSION) + 1;
        let error = upgrade_template_document(minimal_template(newer)).unwrap_err();
        assert_eq!(error.code, "template_invalid");
        assert_eq!(error.path.as_deref(), Some("scenarioVersion"));
        assert_eq!(reason(&error), Some("scenario_version_newer"));
        assert!(
            error.reason.contains(&format!("v{newer}")),
            "{}",
            error.reason
        );
        assert!(
            error.reason.contains("Upgrade SimForge"),
            "{}",
            error.reason
        );
        // parse_template goes through the chain and fails the same way.
        let parsed = parse_template(&minimal_template(newer)).unwrap_err();
        assert_eq!(reason(&parsed), Some("scenario_version_newer"));
    }

    #[test]
    fn template_upgrade_rejects_v1_scenes_pointing_to_the_ts_importer() {
        let scene = json!({ "scenarioVersion": 1, "meta": {}, "map": {}, "entities": [] });
        let error = parse_template(&scene).unwrap_err();
        assert_eq!(error.code, "template_invalid");
        assert_eq!(reason(&error), Some("scene_document"));
        assert!(
            error.reason.contains("TypeScript importer"),
            "{}",
            error.reason
        );
    }

    #[test]
    fn template_upgrade_rejects_non_documents_and_unknown_versions() {
        for value in [
            json!([]),
            json!({}),
            json!({ "scenarioVersion": "2" }),
            json!({ "scenarioVersion": 1.5 }),
        ] {
            let error = upgrade_template_document(value).unwrap_err();
            assert_eq!(error.code, "template_invalid");
        }
        let error = upgrade_template_document(json!({ "scenarioVersion": 0 })).unwrap_err();
        assert_eq!(reason(&error), Some("scenario_version_unknown"));
    }

    /// The table is a chain: one step from each template version below the
    /// current one, each going up by exactly one.
    #[test]
    fn template_upgrade_steps_form_a_chain_to_the_current_version() {
        for version in FIRST_TEMPLATE_VERSION..SCENARIO_TEMPLATE_VERSION {
            let steps: Vec<_> = TEMPLATE_UPGRADE_STEPS
                .iter()
                .filter(|s| s.from == version)
                .collect();
            assert_eq!(steps.len(), 1, "exactly one step from v{version}");
            assert_eq!(steps[0].to, version + 1);
            assert!(!steps[0].description.is_empty());
        }
        for step in TEMPLATE_UPGRADE_STEPS {
            assert!(step.from >= FIRST_TEMPLATE_VERSION && step.to <= SCENARIO_TEMPLATE_VERSION);
        }
    }

    /// `scripts/scenario-contract.ts` reads the table with a regex; keep every
    /// entry in the form it reads so CI cannot miss a step. Whitespace (and so
    /// rustfmt's line breaks) does not matter; field order does.
    #[test]
    fn template_upgrade_step_table_is_in_the_form_ci_parses() {
        let source = include_str!("template_upgrade.rs");
        let table_start = source
            .find("pub const TEMPLATE_UPGRADE_STEPS: &[TemplateUpgradeStep] = &[")
            .expect("table literal");
        let table = &source[table_start..];
        let table = &table[..table.find("];").expect("table end")];
        let table = table.split_whitespace().collect::<Vec<_>>().join(" ");
        let literal_entries = table.matches("TemplateUpgradeStep {").count();
        assert_eq!(literal_entries, TEMPLATE_UPGRADE_STEPS.len());
        for step in TEMPLATE_UPGRADE_STEPS {
            let literal = format!(
                "TemplateUpgradeStep {{ from: {}, to: {},",
                step.from, step.to
            );
            assert!(table.contains(&literal), "missing `{literal}` in the table");
        }
        let template_rs = include_str!("template.rs");
        assert!(template_rs.contains(&format!(
            "pub const SCENARIO_TEMPLATE_VERSION: u32 = {SCENARIO_TEMPLATE_VERSION};"
        )));
    }

    /// The absent-field meanings the committed contract lock records must be
    /// what this crate implements (`SCENARIO_ABSENT_FIELD_SEMANTICS`).
    #[test]
    fn template_upgrade_absent_field_semantics_match_the_contract_lock() {
        let lock_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../contracts/scenario-contract.lock.json");
        let lock: Value =
            serde_json::from_str(&std::fs::read_to_string(&lock_path).expect("contract lock"))
                .expect("contract lock json");
        assert_eq!(lock["scenarioVersion"], json!(SCENARIO_TEMPLATE_VERSION));
        let meaning = |id: &str| -> Value {
            lock["absentFieldSemantics"]
                .as_array()
                .expect("absentFieldSemantics")
                .iter()
                .find(|entry| entry["id"] == json!(id))
                .unwrap_or_else(|| panic!("no absent-field semantic {id}"))["meaning"]
                .clone()
        };

        // No simulation block: the seed identity is anchor.id, else meta.name.
        assert_eq!(
            meaning("simulation.seed")["seedIdentity"],
            json!("anchor.id when it is a string, else meta.name")
        );
        let mut value = minimal_template(2);
        assert!(value.get("simulation").is_none());
        assert_eq!(
            parse_template(&value).unwrap().seed_identity(),
            "ltap-opposing"
        );
        value["anchor"].as_object_mut().unwrap().remove("id");
        let name = value["meta"]["name"].as_str().unwrap().to_owned();
        assert_eq!(parse_template(&value).unwrap().seed_identity(), name);

        // No simulation block and no profile: City traffic, seed ambient-1.
        let legacy = meaning("ambient.profile.legacy");
        let profile = crate::ambient::default_ambient_traffic_profile();
        let resolved = serde_json::to_value(&profile).unwrap();
        assert_eq!(resolved["preset"], legacy["profile"]["preset"]);
        assert_eq!(resolved["seed"], legacy["profile"]["seed"]);
    }
}
