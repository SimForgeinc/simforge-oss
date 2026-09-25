//! `locations find | get | resolve`: the model's spatial awareness.
//!
//! A read-only query over two ingest artifacts of an installed map: the
//! location catalog (`derived/locations.json.gz`) and the fact index in the
//! derived topology (`derived/topology-derived.json.gz`). No map fact is
//! computed here. The contract the three share: a model never sees a road id.
//! It asks in semantics (type, facts, affordances, proximity to a handle) and
//! gets back handles, poses and `matchedReasons`.

pub mod describe;
pub mod find;
pub mod resolve;

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde_json::{json, Map, Value};
use simforge_compiler::CompileError;

use crate::jsfmt::js;
use crate::maps::{MapRoot, DERIVED_FILE, LOCATIONS_FILE};

/// One catalog record, with the fields the queries read. `raw` is the record
/// exactly as the catalog holds it (returned inline, never re-derived).
#[derive(Debug, Clone)]
pub struct Location {
    pub raw: Value,
    pub id: String,
    pub handle: String,
    pub name: String,
    pub r#type: String,
    pub subtype: Option<String>,
    pub tags: Vec<String>,
    pub affordances: Vec<String>,
    pub facts: Map<String, Value>,
    pub lat: f64,
    pub lng: f64,
}

impl Location {
    fn from_value(raw: Value) -> Self {
        let text = |v: &Value, key: &str| {
            v.get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let list = |key: &str| -> Vec<String> {
            raw.get(key)
                .and_then(Value::as_array)
                .map(|a| a.iter().map(js_string).collect())
                .unwrap_or_default()
        };
        let geo = raw.pointer("/anchor/geo");
        let coord = |key: &str| {
            geo.and_then(|g| g.get(key))
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN)
        };
        Self {
            id: text(&raw, "id"),
            handle: text(&raw, "handle"),
            name: text(&raw, "name"),
            r#type: text(&raw, "type"),
            subtype: raw
                .get("subtype")
                .and_then(Value::as_str)
                .map(str::to_owned),
            tags: list("tags"),
            affordances: list("affordances"),
            facts: raw
                .get("facts")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            lat: coord("lat"),
            lng: coord("lng"),
            raw,
        }
    }

    /// `anchor.road`, when the record is placeable.
    pub fn road(&self) -> Option<&Value> {
        self.raw.pointer("/anchor/road").filter(|v| is_truthy(v))
    }

    pub fn scene(&self) -> Option<&Value> {
        self.raw.pointer("/anchor/scene").filter(|v| !v.is_null())
    }

    /// `quality.anchor`.
    pub fn anchor_quality(&self) -> String {
        self.raw
            .pointer("/quality/anchor")
            .map(js_string)
            .unwrap_or_else(|| "undefined".to_owned())
    }
}

/// One catalog relation.
#[derive(Debug, Clone)]
pub struct Relation {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub distance_m: f64,
    pub bearing_deg: f64,
}

/// The candidate-narrowing inverted index (`factIndex` of the derived topology).
#[derive(Debug, Clone, Default)]
pub struct FactIndex {
    pub by_type: HashMap<String, Vec<String>>,
    pub by_subtype: HashMap<String, Vec<String>>,
    pub by_tag: HashMap<String, Vec<String>>,
    pub by_affordance: HashMap<String, Vec<String>>,
}

/// An installed map's location catalog and fact index.
#[derive(Debug, Clone)]
pub struct Catalog {
    pub map_id: String,
    pub catalog_revision: Value,
    pub locations: Vec<Location>,
    pub relations: Vec<Relation>,
    pub index: Option<FactIndex>,
    /// `id` and `handle` -> position in `locations` (the last record wins).
    by_ref: HashMap<String, usize>,
}

impl Catalog {
    /// Build from the two documents.
    pub fn from_documents(catalog: &Value, derived: Option<&Value>) -> Self {
        let locations: Vec<Location> = catalog
            .get("locations")
            .and_then(Value::as_array)
            .map(|a| a.iter().cloned().map(Location::from_value).collect())
            .unwrap_or_default();
        let relations = catalog
            .get("relations")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|r| Relation {
                        from: r.get("from").map(js_string).unwrap_or_default(),
                        to: r.get("to").map(js_string).unwrap_or_default(),
                        kind: r.get("kind").map(js_string).unwrap_or_default(),
                        distance_m: r
                            .get("distanceM")
                            .and_then(Value::as_f64)
                            .unwrap_or(f64::NAN),
                        bearing_deg: r
                            .get("bearingDeg")
                            .and_then(Value::as_f64)
                            .unwrap_or(f64::NAN),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let index = derived.and_then(|d| d.get("factIndex")).map(|fi| {
            let bucket = |key: &str| -> HashMap<String, Vec<String>> {
                fi.get(key)
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .map(|(k, v)| {
                                let ids = v
                                    .as_array()
                                    .map(|a| a.iter().map(js_string).collect())
                                    .unwrap_or_default();
                                (k.clone(), ids)
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            };
            FactIndex {
                by_type: bucket("locationsByType"),
                by_subtype: bucket("locationsBySubtype"),
                by_tag: bucket("locationsByTag"),
                by_affordance: bucket("locationsByAffordance"),
            }
        });
        let mut by_ref = HashMap::new();
        for (i, loc) in locations.iter().enumerate() {
            by_ref.insert(loc.id.clone(), i);
            by_ref.insert(loc.handle.clone(), i);
        }
        Self {
            map_id: catalog.get("mapId").map(js_string).unwrap_or_default(),
            catalog_revision: catalog
                .get("catalogRevision")
                .cloned()
                .unwrap_or(Value::Null),
            locations,
            relations,
            index,
            by_ref,
        }
    }

    /// Read an installed map's catalog and fact index.
    pub fn load(root: &MapRoot, map_id: &str) -> Result<Self, CompileError> {
        let dir = root.assert_known(map_id)?;
        let catalog = read_json_gz(&dir.join(LOCATIONS_FILE))?;
        let derived = read_json_gz(&dir.join(DERIVED_FILE))?;
        Ok(Self::from_documents(&catalog, Some(&derived)))
    }

    /// A record by id or handle.
    pub fn get(&self, r#ref: &str) -> Option<&Location> {
        self.by_ref.get(r#ref).map(|&i| &self.locations[i])
    }
}

fn read_json_gz(file: &Path) -> Result<Value, CompileError> {
    let bytes = std::fs::read(file).map_err(|e| crate::json::io_error(file, e))?;
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes.as_slice())
        .read_to_string(&mut text)
        .map_err(|e| CompileError::at("invalid_json", file.display().to_string(), e.to_string()))?;
    serde_json::from_str(&text)
        .map_err(|e| CompileError::at("invalid_json", file.display().to_string(), e.to_string()))
}

/// JavaScript truthiness of a JSON value.
pub fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)`.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), js),
        Value::String(s) => s.clone(),
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
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `factKeyOf`: arrays as their JSON text, everything else as `String(value)`.
pub fn fact_key_of(v: &Value) -> String {
    match v {
        Value::Array(_) => crate::json::to_compact_js(v).unwrap_or_default(),
        other => js_string(other),
    }
}

/// `Math.round(value * 1000) / 1000`.
pub fn round3(value: f64) -> f64 {
    crate::jsfmt::round(value * 1000.0) / 1000.0
}

/// `Math.round(value * 10) / 10`.
pub fn round1(value: f64) -> f64 {
    crate::jsfmt::round(value * 10.0) / 10.0
}

/// A `MapIntelQueryError`: `{code, path, reason, detail.allowed?}`, exit 1.
pub fn query_error(
    code: &str,
    path: &str,
    reason: String,
    allowed: Option<Vec<String>>,
) -> CompileError {
    let error = CompileError::at(code, path, reason);
    match allowed {
        Some(allowed) => error.detail_entry("allowed", json!(allowed)),
        None => error,
    }
}

/// V8's `Math.hypot` (scaled, Kahan-compensated), so distances round the
/// same way they did in the TypeScript query.
pub fn js_hypot(values: &[f64]) -> f64 {
    let mut max = 0.0f64;
    let mut nan = false;
    for v in values {
        let a = v.abs();
        if a.is_nan() {
            nan = true;
        } else if a > max {
            max = a;
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for v in values {
        let n = v.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// Ground distance between two records' geo anchors, metres.
pub fn geo_distance(a: &Location, b: &Location) -> f64 {
    let lat = (a.lat + b.lat) / 2.0;
    let rad = lat * std::f64::consts::PI / 180.0;
    let per_lng = 111_320.0 * rad.cos();
    let per_lat = 110_574.0;
    js_hypot(&[(a.lng - b.lng) * per_lng, (a.lat - b.lat) * per_lat])
}

/// The `locations find` document.
pub fn locations_find(
    root: &MapRoot,
    map_id: &str,
    query: &find::FindQuery,
) -> Result<Value, CompileError> {
    let catalog = Catalog::load(root, map_id)?;
    let matches = find::find_locations(&catalog, query)?;
    Ok(json!({
        "mapId": map_id,
        "catalogRevision": catalog.catalog_revision,
        "query": query.to_json(),
        "count": matches.len(),
        "results": matches.iter().map(find::location_view).collect::<Vec<_>>(),
    }))
}

/// The `locations get` document (`unknown_reference` when absent).
pub fn locations_get(
    root: &MapRoot,
    map_id: &str,
    r#ref: &str,
    describe: bool,
) -> Result<Value, CompileError> {
    let catalog = Catalog::load(root, map_id)?;
    let Some(location) = catalog.get(r#ref) else {
        return Err(CompileError::at(
            "unknown_reference",
            "ref",
            format!("no location \"{ref}\" on {map_id}", ref = r#ref),
        )
        .detail_entry(
            "hint",
            json!("use `simforge locations resolve` for free text, or `simforge locations find` to browse"),
        ));
    };
    let mut payload = json!({ "mapId": map_id, "location": location.raw });
    if describe {
        payload["description"] = json!(describe::describe_location(&catalog, location));
    }
    Ok(payload)
}

/// The `locations resolve` document, and whether anything matched.
pub fn locations_resolve(
    root: &MapRoot,
    map_id: &str,
    text: &str,
    limit: Option<i64>,
) -> Result<(Value, bool), CompileError> {
    let catalog = Catalog::load(root, map_id)?;
    let resolved = resolve::resolve_reference(&catalog, text, limit);
    let results: Vec<Value> = resolved
        .iter()
        .map(|r| {
            let mut v = json!(r);
            v["score"] = json!(round3(r.score));
            v
        })
        .collect();
    let any = !results.is_empty();
    Ok((
        json!({ "mapId": map_id, "text": text, "count": results.len(), "results": results }),
        any,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_like_javascript() {
        assert_eq!(js_string(&json!(40.0)), "40");
        assert_eq!(js_string(&json!(["a", 1, null])), "a,1,");
        assert_eq!(fact_key_of(&json!(["a", 1.5])), r#"["a",1.5]"#);
        assert_eq!(fact_key_of(&json!(true)), "true");
    }

    #[test]
    fn hypot_is_exact_on_easy_cases() {
        assert_eq!(js_hypot(&[3.0, 4.0]), 5.0);
        assert_eq!(js_hypot(&[0.0, 0.0]), 0.0);
    }
}
