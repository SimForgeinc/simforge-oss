//! The syntax gate for the concrete OpenSCENARIO DSL 2.2 profile the
//! exporter emits: a strict subset of the official grammar (imports, one
//! scenario, parameter and keep declarations, do/serial/parallel, behavior
//! invocations, modifiers, waits). Anything else is rejected: this is an
//! exporter gate, not a general OpenSCENARIO compiler.

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DslDiagnostic {
    pub line: usize,
    pub column: usize,
    pub reason: String,
}

fn statements() -> &'static [Regex] {
    static STATEMENTS: OnceLock<Vec<Regex>> = OnceLock::new();
    STATEMENTS.get_or_init(|| {
        let identifier = "[A-Za-z_][A-Za-z0-9_]*";
        let field = format!("{identifier}(?:\\.{identifier})*");
        let number = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?";
        let physical = format!("{number}(?:m|s|rad|mps|mpss)");
        let value = format!(r#"(?:{physical}|{number}|true|false|{field}|"(?:[^"\\]|\\.)*")"#);
        [
            format!("^import {field}$"),
            format!("^scenario {identifier}:$"),
            format!("^{identifier}: (?:map|vehicle|person|animal|stationary_object|pose_3d) with:$"),
            format!(
                "^{identifier}: path = {field}\\.create_path\\(points: \\[{identifier}(?:, {identifier})+\\], interpolation: straight_line\\)$"
            ),
            "^keep\\(.+\\)$".to_owned(),
            format!("^{field}\\.location\\(pose: {identifier}\\)$"),
            format!("^do parallel\\(duration: {physical}\\):$"),
            "^serial:$".to_owned(),
            format!("^wait elapsed\\({physical}\\)$"),
            format!(r#"^{field}\.{identifier}\((?:[^()"']|"(?:[^"\\]|\\.)*")*\)(?: with:)?$"#),
            format!("^{identifier}\\((?:{identifier}: {value})(?:, {identifier}: {value})*\\)$"),
        ]
        .iter()
        .map(|p| Regex::new(p).expect("DSL profile statement pattern"))
        .collect()
    })
}

fn content_without_comment(line: &str) -> Option<&str> {
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == '#' && !quoted {
            let kept = line[..index].trim_end();
            return (!kept.is_empty()).then_some(kept);
        }
    }
    let kept = line.trim_end();
    (!kept.is_empty()).then_some(kept)
}

fn balanced(line: &str) -> Option<String> {
    let mut stack: Vec<char> = Vec::new();
    let mut quoted = false;
    let mut escaped = false;
    for ch in line.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        match ch {
            '(' | '[' | '{' => stack.push(ch),
            ')' | ']' | '}' => {
                let open = match ch {
                    ')' => '(',
                    ']' => '[',
                    _ => '{',
                };
                if stack.pop() != Some(open) {
                    return Some(format!("unmatched {ch}"));
                }
            }
            _ => {}
        }
    }
    if quoted {
        return Some("unterminated string literal".into());
    }
    stack.last().map(|c| format!("unclosed {c}"))
}

/// Every diagnostic for `source` (empty = accepted).
pub fn validate_dsl22_profile_syntax(source: &str) -> Vec<DslDiagnostic> {
    let mut diagnostics = Vec::new();
    let diag = |line: usize, column: usize, reason: String| DslDiagnostic { line, column, reason };
    if source.contains('\r') {
        diagnostics.push(diag(1, 1, "only LF line endings are accepted".into()));
    }
    let mut active = vec![0usize];
    let mut previous: Option<(usize, bool, usize)> = None;
    let mut saw_import = false;
    let mut saw_scenario = false;
    for (offset, raw) in source.split('\n').enumerate() {
        let line = offset + 1;
        if let Some(tab) = raw.find('\t') {
            diagnostics.push(diag(line, raw[..tab].chars().count() + 1, "tabs are not valid indentation in the concrete profile".into()));
            continue;
        }
        let Some(visible) = content_without_comment(raw) else { continue };
        let text = visible.trim_start();
        let indent = visible.chars().count() - text.chars().count();
        if indent % 4 != 0 {
            diagnostics.push(diag(line, 1, "indentation must use four-space levels".into()));
        }
        match previous {
            Some((prev_indent, opens, prev_line)) if indent > prev_indent => {
                if !opens {
                    diagnostics.push(diag(line, 1, format!("unexpected indentation after line {prev_line}")));
                }
                active.push(indent);
            }
            _ if indent < *active.last().unwrap_or(&0) => {
                while active.len() > 1 && indent < *active.last().unwrap_or(&0) {
                    active.pop();
                }
                if indent != *active.last().unwrap_or(&0) {
                    diagnostics.push(diag(line, 1, "dedent does not match an enclosing block".into()));
                }
            }
            _ => {}
        }
        if let Some(issue) = balanced(text) {
            diagnostics.push(diag(line, 1, issue));
        }
        if !statements().iter().any(|s| s.is_match(text)) {
            diagnostics.push(diag(
                line,
                indent + 1,
                format!("statement is outside the generated DSL 2.2 grammar profile: {text}"),
            ));
        }
        if text.starts_with("import ") {
            if indent != 0 || saw_scenario {
                diagnostics.push(diag(line, 1, "imports must precede the top-level scenario".into()));
            }
            saw_import = true;
        } else if text.starts_with("scenario ") {
            if indent != 0 || saw_scenario {
                diagnostics.push(diag(line, 1, "exactly one top-level scenario is allowed".into()));
            }
            saw_scenario = true;
        } else if !saw_scenario {
            diagnostics.push(diag(line, 1, "scenario declaration must precede scenario members".into()));
        }
        previous = Some((indent, text.ends_with(':'), line));
    }
    if !saw_import {
        diagnostics.push(diag(1, 1, "missing standard-library import".into()));
    }
    if !saw_scenario {
        diagnostics.push(diag(1, 1, "missing scenario declaration".into()));
    }
    if let Some((indent, true, line)) = previous {
        diagnostics.push(diag(line, indent + 1, "block has no body".into()));
    }
    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_emitted_profile_and_rejects_the_rest() {
        let ok = "import osc.standard\n\nscenario s:\n    map_ref: map with:\n        keep(it.map_file == \"a.xodr\")\n    do parallel(duration: 5s):\n        serial:\n            wait elapsed(1s)\n            actor_a.assign_speed(speed: 3mps)\n";
        assert!(validate_dsl22_profile_syntax(ok).is_empty(), "{:?}", validate_dsl22_profile_syntax(ok));
        let bad = "import osc.standard\nscenario s:\n    lol what\n";
        assert!(!validate_dsl22_profile_syntax(bad).is_empty());
    }
}
