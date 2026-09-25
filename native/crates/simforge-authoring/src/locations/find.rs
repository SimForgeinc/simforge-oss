//! `locations find`: the structured query.
//!
//! Closed vocabularies with actionable errors, `matchedReasons[]`, diversity
//! clustering, `anyOf`/`allOf`/`noneOf`, and a filter on an unknown fact key
//! is an error (never an empty result). The fact index only narrows the
//! candidates; it is always a superset filter, so it never changes the answer.

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use simforge_compiler::CompileError;
use simforge_core::hash::cmp_utf16;

use super::{fact_key_of, geo_distance, query_error, round1, round3, Catalog, Location};
use crate::jsfmt::{js, to_fixed};

/// The location types a query may name.
pub const LOCATION_TYPES: [&str; 27] = [
    "junction",
    "junction_movement",
    "driving_corridor",
    "bike_corridor",
    "walking_corridor",
    "midblock_segment",
    "merge_zone",
    "lane_drop",
    "parking_lane",
    "parking_space",
    "parking_area",
    "parking_access_point",
    "driveway",
    "loading_zone",
    "bus_stop",
    "crosswalk",
    "sidewalk",
    "curb",
    "median",
    "refuge_island",
    "building_entrance",
    "school_zone",
    "work_zone_suitable",
    "occlusion_zone",
    "conflict_zone",
    "poi_frontage",
    "address",
];

/// What a location can be used for when placing actors and props.
pub const AFFORDANCES: [&str; 10] = [
    "vehicleSpawn",
    "pedestrianSpawn",
    "cyclistSpawn",
    "parkedVehicle",
    "occluder",
    "route",
    "crossing",
    "stopPoint",
    "propPlacement",
    "conflictPoint",
];

pub const DEFAULT_RESULT_LIMIT: usize = 25;
pub const MAX_RESULT_LIMIT: usize = 200;

/// A fact comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    Exists,
    Missing,
}

impl FactOp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Eq => "eq",
            Self::Ne => "ne",
            Self::Gt => "gt",
            Self::Gte => "gte",
            Self::Lt => "lt",
            Self::Lte => "lte",
            Self::Contains => "contains",
            Self::Exists => "exists",
            Self::Missing => "missing",
        }
    }
}

/// One fact predicate.
#[derive(Debug, Clone, PartialEq)]
pub struct FactFilter {
    pub key: String,
    pub op: FactOp,
    pub value: Option<Value>,
}

impl FactFilter {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("key".into(), json!(self.key));
        out.insert("op".into(), json!(self.op.as_str()));
        if let Some(v) = &self.value {
            out.insert("value".into(), v.clone());
        }
        Value::Object(out)
    }
}

/// `number | boolean | string` from a CLI value (`Number(raw)` when finite).
pub fn coerce(raw: &str) -> Value {
    match raw {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        _ => {}
    }
    match js_number(raw) {
        Some(n) if !raw.is_empty() => json!(n),
        _ => Value::String(raw.to_owned()),
    }
}

/// `Number(raw)` for decimal text (`None` for NaN or a non-finite result).
pub fn js_number(raw: &str) -> Option<f64> {
    let t = raw.trim_matches(|c: char| crate::locations::resolve::js_space(c));
    if t.is_empty() {
        return Some(0.0);
    }
    let lower = t.to_ascii_lowercase();
    if lower.contains("inf")
        || lower.contains("nan")
        || lower.starts_with("0x")
        || lower.starts_with("+0x")
    {
        return None;
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `key=value` (with `k>=v`, `k<=v`, `k!=v`, `k>v`, `k<v`, `k~v`, `k=?`,
/// `k=!?` shorthands) as a fact filter. The operator is read off the end of
/// the key after splitting at the first `=`, so `k>=v` reads as `k>` + `v`
/// (`gt`), exactly as the TypeScript CLI did.
pub fn fact_filter(key: &str, raw: &str) -> FactFilter {
    const OPS: [(&str, FactOp); 6] = [
        (">=", FactOp::Gte),
        ("<=", FactOp::Lte),
        ("!", FactOp::Ne),
        (">", FactOp::Gt),
        ("<", FactOp::Lt),
        ("~", FactOp::Contains),
    ];
    for (token, op) in OPS {
        if let Some(stripped) = key.strip_suffix(token) {
            return FactFilter {
                key: stripped.to_owned(),
                op,
                value: Some(coerce(raw)),
            };
        }
    }
    match raw {
        "?" => FactFilter {
            key: key.to_owned(),
            op: FactOp::Exists,
            value: None,
        },
        "!?" => FactFilter {
            key: key.to_owned(),
            op: FactOp::Missing,
            value: None,
        },
        _ => FactFilter {
            key: key.to_owned(),
            op: FactOp::Eq,
            value: Some(coerce(raw)),
        },
    }
}

/// The CLI's query (every set filter an `anyOf` list, facts all `allOf`).
#[derive(Debug, Clone, Default)]
pub struct FindQuery {
    pub r#type: Option<Vec<String>>,
    pub subtype: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub affordances: Option<Vec<String>>,
    pub facts: Vec<FactFilter>,
    /// `(id or handle, withinM)`.
    pub near: Option<(String, f64)>,
    pub limit: Option<i64>,
    pub diversity_radius_m: Option<f64>,
}

impl FindQuery {
    /// The query as the result echoes it.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        for (key, value) in [
            ("type", &self.r#type),
            ("subtype", &self.subtype),
            ("tags", &self.tags),
            ("affordances", &self.affordances),
        ] {
            if let Some(v) = value {
                out.insert(key.into(), json!(v));
            }
        }
        if !self.facts.is_empty() {
            out.insert(
                "facts".into(),
                json!({ "allOf": self.facts.iter().map(FactFilter::to_json).collect::<Vec<_>>() }),
            );
        }
        if let Some((id, within)) = &self.near {
            out.insert("near".into(), json!({ "id": id, "withinM": within }));
        }
        if let Some(limit) = self.limit {
            out.insert("limit".into(), json!(limit));
        }
        if let Some(radius) = self.diversity_radius_m {
            out.insert("diversityRadiusM".into(), json!(radius));
        }
        Value::Object(out)
    }
}

/// One hit.
#[derive(Debug, Clone)]
pub struct LocationMatch<'a> {
    pub location: &'a Location,
    pub score: f64,
    /// Rounded to 0.1 m; present when the query had `near`.
    pub distance_m: Option<f64>,
    pub matched_reasons: Vec<String>,
}

fn check_vocabulary(
    values: &Option<Vec<String>>,
    path: &str,
    vocabulary: &[&str],
) -> Result<(), CompileError> {
    for value in values.iter().flatten() {
        if !vocabulary.contains(&value.as_str()) {
            return Err(query_error(
                "unknown_value",
                path,
                format!(
                    "{} is not a valid {path}",
                    serde_json::to_string(value).unwrap_or_default()
                ),
                Some(vocabulary.iter().map(|v| (*v).to_owned()).collect()),
            ));
        }
    }
    Ok(())
}

fn match_set(
    value: &str,
    set: &Option<Vec<String>>,
    label: &str,
    reasons: &mut Vec<String>,
) -> bool {
    let Some(any_of) = set else { return true };
    if !any_of.is_empty() && !any_of.iter().any(|v| v == value) {
        return false;
    }
    if !any_of.is_empty() {
        reasons.push(format!("{label}={value}"));
    }
    true
}

fn match_set_multi(
    values: &[String],
    set: &Option<Vec<String>>,
    label: &str,
    reasons: &mut Vec<String>,
) -> bool {
    let Some(any_of) = set else { return true };
    if !any_of.is_empty() {
        let hit: Vec<&String> = any_of.iter().filter(|v| values.contains(v)).collect();
        if hit.is_empty() {
            return false;
        }
        for v in hit {
            reasons.push(format!("{label}={v}"));
        }
    }
    true
}

fn evaluate_fact(loc: &Location, filter: &FactFilter) -> bool {
    let actual = loc.facts.get(&filter.key);
    let expected = filter.value.as_ref();
    match filter.op {
        FactOp::Exists => actual.is_some(),
        FactOp::Missing => actual.is_none(),
        FactOp::Eq => actual.is_some_and(|a| Some(fact_key_of(a)) == expected.map(fact_key_of)),
        FactOp::Ne => actual.is_none_or(|a| Some(fact_key_of(a)) != expected.map(fact_key_of)),
        FactOp::Gt | FactOp::Gte | FactOp::Lt | FactOp::Lte => {
            let (Some(Value::Number(a)), Some(Value::Number(b))) = (actual, expected) else {
                return false;
            };
            let (a, b) = (
                a.as_f64().unwrap_or(f64::NAN),
                b.as_f64().unwrap_or(f64::NAN),
            );
            match filter.op {
                FactOp::Gt => a > b,
                FactOp::Gte => a >= b,
                FactOp::Lt => a < b,
                _ => a <= b,
            }
        }
        FactOp::Contains => match (actual, expected) {
            (Some(Value::Array(items)), _) => {
                let want = expected.map(fact_key_of);
                items.iter().any(|v| Some(fact_key_of(v)) == want)
            }
            (Some(Value::String(a)), Some(Value::String(b))) => {
                a.to_lowercase().contains(&b.to_lowercase())
            }
            _ => false,
        },
    }
}

fn describe_filter(loc: &Location, filter: &FactFilter) -> String {
    let rendered = loc
        .facts
        .get(&filter.key)
        .map_or_else(|| "absent".to_owned(), fact_key_of);
    match filter.op {
        FactOp::Exists | FactOp::Missing => format!("{} {}", filter.key, filter.op.as_str()),
        op => format!(
            "{} {} {} (actual {rendered})",
            filter.key,
            op.as_str(),
            filter
                .value
                .as_ref()
                .map_or_else(|| "undefined".to_owned(), fact_key_of)
        ),
    }
}

fn score_of(reason_count: usize, distance_m: Option<f64>, within_m: Option<f64>) -> f64 {
    let base = (reason_count as f64 / 4.0).min(1.0);
    match (distance_m, within_m) {
        (Some(d), Some(w)) if w != 0.0 && !w.is_nan() => {
            let proximity = 1.0 - (d / w).min(1.0);
            round3(base * 0.6 + proximity * 0.4)
        }
        _ => round3(base),
    }
}

/// Candidate narrowing through the fact index: the records whose id is in
/// every bucket the set filters select (`anyOf` is a union, each `allOf`
/// entry restricts on its own).
fn narrow<'a>(catalog: &'a Catalog, query: &FindQuery) -> Vec<&'a Location> {
    let Some(index) = &catalog.index else {
        return catalog.locations.iter().collect();
    };
    let mut buckets: Vec<HashSet<&str>> = Vec::new();
    for (record, set) in [
        (&index.by_type, &query.r#type),
        (&index.by_subtype, &query.subtype),
        (&index.by_tag, &query.tags),
        (&index.by_affordance, &query.affordances),
    ] {
        let Some(any_of) = set else { continue };
        if any_of.is_empty() {
            continue;
        }
        buckets.push(
            any_of
                .iter()
                .flat_map(|v| record.get(v).into_iter().flatten())
                .map(String::as_str)
                .collect(),
        );
    }
    if buckets.is_empty() {
        return catalog.locations.iter().collect();
    }
    catalog
        .locations
        .iter()
        .filter(|l| buckets.iter().all(|b| b.contains(l.id.as_str())))
        .collect()
}

/// Run a structured query.
pub fn find_locations<'a>(
    catalog: &'a Catalog,
    query: &FindQuery,
) -> Result<Vec<LocationMatch<'a>>, CompileError> {
    let limit = match query.limit {
        None => DEFAULT_RESULT_LIMIT,
        Some(l) if l < 1 => {
            return Err(query_error(
                "invalid_value",
                "limit",
                "must be a positive integer".into(),
                None,
            ));
        }
        Some(l) => (l as usize).min(MAX_RESULT_LIMIT),
    };
    check_vocabulary(&query.r#type, "type", &LOCATION_TYPES)?;
    check_vocabulary(&query.affordances, "affordances", &AFFORDANCES)?;
    if !query.facts.is_empty() {
        let mut known: Vec<&str> = Vec::new();
        for loc in &catalog.locations {
            for key in loc.facts.keys() {
                if !known.contains(&key.as_str()) {
                    known.push(key);
                }
            }
        }
        for filter in &query.facts {
            if !known.contains(&filter.key.as_str()) {
                let mut allowed: Vec<String> = known.iter().map(|k| (*k).to_owned()).collect();
                allowed.sort_by(|a, b| cmp_utf16(a, b));
                return Err(query_error(
                    "unknown_fact_key",
                    &format!("facts.{}", filter.key),
                    format!(
                        "no location on map {} carries this fact key",
                        catalog.map_id
                    ),
                    Some(allowed),
                ));
            }
        }
    }
    let anchor = match &query.near {
        None => None,
        Some((id, within)) => {
            let Some(anchor) = catalog.get(id) else {
                return Err(query_error(
                    "unknown_reference",
                    "near.id",
                    format!(
                        "no location with id or handle {} on map {}",
                        serde_json::to_string(id).unwrap_or_default(),
                        catalog.map_id
                    ),
                    None,
                ));
            };
            if !(*within > 0.0) {
                return Err(query_error(
                    "invalid_value",
                    "near.withinM",
                    "must be a positive number".into(),
                    None,
                ));
            }
            Some((anchor, *within))
        }
    };

    let mut matches: Vec<LocationMatch<'a>> = Vec::new();
    for loc in narrow(catalog, query) {
        let mut reasons = Vec::new();
        if !match_set(&loc.r#type, &query.r#type, "type", &mut reasons) {
            continue;
        }
        if !match_set(
            loc.subtype.as_deref().unwrap_or(""),
            &query.subtype,
            "subtype",
            &mut reasons,
        ) {
            continue;
        }
        if !match_set_multi(&loc.tags, &query.tags, "tag", &mut reasons) {
            continue;
        }
        if !match_set_multi(
            &loc.affordances,
            &query.affordances,
            "affordance",
            &mut reasons,
        ) {
            continue;
        }
        let mut facts_ok = true;
        for filter in &query.facts {
            if !evaluate_fact(loc, filter) {
                facts_ok = false;
                break;
            }
            reasons.push(describe_filter(loc, filter));
        }
        if !facts_ok {
            continue;
        }
        let mut distance_m = None;
        if let Some((anchor, within)) = anchor {
            let d = geo_distance(anchor, loc);
            if d > within {
                continue;
            }
            reasons.push(format!(
                "within {} m of {} ({} m)",
                js(within),
                anchor.handle,
                to_fixed(d, 1)
            ));
            distance_m = Some(d);
        }
        matches.push(LocationMatch {
            location: loc,
            score: score_of(reasons.len(), distance_m, anchor.map(|(_, w)| w)),
            distance_m: distance_m.map(round1),
            matched_reasons: reasons,
        });
    }

    // Handle is the tiebreak everywhere, so a query is fully deterministic.
    let by_distance = anchor.is_some();
    matches.sort_by(|a, b| {
        let primary = if by_distance {
            let da = a.distance_m.unwrap_or(f64::INFINITY);
            let db = b.distance_m.unwrap_or(f64::INFINITY);
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        };
        primary.then_with(|| cmp_utf16(&a.location.handle, &b.location.handle))
    });

    let matches = match query.diversity_radius_m {
        Some(radius) if radius != 0.0 && !radius.is_nan() => {
            let mut kept: Vec<LocationMatch<'a>> = Vec::new();
            for candidate in matches {
                if !kept
                    .iter()
                    .any(|k| geo_distance(k.location, candidate.location) < radius)
                {
                    kept.push(candidate);
                }
            }
            kept
        }
        _ => matches,
    };
    Ok(matches.into_iter().take(limit).collect())
}

/// A match as the CLI prints it.
pub fn location_view(m: &LocationMatch<'_>) -> Value {
    let l = m.location;
    let mut out = Map::new();
    out.insert("handle".into(), json!(l.handle));
    out.insert("id".into(), json!(l.id));
    out.insert("name".into(), json!(l.name));
    out.insert("type".into(), json!(l.r#type));
    out.insert(
        "subtype".into(),
        l.raw.get("subtype").cloned().unwrap_or(Value::Null),
    );
    out.insert("score".into(), json!(round3(m.score)));
    if let Some(d) = m.distance_m {
        out.insert("distanceM".into(), json!(round1(d)));
    }
    out.insert(
        "roadAnchor".into(),
        l.raw
            .pointer("/anchor/road")
            .cloned()
            .unwrap_or(Value::Null),
    );
    out.insert(
        "sceneAnchor".into(),
        l.raw
            .pointer("/anchor/scene")
            .cloned()
            .unwrap_or(Value::Null),
    );
    out.insert(
        "anchorQuality".into(),
        l.raw
            .pointer("/quality/anchor")
            .cloned()
            .unwrap_or(Value::Null),
    );
    out.insert(
        "affordances".into(),
        l.raw.get("affordances").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "tags".into(),
        l.raw.get("tags").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "facts".into(),
        l.raw.get("facts").cloned().unwrap_or(Value::Null),
    );
    out.insert("matchedReasons".into(), json!(m.matched_reasons));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fact_shorthands_read_like_the_typescript_cli() {
        assert_eq!(fact_filter("arm_count>", "3").op, FactOp::Gt);
        assert_eq!(fact_filter("arm_count<", "3").op, FactOp::Lt);
        assert_eq!(fact_filter("road_name~", "Road").op, FactOp::Contains);
        assert_eq!(
            fact_filter("is_protected!", "true").value,
            Some(Value::Bool(true))
        );
        assert_eq!(fact_filter("x", "?").op, FactOp::Exists);
        assert_eq!(fact_filter("x", "!?").op, FactOp::Missing);
        assert_eq!(fact_filter("x", "4").value, Some(json!(4.0)));
        assert_eq!(fact_filter("x", "Road 1").value, Some(json!("Road 1")));
        assert_eq!(coerce(""), json!(""));
    }
}
