#!/usr/bin/env python3
"""Dump the simforge CLI's whole command surface as one JSON document.

    scripts/skills/surface.py [--bin PATH] [-o OUT]

The CLI prints `--help` as data (JSON built from its clap tree): the root lists
the commands, and `simforge <command...> --help` describes one. This collects
{"version", "root", "commands": {"render": {...}, "maps pull": {...}}} for the
skills generator and checker (scripts/skills/skills.py). The binary is --bin, or
$SIMFORGE_BIN; without either, it is built and run with `cargo run` from the
renderer workspace (the CLI's workspace).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def runner(binary: str | None) -> list[str]:
    if binary:
        return [binary]
    return ["cargo", "run", "--quiet", "--locked", "--manifest-path", str(ROOT / "renderer/Cargo.toml"),
            "--package", "simforge", "--"]


def help_of(cmd: list[str], words: list[str]) -> dict:
    out = subprocess.run(cmd + words + ["--help"], capture_output=True, text=True, cwd=ROOT)
    if out.returncode != 0:
        raise SystemExit(f"`simforge {' '.join(words)} --help` exited {out.returncode}: {out.stderr.strip()[:400]}")
    return json.loads(out.stdout)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", default=os.environ.get("SIMFORGE_BIN"))
    parser.add_argument("-o", "--out")
    args = parser.parse_args()
    cmd = runner(args.bin)
    root = help_of(cmd, [])
    commands = {c["name"]: help_of(cmd, c["name"].split()) for c in root["commands"]}
    surface = {"version": root.get("version"), "root": root, "commands": commands}
    text = json.dumps(surface, indent=1, sort_keys=True) + "\n"
    if args.out:
        Path(args.out).write_text(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
