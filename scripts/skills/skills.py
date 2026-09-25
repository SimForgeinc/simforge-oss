#!/usr/bin/env python3
"""Keep skills/ true to the simforge CLI.

    scripts/skills/skills.py generate --surface surface.json   rewrite the generated blocks
    scripts/skills/skills.py check    --surface surface.json   fail on drift or unknown commands/flags

`surface.json` comes from scripts/skills/surface.py (the CLI's `--help` data).

Generated blocks: a SKILL.md (or a file under its references/) may contain

    <!-- simforge:reference render, env serve -->
    ...generated...
    <!-- /simforge:reference -->

and `generate` replaces the inside with the commands' usage, arguments and
flags (possible values, defaults) and the exit codes, from the surface. `check`
fails when a block is stale.

Lint (check): every `simforge <words...>` invocation in the skills (code blocks
and inline code) must name a command the CLI has, and every `--flag` in that
invocation must be a flag of that command or a global flag. Frontmatter must
follow the Agent Skills format: `name` equal to the directory name (lowercase
letters, digits, hyphens; at most 64 characters) and a `description` of at most
1024 characters. Drafts live in scripts/skills/drafts/ (not shipped, not
checked) until their commands exist.
"""
from __future__ import annotations

import argparse
import json
import re
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / "skills"
BLOCK = re.compile(r"(<!-- simforge:reference (?P<cmds>[^>]*?) -->\n)(?P<body>.*?)(<!-- /simforge:reference -->)", re.S)
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def skill_files() -> list[Path]:
    return sorted(SKILLS.rglob("*.md"))


def render_command(surface: dict, name: str) -> str:
    cmd = surface["commands"].get(name)
    if cmd is None:
        raise SystemExit(f"generated block names `{name}`, which the CLI does not have")
    args = cmd.get("arguments", [])
    usage = " ".join(["simforge", name] + [f"<{a.get('valueName', a['name']).lower()}>" for a in args] + ["[flags]"])
    lines = [f"#### `simforge {name}`", "", cmd.get("summary", "").strip(), "", f"Usage: `{usage}`", ""]
    rows = []
    for a in args:
        rows.append((f"`<{a.get('valueName', a['name']).lower()}>`", "required" if a.get("required") else "optional", a.get("help", "")))
    for f in cmd.get("flags", []):
        value = f" {f['valueName']}" if f.get("takesValue") and f.get("valueName") else ""
        notes = []
        if f.get("required"):
            notes.append("required")
        if f.get("possibleValues"):
            notes.append("one of " + ", ".join(f"`{v}`" for v in f["possibleValues"]))
        if "default" in f:
            notes.append(f"default `{f['default']}`")
        if f.get("repeatable"):
            notes.append("repeatable")
        rows.append((f"`{f['name']}{value}`", "; ".join(notes), f.get("help", "")))
    if rows:
        lines += ["| Argument / flag | | What |", "|---|---|---|"]
        lines += [f"| {a} | {b} | {c.replace('|', '/')} |" for a, b, c in rows]
        lines.append("")
    return "\n".join(lines)


def render_block(surface: dict, names: list[str]) -> str:
    parts = [f"_Generated from `simforge --help` (CLI {surface.get('version')}) by scripts/skills/skills.py; do not edit._", ""]
    parts += [render_command(surface, n) for n in names]
    codes = surface["root"].get("exitCodes", {})
    parts.append("Exit codes: " + "; ".join(f"`{k}` {v}" for k, v in sorted(codes.items())) + ".")
    parts.append("")
    return "\n".join(parts)


def regenerate(text: str, surface: dict) -> str:
    def sub(m: re.Match) -> str:
        names = [n.strip() for n in m.group("cmds").split(",") if n.strip()]
        return m.group(1) + render_block(surface, names) + m.group(4)
    return BLOCK.sub(sub, text)


def frontmatter(path: Path, text: str) -> list[str]:
    if path.name != "SKILL.md":
        return []
    problems = []
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return [f"{path}: no YAML frontmatter"]
    fields = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            fields[k.strip()] = v.strip().strip('"')
    name, desc = fields.get("name", ""), fields.get("description", "")
    if name != path.parent.name:
        problems.append(f"{path}: frontmatter name '{name}' must equal the directory name '{path.parent.name}'")
    if not NAME.match(name) or len(name) > 64:
        problems.append(f"{path}: name '{name}' must be lowercase letters, digits and hyphens, at most 64 characters")
    if not desc or len(desc) > 1024:
        problems.append(f"{path}: description must be 1-1024 characters")
    return problems


def invocations(text: str) -> list[list[str]]:
    """Every `simforge ...` invocation in fenced code and inline code (not in generated blocks)."""
    text = BLOCK.sub("", text)
    chunks = re.findall(r"```[a-z]*\n(.*?)```", text, re.S)
    chunks += re.findall(r"`([^`\n]*\bsimforge [^`\n]*)`", text)
    found = []
    for chunk in chunks:
        chunk = chunk.replace("\\\n", " ")
        for line in chunk.splitlines():
            for m in re.finditer(r"(?:^|[\s;&|(])simforge((?:\s+[^\s;&|)#]+)*)", line):
                try:
                    words = shlex.split(m.group(1), comments=True)
                except ValueError:
                    words = m.group(1).split()
                found.append(words)
    return found


def lint(path: Path, text: str, surface: dict) -> list[str]:
    problems = []
    commands = surface["commands"]
    global_flags = {f["name"] for f in surface["root"].get("globalFlags", [])} | {"--version"}
    for words in invocations(text):
        if words and words[0].startswith("<"):
            continue  # a metavariable (`simforge <command> --help`), not an invocation
        if not words or words[0].startswith("-"):
            flags = [w.split("=")[0] for w in words if w.startswith("--")]
            for fl in flags:
                if fl not in global_flags:
                    problems.append(f"{path}: `simforge {' '.join(words)}`: unknown global flag {fl}")
            continue
        # Longest command path that matches the leading words.
        cmd = None
        for n in (2, 1):
            candidate = " ".join(words[:n])
            if candidate in commands:
                cmd = candidate
                break
        if cmd is None:
            problems.append(f"{path}: `simforge {' '.join(words)}`: no such command")
            continue
        known = {f["name"] for f in commands[cmd].get("flags", [])} | global_flags
        for w in words:
            if w.startswith("--"):
                fl = w.split("=")[0]
                if fl not in known:
                    problems.append(f"{path}: `simforge {' '.join(words)}`: `{cmd}` has no flag {fl}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=["generate", "check"])
    parser.add_argument("--surface", required=True, type=Path)
    args = parser.parse_args()
    surface = json.loads(args.surface.read_text())
    problems: list[str] = []
    changed = []
    for path in skill_files():
        text = path.read_text()
        fresh = regenerate(text, surface)
        if args.mode == "generate":
            if fresh != text:
                path.write_text(fresh)
                changed.append(str(path.relative_to(ROOT)))
        elif fresh != text:
            problems.append(f"{path}: generated reference is stale: run scripts/skills/skills.py generate")
        problems += frontmatter(path, fresh)
        problems += lint(path.relative_to(ROOT), fresh, surface)
    for d in sorted(p for p in SKILLS.iterdir() if p.is_dir() and not p.name.startswith(".")):
        if not (d / "SKILL.md").is_file():
            problems.append(f"{d}: a skill directory needs a SKILL.md")
    for p in problems:
        print(p, file=sys.stderr)
    print(json.dumps({"mode": args.mode, "skills": len(list(SKILLS.glob("*/SKILL.md"))), "rewritten": changed,
                      "problems": len(problems), "cli": surface.get("version")}))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
