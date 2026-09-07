"""Alpamayo 1 engine (``nvidia/Alpamayo-R1-10B``, upstream ``alpamayo_r1``).

Differences from 1.5 that this module exists to encode, rather than paper
over:

* The checkpoint's ``config.json`` carries no ``vlm_name_or_path``; upstream
  ``ReasoningVLAConfig`` defaults to ``Qwen/Qwen3-VL-8B-Instruct``, which is
  ungated and Apache-2.0. A1 therefore needs no user token at all.
* ``helper.create_message`` takes only the flattened frames: A1 has no
  camera-name or frame-number prompt section and no navigation conditioning,
  so its message is not the 1.5 message with fields omitted.
* A1 accepts exactly cameras ``[0, 1, 2, 6]``. There is no camera-count
  conditioning, so a different set is refused by the base class rather than
  padded.
* Upstream repository is in limited maintenance; the code commit is pinned.
* No text/VQA capability: ``text`` refuses with ``unsupported_op`` (inherited).

Quantization: the NF4 and FP8 recipes are wired identically to 1.5, but the
family descriptor marks them ``qualification-pending`` because A1's backbone
lineage differs (Qwen3-VL-8B config vs Cosmos-Reason2) and no A1 measurement
exists. Loading a pending mode stamps ``qualification: "pending"`` into the
provenance of every result it produces.
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
from simforge_alpamayo.vendor import require_upstream

logger = logging.getLogger("simforge_alpamayo.engine_a1")

prepare_process_env()


class AlpamayoR1Engine(BaseEngine):
    """Long-lived Alpamayo 1 inference engine."""

    def load(self) -> None:
        import torch
        from huggingface_hub import hf_hub_download

        t0 = time.monotonic()
        backbone, processor_repo = self.spec.sidecars
        backbone_dir = self.resolve_sidecar(
            backbone.repo, backbone.revision, SIDECAR_PATTERNS
        )
        proc_dir = self.resolve_sidecar(
            processor_repo.repo, processor_repo.revision, SIDECAR_PATTERNS
        )

        require_upstream(self.spec)
        from alpamayo_r1.config import AlpamayoR1Config
        from alpamayo_r1.models.alpamayo_r1 import AlpamayoR1

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
        # A1's config omits vlm_name_or_path and would otherwise resolve the
        # upstream default from the Hub unpinned. Pin it to our snapshot.
        cfg_dict["vlm_name_or_path"] = backbone_dir
        cfg_dict["attn_implementation"] = self.attn_implementation
        config = AlpamayoR1Config(**cfg_dict)

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
            kwargs["device_map"] = {"": 0}

        logger.info("loading %s [%s]...", self.model_source, self.quant)
        model = AlpamayoR1.from_pretrained(self.model_source, **kwargs)
        if self.quant == "fp8":
            apply_fp8(model)
        if qcfg is None and self.device == "cuda":
            model = model.to("cuda")
        model.eval()

        tok = model.tokenizer
        if len(tok) != config.vocab_size:
            raise RuntimeError(
                f"tokenizer/checkpoint vocab mismatch: {len(tok)} != "
                f"{config.vocab_size}; sidecar "
                f"{backbone.repo}@{backbone.revision}"
            )
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
        from alpamayo_r1 import helper

        # A1's create_message takes frames only: no camera ids, no nav text.
        messages = helper.create_message(decoded["frames_flat"])
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
        traj = pred_xyz[0, 0].float().cpu().numpy().tolist()
        rotations = (
            pred_rot[0, 0].float().cpu().numpy().tolist() if pred_rot is not None else None
        )
        reasoning = [None if c is None else str(c) for c in extra["cot"][0, 0]]
        return traj, rotations, reasoning
