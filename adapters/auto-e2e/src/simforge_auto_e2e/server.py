"""Length-prefixed MessagePack AutoE2E endpoint.

The framing is the one every SimForge model endpoint speaks (``model-socket.ts``,
``simforge_qwen_drive.protocol``): ``uint32-le length`` followed by one
MessagePack mapping.  Two requests exist:

``hello``
    ``{"op": "hello", "config": {"mapId": str, "graph": {"lanes": [...]}}}``.
    The lane graph is retained per connection and rasterised at every act.

``act``
    ``{"op": "act", "seed": int, "params": {...}, "obs": {...}}`` where ``obs``
    carries ``cameras`` (six positional entries, newest raw RGB/RGBA frame
    each), ``frame_size``, ``pose`` (``x``, ``y``, ``yawRad``, ``speedMps``),
    ``ego_history`` (real ``[x, y, yaw, speed, tS]`` rows, oldest first) and
    ``route`` (``points`` in the world frame).  The reply is the model's 64
    control pairs, their integrated ego-frame path, and raster/history provenance.
"""

from __future__ import annotations

import argparse
import io
import logging
import os
from pathlib import Path
import socket
import socketserver
import struct
import threading
from typing import Any, Mapping

import msgpack
import numpy as np

from simforge_auto_e2e import contract
from simforge_auto_e2e.engine import AutoE2EEngine, AutoE2EError
from simforge_auto_e2e.nav_raster import rasterize
from simforge_auto_e2e.obs import ego_motion_history
from simforge_policy_endpoint import capabilities, receipt

LOGGER = logging.getLogger("simforge_auto_e2e.server")
MAX_MESSAGE = 256 * 1024 * 1024
IMAGE_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
IMAGE_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)


def _decode_frame(payload: bytes, encoding: str, width: int, height: int) -> np.ndarray:
    """Decode one raw RGB/RGBA buffer or encoded image into uint8 HxWx3."""

    if encoding in {"png", "jpeg", "jpg", "webp"}:
        from PIL import Image

        with Image.open(io.BytesIO(payload)) as image:
            return np.asarray(image.convert("RGB"), dtype=np.uint8)
    if encoding != "raw":
        raise AutoE2EError("input_error", f"unsupported camera encoding {encoding!r}")
    if width <= 0 or height <= 0:
        raise AutoE2EError("input_error", "raw camera frame requires positive width and height")
    channels = len(payload) // (width * height)
    if channels not in (3, 4) or len(payload) != width * height * channels:
        raise AutoE2EError("input_error", f"raw camera frame has {len(payload)} bytes for {width}x{height}")
    array = np.frombuffer(payload, dtype=np.uint8).reshape(height, width, channels)
    return np.ascontiguousarray(array[..., :3])


def _preprocess_image(array: np.ndarray) -> np.ndarray:
    from PIL import Image

    image = Image.fromarray(array, mode="RGB").resize((contract.CAMERA_WIDTH, contract.CAMERA_HEIGHT), Image.Resampling.BILINEAR)
    x = np.asarray(image, dtype=np.float32) / 255.0
    return np.ascontiguousarray(((x - IMAGE_MEAN) / IMAGE_STD).transpose(2, 0, 1))


def _pose(obs: Mapping[str, Any]) -> dict[str, float]:
    raw = obs.get("pose")
    if not isinstance(raw, Mapping):
        raise AutoE2EError("missing_fields", "obs.pose is required", fields=["pose"])
    try:
        return {key: float(raw[key]) for key in ("x", "y", "yawRad", "speedMps")}
    except (KeyError, TypeError, ValueError) as exc:
        raise AutoE2EError("input_error", "obs.pose needs finite x, y, yawRad and speedMps") from exc


def _camera_stack(obs: Mapping[str, Any]) -> np.ndarray:
    cameras = obs.get("cameras")
    if not isinstance(cameras, (list, tuple)):
        raise AutoE2EError("missing_fields", "obs.cameras is required", fields=["cameras"])
    if len(cameras) != contract.BEST_MODEL_NUM_VIEWS:
        raise AutoE2EError("camera_set_invalid", f"expected {contract.BEST_MODEL_NUM_VIEWS} positional cameras, got {len(cameras)}")
    images: list[np.ndarray] = []
    for index, camera in enumerate(cameras):
        if not isinstance(camera, Mapping):
            raise AutoE2EError("input_error", f"camera {index} must be a mapping")
        frames = camera.get("frames") or []
        if not frames:
            raise AutoE2EError("missing_fields", f"camera {index} has no frame", fields=[f"cameras[{index}].frames"])
        latest = _decode_frame(bytes(frames[-1]), str(camera.get("encoding", "raw")).lower(), int(camera.get("width", 0)), int(camera.get("height", 0)))
        images.append(_preprocess_image(latest))
    return np.stack(images, axis=0).astype(np.float32, copy=False)


def _route_points(obs: Mapping[str, Any]) -> list[Any]:
    route = obs.get("route")
    points = route.get("points") if isinstance(route, Mapping) else None
    return list(points) if isinstance(points, (list, tuple)) else []


class _ConnectionHandler(socketserver.StreamRequestHandler):
    server: "AutoE2ESocketServer"

    def setup(self) -> None:
        super().setup()
        self.graph: dict[str, Any] = {"lanes": []}
        self.request.settimeout(self.server.request_timeout_s)

    def _read_message(self) -> Mapping[str, Any] | None:
        header = self.rfile.read(4)
        if not header:
            return None
        if len(header) != 4:
            raise AutoE2EError("wire_error", "truncated MessagePack frame length")
        (length,) = struct.unpack("<I", header)
        if length > MAX_MESSAGE:
            raise AutoE2EError("wire_error", f"request too large: {length} bytes")
        payload = self.rfile.read(length)
        if len(payload) != length:
            raise AutoE2EError("wire_error", "truncated MessagePack payload")
        value = msgpack.unpackb(payload, raw=False, strict_map_key=False)
        if not isinstance(value, Mapping):
            raise AutoE2EError("wire_error", "request must be a MessagePack mapping")
        return value

    def _write_message(self, value: Mapping[str, Any]) -> None:
        payload = msgpack.packb(value, use_bin_type=True)
        self.wfile.write(struct.pack("<I", len(payload)))
        self.wfile.write(payload)
        self.wfile.flush()

    def handle(self) -> None:
        while True:
            try:
                request = self._read_message()
                if request is None:
                    return
                self._write_message(self.server.dispatch(request, self))
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
                return
            except Exception as exc:  # noqa: BLE001
                LOGGER.exception("request failed")
                error = exc.as_wire() if isinstance(exc, AutoE2EError) else {"code": "server_error", "message": repr(exc)}
                try:
                    self._write_message({"ok": False, "error": error})
                except OSError:
                    return


class AutoE2ESocketServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, socket_path: str, engine: AutoE2EEngine, *, request_timeout_s: float = 300.0):
        self.engine = engine
        self.request_timeout_s = request_timeout_s
        self._lock = threading.RLock()
        path = Path(socket_path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        super().__init__(str(path), _ConnectionHandler)
        self.socket_path = str(path)

    def dispatch(self, request: Mapping[str, Any], connection: _ConnectionHandler) -> dict[str, Any]:
        op = request.get("op")
        if op == "hello":
            config = request.get("config")
            if isinstance(config, Mapping) and isinstance(config.get("graph"), Mapping):
                connection.graph = dict(config["graph"])
            return {"ok": True, "result": {**self.engine.info(), **capabilities(cameras=True, ego_steps=64, camera_frames=1, horizon_s=contract.HORIZON_SECONDS, hz=contract.FUTURE_HZ)}}
        if op != "act":
            return {"ok": False, "error": {"code": "unknown_op", "message": f"unsupported op {op!r}"}}
        obs = request.get("obs")
        if not isinstance(obs, Mapping):
            raise AutoE2EError("input_error", "act.obs must be a mapping")
        pose = _pose(obs)
        camera_tiles = _camera_stack(obs)
        ego_rows = obs.get("ego_history")
        if ego_rows is None:
            raise AutoE2EError("missing_fields", "ego history is required", fields=["ego_history"])
        ego_history, ego_prov = ego_motion_history(ego_rows)
        graph = connection.graph
        if "trafficSignals" in obs or "stopLines" in obs:
            graph = {**graph, "trafficSignals": obs.get("trafficSignals", []), "stopLines": obs.get("stopLines", [])}
        map_context, route_mask, raster = rasterize(graph, pose, _route_points(obs))
        with self._lock:
            result = self.engine.act(
                {
                    "camera_tiles": camera_tiles,
                    "map_context": map_context,
                    "route_mask": route_mask,
                    "map_valid": raster.map_valid,
                    "route_valid": raster.route_valid,
                    "egomotion_history": ego_history,
                    "visual_history": [0.0] * contract.VISUAL_HISTORY_DIM,
                    "projection": None,
                    "geometry_type": contract.BEST_MODEL_GEOMETRY,
                },
                seed=int(request.get("seed", 0)),
                scored=True,
                initial_speed_mps=pose["speedMps"],
            )
        path = result["path"]
        return {
            "ok": True,
            "result": {
                **receipt(obs, result["controls"], horizon_s=contract.HORIZON_SECONDS),
                "controls": result["controls"],
                "trajectory": path["path_xyz"],
                "reasoning": {"kind": "none"},
                "timings": result["timings"],
                "vram": result["vram"],
                "extras": {
                    "raster": raster.as_dict(),
                    "mapValid": raster.map_valid,
                    "routeValid": raster.route_valid,
                    "egoHistory": ego_prov,
                    "signalState": obs.get("signals"),
                    "integratedSpeedProfileMps": path["speed_profile_mps"],
                    "speedClampedSteps": path["speed_clamped_steps"],
                    "checkpointProbe": self.engine.probe,
                    "geometry": "pseudo (checkpoint-trained learned prior)",
                },
                "model": result["model"],
            },
        }


def serve(socket_path: str, checkpoint: str, *, device: str = "cuda") -> None:
    engine = AutoE2EEngine(checkpoint, device=device)
    engine.load()
    server = AutoE2ESocketServer(socket_path, engine)
    LOGGER.info("listening on %s family=%s checkpoint=%s", socket_path, contract.FAMILY, checkpoint)
    print(f"READY socket={socket_path} family={contract.FAMILY}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        try:
            Path(socket_path).unlink()
        except FileNotFoundError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--checkpoint", default=os.environ.get("SIMFORGE_AUTO_E2E_CHECKPOINT", ""))
    parser.add_argument("--socket", required=True)
    parser.add_argument("--device", default=os.environ.get("SIMFORGE_AUTO_E2E_DEVICE", "cuda"))
    parser.add_argument("--log-level", default=os.environ.get("SIMFORGE_AUTO_E2E_LOG_LEVEL", "INFO"))
    args = parser.parse_args(argv)
    if not args.checkpoint:
        parser.error("--checkpoint or SIMFORGE_AUTO_E2E_CHECKPOINT is required")
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    serve(args.socket, args.checkpoint, device=args.device)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
