//! Studio refinements of a concrete input: one implementation for every
//! executor (the editor's WASM worker, the host's N-API simulation, the
//! compiler service and the CLI).
//!
//! These used to be TypeScript (`@simforge-oss/playback` runtime refinements
//! and `@simforge-oss/compiler` `studio/`), applied by each caller before the
//! engine saw the input. They decide what the engine executes, so they belong
//! to the engine's semantics: a change here is covered by `ENGINE_SEM_VER`
//! like any other change to what a trace is a function of.
//!
//! Two stages:
//! - [`studio_concrete_input`]: authored presentation and baked world content
//!   carried by the document (`studio.presentation.bodyColor` paint tags on
//!   role actors, `studio.ambientTraffic.parkedCars.v1` baked parked cars).
//! - [`execution_refinements`]: repairs of the executed input
//!   (stable high-speed world routes, cruise restoration after a bounded
//!   speed action).
//!
//! Each transform works on the input's canonical JSON and re-parses it, so
//! the result is exactly what the engine's schema makes of the equivalent
//! document (defaults included). An input a transform does not touch is
//! returned unchanged.

use serde_json::{json, Map, Value};
use simforge_core::types::{parse_scenario_input_value, SimScenarioInput};

use crate::error::{CompileError, CompileResult};

pub const STUDIO_BODY_COLOR_TAG_PREFIX: &str = "studio:body-color:";
pub const STUDIO_BODY_COLOR_EXTENSION_KEY: &str = "studio.presentation.bodyColor";
pub const PARKED_CARS_EXTENSION_KEY: &str = "studio.ambientTraffic.parkedCars.v1";
/// Id prefix every baked parked car carries.
pub const PARKED_CAR_ID_PREFIX: &str = "parked:";
/// A parked car's degenerate route: two distinct points 1 mm apart along its
/// own heading (ASAM export refuses a single-point route).
pub const PARKED_CAR_ROUTE_M: f64 = 0.001;

const HIGH_SPEED_WORLD_ROUTE_MPS: f64 = 20.0;
const PASSENGER_CAR_MAX_LATERAL_ACCELERATION_MPS2: f64 = 7.0;
const MIN_STABLE_YAW_RATE_RADPS: f64 = 0.08;
const CRUISE_RESTORE_ACCELERATION_MPS2: f64 = 3.0;
const WHEELED_ROAD_ACTOR_KINDS: [&str; 7] = [
    "vehicle",
    "car",
    "van",
    "truck",
    "bus",
    "motorcycle",
    "bicycle",
];
const TIME_EPSILON: f64 = 1e-9;

/// One committed parked car, in scene metres.
#[derive(Debug, Clone, PartialEq)]
pub struct ParkedCar {
    pub id: String,
    pub stall_id: String,
    pub catalog_id: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub heading_rad: f64,
    pub length_m: f64,
    pub width_m: f64,
    pub height_m: f64,
}

/* ------------------------------------------------------------ entry points */

/// The document's Studio content applied to a materialised input: paint tags
/// reconciled onto role actors, then baked parked cars appended.
/// `template` is the document (only `roles[].id`, `roles[].extensions` and
/// `extensions` are read, so any template version is accepted).
pub fn studio_concrete_input(
    input: SimScenarioInput,
    template: &Value,
) -> CompileResult<SimScenarioInput> {
    let painted = with_studio_body_color_tags(input, template)?;
    with_parked_car_actors(painted, &baked_parked_cars(template.get("extensions")))
}

/// The refinements every executor applies to the input it runs.
pub fn execution_refinements(input: SimScenarioInput) -> CompileResult<SimScenarioInput> {
    with_bounded_speed_cruise_restoration(with_stable_high_speed_world_routes(input)?)
}

/* ------------------------------------------------------------- body colour */

/// `#rrggbb` for a hex or `rgb(r, g, b)` string; `None` for anything else.
/// Channels follow ECMAScript `Number()` exactly (the reconciliation was
/// TypeScript), so every document keeps the tag it had.
pub fn normalize_studio_body_color(value: Option<&Value>) -> Option<String> {
    let text = js_trim(value?.as_str()?).to_lowercase();
    if text.is_empty() {
        return None;
    }
    if let Some(hex) = text.strip_prefix('#') {
        if hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some(text.clone());
        }
        if hex.len() == 3 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some(format!(
                "#{}",
                hex.chars().flat_map(|c| [c, c]).collect::<String>()
            ));
        }
    }
    let inner = if text.starts_with("rgb(") && text.ends_with(')') && text.len() >= 5 {
        &text[4..text.len() - 1]
    } else {
        text.as_str()
    };
    let channels: Vec<&str> = inner.split(',').collect();
    if channels.len() != 3 {
        return None;
    }
    let mut out = String::from("#");
    for channel in channels {
        let parsed = js_number(channel)?;
        if parsed.fract() != 0.0 || !(0.0..=255.0).contains(&parsed) {
            return None;
        }
        out.push_str(&format!("{:02x}", parsed as u8));
    }
    Some(out)
}

/// Reconcile authored paint onto an already-materialised input: every
/// `role:<id>` actor carries exactly the tag its role's paint implies, and
/// stale paint tags are dropped.
pub fn with_studio_body_color_tags(
    input: SimScenarioInput,
    template: &Value,
) -> CompileResult<SimScenarioInput> {
    let mut colors: Map<String, Value> = Map::new();
    for role in template
        .get("roles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(id), Some(color)) = (
            role.get("id").and_then(Value::as_str),
            normalize_studio_body_color(
                role.get("extensions")
                    .and_then(|e| e.get(STUDIO_BODY_COLOR_EXTENSION_KEY)),
            ),
        ) else {
            continue;
        };
        colors.insert(id.to_owned(), Value::String(color));
    }
    let mut changed = false;
    let mut actors = input.actors.clone();
    for actor in &mut actors {
        let color = actor
            .tags
            .iter()
            .find_map(|tag| tag.strip_prefix("role:"))
            .and_then(|role| colors.get(role))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut tags: Vec<String> = actor
            .tags
            .iter()
            .filter(|t| !t.starts_with(STUDIO_BODY_COLOR_TAG_PREFIX))
            .cloned()
            .collect();
        if let Some(color) = color {
            tags.push(format!("{STUDIO_BODY_COLOR_TAG_PREFIX}{color}"));
        }
        if tags != actor.tags {
            actor.tags = tags;
            changed = true;
        }
    }
    if !changed {
        return Ok(input);
    }
    // Tags are free-form strings: no re-parse is needed to stay canonical.
    Ok(SimScenarioInput { actors, ..input })
}

/* ------------------------------------------------------------- parked cars */

/// Baked cars off a document's extension bag, dropping anything incomplete
/// (a hand-edited document is a supported input).
pub fn baked_parked_cars(extensions: Option<&Value>) -> Vec<ParkedCar> {
    let Some(baked) = extensions
        .and_then(|e| e.get(PARKED_CARS_EXTENSION_KEY))
        .filter(|v| v.is_object())
        .and_then(|v| v.get("baked"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    baked
        .iter()
        .filter_map(|entry| {
            let car = entry.as_object()?;
            let id = car.get("id")?.as_str().filter(|s| !s.is_empty())?;
            let stall_id = car.get("stallId")?.as_str()?;
            let catalog_id = car.get("catalogId")?.as_str().filter(|s| !s.is_empty())?;
            let number = |key: &str| {
                car.get(key)
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite())
            };
            Some(ParkedCar {
                id: id.to_owned(),
                stall_id: stall_id.to_owned(),
                catalog_id: catalog_id.to_owned(),
                x: number("x")?,
                y: number("y")?,
                z: number("z")?,
                heading_rad: number("headingRad")?,
                length_m: number("lengthM")?,
                width_m: number("widthM")?,
                height_m: number("heightM")?,
            })
        })
        .collect()
}

/// Append baked parked cars: static cars at zero speed with a degenerate
/// route, which makes them physical (they collide and occlude) and
/// exportable. An authored actor holding the same id wins. The appended
/// block is sorted by id, so the digest does not depend on how the extension
/// was written.
pub fn with_parked_car_actors(
    input: SimScenarioInput,
    baked: &[ParkedCar],
) -> CompileResult<SimScenarioInput> {
    if baked.is_empty() {
        return Ok(input);
    }
    let taken: std::collections::BTreeSet<&str> =
        input.actors.iter().map(|a| a.id.as_str()).collect();
    let mut additions: Vec<&ParkedCar> = baked
        .iter()
        .filter(|car| !taken.contains(car.id.as_str()))
        .collect();
    if additions.is_empty() {
        return Ok(input);
    }
    // UTF-16 code unit order, as the TypeScript `<` comparison sorted them.
    additions.sort_by(|a, b| a.id.encode_utf16().cmp(b.id.encode_utf16()));
    let mut document = to_document(&input)?;
    let actors = document["actors"].as_array_mut().expect("actors array");
    for car in additions {
        actors.push(json!({
            "id": car.id,
            "kind": "car",
            // The engine's fast path: no motion backend, route following or
            // static/static collision pairs; speed forced to zero.
            "static": true,
            // Exactly one `catalog:` tag binds the actor to its asset.
            "tags": [format!("catalog:{}", car.catalog_id)],
            "initial": {
                "pose": { "x": car.x, "z": car.z, "headingRad": car.heading_rad },
                "speedMps": 0,
            },
            "behavior": {
                // The upstream schema defaults, spelled out: the exporter reads
                // `rules.obeySignals` unconditionally.
                "rules": {
                    "obeySignals": true,
                    "yieldToVehicles": true,
                    "yieldToPedestrians": true,
                    "collisionAvoidance": true,
                    "aggression": 0.5,
                    "speedFactor": 1,
                },
                "route": {
                    "kind": "polyline",
                    "points": [
                        { "x": car.x, "z": car.z },
                        // Scene heading h points along (cos h, -sin h) in (x, z).
                        {
                            "x": car.x + PARKED_CAR_ROUTE_M * car.heading_rad.cos(),
                            "z": car.z - PARKED_CAR_ROUTE_M * car.heading_rad.sin(),
                        },
                    ],
                },
            },
            "presentAtStart": true,
            "dims": { "l": car.length_m, "w": car.width_m, "h": car.height_m },
        }));
    }
    from_document(&document)
}

/* ----------------------------------------------------- execution refinements */

/// Stabilise high-speed authored world routes before they reach the dynamic
/// solver: cap the yaw rate at what a passenger car's lateral grip allows at
/// its reference speed, and do not join such a route from the live pose.
pub fn with_stable_high_speed_world_routes(
    input: SimScenarioInput,
) -> CompileResult<SimScenarioInput> {
    let mut document = to_document(&input)?;
    let world_route_actors: std::collections::BTreeSet<String> = interactions(&document)
        .filter(|i| {
            is_polyline_route(i) && i.get("bestEffortWorldPath") == Some(&Value::Bool(true))
        })
        .filter_map(|i| i.get("actorId").and_then(Value::as_str).map(str::to_owned))
        .collect();
    if world_route_actors.is_empty() {
        return Ok(input);
    }
    let existing_profiles = document
        .get("physics")
        .and_then(|p| p.get("vehicleProfiles"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut vehicle_profiles = existing_profiles.clone();
    let mut stabilized = std::collections::BTreeSet::new();
    let mut changed = false;
    for actor in document["actors"].as_array().into_iter().flatten() {
        let id = actor.get("id").and_then(Value::as_str).unwrap_or_default();
        let kind = actor
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !world_route_actors.contains(id)
            || truthy(actor.get("static"))
            || !WHEELED_ROAD_ACTOR_KINDS.contains(&kind)
        {
            continue;
        }
        let initial_speed = actor
            .pointer("/initial/speedMps")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let cruise = actor
            .pointer("/behavior/cruiseSpeedMps")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let reference_speed_mps = initial_speed.abs().max(cruise.abs());
        if reference_speed_mps < HIGH_SPEED_WORLD_ROUTE_MPS {
            continue;
        }
        let existing = existing_profiles
            .get(id)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let lateral = existing
            .get("maxLateralAccelerationMps2")
            .and_then(Value::as_f64)
            .unwrap_or(PASSENGER_CAR_MAX_LATERAL_ACCELERATION_MPS2);
        let feasible_yaw_rate = MIN_STABLE_YAW_RATE_RADPS.max(lateral / reference_speed_mps);
        let max_yaw_rate = match existing.get("maxYawRateRadps").and_then(Value::as_f64) {
            Some(authored) => authored.min(feasible_yaw_rate),
            None => feasible_yaw_rate,
        };
        let mut profile = existing;
        profile.insert("maxYawRateRadps".into(), json!(max_yaw_rate));
        vehicle_profiles.insert(id.to_owned(), Value::Object(profile));
        stabilized.insert(id.to_owned());
        changed = true;
    }
    for interaction in document["interactions"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        let actor_id = interaction
            .get("actorId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if stabilized.contains(actor_id)
            && is_polyline_route(interaction)
            && interaction.get("joinFromCurrentPose") == Some(&Value::Bool(true))
        {
            interaction["joinFromCurrentPose"] = Value::Bool(false);
            changed = true;
        }
    }
    if !changed {
        return Ok(input);
    }
    let physics = document
        .as_object_mut()
        .expect("document object")
        .entry("physics")
        .or_insert_with(|| json!({}));
    let physics = physics
        .as_object_mut()
        .ok_or_else(|| invalid("physics is not an object"))?;
    physics.entry("mode").or_insert_with(|| json!("dynamic-v1"));
    physics.insert("vehicleProfiles".into(), Value::Object(vehicle_profiles));
    from_document(&document)
}

/// When a bounded speed action (one with a window) releases before the clip
/// ends, restore the actor's authored cruise speed at 3 m/s², unless another
/// longitudinal command takes over at that instant.
pub fn with_bounded_speed_cruise_restoration(
    input: SimScenarioInput,
) -> CompileResult<SimScenarioInput> {
    let mut document = to_document(&input)?;
    let clip_seconds = input.clip_seconds;
    let actors: Map<String, Value> = document["actors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a.get("id")?.as_str()?.to_owned(), a.clone())))
        .collect();
    let all: Vec<Value> = interactions(&document).cloned().collect();
    let mut existing_ids: std::collections::BTreeSet<String> = all
        .iter()
        .filter_map(|i| i.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let mut restorations = Vec::new();
    for interaction in &all {
        if interaction.get("verb").and_then(Value::as_str) != Some("speed") {
            continue;
        }
        let Some(release_time) = interaction.pointer("/window/endS").and_then(Value::as_f64) else {
            continue;
        };
        let (Some(id), Some(actor_id)) = (
            interaction.get("id").and_then(Value::as_str),
            interaction.get("actorId").and_then(Value::as_str),
        ) else {
            continue;
        };
        let Some(actor) = actors.get(actor_id) else {
            continue;
        };
        let Some(cruise_speed_mps) = actor
            .pointer("/behavior/cruiseSpeedMps")
            .and_then(Value::as_f64)
        else {
            continue;
        };
        if truthy(actor.get("static")) || release_time >= clip_seconds - TIME_EPSILON {
            continue;
        }
        if has_longitudinal_command_at(&all, id, actor_id, release_time) {
            continue;
        }
        let restore_id = format!("restore-cruise-{id}");
        if !existing_ids.insert(restore_id.clone()) {
            continue;
        }
        restorations.push(json!({
            "id": restore_id,
            "actorId": actor_id,
            "trigger": { "kind": "at", "t": release_time },
            "verb": "speed",
            "target": { "mode": "absolute", "value": cruise_speed_mps },
            "dynamics": { "shape": "linear", "constraint": "rate", "value": CRUISE_RESTORE_ACCELERATION_MPS2 },
        }));
    }
    if restorations.is_empty() {
        return Ok(input);
    }
    document["interactions"]
        .as_array_mut()
        .ok_or_else(|| invalid("interactions is not an array"))?
        .extend(restorations);
    from_document(&document)
}

fn has_longitudinal_command_at(
    all: &[Value],
    released_id: &str,
    actor_id: &str,
    time: f64,
) -> bool {
    all.iter().any(|candidate| {
        candidate.get("id").and_then(Value::as_str) != Some(released_id)
            && candidate.get("actorId").and_then(Value::as_str) == Some(actor_id)
            && matches!(
                candidate.get("verb").and_then(Value::as_str),
                Some("speed" | "gap")
            )
            && candidate.pointer("/trigger/kind").and_then(Value::as_str) == Some("at")
            && candidate
                .pointer("/trigger/t")
                .and_then(Value::as_f64)
                .is_some_and(|t| (t - time).abs() <= TIME_EPSILON)
    })
}

/* ------------------------------------------------------------------ helpers */

fn interactions(document: &Value) -> impl Iterator<Item = &Value> {
    document["interactions"].as_array().into_iter().flatten()
}

fn is_polyline_route(interaction: &Value) -> bool {
    interaction.get("verb").and_then(Value::as_str) == Some("route")
        && interaction.pointer("/target/kind").and_then(Value::as_str) == Some("polyline")
}

fn truthy(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

fn to_document(input: &SimScenarioInput) -> CompileResult<Value> {
    serde_json::to_value(input).map_err(|e| invalid(&e.to_string()))
}

fn from_document(document: &Value) -> CompileResult<SimScenarioInput> {
    parse_scenario_input_value(document).map_err(|e| invalid(&e.to_string()))
}

fn invalid(message: &str) -> CompileError {
    CompileError::new("studio_refinement_invalid", message)
}

/// ECMAScript `String.prototype.trim` (Unicode white space plus BOM).
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// ECMAScript `Number(string)` for the finite results a paint channel can
/// use: `NaN` and the infinities are `None`.
fn js_number(text: &str) -> Option<f64> {
    let text = js_trim(text);
    if text.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            return u128::from_str_radix(digits, radix).ok().map(|v| v as f64);
        }
    }
    // StrDecimalLiteral: [sign] (digits [. digits] | . digits) [e [sign] digits]; no "inf"/"nan".
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    let mut chars = unsigned.chars().peekable();
    let mut mantissa_digits = 0;
    while chars.peek().is_some_and(char::is_ascii_digit) {
        chars.next();
        mantissa_digits += 1;
    }
    if chars.peek() == Some(&'.') {
        chars.next();
        while chars.peek().is_some_and(char::is_ascii_digit) {
            chars.next();
            mantissa_digits += 1;
        }
    }
    if mantissa_digits == 0 {
        return None;
    }
    if matches!(chars.peek(), Some('e' | 'E')) {
        chars.next();
        if matches!(chars.peek(), Some('+' | '-')) {
            chars.next();
        }
        let mut exponent_digits = 0;
        while chars.peek().is_some_and(char::is_ascii_digit) {
            chars.next();
            exponent_digits += 1;
        }
        if exponent_digits == 0 {
            return None;
        }
    }
    if chars.next().is_some() {
        return None;
    }
    text.parse::<f64>().ok().filter(|v| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paint_channels_follow_ecmascript_number() {
        let norm = |s: &str| normalize_studio_body_color(Some(&json!(s)));
        assert_eq!(norm("#ABC"), Some("#aabbcc".into()));
        assert_eq!(norm(" #a1b2c3 "), Some("#a1b2c3".into()));
        assert_eq!(norm("rgb(255, 0, 16)"), Some("#ff0010".into()));
        assert_eq!(norm("255,0,16"), Some("#ff0010".into()));
        // Number("") === 0, Number("5.0") === 5, Number("0x1f") === 31, Number("+2") === 2.
        assert_eq!(norm("rgb(,5.0,0x1f)"), Some("#00051f".into()));
        assert_eq!(norm("rgb(+2,1e2,0)"), Some("#026400".into()));
        assert_eq!(norm("rgb(256,0,0)"), None);
        assert_eq!(norm("rgb(1.5,0,0)"), None);
        assert_eq!(norm("rgb(inf,0,0)"), None);
        assert_eq!(norm("rgb(-0x1,0,0)"), None);
        assert_eq!(norm("#abcd"), None);
        assert_eq!(norm(""), None);
        assert_eq!(normalize_studio_body_color(Some(&json!(7))), None);
    }
}
