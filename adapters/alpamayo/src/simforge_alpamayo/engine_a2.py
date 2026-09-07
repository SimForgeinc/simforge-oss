"""Alpamayo 2 Super engine (``nvidia/Alpamayo2-Super``, ``alpamayo2_super``).

A2 is structurally different from 1 and 1.5, and this module encodes those
differences instead of pretending the families are interchangeable:

* Self-contained checkpoint: tokenizer, processor and chat template ship in
  the repo, so there is no sidecar and no gated dependency. The processor is
  loaded from the checkpoint with ``fix_mistral_regex``, via upstream
  ``helper.get_processor``.
* Inputs go through ``input_profiles``. The trajectory/meta-action/auto-label
  profile is cameras ``[0, 1, 2, 3, 5, 6]``; VQA is ``[0, 1, 2, 3, 4, 5]``.
  Upstream validates the ordered camera contract, and we call that validator
  rather than reimplementing it.
* Two accepted input shapes, both real:
  1. the exact task profile (6 cameras) — we build the already-selected
     payload and assert it with upstream ``assert_task_input``;
  2. the full canonical 7-camera ring — we build a source payload with the
     timing fields and let upstream ``select_task_input`` do the selection,
     which is the true parity path.
  Which one ran is recorded in provenance as ``input_selection``.
* Trajectory entrypoint ``Alpamayo2Super.sample_trajectories_from_data``
  returns a 4-tuple with ``return_extra=True`` (A1/A1.5 return 3), so the
  call cannot be shared.
* Text tasks are first-class upstream: ``vqa``, ``meta_action``,
  ``auto_labeling``, ``grounding`` via ``text_tasks.generate_text``.
  ``auto_labeling`` conditions on a future trajectory; when the caller
  supplies none we refuse with ``missing_fields`` rather than invent one.

Hardware: NVIDIA validated only an H100 80GB (72,115 MiB device peak). The
family descriptor marks local execution ``qualification-pending`` and offers
no quantized mode, so this engine never claims to fit a smaller device.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from simforge_alpamayo.engine import BaseEngine, prepare_process_env, quant_config
from simforge_alpamayo.obs import NUM_FRAMES_PER_CAMERA, ObservationError, decode_observation
from simforge_alpamayo.vendor import require_upstream

logger = logging.getLogger("simforge_alpamayo.engine_a2")

prepare_process_env()

#: Upstream ``CAMERA_NAMES_TO_INDICES`` order: the canonical source ring.
CANONICAL_RING: tuple[int, ...] = (0, 1, 2, 3, 4, 5, 6)

#: Our wire task names -> upstream task names.
TASK_ALIASES = {
    "act": "trajectory",
    "trajectory": "trajectory",
    "vqa": "vqa",
    "meta_actions": "meta_action",
    "meta_action": "meta_action",
    "autolabel": "auto_labeling",
    "auto_labeling": "auto_labeling",
    "grounding": "grounding",
}

#: Microsecond base for synthesized frame timestamps. Upstream only consumes
#: differences (``camera_tmin`` is subtracted), so the base is arbitrary; it
#: is a positive constant purely to keep the integers unsigned-friendly.
_TIME_BASE_US = 1_000_000_000


class Alpamayo2SuperEngine(BaseEngine):
    """Long-lived Alpamayo 2 Super inference engine."""

    def load(self) -> None:
        import torch

        t0 = time.monotonic()
        require_upstream(self.spec)
        from alpamayo2_super import helper
        from alpamayo2_super.models.alpamayo2_super import Alpamayo2Super

        if quant_config(self.quant) is not None:  # pragma: no cover - guarded
            raise RuntimeError(
                "Alpamayo 2 Super has no quantized recipe; only bf16 is offered"
            )

        logger.info("loading %s [%s]...", self.model_source, self.quant)
        model = Alpamayo2Super.from_pretrained(
            self.model_source,
            dtype=torch.bfloat16,
            device_map="cuda:0" if self.device == "cuda" else None,
            **({"revision": self.revision} if self.revision else {}),
        )
        model.eval()

        self.model = model
        # Processor comes from the checkpoint itself (fix_mistral_regex).
        self.processor = helper.get_processor(model.tokenizer, model.config)
        self.load_seconds = time.monotonic() - t0
        logger.info("model loaded in %.1fs", self.load_seconds)

    # -- input handling -----------------------------------------------------

    def decode(self, obs: dict[str, Any], task: str = "act") -> dict[str, Any]:
        """Accept either the exact task profile or the full 7-camera ring."""
        cameras = obs.get("cameras")
        if not cameras:
            raise ObservationError(
                "missing_fields",
                "observation.cameras is required and must be non-empty",
                fields=["obs.cameras"],
            )
        present = tuple(sorted(int(c["camera_id"]) for c in cameras))
        if present == CANONICAL_RING:
            decoded = decode_observation(
                obs,
                required_cameras=CANONICAL_RING,
                variable_cameras=False,
                family=self.family,
                task=task,
                max_cameras=7,
            )
            decoded["selection"] = "upstream-select_task_input"
            return decoded
        decoded = super().decode(obs, task=task)
        decoded["selection"] = "direct-task-profile"
        return decoded

    def _upstream_task(self, task: str) -> str:
        try:
            return TASK_ALIASES[task]
        except KeyError:
            raise ObservationError(
                "unsupported_op",
                f"{self.family}: unknown task {task!r}; supported: "
                f"{sorted(set(TASK_ALIASES))}",
            ) from None

    def _source_data(self, decoded: dict[str, Any], upstream_task: str) -> dict[str, Any]:
        """Build the upstream ``data`` payload for one task.

        For the 7-camera ring this is a *source* payload with the full timing
        fields, handed to upstream ``select_task_input``. For the exact task
        profile it is the *selected* payload, validated by upstream
        ``assert_task_input``.
        """
        import torch
        from alpamayo2_super.common.constants import CAMERA_INDICES_TO_NAMES
        from alpamayo2_super.input_profiles import (
            TASK_INPUT_PROFILES,
            assert_task_input,
            input_profile_record,
            select_task_input,
        )

        frames = decoded["frames"]  # (n_cams, n_frames, 3, H, W)
        camera_ids = decoded["camera_ids"]
        n_cams, n_frames = frames.shape[0], frames.shape[1]

        # Frame timestamps: from the supplied history clock when present,
        # otherwise the nominal 10 Hz window ending at t0. Both are recorded
        # in provenance by the base class; neither is silently invented.
        times = decoded.get("history_t_s")
        if times is None:
            offsets_s = [
                -(n_frames - 1 - index) / 10.0 for index in range(n_frames)
            ]
        else:
            offsets_s = list(times[-n_frames:])
        absolute_us = torch.tensor(
            [[_TIME_BASE_US + int(round(o * 1e6)) for o in offsets_s]] * n_cams,
            dtype=torch.int64,
        )

        data: dict[str, Any] = {
            "image_frames": frames,
            "camera_indices": torch.tensor(camera_ids, dtype=torch.int64),
            "camera_names": [CAMERA_INDICES_TO_NAMES[c] for c in camera_ids],
            "absolute_timestamps": absolute_us,
            "relative_timestamps": (
                absolute_us - int(absolute_us.min().item())
            ).float() * 1e-6,
            "ego_t0": torch.tensor([int(absolute_us[:, -1].max().item())], dtype=torch.int64),
            "ego_t0_frame_idx": torch.tensor([n_frames - 1], dtype=torch.int64),
            "ego_history_xyz": decoded["ego_history_xyz"],
            "ego_history_rot": decoded["ego_history_rot"],
        }
        if decoded.get("nav_text"):
            data["nav_instruction"] = decoded["nav_text"]

        if decoded.get("selection") == "upstream-select_task_input":
            return select_task_input(data, upstream_task)

        profile = TASK_INPUT_PROFILES[upstream_task]
        if tuple(camera_ids) != profile.camera_ids:
            raise ObservationError(
                "camera_set_invalid",
                (
                    f"{self.family} task {upstream_task!r} requires cameras "
                    f"{list(profile.camera_ids)} in order, or the full "
                    f"7-camera ring {list(CANONICAL_RING)} for upstream "
                    f"selection; got {camera_ids}"
                ),
                required_cameras=list(profile.camera_ids),
            )
        data["camera_tmin"] = int(absolute_us.min().item())
        data["ego_t0_relative"] = (
            data["ego_t0"].float() - float(data["camera_tmin"])
        ) * 1e-6
        data["input_profile"] = input_profile_record(profile)
        assert_task_input(data, upstream_task)
        return data

    def _prepare_inputs(self, decoded: dict[str, Any]) -> dict[str, Any]:
        from alpamayo2_super import helper

        data = self._source_data(decoded, "trajectory")
        prepared = helper.prepare_model_inputs(
            data, self.model.config, self.model.tokenizer
        )
        prepared = helper.to_device(prepared, self.device)
        prepared["_selection"] = decoded.get("selection")
        return prepared

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

        prepared = {k: v for k, v in prepared.items() if not k.startswith("_")}
        diffusion_kwargs: dict[str, Any] = {}
        if num_diffusion_steps is not None:
            diffusion_kwargs["inference_step"] = int(num_diffusion_steps)

        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            pred_xyz, pred_rot, _logprob, extra = (
                self.model.sample_trajectories_from_data(
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
        cot = extra.get("cot") if isinstance(extra, dict) else None
        reasoning = (
            [None if c is None else str(c) for c in cot[0, 0]]
            if cot is not None
            else [None] * len(traj)
        )
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
        import torch
        from alpamayo2_super import text_tasks

        if self.model is None:
            raise RuntimeError("engine not loaded")
        upstream_task = self._upstream_task(task)
        if upstream_task == "trajectory":
            raise ObservationError(
                "unsupported_op", "use the act op for trajectory inference"
            )
        if upstream_task == "grounding":
            # Upstream routes grounding through the VQA template with a
            # bounding-box question; there is no separate generator.
            question = prompt or text_tasks.DEFAULT_GROUNDING_QUESTION
            upstream_task = "vqa"
        elif upstream_task == "vqa":
            if not prompt or not prompt.strip():
                raise ObservationError(
                    "missing_fields",
                    "text task 'vqa' requires a non-empty question in `prompt`",
                    fields=["prompt"],
                )
            question = prompt
        else:
            question = None

        t_start = time.monotonic()
        # VQA has its own camera profile; the driving text tasks share the
        # trajectory profile.
        decoded = self.decode(obs, task="text" if upstream_task == "vqa" else "act")
        data = self._source_data(decoded, upstream_task)

        future_xyz = params.get("future_xyz")
        future_rot = params.get("future_rot")
        if upstream_task == "auto_labeling" and future_xyz is None:
            raise ObservationError(
                "missing_fields",
                (
                    "auto_labeling conditions on a future ego trajectory. "
                    "Supply params.future_xyz and params.future_rot (for "
                    "example a prior act result, labelled as such) — a future "
                    "is never fabricated here."
                ),
                fields=["params.future_xyz", "params.future_rot"],
            )
        if future_xyz is not None:
            future_xyz = torch.as_tensor(future_xyz, dtype=torch.float32)
            future_rot = (
                torch.as_tensor(future_rot, dtype=torch.float32)
                if future_rot is not None
                else None
            )
            if future_rot is None:
                raise ObservationError(
                    "missing_fields",
                    "params.future_rot must accompany params.future_xyz",
                    fields=["params.future_rot"],
                )

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)

        prepared = text_tasks.prepare_text_generation_inputs(
            data=data,
            model_config=self.model.config,
            tokenizer=self.model.tokenizer,
            task=upstream_task,
            future_xyz=future_xyz,
            future_rot=future_rot,
            question=question,
        )
        from alpamayo2_super import helper

        prepared = helper.to_device(prepared, self.device)
        prepared["task"] = upstream_task

        num_samples = int(params.get("num_samples", 1))
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            output = text_tasks.generate_text(
                model=self.model,
                data=prepared,
                top_p=float(params.get("top_p", 0.98)),
                temperature=float(params.get("temperature", 0.6)),
                num_samples=num_samples,
                max_new_tokens=params.get("max_generation_length"),
            )

        text, fields = self._text_output(output, upstream_task)
        provenance = self.rng_provenance(
            seed, None, num_samples, decoded["time_base"]
        )
        provenance["input_selection"] = decoded.get("selection")
        provenance["upstream_task"] = upstream_task
        return {
            "task": task,
            "text": text,
            "fields": fields,
            "trajectories": None,
            "trajectory_rot": None,
            "reasoning": None,
            "seed": seed,
            "timings": {"total_ms": (time.monotonic() - t_start) * 1e3},
            "vram": self.vram(),
            "rng_provenance": provenance,
            "model": self.model_identity(decoded["camera_ids"]),
            "cameras": decoded["camera_ids"],
            "not_a_driving_evaluation": True,
        }

    @staticmethod
    def _text_output(output: Any, upstream_task: str) -> tuple[str, dict | None]:
        """Normalize upstream text output to ``(text, fields)``."""
        from alpamayo2_super import text_tasks

        if not isinstance(output, dict):
            return str(output), None

        def first(key: str) -> str | None:
            value = output.get(key)
            if value is None:
                return None
            try:
                return str(value[0][0])
            except (IndexError, TypeError):
                return str(value)

        if upstream_task == "auto_labeling":
            raw = first("cot_auto_labeling") or first("cot") or ""
            try:
                parsed = text_tasks.parse_auto_labeling_json(raw)
            except Exception:
                parsed = None
            return raw, parsed
        if upstream_task == "meta_action":
            meta = first("meta_action")
            cot = first("cot")
            return meta or cot or "", {"cot": cot, "meta_action": meta}
        answer = first("answer") or first("cot") or ""
        extras = {
            key: first(key) for key in output if key != "answer"
        }
        return answer, extras or None
