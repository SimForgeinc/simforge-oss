"""``simforge-oss-physics`` command line.

    simforge-oss-physics capabilities [--warp] [--no-probe]
    simforge-oss-physics qualify [--warp] [--out report.json]
    simforge-oss-physics rollout --seed N [--decisions K] [--torque NM]
                                 [--start approach|ramp|plateau] [--scene-state out.json]
    simforge-oss-physics job --params params.json --out-dir DIR [--resume checkpoint.json]
    simforge-oss-physics course --out-dir DIR [--profile sensor|cinematic]
    simforge-oss-physics mjcf [--out model.xml]
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Sequence

import numpy as np

from .capabilities import cpu_capabilities, warp_capabilities
from .job import episode_summary, run_job
from .types import ResetOptions
from .workload import ACTION_SIZE, Workload


def _emit(doc: dict, out: str | None) -> None:
    text = json.dumps(doc, indent=2, sort_keys=True)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(out)
    else:
        print(text)


def cmd_capabilities(args: argparse.Namespace) -> int:
    workload = Workload()
    doc = {"cpu": cpu_capabilities(workload)}
    if args.warp:
        doc["warp"] = warp_capabilities(workload, probe_device=not args.no_probe)
    _emit(doc, args.out)
    return 0


def cmd_qualify(args: argparse.Namespace) -> int:
    from .qualification import run_qualification

    report = run_qualification(Workload(), warp=args.warp)
    _emit(report, args.out)
    failed = [c["name"] for c in report["checks"] if c["status"] == "fail"]
    if failed:
        print("FAILED gates: " + ", ".join(failed), file=sys.stderr)
    if report["not_run"]:
        print("not run: " + ", ".join(report["not_run"]), file=sys.stderr)
    return 1 if failed else 0


def cmd_rollout(args: argparse.Namespace) -> int:
    from .cpu import MuJoCoCpuSession

    session = MuJoCoCpuSession(Workload())
    res = session.reset(args.seed, ResetOptions(start=args.start))
    total_reward = 0.0
    for _ in range(args.decisions):
        res = session.step(np.full(ACTION_SIZE, args.torque))
        total_reward += res.reward
        if res.done:
            break
    doc = session.export_scene_state()
    summary = episode_summary(args.seed, session.workload, res, total_reward, doc)
    if args.scene_state:
        with open(args.scene_state, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, sort_keys=True, separators=(",", ":"))
        summary["scene_state_path"] = args.scene_state
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def cmd_mjcf(args: argparse.Namespace) -> int:
    workload = Workload()
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(workload.mjcf)
        print(args.out)
    else:
        print(workload.mjcf, end="")
    return 0


def cmd_course(args: argparse.Namespace) -> int:
    """Materialise the course GLB + manifest and print the absolute-path
    renderer SceneSpec ready for ``native-render-service`` prewarm."""
    from pathlib import Path

    from .course_asset import render_scene_spec, write_course_resources

    out_dir = Path(args.out_dir)
    manifest = write_course_resources(Workload(), out_dir)
    spec = render_scene_spec(manifest, out_dir, profile=args.profile)
    _emit({"manifest": manifest, "sceneSpec": spec}, args.out)
    return 0



def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="simforge-oss-physics", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("capabilities", help="backend capability report")
    p.add_argument("--warp", action="store_true", help="include the mujoco-warp report")
    p.add_argument("--no-probe", action="store_true", help="do not initialise Warp / enumerate devices")
    p.add_argument("--out")
    p.set_defaults(func=cmd_capabilities)

    p = sub.add_parser("qualify", help="run the qualification gates and write the report")
    p.add_argument("--warp", action="store_true", help="also run the mujoco-warp gates")
    p.add_argument("--out")
    p.set_defaults(func=cmd_qualify)

    p = sub.add_parser("rollout", help="constant-torque CPU episode with scene-state export")
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--decisions", type=int, default=400)
    p.add_argument("--torque", type=float, default=1.0, help="per-wheel torque N*m")
    p.add_argument("--start", choices=("approach", "ramp", "plateau"), default="approach")
    p.add_argument("--scene-state", help="write scene-state.v1 JSON here")
    p.set_defaults(func=cmd_rollout)

    p = sub.add_parser("job", help="runner workload simforge.articulated-mujoco/v1 (JSONL events, checkpoints)")
    p.add_argument("--params", required=True, help="JSON params file")
    p.add_argument("--out-dir", required=True)
    p.add_argument("--resume", help="checkpoint JSON written by a previous run")
    p.set_defaults(func=lambda a: run_job(a.params, a.out_dir, a.resume))

    p = sub.add_parser("mjcf", help="print the generated MJCF model")
    p.add_argument("--out")
    p.set_defaults(func=cmd_mjcf)

    p = sub.add_parser("course", help="write the course GLB/manifest and print the renderer SceneSpec")
    p.add_argument("--out-dir", required=True, help="resource directory; writes course/<sha256>.glb and course/manifest.json")
    p.add_argument("--profile", choices=("sensor", "cinematic"), default="sensor")
    p.add_argument("--out", help="write the JSON summary here instead of stdout")
    p.set_defaults(func=cmd_course)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
