"""``python -m simforge_oss_gpu`` command line.

Subcommands: ``capabilities`` (JSON; ``--probe`` touches the GPU),
``job`` (runner workload, see :mod:`.job`), ``conformance`` and ``qualify``
(qualification tooling, see those modules).
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Sequence


def cmd_capabilities(args: argparse.Namespace) -> int:
    from .capabilities import capabilities

    print(json.dumps(capabilities(probe_device=args.probe), indent=2, sort_keys=True))
    return 0


def cmd_job(args: argparse.Namespace) -> int:
    from .job import run_job

    return run_job(args.params, args.out_dir, args.resume)


def cmd_conformance(args: argparse.Namespace) -> int:
    from .conformance import main

    return main(args.rest)


def cmd_qualify(args: argparse.Namespace) -> int:
    from .qualify import main

    return main(args.rest)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="simforge-oss-gpu", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    cap = sub.add_parser("capabilities", help="profile/numerics/admission report as JSON")
    cap.add_argument("--probe", action="store_true", help="initialise Warp and enumerate CUDA devices")
    cap.add_argument("--no-probe", dest="probe", action="store_false")
    cap.set_defaults(func=cmd_capabilities, probe=False)
    job = sub.add_parser("job", help="runner workload simforge.gpu-batch-rollout/v1")
    job.add_argument("--params", required=True)
    job.add_argument("--out-dir", required=True)
    job.add_argument("--resume")
    job.set_defaults(func=cmd_job)
    for name, func in (("conformance", cmd_conformance), ("qualify", cmd_qualify)):
        p = sub.add_parser(name, help=f"{name} tooling (arguments forwarded)")
        p.add_argument("rest", nargs=argparse.REMAINDER)
        p.set_defaults(func=func)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
