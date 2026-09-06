"""``simforge-oss-splat`` command line.

  capabilities [--no-probe] [--out F]   prerequisite/capability report as JSON
  job --params P --out-dir D [--resume C]   durable render workload simforge.render-bundle-nurec/v1
  service ...                               interactive V5 socket service (host shm ring)

``capabilities`` never renders. With ``--no-probe`` it reports only what is resolvable without
touching CUDA (package version, 3DGRUT root resolution, importable modules); with probing it
also initialises torch/CUDA and imports the tracer, so ``available`` becomes true/false instead
of null. Missing prerequisites are reported, never guessed.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import sys
from typing import Any, Sequence

from . import __version__
from .prerequisites import THREEDGRUT_ENV, CapabilityError, resolve_threedgrut_root


def _dist_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _emit(doc: dict, out: str | None) -> None:
    text = json.dumps(doc, indent=2, sort_keys=True)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(out)
    else:
        print(text)


def capabilities(probe: bool) -> dict[str, Any]:
    from .protocol import (
        JOB_TRANSPORT, PASSES, PROTOCOL_VERSION, RGB_OUTPUT_FORMATS, SERVICE_TRANSPORT, TENSOR_TRANSPORT,
        UNSUPPORTED_OPS, WORKLOAD,
    )

    report: dict[str, Any] = {
        "provider": "simforge-oss-splat",
        "version": __version__,
        "workloads": {WORKLOAD: {"transport": JOB_TRANSPORT, "entry": "simforge-oss-splat job"}},
        "service": {"protocol": PROTOCOL_VERSION, "transport": SERVICE_TRANSPORT, "unsupportedOps": sorted(UNSUPPORTED_OPS)},
        "inProcess": {"module": "simforge_splat.tensor", "transport": TENSOR_TRANSPORT},
        "passes": list(PASSES),
        "rgbOutputFormats": list(RGB_OUTPUT_FORMATS),
        "requires": {
            "torch": {"version": _dist_version("torch"), "cuda": None},
            "kaolin": {"importable": importlib.util.find_spec("kaolin") is not None, "note": "NVIDIA Kaolin for this torch/CUDA; not the PyPI 'kaolin'"},
            "threedgrut": {"root": None, "env": THREEDGRUT_ENV},
            "data": ["NuRec .usdz packages (sha256-pinned)", "imported scene bundles (scenesRoot)", "GLB catalog roots", "hood overlay dir or 'none'"],
        },
        "available": None,
        "reason": "device not probed",
    }
    try:
        report["requires"]["threedgrut"]["root"] = str(resolve_threedgrut_root())
    except CapabilityError as exc:
        report["requires"]["threedgrut"]["error"] = str(exc)
    if not probe:
        return report
    try:
        from .prerequisites import check_render_prerequisites

        found = check_render_prerequisites()
        import torch

        report["requires"]["torch"]["cuda"] = torch.version.cuda
        report["device"] = {"index": torch.cuda.current_device(), "name": torch.cuda.get_device_name(torch.cuda.current_device())}
        report["requires"]["threedgrut"]["root"] = found["threedgrutRoot"]
        report.update({"available": True, "reason": None})
    except CapabilityError as exc:
        report.update({"available": False, "reason": str(exc)})
    except ImportError as exc:
        report.update({"available": False, "reason": f"import failed: {exc}"})
    return report


def cmd_job(args: argparse.Namespace) -> int:
    from .job import run_job

    return run_job(args.params, args.out_dir, args.resume)


def cmd_capabilities(args: argparse.Namespace) -> int:
    _emit(capabilities(probe=not args.no_probe), args.out)
    return 0


def cmd_service(args: argparse.Namespace) -> int:
    from .service import main as service_main

    sys.argv = [f"{sys.argv[0]} service", *args.rest]
    service_main()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="simforge-oss-splat", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("capabilities", help="prerequisite/capability report")
    p.add_argument("--no-probe", action="store_true", help="do not initialise CUDA or import the tracer")
    p.add_argument("--out")
    p.set_defaults(func=cmd_capabilities)

    p = sub.add_parser("job", help="runner workload simforge.render-bundle-nurec/v1 (JSONL events, checkpoints)")
    p.add_argument("--params", required=True, help="JSON params file")
    p.add_argument("--out-dir", required=True)
    p.add_argument("--resume", help="checkpoint JSON written by a previous run")
    p.set_defaults(func=cmd_job)

    p = sub.add_parser("service", help="V5 socket service; remaining arguments are its own (see `service --help`)")
    p.add_argument("rest", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_service)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
