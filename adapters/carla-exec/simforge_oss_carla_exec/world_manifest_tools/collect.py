"""Read-only collectors for the world manifest inputs.

Every collector only lists, hashes and copies files out; none of them writes to
the source of truth. Remote hosts are reached over SSH exactly as an operator
would (``ssh <host> <command>``), so the collectors need no credentials of
their own.

Input directory layout (what ``generate`` consumes)::

    <inputs>/nas.json                      files of every source folder
    <inputs>/nas/<folder>/<file>.xodr      byte copies of the source XODRs
    <inputs>/cooked.json                   cooked image identity + worlds
    <inputs>/cooked/<World>.xodr           byte copies of the cooked XODRs
    <inputs>/simforge-<env>.json           SimForge map assets/versions per env
                                           (written by the SimCloud exporter)
"""
from __future__ import annotations

import hashlib
import json
import shlex
import subprocess
from pathlib import Path
from typing import Callable, Sequence

Runner = Callable[[Sequence[str]], bytes]


def local_runner(argv: Sequence[str]) -> bytes:
    return subprocess.run(list(argv), check=True, capture_output=True).stdout


def ssh_runner(host: str) -> Runner:
    def run(argv: Sequence[str]) -> bytes:
        remote = " ".join(shlex.quote(a) for a in argv)
        return subprocess.run(
            ["ssh", "-o", "BatchMode=yes", host, remote], check=True, capture_output=True,
        ).stdout
    return run


def collect_nas(run: Runner, root: str, out: Path, *, sudo: bool, previous: dict | None = None,
                label: str = "nas") -> dict:
    """List + hash every file under ``root/<folder>/``; copy the XODRs.

    GLBs are gigabytes on NFS: when ``previous`` (an earlier nas.json) has the
    same path, size and mtime, its sha256 is reused instead of re-reading.
    """
    prefix = ["sudo", "-n"] if sudo else []
    listing = run(prefix + ["find", root, "-mindepth", "2", "-maxdepth", "2", "-type", "f",
                            "-printf", r"%P\t%s\t%TY-%Tm-%TdT%TH:%TM:%TSZ\n"]).decode()
    # fallback-ok: offline collector: no previous listing means nothing to reuse; every file is hashed
    prior = {f["path"]: f for f in (previous or {}).get("files", [])}
    files = []
    for line in sorted(filter(None, listing.splitlines())):
        rel, size, mtime = line.split("\t")
        folder, name = rel.split("/", 1)
        entry = {"path": rel, "folder": folder, "name": name, "bytes": int(size), "mtime": mtime}
        old = prior.get(rel)
        if old and old.get("bytes") == entry["bytes"] and old.get("mtime") == mtime and old.get("sha256"):
            entry["sha256"] = old["sha256"]
        elif name.lower().endswith((".xodr", ".json")):
            data = run(prefix + ["cat", f"{root}/{rel}"])
            entry["sha256"] = hashlib.sha256(data).hexdigest()
            target = out / label / folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        else:
            entry["sha256"] = run(prefix + ["sha256sum", f"{root}/{rel}"]).decode().split()[0]
        if name.lower().endswith((".xodr", ".json")) and not (out / label / folder / name).exists():
            data = run(prefix + ["cat", f"{root}/{rel}"])
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise RuntimeError(f"{rel} changed while it was being collected")
            (out / label / folder).mkdir(parents=True, exist_ok=True)
            (out / label / folder / name).write_bytes(data)
        files.append(entry)
    doc = {"schema": "simforge.carla-world-manifest.nas/v1", "root": root, "files": files}
    (out / f"{label}.json").write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    return doc


def collect_cooked(run: Runner, container: str, image: str, out: Path) -> dict:
    """Identity of the cooked image and every world it ships (``docker exec``
    into an already-running container of that image; nothing is started)."""
    home = "/home/carla"
    image_id = run(["docker", "image", "inspect", image, "--format", "{{.Id}}"]).decode().strip()
    repo_digests = json.loads(run(["docker", "image", "inspect", image, "--format", "{{json .RepoDigests}}"]))
    container_image = run(["docker", "inspect", container, "--format", "{{.Image}}"]).decode().strip()
    if container_image != image_id:
        raise RuntimeError(f"container {container} runs {container_image}, not {image} ({image_id})")
    version = run(["docker", "exec", container, "cat", f"{home}/VERSION"]).decode()
    binary = run(["docker", "exec", container, "sha256sum",
                  f"{home}/CarlaUnreal/Binaries/Linux/CarlaUnreal-Linux-Shipping"]).decode().split()[0]
    maps_dir = f"{home}/CarlaUnreal/Content/Carla/Maps"
    umaps = sorted(
        name[:-5] for name in run(["docker", "exec", container, "ls", maps_dir]).decode().split()
        if name.endswith(".umap")
    )
    xodrs = sorted(
        name[:-5] for name in run(["docker", "exec", container, "ls", f"{maps_dir}/OpenDrive"]).decode().split()
        if name.endswith(".xodr")
    )
    worlds = {}
    (out / "cooked").mkdir(parents=True, exist_ok=True)
    for world in umaps:
        if world not in xodrs:
            continue
        data = run(["docker", "exec", container, "cat", f"{maps_dir}/OpenDrive/{world}.xodr"])
        (out / "cooked" / f"{world}.xodr").write_bytes(data)
        worlds[world] = {"xodrSha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    doc = {
        "schema": "simforge.carla-world-manifest.cooked/v1",
        "image": image, "imageId": image_id, "repoDigests": sorted(repo_digests),
        "engineBinarySha256": binary,
        "version": {k.strip(): v.strip() for k, v in
                    (line.split(":", 1) for line in version.splitlines() if ":" in line)},
        "worlds": worlds,
        "umapsWithoutXodr": sorted(set(umaps) - set(xodrs)),
    }
    (out / "cooked.json").write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    return doc
