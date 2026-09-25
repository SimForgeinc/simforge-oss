//! Reading authored v2 templates.
//!
//! One parser: the compiler's strict typed template (the upgrader chain, then
//! `deny_unknown_fields` serde, then the universal cross-field checks). A
//! failure is a finding (exit 2) carrying `{path, message, code}` issues, so a
//! repair loop gets "your document is wrong at this path", never a line and
//! column.

use std::path::Path;

use serde_json::{json, Value};
use simforge_compiler::template::structural_issues;
use simforge_compiler::{upgrade_template_document, CompileError, ScenarioTemplate};

use crate::json::read_json;

/// A template as read from disk: the parsed document and its typed form.
#[derive(Debug, Clone)]
pub struct TemplateFile {
    pub document: Value,
    pub template: ScenarioTemplate,
}

/// One schema issue, in the `ScenarioIssue` shape.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SchemaIssue {
    pub path: String,
    pub message: String,
    pub code: String,
}

/// Parse a JSON value as a v2 template; `Err` carries every issue found.
pub fn parse_template_issues(document: &Value) -> Result<ScenarioTemplate, Vec<SchemaIssue>> {
    let upgraded = upgrade_template_document(document.clone()).map_err(|e| {
        vec![SchemaIssue {
            path: e.path.clone().unwrap_or_default(),
            message: e.reason.clone(),
            code: "invalid_value".into(),
        }]
    })?;
    let template: ScenarioTemplate =
        serde_path_to_error::deserialize(upgraded).map_err(|error| {
            let path = dotted_path(error.path());
            let inner = error.into_inner().to_string();
            vec![SchemaIssue {
                path,
                code: issue_code(&inner).into(),
                message: inner,
            }]
        })?;
    let structural = structural_issues(&template);
    if !structural.is_empty() {
        return Err(structural
            .into_iter()
            .map(|i| SchemaIssue {
                path: i.path,
                message: i.message,
                code: "custom".into(),
            })
            .collect());
    }
    Ok(template)
}

/// Read and parse a template file (`template_invalid`, exit 2, on failure).
pub fn read_template(file: &Path) -> Result<TemplateFile, CompileError> {
    let document = read_json(file)?;
    match parse_template_issues(&document) {
        Ok(template) => Ok(TemplateFile { document, template }),
        Err(issues) => Err(CompileError::at(
            "template_invalid",
            file.display().to_string(),
            "the document is not a valid v2 scenario template",
        )
        .detail_entry("issues", json!(issues))
        .as_findings()),
    }
}

/// serde's error kinds in zod's issue-code vocabulary.
fn issue_code(message: &str) -> &'static str {
    if message.starts_with("unknown field") {
        "unrecognized_keys"
    } else if message.starts_with("invalid type") || message.starts_with("missing field") {
        "invalid_type"
    } else if message.starts_with("unknown variant") {
        "invalid_value"
    } else {
        "custom"
    }
}

/// `roles[0].pose` -> `roles.0.pose` (the `ScenarioIssue` path form).
fn dotted_path(path: &serde_path_to_error::Path) -> String {
    use serde_path_to_error::Segment;
    let parts: Vec<String> = path
        .iter()
        .filter_map(|segment| match segment {
            Segment::Seq { index } => Some(index.to_string()),
            Segment::Map { key } => Some(key.clone()),
            Segment::Enum { variant } => Some(variant.clone()),
            Segment::Unknown => None,
        })
        .collect();
    parts.join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fields_name_their_path() {
        let doc = json!({
            "scenarioVersion": 2,
            "meta": {"name": "x", "createdAt": "1970-01-01T00:00:00.000Z", "modifiedAt": "1970-01-01T00:00:00.000Z", "appVersion": "t", "bogus": 1},
            "anchor": {"corridor": {}, "features": []}
        });
        let issues = parse_template_issues(&doc).unwrap_err();
        assert_eq!(issues.len(), 1);
        assert!(issues[0].path.starts_with("meta"), "{issues:?}");
    }
}
