"""Qwen-Drive-1.0 model endpoint for the SimForge drive bench.

The service deliberately owns only model inference.  Native Bevy rendering and
trajectory execution remain in the TypeScript bench.  Requests use the shared
four-byte little-endian length prefix followed by one MessagePack document.
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import threading
import time
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from .families import CODE_REVISION, FAMILY, MODEL_REVISION
from .protocol import recv_msg, send_msg
from .scene import CAMERA_IDS, FRAME_COUNT, build_scene
from simforge_policy_endpoint import capabilities, receipt

LOG = logging.getLogger("simforge_qwen_drive")
DEFAULT_MODEL = Path(
    os.environ.get(
        "SIMFORGE_QWEN_DRIVE_MODEL",
        os.path.join(os.environ.get("SIMFORGE_ASSETS_ROOT", os.path.expanduser("~/simforge-assets")), "models", "qwen-drive", MODEL_REVISION),
    )
)


class QwenServerError(RuntimeError):
    """A typed inference or request failure returned to the socket client."""


class QwenEngine:
    def __init__(
        self,
        model_dir: Path,
        planner: str,
        mode: str,
        precision: str,
        quant: str,
        device: str,
        attn_implementation: str,
        max_reasoning_tokens: int,
        bev: bool = False,
    ) -> None:
        if mode not in {"direct", "reasoning"}:
            raise ValueError(f"unsupported mode {mode!r}")
        if precision not in {"bf16", "float16", "float32"}:
            raise ValueError(f"unsupported precision {precision!r}")
        if quant not in {"none", "nf4"}:
            raise ValueError(f"unsupported quantization {quant!r}")
        if not model_dir.is_dir():
            raise FileNotFoundError(f"Qwen-Drive model directory does not exist: {model_dir}")
        self.model_dir = model_dir
        self.planner_name, planner_dir = self._planner_path(planner)
        if bev:
            for filename in ("config.json", "model.safetensors"):
                if not (model_dir / "perception" / filename).is_file():
                    raise FileNotFoundError(
                        f"--bev requires {model_dir / 'perception' / filename}; "
                        "download the perception/ files from the same pinned Qwen-Drive release"
                    )
        self.mode = mode
        self.precision = precision
        self.quant = quant
        self.device_name = device
        self.max_reasoning_tokens = max_reasoning_tokens
        try:
            import torch
            from qwen_drive import InferenceMode, QwenDriveForPlanning
        except ImportError as exc:  # pragma: no cover - depends on isolated model venv
            raise QwenServerError(
                "Qwen-Drive runtime is unavailable; run adapters/qwen-drive/scripts/setup.sh"
            ) from exc
        self.torch = torch
        self.InferenceMode = InferenceMode
        requested_dtype = {
            "bf16": torch.bfloat16,
            "float16": torch.float16,
            "float32": torch.float32,
        }[precision]
        kwargs: dict[str, Any] = {
            "planner": str(planner_dir),
            "dtype": requested_dtype,
            "attn_implementation": attn_implementation,
        }
        if quant == "nf4":
            try:
                from transformers import BitsAndBytesConfig
            except ImportError as exc:  # pragma: no cover - optional dependency
                raise QwenServerError("--quant nf4 requires transformers BitsAndBytesConfig") from exc
            if not torch.cuda.is_available() or not device.startswith("cuda"):
                raise QwenServerError("--quant nf4 requires a CUDA device")
            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
                # The planning head has a distinct diffusion-transformer
                # layout; bitsandbytes' Linear4bit wrapper is not valid for
                # its grouped expert projections. Keep that 1B head in bf16
                # while quantizing the shared VLM.
                llm_int8_skip_modules=["planning_expert", "lm_head"],
            )
        LOG.info(
            "loading model=%s planner=%s mode=%s precision=%s quant=%s device=%s",
            model_dir,
            self.planner_name,
            mode,
            precision,
            quant,
            device,
        )
        started = time.perf_counter()
        self.model = QwenDriveForPlanning.from_pretrained(str(model_dir), **kwargs)
        if quant == "none":
            self.model = self.model.to(device)
        self.model.eval()
        self.planner_vram = self._vram()
        self.perception = None
        if bev:
            from .perception import QwenPerception

            self.perception = QwenPerception(self.model, model_dir, device)
        self.load_seconds = time.perf_counter() - started
        self._lock = threading.Lock()
        self.last_vram = self._vram()
        LOG.info("loaded Qwen-Drive in %.2fs; vram=%s", self.load_seconds, self.last_vram)

    def _planner_path(self, planner: str) -> tuple[str, Path]:
        aliases = {"sft": "planner-sft", "planner-sft": "planner-sft", "rl": "planner-rl", "planner-rl": "planner-rl"}
        value = aliases.get(planner, planner)
        path = Path(value)
        if not path.is_absolute():
            path = self.model_dir / path
        if not path.is_dir() or not (path / "model.safetensors").is_file():
            raise FileNotFoundError(f"Qwen-Drive planner head is missing model.safetensors: {path}")
        return Path(value).name, path

    def _vram(self) -> dict[str, float]:
        try:
            torch = self.torch
            if not torch.cuda.is_available():
                return {}
            torch.cuda.synchronize()
            free, total = torch.cuda.mem_get_info()
            return {
                "allocatedGiB": float(torch.cuda.memory_allocated() / 2**30),
                "maxAllocatedGiB": float(torch.cuda.max_memory_allocated() / 2**30),
                "reservedGiB": float(torch.cuda.memory_reserved() / 2**30),
                "deviceUsedGiB": float((total - free) / 2**30),
                "totalGiB": float(total / 2**30),
            }
        except Exception:  # noqa: BLE001 - telemetry must not mask inference
            return {}

    def hello(self) -> dict[str, Any]:
        config = self.model.config
        return {
            **capabilities(cameras=True, ego_steps=int(config.num_history_points), camera_frames=FRAME_COUNT, horizon_s=float(config.num_future_points / config.trajectory_hz), hz=float(config.trajectory_hz)),
            "family": FAMILY,
            "model": str(self.model_dir),
            "revision": MODEL_REVISION,
            "code_revision": CODE_REVISION,
            "inputRevision": "simforge-qwen-input/v2-derived-acceleration",
            "host": socket.gethostname(),
            "deviceName": self.torch.cuda.get_device_name() if self.device_name.startswith("cuda") else self.device_name,
            "torchVersion": str(self.torch.__version__),
            "cudaVersion": self.torch.version.cuda,
            "planner": self.planner_name,
            "mode": self.mode,
            "precision": self.precision,
            "quant": self.quant,
            "device": self.device_name,
            "cameraProfile": "qwen-drive-3cam",
            "cameraIds": list(CAMERA_IDS),
            "historyFrames": FRAME_COUNT,
            "historyPoints": int(config.num_history_points),
            "trajectoryShape": ["N", int(config.num_future_points), int(config.trajectory_point_dim)],
            "trajectoryHz": float(config.trajectory_hz),
            "trajectoryHorizonS": float(config.num_future_points / config.trajectory_hz),
            "loadSeconds": self.load_seconds,
            "bev": self.perception is not None,
            "perceptionPrecision": "bf16" if self.perception is not None else None,
            "plannerVram": self.planner_vram,
            "vram": self.last_vram,
        }

    def act(self, observation: Mapping[str, Any], seed: int, params: Mapping[str, Any]) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            scene = build_scene(observation, model_config=self.model.config)
            mode_name = str(params.get("mode", self.mode))
            mode = {
                "direct": self.InferenceMode.DIRECT_PLANNING,
                "reasoning": self.InferenceMode.REASONING_PLANNING,
                "direct_planning": self.InferenceMode.DIRECT_PLANNING,
                "reasoning_planning": self.InferenceMode.REASONING_PLANNING,
            }.get(mode_name)
            if mode is None:
                raise QwenServerError(f"unsupported act mode {mode_name!r}")
            max_tokens = int(params.get("max_reasoning_tokens", self.max_reasoning_tokens))
            with self._lock:
                self.torch.cuda.reset_peak_memory_stats() if self.torch.cuda.is_available() else None
                model_started = time.perf_counter()
                result = self.model.run(
                    mode,
                    scene=scene,
                    num_samples=max(1, int(params.get("num_samples", 1))),
                    seed=int(seed),
                    max_new_tokens=max_tokens if mode is self.InferenceMode.REASONING_PLANNING else None,
                )
                self.torch.cuda.synchronize() if self.torch.cuda.is_available() else None
                model_ms = (time.perf_counter() - model_started) * 1e3
                extras = {}
                perception_ms = 0.0
                if self.perception is not None:
                    perception_started = time.perf_counter()
                    extras["bev"] = self.perception.infer(scene, observation)
                    self.torch.cuda.synchronize() if self.torch.cuda.is_available() else None
                    perception_ms = (time.perf_counter() - perception_started) * 1e3
                vram = self._vram()
            trajectories = np.asarray(result.trajectories, dtype=np.float32)
            expected_points = int(self.model.config.num_future_points)
            expected_dim = int(self.model.config.trajectory_point_dim)
            if trajectories.ndim != 3 or trajectories.shape[1:] != (expected_points, expected_dim):
                raise QwenServerError(f"Qwen-Drive returned invalid trajectory shape {trajectories.shape}")
            if not np.isfinite(trajectories).all():
                raise QwenServerError("Qwen-Drive returned non-finite trajectory values")
            total_ms = (time.perf_counter() - started) * 1e3
            return {
                "trajectories": trajectories.tolist(),
                "reasoning": result.reasoning if mode is self.InferenceMode.REASONING_PLANNING else None,
                "timings": {"modelMs": model_ms, "perceptionMs": perception_ms, "totalMs": total_ms},
                "vram": vram,
                "planner": self.planner_name,
                "mode": mode_name,
                "extras": extras,
            }
        except QwenServerError:
            raise
        except Exception as exc:  # noqa: BLE001 - return model failures over wire
            raise QwenServerError(f"Qwen-Drive act failed: {exc}") from exc


class SocketServer:
    def __init__(self, socket_path: Path, engine: QwenEngine) -> None:
        self.socket_path = socket_path
        self.engine = engine
        self.stop_event = threading.Event()
        self.listener: socket.socket | None = None

    def serve(self) -> None:
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener = listener
        listener.bind(str(self.socket_path))
        os.chmod(self.socket_path, 0o600)
        listener.listen(8)
        print(f"READY socket={self.socket_path} planner={self.engine.planner_name} mode={self.engine.mode}", flush=True)
        while not self.stop_event.is_set():
            try:
                listener.settimeout(0.5)
                client, _ = listener.accept()
            except TimeoutError:
                continue
            except OSError:
                if self.stop_event.is_set():
                    break
                raise
            thread = threading.Thread(target=self._connection, args=(client,), daemon=True)
            thread.start()

    def _connection(self, client: socket.socket) -> None:
        with client:
            while not self.stop_event.is_set():
                try:
                    request = recv_msg(client)
                    if request is None:
                        return
                    response = self._dispatch(request)
                except Exception as exc:  # noqa: BLE001 - keep connection usable after bad request
                    LOG.exception("request failed")
                    response = {"ok": False, "error": str(exc)}
                try:
                    send_msg(client, response)
                except OSError:
                    return
                if isinstance(request, Mapping) and request.get("op") == "close":
                    return

    def _dispatch(self, request: Any) -> dict[str, Any]:
        if not isinstance(request, Mapping):
            raise QwenServerError("request must be a map")
        op = str(request.get("op", ""))
        if op == "hello":
            return {"ok": True, "result": self.engine.hello()}
        if op == "health":
            return {"ok": True, "result": {"status": "ok", "vram": self.engine._vram()}}
        if op == "reset":
            return {"ok": True, "result": {"reset": True}}
        if op == "close":
            return {"ok": True, "result": {"closed": True}}
        if op == "shutdown":
            self.stop_event.set()
            if self.listener is not None:
                self.listener.close()
            return {"ok": True, "result": {"shutdown": True}}
        if op == "act":
            obs = request.get("obs", request)
            if not isinstance(obs, Mapping):
                raise QwenServerError("act.obs must be a map")
            params = request.get("params", {})
            if not isinstance(params, Mapping):
                raise QwenServerError("act.params must be a map")
            result = self.engine.act(obs, int(request.get("seed", 0)), params)
            result.update(receipt(obs, result.get("trajectories"), horizon_s=float(self.engine.model.config.num_future_points / self.engine.model.config.trajectory_hz)))
            return {"ok": True, "result": result}
        raise QwenServerError(f"unknown operation {op!r}")

    def stop(self, *_args: Any) -> None:
        self.stop_event.set()
        if self.listener is not None:
            self.listener.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--planner", default="sft", help="sft, rl, or a planner head directory")
    parser.add_argument("--mode", choices=("direct", "reasoning"), default="direct")
    parser.add_argument("--precision", choices=("bf16", "float16", "float32"), default="bf16")
    parser.add_argument("--quant", choices=("none", "nf4"), default="none")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--attn-implementation", choices=("sdpa", "flash_attention_2"), default="sdpa")
    parser.add_argument("--max-reasoning-tokens", type=int, default=256)
    parser.add_argument("--bev", action="store_true", help="run the bf16 BEV perception head on the same current planner frames")
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--log-level", default=os.environ.get("SIMFORGE_QWEN_LOG_LEVEL", "INFO"))
    args = parser.parse_args()
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    engine = QwenEngine(
        args.model,
        args.planner,
        args.mode,
        args.precision,
        args.quant,
        args.device,
        args.attn_implementation,
        args.max_reasoning_tokens,
        bev=args.bev,
    )
    server = SocketServer(args.socket, engine)
    signal.signal(signal.SIGINT, server.stop)
    signal.signal(signal.SIGTERM, server.stop)
    try:
        server.serve()
    finally:
        server.stop()
        try:
            args.socket.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
