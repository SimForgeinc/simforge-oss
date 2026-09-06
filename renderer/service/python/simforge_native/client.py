"""Python client for the native render service (protocol V5).

Wire: u32-LE length-prefixed msgpack frames (`renderer/service/src/proto.rs`)
over a Unix socket, encoded with the `msgpack` package. Host frames are read
as numpy views over the service's shm ring (`step`, `step_bundle`,
`read_record`): that view is a copy-free read of the service's own host
staging output, not a GPU-resident tensor; the device-stream ops below are
the GPU-resident path.
"""
from __future__ import annotations

import mmap
import os
import socket
import struct

import msgpack

# Same cap as `proto::MAX_FRAME_BYTES`.
MAX_FRAME_BYTES = 64 * 1024 * 1024


# ------------------------------------------------------------------- client
class NativeRenderClient:
    """Unix-socket client over the service's u32-LE length-prefixed msgpack
    frames, with numpy views over the shm ring for host frames."""

    def __init__(self, socket_path: str):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(socket_path)
        self.seq = 0
        self.shm = None
        hello = self._rpc({"i": self._next(), "op": "hello"})
        assert hello["ok"], hello
        self.hello = hello
        info = hello["shm"]
        if info.get("path") and os.path.exists(info["path"]):
            f = open(info["path"], "rb")
            self.shm = mmap.mmap(f.fileno(), 0, prot=mmap.PROT_READ)

    def _next(self) -> int:
        self.seq += 1
        return self.seq

    def _rpc(self, request: dict) -> dict:
        payload = msgpack.packb(request, use_bin_type=True)
        if len(payload) > MAX_FRAME_BYTES:
            raise ValueError(f"request exceeds the service's {MAX_FRAME_BYTES}-byte frame cap")
        self.sock.sendall(struct.pack("<I", len(payload)) + payload)
        (length,) = struct.unpack("<I", self._recv_exact(4))
        if length > MAX_FRAME_BYTES:
            raise ConnectionError(f"service response frame {length} bytes exceeds cap")
        return msgpack.unpackb(self._recv_exact(length), raw=False, strict_map_key=False)

    def _recv_exact(self, n: int) -> bytes:
        chunks = []
        while n > 0:
            chunk = self.sock.recv(min(n, 65536))
            if not chunk:
                raise ConnectionError("service closed")
            chunks.append(chunk)
            n -= len(chunk)
        return b"".join(chunks)

    # -- ops ---------------------------------------------------------------
    def render(self, tick_id: int, cameras: list[dict], export_dir: str | None = None,
               tick_index: int | None = None) -> dict:
        req = {"i": self._next(), "op": "render", "tick_id": tick_id, "cameras": cameras}
        if export_dir is not None:
            req["export_dir"] = export_dir
        if tick_index is not None:
            req["tick_index"] = tick_index
        return self._rpc(req)

    # -- scene-state / rig ops --------------------------------------------
    def load_scene_state(self, states: list[dict]) -> dict:
        return self._rpc({"i": self._next(), "op": "load_scene_state", "states": states})

    def reset_cameras(self) -> dict:
        return self._rpc({"i": self._next(), "op": "reset_cameras"})

    def encode_jpeg(self, items: list[dict]) -> dict:
        """JPEG-encode cached pass payloads from the last rendered tick.
        items: [{"sensorId": ..., "pass": "rgb", "quality": 70}]"""
        return self._rpc({"i": self._next(), "op": "encode_jpeg", "items": items})

    def render_bundle(self, sim_tick: int, cameras: list[dict] | None = None,
                      tick_index: int | None = None, passes: list[str] | None = None,
                      lidars: list[dict] | None = None,
                      radars: list[dict] | None = None,
                      device_sensors: list[str] | None = None) -> dict:
        """Render the retained camera/lidar/radar rig as one atomic bundle.

        Send declarations once, then omit them on the persistent hot loop.
        Lidar and radar records use passes ``lidar`` and ``radar`` and expose
        their deterministic PLY/CSV bytes through the same shm offsets.
        ``device_sensors`` names cameras whose open device streams are
        filled by the same submission; the response's ``device`` map gives
        the slot to lease per sensor (see :meth:`lease_device_frame`).
        """
        req = {"i": self._next(), "op": "render_bundle", "sim_tick": sim_tick}
        if cameras is not None:
            req["cameras"] = cameras
        if lidars is not None:
            req["lidars"] = lidars
        if radars is not None:
            req["radars"] = radars
        if tick_index is not None:
            req["tick_index"] = tick_index
        if passes is not None:
            req["passes"] = passes
        if device_sensors is not None:
            req["device_sensors"] = device_sensors
        return self._rpc(req)

    # -- device-resident streams -------------------------------------------
    def open_device_stream(self, sensor_id: str, passes: list[str], slots: int,
                           wait_ms: int | None = None) -> dict:
        """Allocate an exportable device stream for a registered camera."""
        req = {"i": self._next(), "op": "open_device_stream", "sensor_id": sensor_id,
               "passes": passes, "slots": slots}
        if wait_ms is not None:
            req["wait_ms"] = wait_ms
        return self._rpc(req)

    def import_device_stream(self, sensor_id: str, cuda_device: int | None = None):
        """Export a sensor's device stream and import it into CUDA.

        The service answers the RPC, then writes the manifest frame with every
        slot's memory/ready/release descriptors as SCM_RIGHTS on this socket;
        both are consumed here. Returns ``simforge_native.gpu.ImportedStream``.
        """
        from .gpu import ImportedStream, receive_stream
        response = self._rpc({"i": self._next(), "op": "export_device_stream", "sensor_id": sensor_id})
        assert response["ok"], response
        manifest, fds = receive_stream(self.sock)
        if manifest.stream_id != response["stream_id"]:
            raise RuntimeError(f"device stream handles for {manifest.stream_id}, expected {response['stream_id']}")
        return ImportedStream(manifest, fds, cuda_device)

    def close_device_stream(self, sensor_id: str, grace_ms: int = 0) -> dict:
        return self._rpc({"i": self._next(), "op": "close_device_stream", "sensor_id": sensor_id,
                          "grace_ms": grace_ms})

    @staticmethod
    def lease_device_frame(imported, response: dict, sensor_id: str, cuda_stream=None):
        """Lease the slot a ``render_bundle`` response published for ``sensor_id``."""
        ready = response["device"][sensor_id]
        if int(ready["stream"]) != imported.manifest.stream_id:
            raise RuntimeError(f"bundle names stream {ready['stream']}, imported {imported.manifest.stream_id}")
        return imported.lease(int(ready["slot"]), int(ready["generation"]), cuda_stream)

    def read_record(self, frame: dict) -> memoryview:
        """Raw payload bytes (row-padded) of one returned FrameRecord."""
        offset = frame["offset"] + 128
        return memoryview(self.shm)[offset:offset + frame["len"]]

    def close(self) -> None:
        try:
            self._rpc({"i": self._next(), "op": "close"})
        finally:
            self.sock.close()

    # -- gym-shaped host observations (numpy views over the shm ring) --------
    @staticmethod
    def _stride(width: int, pixel_bytes: int) -> int:
        """wgpu COPY_BYTES_PER_ROW_ALIGNMENT (256) padded row stride."""
        row = width * pixel_bytes
        return -(-row // 256) * 256

    def step(self, tick_id: int, cameras: list[dict], tick_index: int | None = None) -> tuple[dict, float]:
        """One env step: send tick -> receive frame records -> numpy views.

        Returns (observations, server_ms). Each observation value is a numpy
        array VIEW into the shared-memory ring with the 256-byte GPU row
        padding handled via a strided view. rgb/id/semantic are (H, W, 4)
        uint8; depth32f is (H, W) float32; carla-depth-bgra and jpeg
        payloads stay raw byte arrays.
        """
        import numpy as np
        response = self.render(tick_id, cameras, tick_index=tick_index)
        assert response["ok"], response
        obs: dict = {}
        for frame in response["frames"]:
            offset = frame["offset"]
            w, h = frame["width"], frame["height"]
            fmt = frame["format"]
            if fmt == "depth32f":
                stride = self._stride(w, 4)
                arr = np.frombuffer(self.shm, dtype="<f4", count=stride * h // 4, offset=offset + 128)
                view = arr.reshape(h, stride // 4)[:, :w]
            elif fmt in ("rgba8", "carla-depth-bgra"):
                stride = self._stride(w, 4)
                arr = np.frombuffer(self.shm, dtype=np.uint8, count=stride * h, offset=offset + 128)
                view = arr.reshape(h, stride)[:, : w * 4].reshape(h, w, 4)
            else:  # jpeg / opaque byte payload
                view = np.frombuffer(self.shm, dtype=np.uint8, count=frame["len"], offset=offset + 128)
            obs.setdefault(frame["sensorId"], {})[frame["pass"]] = view
        return obs, response["server_ms"]

    def step_bundle(self, sim_tick: int, cameras: list[dict] | None = None,
                    tick_index: int | None = None, passes: list[str] | None = None) -> tuple[dict, dict]:
        """render_bundle + zero-copy views: returns (observations, response).

        Push-mode twin of `bundles.BundleRingReader` (which pulls the same
        bundles from the ring without the RPC socket). Observation views use
        the same strided zero-copy mapping as `step()`.
        """
        import numpy as np
        response = self.render_bundle(sim_tick, cameras, tick_index=tick_index, passes=passes)
        assert response["ok"], response
        obs: dict = {}
        for frame in response["frames"]:
            offset = frame["offset"]
            w, h = frame["width"], frame["height"]
            fmt = frame["format"]
            if fmt == "depth32f":
                stride = self._stride(w, 4)
                arr = np.frombuffer(self.shm, dtype="<f4", count=stride * h // 4, offset=offset + 128)
                view = arr.reshape(h, stride // 4)[:, :w]
            elif fmt in ("rgba8", "carla-depth-bgra"):
                stride = self._stride(w, 4)
                arr = np.frombuffer(self.shm, dtype=np.uint8, count=stride * h, offset=offset + 128)
                view = arr.reshape(h, stride)[:, : w * 4].reshape(h, w, 4)
            else:
                view = np.frombuffer(self.shm, dtype=np.uint8, count=frame["len"], offset=offset + 128)
            obs.setdefault(frame["sensorId"], {})[frame["pass"]] = view
        return obs, response
