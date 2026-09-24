//! `--help` as data. An agent reads the command surface as JSON; `--pretty`
//! renders clap's text help of the same command. The surface is built from the
//! clap tree, so it cannot drift from what the parser accepts, and it needs no
//! network, no cache and no private code.

use clap::{Arg, ArgAction, Command};
use serde_json::{json, Value};

use crate::commands;
use crate::contract::exit_code_table;

/// Find the (sub)command named by the leading non-flag tokens of `argv`
/// (without the binary name). Unknown words stop the walk: `simforge maps
/// frobnicate --help` describes `maps`, and the unknown word is reported.
pub fn locate<'a>(
    root: &'a Command,
    argv: &[String],
) -> (&'a Command, Vec<String>, Option<String>) {
    let mut current = root;
    let mut path = Vec::new();
    for token in argv {
        if token == "--" {
            break;
        }
        if token.starts_with('-') {
            continue;
        }
        if token == "help" && path.is_empty() {
            continue;
        }
        match current.find_subcommand(token) {
            Some(sub) => {
                path.push(sub.get_name().to_owned());
                current = sub;
            }
            None if current.has_subcommands() => return (current, path, Some(token.clone())),
            // A positional value (e.g. `render ws --help`): stop at the leaf.
            None => break,
        }
    }
    (current, path, None)
}

fn arg_json(arg: &Arg) -> Value {
    let takes_value = matches!(arg.get_action(), ArgAction::Set | ArgAction::Append);
    let possible: Vec<String> = arg
        .get_possible_values()
        .iter()
        .filter(|v| !v.is_hide_set())
        .map(|v| v.get_name().to_owned())
        .collect();
    let defaults: Vec<String> = arg
        .get_default_values()
        .iter()
        .map(|v| v.to_string_lossy().into_owned())
        .collect();
    let mut out = serde_json::Map::new();
    if arg.is_positional() {
        out.insert("name".into(), json!(arg.get_id().as_str()));
    } else {
        out.insert(
            "name".into(),
            json!(format!(
                "--{}",
                arg.get_long().unwrap_or(arg.get_id().as_str())
            )),
        );
        out.insert("takesValue".into(), json!(takes_value));
    }
    if let Some(names) = arg.get_value_names() {
        if takes_value || arg.is_positional() {
            out.insert(
                "valueName".into(),
                json!(names
                    .iter()
                    .map(|n| n.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")),
            );
        }
    }
    out.insert("required".into(), json!(arg.is_required_set()));
    if matches!(arg.get_action(), ArgAction::Append) {
        out.insert("repeatable".into(), json!(true));
    }
    if !defaults.is_empty() && takes_value {
        out.insert("default".into(), json!(defaults.join(",")));
    }
    if !possible.is_empty() {
        out.insert("possibleValues".into(), json!(possible));
    }
    if let Some(env) = arg.get_env() {
        out.insert("env".into(), json!(env.to_string_lossy()));
    }
    if arg.is_global_set() {
        out.insert("global".into(), json!(true));
    }
    out.insert(
        "help".into(),
        json!(arg.get_help().map(|h| h.to_string()).unwrap_or_default()),
    );
    Value::Object(out)
}

fn summary(cmd: &Command) -> String {
    cmd.get_about().map(|s| s.to_string()).unwrap_or_default()
}

fn status(path: &str) -> &'static str {
    if commands::PLANNED.contains(&path) {
        "planned"
    } else {
        "available"
    }
}

/// Every runnable command as `{name, summary, status}`, depth first.
pub fn flatten(cmd: &Command, prefix: &str, out: &mut Vec<Value>) {
    for sub in cmd.get_subcommands().filter(|s| !s.is_hide_set()) {
        let name = if prefix.is_empty() {
            sub.get_name().to_owned()
        } else {
            format!("{prefix} {}", sub.get_name())
        };
        if sub.has_subcommands() {
            flatten(sub, &name, out);
        } else {
            out.push(json!({ "name": name, "summary": summary(sub), "status": status(&name) }));
        }
    }
}

/// The help document for one command (the root when `path` is empty).
pub fn document(root: &Command, cmd: &Command, path: &[String]) -> Value {
    let name = path.join(" ");
    let mut cmd_for_usage = cmd.clone();
    let usage = cmd_for_usage.render_usage().to_string();
    let usage = usage.trim_start_matches("Usage: ").trim().to_owned();
    let usage = if path.is_empty() {
        usage
    } else {
        format!(
            "simforge {}{}",
            name,
            usage.strip_prefix(cmd.get_name()).unwrap_or(&usage)
        )
    };

    let args: Vec<&Arg> = cmd.get_arguments().filter(|a| !a.is_hide_set()).collect();
    let positionals: Vec<Value> = args
        .iter()
        .filter(|a| a.is_positional())
        .map(|a| arg_json(a))
        .collect();
    let flags: Vec<Value> = args
        .iter()
        .filter(|a| !a.is_positional() && !a.is_global_set())
        .map(|a| arg_json(a))
        .collect();
    let globals: Vec<Value> = root
        .get_arguments()
        .filter(|a| a.is_global_set())
        .map(arg_json)
        .chain(std::iter::once(json!({
            "name": "--help", "takesValue": false, "required": false, "global": true,
            "help": "print this command's surface as JSON (with --pretty: as text)",
        })))
        .collect();

    let mut doc = serde_json::Map::new();
    doc.insert("bin".into(), json!("simforge"));
    doc.insert("version".into(), json!(env!("CARGO_PKG_VERSION")));
    doc.insert("command".into(), json!(name));
    doc.insert("summary".into(), json!(summary(cmd)));
    if let Some(long) = cmd.get_long_about() {
        doc.insert("description".into(), json!(long.to_string()));
    }
    if cmd.has_subcommands() {
        let mut commands = Vec::new();
        flatten(cmd, &name, &mut commands);
        doc.insert("commands".into(), json!(commands));
        if !flags.is_empty() {
            doc.insert("flags".into(), json!(flags));
        }
    } else {
        doc.insert("status".into(), json!(status(&name)));
        doc.insert("usage".into(), json!(usage));
        doc.insert("arguments".into(), json!(positionals));
        doc.insert("flags".into(), json!(flags));
    }
    doc.insert("globalFlags".into(), json!(globals));
    doc.insert("exitCodes".into(), exit_code_table());
    doc.insert(
        "output".into(),
        json!("stdout: one JSON document (indented with --pretty); stderr: {code, path?, reason, detail?} on failure"),
    );
    Value::Object(doc)
}

/// clap's text help for `--help --pretty`.
pub fn text(cmd: &Command, path: &[String]) -> String {
    let mut cmd = cmd.clone().bin_name(if path.is_empty() {
        "simforge".to_owned()
    } else {
        format!("simforge {}", path.join(" "))
    });
    cmd.render_long_help().to_string()
}
