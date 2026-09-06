"""``simforge.scene-state.v1`` export of a recorded episode.

MuJoCo world frame (x forward, y left, z up) is the engine's xodr-local frame;
the scene frame is y-up: ``scene = (x, z, -y)`` (``packages/engine/src/frames.ts``).
That mapping is a proper rotation, so a quaternion's vector part maps the same
way: MuJoCo ``(w, x, y, z)`` becomes scene ``[x, z, -y, w]``. Yaw about
local +z equals yaw about scene +y, matching the engine's frame invariance.

Provenance of derived channels is emitter-declared, as in the trace emitter:
the chassis velocity is the solver's exact ``framelinvel``; wheel origin
velocities are exact rigid-body kinematics ``v_c + w_c x (p_w - p_c)`` (wheel
centres are fixed in the chassis frame); accelerations are backward finite
differences over the decision dt and are omitted on the first exported frame.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

import numpy as np

from .profile import SCENE_STATE_VERSION
from .workload import EXPORTED_BODIES, WHEELS, Workload


def to_scene_position(p: np.ndarray) -> list[float]:
    return [float(p[0]), float(p[2]), float(-p[1])]


def to_scene_quaternion(q_wxyz: np.ndarray) -> list[float]:
    w, x, y, z = (float(v) for v in q_wxyz)
    return [x, z, -y, w]


def yaw_from_quaternion(q_wxyz: np.ndarray) -> float:
    """Heading about local +z (== scene +y), CCW from +x."""
    w, x, y, z = (float(v) for v in q_wxyz)
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def canonical_json(doc: Any) -> str:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), allow_nan=False)


def scene_state_digest(doc: dict[str, Any]) -> str:
    """sha256 of the canonical JSON serialization."""
    return hashlib.sha256(canonical_json(doc).encode()).hexdigest()


def merge_scene_state(prior: dict[str, Any], later: dict[str, Any]) -> dict[str, Any]:
    """Join a segment exported after a snapshot restore onto the recording
    that preceded the snapshot. ``later`` must start at ``prior``'s last tick
    (the restored frame, which is re-recorded as ``spawn``); that duplicate
    frame is dropped so the result equals an uninterrupted export.
    """
    for key in ("version", "mapId", "frame", "dt", "tickHz", "actors"):
        if prior[key] != later[key]:
            raise ValueError(f"scene-state segments differ in {key!r}")
    if not prior["frames"] or not later["frames"]:
        raise ValueError("cannot merge empty scene-state segments")
    last_tick = prior["frames"][-1]["tick"]
    if later["frames"][0]["tick"] != last_tick:
        raise ValueError(f"segment starts at tick {later['frames'][0]['tick']}, expected {last_tick}")
    frames = prior["frames"] + later["frames"][1:]
    return {**prior, "frames": frames, "tickCount": len(frames)}


class SceneStateRecorder:
    """Accumulates per-decision body poses for one world, addressed by the
    absolute decision tick so a segment recorded after a snapshot restore can
    be compared with the same ticks of an uninterrupted run."""

    def __init__(self, workload: Workload) -> None:
        self.workload = workload
        self._ticks: list[int] = []
        self._times: list[float] = []
        self._positions: list[np.ndarray] = []
        self._quaternions: list[np.ndarray] = []
        self._chassis_linvel: list[np.ndarray] = []
        self._chassis_angvel: list[np.ndarray] = []

    def clear(self) -> None:
        self._ticks.clear()
        self._times.clear()
        self._positions.clear()
        self._quaternions.clear()
        self._chassis_linvel.clear()
        self._chassis_angvel.clear()

    def record(
        self,
        tick: int,
        time_s: float,
        xpos: np.ndarray,
        xquat: np.ndarray,
        chassis_linvel: np.ndarray,
        chassis_angvel: np.ndarray,
    ) -> None:
        """``xpos``/``xquat`` are ``(len(EXPORTED_BODIES), 3|4)`` in
        ``EXPORTED_BODIES`` order; velocities are world-frame."""
        if self._ticks and tick != self._ticks[-1] + 1:
            raise ValueError(f"non-consecutive tick {tick} after {self._ticks[-1]}")
        self._ticks.append(int(tick))
        self._times.append(float(time_s))
        self._positions.append(np.array(xpos, dtype=np.float64, copy=True))
        self._quaternions.append(np.array(xquat, dtype=np.float64, copy=True))
        self._chassis_linvel.append(np.array(chassis_linvel, dtype=np.float64, copy=True))
        self._chassis_angvel.append(np.array(chassis_angvel, dtype=np.float64, copy=True))

    def rewind(self, tick: int) -> None:
        """Keep frames up to and including ``tick``; if the recording does not
        contain ``tick`` it is cleared and restarts at the restored tick."""
        if not self._ticks or tick < self._ticks[0] or tick > self._ticks[-1]:
            self.clear()
            return
        keep = tick - self._ticks[0] + 1
        del self._ticks[keep:]
        del self._times[keep:]
        del self._positions[keep:]
        del self._quaternions[keep:]
        del self._chassis_linvel[keep:]
        del self._chassis_angvel[keep:]

    def __len__(self) -> int:
        return len(self._ticks)

    @property
    def first_tick(self) -> int | None:
        return self._ticks[0] if self._ticks else None

    def export(self, from_tick: int = 0) -> dict[str, Any]:
        """simforge.scene-state.v1 document of frames with ``tick >= from_tick``."""
        spec = self.workload.spec
        robot = spec.robot
        dt = spec.simulation.decision_dt_s
        actors = [
            {
                "id": "chassis",
                "catalogId": "robot.delivery-4w",
                "actorClass": "prop",
                "dims": {"l": robot.chassis_length_m, "w": robot.chassis_width_m, "h": robot.chassis_height_m},
            }
        ]
        for n in WHEELS:
            actors.append(
                {
                    "id": f"wheel_{n}",
                    "catalogId": "robot.wheel",
                    "actorClass": "prop",
                    "dims": {"l": 2.0 * robot.wheel_radius_m, "w": robot.wheel_width_m, "h": 2.0 * robot.wheel_radius_m},
                }
            )

        frames = []
        prev_vel: np.ndarray | None = None
        for i, tick in enumerate(self._ticks):
            if tick < from_tick:
                continue
            pos, quat = self._positions[i], self._quaternions[i]
            v_c, w_c = self._chassis_linvel[i], self._chassis_angvel[i]
            vel = v_c[None, :] + np.cross(w_c[None, :], pos - pos[0][None, :])
            acc = None if prev_vel is None else (vel - prev_vel) / dt
            prev_vel = vel
            frame_actors = []
            for b, body in enumerate(EXPORTED_BODIES):
                actor: dict[str, Any] = {
                    "id": body,
                    "kind": "spawn" if not frames else "update",
                    "position": to_scene_position(pos[b]),
                    "rotation": to_scene_quaternion(quat[b]),
                    "yawRad": yaw_from_quaternion(quat[b]),
                    "velocity": to_scene_position(vel[b]),
                }
                if acc is not None:
                    actor["acceleration"] = to_scene_position(acc[b])
                frame_actors.append(actor)
            frames.append({"tick": tick, "t": self._times[i], "actors": frame_actors})

        return {
            "version": SCENE_STATE_VERSION,
            "mapId": self.workload.map_id,
            "frame": "scene-yup",
            "dt": dt,
            "tickHz": spec.simulation.decision_hz,
            "tickCount": len(frames),
            "weather": {"preset": "clear", "fogDensity": 0.0, "rainIntensity": 0.0, "wetness": 0.0},
            "timeOfDay": 12.0,
            "profile": "sensor",
            # Positions carry solver height; no ground hint is meaningful for a
            # course with a raised sidewalk. Consumers resolve the surface.
            "groundY": None,
            "actors": actors,
            "frames": frames,
        }


def to_service_states(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert a simforge.scene-state.v1 playback document into the native render
    service's per-tick ``LoadSceneState`` form (``renderer/service/src/scene.rs``):
    one document per tick, static actor descriptors joined onto each actor
    record, and the pose under ``transform``. Positions (including y) and the
    full quaternion are preserved; the service applies them verbatim for the
    body-centred ``robot.*`` catalog entries.
    """
    descs = {a["id"]: a for a in doc["actors"]}
    states = []
    for frame in doc["frames"]:
        actors = []
        for actor in frame["actors"]:
            desc = descs[actor["id"]]
            actors.append(
                {
                    "id": actor["id"],
                    "kind": actor["kind"],
                    "catalogId": desc["catalogId"],
                    "actorClass": desc["actorClass"],
                    "dims": desc["dims"],
                    "transform": {"position": actor["position"], "rotation": actor["rotation"]},
                    "velocity": actor["velocity"],
                }
            )
        states.append(
            {
                "version": doc["version"],
                "mapId": doc["mapId"],
                "tick": frame["tick"],
                "tickHz": doc["tickHz"],
                "weather": doc["weather"],
                "timeOfDay": doc["timeOfDay"],
                "groundY": doc["groundY"],
                "actors": actors,
            }
        )
    return states
