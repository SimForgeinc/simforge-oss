#!/usr/bin/env python3
"""Fail when a reusable workflow asks for more than its caller grants.

GitHub refuses a run at startup ("startup_failure", no job starts) when a
called workflow's `permissions` (top level or any job) exceed what the
calling job grants. That is only visible after a tag is pushed, so this
checks it before: every `uses: ./.github/workflows/<x>.yml` job in every
workflow against the called file.

    scripts/release/check-workflow-permissions.py
"""
import sys
from pathlib import Path

import yaml

LEVEL = {"none": 0, "read": 1, "write": 2}
ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"


def perms(value):
    if value in (None, {}):
        return {}
    if isinstance(value, str):  # read-all / write-all
        return {"*": value.split("-")[0]}
    return dict(value)


def needed(called):
    doc = yaml.safe_load(called.read_text())
    out = perms(doc.get("permissions"))
    for job in (doc.get("jobs") or {}).values():
        for scope, level in perms(job.get("permissions")).items():
            if LEVEL[level] > LEVEL.get(out.get(scope, "none"), 0):
                out[scope] = level
    return out


problems = []
for caller in sorted(WORKFLOWS.glob("*.yml")):
    doc = yaml.safe_load(caller.read_text())
    default = perms(doc.get("permissions"))
    for name, job in (doc.get("jobs") or {}).items():
        uses = job.get("uses", "")
        if not uses.startswith("./.github/workflows/"):
            continue
        granted = perms(job["permissions"]) if "permissions" in job else default
        for scope, level in needed(ROOT / uses[2:]).items():
            have = granted.get(scope, granted.get("*", "none"))
            if LEVEL[level] > LEVEL[have]:
                problems.append(f"{caller.name}: job {name} grants {scope}: {have}, {uses[2:]} needs {level}")
for p in problems:
    print(p, file=sys.stderr)
print(f"workflow permissions: {len(problems)} problem(s)")
sys.exit(1 if problems else 0)
