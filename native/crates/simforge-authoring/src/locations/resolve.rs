//! `locations resolve`: free text -> ranked handles.
//!
//! Token overlap plus bigram-dice fuzziness plus a small table of type
//! keywords: deterministic, explainable, no model involved. Deliberately no
//! spatial reasoning ("north of the park"); that is what the structured query
//! is for.

use serde::Serialize;
use simforge_core::hash::cmp_utf16;

use super::{js_string, round3, Catalog, Location};
use crate::jsfmt::to_fixed;

/// One ranked candidate.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedReference {
    pub id: String,
    pub handle: String,
    pub name: String,
    pub r#type: String,
    pub score: f64,
    pub reasons: Vec<String>,
}

/// Phrases that imply a type (each list is one keyword regex's alternatives,
/// matched on word boundaries), the type, and its weight.
const TYPE_KEYWORDS: &[(&[&str], &str, f64)] = &[
    (
        &["intersection", "junction", "crossroads", "crossroad"],
        "junction",
        0.35,
    ),
    (
        &["left turn", "right turn", "turn", "movement", "through"],
        "junction_movement",
        0.25,
    ),
    (&["crosswalk", "crossing", "zebra"], "crosswalk", 0.35),
    (&["school zone", "school"], "school_zone", 0.3),
    (
        &["parking space", "parking bay", "parking stall"],
        "parking_space",
        0.35,
    ),
    (&["parking lot", "car park"], "parking_area", 0.35),
    (
        &["street parking", "parked cars", "parked car"],
        "parking_lane",
        0.3,
    ),
    (&["bus stop", "transit stop"], "bus_stop", 0.4),
    (&["sidewalk", "pavement", "footpath"], "sidewalk", 0.3),
    (
        &[
            "midblock",
            "mid-block",
            "straightaway",
            "stretch of road",
            "block",
        ],
        "midblock_segment",
        0.3,
    ),
    (
        &["occlusion", "blind", "obscured", "hidden"],
        "occlusion_zone",
        0.35,
    ),
    (
        &["work zone", "construction", "roadworks", "roadwork"],
        "work_zone_suitable",
        0.4,
    ),
    (
        &["entrance", "doorway", "address", "building"],
        "building_entrance",
        0.3,
    ),
    (
        &["corridor", "road", "street", "avenue", "boulevard"],
        "driving_corridor",
        0.12,
    ),
];

const STOP_WORDS: [&str; 15] = [
    "the", "a", "an", "at", "by", "on", "in", "of", "near", "to", "with", "and", "is", "that",
    "this",
];

/// JavaScript's `\s` / `String.prototype.trim` whitespace.
pub fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `\b<phrase>\b` somewhere in `text`.
fn has_phrase(text: &str, phrase: &str) -> bool {
    let bytes = text.as_bytes();
    text.match_indices(phrase).any(|(at, _)| {
        let end = at + phrase.len();
        let before = at == 0 || !is_word(bytes[at - 1]);
        let after = end == bytes.len() || !is_word(bytes[end]);
        before && after
    })
}

/// Split on runs of non-alphanumerics, lowercase, drop 1-char tokens and stop words.
fn tokenise(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .map(str::to_lowercase)
        .filter(|t| t.len() > 1 && !STOP_WORDS.contains(&t.as_str()))
        .collect()
}

/// Sorensen-Dice over character bigrams (UTF-16 units, whitespace runs collapsed).
pub fn dice_coefficient(a: &str, b: &str) -> f64 {
    fn bigrams(s: &str) -> Vec<(u16, u16)> {
        let mut clean = String::with_capacity(s.len());
        let mut in_space = false;
        for c in s.chars() {
            if js_space(c) {
                if !in_space {
                    clean.push(' ');
                }
                in_space = true;
            } else {
                clean.push(c);
                in_space = false;
            }
        }
        let units: Vec<u16> = clean.encode_utf16().collect();
        units.windows(2).map(|w| (w[0], w[1])).collect()
    }
    let a = bigrams(a);
    let b = bigrams(b);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let mut pool: std::collections::HashMap<(u16, u16), usize> = std::collections::HashMap::new();
    for g in &a {
        *pool.entry(*g).or_default() += 1;
    }
    let mut hits = 0usize;
    for g in &b {
        if let Some(n) = pool.get_mut(g) {
            if *n > 0 {
                hits += 1;
                *n -= 1;
            }
        }
    }
    (2 * hits) as f64 / (a.len() + b.len()) as f64
}

fn score_location(
    loc: &Location,
    query: &str,
    query_tokens: &[String],
    hints: &[(&str, f64)],
) -> (f64, Vec<String>) {
    let mut reasons = Vec::new();
    let mut score = 0.0f64;

    let haystack = format!("{} {}", loc.name, loc.handle).to_lowercase();
    let name_tokens = tokenise(&haystack);
    let overlap: Vec<&str> = query_tokens
        .iter()
        .filter(|t| name_tokens.contains(t))
        .map(String::as_str)
        .collect();
    if !overlap.is_empty() {
        score += 0.55 * (overlap.len() as f64 / query_tokens.len() as f64);
        reasons.push(format!("name/handle shares {}", overlap.join(", ")));
    }

    let fuzzy = dice_coefficient(query, &haystack);
    if fuzzy > 0.25 {
        score += 0.2 * fuzzy;
        reasons.push(format!("fuzzy name similarity {}", to_fixed(fuzzy, 2)));
    }

    // Road names carried in facts are the most common way people refer to places.
    for key in [
        "road_name",
        "street_name",
        "connected_road_names",
        "resolved_name",
    ] {
        let Some(value) = loc.facts.get(key) else {
            continue;
        };
        let values: Vec<String> = match value {
            serde_json::Value::Array(items) => items.iter().map(js_string).collect(),
            other => vec![js_string(other)],
        };
        for v in values {
            let tokens = tokenise(&v.to_lowercase());
            let hit: Vec<&str> = query_tokens
                .iter()
                .filter(|t| tokens.contains(t))
                .map(String::as_str)
                .collect();
            if hit.is_empty() {
                continue;
            }
            score += 0.3 * (hit.len() as f64 / tokens.len().max(1) as f64);
            reasons.push(format!("{key} matches {}", hit.join(", ")));
            break;
        }
    }

    for (r#type, weight) in hints {
        if loc.r#type == *r#type {
            score += weight;
            reasons.push(format!("type keyword implies {}", r#type));
        }
    }

    for tag in &loc.tags {
        let lowered = tag.to_lowercase();
        let words: Vec<&str> = lowered
            .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
            .filter(|w| !w.is_empty())
            .collect();
        if query_tokens.iter().any(|t| words.contains(&t.as_str())) {
            score += 0.12;
            reasons.push(format!("tag {tag}"));
            break;
        }
    }

    // A record you cannot place is a worse answer than one you can.
    if loc.road().is_none() {
        score *= 0.8;
    }
    (score.min(1.0), reasons)
}

/// `Array.prototype.slice(0, limit)` bound.
fn slice_end(len: usize, limit: i64) -> usize {
    if limit < 0 {
        len.saturating_sub(limit.unsigned_abs() as usize)
    } else {
        (limit as usize).min(len)
    }
}

/// Rank catalog records against a free-text description (`limit` default 8).
pub fn resolve_reference(
    catalog: &Catalog,
    text: &str,
    limit: Option<i64>,
) -> Vec<ResolvedReference> {
    let limit = limit.unwrap_or(8);
    let trimmed = text.trim_matches(js_space);
    let query = trimmed.to_lowercase();
    if query.is_empty() {
        return Vec::new();
    }
    // Exact id/handle wins outright, so a model can round-trip.
    if let Some(direct) = catalog.get(trimmed) {
        // Returned before the limit applies, as it always was.
        return vec![ResolvedReference {
            id: direct.id.clone(),
            handle: direct.handle.clone(),
            name: direct.name.clone(),
            r#type: direct.r#type.clone(),
            score: 1.0,
            reasons: vec!["exact id or handle match".into()],
        }];
    }

    let query_tokens = tokenise(&query);
    let hints: Vec<(&str, f64)> = TYPE_KEYWORDS
        .iter()
        .filter(|(phrases, _, _)| phrases.iter().any(|p| has_phrase(&query, p)))
        .map(|(_, t, w)| (*t, *w))
        .collect();

    let mut out: Vec<ResolvedReference> = Vec::new();
    for loc in &catalog.locations {
        let (score, reasons) = score_location(loc, &query, &query_tokens, &hints);
        if score < 0.12 {
            continue;
        }
        out.push(ResolvedReference {
            id: loc.id.clone(),
            handle: loc.handle.clone(),
            name: loc.name.clone(),
            r#type: loc.r#type.clone(),
            score: round3(score),
            reasons,
        });
    }
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| cmp_utf16(&a.handle, &b.handle))
    });
    let end = slice_end(out.len(), limit);
    out.truncate(end);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_boundaries_and_tokens() {
        assert!(has_phrase("the school crosswalk", "school"));
        assert!(!has_phrase("schoolyard", "school"));
        assert!(has_phrase("mid-block", "mid-block"));
        assert!(has_phrase("near the parked cars", "parked car") == false);
        assert!(has_phrase("near the parked cars", "parked cars"));
        assert_eq!(tokenise("The Road-38 at X"), vec!["road", "38"]);
        assert_eq!(dice_coefficient("night", "nacht"), 0.25);
        assert_eq!(slice_end(5, -1), 4);
        assert_eq!(slice_end(5, 0), 0);
        assert_eq!(slice_end(5, 9), 5);
    }
}
