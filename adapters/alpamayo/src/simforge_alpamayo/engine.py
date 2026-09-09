"""Engine base class, quantization recipes and the family engine factory.

One process serves exactly one ``(family, quant)`` pair. The three upstream
packages (``alpamayo_r1``, ``alpamayo1_5``, ``alpamayo2_super``) pin
incompatible dependency sets and must live in separate virtual environments,
so a single process can never hold two families. The factory therefore
imports one engine module lazily and fails with an actionable message when
the environment does not carry that family's upstream package.

Quantization recipes (load-time, reproducible — no serialized artifact):

* ``bf16``: no quantization. The published requirement for A1/A1.5 is a
  >=24 GiB device; A2 is only validated on an 80 GiB H100.
* ``nf4``: bitsandbytes 4-bit NF4 + double quantization, bf16 compute.
  Quantizes every ``nn.Linear`` in the VLM backbone and the diffusion action
  expert; the vision tower, embeddings, ``lm_head``, action projections and
  diffusion head stay bf16 (small and/or sensitive).
* ``fp8``: torchao ``Float8WeightOnlyConfig`` (e4m3) with a wider skip list.

A family only offers a quant its descriptor marks as offered; a mode with
status ``unsupported`` is refused outright, and a mode marked
``qualification-pending`` loads but stamps ``qualification: "pending"`` into
every result's provenance so no measurement is implied that was not made.
"""

from __future__ import annotations

import importlib
import logging
import os
import time
from typing import Any

from simforge_alpamayo.families import Family, get_family
from simforge_alpamayo.obs import (
    MAX_PIXELS,
    MIN_PIXELS,
    ObservationError,
    decode_observation,
)

logger = logging.getLogger("simforge_alpamayo.engine")

# Modules kept un-quantized under NF4 (name fragments matched by the HF
# quantizer plumbing).
SKIP_MODULES = [
    "visual",  # vision tower: sensitive, comparatively small
    "lm_head",
    "embed_tokens",
    "action_in_proj",
    "action_out_proj",
    "diffusion",
]

# FP8 constraints on a 16 GiB card (torchao weight-only fallback dequantizes
# with an fp32 scale expanded to the full weight shape):
# * lm_head MUST stay bf16 — its fp8 dequant would expand a 2.4 GB fp32 scale
#   every forward step.
# * the vision tower IS quantized (unlike NF4) to claw back ~0.6 GB; without
#   it the weights (~13 GB) leave no activation headroom.
FP8_SKIP_MODULES = [
    "lm_head",
    "embed_tokens",
    "action_in_proj",
    "action_out_proj",
    "diffusion",
]


class QuantNotOffered(ValueError):
    """The family does not offer this quantization mode at all."""


def default_hf_home() -> str:
    """Shared HF cache root, so upstream tooling and our store share blobs."""
    return os.path.expanduser(
        os.environ.get(
            "SIMFORGE_HF_HOME",
            os.path.join(
                os.environ.get("SIMFORGE_ASSETS_ROOT", "~/simforge-assets"),
                "hf-cache",
            ),
        )
    )


def prepare_process_env() -> None:
    """Environment every engine process wants, set before torch is imported."""
    os.environ.setdefault("HF_HOME", default_hf_home())
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")


def quant_config(quant: str):
    """Load-time quantization config, or ``None`` for an unquantized load."""
    import torch

    if quant == "nf4":
        from transformers import BitsAndBytesConfig

        return BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
            llm_int8_skip_modules=SKIP_MODULES,
        )
    if quant in ("fp8", "bf16"):
        return None
    raise ValueError(f"unknown quant mode: {quant}")


def apply_fp8(model) -> None:
    """Quantize linears to fp8 e4m3 weight-only, on the model's current device.

    Called while the model is still on CPU: torchao's on-the-fly GPU
    quantization spikes ~2.4 GB transients (scale expansion on lm_head-sized
    tensors) and OOMs a 16 GiB card. CPU quantization is numerically
    identical and the already-quantized model moves to the GPU in one pass.
    """
    import torch.nn as nn
    from torchao.quantization import Float8WeightOnlyConfig, quantize_

    def _filter(module, fqn: str) -> bool:
        return isinstance(module, nn.Linear) and not any(
            skip in fqn for skip in FP8_SKIP_MODULES
        )

    logger.info("quantizing to fp8 (e4m3, weight-only) on CPU...")
    quantize_(model, Float8WeightOnlyConfig(), filter_fn=_filter)


class BaseEngine:
    """Shared engine behaviour: identity, validation, VRAM, provenance.

    Subclasses implement :meth:`load` and :meth:`_infer_trajectories`, and
    optionally :meth:`text`.
    """

    def __init__(
        self,
        family: str,
        quant: str = "bf16",
        device: str = "cuda",
        *,
        weights_dir: str | None = None,
        sidecar_dir: str | None = None,
        checkpoint_digest: str | None = None,
        num_diffusion_steps: int | None = None,
    ):
        self.spec: Family = get_family(family)
        offer = self.spec.quant(quant)
        if offer.status == "unsupported":
            raise QuantNotOffered(
                f"{self.spec.family} does not support quant {quant!r}: {offer.note}"
            )
        self.family = self.spec.family
        self.quant = quant
        self.quant_status = offer.status
        self.device = device
        #: Local install directory holding the weights, when the model store
        #: installed them; ``None`` means resolve through the HF cache.
        self.weights_dir = weights_dir
        #: Read-only directory holding sidecar config/tokenizer files. Set by
        #: the cloud worker image (baked at build time) so no token and no
        #: Hub call is needed at runtime.
        self.sidecar_dir = sidecar_dir or os.environ.get(
            "SIMFORGE_ALPAMAYO_SIDECAR_DIR"
        )
        self.checkpoint_digest = checkpoint_digest
        self.default_diffusion_steps = num_diffusion_steps
        self.model = None
        self.processor = None
        self.warmed = False
        self.load_seconds: float | None = None
        self.attn_implementation = "sdpa"

    # -- identity -----------------------------------------------------------

    @property
    def model_source(self) -> str:
        """What ``from_pretrained`` is pointed at: a local install or the repo."""
        return self.weights_dir or self.spec.weights_repo

    @property
    def revision(self) -> str | None:
        """Pinned revision; ``None`` when loading a local directory.

        A local install directory has no revision to pass: the install was
        materialized from the pinned revision and its identity is asserted by
        ``simforge_alpamayo.preflight``, not by re-declaring it here.
        """
        return None if self.weights_dir else self.spec.weights_revision

    def capabilities(self) -> dict[str, Any]:
        cameras = self.spec.cameras
        return {
            "cameras": {
                "required": list(cameras.required) if cameras.required else None,
                "variable": cameras.variable,
                "default": list(cameras.default),
                "vqa": list(cameras.vqa) if cameras.vqa else None,
                "max": cameras.max_cameras,
                "maxCameras": cameras.max_cameras,
            },
            **self.spec.capabilities.as_dict(),
            "textTasks": list(self.spec.text_tasks),
        }

    def supports(self) -> list[str]:
        ops = ["act"] if self.spec.capabilities.trajectory else []
        if self.spec.text_tasks:
            ops.append("text")
        return ops

    def info(self) -> dict[str, Any]:
        """The ``hello`` / ``GET /healthz`` document."""
        import torch

        return {
            "service": "simforge-alpamayo",
            "schema": "simforge.policy-endpoint/v2",
            "family": self.family,
            "display_name": self.spec.display_name,
            "revision": self.spec.weights_revision,
            "code_revision": self.spec.code_revision,
            "checkpoint_digest": self.checkpoint_digest,
            "quant": self.quant,
            "quant_status": self.quant_status,
            "loaded": self.model is not None,
            "status": "ok" if self.model is not None else "loading",
            "warmed": self.warmed,
            "load_seconds": self.load_seconds,
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
            "attn": self.attn_implementation,
            "gpu": (
                torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
            ),
            "capabilities": self.capabilities(),
            "camera_profile": self.camera_profile(),
            "supports": self.supports(),
            "horizon_s": 6.4,
            "dt_s": 0.1,
            "num_history_steps": 16,
            "num_frames_per_camera": 4,
            "vram": self.vram(),
        }

    def camera_profile(self) -> str | None:
        """Rig-preset id matching this family's default camera set."""
        from simforge_alpamayo.bridge import profile_for_camera_ids

        return profile_for_camera_ids(self.spec.cameras.default)

    # -- inference ----------------------------------------------------------

    def decode(self, obs: dict[str, Any], task: str = "act") -> dict[str, Any]:
        """Validate and decode one observation against this family's contract."""
        required, variable = self.spec.camera_contract(task)
        decoded = decode_observation(
            obs,
            required_cameras=required,
            variable_cameras=variable,
            family=self.family,
            task=task,
            max_cameras=self.spec.cameras.max_cameras,
        )
        if decoded["exploratory_video"] and task == "act":
            decoded["selection"] = "exploratory-uploaded-cameras"
        return decoded

    def act(
        self,
        obs: dict[str, Any],
        seed: int = 0,
        top_p: float = 0.98,
        temperature: float = 0.6,
        num_traj_samples: int = 1,
        max_generation_length: int = 256,
        num_diffusion_steps: int | None = None,
        **_ignored: Any,
    ) -> dict[str, Any]:
        """Run one open- or closed-loop step: observation -> trajectory."""
        import torch

        if self.model is None:
            raise RuntimeError("engine not loaded")
        if not self.spec.capabilities.trajectory:
            raise ObservationError(
                "unsupported_op",
                f"{self.family} does not produce trajectories",
            )

        timings: dict[str, float] = {}
        t_start = time.monotonic()
        decoded = self.decode(obs, task="act")
        steps = num_diffusion_steps if num_diffusion_steps is not None else (
            self.default_diffusion_steps
        )

        # Deterministic seeding: generation and diffusion noise both consume
        # the global RNG streams.
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)

        prepared = self._prepare_inputs(decoded)
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        timings["preprocess_ms"] = (time.monotonic() - t_start) * 1e3

        t_infer = time.monotonic()
        traj, rotations, reasoning = self._infer_trajectories(
            prepared,
            top_p=top_p,
            temperature=temperature,
            num_traj_samples=num_traj_samples,
            max_generation_length=max_generation_length,
            num_diffusion_steps=steps,
        )
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        timings["inference_ms"] = (time.monotonic() - t_infer) * 1e3
        timings["total_ms"] = (time.monotonic() - t_start) * 1e3
        provenance = self.rng_provenance(
            seed, steps, num_traj_samples, decoded["time_base"]
        )
        selection = decoded.get("selection")
        if selection is not None:
            provenance["input_selection"] = selection
        if decoded["exploratory_video"]:
            provenance["exploratory_video"] = True
            provenance["supplied_camera_ids"] = list(decoded["camera_ids"])


        return {
            "trajectories": traj,
            "trajectory_rot": rotations,
            "horizon_s": 6.4,
            "dt_s": 0.1,
            "frame": "ego@t0",
            "reasoning": reasoning,
            "text": None,
            "fields": None,
            "seed": seed,
            "timings": timings,
            "vram": self.vram(),
            "rng_provenance": provenance,
            "model": self.model_identity(
                decoded["camera_ids"],
                exploratory_video=decoded["exploratory_video"],
            ),
            "cameras": decoded["camera_ids"],
            "frame_size": decoded["frame_size"],
            "time_base": decoded["time_base"],
        }

    def text(
        self,
        obs: dict[str, Any],
        prompt: str | None = None,
        task: str = "vqa",
        seed: int = 0,
        **params: Any,
    ) -> dict[str, Any]:
        """Text-only task. Families without one refuse; none fabricates."""
        raise ObservationError(
            "unsupported_op",
            f"{self.family} has no text capability; supported ops: "
            f"{self.supports()}",
        )

    # -- subclass hooks -----------------------------------------------------

    def load(self) -> None:
        raise NotImplementedError

    def _prepare_inputs(self, decoded: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def _infer_trajectories(
        self,
        prepared: dict[str, Any],
        *,
        top_p: float,
        temperature: float,
        num_traj_samples: int,
        max_generation_length: int,
        num_diffusion_steps: int | None,
    ) -> tuple[list, list | None, list]:
        raise NotImplementedError

    # -- introspection ------------------------------------------------------

    def rng_provenance(
        self,
        seed: int,
        num_diffusion_steps: int | None,
        num_traj_samples: int,
        time_base: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        import torch

        record: dict[str, Any] = {
            "seed": seed,
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
            "attn": self.attn_implementation,
            "quant": self.quant,
            "diffusion_steps": num_diffusion_steps,
            "num_traj_samples": num_traj_samples,
            "device_name": (
                torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
            ),
            "deterministic_algorithms": bool(
                torch.are_deterministic_algorithms_enabled()
            ),
        }
        if self.quant_status != "supported":
            # Never let a pending measurement read as a qualified one.
            record["qualification"] = "pending"
        if time_base:
            record.update(time_base)
        return record

    def model_identity(
        self,
        camera_ids: list[int] | None = None,
        *,
        exploratory_video: bool = False,
    ) -> dict[str, Any]:
        from simforge_alpamayo.bridge import profile_for_camera_ids

        profile = (
            None
            if exploratory_video
            else (
                profile_for_camera_ids(tuple(camera_ids))
                if camera_ids
                else self.camera_profile()
            )
        )
        return {
            "family": self.family,
            "revision": self.spec.weights_revision,
            "quant": self.quant,
            "checkpoint_digest": self.checkpoint_digest,
            "camera_profile": profile,
            "code_revision": self.spec.code_revision,
        }

    def vram(self) -> dict[str, float]:
        import torch

        if not torch.cuda.is_available():
            return {}
        free, total = torch.cuda.mem_get_info()
        return {
            "allocated_mb": torch.cuda.memory_allocated() / 2**20,
            "allocated_mib": torch.cuda.memory_allocated() / 2**20,
            "reserved_mb": torch.cuda.memory_reserved() / 2**20,
            "peak_allocated_mb": torch.cuda.max_memory_allocated() / 2**20,
            "peak_mib": torch.cuda.max_memory_allocated() / 2**20,
            "device_used_mb": (total - free) / 2**20,
            "device_total_mb": total / 2**20,
        }

    def reset_peak(self) -> None:
        import torch

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()

    # -- shared loading helpers --------------------------------------------

    def resolve_sidecar(self, repo: str, revision: str, patterns: list[str]) -> str:
        """Local directory for one sidecar repo's config/tokenizer files.

        Resolution order, deliberate: an explicitly provided read-only
        directory (baked into a worker image, no token, no network), then the
        model store's install layout, then the pinned Hub snapshot. Only the
        last one can require a token, and only for a gated repo.
        """
        if self.sidecar_dir:
            candidate = os.path.join(self.sidecar_dir, repo.replace("/", "--"))
            if os.path.isdir(candidate):
                return candidate
            flat = os.path.join(self.sidecar_dir, repo.split("/")[-1])
            if os.path.isdir(flat):
                return flat
            if os.path.isfile(os.path.join(self.sidecar_dir, "config.json")):
                return self.sidecar_dir
        if self.weights_dir:
            candidate = os.path.join(
                os.path.dirname(self.weights_dir.rstrip("/")),
                "sidecars",
                repo.replace("/", "--"),
            )
            if os.path.isdir(candidate):
                return candidate
        from huggingface_hub import snapshot_download

        return snapshot_download(repo, revision=revision, allow_patterns=patterns)

    def load_processor(self, source: str, tokenizer=None):
        """Pinned image processor at the upstream pixel budget."""
        from transformers import AutoProcessor

        processor = AutoProcessor.from_pretrained(
            source, min_pixels=MIN_PIXELS, max_pixels=MAX_PIXELS
        )
        if tokenizer is not None:
            processor.tokenizer = tokenizer
        return processor


#: Sidecar file patterns for a config/tokenizer-only snapshot.
SIDECAR_PATTERNS = [
    "config.json",
    "generation_config.json",
    "tokenizer*",
    "vocab*",
    "merges*",
    "special_tokens_map.json",
    "preprocessor_config.json",
    "video_preprocessor_config.json",
    "chat_template*",
]


def load_engine(
    family: str,
    quant: str = "bf16",
    device: str = "cuda",
    *,
    weights_dir: str | None = None,
    sidecar_dir: str | None = None,
    checkpoint_digest: str | None = None,
    num_diffusion_steps: int | None = None,
    load: bool = True,
) -> BaseEngine:
    """Construct (and by default load) the engine for one family."""
    spec = get_family(family)
    prepare_process_env()
    try:
        module = importlib.import_module(spec.engine_module)
    except ImportError as exc:  # pragma: no cover - environment plumbing
        raise ImportError(
            f"cannot import {spec.engine_module} for {spec.family}: {exc}"
        ) from exc
    engine_cls = getattr(module, spec.engine_class)
    engine = engine_cls(
        family=spec.family,
        quant=quant,
        device=device,
        weights_dir=weights_dir,
        sidecar_dir=sidecar_dir,
        checkpoint_digest=checkpoint_digest,
        num_diffusion_steps=num_diffusion_steps,
    )
    if load:
        engine.load()
    return engine
