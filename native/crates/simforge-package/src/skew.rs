//! Version skew (scenario-package.md section 5.4, PLAN §4.2). Each versioned
//! dimension is checked separately; a refusal lists every dimension that is
//! ahead of this reader, never just the first.

use serde_json::Value;

use crate::error::{ErrorCode, PackageError, Result, SkewDimension};
use crate::manifest::{sampler_number, Manifest, MAJOR, SCHEMA, SCHEMA_PREFIX};

/// Highest `scenarioVersion` the document upgrader chain reads
/// (`SCENARIO_TEMPLATE_VERSION`, `@simforge-oss/scenario`).
pub const MAX_SCENARIO_VERSION: u32 = 2;

/// What this reader understands. The CLI builds it from its own version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReaderSupport {
    /// The reading CLI's version, compared with `producer.minCli`. `None`
    /// only for a producer re-checking its own output (the hosted exporter):
    /// the report then says the `cli` dimension was not evaluated.
    pub cli_version: Option<semver::Version>,
    pub max_scenario_version: u32,
    pub max_trace_format: u32,
    pub timeline_versions: Vec<String>,
    pub max_sampler: u32,
}

impl ReaderSupport {
    /// This build's engine contracts, read by CLI `cli_version`.
    pub fn current(cli_version: Option<&str>) -> Result<Self> {
        use simforge_core::trace::timeline::{RENDER_TIMELINE_VERSION, SAMPLER_VERSION};
        let cli_version = cli_version
            .map(|v| {
                semver::Version::parse(v).map_err(|_| {
                    PackageError::argument(
                        "cli_version",
                        format!("{v:?} is not a semantic version"),
                    )
                })
            })
            .transpose()?;
        Ok(Self {
            cli_version,
            max_scenario_version: MAX_SCENARIO_VERSION,
            max_trace_format: simforge_core::trace::TRACE_FORMAT_VERSION,
            timeline_versions: vec![RENDER_TIMELINE_VERSION.to_owned()],
            max_sampler: sampler_number(SAMPLER_VERSION)
                .expect("the core sampler version is well-formed"),
        })
    }
}

fn skew_error(
    dims: Vec<SkewDimension>,
    producer: Option<(String, String, String)>,
    reader: &ReaderSupport,
) -> PackageError {
    let what = dims
        .iter()
        .map(|d| {
            format!(
                "{} {} (this reader supports {})",
                d.dimension, d.found, d.supported
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let message = match producer {
        Some((app, app_version, min_cli)) => format!(
            "This package was made by {app} {app_version} and needs simforge {min_cli} or later{}. Ahead of this reader: {what}. Update simforge to {min_cli} or later to read it.",
            reader
                .cli_version
                .as_ref()
                .map(|v| format!("; this is simforge {v}"))
                .unwrap_or_default()
        ),
        None => format!("This package is newer than this reader. Ahead of this reader: {what}. Update simforge to read it."),
    };
    let mut err = PackageError::new(ErrorCode::VersionUnsupported, "version_ahead", message);
    err.dimensions = dims;
    err
}

fn producer_of(raw: &Value) -> Option<(String, String, String)> {
    let p = raw.get("producer")?;
    Some((
        p.get("app")?.as_str()?.to_owned(),
        p.get("appVersion")?.as_str()?.to_owned(),
        p.get("minCli")?.as_str()?.to_owned(),
    ))
}

/// Before strict parsing: the manifest's major. An unknown major is refused
/// with `package_version_unsupported` (dimension `manifest`) and whatever
/// producer information the newer manifest offers, not with a schema error.
pub fn check_manifest_major(raw: &Value, reader: &ReaderSupport) -> Result<()> {
    let Some(schema) = raw.get("schema").and_then(Value::as_str) else {
        return Err(PackageError::manifest(
            "schema",
            "the manifest has no schema string",
        ));
    };
    if schema == SCHEMA {
        return Ok(());
    }
    let major = schema
        .strip_prefix(SCHEMA_PREFIX)
        .filter(|n| !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|n| n.parse::<u64>().ok());
    match major {
        Some(n) if n > MAJOR => {
            let mut dims = vec![SkewDimension {
                dimension: "manifest".to_owned(),
                found: schema.to_owned(),
                supported: SCHEMA.to_owned(),
            }];
            // A newer manifest still says which CLI it needs, when it keeps `producer`.
            if let (Some((_, _, min_cli)), Some(cli)) = (producer_of(raw), &reader.cli_version) {
                if semver::Version::parse(&min_cli).is_ok_and(|min| &min > cli) {
                    dims.push(SkewDimension {
                        dimension: "cli".to_owned(),
                        found: format!(">= {min_cli}"),
                        supported: cli.to_string(),
                    });
                }
            }
            Err(skew_error(dims, producer_of(raw), reader))
        }
        _ => Err(PackageError::manifest(
            "schema",
            format!("schema {schema:?} is not a scenario package manifest"),
        )),
    }
}

/// Every dimension of a parsed v1 manifest that is ahead of `reader`.
pub fn ahead(manifest: &Manifest, reader: &ReaderSupport) -> Vec<SkewDimension> {
    let mut dims = Vec::new();
    if let Some(cli) = &reader.cli_version {
        let min = semver::Version::parse(&manifest.producer.min_cli).expect("validated");
        if &min > cli {
            dims.push(SkewDimension {
                dimension: "cli".to_owned(),
                found: format!(">= {min}"),
                supported: cli.to_string(),
            });
        }
    }
    if manifest.scenario.scenario_version > reader.max_scenario_version {
        dims.push(SkewDimension {
            dimension: "scenarioVersion".to_owned(),
            found: manifest.scenario.scenario_version.to_string(),
            supported: format!("<= {}", reader.max_scenario_version),
        });
    }
    if manifest.simulation.trace_format > reader.max_trace_format {
        dims.push(SkewDimension {
            dimension: "traceFormat".to_owned(),
            found: manifest.simulation.trace_format.to_string(),
            supported: format!("<= {}", reader.max_trace_format),
        });
    }
    for t in &manifest.timelines {
        if !reader.timeline_versions.contains(&t.version) {
            dims.push(SkewDimension {
                dimension: "timelineVersion".to_owned(),
                found: t.version.clone(),
                supported: reader.timeline_versions.join(", "),
            });
        }
        let n = sampler_number(&t.sampler_version).expect("validated");
        if n > reader.max_sampler {
            dims.push(SkewDimension {
                dimension: "samplerVersion".to_owned(),
                found: t.sampler_version.clone(),
                supported: format!(
                    "<= {}{}",
                    crate::manifest::SAMPLER_PREFIX,
                    reader.max_sampler
                ),
            });
        }
    }
    dims.dedup();
    dims
}

pub fn check(manifest: &Manifest, reader: &ReaderSupport) -> Result<()> {
    let dims = ahead(manifest, reader);
    if dims.is_empty() {
        return Ok(());
    }
    let p = &manifest.producer;
    Err(skew_error(
        dims,
        Some((p.app.clone(), p.app_version.clone(), p.min_cli.clone())),
        reader,
    ))
}
