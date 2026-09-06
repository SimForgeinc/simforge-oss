"""Resident Bevy sensors in-process (``simforge_native.embedded.EmbeddedRenderer``).

The renderer is the existing native Bevy service linked in-process through
``libsimforge_render`` (``renderer/ffi``); there is no socket, Node or Studio
in the loop. Physical state stays with the physics owner: every camera frame is
rendered from a ``simforge.scene-state.v1`` document the world exported for its exact
tick and full body poses. Two consumption paths, selected explicitly:

- ``device=True``: cameras get exportable device streams imported into CUDA
  (``simforge_native.gpu.ImportedStream``); ``render`` returns per-sensor
  leases whose planes are torch tensors. Release a lease after use; the
  producer waits device-side and never recycles a slot under a live view.
- ``device=False``: frames are read from the renderer's shm ring as owned
  NumPy copies (``rgba8``/semantic ``(H, W, 4)`` uint8, ``depth32f`` ``(H, W)`` float32).

Scene documents are the renderer's ``SceneSpec`` (``glbs`` absolute tile paths for
ground/ramp/plateau, lighting, profile); ``robot.delivery-4w``/``robot.wheel``
actors are body-centred proxies sized from ``dims`` with the full quaternion applied.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

import numpy as np

try:
    from simforge_native.embedded import EmbeddedRenderer, EmbeddedRendererError
except ImportError as error:  # pragma: no cover - extras guard
    raise ImportError(
        "resident Bevy sensors need the simforge_native provider: `pip install simforge-oss-gym[bevy]` "
        "(libsimforge_render comes with the native runtime bundle; SIMFORGE_RENDER_LIB overrides its location)"
    ) from error

SceneStateProvider = Callable[[], Sequence[Mapping[str, Any]]]
"""Returns the per-tick ``LoadSceneState`` documents (renderer ``scene.rs`` form)
recorded since the previous call; the last one is the tick being rendered."""


@dataclass(frozen=True)
class HostFrame:
    """One camera pass copied out of the shm ring."""

    sensor_id: str
    pass_name: str
    tick: int
    array: np.ndarray


class BevySensorRig:
    """Cameras rendered by the resident Bevy renderer from a scene-state provider.

    ``scene`` is the render scene document (map/course meshes, actor catalog
    bindings such as ``robot.delivery-4w``/``robot.wheel``) published by the
    workload owner; ``cameras`` are renderer ServiceCamera descriptors
    (``{sensorId, width, height, fovDeg, eye, target, attach?}``).
    """

    def __init__(
        self,
        scene: Mapping[str, Any] | str,
        cameras: Sequence[Mapping[str, Any]],
        scene_state: SceneStateProvider,
        *,
        passes: Sequence[str] = ("rgb",),
        device: bool = False,
        cuda_device: int | None = None,
        slots: int = 3,
        wait_ms: int | None = None,
        shm_path: str | None = None,
        shm_size_bytes: int = 256 * 1024 * 1024,
        library: str | None = None,
    ) -> None:
        self.cameras = [dict(c) for c in cameras]
        self.passes = list(passes)
        self.device = device
        self._scene_state = scene_state
        self._shm_path = shm_path or os.path.join(tempfile.gettempdir(), f"simforge-bevy-{os.getpid()}-{id(self):x}.shm")
        self._renderer = EmbeddedRenderer(dict(scene) if isinstance(scene, Mapping) else scene, self._shm_path, shm_size_bytes, library)
        self._declared = False
        self._imported: dict[str, Any] = {}
        self._cuda_device = cuda_device
        self._slots = slots
        self._wait_ms = wait_ms
        self._pending: tuple[int, list[dict[str, Any]]] | None = None

    @property
    def renderer(self) -> EmbeddedRenderer:
        return self._renderer

    def render(self, sim_tick: int, tick_index: int | None = None, cuda_stream: Any | None = None) -> dict[str, Any] | list[HostFrame]:
        """Load the provider's latest scene-state chunk and render ``sim_tick``.

        Device mode returns ``{sensorId: gpu.FrameLease}`` (``lease.plane("rgb").as_torch()``;
        release each lease when done); host mode returns owned :class:`HostFrame` copies.
        """
        states = [dict(state) for state in self._scene_state()]
        if states:
            self._pending = (sim_tick, states)
        elif self._pending is not None and self._pending[0] == sim_tick:
            # A failed capture (including lease backpressure) must be retryable
            # even though the provider already exported this chunk.
            states = self._pending[1]
        else:
            raise RuntimeError("no new physics ticks to render since the previous frame; step the world first")
        self._renderer.request("load_scene_state", states=states)
        # load_scene_state replaces the resident chunk. Its indices start at
        # zero, independently of the authoritative tick stamped on the bundle.
        fields: dict[str, Any] = {"tick_index": len(states) - 1 if tick_index is None else tick_index}
        if not self._declared:
            if self.device:
                # Registration creates the camera textures the export streams
                # need. Empty passes perform no host readback.
                self._renderer.render_bundle(sim_tick, cameras=self.cameras, passes=[], **fields)
                self._declared = True
            else:
                fields["cameras"] = self.cameras
        if self.device:
            for camera in self.cameras:
                sensor_id = camera["sensorId"]
                if sensor_id in self._imported:
                    continue
                self._renderer.open_device_stream(sensor_id, self.passes, self._slots, self._wait_ms)
                try:
                    self._imported[sensor_id] = self._renderer.import_device_stream(sensor_id, self._cuda_device)
                except Exception:
                    self._renderer.close_device_stream(sensor_id)
                    raise
            fields["device_sensors"] = list(self._imported)
            fields["passes"] = []
        else:
            fields["passes"] = self.passes
        response = self._renderer.render_bundle(sim_tick, **fields)
        if self.device:
            result = {sensor_id: EmbeddedRenderer.lease_device_frame(imported, response, sensor_id, cuda_stream) for sensor_id, imported in self._imported.items()}
        else:
            result = [self._host_frame(record) for record in response["frames"]]
        self._declared = True
        self._pending = None
        return result

    def _host_frame(self, record: Mapping[str, Any]) -> HostFrame:
        """Strip the 256-byte row padding of one shm FrameRecord into an owned array."""
        payload = self._renderer.read_record(dict(record))
        width, height, fmt = int(record["width"]), int(record["height"]), str(record["format"])
        stride = -(-width * 4 // 256) * 256
        rows = np.frombuffer(payload, dtype=np.uint8).reshape(height, stride)[:, : width * 4].copy()
        if fmt == "depth32f":
            array = rows.view(np.float32).reshape(height, width)
        else:  # rgba8 / carla-depth-bgra / semantic rgba8
            array = rows.reshape(height, width, 4)
        return HostFrame(str(record["sensorId"]), str(record["pass"]), int(record["tickId"]), array)

    def close(self) -> None:
        for sensor_id, imported in self._imported.items():
            try:
                self._renderer.close_device_stream(sensor_id)
            except EmbeddedRendererError:
                pass
            imported.close()
        self._imported.clear()
        self._renderer.close()
        try:
            os.unlink(self._shm_path)
        except OSError:
            pass

    def __enter__(self) -> "BevySensorRig":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
