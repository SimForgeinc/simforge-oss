//! OpenSCENARIO XML 1.4.0 trajectory replay, and its esmini 1.3.1 lowering.

use std::collections::{BTreeMap, HashSet};

use simforge_bindings_common::runtime::{check_feasibility_json, MapAsset, Scenario};
use simforge_core::types::SimScenarioInput;

use super::{
    actor_backends, analyze_capabilities, finite, identifier, issue, items, js_num, js_string,
    merge_warnings, num, physics_of, resolve_scenario, stringify, text, xml_escape as xml,
    AsamFormat, AsamIssue, ExportDocument, ExportFailure, ExportOptions, ExportResult, Profile,
    Resolved,
};
use crate::jsvalue::JsValue;

fn lines(text: &str, spaces: usize) -> String {
    let prefix = " ".repeat(spaces);
    text.split('\n')
        .map(|l| format!("{prefix}{l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn world_position(x: f64, y: f64, heading: f64) -> String {
    format!(
        r#"<WorldPosition x="{}" y="{}" z="0" h="{}" p="0" r="0"/>"#,
        finite(x),
        finite(y),
        finite(heading)
    )
}

fn at_f64(track: &JsValue, key: &str, index: usize) -> Option<f64> {
    track
        .get(key)
        .and_then(JsValue::as_array)
        .and_then(|a| a.get(index))
        .and_then(JsValue::as_f64)
}

fn trajectory_xml(actor_id: &str, trace: &JsValue, warmup: f64) -> String {
    let null = JsValue::Null;
    let track = trace.at(&["ticks", "actors", actor_id]).unwrap_or(&null);
    let t = items(trace.get("ticks").unwrap_or(&null), "t");
    let kinematic = |index: usize| if index == 0 && t.len() > 1 { 1 } else { index };
    let motion_speed = |index: usize| {
        let sample = kinematic(index);
        let direction = at_f64(track, "motionDirection", sample).unwrap_or(1.0);
        at_f64(track, "speedMps", sample).unwrap_or(f64::NAN) * direction
    };
    let vertices: Vec<String> = t
        .iter()
        .enumerate()
        .map(|(index, time)| {
            [
                format!(
                    r#"<Vertex time="{}">"#,
                    finite(time.as_f64().unwrap_or(f64::NAN) + warmup)
                ),
                format!(
                    "  <Position>{}</Position>",
                    world_position(
                        at_f64(track, "x", index).unwrap_or(f64::NAN),
                        at_f64(track, "y", index).unwrap_or(f64::NAN),
                        at_f64(track, "headingRad", kinematic(index)).unwrap_or(f64::NAN),
                    )
                ),
                format!(
                    r#"  <Motion speed_longitudinal="{}"/>"#,
                    finite(motion_speed(index))
                ),
                "</Vertex>".to_owned(),
            ]
            .join("\n")
        })
        .collect();
    let mut out = vec![
        format!(
            r#"<Trajectory name="{}" closed="false">"#,
            xml(&identifier("trajectory", actor_id))
        ),
        "  <Shape><Polyline>".to_owned(),
    ];
    out.extend(vertices.iter().map(|v| lines(v, 4)));
    out.push("    <Interpolation/>".into());
    out.push("  </Polyline></Shape>".into());
    out.push("</Trajectory>".into());
    out.join("\n")
}

fn follow_trajectory_action(actor_id: &str, trace: &JsValue, warmup: f64) -> String {
    [
        "<PrivateAction>".to_owned(),
        "  <RoutingAction>".into(),
        "    <FollowTrajectoryAction>".into(),
        r#"      <TimeReference><Timing domainAbsoluteRelative="absolute" scale="1" offset="0"/></TimeReference>"#.into(),
        r#"      <TrajectoryFollowingMode followingMode="position"/>"#.into(),
        "      <TrajectoryRef>".into(),
        lines(&trajectory_xml(actor_id, trace, warmup), 8),
        "      </TrajectoryRef>".into(),
        "    </FollowTrajectoryAction>".into(),
        "  </RoutingAction>".into(),
        "</PrivateAction>".into(),
    ]
    .join("\n")
}

fn traffic_signal_state_action(head_id: &str, state: &str) -> String {
    format!(
        r#"<GlobalAction><InfrastructureAction><TrafficSignalAction><TrafficSignalStateAction name="{}" state="{state}"/></TrafficSignalAction></InfrastructureAction></GlobalAction>"#,
        xml(head_id)
    )
}

// 1.0472 is the exporter's literal sun elevation (rad), kept for byte parity, not pi/3.
#[allow(clippy::approx_constant)]
fn environment_action(input: &JsValue) -> String {
    let null = JsValue::Null;
    let c = input.get("operationalConditions").unwrap_or(&null);
    let time = match text(c, "timeOfDay") {
        "dawn" => "2020-06-21T06:00:00Z",
        "day" => "2020-06-21T12:00:00Z",
        "dusk" => "2020-06-21T18:00:00Z",
        "night" => "2020-06-21T00:00:00Z",
        _ => "undefined",
    };
    let (clouds, precipitation, intensity, sun, illuminance) = match text(c, "weather") {
        "overcast" => ("eightOktas", "dry", 0.0, 0.6, 20_000.0),
        "rain" => ("eightOktas", "rain", 0.6, 0.45, 10_000.0),
        _ => ("zeroOktas", "dry", 0.0, 1.0472, 100_000.0),
    };
    let visibility = num(c, &["effects", "visibilityRangeM"]).min(100_000.0);
    [
        "<GlobalAction><EnvironmentAction>".to_owned(),
        r#"  <Environment name="uniscenarios_environment">"#.into(),
        format!(r#"    <TimeOfDay animation="false" dateTime="{time}"/>"#),
        format!(r#"    <Weather fractionalCloudCover="{clouds}">"#),
        format!(r#"      <Sun azimuth="0" elevation="{}" illuminance="{}"/>"#, finite(sun), finite(illuminance)),
        format!(r#"      <Fog visualRange="{}"/>"#, finite(visibility)),
        format!(
            r#"      <Precipitation precipitationType="{precipitation}" precipitationIntensity="{}"/>"#,
            finite(intensity)
        ),
        "    </Weather>".into(),
        format!(r#"    <RoadCondition frictionScaleFactor="{}">"#, finite(num(c, &["effects", "frictionScale"]))),
        "      <Properties>".into(),
        format!(
            r#"        <Property name="uniscenarios.environment.trafficSpeedFactor" value="{}"/>"#,
            finite(num(c, &["effects", "trafficSpeedFactor"]))
        ),
        format!(
            r#"        <Property name="uniscenarios.environment.visibilityClass" value="{}"/>"#,
            xml(text(c, "visibility"))
        ),
        "      </Properties>".into(),
        "    </RoadCondition>".into(),
        "  </Environment>".into(),
        "</EnvironmentAction></GlobalAction>".into(),
    ]
    .join("\n")
}

/// `compactSignalTracks`: each program's logical indication changes.
fn compact_signal_tracks(input: &JsValue, trace: &JsValue) -> ExportResult<JsValue> {
    let null = JsValue::Null;
    let t = items(trace.get("ticks").unwrap_or(&null), "t");
    let warmup = num(input, &["warmupSeconds"]);
    let mut out = Vec::new();
    for program in items(input, "signalPrograms") {
        let id = text(program, "id");
        let phases = trace
            .at(&["ticks", "signals", id, "phase"])
            .and_then(JsValue::as_array);
        let Some(phases) = phases.filter(|p| p.len() == t.len()) else {
            return Err(ExportFailure::Unsupported(vec![issue(
                "missing_signal_replay_track",
                format!("signalPrograms.{id}"),
                format!("simulation did not produce a complete logical signal track for {id}"),
            )]));
        };
        let changes: Vec<JsValue> = phases
            .iter()
            .enumerate()
            .filter(|(i, state)| *i == 0 || Some(*state) != phases.get(i - 1))
            .map(|(i, state)| {
                JsValue::Object(vec![
                    (
                        "t".into(),
                        JsValue::Number(t[i].as_f64().unwrap_or(f64::NAN) + warmup),
                    ),
                    ("state".into(), (*state).clone()),
                ])
            })
            .collect();
        out.push(JsValue::Object(vec![
            ("programId".into(), JsValue::String(id.to_owned())),
            (
                "headIds".into(),
                program
                    .at(&["mapBinding", "headIds"])
                    .cloned()
                    .unwrap_or(JsValue::Array(Vec::new())),
            ),
            ("changes".into(), JsValue::Array(changes)),
        ]));
    }
    Ok(JsValue::Array(out))
}

fn bounding_box(actor: &JsValue) -> String {
    let h = num(actor, &["dims", "h"]);
    [
        "<BoundingBox>".to_owned(),
        format!(r#"  <Center x="0" y="0" z="{}"/>"#, finite(h / 2.0)),
        format!(
            r#"  <Dimensions width="{}" length="{}" height="{}"/>"#,
            finite(num(actor, &["dims", "w"])),
            finite(num(actor, &["dims", "l"])),
            finite(h)
        ),
        "</BoundingBox>".into(),
    ]
    .join("\n")
}

fn actor_entity(actor: &JsValue, name: &str) -> String {
    let kind = text(actor, "kind");
    let tags: Vec<&str> = items(actor, "tags")
        .iter()
        .filter_map(JsValue::as_str)
        .collect();
    let mut properties = vec![
        format!(
            r#"<Property name="uniscenarios.actorId" value="{}"/>"#,
            xml(text(actor, "id"))
        ),
        format!(
            r#"<Property name="uniscenarios.actorKind" value="{}"/>"#,
            xml(kind)
        ),
    ];
    if let Some(profile) = tags.iter().find(|t| t.starts_with("driver-profile:")) {
        properties.push(format!(
            r#"<Property name="uniscenarios.driverProfile" value="{}"/>"#,
            xml(&profile["driver-profile:".len()..])
        ));
    }
    properties.extend(
        tags.iter()
            .map(|t| format!(r#"<Property name="uniscenarios.tag" value="{}"/>"#, xml(t))),
    );
    let props = |out: &mut Vec<String>| out.extend(properties.iter().map(|p| format!("      {p}")));
    if matches!(kind, "pedestrian" | "sidewalk_robot" | "drone" | "animal") {
        let category = if kind == "animal" {
            "animal"
        } else {
            "pedestrian"
        };
        let mass = match kind {
            "animal" => 40,
            "sidewalk_robot" => 70,
            "drone" => 12,
            _ => 80,
        };
        let mut out = vec![
            format!(r#"<ScenarioObject name="{}">"#, xml(name)),
            format!(
                r#"  <Pedestrian name="uniscenarios_{kind}" mass="{mass}" pedestrianCategory="{category}">"#
            ),
            lines(&bounding_box(actor), 4),
            "    <Properties>".into(),
        ];
        props(&mut out);
        out.extend([
            "    </Properties>".into(),
            "  </Pedestrian>".into(),
            "</ScenarioObject>".into(),
        ]);
        return out.join("\n");
    }
    if kind == "static_object" {
        let mut out = vec![
            format!(r#"<ScenarioObject name="{}">"#, xml(name)),
            r#"  <MiscObject mass="1" name="uniscenarios_static_object" miscObjectCategory="obstacle">"#.to_owned(),
            lines(&bounding_box(actor), 4),
            "    <Properties>".into(),
        ];
        props(&mut out);
        out.extend([
            "    </Properties>".into(),
            "  </MiscObject>".into(),
            "</ScenarioObject>".into(),
        ]);
        return out.join("\n");
    }
    let category = match kind {
        "vehicle" => "other",
        "car" => "car",
        "truck" => "heavyTruck",
        "bus" => "bus",
        "van" => "van",
        "motorcycle" => "motorcycle",
        "bicycle" => "bicycle",
        "scooter" => "standupScooter",
        _ => "undefined",
    };
    let (l, w, h) = (
        num(actor, &["dims", "l"]),
        num(actor, &["dims", "w"]),
        num(actor, &["dims", "h"]),
    );
    let wheel = 0.8f64.min(0.3f64.max(h * 0.45));
    let track = 0.5f64.max(w * 0.84);
    // The reference point is the footprint centre, so the axles sit either
    // side of it, a wheelbase of 0.58 l apart, inside the bumpers.
    let half_wheelbase = (0.45 * l).min(0.25f64.max(l * 0.29));
    let mut out = vec![
        format!(r#"<ScenarioObject name="{}">"#, xml(name)),
        format!(r#"  <Vehicle name="uniscenarios_{kind}" vehicleCategory="{category}">"#),
        lines(&bounding_box(actor), 4),
        r#"    <Performance maxSpeed="100" maxAcceleration="12" maxDeceleration="12"/>"#.into(),
        "    <Axles>".into(),
        format!(
            r#"      <FrontAxle maxSteering="0.7" wheelDiameter="{}" trackWidth="{}" positionX="{}" positionZ="{}"/>"#,
            finite(wheel),
            finite(track),
            finite(half_wheelbase),
            finite(wheel / 2.0)
        ),
        format!(
            r#"      <RearAxle maxSteering="0" wheelDiameter="{}" trackWidth="{}" positionX="{}" positionZ="{}"/>"#,
            finite(wheel),
            finite(track),
            finite(-half_wheelbase),
            finite(wheel / 2.0)
        ),
        "    </Axles>".into(),
        "    <Properties>".into(),
    ];
    props(&mut out);
    out.extend([
        "    </Properties>".into(),
        "  </Vehicle>".into(),
        "</ScenarioObject>".into(),
    ]);
    out.join("\n")
}

fn occluder_entity(o: &JsValue) -> String {
    let name = identifier("occluder", text(o, "id"));
    let h = num(o, &["obb", "heightM"]);
    let mut out = vec![
        format!(r#"<ScenarioObject name="{}">"#, xml(&name)),
        r#"  <MiscObject mass="1" name="uniscenarios_occluder" miscObjectCategory="obstacle">"#
            .to_owned(),
        "    <BoundingBox>".into(),
        format!(r#"      <Center x="0" y="0" z="{}"/>"#, finite(h / 2.0)),
        format!(
            r#"      <Dimensions width="{}" length="{}" height="{}"/>"#,
            finite(num(o, &["obb", "widthM"])),
            finite(num(o, &["obb", "lengthM"])),
            finite(h)
        ),
        "    </BoundingBox>".into(),
        "    <Properties>".into(),
        format!(
            r#"      <Property name="uniscenarios.occluderId" value="{}"/>"#,
            xml(text(o, "id"))
        ),
    ];
    if let Some(group) = o
        .get("groupId")
        .and_then(JsValue::as_str)
        .filter(|g| !g.is_empty())
    {
        out.push(format!(
            r#"      <Property name="uniscenarios.occluderGroupId" value="{}"/>"#,
            xml(group)
        ));
    }
    out.extend([
        "    </Properties>".into(),
        "  </MiscObject>".into(),
        "</ScenarioObject>".into(),
    ]);
    out.join("\n")
}

fn vehicle_light_action(light: &str, mode: &str) -> String {
    let flashing = if mode == "flashing" {
        r#" flashingOnDuration="0.5" flashingOffDuration="0.5""#
    } else {
        ""
    };
    [
        "<PrivateAction>".to_owned(),
        "  <AppearanceAction>".into(),
        r#"    <LightStateAction transitionTime="0">"#.into(),
        format!(r#"      <LightType><VehicleLight vehicleLightType="{light}"/></LightType>"#),
        format!(r#"      <LightState mode="{mode}"{flashing}/>"#),
        "    </LightStateAction>".into(),
        "  </AppearanceAction>".into(),
        "</PrivateAction>".into(),
    ]
    .join("\n")
}

fn door_animation_action(component: &str, value: &str) -> Option<String> {
    let state = match value {
        "opening" | "open" => 1,
        "closing" | "closed" => 0,
        _ => return None,
    };
    let duration = if value == "opening" || value == "closing" {
        1
    } else {
        0
    };
    Some(
        [
            "<PrivateAction>".to_owned(),
            "  <AppearanceAction>".into(),
            format!(r#"    <AnimationAction loop="false" animationDuration="{duration}">"#),
            format!(
                r#"      <AnimationType><ComponentAnimation><VehicleComponent vehicleComponentType="{component}"/></ComponentAnimation></AnimationType>"#
            ),
            format!(r#"      <AnimationState state="{state}"/>"#),
            "    </AnimationAction>".into(),
            "  </AppearanceAction>".into(),
            "</PrivateAction>".into(),
        ]
        .join("\n"),
    )
}

fn user_defined_animation_action(key: &str, value: &JsValue) -> String {
    let kind = format!("simforge:{key}:{}", js_string(value));
    [
        "<PrivateAction>".to_owned(),
        "  <AppearanceAction>".into(),
        r#"    <AnimationAction loop="false" animationDuration="0">"#.into(),
        format!(r#"      <AnimationType><UserDefinedAnimation userDefinedAnimationType="{}"/></AnimationType>"#, xml(&kind)),
        "    </AnimationAction>".into(),
        "  </AppearanceAction>".into(),
        "</PrivateAction>".into(),
    ]
    .join("\n")
}

/// `setAppearanceActions`: an appearance `set` as XML actions.
fn set_appearance_actions(
    input: &JsValue,
    interaction: &JsValue,
) -> Result<Vec<String>, AsamIssue> {
    let actor_id = text(interaction, "actorId");
    let null = JsValue::Null;
    let actor = items(input, "actors")
        .iter()
        .find(|a| text(a, "id") == actor_id)
        .unwrap_or(&null);
    let kind = text(actor, "kind");
    let id = text(interaction, "id");
    let key = interaction
        .at(&["target", "key"])
        .and_then(JsValue::as_str)
        .unwrap_or("");
    let value = interaction
        .at(&["target", "value"])
        .cloned()
        .unwrap_or(JsValue::Null);
    let path = format!("interactions.{id}.target.key");
    if (key.starts_with("lights.") || key.starts_with("doors."))
        && matches!(kind, "pedestrian" | "animal" | "static_object")
    {
        return Err(issue(
            "unsupported_appearance_actor",
            path,
            format!("{key} requires an XML Vehicle entity, but {actor_id} is {kind}"),
        ));
    }
    if key.starts_with("doors.") && !matches!(kind, "car" | "truck" | "bus" | "van") {
        return Err(issue(
            "unsupported_appearance_actor",
            path,
            format!("{key} requires a door-capable vehicle class, but {actor_id} is {kind}"),
        ));
    }
    if key == "lights.reverse" && matches!(kind, "bicycle" | "scooter" | "motorcycle") {
        return Err(issue(
            "unsupported_appearance_actor",
            path,
            format!("{key} is not defined for the {kind} semantic class"),
        ));
    }
    if key == "lights.indicator" {
        match &value {
            JsValue::String(s) if s == "left" => {
                return Ok(vec![
                    vehicle_light_action("indicatorLeft", "flashing"),
                    vehicle_light_action("indicatorRight", "off"),
                ])
            }
            JsValue::String(s) if s == "right" => {
                return Ok(vec![
                    vehicle_light_action("indicatorLeft", "off"),
                    vehicle_light_action("indicatorRight", "flashing"),
                ])
            }
            JsValue::String(s) if s == "hazard" => {
                return Ok(vec![vehicle_light_action("warningLights", "flashing")])
            }
            JsValue::String(s) if s == "off" || s == "none" => {
                return Ok(vec![
                    vehicle_light_action("indicatorLeft", "off"),
                    vehicle_light_action("indicatorRight", "off"),
                    vehicle_light_action("warningLights", "off"),
                ])
            }
            JsValue::Bool(false) => {
                return Ok(vec![
                    vehicle_light_action("indicatorLeft", "off"),
                    vehicle_light_action("indicatorRight", "off"),
                    vehicle_light_action("warningLights", "off"),
                ])
            }
            _ => {}
        }
    }
    if key == "lights.reverse" {
        if let JsValue::Bool(on) = value {
            return Ok(vec![vehicle_light_action(
                "reversingLights",
                if on { "on" } else { "off" },
            )]);
        }
    }
    if key == "lights.brake" {
        if let JsValue::Bool(on) = value {
            return Ok(vec![vehicle_light_action(
                "brakeLights",
                if on { "on" } else { "off" },
            )]);
        }
    }
    let door = match key {
        "doors.left" => Some("doorFrontLeft"),
        "doors.right" => Some("doorFrontRight"),
        "doors.rear" => Some("trunk"),
        _ => None,
    };
    if let (Some(component), JsValue::String(v)) = (door, &value) {
        if let Some(action) = door_animation_action(component, v) {
            return Ok(vec![action]);
        }
    }
    if key.starts_with("pose.") || key == "lights.emergency" || key == "audio.horn" {
        return Ok(vec![user_defined_animation_action(key, &value)]);
    }
    Err(issue(
        "unsupported_set_action",
        path,
        format!("{key} has no standard XML 1.4 action with equivalent semantics"),
    ))
}

const REPLAYABLE_SET_KEYS: [&str; 8] = [
    "lights.indicator",
    "lights.reverse",
    "lights.brake",
    "doors.left",
    "doors.right",
    "doors.rear",
    "lights.emergency",
    "audio.horn",
];

/// `validateXmlProfile(input, 'trajectory-replay')`.
fn validate_replay_profile(input: &JsValue) -> ExportResult<()> {
    let mut issues = Vec::new();
    let dt = num(input, &["dt"]);
    for path in ["warmupSeconds", "clipSeconds"] {
        let seconds = num(input, &[path]);
        let ticks = seconds / dt;
        if (ticks - ticks.round()).abs() > 1e-9 {
            issues.push(issue(
                "non_integral_replay_duration",
                path,
                format!(
                    "{path}={} is not an integer number of dt={} fixed steps; exporting the rounded engine trace would change the authored clock",
                    js_num(seconds),
                    js_num(dt)
                ),
            ));
        }
    }
    for (i, prop) in items(input, "props").iter().enumerate() {
        let id = text(prop, "id");
        issues.push(issue(
            "unsupported_prop",
            format!("props.{i}"),
            if prop.get("collidable").is_some_and(JsValue::truthy) {
                format!("prop {id} has collision geometry that is not emitted by the XML 1.4 profile")
            } else {
                format!("prop {id} is not emitted by the XML 1.4 profile; its identity, pose, geometry, and attachment semantics would be lost")
            },
        ));
    }
    for (i, actor) in items(input, "actors").iter().enumerate() {
        let is_static = actor.get("static").is_some_and(JsValue::truthy);
        if text(actor, "kind") == "static_object" && !is_static {
            issues.push(issue(
                "unsupported_moving_misc_object",
                format!("actors.{i}.kind"),
                "the XML profile exports static_object as MiscObject and does not substitute vehicle motion semantics",
            ));
        }
        if is_static && num(actor, &["initial", "speedMps"]) > 1e-9 {
            issues.push(issue(
                "invalid_static_actor_speed",
                format!("actors.{i}.initial.speedMps"),
                "a static actor cannot preserve a non-zero initial speed",
            ));
        }
    }
    for interaction in items(input, "interactions") {
        if text(interaction, "verb") != "set" {
            continue;
        }
        let key = interaction
            .at(&["target", "key"])
            .and_then(JsValue::as_str)
            .unwrap_or("");
        let replayable = key.starts_with("pose.") || REPLAYABLE_SET_KEYS.contains(&key);
        let embodied = key.starts_with("rules.") || key.starts_with("signal:");
        if !replayable && !embodied {
            issues.push(issue(
                "unsupported_set_action",
                format!("interactions.{}.target.key", text(interaction, "id")),
                format!("{key} has no standard XML 1.4 action with equivalent semantics"),
            ));
        }
    }
    let mut head_owners: BTreeMap<String, usize> = BTreeMap::new();
    for (i, program) in items(input, "signalPrograms").iter().enumerate() {
        let Some(binding) = program.get("mapBinding").filter(|b| b.truthy()) else {
            issues.push(issue(
                "missing_signal_map_binding",
                format!("signalPrograms.{i}.mapBinding"),
                "XML TrafficSignalController.name must reference a concrete road-network controller",
            ));
            continue;
        };
        if items(binding, "controllerHeadGroups").is_empty() {
            issues.push(issue(
                "missing_signal_controller_head_groups",
                format!("signalPrograms.{i}.mapBinding.controllerHeadGroups"),
                "flattened controller/head ids do not preserve authoritative OpenDRIVE controller-stage membership",
            ));
            continue;
        }
        for (h, head) in items(binding, "headIds").iter().enumerate() {
            let head = js_string(head);
            match head_owners.get(&head) {
                Some(owner) => issues.push(issue(
                    "duplicate_signal_head_binding",
                    format!("signalPrograms.{i}.mapBinding.headIds.{h}"),
                    format!("{head} is already controlled by signalPrograms.{owner}"),
                )),
                None => {
                    head_owners.insert(head, i);
                }
            }
        }
    }
    if !issues.is_empty() {
        return Err(ExportFailure::Unsupported(issues));
    }
    Ok(())
}

/// One engine pass with the warm-up recorded; runtime errors that the
/// feasibility guards do not already report refuse the export.
fn replay_trace(typed: &SimScenarioInput, map: &MapAsset) -> ExportResult<JsValue> {
    let failed = |reason: String| {
        ExportFailure::Unsupported(vec![issue("trajectory_replay_failed", "input", reason)])
    };
    let bytes = serde_json::to_vec(typed).map_err(|e| failed(e.to_string()))?;
    let scenario = Scenario::parse(&bytes).map_err(|e| failed(e.to_string()))?;
    let mut options = map
        .graph()
        .run_options(Some(r#"{"includeWarmupTrace":true}"#))
        .map_err(|e| failed(e.to_string()))?;
    options.capture_trace = true;
    let result = simforge_core::engine::run_simulation(scenario.input().clone(), options)
        .map_err(|e| failed(e.to_string()))?;
    let feasibility_text =
        check_feasibility_json(&scenario, map.graph()).map_err(|e| failed(e.to_string()))?;
    let feasibility: Vec<serde_json::Value> =
        serde_json::from_str(&feasibility_text).unwrap_or_default();
    let known: HashSet<String> = feasibility
        .iter()
        .map(|i| {
            format!(
                "{}\u{0}{}",
                i.get("code").and_then(|v| v.as_str()).unwrap_or(""),
                i.get("path").and_then(|v| v.as_str()).unwrap_or("")
            )
        })
        .collect();
    let issues = JsValue::from_serialize(&result.issues)?;
    let errors: Vec<AsamIssue> = items_of(&issues)
        .iter()
        .enumerate()
        .filter(|(_, i)| text(i, "severity") == "error")
        .filter(|(_, i)| !known.contains(&format!("{}\u{0}{}", text(i, "code"), text(i, "path"))))
        .map(|(index, i)| {
            let path = i
                .get("path")
                .and_then(JsValue::as_str)
                .map_or_else(|| format!("simulation.issues.{index}"), str::to_owned);
            issue(
                "trajectory_replay_simulation_error",
                path,
                text(i, "reason"),
            )
        })
        .collect();
    if !errors.is_empty() {
        return Err(ExportFailure::Unsupported(errors));
    }
    Ok(JsValue::from_serialize(&result.trace)?)
}

fn items_of(value: &JsValue) -> &[JsValue] {
    value.as_array().unwrap_or(&[])
}

fn scheduled_event(name: &str, actions: &[String], at: f64, single: bool) -> String {
    let trigger = format!(
        r#"<StartTrigger><ConditionGroup><Condition name="{}" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="{}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>"#,
        xml(&format!("{name}_start")),
        finite(at)
    );
    let mut out = vec![format!(
        r#"<Event name="{}" priority="override" maximumExecutionCount="1">"#,
        xml(name)
    )];
    if single {
        out.push(lines(
            &format!(
                r#"<Action name="{}">{}</Action>"#,
                xml(&format!("{name}_action")),
                actions[0]
            ),
            2,
        ));
    } else {
        out.extend(actions.iter().enumerate().map(|(i, a)| {
            lines(
                &format!(
                    r#"<Action name="{}">{a}</Action>"#,
                    xml(&format!("{name}_action_{i}"))
                ),
                2,
            )
        }));
    }
    out.push(lines(&trigger, 2));
    out.push("</Event>".into());
    out.join("\n")
}

fn property(name: &str, value: &str) -> String {
    format!(r#"<Property name="{name}" value="{value}"/>"#)
}

/// `exportOpenScenarioXml14(input, {executionMode: 'trajectory-replay'})`.
pub(crate) fn export_xml14(
    input: &JsValue,
    typed: &SimScenarioInput,
    map: &MapAsset,
    options: &ExportOptions,
) -> ExportResult<ExportDocument> {
    let (report, capability_warnings) = analyze_capabilities(input, Profile::Xml14Replay);
    validate_replay_profile(input)?;
    let trace = replay_trace(typed, map)?;
    let resolved: Resolved<'_> = resolve_scenario(input, map.graph(), options, false)?;
    let warmup = num(input, &["warmupSeconds"]);
    let null = JsValue::Null;
    let ticks_t = items(trace.get("ticks").unwrap_or(&null), "t");
    let tick_time = |index: usize| {
        ticks_t
            .get(index)
            .and_then(JsValue::as_f64)
            .unwrap_or(f64::NAN)
    };
    let mut issues: Vec<AsamIssue> = Vec::new();
    let mut actor_events: Vec<(String, Vec<String>)> = resolved
        .actors
        .iter()
        .map(|a| (text(a.actor, "id").to_owned(), Vec::new()))
        .collect();
    let push_event = |events: &mut Vec<(String, Vec<String>)>, actor_id: &str, event: String| {
        if let Some((_, list)) = events.iter_mut().find(|(id, _)| id == actor_id) {
            list.push(event);
        }
    };

    for entry in &resolved.interactions {
        let interaction = entry.interaction;
        let key = interaction
            .at(&["target", "key"])
            .and_then(JsValue::as_str)
            .unwrap_or("");
        if text(interaction, "verb") != "set"
            || key.starts_with("rules.")
            || key.starts_with("signal:")
        {
            continue;
        }
        let id = text(interaction, "id");
        let fired = items(&trace, "events")
            .iter()
            .find(|e| text(e, "kind") == "trigger_fired" && text(e, "interactionId") == id);
        let Some(fired) = fired else { continue };
        let actions = match set_appearance_actions(input, interaction) {
            Ok(actions) => actions,
            Err(found) => {
                issues.push(found);
                continue;
            }
        };
        let trigger = format!(
            r#"<StartTrigger><ConditionGroup><Condition name="{}" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="{}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>"#,
            xml(&format!("{id}_replay")),
            finite(warmup + num(fired, &["t"]))
        );
        let mut event = vec![format!(
            r#"<Event name="{}" priority="override" maximumExecutionCount="1">"#,
            xml(&entry.name)
        )];
        event.extend(actions.iter().enumerate().map(|(i, a)| {
            lines(
                &format!(
                    r#"<Action name="{}">{a}</Action>"#,
                    xml(&format!("{}_action_{i}", entry.name))
                ),
                2,
            )
        }));
        event.push(lines(&trigger, 2));
        event.push("</Event>".into());
        push_event(
            &mut actor_events,
            text(interaction, "actorId"),
            event.join("\n"),
        );
    }
    for actor in items(input, "actors") {
        let id = text(actor, "id");
        let present: Vec<f64> = trace
            .at(&["ticks", "actors", id, "present"])
            .and_then(JsValue::as_array)
            .unwrap_or(&[])
            .iter()
            .map(|p| p.as_f64().unwrap_or(f64::NAN))
            .collect();
        if present.first() == Some(&0.0) && present.contains(&1.0) {
            issues.push(issue(
                "unsupported_trajectory_spawn",
                format!("actors.{id}.presentAtStart"),
                "trajectory replay cannot atomically add an absent entity and start its timed trajectory",
            ));
        }
        for index in 1..present.len() {
            if present[index - 1] != 1.0 || present[index] != 0.0 {
                continue;
            }
            let name = identifier("event", &format!("{id}_trajectory_despawn_{index}"));
            let action = format!(
                r#"<GlobalAction><EntityAction entityRef="{}"><DeleteEntityAction/></EntityAction></GlobalAction>"#,
                xml(&identifier("actor", id))
            );
            // The delete fires on the last sample that still shows the entity.
            let event = scheduled_event(&name, &[action], warmup + tick_time(index - 1), true);
            push_event(&mut actor_events, id, event);
            break;
        }
    }
    let mut head_tracks: Vec<(String, Vec<JsValue>)> = Vec::new();
    for (p, program) in items(input, "signalPrograms").iter().enumerate() {
        let Some(binding) = program.get("mapBinding").filter(|b| b.truthy()) else {
            continue;
        };
        let id = text(program, "id");
        let phases = trace
            .at(&["ticks", "signals", id, "phase"])
            .and_then(JsValue::as_array);
        let Some(phases) = phases.filter(|ph| ph.len() == ticks_t.len()) else {
            issues.push(issue(
                "missing_signal_replay_track",
                format!("signalPrograms.{p}"),
                format!("simulation did not produce a complete phase track for {id}"),
            ));
            continue;
        };
        for (h, head) in items(binding, "headIds").iter().enumerate() {
            let head = js_string(head);
            if let Some((_, existing)) = head_tracks.iter().find(|(k, _)| *k == head) {
                if existing.iter().zip(phases.iter()).any(|(a, b)| a != b) {
                    issues.push(issue(
                        "conflicting_signal_head_replay",
                        format!("signalPrograms.{p}.mapBinding.headIds.{h}"),
                        format!("{head} is assigned incompatible phase timelines by multiple signal programs"),
                    ));
                    continue;
                }
                head_tracks.retain(|(k, _)| *k != head);
            }
            head_tracks.push((head, phases.to_vec()));
        }
    }
    head_tracks.sort_by(|a, b| simforge_core::hash::cmp_locale(&a.0, &b.0));
    let mut replay_signal_init = Vec::new();
    let mut changes: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for (head, track) in &head_tracks {
        replay_signal_init.push(traffic_signal_state_action(head, &js_string(&track[0])));
        for index in 1..track.len() {
            if track[index] == track[index - 1] {
                continue;
            }
            changes
                .entry(index)
                .or_default()
                .push(traffic_signal_state_action(head, &js_string(&track[index])));
        }
    }
    let signal_actor = items(input, "actors")
        .first()
        .map(|a| text(a, "id").to_owned());
    match &signal_actor {
        None if !changes.is_empty() => issues.push(issue(
            "signal_replay_without_actor",
            "actors",
            "scheduled XML signal-state actions require a storyboard maneuver group",
        )),
        Some(actor_id) => {
            for (index, actions) in &changes {
                let name = identifier("event", &format!("signal_replay_{index}"));
                let event = scheduled_event(&name, actions, warmup + tick_time(*index), false);
                push_event(&mut actor_events, actor_id, event);
            }
        }
        None => {}
    }
    if !issues.is_empty() {
        return Err(ExportFailure::Unsupported(issues));
    }

    let mut init_private = Vec::new();
    for resolved_actor in &resolved.actors {
        let actor = resolved_actor.actor;
        let id = text(actor, "id");
        let track = trace.at(&["ticks", "actors", id]).unwrap_or(&null);
        if at_f64(track, "present", 0) != Some(1.0) {
            continue;
        }
        let mut actions = vec![
            "<PrivateAction><TeleportAction><Position>".to_owned(),
            lines(
                &world_position(
                    at_f64(track, "x", 0).unwrap_or(f64::NAN),
                    at_f64(track, "y", 0).unwrap_or(f64::NAN),
                    at_f64(track, "headingRad", 0).unwrap_or(f64::NAN),
                ),
                4,
            ),
            "</Position></TeleportAction></PrivateAction>".to_owned(),
        ];
        if !actor.get("static").is_some_and(JsValue::truthy) {
            actions.push(follow_trajectory_action(id, &trace, warmup));
        }
        let mut private = vec![format!(
            r#"<Private entityRef="{}">"#,
            xml(&resolved_actor.name)
        )];
        private.extend(actions.iter().map(|a| lines(a, 2)));
        private.push("</Private>".into());
        init_private.push(private.join("\n"));
    }
    let init_occluders: Vec<String> = items(input, "occluders")
        .iter()
        .map(|o| {
            let name = identifier("occluder", text(o, "id"));
            format!(
                r#"<Private entityRef="{}"><PrivateAction><TeleportAction><Position>{}</Position></TeleportAction></PrivateAction></Private>"#,
                xml(&name),
                world_position(num(o, &["obb", "center", "x"]), -num(o, &["obb", "center", "z"]), num(o, &["obb", "headingRad"]))
            )
        })
        .collect();
    let maneuver_groups: Vec<String> = resolved
        .actors
        .iter()
        .filter_map(|a| {
            let id = text(a.actor, "id");
            let events = &actor_events.iter().find(|(k, _)| k == id)?.1;
            if events.is_empty() {
                return None;
            }
            let mut out = vec![
                format!(r#"<ManeuverGroup name="{}" maximumExecutionCount="1">"#, xml(&identifier("group", id))),
                format!(r#"  <Actors selectTriggeringEntities="false"><EntityRef entityRef="{}"/></Actors>"#, xml(&a.name)),
                format!(r#"  <Maneuver name="{}">"#, xml(&identifier("maneuver", id))),
            ];
            out.extend(events.iter().map(|e| lines(e, 4)));
            out.push("  </Maneuver>".into());
            out.push("</ManeuverGroup>".into());
            Some(out.join("\n"))
        })
        .collect();

    let (physics_mode, substep) = physics_of(
        input,
        &serde_json::to_value(typed.physics_mode())
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default(),
    );
    let signal_tracks = compact_signal_tracks(input, &trace)?;
    let header = trace.get("header").unwrap_or(&null);
    let header_text = |key: &str| xml(&js_string(header.get(key).unwrap_or(&JsValue::Null)));
    let replay_backends = {
        let mut rows: Vec<(String, String)> = match header.at(&["physics", "actorBackends"]) {
            Some(JsValue::Object(entries)) => entries
                .iter()
                .map(|(id, b)| {
                    (
                        id.clone(),
                        format!(
                            "{id}:{}:{}:{}",
                            js_string_or_undefined(b.get("mode")),
                            js_string_or_undefined(b.get("reason")),
                            js_string_or_undefined(b.get("profile"))
                        ),
                    )
                })
                .collect(),
            _ => Vec::new(),
        };
        rows.sort_by(|a, b| simforge_core::hash::cmp_locale(&a.0, &b.0));
        rows.into_iter()
            .map(|(_, r)| r)
            .collect::<Vec<_>>()
            .join(",")
    };
    let empty_object = JsValue::Object(Vec::new());
    let mut props = vec![
        property("uniscenarios.executionMode", "trajectory-replay"),
        property("uniscenarios.export.profile", report.profile),
        property("uniscenarios.export.intent", report.intent),
        property(
            "uniscenarios.input.schemaVersion",
            &js_string(input.get("schemaVersion").unwrap_or(&JsValue::Null)),
        ),
        property(
            "uniscenarios.input.seed",
            &xml(&js_string(input.get("seed").unwrap_or(&JsValue::Null))),
        ),
        property("uniscenarios.physics.mode", &physics_mode),
        property("uniscenarios.physics.substepS", &finite(substep)),
        property(
            "uniscenarios.physics.actorBackends",
            &xml(&actor_backends(input)),
        ),
        property(
            "uniscenarios.export.constructCapabilities.v1",
            &xml(&stringify(&JsValue::from_serialize(&report.constructs)?)),
        ),
        property(
            "uniscenarios.trajectoryReplay.inputHash",
            &header_text("inputHash"),
        ),
        property(
            "uniscenarios.trajectoryReplay.engineVersion",
            &header_text("engineVersion"),
        ),
        property("uniscenarios.trajectoryReplay.mapId", &header_text("mapId")),
        property(
            "uniscenarios.trajectoryReplay.dt",
            &finite(num(header, &["dt"])),
        ),
        property(
            "uniscenarios.trajectoryReplay.warmupSeconds",
            &finite(num(header, &["warmupSeconds"])),
        ),
        property(
            "uniscenarios.trajectoryReplay.clipSeconds",
            &finite(num(header, &["clipSeconds"])),
        ),
        property(
            "uniscenarios.trajectoryReplay.physics.mode",
            &xml(&js_string_or_undefined(header.at(&["physics", "mode"]))),
        ),
        property(
            "uniscenarios.trajectoryReplay.physics.substepS",
            &finite(num(header, &["physics", "substepS"])),
        ),
        property(
            "uniscenarios.trajectoryReplay.physics.solver",
            &xml(&js_string_or_undefined(header.at(&["physics", "solver"]))),
        ),
        property(
            "uniscenarios.trajectoryReplay.physics.solverVersion",
            &xml(&js_string_or_undefined(
                header.at(&["physics", "solverVersion"]),
            )),
        ),
        property(
            "uniscenarios.trajectoryReplay.physics.vehicleProfileDigest",
            &xml(&match header.at(&["physics", "vehicleProfileDigest"]) {
                None | Some(JsValue::Null) => "none".to_owned(),
                Some(v) => js_string(v),
            }),
        ),
        property(
            "uniscenarios.trajectoryReplay.physics.actorBackends",
            &xml(&replay_backends),
        ),
        property(
            "uniscenarios.trajectoryReplay.actorIds.v1",
            &xml(&stringify(header.get("actorIds").unwrap_or(&JsValue::Null))),
        ),
        property(
            "uniscenarios.trajectoryReplay.authoredActorIds.v1",
            &xml(&stringify(&JsValue::Array(
                items(input, "actors")
                    .iter()
                    .map(|a| a.get("id").cloned().unwrap_or(JsValue::Null))
                    .collect(),
            ))),
        ),
        property(
            "uniscenarios.trajectoryReplay.actorMetadata.v1",
            &xml(&stringify(match header.get("actorMetadata") {
                None | Some(JsValue::Null) => &empty_object,
                Some(v) => v,
            })),
        ),
        property(
            "uniscenarios.trajectoryReplay.interactions.v1",
            &xml(&stringify(
                input.get("interactions").unwrap_or(&JsValue::Null),
            )),
        ),
        property(
            "uniscenarios.trajectoryReplay.events.v1",
            &xml(&stringify(trace.get("events").unwrap_or(&JsValue::Null))),
        ),
        property(
            "uniscenarios.trajectoryReplay.signals.v1",
            &xml(&stringify(&signal_tracks)),
        ),
        property(
            "uniscenarios.trajectoryReplay.environment.v1",
            &xml(&stringify(
                input.get("operationalConditions").unwrap_or(&JsValue::Null),
            )),
        ),
        property(
            "uniscenarios.trajectoryReplay.surfacePatches.v1",
            &xml(&stringify(
                input.get("surfacePatches").unwrap_or(&JsValue::Null),
            )),
        ),
        property(
            "uniscenarios.trajectoryReplay.occluders.v1",
            &xml(&stringify(input.get("occluders").unwrap_or(&JsValue::Null))),
        ),
    ];
    if let Some(perception) = input.get("perception").filter(|p| p.truthy()) {
        props.push(property(
            "uniscenarios.trajectoryReplay.perception.v1",
            &xml(&stringify(perception)),
        ));
    }
    // OpenSCENARIO has no posture for a body on the ground; declare it.
    if let Some(JsValue::Object(tracks)) = trace.at(&["ticks", "actors"]) {
        let mut down: Vec<(&String, f64)> = tracks
            .iter()
            .filter_map(|(id, track)| {
                track
                    .get("downSinceS")
                    .and_then(JsValue::as_f64)
                    .map(|t| (id, t))
            })
            .collect();
        down.sort_by(|a, b| simforge_core::hash::cmp_locale(a.0, b.0));
        props.extend(down.into_iter().map(|(id, t)| {
            property(
                &format!("uniscenarios.trajectoryReplay.knockedDownAtS.{}", xml(id)),
                &finite(t),
            )
        }));
    }
    if let Some(provenance) = &options.provenance {
        let mut sorted: Vec<&(String, JsValue)> = provenance.iter().collect();
        sorted.sort_by(|a, b| simforge_core::hash::cmp_locale(&a.0, &b.0));
        props.extend(sorted.into_iter().map(|(k, v)| {
            property(
                &format!("uniscenarios.provenance.{}", xml(k)),
                &xml(&js_string(v)),
            )
        }));
    }
    for (index, criterion) in items(input, "nearMissCriteria").iter().enumerate() {
        let prefix = format!("uniscenarios.nearMiss.{index}");
        props.push(property(
            &format!("{prefix}.pedestrian"),
            &xml(text(criterion, "pedestrianId")),
        ));
        props.push(property(
            &format!("{prefix}.target"),
            &xml(text(criterion, "targetId")),
        ));
        props.push(property(
            &format!("{prefix}.clearanceM"),
            &finite(num(criterion, &["clearanceM"])),
        ));
        props.push(property(
            &format!("{prefix}.toleranceM"),
            &finite(
                criterion
                    .get("toleranceM")
                    .and_then(JsValue::as_f64)
                    .unwrap_or(0.15),
            ),
        ));
        props.push(property(
            &format!("{prefix}.pass"),
            criterion
                .get("pass")
                .and_then(JsValue::as_str)
                .unwrap_or("auto"),
        ));
        if let Some(hash) = criterion
            .get("planHash")
            .and_then(JsValue::as_str)
            .filter(|h| !h.is_empty())
        {
            props.push(property(&format!("{prefix}.planHash"), &xml(hash)));
        }
    }
    for program in items(input, "signalPrograms") {
        let id = xml(text(program, "id"));
        let binding = program.get("mapBinding").unwrap_or(&null);
        let join = |key: &str| {
            items(binding, key)
                .iter()
                .map(js_string)
                .collect::<Vec<_>>()
                .join(",")
        };
        props.push(property(
            &format!("uniscenarios.signal.{id}.timingSource"),
            &xml(&js_string_or_undefined(binding.get("timingSource"))),
        ));
        props.push(property(
            &format!("uniscenarios.signal.{id}.junctionId"),
            &xml(&js_string_or_undefined(binding.get("junctionId"))),
        ));
        props.push(property(
            &format!("uniscenarios.signal.{id}.controllerIds"),
            &xml(&join("controllerIds")),
        ));
        props.push(property(
            &format!("uniscenarios.signal.{id}.headIds"),
            &xml(&join("headIds")),
        ));
        let groups = items(binding, "controllerHeadGroups")
            .iter()
            .map(|g| {
                format!(
                    "{}:{}",
                    js_string_or_undefined(g.get("controllerId")),
                    items(g, "headIds")
                        .iter()
                        .map(js_string)
                        .collect::<Vec<_>>()
                        .join("+")
                )
            })
            .collect::<Vec<_>>()
            .join(";");
        props.push(property(
            &format!("uniscenarios.signal.{id}.controllerHeadGroups"),
            &xml(&groups),
        ));
    }

    let road_file = options
        .road_file
        .clone()
        .unwrap_or_else(|| format!("{}.xodr", text(input, "mapId")));
    let mut content: Vec<String> = vec![
        r#"<?xml version="1.0" encoding="UTF-8"?>"#.into(),
        "<OpenSCENARIO>".into(),
        format!(
            r#"  <FileHeader revMajor="1" revMinor="4" date="{}" description="{}" author="{}">"#,
            xml("1970-01-01T00:00:00.000Z"),
            xml(options
                .description
                .as_deref()
                .unwrap_or("Concrete SimForge scenario instance")),
            xml(options.author.as_deref().unwrap_or("SimForge"))
        ),
        "    <Properties>".into(),
    ];
    content.extend(props.iter().map(|p| format!("      {p}")));
    content.extend([
        "    </Properties>".into(),
        "  </FileHeader>".into(),
        "  <ParameterDeclarations/>".into(),
        "  <CatalogLocations/>".into(),
        "  <RoadNetwork>".into(),
        format!(r#"    <LogicFile filepath="{}"/>"#, xml(&road_file)),
        "  </RoadNetwork>".into(),
        "  <Entities>".into(),
    ]);
    content.extend(
        resolved
            .actors
            .iter()
            .map(|a| lines(&actor_entity(a.actor, &a.name), 4)),
    );
    content.extend(
        items(input, "occluders")
            .iter()
            .map(|o| lines(&occluder_entity(o), 4)),
    );
    content.extend([
        "  </Entities>".into(),
        "  <Storyboard>".into(),
        "    <Init><Actions>".into(),
    ]);
    content.push(lines(&environment_action(input), 6));
    content.extend(replay_signal_init.iter().map(|a| lines(a, 6)));
    content.extend(init_private.iter().map(|a| lines(a, 6)));
    content.extend(init_occluders.iter().map(|a| lines(a, 6)));
    content.push("    </Actions></Init>".into());
    if !maneuver_groups.is_empty() {
        content.push(r#"    <Story name="uniscenarios_story">"#.into());
        content.push(r#"      <Act name="uniscenarios_act">"#.into());
        content.extend(maneuver_groups.iter().map(|g| lines(g, 8)));
        content.push(r#"        <StartTrigger><ConditionGroup><Condition name="act_start" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="0" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>"#.into());
        content.push("      </Act>".into());
        content.push("    </Story>".into());
    }
    content.push(format!(
        r#"    <StopTrigger><ConditionGroup><Condition name="scenario_end" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="{}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StopTrigger>"#,
        finite(warmup + num(input, &["clipSeconds"]))
    ));
    content.extend([
        "  </Storyboard>".into(),
        "</OpenSCENARIO>".into(),
        String::new(),
    ]);

    let mut extra: Vec<AsamIssue> = Vec::new();
    if !items(input, "nearMissCriteria").is_empty() {
        extra.push(issue(
            "near_miss_criterion_metadata",
            "FileHeader.Properties",
            "OSC 1.4 preserves the executable condition and pedestrian trajectory; exact OBB-clearance acceptance remains SimForge metadata and must be re-evaluated from the simulator trace",
        ));
    }
    for interaction in items(input, "interactions") {
        let key = interaction
            .at(&["target", "key"])
            .and_then(JsValue::as_str)
            .unwrap_or("");
        if text(interaction, "verb") == "set" && key.starts_with("pose.") {
            extra.push(issue(
                "user_defined_animation",
                format!("interactions.{}.target.key", text(interaction, "id")),
                format!("{key} is preserved with XML UserDefinedAnimation and requires a simulator-specific animation implementation"),
            ));
        }
    }
    Ok(ExportDocument {
        format: AsamFormat::Xosc14,
        standard: "ASAM OpenSCENARIO XML 1.4.0",
        media_type: "application/xml",
        content: content.join("\n"),
        warnings: merge_warnings(&[&[], &capability_warnings, &[], &extra]),
        capability_report: report,
    })
}

fn js_string_or_undefined(value: Option<&JsValue>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js_string)
}

/// Remove the 1.4-only trajectory elements and map the 1.4-only categories.
fn lower_to_13(content: &str) -> ExportResult<String> {
    if content.matches(r#"revMajor="1" revMinor="4""#).count() != 1 {
        return Err(ExportFailure::Unsupported(vec![issue(
            "unexpected_source_version",
            "FileHeader",
            "the 1.3 lowering accepts exactly one ASAM OpenSCENARIO XML 1.4 FileHeader",
        )]));
    }
    let lowered = content
        .replacen(
            r#"revMajor="1" revMinor="4""#,
            r#"revMajor="1" revMinor="3""#,
            1,
        )
        .replace(r#"vehicleCategory="other""#, r#"vehicleCategory="car""#)
        .replace(
            r#"vehicleCategory="heavyTruck""#,
            r#"vehicleCategory="truck""#,
        )
        .replace(
            r#"vehicleCategory="motorcycle""#,
            r#"vehicleCategory="motorbike""#,
        )
        .replace(
            r#"vehicleCategory="standupScooter""#,
            r#"vehicleCategory="motorbike""#,
        );
    // `/\n\s*<Motion speed_longitudinal="[^"]+"\/>/g` and `/\n\s*<Interpolation\/>/g`.
    Ok(remove_line_element(
        &remove_line_element(&lowered, "<Motion speed_longitudinal=\"", true),
        "<Interpolation/>",
        false,
    ))
}

/// Remove every `\n<whitespace><element...>` occurrence (`with_attr`: the
/// element is `<Motion speed_longitudinal="[^"]+"/>`).
fn remove_line_element(text: &str, start: &str, with_attr: bool) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            if text[j..].starts_with(start) {
                let rest = j + start.len();
                let end = if with_attr {
                    // `[^"]+"/>`
                    match text[rest..].find('"') {
                        Some(q) if q > 0 && text[rest + q..].starts_with("\"/>") => {
                            Some(rest + q + 3)
                        }
                        _ => None,
                    }
                } else {
                    Some(rest)
                };
                if let Some(end) = end {
                    out.push_str(&text[copied..i]);
                    copied = end;
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// `exportOpenScenarioXml13Esmini` in deterministic-trajectory mode.
pub(crate) fn export_xml13_esmini(
    input: &JsValue,
    typed: &SimScenarioInput,
    map: &MapAsset,
    options: &ExportOptions,
) -> ExportResult<ExportDocument> {
    let base = export_xml14(input, typed, map, options)?;
    let (report, capability_warnings) = analyze_capabilities(input, Profile::Xml13EsminiReplay);
    let content = lower_to_13(&base.content)?
        .replace(
            r#"uniscenarios.export.profile" value="xml-1.4-actions"#,
            r#"uniscenarios.export.profile" value="xml-1.3-esmini-actions"#,
        )
        .replace(
            r#"uniscenarios.export.profile" value="xml-1.4-trajectory-replay"#,
            r#"uniscenarios.export.profile" value="xml-1.3-esmini-trajectory-replay"#,
        );
    let mut warnings = base.warnings;
    warnings.extend(capability_warnings);
    Ok(ExportDocument {
        format: AsamFormat::Xosc13Esmini,
        standard: "ASAM OpenSCENARIO XML 1.3.1 · esmini compatibility",
        media_type: "application/xml",
        content,
        warnings,
        capability_report: report,
    })
}
