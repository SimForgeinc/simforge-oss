"""Conformance client for real renderer frame bundles.

This command never fabricates camera pixels.  ``--frame-root`` must contain
four RGB image files per Qwen camera and ``--ego-history`` must contain the
sixteen real world-frame poses captured at the same decision timestamp; they
are re-expressed in the newest pose's ego frame, as the bench does.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .protocol import recv_msg, send_msg
from .scene import CAMERA_IDS, CAMERA_SENSOR_IDS, FRAME_COUNT, HISTORY_POINTS


def _frame_files(root: Path, sensor_id: str) -> list[Path]:
    directory = root / sensor_id
    if not directory.is_dir():
        raise SystemExit(f"missing frame directory: {directory}")
    files = sorted(path for path in directory.iterdir() if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"})
    if len(files) < FRAME_COUNT:
        raise SystemExit(f"{directory} has {len(files)} images; need at least {FRAME_COUNT}")
    return files[-FRAME_COUNT:]


def _frame_payload(path: Path, width: int, height: int) -> bytes:
    with Image.open(path) as image:
        image = image.convert("RGB")
        if image.size != (width, height):
            image = image.resize((width, height), Image.Resampling.BILINEAR)
        return image.tobytes()


def _ego_frame(history: list[list[float]]) -> list[list[float]]:
    """World ``[x, y, yaw, ...]`` rows into the newest row's ego frame (x forward, y left)."""
    x0, y0, yaw0 = float(history[-1][0]), float(history[-1][1]), float(history[-1][2])
    cos, sin = math.cos(yaw0), math.sin(yaw0)
    rows = []
    for x, y, yaw, *rest in history[-HISTORY_POINTS:]:
        dx, dy = float(x) - x0, float(y) - y0
        heading = float(yaw) - yaw0
        rows.append([dx * cos + dy * sin, -dx * sin + dy * cos, math.atan2(math.sin(heading), math.cos(heading)), *rest])
    return rows


def _request(socket_path: str, request: dict[str, Any]) -> dict[str, Any]:
    import socket

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(socket_path)
        send_msg(sock, request)
        response = recv_msg(sock)
        if not isinstance(response, dict):
            raise SystemExit(f"invalid endpoint response: {response!r}")
        return response


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--frame-root", type=Path, required=True)
    parser.add_argument("--ego-history", type=Path, required=True, help="JSON list of >=16 [x,y,yaw,speed,tS] rows")
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--mode", choices=("direct", "reasoning"), default="reasoning")
    parser.add_argument("--nav-command", type=int, default=0)
    args = parser.parse_args()
    history = json.loads(args.ego_history.read_text())
    if not isinstance(history, list) or len(history) < HISTORY_POINTS:
        raise SystemExit(f"--ego-history must contain at least {HISTORY_POINTS} pose rows")
    history = _ego_frame(history)
    cameras = []
    for camera_id, sensor_id in zip(CAMERA_IDS, CAMERA_SENSOR_IDS):
        cameras.append(
            {
                "camera_id": camera_id,
                "encoding": "raw",
                "width": args.width,
                "height": args.height,
                "frames": [_frame_payload(path, args.width, args.height) for path in _frame_files(args.frame_root, sensor_id)],
            }
        )
    hello = _request(args.socket, {"op": "hello"})
    if not hello.get("ok"):
        raise SystemExit(f"hello failed: {hello}")
    started = time.perf_counter()
    response = _request(
        args.socket,
        {
            "op": "act",
            "seed": args.seed,
            "params": {"mode": args.mode, "num_samples": 1},
            "obs": {
                "cameras": cameras,
                "frame_size": {"width": args.width, "height": args.height},
                "ego_history_xyz": history,
                "nav_command": args.nav_command,
            },
        },
    )
    if not response.get("ok"):
        raise SystemExit(f"act failed: {response}")
    result = response.get("result")
    if not isinstance(result, dict):
        raise SystemExit(f"act has no result: {response}")
    trajectories = np.asarray(result.get("trajectories"), dtype=np.float32)
    if trajectories.shape != (1, 50, 3):
        raise SystemExit(f"unexpected trajectory shape {trajectories.shape}; expected (1, 50, 3)")
    if args.mode == "reasoning" and not isinstance(result.get("reasoning"), str):
        raise SystemExit("reasoning mode returned no reasoning text")
    print(
        json.dumps(
            {
                "ok": True,
                "hello": hello.get("result", hello),
                "shape": list(trajectories.shape),
                "reasoning": result.get("reasoning"),
                "elapsedMs": (time.perf_counter() - started) * 1e3,
                "timings": result.get("timings", {}),
                "vram": result.get("vram", {}),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
