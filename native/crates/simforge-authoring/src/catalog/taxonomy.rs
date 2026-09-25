//! The authored incident taxonomy, research sources, operational variants and
//! the executable template registry, embedded from
//! `data/catalog-taxonomy.json`.
//!
//! The file is generated from the TypeScript constants by
//! `packages/cli/parity/gen-catalog-taxonomy.mjs`. Its key order is part of
//! the data: the taxonomy digest is `sha256(JSON.stringify({sources,
//! incidents, variants}))`, so it is read with the order-preserving [`Js`]
//! parser and hashed unchanged.

use std::sync::OnceLock;

use simforge_core::hash::sha256;

use super::js::{object, Js};

const DATA: &str = include_str!("../../data/catalog-taxonomy.json");

/// One incident mechanism, read from the taxonomy row.
#[derive(Debug, Clone)]
pub struct Incident {
    pub id: String,
    pub title: String,
    pub domain: String,
    pub summary: String,
    pub site_types: Vec<String>,
    pub required_affordances: Vec<String>,
    pub preferred_tags: Vec<String>,
    pub map_ids: Option<Vec<String>>,
    pub event_sequence: Vec<String>,
    pub criticality: Vec<String>,
    pub source_ids: Vec<String>,
    pub implementation_template_id: Option<String>,
    /// The row itself, in its authored key order.
    pub row: Js,
}

/// An executable template in the registry: taxonomy key -> example file.
#[derive(Debug, Clone)]
pub struct TemplateSource {
    pub id: String,
    pub source: String,
}

#[derive(Debug)]
pub struct Taxonomy {
    pub domains: Vec<String>,
    /// `CATALOG_RESEARCH_SOURCES`.
    pub sources: Js,
    /// `INCIDENT_TAXONOMY`.
    pub incidents_js: Js,
    pub incidents: Vec<Incident>,
    /// `OPERATIONAL_VARIANTS`.
    pub variants: Js,
    pub templates: Vec<TemplateSource>,
    /// `taxonomyDigest()`.
    pub digest: String,
}

impl Taxonomy {
    /// `OPERATIONAL_VARIANTS[0]`.
    pub fn baseline_variant(&self) -> &Js {
        &self.variants.as_array().expect("variants")[0]
    }

    pub fn variant_ids(&self) -> impl Iterator<Item = &str> {
        self.variants
            .as_array()
            .expect("variants")
            .iter()
            .filter_map(|v| v.get("id").and_then(Js::as_str))
    }
}

/// The embedded taxonomy (parsed once).
pub fn taxonomy() -> &'static Taxonomy {
    static TAXONOMY: OnceLock<Taxonomy> = OnceLock::new();
    TAXONOMY.get_or_init(|| {
        let data = Js::parse(DATA).expect("embedded catalog taxonomy is valid JSON");
        let field = |key: &str| data.get(key).cloned().expect("taxonomy field");
        let sources = field("sources");
        let incidents_js = field("incidents");
        let variants = field("variants");
        let digest = sha256(
            &object([
                ("sources", sources.clone()),
                ("incidents", incidents_js.clone()),
                ("variants", variants.clone()),
            ])
            .stringify(),
        );
        let incidents = incidents_js
            .as_array()
            .expect("incidents")
            .iter()
            .map(incident)
            .collect();
        let templates = field("templates")
            .as_array()
            .expect("templates")
            .iter()
            .map(|row| TemplateSource {
                id: str_of(row, "id"),
                source: str_of(row, "source"),
            })
            .collect();
        Taxonomy {
            domains: strs(field("domains").as_array().expect("domains")),
            sources,
            incidents_js,
            incidents,
            variants,
            templates,
            digest,
        }
    })
}

fn str_of(row: &Js, key: &str) -> String {
    row.get(key).and_then(Js::as_str).unwrap_or_default().to_owned()
}

fn strs(items: &[Js]) -> Vec<String> {
    items.iter().filter_map(Js::as_str).map(str::to_owned).collect()
}

fn list(row: &Js, key: &str) -> Option<Vec<String>> {
    row.get(key).and_then(Js::as_array).map(|a| strs(a))
}

fn incident(row: &Js) -> Incident {
    Incident {
        id: str_of(row, "id"),
        title: str_of(row, "title"),
        domain: str_of(row, "domain"),
        summary: str_of(row, "summary"),
        site_types: list(row, "siteTypes").unwrap_or_default(),
        required_affordances: list(row, "requiredAffordances").unwrap_or_default(),
        preferred_tags: list(row, "preferredTags").unwrap_or_default(),
        map_ids: list(row, "mapIds"),
        event_sequence: list(row, "eventSequence").unwrap_or_default(),
        criticality: list(row, "criticality").unwrap_or_default(),
        source_ids: list(row, "sourceIds").unwrap_or_default(),
        implementation_template_id: row
            .get("implementationTemplateId")
            .and_then(Js::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        row: row.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_the_typescript_taxonomy_digest() {
        // `taxonomyDigest()` from packages/cli/src/catalog.ts at generation time.
        assert_eq!(
            taxonomy().digest,
            "e7eae946e314074710c092632ca02141e95d41ff684bece2e849799443011e1c"
        );
        assert_eq!(taxonomy().incidents.len(), 37);
        assert_eq!(taxonomy().domains.len(), 8);
    }
}
