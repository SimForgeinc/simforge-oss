"""CLI: collect inputs (read-only), generate the manifest, derive tables.

  # 1. inputs (read-only: list / hash / copy out)
  python -m simforge_oss_carla_exec.world_manifest_tools collect-nas \\
      --ssh simforge1 --sudo --root /mnt/nas/a100-data/GLB_Map_Export --inputs build/wm
  python -m simforge_oss_carla_exec.world_manifest_tools collect-cooked \\
      --ssh rtx3080-02 --container sf-engine-cook \\
      --image ghcr.io/simforgeinc/carla-rr-maps:0.10.0-prod-graphics --inputs build/wm
  # SimForge side (SimCloud): scripts/carla-world-manifest/export-map-registry.sh dev > build/wm/simforge-dev.json

  # 2. manifest (deterministic; commit the result)
  python -m simforge_oss_carla_exec.world_manifest_tools generate --inputs build/wm

  # 3. derived tables (never hand-edit these either)
  python -m simforge_oss_carla_exec.world_manifest_tools derive --format env
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .. import actor_bindings, world_manifest
from . import collect, generate

DEFAULT_DECISIONS = Path(__file__).parent / "decisions.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m simforge_oss_carla_exec.world_manifest_tools")
    sub = parser.add_subparsers(dest="command", required=True)

    nas = sub.add_parser("collect-nas", help="list, hash and copy the source exports (read-only)")
    nas.add_argument("--ssh", help="host holding the NAS mount (default: local)")
    nas.add_argument("--sudo", action="store_true", help="read with sudo -n (the exports are 0600)")
    nas.add_argument("--root", required=True)
    nas.add_argument("--inputs", required=True, type=Path)
    nas.add_argument("--derived", action="store_true",
                     help="collect a derived tree (e.g. GLB_Map_Export_corrected) as nas-derived")

    cooked = sub.add_parser("collect-cooked", help="identify the cooked image's worlds (read-only)")
    cooked.add_argument("--ssh", help="docker host (default: local)")
    cooked.add_argument("--container", required=True, help="an already-running container of --image")
    cooked.add_argument("--image", required=True)
    cooked.add_argument("--inputs", required=True, type=Path)

    gen = sub.add_parser("generate", help="write the manifest from collected inputs")
    gen.add_argument("--inputs", required=True, type=Path)
    gen.add_argument("--decisions", type=Path, default=DEFAULT_DECISIONS)
    gen.add_argument("--out", type=Path, default=world_manifest.MANIFEST_PATH)
    gen.add_argument("--check", action="store_true", help="fail if --out differs instead of writing it")

    actors = sub.add_parser("actor-bindings", help="write the CARLA actor binding table")
    actors.add_argument("--object-catalog", required=True, type=Path,
                        help="SimCloud config/simforge/carla/carla-object-catalog.json")
    actors.add_argument("--substitutions", type=Path,
                        help="OSS catalog/vehicles-carla/carla-substitutions.json (renderer parity)")
    actors.add_argument("--out", type=Path, default=actor_bindings.TABLE_PATH)
    actors.add_argument("--check", action="store_true")

    derive = sub.add_parser("derive", help="print tables derived from the manifest")
    derive.add_argument("--manifest", type=Path, default=world_manifest.MANIFEST_PATH)
    derive.add_argument("--format", choices=("env", "json", "summary"), default="summary")

    args = parser.parse_args(argv)
    if args.command == "collect-nas":
        run = collect.ssh_runner(args.ssh) if args.ssh else collect.local_runner
        args.inputs.mkdir(parents=True, exist_ok=True)
        label = "nas-derived" if args.derived else "nas"
        previous_path = args.inputs / f"{label}.json"
        previous = json.loads(previous_path.read_text()) if previous_path.exists() else None
        doc = collect.collect_nas(run, args.root, args.inputs, sudo=args.sudo, previous=previous, label=label)
        print(f"{len(doc['files'])} files under {args.root}")
        return 0
    if args.command == "collect-cooked":
        run = collect.ssh_runner(args.ssh) if args.ssh else collect.local_runner
        args.inputs.mkdir(parents=True, exist_ok=True)
        doc = collect.collect_cooked(run, args.container, args.image, args.inputs)
        print(f"{len(doc['worlds'])} cooked worlds in {args.image}")
        return 0
    if args.command == "generate":
        decisions = json.loads(args.decisions.read_text()) if args.decisions.exists() else {}
        decisions = {k: v for k, v in decisions.items() if not k.startswith("$")}
        # fallback-ok: offline CLI: absent optional manifest section or display value
        legacy = json.loads(args.out.read_text()).get("legacySources", []) if args.out.exists() else []
        manifest = generate.generate(args.inputs, decisions, legacy)
        world_manifest.validate(manifest)
        text = generate.dump(manifest)
        if args.check:
            if not args.out.exists() or args.out.read_text() != text:
                print(f"{args.out} is stale; regenerate it", file=sys.stderr)
                return 1
            return 0
        args.out.write_text(text)
        for entry in manifest["maps"]:
            print(f"{entry['status']:20} {entry['sourceFolder']:40} -> {entry.get('carlaWorld')}")
        return 0
    if args.command == "actor-bindings":
        import hashlib
        catalog_bytes = args.object_catalog.read_bytes()
        subs_bytes = args.substitutions.read_bytes() if args.substitutions else None
        table = actor_bindings.generate(
            json.loads(catalog_bytes), hashlib.sha256(catalog_bytes).hexdigest(),
            json.loads(subs_bytes) if subs_bytes else None,
            hashlib.sha256(subs_bytes).hexdigest() if subs_bytes else None,
        )
        text = json.dumps(table, indent=1, sort_keys=True) + "\n"
        actor_bindings.parse(text.encode())
        if args.check:
            return 0 if args.out.exists() and args.out.read_text() == text else 1
        args.out.write_text(text)
        print(f"{len(table['bindings'])} bindings, {len(table['unavailable'])} unavailable -> {args.out} "
              f"(sha256 {hashlib.sha256(text.encode()).hexdigest()})")
        return 0
    if args.command == "derive":
        world_manifest.load.cache_clear()
        manifest = world_manifest.load(str(args.manifest))
        if args.format == "env":
            for key, value in world_manifest.env_values(manifest).items():
                print(f"{key}={value}")
        elif args.format == "json":
            print(json.dumps({
                "cookedMapNames": world_manifest.cooked_map_names(manifest),
                "approvedCookedXodrDigests": {k: sorted(v) for k, v in world_manifest.approved_cooked_digests(manifest).items()},
                "refusals": {k: vars(v) for k, v in world_manifest.refusals(manifest).items()},
            }, indent=1, sort_keys=True))
        else:
            for entry in manifest["maps"]:
                # fallback-ok: offline CLI: absent optional manifest section or display value
                sf = entry.get("simforge", {})
                # fallback-ok: offline CLI: absent optional manifest section or display value
                assets = ",".join(sorted({v["mapAssetId"] for v in sf.values()})) or "-"
                print(f"{entry['status']:20} {entry['sourceFolder']:36} {assets:30} -> {entry.get('carlaWorld')}")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
