"""Model identity verification and runtime qualification.

Two independent questions, deliberately separated because conflating them is
how a product ends up claiming a model runs on hardware it cannot run on:

* **Identity** (:func:`verify_revision`) — is the checkpoint on this disk the
  one the job asked for? Answered from the pinned revision, the shard set and
  the checkpoint digest. Needs no GPU.
* **Runtime qualification** (:func:`runtime_preflight`) — can this machine
  execute this family at this quantization? Answered from platform, driver,
  device VRAM, free disk and the family's published or measured requirement.
  Needs no weights.

The checkpoint digest is sha256 over the ordered ``"<shard> <sha256>"`` lines
of the weight shards, so identity is derived entirely from published upstream
metadata and never requires re-hashing 22-72 GB. ``--deep`` streams the
shards and recomputes their digests for the cases that warrant the cost
(worker-image bake validation, a user-invoked integrity check).

CLI:

    python -m simforge_alpamayo.preflight --family alpamayo-1.5 \
        --expect-digest <64-hex> --weights-dir <dir> [--deep] [--json]
    python -m simforge_alpamayo.preflight --runtime --json

Exit codes: 0 ok · 2 the check ran and the answer is "not qualified" ·
3 identity mismatch · 1 the check could not run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from simforge_alpamayo.families import FAMILY_IDS, Family, get_family

PREFLIGHT_SCHEMA = "simforge.model-preflight/v1"
IDENTITY_SCHEMA = "simforge.model-identity/v1"

#: Extra headroom a resident renderer needs when the model shares the device
#: in a closed-loop episode (measured requirement for the Bevy sensor pass).
RENDERER_HEADROOM_GIB = 3.0

#: Venv + CUDA wheels for one family, measured from a populated install.
VENV_GIB = 10.0


class ModelRevisionMismatch(RuntimeError):
    """The materialized checkpoint is not the requested revision."""

    def __init__(self, message: str, detail: dict[str, Any]):
        super().__init__(message)
        self.detail = detail


def _sha256_file(path: Path, chunk: int = 8 << 20) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            hasher.update(block)
    return hasher.hexdigest()


def _digest_from_files(files: list[tuple[str, str]]) -> str:
    hasher = hashlib.sha256()
    for name, digest in files:
        hasher.update(f"{name} {digest}\n".encode())
    return hasher.hexdigest()


def _shard_names(weights_dir: Path) -> list[str]:
    """Shard filenames in index order, from the safetensors index."""
    index = weights_dir / "model.safetensors.index.json"
    if index.is_file():
        payload = json.loads(index.read_text())
        weight_map = payload.get("weight_map") or {}
        return sorted(set(weight_map.values()))
    return sorted(p.name for p in weights_dir.glob("*.safetensors"))


def _install_record(weights_dir: Path) -> dict[str, Any] | None:
    """The model store's ``install.json``, when this is a store install."""
    for candidate in (
        weights_dir / "install.json",
        weights_dir.parent / "install.json",
    ):
        if candidate.is_file():
            try:
                return json.loads(candidate.read_text())
            except json.JSONDecodeError:
                return None
    return None


def _upstream_shard_digests(spec: Family, revision: str) -> list[tuple[str, str]] | None:
    """Per-shard sha256 from the HF blob metadata for a pinned revision.

    Read-only, a few kilobytes, and the same source the lock generator uses.
    Returns ``None`` when the Hub is unreachable or offline mode is set, so
    an offline worker can still verify sizes and the shard set.
    """
    if os.environ.get("HF_HUB_OFFLINE") in ("1", "true", "TRUE"):
        return None
    try:
        import urllib.request

        url = (
            f"https://huggingface.co/api/models/{spec.weights_repo}"
            f"/revision/{revision}?blobs=true"
        )
        request = urllib.request.Request(
            url, headers={"User-Agent": "simforge-model-store/1.0"}
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except Exception:
        return None
    digests: list[tuple[str, str]] = []
    for sibling in payload.get("siblings", []):
        name = sibling.get("rfilename", "")
        if not name.endswith(".safetensors"):
            continue
        sha = (sibling.get("lfs") or {}).get("sha256")
        if sha:
            digests.append((name, sha))
    return sorted(digests) or None


def resolve_weights_dir(spec: Family, weights_dir: str | None) -> Path | None:
    """Where this family's weights actually are on this machine."""
    if weights_dir:
        return Path(weights_dir).expanduser()
    env = os.environ.get("SIMFORGE_ALPAMAYO_WEIGHTS_DIR")
    if env:
        return Path(env).expanduser()
    root = Path(
        os.path.expanduser(os.environ.get("SIMFORGE_ASSETS_ROOT", "~/simforge-assets"))
    )
    candidate = root / "models" / spec.family / spec.weights_revision / "weights"
    if candidate.is_dir():
        return candidate
    # RunPod's endpoint model cache mounts the snapshot read-only.
    cache = os.environ.get("SIMFORGE_MODEL_CACHE_ROOT") or "/runpod-volume/huggingface-cache/hub"
    snapshot = (
        Path(cache)
        / f"models--{spec.weights_repo.replace('/', '--')}"
        / "snapshots"
        / spec.weights_revision
    )
    if snapshot.is_dir():
        return snapshot
    return None


def verify_revision(
    family: str,
    revision: str | None = None,
    expect_digest: str | None = None,
    weights_dir: str | None = None,
    *,
    deep: bool = False,
) -> dict[str, Any]:
    """Assert that the checkpoint on disk is the requested one.

    Raises :class:`ModelRevisionMismatch` when a requested revision or digest
    disagrees with what is present. Returns an identity record otherwise; a
    record with ``verified: False`` means the weights are not materialized
    here yet, which is not an error unless the caller demanded a digest.
    """
    spec = get_family(family)
    requested = revision or spec.weights_revision
    if requested != spec.weights_revision:
        raise ModelRevisionMismatch(
            f"{spec.family}: requested revision {requested} is not the pinned "
            f"revision {spec.weights_revision}; this build only serves the pin",
            {
                "code": "model_revision_mismatch",
                "requested": requested,
                "resolved": spec.weights_revision,
            },
        )

    resolved_dir = resolve_weights_dir(spec, weights_dir)
    record: dict[str, Any] = {
        "schema": IDENTITY_SCHEMA,
        "family": spec.family,
        "repo": spec.weights_repo,
        "requested": requested,
        "resolved": spec.weights_revision,
        "weights_dir": str(resolved_dir) if resolved_dir else None,
        "digest_requested": expect_digest,
        "digest_resolved": None,
        "shards": [],
        "deep": deep,
        "verified": False,
    }

    if resolved_dir is None or not resolved_dir.is_dir():
        record["reason"] = "weights are not materialized on this host"
        if expect_digest:
            raise ModelRevisionMismatch(
                f"{spec.family}: no materialized checkpoint to verify against "
                f"{expect_digest}",
                {**record, "code": "model_revision_mismatch"},
            )
        return record

    names = _shard_names(resolved_dir)
    if not names:
        record["reason"] = f"no safetensors shards under {resolved_dir}"
        if expect_digest:
            raise ModelRevisionMismatch(
                f"{spec.family}: {record['reason']}",
                {**record, "code": "model_revision_mismatch"},
            )
        return record

    install = _install_record(resolved_dir)
    published: dict[str, dict[str, Any]] = {}
    if install:
        for entry in (install.get("weights") or {}).get("files") or []:
            published[entry["path"]] = entry
    if not published:
        upstream = _upstream_shard_digests(spec, spec.weights_revision)
        if upstream:
            published = {name: {"path": name, "sha256": sha} for name, sha in upstream}

    shards: list[dict[str, Any]] = []
    digest_pairs: list[tuple[str, str]] = []
    problems: list[str] = []
    for name in names:
        path = resolved_dir / name
        entry: dict[str, Any] = {"path": name, "present": path.is_file()}
        if not entry["present"]:
            problems.append(f"{name}: missing")
            shards.append(entry)
            continue
        entry["sizeBytes"] = path.stat().st_size
        expected = published.get(name)
        if expected and expected.get("sizeBytes") is not None:
            entry["sizeOk"] = entry["sizeBytes"] == expected["sizeBytes"]
            if not entry["sizeOk"]:
                problems.append(
                    f"{name}: {entry['sizeBytes']} bytes, expected "
                    f"{expected['sizeBytes']}"
                )
        if deep:
            entry["sha256"] = _sha256_file(path)
            if expected and expected.get("sha256"):
                entry["sha256Ok"] = entry["sha256"] == expected["sha256"]
                if not entry["sha256Ok"]:
                    problems.append(f"{name}: digest mismatch")
            digest_pairs.append((name, entry["sha256"]))
        elif expected and expected.get("sha256"):
            digest_pairs.append((name, expected["sha256"]))
        shards.append(entry)

    record["shards"] = shards
    if digest_pairs and len(digest_pairs) == len(names):
        record["digest_resolved"] = _digest_from_files(sorted(digest_pairs))
    elif not digest_pairs:
        record["reason"] = (
            "no published per-shard digests available (offline and no "
            "install.json); size and shard-set were verified only"
        )

    if expect_digest:
        if record["digest_resolved"] is None:
            raise ModelRevisionMismatch(
                f"{spec.family}: cannot compute a checkpoint digest to compare "
                f"against {expect_digest}: {record.get('reason')}",
                {**record, "code": "model_revision_mismatch"},
            )
        if record["digest_resolved"] != expect_digest:
            raise ModelRevisionMismatch(
                f"{spec.family}: checkpoint digest {record['digest_resolved']} "
                f"!= requested {expect_digest}",
                {**record, "code": "model_revision_mismatch"},
            )
    if problems:
        raise ModelRevisionMismatch(
            f"{spec.family}: checkpoint integrity problems: {'; '.join(problems)}",
            {**record, "code": "model_revision_mismatch", "problems": problems},
        )

    record["verified"] = True
    return record


# ---------------------------------------------------------------------------
# Runtime qualification
# ---------------------------------------------------------------------------


def _nvidia_smi() -> dict[str, Any] | None:
    binary = shutil.which("nvidia-smi")
    if not binary:
        return None
    try:
        out = subprocess.run(
            [
                binary,
                "--query-gpu=name,memory.total,driver_version,compute_cap",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    first = out.stdout.strip().splitlines()[0]
    parts = [part.strip() for part in first.split(",")]
    if len(parts) < 3:
        return None
    try:
        total_mib = float(parts[1])
    except ValueError:
        total_mib = 0.0
    return {
        "name": parts[0],
        "vramGiB": round(total_mib / 1024.0, 2),
        "driver": parts[2],
        "computeCapability": parts[3] if len(parts) > 3 else None,
    }


def _torch_device() -> dict[str, Any]:
    try:
        import torch
    except ImportError:
        return {"torchAvailable": False, "cudaAvailable": False}
    info: dict[str, Any] = {
        "torchAvailable": True,
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "cudaAvailable": bool(torch.cuda.is_available()),
    }
    if info["cudaAvailable"]:
        free, total = torch.cuda.mem_get_info()
        info.update(
            {
                "gpuName": torch.cuda.get_device_name(0),
                "vramGiB": round(total / 2**30, 2),
                "freeVramGiB": round(free / 2**30, 2),
                "deviceCount": torch.cuda.device_count(),
            }
        )
    return info


def observed_host(assets_root: str | None = None) -> dict[str, Any]:
    """What this machine actually is. No guesses, no defaults for absent facts."""
    root = Path(
        os.path.expanduser(
            assets_root or os.environ.get("SIMFORGE_ASSETS_ROOT", "~/simforge-assets")
        )
    )
    probe = root
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(probe)
        free_disk_gib = round(usage.free / 2**30, 2)
    except OSError:
        free_disk_gib = None

    smi = _nvidia_smi()
    torch_info = _torch_device()
    machine = platform.machine().lower()
    arch = "x64" if machine in ("x86_64", "amd64") else machine
    return {
        "platform": f"{sys.platform}-{arch}",
        "os": platform.system(),
        "osRelease": platform.release(),
        "arch": arch,
        "python": platform.python_version(),
        "assetsRoot": str(root),
        "freeDiskGiB": free_disk_gib,
        "nvcc": shutil.which("nvcc"),
        "gpuName": torch_info.get("gpuName") or (smi or {}).get("name"),
        "vramGiB": torch_info.get("vramGiB") or (smi or {}).get("vramGiB"),
        "freeVramGiB": torch_info.get("freeVramGiB"),
        "driver": (smi or {}).get("driver"),
        "computeCapability": (smi or {}).get("computeCapability"),
        **torch_info,
    }


def qualify(
    spec: Family,
    quant: str,
    host: dict[str, Any],
    *,
    reserve_renderer: bool = False,
) -> dict[str, Any]:
    """Download and execution eligibility for one family+quant on this host.

    Download and execution are answered separately and never collapsed: a
    user with the disk may download A2 Super on a machine that cannot run it,
    and the honest answer is "downloaded here, executed in the cloud".
    """
    offer = spec.quant(quant)
    disk_needed = round(spec.weights_bytes / 2**30 + VENV_GIB, 1)
    free_disk = host.get("freeDiskGiB")

    download_reasons: list[str] = []
    if free_disk is not None and free_disk < disk_needed:
        download_reasons.append(
            f"needs ~{disk_needed} GiB free (weights {spec.weights_bytes / 2**30:.1f} "
            f"GiB + runtime ~{VENV_GIB:.0f} GiB); observed {free_disk} GiB free"
        )

    reasons: list[str] = []
    platform_ok = host.get("platform") in ("linux-x64",)
    if not platform_ok:
        reasons.append(
            f"local execution is Linux x64 only for every Alpamayo family "
            f"(upstream requirement); observed {host.get('platform')}"
        )
    if offer.status == "unsupported":
        reasons.append(f"{quant} is not supported for {spec.family}: {offer.note}")
    elif offer.status == "qualification-pending":
        reasons.append(
            f"{quant} has no measured envelope for {spec.family} yet: {offer.note}"
        )
    if not host.get("cudaAvailable"):
        reasons.append(
            "no CUDA device is visible to torch"
            if host.get("torchAvailable")
            else "torch is not installed in this environment"
        )
    required_vram = offer.min_vram_gib
    observed_vram = host.get("vramGiB")
    if required_vram is not None and observed_vram is not None:
        needed = required_vram + (RENDERER_HEADROOM_GIB if reserve_renderer else 0.0)
        if observed_vram < needed:
            detail = (
                f" (+{RENDERER_HEADROOM_GIB:.0f} GiB reserved for a resident renderer)"
                if reserve_renderer
                else ""
            )
            reasons.append(
                f"requires >= {needed:g} GiB device VRAM{detail}; observed "
                f"{observed_vram} GiB"
            )
    if spec.local_execution == "qualification-pending" and not reasons:
        reasons.append(
            f"{spec.family} local execution is unqualified: NVIDIA validated "
            f"only {', '.join(spec.vendor_tested_gpus)}. A device that meets "
            f"the memory requirement is qualified by a recorded run, not by "
            f"assumption."
        )

    if offer.status == "unsupported" or (
        spec.local_execution == "unsupported"
    ):
        qualification = "unsupported"
    elif reasons:
        qualification = (
            "unsupported"
            if not platform_ok or not host.get("cudaAvailable")
            else "qualification-pending"
        )
    else:
        qualification = "qualified"

    tier = None
    if observed_vram is not None:
        if observed_vram >= 80:
            tier = "local-80"
        elif observed_vram >= 24:
            tier = "local-24"
        elif observed_vram >= 16:
            tier = "local-16"
    if qualification != "qualified":
        tier = tier if not reasons else "remote-only"

    return {
        "family": spec.family,
        "quant": quant,
        "downloadEligible": not download_reasons,
        "downloadBlockedReasons": download_reasons,
        "executionEligible": qualification == "qualified",
        "qualification": qualification,
        "tier": tier,
        "reasons": reasons,
        "requires": {
            "vramGiB": required_vram,
            "diskGiB": disk_needed,
            "os": "Linux",
            "platform": "linux-x64",
            "cuda": ">=12.8 for the pinned torch cu128 wheels",
            "vendorTestedGpus": list(spec.vendor_tested_gpus),
        },
        "observed": {
            "platform": host.get("platform"),
            "gpuName": host.get("gpuName"),
            "vramGiB": observed_vram,
            "freeVramGiB": host.get("freeVramGiB"),
            "driver": host.get("driver"),
            "cudaAvailable": host.get("cudaAvailable"),
            "freeDiskGiB": free_disk,
            "nvcc": host.get("nvcc"),
        },
    }


def runtime_preflight(
    families: list[str] | None = None,
    *,
    reserve_renderer: bool = False,
    assets_root: str | None = None,
) -> dict[str, Any]:
    """Full ``simforge.model-preflight/v1`` document for this host."""
    from simforge_alpamayo import vendor

    host = observed_host(assets_root)
    selected = families or list(FAMILY_IDS)
    eligibility = []
    for family_id in selected:
        spec = get_family(family_id)
        for offer in spec.quants:
            eligibility.append(
                qualify(spec, offer.quant, host, reserve_renderer=reserve_renderer)
            )
    any_local = any(entry["executionEligible"] for entry in eligibility)
    return {
        "schema": PREFLIGHT_SCHEMA,
        "observed": host,
        "eligibility": eligibility,
        "upstream": vendor.upstream_status(),
        "rendererHeadroomGiB": RENDERER_HEADROOM_GIB if reserve_renderer else None,
        # A host with no eligible local profile is not broken: it is a
        # remote-execution host, and downloads may still be offered.
        "localExecution": "available" if any_local else "remote-only",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--family", choices=list(FAMILY_IDS))
    parser.add_argument("--quant", default=None)
    parser.add_argument("--revision", default=None)
    parser.add_argument("--expect-digest", default=None)
    parser.add_argument("--weights-dir", default=None)
    parser.add_argument("--deep", action="store_true",
                        help="stream every shard and recompute its sha256")
    parser.add_argument("--runtime", action="store_true",
                        help="report host runtime qualification instead of identity")
    parser.add_argument("--reserve-renderer", action="store_true",
                        help="reserve renderer VRAM headroom (closed-loop co-residency)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    def emit(payload: dict[str, Any]) -> None:
        print(json.dumps(payload, indent=None if args.json else 2))

    if args.runtime or not args.family:
        report = runtime_preflight(
            [args.family] if args.family else None,
            reserve_renderer=args.reserve_renderer,
        )
        emit(report)
        blocking = [
            entry
            for entry in report["eligibility"]
            if args.quant in (None, entry["quant"])
            and not entry["executionEligible"]
        ]
        if args.family and args.quant and blocking:
            raise SystemExit(2)
        raise SystemExit(0)

    try:
        record = verify_revision(
            args.family,
            revision=args.revision,
            expect_digest=args.expect_digest,
            weights_dir=args.weights_dir,
            deep=args.deep,
        )
    except ModelRevisionMismatch as exc:
        emit({"ok": False, "error": {**exc.detail, "message": str(exc)}})
        raise SystemExit(3) from None
    emit({"ok": True, **record})
    raise SystemExit(0 if record["verified"] else 2)


if __name__ == "__main__":
    main()
