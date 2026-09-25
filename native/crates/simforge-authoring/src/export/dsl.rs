//! OpenSCENARIO DSL 2.2.0: editable actions for the statically schedulable
//! subset (`at`/`after` triggers, speed/lane/gap/offset actions).

use simforge_bindings_common::runtime::MapAsset;
use simforge_compiler::CompileError;
use simforge_core::types::SimScenarioInput;

use super::{
    actor_backends, analyze_capabilities, assert_default_controller_rules, finite, flag,
    identifier, issue, items, js_num, js_string, merge_warnings, num, physics_of, resolve_scenario,
    text, AsamFormat, AsamIssue, ExportDocument, ExportFailure, ExportOptions, ExportResult, Pose,
    Profile, Resolved, ResolvedInteraction,
};
use crate::jsvalue::JsValue;

fn indent(text: &str, spaces: usize) -> String {
    let prefix = " ".repeat(spaces);
    text.split('\n')
        .map(|l| format!("{prefix}{l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn pose_name(path_name: &str, index: usize) -> String {
    format!("{path_name}_pose_{index}")
}

fn pose_declaration(name: &str, pose: Pose) -> String {
    [
        format!("{name}: pose_3d with:"),
        format!("    keep(it.position.x == {}m)", finite(pose.x)),
        format!("    keep(it.position.y == {}m)", finite(-pose.z)),
        "    keep(it.position.z == 0m)".into(),
        "    keep(it.orientation.roll == 0rad)".into(),
        "    keep(it.orientation.pitch == 0rad)".into(),
        format!(
            "    keep(it.orientation.yaw == {}rad)",
            finite(pose.heading_rad)
        ),
    ]
    .join("\n")
}

fn actor_declaration(actor: &JsValue, name: &str) -> String {
    let kind = text(actor, "kind");
    let kind_type = match kind {
        "pedestrian" => "person",
        "animal" => "animal",
        "static_object" => "stationary_object",
        _ => "vehicle",
    };
    let category = match kind {
        "vehicle" => Some("other"),
        "car" => Some("car"),
        "truck" => Some("heavy_truck"),
        "bus" => Some("bus"),
        "van" => Some("van"),
        "motorcycle" => Some("motorcycle"),
        "bicycle" => Some("bicycle"),
        "scooter" => Some("stand_up_scooter"),
        _ => None,
    };
    let h = num(actor, &["dims", "h"]);
    let mut out = vec![format!("{name}: {kind_type} with:")];
    if let Some(category) = category {
        out.push(format!("    keep(it.vehicle_category == {category})"));
    }
    out.extend([
        "    keep(it.bounding_box.center.x == 0m)".into(),
        "    keep(it.bounding_box.center.y == 0m)".into(),
        format!("    keep(it.bounding_box.center.z == {}m)", finite(h / 2.0)),
        format!(
            "    keep(it.bounding_box.length == {}m)",
            finite(num(actor, &["dims", "l"]))
        ),
        format!(
            "    keep(it.bounding_box.width == {}m)",
            finite(num(actor, &["dims", "w"]))
        ),
        format!("    keep(it.bounding_box.height == {}m)", finite(h)),
        "    keep(it.center_of_gravity.x == 0m)".into(),
        "    keep(it.center_of_gravity.y == 0m)".into(),
        format!("    keep(it.center_of_gravity.z == {}m)", finite(h / 2.0)),
    ]);
    if kind != "static_object" {
        let infrastructure = match kind {
            "pedestrian" | "animal" => "sidewalk",
            "bicycle" | "scooter" => "biking",
            "bus" => "bus",
            _ => "driving",
        };
        out.push(format!(
            "    keep(it.intended_infrastructure == [{infrastructure}])"
        ));
    }
    out.join("\n")
}

fn path_declaration(name: &str, points: &[Pose]) -> String {
    let mut out = Vec::new();
    for (i, point) in points.iter().enumerate() {
        out.push(pose_declaration(&pose_name(name, i), *point));
        out.push(String::new());
    }
    out.push(format!(
        "{name}: path = map_ref.create_path(points: [{}], interpolation: straight_line)",
        (0..points.len())
            .map(|i| pose_name(name, i))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    out.join("\n")
}

fn occluder_declaration(o: &JsValue) -> String {
    let id = text(o, "id");
    let name = identifier("occluder", id);
    let pose = identifier("occluder_pose", id);
    let h = num(o, &["obb", "heightM"]);
    [
        format!("{name}: stationary_object with:"),
        "    keep(it.bounding_box.center.x == 0m)".into(),
        "    keep(it.bounding_box.center.y == 0m)".into(),
        format!("    keep(it.bounding_box.center.z == {}m)", finite(h / 2.0)),
        format!(
            "    keep(it.bounding_box.length == {}m)",
            finite(num(o, &["obb", "lengthM"]))
        ),
        format!(
            "    keep(it.bounding_box.width == {}m)",
            finite(num(o, &["obb", "widthM"]))
        ),
        format!("    keep(it.bounding_box.height == {}m)", finite(h)),
        "    keep(it.center_of_gravity.x == 0m)".into(),
        "    keep(it.center_of_gravity.y == 0m)".into(),
        format!("    keep(it.center_of_gravity.z == {}m)", finite(h / 2.0)),
        pose_declaration(
            &pose,
            Pose {
                x: num(o, &["obb", "center", "x"]),
                z: num(o, &["obb", "center", "z"]),
                heading_rad: num(o, &["obb", "headingRad"]),
            },
        ),
        format!("{name}.location(pose: {pose})"),
    ]
    .join("\n")
}

fn initial_actor_branch(actor: &JsValue, name: &str, route_name: &str, clip: f64) -> String {
    let avoid = flag(actor, &["behavior", "rules", "collisionAvoidance"]);
    let mut motion = vec![format!(
        "{name}.follow_path(absolute: {route_name}, duration: {}s){}",
        finite(clip),
        if avoid { "" } else { " with:" }
    )];
    if !avoid {
        motion.push("    avoid_collisions(avoid: false)".into());
    }
    [
        "serial:".to_owned(),
        format!(
            "    {name}.assign_position(position: {}.position)",
            pose_name(route_name, 0)
        ),
        format!(
            "    {name}.assign_orientation(orientation: {}.orientation)",
            pose_name(route_name, 0)
        ),
        format!(
            "    {name}.assign_speed(speed: {}mps)",
            finite(num(actor, &["initial", "speedMps"]))
        ),
        indent(&motion.join("\n"), 4),
    ]
    .join("\n")
}

fn target_speed(interaction: &JsValue, current: Option<f64>) -> Result<f64, AsamIssue> {
    let id = text(interaction, "id");
    let target = interaction.get("target").cloned().unwrap_or(JsValue::Null);
    let path = format!("interactions.{id}.target");
    match text(&target, "mode") {
        "absolute" => Ok(num(&target, &["value"])),
        "stop" => Ok(0.0),
        "delta" => current
            .map(|c| 0f64.max(c + num(&target, &["value"])))
            .ok_or_else(|| issue("unknown_prior_speed", path, "delta speed needs a statically known prior speed")),
        "factor" => current
            .map(|c| c * num(&target, &["value"]))
            .ok_or_else(|| issue("unknown_prior_speed", path, "factor speed needs a statically known prior speed")),
        "match" => Err(issue(
            "unsupported_relative_speed",
            path,
            "DSL same_as speed is a persistent constraint, not the engine\u{2019}s instantaneous match target",
        )),
        _ => Ok(f64::NAN),
    }
}

fn speed_action(
    interaction: &JsValue,
    actor_name: &str,
    current: Option<f64>,
) -> Result<(String, f64), AsamIssue> {
    let target = target_speed(interaction, current)?;
    let id = text(interaction, "id");
    let dynamics = interaction
        .get("dynamics")
        .cloned()
        .unwrap_or(JsValue::Null);
    let shape = text(&dynamics, "shape");
    if shape == "step" || current == Some(target) {
        return Ok((
            format!("{actor_name}.assign_speed(speed: {}mps)", finite(target)),
            target,
        ));
    }
    if shape != "linear" {
        return Err(issue(
            "unsupported_dynamics_shape",
            format!("interactions.{id}.dynamics.shape"),
            format!("DSL 2.2 dynamic_profile cannot distinguish the engine's {shape} interpolation exactly"),
        ));
    }
    let Some(current) = current else {
        return Err(issue(
            "unknown_prior_speed",
            format!("interactions.{id}"),
            "linear transition needs a statically known prior speed",
        ));
    };
    let value = num(&dynamics, &["value"]);
    let rate = match text(&dynamics, "constraint") {
        "rate" => value,
        "time" => (target - current).abs() / value,
        _ => (target * target - current * current).abs() / (2.0 * value),
    };
    // `!(x > 0)`, NaN included, as in the TS.
    if !rate.is_finite() || rate.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return Err(issue(
            "invalid_speed_transition",
            format!("interactions.{id}.dynamics"),
            "transition does not imply a positive acceleration magnitude",
        ));
    }
    Ok((
        format!(
            "{actor_name}.change_speed(target: {}mps, rate_profile: constant, rate_peak: {}mpss)",
            finite(target),
            finite(rate)
        ),
        target,
    ))
}

fn interaction_action(
    resolved: &Resolved<'_>,
    entry: &ResolvedInteraction<'_>,
    current: Option<f64>,
) -> Result<(String, Option<f64>), AsamIssue> {
    let interaction = entry.interaction;
    let id = text(interaction, "id");
    let actor_name = resolved
        .actor_names
        .get(text(interaction, "actorId"))
        .cloned()
        .unwrap_or_else(|| "undefined".into());
    let dynamics = interaction
        .get("dynamics")
        .cloned()
        .unwrap_or(JsValue::Null);
    let target = interaction.get("target").cloned().unwrap_or(JsValue::Null);
    match text(interaction, "verb") {
        "speed" => speed_action(interaction, &actor_name, current).map(|(text, speed)| (text, Some(speed))),
        "changeLane" => {
            let mode = text(&target, "mode");
            if mode != "left" && mode != "right" {
                return Err(issue(
                    "unsupported_lane_target",
                    format!("interactions.{id}.target"),
                    format!("{mode} is not a portable DSL relative lane target"),
                ));
            }
            if text(&dynamics, "constraint") != "time" {
                return Err(issue(
                    "unsupported_lane_dynamics",
                    format!("interactions.{id}.dynamics"),
                    "DSL change_lane cannot preserve an engine rate/distance completion constraint without lane geometry state",
                ));
            }
            Ok((
                format!(
                    "{actor_name}.change_lane(num_of_lanes: {}, side: {mode}, duration: {}s)",
                    js_string(target.get("count").unwrap_or(&JsValue::Null)),
                    finite(num(&dynamics, &["value"]))
                ),
                None,
            ))
        }
        "gap" => {
            if text(&dynamics, "constraint") != "time" {
                return Err(issue(
                    "unsupported_gap_dynamics",
                    format!("interactions.{id}.dynamics"),
                    "DSL gap action only has an exact mapping for time-constrained transitions",
                ));
            }
            let distance = text(interaction, "mode") == "distance";
            let reference = resolved
                .actor_names
                .get(text(&target, "actorId"))
                .cloned()
                .unwrap_or_else(|| "undefined".into());
            Ok((
                format!(
                    "{actor_name}.{}(target: {}{}, direction: behind, reference: {reference}, duration: {}s)",
                    if distance { "change_space_gap" } else { "change_time_gap" },
                    finite(num(interaction, &["value"])),
                    if distance { "m" } else { "s" },
                    finite(num(&dynamics, &["value"]))
                ),
                None,
            ))
        }
        "laneOffset" => {
            if text(&target, "mode") != "meters" || text(&dynamics, "constraint") != "time" {
                return Err(issue(
                    "unsupported_lane_offset",
                    format!("interactions.{id}"),
                    "DSL lateral() only exactly maps metre offsets with a time completion constraint",
                ));
            }
            Ok((
                format!(
                    "{actor_name}.move(duration: {}s) with:\n    lateral(distance: {}m, at: end)",
                    finite(num(&dynamics, &["value"])),
                    finite(num(&target, &["value"]))
                ),
                None,
            ))
        }
        "route" => Err(issue(
            "unsupported_dynamic_route",
            format!("interactions.{id}"),
            "DSL follow_path is an ongoing behavior; replacing an active engine route needs explicit arbitration semantics",
        )),
        "exist" => Err(issue(
            "unsupported_entity_lifecycle",
            format!("interactions.{id}"),
            "DSL 2.2 has no standard add/delete entity action equivalent",
        )),
        _ => Err(issue(
            "unsupported_set_action",
            format!("interactions.{id}"),
            format!(
                "{} has no exact DSL 2.2 assignment/action mapping in the concrete profile",
                js_string(target.get("key").unwrap_or(&JsValue::Null))
            ),
        )),
    }
}

fn validate_dsl_profile(input: &JsValue) -> ExportResult<()> {
    let mut issues = Vec::new();
    for (i, actor) in items(input, "actors").iter().enumerate() {
        if !flag(actor, &["presentAtStart"]) {
            issues.push(issue(
                "unsupported_entity_lifecycle",
                format!("actors.{i}.presentAtStart"),
                "DSL 2.2 has no standard dynamic spawn action",
            ));
        }
        if items(actor, "tags")
            .iter()
            .any(|t| t.as_str() == Some("motion:reverse"))
        {
            issues.push(issue(
                "unsupported_reverse_motion",
                format!("actors.{i}.tags"),
                "DSL follow_path does not define the engine reverse-driving controller semantics; use XML trajectory replay",
            ));
        }
        if flag(actor, &["static"]) && num(actor, &["initial", "speedMps"]) > 1e-9 {
            issues.push(issue(
                "invalid_static_actor_speed",
                format!("actors.{i}.initial.speedMps"),
                "a stationary_object cannot preserve a non-zero initial speed",
            ));
        }
    }
    for (i, interaction) in items(input, "interactions").iter().enumerate() {
        if interaction.get("until").is_some_and(JsValue::truthy) {
            issues.push(issue(
                "unsupported_until",
                format!("interactions.{i}.until"),
                "the concrete DSL profile schedules actions explicitly and cannot preserve this condition exactly",
            ));
        }
        let actor_id = text(interaction, "actorId");
        let is_static = items(input, "actors")
            .iter()
            .find(|a| text(a, "id") == actor_id)
            .is_some_and(|a| flag(a, &["static"]));
        let verb = text(interaction, "verb");
        if is_static && verb != "exist" {
            issues.push(issue(
                "unsupported_static_actor_action",
                format!("interactions.{i}"),
                format!("{verb} cannot be applied to a DSL stationary_object without substituting movable-object semantics"),
            ));
        }
    }
    if !items(input, "signalPrograms").is_empty() {
        issues.push(issue(
            "unsupported_signal_program",
            "signalPrograms",
            "the concrete DSL profile has no standard traffic-light cycle action; controllerHeadGroups provenance is not an executable substitute",
        ));
    }
    if !issues.is_empty() {
        return Err(ExportFailure::Unsupported(issues));
    }
    Ok(())
}

/// `exportOpenScenarioDsl22`.
pub(crate) fn export_dsl22(
    input: &JsValue,
    typed: &SimScenarioInput,
    map: &MapAsset,
    options: &ExportOptions,
) -> ExportResult<ExportDocument> {
    let (report, capability_warnings) = analyze_capabilities(input, Profile::Dsl22Actions);
    let controller_warnings = assert_default_controller_rules(input)?;
    validate_dsl_profile(input)?;
    let resolved = resolve_scenario(input, map.graph(), options, true)?;
    let mut issues = Vec::new();
    let mut speed_by_actor: Vec<(String, f64)> = items(input, "actors")
        .iter()
        .map(|a| (text(a, "id").to_owned(), num(a, &["initial", "speedMps"])))
        .collect();
    let mut ordered: Vec<&ResolvedInteraction<'_>> = resolved.interactions.iter().collect();
    ordered.sort_by(|a, b| {
        let ta = a.start_time_s.unwrap_or(0.0);
        let tb = b.start_time_s.unwrap_or(0.0);
        ta.partial_cmp(&tb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                simforge_core::hash::cmp_locale(
                    text(a.interaction, "id"),
                    text(b.interaction, "id"),
                )
            })
    });
    let mut branches: Vec<(f64, String, String)> = Vec::new();
    for entry in ordered {
        let actor_id = text(entry.interaction, "actorId");
        let current = speed_by_actor
            .iter()
            .find(|(id, _)| id == actor_id)
            .map(|(_, s)| *s);
        match interaction_action(&resolved, entry, current) {
            Err(found) => issues.push(found),
            Ok((text_out, speed)) => {
                if let Some(speed) = speed {
                    match speed_by_actor.iter_mut().find(|(id, _)| id == actor_id) {
                        Some(slot) => slot.1 = speed,
                        None => speed_by_actor.push((actor_id.to_owned(), speed)),
                    }
                }
                branches.push((
                    entry.start_time_s.unwrap_or(f64::NAN),
                    text(entry.interaction, "id").to_owned(),
                    text_out,
                ));
            }
        }
    }
    if !issues.is_empty() {
        return Err(ExportFailure::Unsupported(issues));
    }

    let typed_mode = serde_json::to_value(typed.physics_mode())
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let (mode, substep) = physics_of(input, &typed_mode);
    let road_file = options
        .road_file
        .clone()
        .unwrap_or_else(|| format!("{}.xodr", text(input, "mapId")));
    let mut content = vec![
        "# ASAM OpenSCENARIO DSL 2.2.0".to_owned(),
        "# Generated from a concrete SimForge scenario instance.".into(),
        "# uniscenarios.export.profile=dsl-2.2-actions".into(),
        "# uniscenarios.export.intent=editable-semantic".into(),
        format!(
            "# uniscenarios.input.schemaVersion={}",
            js_string(input.get("schemaVersion").unwrap_or(&JsValue::Null))
        ),
        format!("# uniscenarios.physics.mode={mode}"),
        format!("# uniscenarios.physics.substepS={}", js_num(substep)),
        format!(
            "# uniscenarios.physics.actorBackends={}",
            actor_backends(input)
        ),
    ];
    if let Some(provenance) = &options.provenance {
        let mut sorted: Vec<&(String, JsValue)> = provenance.iter().collect();
        sorted.sort_by(|a, b| simforge_core::hash::cmp_locale(&a.0, &b.0));
        content.extend(sorted.into_iter().map(|(k, v)| {
            format!(
                "# uniscenarios.provenance.{k}={}",
                js_string(v).replace(['\r', '\n'], " ")
            )
        }));
    }
    let clip = num(input, &["warmupSeconds"]) + num(input, &["clipSeconds"]);
    content.extend([
        "import osc.standard".into(),
        String::new(),
        "scenario uniscenarios_instance:".into(),
        "    map_ref: map with:".into(),
        format!(
            "        keep(it.map_file == \"{}\")",
            road_file.replace('\\', "\\\\").replace('"', "\\\"")
        ),
        String::new(),
    ]);
    for a in &resolved.actors {
        content.push(indent(&actor_declaration(a.actor, &a.name), 4));
        content.push(String::new());
    }
    for a in &resolved.actors {
        let id = text(a.actor, "id");
        if flag(a.actor, &["static"]) {
            let pose_name = identifier("initial_pose", id);
            let pose = Pose {
                x: num(a.actor, &["initial", "pose", "x"]),
                z: num(a.actor, &["initial", "pose", "z"]),
                heading_rad: num(a.actor, &["initial", "pose", "headingRad"]),
            };
            content.push(indent(
                &[
                    pose_declaration(&pose_name, pose),
                    format!("{}.location(pose: {pose_name})", a.name),
                ]
                .join("\n"),
                4,
            ));
        } else {
            content.push(indent(&path_declaration(&a.route_name, &a.points), 4));
        }
        content.push(String::new());
    }
    for o in items(input, "occluders") {
        content.push(indent(&occluder_declaration(o), 4));
        content.push(String::new());
    }
    content.push(format!("    do parallel(duration: {}s):", finite(clip)));
    for a in &resolved.actors {
        if !flag(a.actor, &["static"]) {
            content.push(indent(
                &initial_actor_branch(a.actor, &a.name, &a.route_name, clip),
                8,
            ));
        }
    }
    for (time, id, text_out) in &branches {
        let mut branch = vec![format!("serial: # {id}")];
        if *time > 0.0 {
            branch.push(format!("    wait elapsed({}s)", finite(*time)));
        }
        branch.push(indent(text_out, 4));
        content.push(indent(&branch.join("\n"), 8));
    }
    content.push(String::new());
    let content = content.join("\n");

    // The exporter's own grammar gate: a syntactically invalid artifact never
    // escapes because an external compiler happens to be unavailable.
    let diagnostics = super::dsl_syntax::validate_dsl22_profile_syntax(&content);
    if !diagnostics.is_empty() {
        return Err(ExportFailure::Error(CompileError::new(
            "internal_error",
            format!(
                "Dsl22SyntaxError: OpenSCENARIO DSL 2.2 profile syntax rejected {} diagnostic{}",
                diagnostics.len(),
                if diagnostics.len() == 1 { "" } else { "s" }
            ),
        )));
    }
    Ok(ExportDocument {
        format: AsamFormat::Osc22,
        standard: "ASAM OpenSCENARIO DSL 2.2.0",
        media_type: "text/plain",
        content,
        warnings: merge_warnings(&[&[], &capability_warnings, &controller_warnings]),
        capability_report: report,
    })
}
