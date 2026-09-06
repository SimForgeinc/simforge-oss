"""Sensor tensors from the in-process NuRec renderer (``simforge-oss-gym[nurec]``).

The renderer provider is ``simforge-oss-splat`` (module ``simforge_splat``, ``renderer/splat/python``, CUDA
only, not vendorable: see ``renderer/splat/PROVENANCE.json``). This module
joins a :class:`~simforge_oss_gym.world.SimForgeWorld`'s per-tick truth
frames (current ``simforge.scene-state.v1`` documents) to ``NuRecTensorSensor`` and
returns device tensor leases. Tensor ownership follows the provider's lease
contract: ``lease.plane(name)`` is a read-only device view; a view kept past
``lease.release()`` holds its slot (never reused or freed) until the last view
is gone, and ``render`` raises ``LeaseExhausted`` when every slot is leased or
held and the declared capacity is spent. Nothing here copies frames through the host.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

try:
    from simforge_splat.tensor import NuRecTensorSensor, TensorFrame
except ImportError as error:  # pragma: no cover - extras guard
    raise ImportError(
        "sensor observations need the NuRec renderer provider (simforge-oss-splat, CUDA; `pip install simforge-oss-gym[nurec]`): "
        "install `simforge-oss-gym[nurec]` from the repository and set THREEDGRUT_ROOT as documented in renderer/splat"
    ) from error

from .world import SimForgeWorld, TruthStream


class SensorRig:
    """Cameras rendered from a live world's committed ticks.

    ``cameras`` are the current V5 camera descriptors
    (``{sensorId, projection?, output?: {width, height, format}}``); each gets
    one open stream with the requested ``planes`` (``{"rgb": "rgb8", ...}``).
    """

    def __init__(
        self,
        world: SimForgeWorld,
        sensor: NuRecTensorSensor,
        cameras: Sequence[Mapping[str, Any]],
        *,
        planes: Mapping[str, str] | None = None,
        slots: int | None = None,
        truth_capacity: int | None = None,
    ) -> None:
        self.world = world
        self.sensor = sensor
        self.cameras = [dict(c) for c in cameras]
        self.planes = dict(planes or {"rgb": "rgb8"})
        self._truth: TruthStream = world.subscribe(truth_capacity)
        self._loaded_map: str | None = None
        self._slots = slots
        self.streams: dict[str, Any] = {}

    def _ensure_streams(self, frames: list[dict[str, Any]]) -> None:
        loaded = self.sensor.load_scene_state([frame["scene"] for frame in frames])
        map_id = loaded["map_id"]
        if self.sensor.set_cameras(self.cameras) or map_id != self._loaded_map:
            # A camera or map change retires streams; reopen every retained camera.
            self.streams = {c["sensorId"]: self.sensor.open_stream(c["sensorId"], self.planes, slots=self._slots) for c in self.cameras}
            self._loaded_map = map_id

    def render(self, consumer_stream: Any | None = None) -> TensorFrame:
        """Feed every committed tick since the last call and render the latest one.

        Returns a ``TensorFrame`` lease; call ``release()`` (or use it as a
        context manager) before the next render can reuse its slot.
        """
        frames = self._truth.drain()
        if not frames:
            raise RuntimeError("no committed ticks since the last render; advance the world first")
        self._ensure_streams(frames)
        return self.sensor.render(int(frames[-1]["tick"]), consumer_stream)

    @property
    def dropped_ticks(self) -> int:
        return self._truth.dropped

    def close(self) -> None:
        for sensor_id in list(self.streams):
            self.sensor.close_stream(sensor_id)
        self.streams.clear()
        self._truth.close()

    def __enter__(self) -> "SensorRig":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
