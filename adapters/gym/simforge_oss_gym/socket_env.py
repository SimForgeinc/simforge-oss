"""SimForge episodes over a socket: ``simforge env serve`` (``simforge.env-serve/v1``).

The server is the SimForge CLI's closed-loop episode server. It runs the same
episode the in-process ``_native`` session runs (the same action row,
observation layout, info channel and checkpoints, byte for byte) and can also
render the rig's sensors on every observation. This module needs only the
standard library, numpy and gymnasium: no compiled extension.

.. code-block:: python

    from simforge_oss_gym.socket_env import SimForgeSocketEnv, spawn_env_server

    server, ready = spawn_env_server("ws/", "/tmp/sf.sock", "--no-sensors")
    env = SimForgeSocketEnv("/tmp/sf.sock")           # action_mode="setpoint" -> Box(2,)
    obs, info = env.reset(seed=7)
    obs, reward, terminated, truncated, info = env.step([9.0, 0.0])
    frames = info["sensors"]                           # {} without a rig

Observations are the ``SimForgeEnv`` Dict (``state_vector``, ``objects``,
optional ``bev``), so a policy written for the native env runs unchanged.
Rendered sensor frames ride in ``info["sensors"]``: ``{source_id: {pass:
ndarray}}`` with ``rgb``/``id``/``semantic`` as ``uint8 (H, W, 4)``, ``depth``
as ``float32 (H, W)`` (reverse-Z), lidar/radar payloads as their raw bytes
(``uint8``, PLY / CSV). They are kept out of the observation space because
their shapes are the rig's, not the scenario's.

Wire: every message is ``u32le total || u32le header_len || JSON header ||
binary tail``; arrays in the tail are referenced from the header as
``{offset, length, dtype, shape}``. A failed request answers ``{"ok": false,
"code", "reason", "detail"}`` and raises :class:`EnvServeError`.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import socket as _socket
import struct
import subprocess
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence

import gymnasium as gym
import numpy as np
from gymnasium import spaces

PROTOCOL = "simforge.env-serve/v1"
ActionMode = Literal["setpoint", "control"]

__all__ = [
    "PROTOCOL",
    "EnvServeError",
    "SocketEnvClient",
    "SimForgeSocketEnv",
    "spawn_env_server",
]


class EnvServeError(RuntimeError):
    """A request the server refused: ``code`` is stable, ``reason`` human-readable."""

    def __init__(self, op: str, code: str, reason: str, detail: Any = None) -> None:
        super().__init__(f"{op}: {code}: {reason}")
        self.op = op
        self.code = code
        self.reason = reason
        self.detail = detail


class SocketEnvClient:
    """One connection to ``simforge env serve``; requests are answered in order."""

    def __init__(self, path: str | os.PathLike[str], *, timeout: float | None = None) -> None:
        self.path = os.fspath(path)
        self._sock = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        self._sock.settimeout(timeout)
        self._sock.connect(self.path)
        self._i = 0

    # ------------------------------------------------------------ framing

    def _recv_exact(self, n: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < n:
            chunk = self._sock.recv(n - len(chunks))
            if not chunk:
                raise ConnectionError("simforge env serve closed the connection")
            chunks.extend(chunk)
        return bytes(chunks)

    def call(self, op: str, *, tail: bytes = b"", **fields: Any) -> tuple[dict[str, Any], bytes]:
        """Send ``{op, i, **fields}`` (+ ``tail``); return the response header and tail."""
        self._i += 1
        header = json.dumps({"op": op, "i": self._i, **fields}, allow_nan=False).encode()
        self._sock.sendall(struct.pack("<II", 4 + len(header) + len(tail), len(header)) + header + tail)
        (total,) = struct.unpack("<I", self._recv_exact(4))
        body = self._recv_exact(total)
        (header_len,) = struct.unpack("<I", body[:4])
        response = json.loads(body[4 : 4 + header_len])
        payload = body[4 + header_len :]
        if response.get("i") != self._i:
            raise ConnectionError(f"response {response.get('i')!r} does not answer request {self._i}")
        if not response.get("ok"):
            raise EnvServeError(op, response.get("code", "unknown"), response.get("reason", ""), response.get("detail"))
        return response, payload

    @staticmethod
    def array(tail: bytes, ref: Mapping[str, Any]) -> np.ndarray:
        """The tail array ``ref`` names, as an owned copy."""
        start = int(ref["offset"])
        data = tail[start : start + int(ref["length"])]
        return np.frombuffer(data, dtype=np.dtype(ref["dtype"])).reshape(ref["shape"]).copy()

    # ------------------------------------------------------------ ops

    def hello(self) -> dict[str, Any]:
        return self.call("hello")[0]

    def reset(self, seed: int | float | str | None = None) -> tuple[dict[str, Any], bytes]:
        return self.call("reset", seed=seed)

    def step(self, row: Sequence[float] | np.ndarray | None) -> tuple[dict[str, Any], bytes]:
        """``row`` is the native action row (``ACTION_WIDTH`` values, NaN = unset) or ``None``."""
        action = None if row is None else [None if math.isnan(v) else float(v) for v in np.asarray(row, dtype=np.float64)]
        return self.call("step", action=action)

    def observe(self) -> tuple[dict[str, Any], bytes]:
        return self.call("observe")

    def checkpoint(self) -> bytes:
        header, tail = self.call("checkpoint")
        return self.array(tail, header["checkpoint"]).tobytes()

    def restore(self, checkpoint: bytes) -> tuple[dict[str, Any], bytes]:
        return self.call("restore", checkpoint={"offset": 0, "length": len(checkpoint), "dtype": "|u1", "shape": [len(checkpoint)]}, tail=checkpoint)

    def close_server(self) -> None:
        """Ask the server to exit (it removes its socket)."""
        self.call("close")

    def close(self) -> None:
        self._sock.close()


def _action_space(mode: ActionMode) -> spaces.Box:
    # The same Boxes as ``simforge_oss_gym.env.action_space_for``.
    if mode == "setpoint":
        return spaces.Box(np.array([0.0, -np.inf]), np.array([np.inf, np.inf]), (2,), np.float64)
    if mode == "control":
        return spaces.Box(np.array([0.0, 0.0, -1.0]), np.array([1.0, 1.0, 1.0]), (3,), np.float64)
    raise ValueError(f"unknown action_mode {mode!r}; expected 'setpoint' or 'control'")


class SimForgeSocketEnv(gym.Env[dict[str, np.ndarray], np.ndarray]):
    """``SimForgeEnv``'s Gymnasium contract over ``simforge env serve``.

    Same spaces, same action encoding (``setpoint`` ``[target_speed_mps,
    target_acceleration_mps2]`` or ``control`` ``[throttle, brake, steer]``),
    same observations and ``info`` (``t_s``, ``ego``, ``object_ids``,
    ``reward_terms`` and, unless ``info_channel=False``, the engine ``events``,
    ``minima`` and ``causal`` frame), plus ``info["sensors"]`` (see the module
    docs). ``terminated`` / ``truncated`` are the server's.
    """

    metadata: dict[str, Any] = {"render_modes": []}

    def __init__(
        self,
        socket: str | os.PathLike[str],
        *,
        action_mode: ActionMode = "setpoint",
        seed: int | float | str | None = None,
        info_channel: bool = True,
        timeout: float | None = None,
    ) -> None:
        super().__init__()
        self.client = SocketEnvClient(socket, timeout=timeout)
        self.hello = self.client.hello()
        if self.hello.get("protocol") != PROTOCOL:
            raise ConnectionError(f"{socket} speaks {self.hello.get('protocol')!r}, not {PROTOCOL}")
        self.action_mode: ActionMode = action_mode
        self.info_channel = info_channel
        self._default_seed = seed
        fields = list(self.hello["actionFields"])
        self._slot = {name: index for index, name in enumerate(fields)}
        self._row = np.empty(int(self.hello["actionWidth"]), dtype=np.float64)
        self.ego: str = self.hello["ego"]
        self.decision_hz: int = int(self.hello["decisionHz"])
        self.engine_hz: int = int(self.hello["engineHz"])
        self.action_space = _action_space(action_mode)
        max_objects = int(self.hello["maxObjects"])
        features = int(self.hello["objectFeatures"])
        members: dict[str, spaces.Space] = {
            "state_vector": spaces.Box(-np.inf, np.inf, (int(self.hello["stateVectorSize"]),), np.float64),
            "objects": spaces.Box(
                np.tile(np.array([0.0, -math.pi, -np.inf, 0.0, 0.0], dtype=np.float32), (max_objects, 1)),
                np.tile(np.array([np.inf, math.pi, np.inf, 1.0, 1.0], dtype=np.float32), (max_objects, 1)),
                (max_objects, features),
                np.float32,
            ),
        }
        if self.hello.get("bevShape"):
            members["bev"] = spaces.Box(-np.inf, np.inf, tuple(self.hello["bevShape"]), np.float32)
        self.observation_space = spaces.Dict(members)

    def encode_action(self, action: Any) -> np.ndarray:
        """``action`` (in the mode's Box) as the flat native row; NaN = unset."""
        row = self._row
        row.fill(np.nan)
        values = np.asarray(action, dtype=np.float64).reshape(-1)
        if self.action_mode == "setpoint":
            if values.shape != (2,):
                raise ValueError(f"setpoint action must have shape (2,), got {values.shape}")
            row[self._slot["target_speed_mps"]] = values[0]
            row[self._slot["target_acceleration_mps2"]] = values[1]
        else:
            if values.shape != (3,):
                raise ValueError(f"control action must have shape (3,), got {values.shape}")
            row[self._slot["throttle"]] = values[0]
            row[self._slot["brake"]] = values[1]
            row[self._slot["steer"]] = values[2]
        if not np.all(np.isfinite(values)):
            raise ValueError(f"action contains non-finite values: {values}")
        return row

    def _unpack(self, header: Mapping[str, Any], tail: bytes) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        observation = {name: SocketEnvClient.array(tail, ref) for name, ref in header["observation"].items()}
        server_info = dict(header["info"])
        info: dict[str, Any] = {k: server_info[k] for k in ("t_s", "ego", "object_ids", "reward_terms")}
        if self.info_channel:
            info.update({k: v for k, v in server_info.items() if k not in info})
        sensors: dict[str, dict[str, np.ndarray]] = {}
        for source, passes in header.get("sensors", {}).items():
            sensors[source] = {name: SocketEnvClient.array(tail, ref) for name, ref in passes.items()}
        info["sensors"] = sensors
        if "renderMs" in header:
            info["render_ms"] = header["renderMs"]
        return observation, info

    # ------------------------------------------------------------------ api

    def reset(self, *, seed: int | None = None, options: Mapping[str, Any] | None = None) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        super().reset(seed=seed)
        value = seed if seed is not None else (options or {}).get("seed", self._default_seed)
        return self._unpack(*self.client.reset(value))

    def step(self, action: np.ndarray | None) -> tuple[dict[str, np.ndarray], float, bool, bool, dict[str, Any]]:
        """Apply ``action`` for one decision; ``None`` keeps the authored choreography."""
        row = None if action is None else self.encode_action(action)
        header, tail = self.client.step(row)
        observation, info = self._unpack(header, tail)
        return observation, float(header["reward"]), bool(header["terminated"]), bool(header["truncated"]), info

    def observe(self) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        """The current observation again (sensors re-rendered), without stepping."""
        return self._unpack(*self.client.observe())

    def checkpoint(self) -> bytes:
        return self.client.checkpoint()

    def restore(self, checkpoint: bytes) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        return self._unpack(*self.client.restore(checkpoint))

    def close(self) -> None:
        client = self.__dict__.pop("client", None)
        if client is not None:
            client.close()

    def __enter__(self) -> "SimForgeSocketEnv":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def spawn_env_server(
    workspace: str | os.PathLike[str],
    socket: str | os.PathLike[str],
    *args: str,
    binary: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[subprocess.Popen[bytes], dict[str, Any]]:
    """Start ``simforge env serve WORKSPACE --socket SOCKET *args``; wait for its ready line.

    ``binary`` defaults to ``$SIMFORGE_BIN``, then ``simforge`` on PATH. A
    server that exits before listening raises with its structured error.
    """
    exe = os.fspath(binary) if binary is not None else os.environ.get("SIMFORGE_BIN") or shutil.which("simforge")
    if not exe:
        raise FileNotFoundError("no simforge binary: pass binary=, set SIMFORGE_BIN, or put simforge on PATH")
    proc = subprocess.Popen(
        [exe, "env", "serve", os.fspath(workspace), "--socket", os.fspath(socket), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, **(env or {})},
    )
    assert proc.stdout is not None
    line = proc.stdout.readline()
    if not line:
        stderr = proc.stderr.read().decode() if proc.stderr else ""
        proc.wait()
        raise RuntimeError(f"simforge env serve exited ({proc.returncode}) before listening: {stderr.strip()}")
    ready = json.loads(line)
    if Path(ready["socket"]) != Path(socket).resolve() and Path(ready["socket"]) != Path(os.path.abspath(socket)):
        raise RuntimeError(f"server listens on {ready['socket']}, not {socket}")
    return proc, ready
