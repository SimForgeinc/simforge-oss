//! `locations get --describe`: the paragraph an agent reads before authoring
//! against a place. It states the road anchor in plain terms ("lane 27:0:4 at
//! s=18.0 m") beside the prose, because prose alone is what makes models
//! invent road ids.

use serde_json::Value;

use super::{is_truthy, js_string, Catalog, Location};
use crate::jsfmt::{js, round, to_fixed};

const HIGHLIGHT_FACTS: [&str; 17] = [
    "derived_control",
    "arm_count",
    "conflict_pair_count",
    "turn_relation",
    "is_protected",
    "lanes_same_dir",
    "lanes_opposing",
    "speed_limit_kph",
    "curvature_deg_per_10m",
    "has_parking_adjacent",
    "has_bike_adjacent",
    "has_sidewalk_adjacent",
    "distance_to_junction_m",
    "usable_length_m",
    "school_sign_count",
    "address_formatted",
    "road_name",
];

const COMPASS_8_LONG: [&str; 8] = [
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
];

/// Spelled-out eight-point compass direction for a bearing (0 = north, CW).
pub fn compass_long(bearing_deg: f64) -> &'static str {
    let idx = round((((bearing_deg % 360.0) + 360.0) % 360.0) / 45.0) % 8.0;
    COMPASS_8_LONG[idx as usize]
}

/// `${value}` of an optional field (`undefined` when absent).
fn field(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".to_owned(), js_string)
}

fn list_of(values: &[String]) -> String {
    match values {
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
        [] => "undefined".to_owned(),
    }
}

fn describe_facts(loc: &Location) -> String {
    let mut parts = Vec::new();
    for key in HIGHLIGHT_FACTS {
        let Some(value) = loc.facts.get(key) else {
            continue;
        };
        if value.as_str() == Some("") {
            continue;
        }
        let rendered = match value {
            Value::Array(items) => items
                .iter()
                .map(|i| {
                    if i.is_null() {
                        String::new()
                    } else {
                        js_string(i)
                    }
                })
                .collect::<Vec<_>>()
                .join("/"),
            other => js_string(other),
        };
        parts.push(format!("{} {rendered}", key.replace('_', " ")));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("Key facts: {}.", parts.join(", "))
    }
}

/// A natural-language paragraph describing one location (up to 4 relations).
pub fn describe_location(catalog: &Catalog, loc: &Location) -> String {
    let mut sentences: Vec<String> = Vec::new();
    let subtype = loc
        .subtype
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!(" of subtype {s}"))
        .unwrap_or_default();
    sentences.push(format!(
        "{} ({}) is a {}{subtype} on {}.",
        loc.name,
        loc.handle,
        loc.r#type.replace('_', " "),
        catalog.map_id
    ));

    match loc.road() {
        Some(road) => {
            let num = |key: &str| road.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
            let offset_m = num("offsetM");
            let offset = if offset_m.abs() < 0.2 {
                "on the lane centreline".to_owned()
            } else {
                format!(
                    "{} m to the {} of the centreline",
                    to_fixed(offset_m.abs(), 1),
                    if offset_m > 0.0 { "left" } else { "right" }
                )
            };
            let heading = loc
                .facts
                .get("anchor_heading_deg")
                .filter(|v| !v.is_null())
                .map_or_else(|| "?".to_owned(), js_string);
            let limit = road
                .get("speedLimitKph")
                .filter(|v| is_truthy(v))
                .map(|v| format!(" on a {} kph lane", js_string(v)))
                .unwrap_or_default();
            sentences.push(format!(
                "It anchors to {} lane {} at s={} m, {offset}, heading {heading}\u{b0}{limit} (anchor quality: {}).",
                field(road.get("laneType")),
                field(road.get("rsl")),
                to_fixed(num("s"), 1),
                loc.anchor_quality()
            ));
        }
        None => sentences.push(
            "It has no road anchor, so it can be searched and described but not used as a placement target."
                .into(),
        ),
    }

    let facts = describe_facts(loc);
    if !facts.is_empty() {
        sentences.push(facts);
    }
    if !loc.affordances.is_empty() {
        sentences.push(format!("It supports {}.", list_of(&loc.affordances)));
    }
    if !loc.tags.is_empty() {
        sentences.push(format!("Tagged {}.", list_of(&loc.tags)));
    }

    let relations: Vec<_> = catalog
        .relations
        .iter()
        .filter(|r| r.from == loc.id)
        .take(4)
        .collect();
    if !relations.is_empty() {
        let parts: Vec<String> = relations
            .iter()
            .map(|rel| {
                let name = catalog
                    .get(&rel.to)
                    .map_or(rel.to.as_str(), |o| o.handle.as_str());
                format!(
                    "{} {name}, {} m to the {}",
                    rel.kind.replace('_', " "),
                    js(round(rel.distance_m)),
                    compass_long(rel.bearing_deg)
                )
            })
            .collect();
        sentences.push(format!("Related: {}.", parts.join("; ")));
    }

    let provenance: Vec<String> = loc
        .raw
        .get("provenance")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|p| format!("{}({})", field(p.get("source")), field(p.get("ref"))))
                .collect()
        })
        .unwrap_or_default();
    sentences.push(format!(
        "Sources: {}; confidence {}.",
        provenance.join(", "),
        field(loc.raw.pointer("/quality/confidence"))
    ));
    sentences.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compass() {
        assert_eq!(compass_long(0.0), "north");
        assert_eq!(compass_long(168.4), "south");
        assert_eq!(compass_long(-45.0), "northwest");
        assert_eq!(compass_long(337.6), "north");
    }
}
