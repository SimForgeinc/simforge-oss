//! `simforge`: the SimForge command line.
//!
//! The contract lives in [`contract`]: one JSON document on stdout, a
//! structured `{code, path?, reason, detail?}` error on stderr, exit 0/1/2.
//! `--help` on any command prints that command's surface as JSON.
//!
//! Adding a command: a module under `commands/` with a clap `Args` (or
//! `Subcommand`) type and a `run(args, ctx) -> CmdResult`, one variant in
//! [`commands::Command`] and one arm in [`commands::dispatch`].

pub mod auth;
pub mod commands;
pub mod contract;
#[cfg(unix)]
pub mod env_serve;
pub mod help;
pub mod installed_maps;
pub mod net;
pub mod paths;
pub mod registry;
pub mod render;
pub mod workspace;

use std::ffi::OsString;

use clap::error::{ContextKind, ContextValue, ErrorKind};
use clap::{CommandFactory, Parser};
use serde_json::json;

use contract::{emit, emit_error, CliError, Ctx, Exit};

#[derive(Debug, Parser)]
#[command(
    name = "simforge",
    about = "SimForge: verify scenario packages, pull maps and assets, render, re-simulate, and serve closed-loop episodes",
    disable_help_flag = true,
    disable_help_subcommand = true,
    disable_version_flag = true
)]
pub struct Cli {
    /// Indent the JSON result for humans (the same document, never a different one).
    #[arg(long, global = true)]
    pub pretty: bool,

    /// Print the CLI version as JSON.
    #[arg(long)]
    pub version: bool,

    #[command(subcommand)]
    pub command: Option<commands::Command>,
}

/// The full clap tree, built (global flags propagated).
pub fn command_tree() -> clap::Command {
    let mut cmd = Cli::command();
    cmd.build();
    cmd
}

fn wants_help(argv: &[String]) -> bool {
    argv.iter()
        .take_while(|a| a.as_str() != "--")
        .any(|a| a == "--help" || a == "-h")
        || argv.first().map(String::as_str) == Some("help")
}

fn help(argv: &[String]) -> i32 {
    let root = command_tree();
    let (cmd, path, unknown) = help::locate(&root, argv);
    if let Some(word) = unknown {
        let known: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        let error = CliError::new("unknown_command", format!("unknown command `{word}`"))
            .with_path(if path.is_empty() {
                word.clone()
            } else {
                format!("{} {word}", path.join(" "))
            })
            .with_detail(json!({ "known": known }));
        emit_error(&error);
        return Exit::CommandError.code();
    }
    if argv.iter().any(|a| a == "--json") {
        // The whole surface under this command, every flag typed.
        emit(
            &help::surface(&root, cmd, &path),
            argv.iter().any(|a| a == "--pretty"),
        );
    } else if argv.iter().any(|a| a == "--pretty") {
        print!("{}", help::text(cmd, &path));
    } else {
        emit(&help::document(&root, cmd, &path), false);
    }
    Exit::Ok.code()
}

fn context_string(error: &clap::Error, kind: ContextKind) -> Option<String> {
    match error.get(kind)? {
        ContextValue::String(s) => Some(s.clone()),
        ContextValue::Strings(v) => Some(v.join(", ")),
        other => Some(other.to_string()),
    }
}

/// clap's parse failures in the contract's shape. Unknown flags are errors,
/// never warnings: a typo'd flag that is ignored is exactly the failure an
/// unattended caller cannot see. `rest` is argv without the binary name.
pub fn parse_error(error: &clap::Error, rest: &[String]) -> CliError {
    let code = match error.kind() {
        ErrorKind::UnknownArgument => "unknown_flag",
        ErrorKind::InvalidSubcommand => "unknown_command",
        ErrorKind::MissingRequiredArgument => "missing_argument",
        ErrorKind::MissingSubcommand | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            "missing_command"
        }
        ErrorKind::InvalidValue
        | ErrorKind::ValueValidation
        | ErrorKind::InvalidUtf8
        | ErrorKind::NoEquals => "bad_value",
        ErrorKind::ArgumentConflict => "conflicting_arguments",
        ErrorKind::TooManyValues | ErrorKind::TooFewValues | ErrorKind::WrongNumberOfValues => {
            "bad_value"
        }
        _ => "bad_arguments",
    };
    // `--preset <PRESET>` -> `--preset`; `<NAME@VERSION>` stays as is.
    let path = context_string(error, ContextKind::InvalidArg)
        .or_else(|| context_string(error, ContextKind::InvalidSubcommand))
        .map(|p| {
            if p.starts_with("--") {
                p.split_whitespace().next().unwrap_or(&p).to_owned()
            } else {
                p
            }
        });
    let rendered = error.render().to_string();
    let first_line = rendered
        .lines()
        .next()
        .unwrap_or("invalid arguments")
        .trim_start_matches("error: ")
        .trim()
        .to_owned();
    let mut detail = serde_json::Map::new();
    let reason = match error.kind() {
        ErrorKind::MissingRequiredArgument => format!(
            "missing required argument {}",
            path.as_deref().unwrap_or("")
        ),
        ErrorKind::MissingSubcommand | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            let root = command_tree();
            let (cmd, at, _) = help::locate(&root, rest);
            let known: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
            detail.insert("known".into(), json!(known));
            format!("`simforge {}` needs a subcommand", at.join(" "))
        }
        _ => first_line,
    };
    let mut out = CliError::new(code, reason);
    if let Some(path) = path {
        out = out.with_path(path);
    }
    if let Some(valid) = context_string(error, ContextKind::ValidValue)
        .or_else(|| context_string(error, ContextKind::ValidSubcommand))
    {
        detail.insert("valid".into(), json!(valid));
    }
    if let Some(suggested) = context_string(error, ContextKind::SuggestedArg)
        .or_else(|| context_string(error, ContextKind::SuggestedSubcommand))
    {
        detail.insert("didYouMean".into(), json!(suggested));
    }
    if !detail.is_empty() {
        out = out.with_detail(serde_json::Value::Object(detail));
    }
    out
}

/// Run the CLI over `argv` (including the binary name); returns the exit code.
pub fn run<I, T>(argv: I) -> i32
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let argv: Vec<OsString> = argv.into_iter().map(Into::into).collect();
    let rest: Vec<String> = argv
        .iter()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();

    if rest.is_empty() || wants_help(&rest) {
        return help(&rest);
    }

    let cli = match Cli::try_parse_from(&argv) {
        Ok(cli) => cli,
        Err(error) => {
            emit_error(&parse_error(&error, &rest));
            return Exit::CommandError.code();
        }
    };
    let ctx = Ctx { pretty: cli.pretty };

    if cli.version {
        emit(
            &json!({ "bin": "simforge", "version": env!("CARGO_PKG_VERSION") }),
            ctx.pretty,
        );
        return Exit::Ok.code();
    }
    let Some(command) = cli.command else {
        return help(&[]);
    };

    match commands::dispatch(command, &ctx) {
        Ok(outcome) => {
            if !outcome.value.is_null() {
                emit(&outcome.value, ctx.pretty);
            }
            outcome.exit.code()
        }
        Err(error) => {
            emit_error(&error);
            error.exit.code()
        }
    }
}
