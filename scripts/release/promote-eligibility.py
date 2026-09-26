#!/usr/bin/env python3
"""Decide whether a prerelease may be promoted to stable.

    scripts/release/promote-eligibility.py --tag vX.Y.Z --event workflow_dispatch
    scripts/release/promote-eligibility.py --scan --event schedule

Rules (PROGRAM.md "Releases"; .claude/agents/release.md):
  - only a published, non-draft GitHub *prerelease* whose version has no
    semver prerelease suffix can go stable (release candidates never do);
  - smoke-report.json on the release says "pass": true;
  - gpu-smoke-report.json (postmerge agent, real NVIDIA GPUs) says "pass": true;
  - no open issue labelled P1 or release-blocker;
  - v0.2.x-v0.4.x: only a person, by workflow_dispatch, through the
    `stable-approval` environment (the user clicks);
  - v0.5.0 and later: also automatically (schedule) once the release has been
    published for >= 48 h with all of the above green; through the `stable`
    environment.

Prints {"eligible", "tag", "environment", "reasons"} as JSON and writes the
same keys to $GITHUB_OUTPUT when set. Exit 0 either way; the workflow reads
"eligible".
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys

REPO = os.environ.get("GITHUB_REPOSITORY", "SimForgeinc/simforge-sdk")
SEMVER = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?$")
WAIT = dt.timedelta(hours=48)
MANUAL_BELOW = (0, 5, 0)


def gh(*args: str) -> str:
    return subprocess.check_output(["gh", *args], text=True)


def release(tag: str) -> dict:
    return json.loads(gh("release", "view", tag, "--repo", REPO, "--json",
                         "tagName,isDraft,isPrerelease,publishedAt,assets"))


def report(tag: str, name: str) -> dict | None:
    try:
        return json.loads(gh("release", "download", tag, "--repo", REPO, "-p", name, "-O", "-"))
    except subprocess.CalledProcessError:
        return None


def blockers() -> list[str]:
    issues = json.loads(gh("issue", "list", "--repo", REPO, "--state", "open", "--json", "number,title,labels",
                           "--limit", "200"))
    return [f"#{i['number']} {i['title']}" for i in issues
            if {l["name"].lower() for l in i["labels"]} & {"p1", "release-blocker"}]


def evaluate(tag: str, event: str, now: dt.datetime) -> dict:
    reasons: list[str] = []
    match = SEMVER.match(tag)
    if not match:
        return {"eligible": False, "tag": tag, "environment": "", "reasons": [f"{tag} is not a vX.Y.Z tag"]}
    version = tuple(int(x) for x in match.groups()[:3])
    if match.group(4):
        reasons.append(f"{tag} is a release candidate; candidates are never promoted (tag vX.Y.Z)")
    rel = release(tag)
    if rel["isDraft"]:
        reasons.append("the release is still a draft")
    if not rel["isPrerelease"]:
        reasons.append("the release is already stable")
    published = dt.datetime.fromisoformat(rel["publishedAt"].replace("Z", "+00:00")) if rel["publishedAt"] else None

    smoke = report(tag, "smoke-report.json")
    if not smoke or smoke.get("pass") is not True:
        reasons.append("smoke-report.json is missing or not all pass")
    gpu = report(tag, "gpu-smoke-report.json")
    if not gpu or gpu.get("pass") is not True:
        reasons.append("gpu-smoke-report.json (postmerge GPU smoke) is missing or not all pass")
    open_blockers = blockers()
    if open_blockers:
        reasons.append("open P1/release-blocker issues: " + "; ".join(open_blockers[:5]))

    manual_only = version < MANUAL_BELOW
    if event == "workflow_dispatch":
        environment = "stable-approval"
    else:
        environment = "stable"
        if manual_only:
            reasons.append(f"{tag} is below v0.5.0: the user promotes it by hand")
        if not published or now - published < WAIT:
            age = (now - published) if published else dt.timedelta(0)
            reasons.append(f"published {age.total_seconds() / 3600:.1f} h ago; automatic promotion waits 48 h")

    return {"eligible": not reasons, "tag": tag, "environment": environment, "reasons": reasons}


def scan_candidates() -> list[str]:
    rows = json.loads(gh("release", "list", "--repo", REPO, "--limit", "20", "--json",
                         "tagName,isPrerelease,isDraft"))
    return [r["tagName"] for r in rows if r["isPrerelease"] and not r["isDraft"] and SEMVER.match(r["tagName"])
            and not SEMVER.match(r["tagName"]).group(4)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag")
    parser.add_argument("--scan", action="store_true")
    parser.add_argument("--event", required=True)
    args = parser.parse_args()
    now = dt.datetime.now(dt.timezone.utc)

    if args.tag:
        result = evaluate(args.tag, args.event, now)
    else:
        result = {"eligible": False, "tag": "", "environment": "", "reasons": ["no stable-version prerelease is waiting"]}
        for tag in scan_candidates():
            result = evaluate(tag, args.event, now)
            if result["eligible"]:
                break

    print(json.dumps(result, indent=2))
    if "GITHUB_OUTPUT" in os.environ:
        with open(os.environ["GITHUB_OUTPUT"], "a") as out:
            out.write(f"eligible={'true' if result['eligible'] else 'false'}\n")
            out.write(f"tag={result['tag']}\n")
            out.write(f"environment={result['environment']}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
