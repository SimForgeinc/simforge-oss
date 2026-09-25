//! `simforge skills`: the agent skills that ship inside the binary.
//!
//! Skills are directories under the repository's `skills/` (one per skill,
//! each with a `SKILL.md` whose front matter names and describes it),
//! embedded at build time so the copy always matches the binary, including
//! brew and cargo installs that carry no archive. `install` writes
//! `<dest>/<skill>/...` into an agent's skill directory (`~/.claude/skills`,
//! `${CODEX_HOME:-~/.codex}/skills`, or `--dir`) and records what it wrote
//! (`.simforge-install.json`, the sha256 of every file). Re-installing over
//! files it wrote itself is fine; a file that differs from what an earlier
//! install wrote (edited by hand, or written by something else) is refused
//! as a finding (exit 2) unless `--force`, and a refused install writes
//! nothing at all.

use std::path::{Path, PathBuf};

use clap::{ArgGroup, Args, Subcommand};
use include_dir::{include_dir, Dir, DirEntry};
use serde_json::{json, Value};

use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::paths;

/// The embedded skill bundle.
static SKILLS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../../skills");

/// What an install wrote into a skill directory: `{version, files: {path: sha256}}`.
const INSTALL_RECORD: &str = ".simforge-install.json";

#[derive(Debug, Subcommand)]
pub enum SkillsCommand {
    /// List the skills bundled with this binary.
    List,
    /// Copy the bundled skills into an agent's skill directory.
    Install(InstallArgs),
}

#[derive(Debug, Args)]
#[command(group(ArgGroup::new("target").required(true).args(["claude", "codex", "dir"])))]
pub struct InstallArgs {
    /// Install into ~/.claude/skills (Claude Code).
    #[arg(long)]
    pub claude: bool,
    /// Install into $CODEX_HOME/skills, else ~/.codex/skills (Codex).
    #[arg(long)]
    pub codex: bool,
    /// Install into this directory.
    #[arg(long, value_name = "PATH")]
    pub dir: Option<PathBuf>,
    /// Overwrite files that differ from what an earlier install wrote.
    #[arg(long)]
    pub force: bool,
}

pub fn run(command: SkillsCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        SkillsCommand::List => list(),
        SkillsCommand::Install(args) => install(args),
    }
}

/// One bundled skill: its directory and the front matter of its SKILL.md.
struct Skill {
    name: String,
    description: String,
    dir: &'static Dir<'static>,
}

/// `name:` / `description:` from a SKILL.md front matter block.
fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some(v) = line.strip_prefix("name:") {
            name = Some(v.trim().to_owned());
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(v.trim().to_owned());
        }
    }
    (name, description)
}

fn bundled() -> Result<Vec<Skill>, CliError> {
    let mut skills = Vec::new();
    for dir in SKILLS.dirs() {
        let dir_name = dir
            .path()
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let manifest = dir.get_file(dir.path().join("SKILL.md")).ok_or_else(|| {
            CliError::new(
                "skills_bundle_invalid",
                format!("bundled skill {dir_name} has no SKILL.md"),
            )
        })?;
        let text = manifest.contents_utf8().unwrap_or_default();
        let (name, description) = front_matter(text);
        let name = name.ok_or_else(|| {
            CliError::new(
                "skills_bundle_invalid",
                format!("bundled skill {dir_name}: SKILL.md has no `name:` front matter"),
            )
        })?;
        if name != dir_name {
            return Err(CliError::new(
                "skills_bundle_invalid",
                format!("bundled skill directory {dir_name} declares name {name}"),
            ));
        }
        skills.push(Skill {
            name,
            description: description.unwrap_or_default(),
            dir,
        });
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    if skills.is_empty() {
        return Err(CliError::new(
            "no_skills_bundled",
            "this build of simforge bundles no skills",
        ));
    }
    Ok(skills)
}

fn files(dir: &'static Dir<'static>, out: &mut Vec<&'static include_dir::File<'static>>) {
    for entry in dir.entries() {
        match entry {
            DirEntry::Dir(d) => files(d, out),
            DirEntry::File(f) => out.push(f),
        }
    }
}

fn list() -> CmdResult {
    let skills = bundled()?;
    let listed: Vec<Value> = skills
        .iter()
        .map(|s| {
            let mut all = Vec::new();
            files(s.dir, &mut all);
            json!({
                "name": s.name,
                "description": s.description,
                "files": all.iter().map(|f| f.path().strip_prefix(s.dir.path()).unwrap_or(f.path())).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(Outcome::ok(json!({
        "schema": "simforge.skills/v1",
        "version": env!("CARGO_PKG_VERSION"),
        "skills": listed,
    })))
}

fn home() -> Result<PathBuf, CliError> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| CliError::new("no_home", "HOME is not set; pass --dir"))
}

fn destination(args: &InstallArgs) -> Result<(PathBuf, &'static str), CliError> {
    if let Some(dir) = &args.dir {
        return Ok((paths::absolutize(dir), "dir"));
    }
    if args.claude {
        return Ok((home()?.join(".claude").join("skills"), "claude"));
    }
    let codex_home = std::env::var_os("CODEX_HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from);
    Ok((
        match codex_home {
            Some(h) => h.join("skills"),
            None => home()?.join(".codex").join("skills"),
        },
        "codex",
    ))
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The bundled files of one skill as (relative path, bytes).
fn skill_files(skill: &Skill) -> Vec<(String, &'static [u8])> {
    let mut all = Vec::new();
    files(skill.dir, &mut all);
    all.iter()
        .map(|f| {
            let rel = f.path().strip_prefix(skill.dir.path()).unwrap_or(f.path());
            (rel.to_string_lossy().replace('\\', "/"), f.contents())
        })
        .collect()
}

/// Files already in `target` that this install would overwrite but that
/// differ from what an earlier install wrote (or that no install wrote).
fn conflicts(skill: &Skill, target: &Path) -> Vec<Value> {
    if !target.exists() {
        return Vec::new();
    }
    let record: Value = std::fs::read(target.join(INSTALL_RECORD))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let mut out = Vec::new();
    for (rel, bytes) in skill_files(skill) {
        let path = target.join(&rel);
        let Ok(current) = std::fs::read(&path) else {
            continue;
        };
        let current = sha256(&current);
        if current == sha256(bytes) {
            continue;
        }
        match record["files"][&rel].as_str() {
            Some(written) if written == current => {}
            written => out.push(json!({
                "path": path,
                "reason": if written.is_some() { "modified since the last install" } else { "not written by simforge skills install" },
            })),
        }
    }
    out
}

fn write_skill(skill: &Skill, target: &Path) -> Result<usize, CliError> {
    let files = skill_files(skill);
    let mut record = serde_json::Map::new();
    for (rel, bytes) in &files {
        let path = target.join(rel);
        std::fs::create_dir_all(path.parent().expect("a file has a parent"))
            .and_then(|_| {
                let tmp = path.with_extension(format!("simforge-{}", std::process::id()));
                std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path))
            })
            .map_err(|e| {
                CliError::new(
                    "write_failed",
                    format!("cannot write {}: {e}", path.display()),
                )
            })?;
        record.insert(rel.clone(), json!(sha256(bytes)));
    }
    let doc = json!({ "version": env!("CARGO_PKG_VERSION"), "files": record });
    std::fs::write(
        target.join(INSTALL_RECORD),
        serde_json::to_vec_pretty(&doc).expect("JSON serializes"),
    )
    .map_err(|e| {
        CliError::new(
            "write_failed",
            format!("cannot write {}: {e}", target.display()),
        )
    })?;
    Ok(files.len())
}

fn install(args: InstallArgs) -> CmdResult {
    let skills = bundled()?;
    let (dest, kind) = destination(&args)?;
    let found: Vec<Value> = skills
        .iter()
        .flat_map(|s| conflicts(s, &dest.join(&s.name)))
        .collect();
    if !found.is_empty() && !args.force {
        return Err(CliError::findings(
            "skills_modified",
            format!(
                "{} file(s) under {} differ from what simforge installed there; pass --force to overwrite them",
                found.len(),
                dest.display()
            ),
        )
        .with_path(dest.display().to_string())
        .with_detail(json!({ "files": found })));
    }
    std::fs::create_dir_all(&dest).map_err(|e| {
        CliError::new(
            "write_failed",
            format!("cannot create {}: {e}", dest.display()),
        )
        .with_path(dest.display().to_string())
    })?;
    let mut installed = Vec::new();
    for skill in &skills {
        let target = dest.join(&skill.name);
        let existed = target.exists();
        let count = write_skill(skill, &target)?;
        installed.push(json!({
            "name": skill.name,
            "path": target,
            "files": count,
            "updated": existed,
        }));
    }
    Ok(Outcome::ok(json!({
        "schema": "simforge.skills-install/v1",
        "version": env!("CARGO_PKG_VERSION"),
        "dest": dest,
        "target": kind,
        "forced": args.force && !found.is_empty(),
        "overwritten": if args.force { json!(found) } else { json!([]) },
        "installed": installed,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_skill_is_named_like_its_directory() {
        let skills = bundled().unwrap();
        assert!(skills.iter().any(|s| s.name == "simforge-cli"));
        assert!(skills.iter().all(|s| !s.description.is_empty()));
    }

    #[test]
    fn front_matter_reads_name_and_description() {
        let (n, d) = front_matter("---\nname: a\ndescription: b c\n---\n# x\n");
        assert_eq!((n.as_deref(), d.as_deref()), (Some("a"), Some("b c")));
        assert_eq!(front_matter("# no front matter"), (None, None));
    }
}
