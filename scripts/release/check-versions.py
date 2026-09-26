#!/usr/bin/env python3
"""Check that one release version is written everywhere it must be.

    scripts/release/check-versions.py [--tag vX.Y.Z[-rc.N]]

Reads the CLI package version (Cargo metadata), the version of every released
Python dist (layout.sh SIMFORGE_PY_DISTS) and CHANGELOG.md, and fails unless
they agree (and match --tag when given); sibling pins must be == that version:

  tag         v0.2.0-rc.0     (semver, what dist parses)
  Cargo       0.2.0-rc.0
  pyproject   0.2.0rc0        (PEP 440 spelling of the same version)
  CHANGELOG   "## [0.2.0-rc.0]" heading (stable and release candidates)

Prints the resolved versions as JSON on success (the release workflows read
`prerelease` from it).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$")
PEP440_TAG = {"alpha": "a", "beta": "b", "rc": "rc"}


def layout() -> dict[str, str]:
    values = {}
    for line in Path("scripts/release/layout.sh").read_text().splitlines():
        match = re.match(r"^([A-Z_]+)=(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2).strip('"')
    return values


def pep440(semver: str) -> str:
    match = SEMVER.match(semver)
    if not match:
        raise SystemExit(f"{semver} is not a release version (X.Y.Z or X.Y.Z-(alpha|beta|rc).N)")
    major, minor, patch, pre, num = match.groups()
    return f"{major}.{minor}.{patch}" + (f"{PEP440_TAG[pre]}{num}" if pre else "")


def cargo_version(manifest: str, package: str) -> str:
    meta = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest]))
    for pkg in meta["packages"]:
        if pkg["name"] == package:
            return pkg["version"]
    raise SystemExit(f"package {package} not found via {manifest}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag")
    args = parser.parse_args()
    paths = layout()

    cargo = cargo_version(paths["SIMFORGE_CLI_MANIFEST"], paths["SIMFORGE_CLI_PACKAGE"])
    expected_py = pep440(cargo)
    problems = []
    if args.tag and args.tag != f"v{cargo}":
        problems.append(f"tag {args.tag} does not match the CLI version v{cargo}")
    changelog = Path("CHANGELOG.md").read_text() if Path("CHANGELOG.md").exists() else ""
    if f"## [{cargo}]" not in changelog:
        problems.append(f"CHANGELOG.md has no '## [{cargo}]' section")

    # Every released Python dist carries the same version, and a pin on a
    # sibling is exactly that version (they are published together).
    dists: dict[str, dict] = {}
    for entry in paths["SIMFORGE_PY_DISTS"].split():
        directory = entry.split(":")[0]
        project = tomllib.loads(Path(directory, "pyproject.toml").read_text())["project"]
        dists[project["name"]] = {"dir": directory, "project": project}
        if project["version"] != expected_py:
            problems.append(f"{directory}/pyproject.toml ({project['name']}) is {project['version']}, expected {expected_py} (Cargo {cargo})")
    for name, info in dists.items():
        project = info["project"]
        requirements = list(project.get("dependencies", []))
        for reqs in project.get("optional-dependencies", {}).values():
            requirements += reqs
        for requirement in requirements:
            dep = re.split(r"[<>=!~\[ ;]", requirement, maxsplit=1)[0]
            if not dep.startswith("simforge-oss-"):
                continue
            if dep not in dists:
                problems.append(f"{name} needs {dep}, which this release does not publish")
            elif not re.search(r"==\s*" + re.escape(expected_py) + r"(\s|;|$|,)", requirement):
                problems.append(f"{name} pins '{requirement}'; siblings are pinned =={expected_py}")
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    prerelease = SEMVER.match(cargo).group(4) is not None
    print(json.dumps({"version": cargo, "python": expected_py, "dists": sorted(dists), "tag": f"v{cargo}", "prerelease": prerelease}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
