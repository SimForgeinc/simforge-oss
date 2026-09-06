"""In-process native renderer: `libsimforge_render` (renderer/ffi) via ctypes.

The same resident scene and V5 request/response contract as the socket
service, without the socket: requests are JSON documents answered on the
calling thread. Host frames are published into the shm ring the renderer
was opened with and read through the same strided views as the socket
client; device streams hand their exported memory/semaphore descriptors
over as raw fds for `simforge_native.gpu.ImportedStream.from_handles`, so a
same-process CUDA consumer never touches host bytes.

All calls on one `EmbeddedRenderer` must come from the thread that opened it.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import json
import mmap
import os
from typing import Any

PROTOCOL = 5
ABI = 1


class EmbeddedRendererError(RuntimeError):
    pass


RUNTIME_ROOT_ENV = "SIMFORGE_NATIVE_RUNTIME_ROOT"
LIBRARY_ENV = "SIMFORGE_RENDER_LIB"


def default_runtime_root() -> str:
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.environ.get(RUNTIME_ROOT_ENV) or os.path.join(data, "simforge", "native-runtime")


def library_candidates(path: str | None = None) -> list[str]:
    """Resolution order: explicit path, `$SIMFORGE_RENDER_LIB`, the installed
    runtime root's `lib/libsimforge_render.so`, then the loader path."""
    return [
        c
        for c in (
            path,
            os.environ.get(LIBRARY_ENV),
            os.path.join(default_runtime_root(), "lib", "libsimforge_render.so"),
            ctypes.util.find_library("simforge_render"),
        )
        if c
    ]


def find_library(path: str | None = None) -> str | None:
    return next((c for c in library_candidates(path) if os.path.exists(c)), None)


def _load(path: str | None) -> ctypes.CDLL:
    found = find_library(path)
    if found is None:
        raise EmbeddedRendererError(
            f"libsimforge_render.so not found (looked at {library_candidates(path)}); install the native "
            f"runtime ({RUNTIME_ROOT_ENV}) or set {LIBRARY_ENV}"
        )
    return ctypes.CDLL(found)


class EmbeddedRenderer:
    """One resident renderer opened from a scene document."""

    def __init__(self, scene: dict | str, shm_path: str, shm_size_bytes: int = 256 * 1024 * 1024,
                 library: str | None = None):
        self._lib = lib = _load(library)
        lib.simforge_render_abi.restype = ctypes.c_int
        lib.simforge_render_protocol.restype = ctypes.c_int
        lib.simforge_render_open.restype = ctypes.c_void_p
        lib.simforge_render_open.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint64,
                                             ctypes.POINTER(ctypes.c_void_p)]
        lib.simforge_render_request.restype = ctypes.c_void_p
        lib.simforge_render_request.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        lib.simforge_render_take_export.restype = ctypes.c_void_p
        lib.simforge_render_take_export.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int),
                                                    ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        lib.simforge_render_free_string.restype = None
        lib.simforge_render_free_string.argtypes = [ctypes.c_void_p]
        lib.simforge_render_close.restype = None
        lib.simforge_render_close.argtypes = [ctypes.c_void_p]
        if lib.simforge_render_abi() != ABI or lib.simforge_render_protocol() != PROTOCOL:
            raise EmbeddedRendererError(
                f"libsimforge_render abi {lib.simforge_render_abi()} / protocol "
                f"{lib.simforge_render_protocol()}; this module expects {ABI} / {PROTOCOL}"
            )
        scene_json = scene if isinstance(scene, str) else json.dumps(scene)
        error = ctypes.c_void_p()
        self._handle = lib.simforge_render_open(scene_json.encode(), shm_path.encode(), shm_size_bytes,
                                                ctypes.byref(error))
        if not self._handle:
            message = self._take_string(error.value) or "unknown error"
            raise EmbeddedRendererError(message)
        self.shm_path = shm_path
        with open(shm_path, "rb") as f:
            self.shm = mmap.mmap(f.fileno(), 0, prot=mmap.PROT_READ)
        self._seq = 0

    def _take_string(self, ptr: int | None) -> str | None:
        if not ptr:
            return None
        try:
            return ctypes.string_at(ptr).decode()
        finally:
            self._lib.simforge_render_free_string(ptr)

    # -- protocol ------------------------------------------------------------
    def request(self, op: str, **fields: Any) -> dict:
        """Serve one V5 request; raises on `ok: false`."""
        if not self._handle:
            raise EmbeddedRendererError("renderer is closed")
        self._seq += 1
        document = json.dumps({"i": self._seq, "op": op, **fields})
        response = json.loads(self._take_string(self._lib.simforge_render_request(self._handle, document.encode())))
        if not response.get("ok"):
            raise EmbeddedRendererError(response.get("error", "request failed"))
        return response

    def render_bundle(self, sim_tick: int, **fields: Any) -> dict:
        return self.request("render_bundle", sim_tick=sim_tick, **fields)

    def open_device_stream(self, sensor_id: str, passes: list[str], slots: int,
                           wait_ms: int | None = None) -> dict:
        fields: dict[str, Any] = {"sensor_id": sensor_id, "passes": passes, "slots": slots}
        if wait_ms is not None:
            fields["wait_ms"] = wait_ms
        return self.request("open_device_stream", **fields)

    def import_device_stream(self, sensor_id: str, cuda_device: int | None = None):
        """Export a sensor's device stream and import it into CUDA in-process."""
        from .gpu import HANDLES_PER_SLOT, ImportedStream

        ack = self.request("export_device_stream", sensor_id=sensor_id)
        capacity = int(ack["slots"]) * HANDLES_PER_SLOT
        fds = (ctypes.c_int * capacity)()
        count = ctypes.c_size_t()
        manifest = self._take_string(
            self._lib.simforge_render_take_export(self._handle, fds, capacity, ctypes.byref(count))
        )
        if manifest is None:
            raise EmbeddedRendererError(
                f"no exported handles for {sensor_id} (needed {count.value}, offered {capacity})"
            )
        return ImportedStream.from_handles(manifest, list(fds)[: count.value], cuda_device)

    def close_device_stream(self, sensor_id: str, grace_ms: int = 0) -> dict:
        return self.request("close_device_stream", sensor_id=sensor_id, grace_ms=grace_ms)

    @staticmethod
    def lease_device_frame(imported, response: dict, sensor_id: str, cuda_stream=None):
        ready = response["device"][sensor_id]
        if int(ready["stream"]) != imported.manifest.stream_id:
            raise EmbeddedRendererError(
                f"bundle names stream {ready['stream']}, imported {imported.manifest.stream_id}"
            )
        return imported.lease(int(ready["slot"]), int(ready["generation"]), cuda_stream)

    def read_record(self, frame: dict) -> memoryview:
        """Raw payload bytes (row-padded) of one FrameRecord in the shm ring."""
        offset = frame["offset"] + 128
        return memoryview(self.shm)[offset:offset + frame["len"]]

    # -- lifecycle -------------------------------------------------------------
    def close(self) -> None:
        if self._handle:
            try:
                self.request("close")
            finally:
                self._lib.simforge_render_close(self._handle)
                self._handle = None
                self.shm.close()

    def __enter__(self) -> "EmbeddedRenderer":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()
