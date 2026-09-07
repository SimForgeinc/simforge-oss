"""Alpamayo 1.5 engine (``nvidia/Alpamayo-1.5-10B``, upstream ``alpamayo1_5``).

The checkpoint's ``config.json`` names ``nvidia/Cosmos-Reason2-8B`` as
``vlm_name_or_path``. That repo is gated (``gated: "auto"``, NVIDIA Open
Model License) and supplies only ``config.json`` plus the tokenizer — every
weight comes from the ungated Alpamayo checkpoint. The engine substitutes a
pinned local snapshot of those text files for the repo id, so the load is
reproducible and, when the model store or a worker image has already
materialized them, needs no token and no network at inference time.

Trajectory entrypoint: ``Alpamayo1_5.sample_trajectories_from_data_with_vlm_rollout``.
Text entrypoint: ``ReasoningVLA.generate_text`` with ``helper.create_vqa_message``.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from simforge_alpamayo.engine import (
    SIDECAR_PATTERNS,
    BaseEngine,
    apply_fp8,
    prepare_process_env,
    quant_config,
)
from simforge_alpamayo.obs import ObservationError
from simforge_alpamayo.vendor import require_upstream

logger = logging.getLogger("simforge_alpamayo.engine_a15")

prepare_process_env()


class Alpamayo15Engine(BaseEngine):
    """Long-lived Alpamayo 1.5 inference engine."""

    def load(self) -> None:
        import torch
        from huggingface_hub import hf_hub_download

        t0 = time.monotonic()
        cosmos, processor_repo = self.spec.sidecars
        cosmos_dir = self.resolve_sidecar(
            cosmos.repo, cosmos.revision, SIDECAR_PATTERNS
        )
        proc_dir = self.resolve_sidecar(
            processor_repo.repo, processor_repo.revision, SIDECAR_PATTERNS
        )

        require_upstream(self.spec)
        from alpamayo1_5.config import Alpamayo1_5Config
        from alpamayo1_5.models.alpamayo1_5 import Alpamayo1_5

        if self.weights_dir:
            with open(f"{self.weights_dir}/config.json") as handle:
                cfg_dict = json.load(handle)
        else:
            cfg_path = hf_hub_download(
                self.spec.weights_repo,
                "config.json",
                revision=self.spec.weights_revision,
            )
            with open(cfg_path) as handle:
                cfg_dict = json.load(handle)
        cfg_dict["vlm_name_or_path"] = cosmos_dir
        cfg_dict["attn_implementation"] = self.attn_implementation
        config = Alpamayo1_5Config(**cfg_dict)

        qcfg = quant_config(self.quant)
        kwargs: dict[str, Any] = dict(
            config=config,
            dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
        )
        if self.revision:
            kwargs["revision"] = self.revision
        if qcfg is not None:
            kwargs["quantization_config"] = qcfg
            kwargs["device_map"] = {"": 0}  # whole model on GPU 0 — no offload

        logger.info("loading %s [%s]...", self.model_source, self.quant)
        model = Alpamayo1_5.from_pretrained(self.model_source, **kwargs)
        if self.quant == "fp8":
            apply_fp8(model)
        if qcfg is None and self.device == "cuda":
            model = model.to("cuda")
        model.eval()

        # Invariants: the substituted tokenizer must reproduce the ids baked
        # into the Alpamayo checkpoint. A mismatch means the pinned sidecar
        # drifted, and a silently wrong tokenizer produces plausible garbage.
        tok = model.tokenizer
        if len(tok) != config.vocab_size:
            raise RuntimeError(
                f"tokenizer/checkpoint vocab mismatch: {len(tok)} != "
                f"{config.vocab_size}; sidecar {cosmos.repo}@{cosmos.revision}"
            )
        if tok.convert_tokens_to_ids("<i0>") != config.traj_token_start_idx:
            raise RuntimeError("tokenizer trajectory-token base does not match config")
        for name, tid in config.traj_token_ids.items():
            got = tok.traj_token_ids[name]
            if got != tid:
                raise RuntimeError(f"traj token {name}: {got} != {tid}")

        self.model = model
        self.processor = self.load_processor(proc_dir, tokenizer=tok)
        self.load_seconds = time.monotonic() - t0
        logger.info("model loaded in %.1fs", self.load_seconds)

    # -- inference ----------------------------------------------------------

    def _prepare_inputs(self, decoded: dict[str, Any]) -> dict[str, Any]:
        from alpamayo1_5 import helper

        messages = helper.create_message(
            frames=decoded["frames_flat"],
            camera_indices=decoded["camera_indices"],
            nav_text=decoded["nav_text"],
        )
        return self._tokenize(messages, decoded)

    def _tokenize(self, messages, decoded: dict[str, Any]) -> dict[str, Any]:
        from alpamayo1_5 import helper

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=False,
            continue_final_message=True,
            return_dict=True,
            return_tensors="pt",
        )
        return helper.to_device(
            {
                "tokenized_data": inputs,
                "ego_history_xyz": decoded["ego_history_xyz"],
                "ego_history_rot": decoded["ego_history_rot"],
            },
            self.device,
        )

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
        import torch

        diffusion_kwargs: dict[str, Any] = {}
        if num_diffusion_steps is not None:
            diffusion_kwargs["inference_step"] = int(num_diffusion_steps)

        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            pred_xyz, pred_rot, extra = (
                self.model.sample_trajectories_from_data_with_vlm_rollout(
                    data=prepared,
                    top_p=top_p,
                    temperature=temperature,
                    num_traj_samples=num_traj_samples,
                    max_generation_length=max_generation_length,
                    diffusion_kwargs=diffusion_kwargs,
                    return_extra=True,
                )
            )
        # pred_xyz: (B=1, n_traj_sets=1, n_samples, 64, 3)
        traj = pred_xyz[0, 0].float().cpu().numpy().tolist()
        rotations = pred_rot[0, 0].float().cpu().numpy().tolist() if pred_rot is not None else None
        reasoning = [None if c is None else str(c) for c in extra["cot"][0, 0]]
        return traj, rotations, reasoning

    # -- text ---------------------------------------------------------------

    def text(
        self,
        obs: dict[str, Any],
        prompt: str | None = None,
        task: str = "vqa",
        seed: int = 0,
        **params: Any,
    ) -> dict[str, Any]:
        """Visual question answering. Not a driving evaluation, and labelled so."""
        import torch
        from alpamayo1_5 import helper

        if self.model is None:
            raise RuntimeError("engine not loaded")
        if task not in self.spec.text_tasks:
            raise ObservationError(
                "unsupported_op",
                f"{self.family} supports text tasks {list(self.spec.text_tasks)}; "
                f"got {task!r}",
            )
        if not prompt or not prompt.strip():
            raise ObservationError(
                "missing_fields",
                "text task 'vqa' requires a non-empty question in `prompt`",
                fields=["prompt"],
            )

        t_start = time.monotonic()
        decoded = self.decode(obs, task="text")
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)

        messages = helper.create_vqa_message(
            frames=decoded["frames_flat"],
            question=prompt,
            camera_indices=decoded["camera_indices"],
        )
        prepared = self._tokenize(messages, decoded)
        num_samples = int(params.get("num_samples", 1))
        max_len = int(params.get("max_generation_length", 256))

        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            extra = self.model.generate_text(
                data=prepared,
                top_p=float(params.get("top_p", 0.98)),
                temperature=float(params.get("temperature", 0.6)),
                num_samples=num_samples,
                max_generation_length=max_len,
            )

        answers = extra.get("answer")
        answer = str(answers[0][0]) if answers is not None and len(answers) else ""
        fields = {
            key: [str(v) for v in value[0]] for key, value in extra.items() if key != "answer"
        }
        return {
            "task": task,
            "text": answer,
            "fields": fields or None,
            "trajectories": None,
            "trajectory_rot": None,
            "reasoning": None,
            "seed": seed,
            "timings": {"total_ms": (time.monotonic() - t_start) * 1e3},
            "vram": self.vram(),
            "rng_provenance": self.rng_provenance(
                seed, None, num_samples, decoded["time_base"]
            ),
            "model": self.model_identity(decoded["camera_ids"]),
            "cameras": decoded["camera_ids"],
            "not_a_driving_evaluation": True,
        }
