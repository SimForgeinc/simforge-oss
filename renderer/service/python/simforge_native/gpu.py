"""GPU-resident consumption of native render outputs (Vulkan → CUDA).

Counterpart of `renderer/render-core/src/gpu_interop.rs`. The renderer
allocates dedicated, exportable Vulkan buffers ("slots") per output stream and
exports, per slot, three opaque file descriptors: the memory, a *ready*
timeline semaphore (signalled by the renderer with the slot's generation on
the submission that fills it) and a *release* timeline semaphore (signalled by
this side, on the consumer's CUDA stream, once its GPU work on the slot has
finished). The renderer never rewrites a slot before its release landed.

What this module does:

* matches the renderer's Vulkan physical-device UUID against CUDA devices and
  imports on that device only (same-host, same-GPU; no pointer integers cross
  the boundary — only descriptors, either in-process or via `SCM_RIGHTS`);
* imports memory with `cuImportExternalMemory` (dedicated) and maps it once;
  imports both timelines with `cuImportExternalSemaphore`;
* exposes each plane of a leased slot as an object implementing
  `__cuda_array_interface__` (strided; the renderer publishes 256-byte aligned
  row strides), consumable zero-copy by PyTorch (`torch.as_tensor`), CuPy,
  Numba, JAX;
* orders the consumer: `cuWaitExternalSemaphoresAsync(ready, generation)` on
  the consumer stream before any kernel touches the plane, and one
  `cuSignalExternalSemaphoresAsync(release, generation)` after every stream
  the lease was used on (joined through events) when the lease is released.

Only the CUDA driver library (`libcuda.so.1`) is required; PyTorch/CuPy are
optional conveniences. Unsupported environments raise
`GpuInteropUnsupported` — there is no host fallback in this module.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import json
import os
import socket
import struct
import sys
import threading
import warnings
import weakref
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

PROTOCOL = "simforge-gpu-interop/1"
WIRE_MAGIC = b"SFGX"
HANDLES_PER_SLOT = 3
SCM_MAX_FD = 253

__all__ = [
    "CudaError",
    "DeviceIdentity",
    "FrameLease",
    "GpuInteropError",
    "GpuInteropUnsupported",
    "ImportedStream",
    "PlaneLayout",
    "PlaneView",
    "StreamManifest",
    "match_cuda_device",
    "receive_stream",
]


class GpuInteropError(RuntimeError):
    """Protocol or lifecycle violation on the consumer side."""


class GpuInteropUnsupported(GpuInteropError):
    """The host cannot import the renderer's handles (no driver, no matching GPU, ...)."""


class CudaError(GpuInteropError):
    def __init__(self, what: str, code: int, name: str):
        super().__init__(f"{what} failed: {name} ({code})")
        self.what = what
        self.code = code
        self.name = name


# --------------------------------------------------------------- CUDA driver API
# Minimal ctypes binding of the driver entry points needed for external
# memory / semaphore interop. Layouts mirror cuda.h (v1 structs; the driver
# ABI keeps them stable) and are size-asserted below.

CUresult = ctypes.c_int
CUdevice = ctypes.c_int
CUcontext = ctypes.c_void_p
CUstream = ctypes.c_void_p
CUevent = ctypes.c_void_p
CUdeviceptr = ctypes.c_ulonglong
CUexternalMemory = ctypes.c_void_p
CUexternalSemaphore = ctypes.c_void_p

CUDA_SUCCESS = 0
CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD = 1
CU_EXTERNAL_MEMORY_DEDICATED = 0x1
CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_TIMELINE_SEMAPHORE_FD = 9
CU_EVENT_DISABLE_TIMING = 0x2


class CUuuid(ctypes.Structure):
    _fields_ = [("bytes", ctypes.c_ubyte * 16)]


class _Win32Handle(ctypes.Structure):
    _fields_ = [("handle", ctypes.c_void_p), ("name", ctypes.c_void_p)]


class _MemHandle(ctypes.Union):
    _fields_ = [("fd", ctypes.c_int), ("win32", _Win32Handle), ("nvSciBufObject", ctypes.c_void_p)]


class CUDA_EXTERNAL_MEMORY_HANDLE_DESC(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("handle", _MemHandle),
        ("size", ctypes.c_ulonglong),
        ("flags", ctypes.c_uint),
        ("reserved", ctypes.c_uint * 16),
    ]


class CUDA_EXTERNAL_MEMORY_BUFFER_DESC(ctypes.Structure):
    _fields_ = [
        ("offset", ctypes.c_ulonglong),
        ("size", ctypes.c_ulonglong),
        ("flags", ctypes.c_uint),
        ("reserved", ctypes.c_uint * 16),
    ]


class _SemHandle(ctypes.Union):
    _fields_ = [("fd", ctypes.c_int), ("win32", _Win32Handle), ("nvSciSyncObj", ctypes.c_void_p)]


class CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("handle", _SemHandle),
        ("flags", ctypes.c_uint),
        ("reserved", ctypes.c_uint * 16),
    ]


class _Fence(ctypes.Structure):
    _fields_ = [("value", ctypes.c_ulonglong)]


class _NvSciSync(ctypes.Union):
    _fields_ = [("fence", ctypes.c_void_p), ("reserved", ctypes.c_ulonglong)]


class _KeyedMutexSignal(ctypes.Structure):
    _fields_ = [("key", ctypes.c_ulonglong)]


class _KeyedMutexWait(ctypes.Structure):
    _fields_ = [("key", ctypes.c_ulonglong), ("timeoutMs", ctypes.c_uint)]


class _SignalParams(ctypes.Structure):
    _fields_ = [
        ("fence", _Fence),
        ("nvSciSync", _NvSciSync),
        ("keyedMutex", _KeyedMutexSignal),
        ("reserved", ctypes.c_uint * 12),
    ]


class CUDA_EXTERNAL_SEMAPHORE_SIGNAL_PARAMS(ctypes.Structure):
    _fields_ = [("params", _SignalParams), ("flags", ctypes.c_uint), ("reserved", ctypes.c_uint * 16)]


class _WaitParams(ctypes.Structure):
    _fields_ = [
        ("fence", _Fence),
        ("nvSciSync", _NvSciSync),
        ("keyedMutex", _KeyedMutexWait),
        ("reserved", ctypes.c_uint * 10),
    ]


class CUDA_EXTERNAL_SEMAPHORE_WAIT_PARAMS(ctypes.Structure):
    _fields_ = [("params", _WaitParams), ("flags", ctypes.c_uint), ("reserved", ctypes.c_uint * 16)]


# Guard the hand-written layouts against the cuda.h definitions.
assert ctypes.sizeof(CUDA_EXTERNAL_MEMORY_HANDLE_DESC) == 104
assert ctypes.sizeof(CUDA_EXTERNAL_MEMORY_BUFFER_DESC) == 88
assert ctypes.sizeof(CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC) == 96
assert ctypes.sizeof(CUDA_EXTERNAL_SEMAPHORE_SIGNAL_PARAMS) == 144
assert ctypes.sizeof(CUDA_EXTERNAL_SEMAPHORE_WAIT_PARAMS) == 144


class _Driver:
    """Lazily loaded libcuda with the entry points this module needs."""

    _lock = threading.Lock()
    _instance: "_Driver | None" = None

    @classmethod
    def get(cls) -> "_Driver":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def __init__(self) -> None:
        lib = None
        for name in ("libcuda.so.1", ctypes.util.find_library("cuda")):
            if not name:
                continue
            try:
                lib = ctypes.CDLL(name)
                break
            except OSError:
                continue
        if lib is None:
            raise GpuInteropUnsupported("libcuda.so.1 not loadable: no NVIDIA driver on this host")
        self.lib = lib
        P = ctypes.POINTER
        proto = {
            "cuInit": ([ctypes.c_uint], None),
            "cuDriverGetVersion": ([P(ctypes.c_int)], None),
            "cuGetErrorName": ([CUresult, P(ctypes.c_char_p)], None),
            "cuDeviceGetCount": ([P(ctypes.c_int)], None),
            "cuDeviceGet": ([P(CUdevice), ctypes.c_int], None),
            "cuDeviceGetUuid": ([P(CUuuid), CUdevice], None),
            "cuDevicePrimaryCtxRetain": ([P(CUcontext), CUdevice], None),
            "cuDevicePrimaryCtxRelease_v2": ([CUdevice], None),
            "cuCtxPushCurrent_v2": ([CUcontext], None),
            "cuCtxPopCurrent_v2": ([P(CUcontext)], None),
            "cuImportExternalMemory": ([P(CUexternalMemory), P(CUDA_EXTERNAL_MEMORY_HANDLE_DESC)], None),
            "cuExternalMemoryGetMappedBuffer": (
                [P(CUdeviceptr), CUexternalMemory, P(CUDA_EXTERNAL_MEMORY_BUFFER_DESC)],
                None,
            ),
            "cuDestroyExternalMemory": ([CUexternalMemory], None),
            "cuMemFree_v2": ([CUdeviceptr], None),
            "cuImportExternalSemaphore": (
                [P(CUexternalSemaphore), P(CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC)],
                None,
            ),
            "cuWaitExternalSemaphoresAsync": (
                [P(CUexternalSemaphore), P(CUDA_EXTERNAL_SEMAPHORE_WAIT_PARAMS), ctypes.c_uint, CUstream],
                None,
            ),
            "cuSignalExternalSemaphoresAsync": (
                [P(CUexternalSemaphore), P(CUDA_EXTERNAL_SEMAPHORE_SIGNAL_PARAMS), ctypes.c_uint, CUstream],
                None,
            ),
            "cuDestroyExternalSemaphore": ([CUexternalSemaphore], None),
            "cuEventCreate": ([P(CUevent), ctypes.c_uint], None),
            "cuEventRecord": ([CUevent, CUstream], None),
            "cuStreamWaitEvent": ([CUstream, CUevent, ctypes.c_uint], None),
            "cuEventDestroy_v2": ([CUevent], None),
            "cuEventSynchronize": ([CUevent], None),
            "cuStreamSynchronize": ([CUstream], None),
            "cuMemcpyDtoH_v2": ([ctypes.c_void_p, CUdeviceptr, ctypes.c_size_t], None),
        }
        for name, (argtypes, _) in proto.items():
            try:
                fn = getattr(lib, name)
            except AttributeError as exc:
                raise GpuInteropUnsupported(f"driver lacks {name}; CUDA >= 11.2 driver required") from exc
            fn.argtypes = argtypes
            fn.restype = CUresult
        # Optional: MIG-aware UUID query (CUDA >= 11.4).
        self.cuDeviceGetUuid_v2 = getattr(lib, "cuDeviceGetUuid_v2", None)
        if self.cuDeviceGetUuid_v2 is not None:
            self.cuDeviceGetUuid_v2.argtypes = [P(CUuuid), CUdevice]
            self.cuDeviceGetUuid_v2.restype = CUresult

        self.check(lib.cuInit(0), "cuInit")
        version = ctypes.c_int()
        self.check(lib.cuDriverGetVersion(ctypes.byref(version)), "cuDriverGetVersion")
        self.version = version.value
        if self.version < 11020:
            raise GpuInteropUnsupported(
                f"CUDA driver {self.version} < 11020: timeline semaphore import unavailable"
            )

    def check(self, code: int, what: str) -> None:
        if code != CUDA_SUCCESS:
            name = ctypes.c_char_p()
            self.lib.cuGetErrorName(code, ctypes.byref(name))
            raise CudaError(what, code, (name.value or b"?").decode())

    # -- devices
    def device_count(self) -> int:
        n = ctypes.c_int()
        self.check(self.lib.cuDeviceGetCount(ctypes.byref(n)), "cuDeviceGetCount")
        return n.value

    def device_uuids(self, ordinal: int) -> set[str]:
        dev = CUdevice()
        self.check(self.lib.cuDeviceGet(ctypes.byref(dev), ordinal), "cuDeviceGet")
        out: set[str] = set()
        for fn, what in ((self.cuDeviceGetUuid_v2, "cuDeviceGetUuid_v2"), (self.lib.cuDeviceGetUuid, "cuDeviceGetUuid")):
            if fn is None:
                continue
            uuid = CUuuid()
            self.check(fn(ctypes.byref(uuid), dev), what)
            out.add(bytes(uuid.bytes).hex())
        return out

    # -- context
    def retain_primary(self, ordinal: int) -> tuple[CUdevice, CUcontext]:
        dev = CUdevice()
        self.check(self.lib.cuDeviceGet(ctypes.byref(dev), ordinal), "cuDeviceGet")
        ctx = CUcontext()
        self.check(self.lib.cuDevicePrimaryCtxRetain(ctypes.byref(ctx), dev), "cuDevicePrimaryCtxRetain")
        return dev, ctx

    def release_primary(self, dev: CUdevice) -> None:
        self.check(self.lib.cuDevicePrimaryCtxRelease_v2(dev), "cuDevicePrimaryCtxRelease")

    def push(self, ctx: CUcontext) -> None:
        self.check(self.lib.cuCtxPushCurrent_v2(ctx), "cuCtxPushCurrent")

    def pop(self) -> None:
        old = CUcontext()
        self.check(self.lib.cuCtxPopCurrent_v2(ctypes.byref(old)), "cuCtxPopCurrent")


def match_cuda_device(device_uuid_hex: str) -> int:
    """CUDA ordinal whose UUID equals the renderer's Vulkan `deviceUUID`."""
    drv = _Driver.get()
    want = device_uuid_hex.replace("-", "").lower()
    seen = []
    for ordinal in range(drv.device_count()):
        uuids = drv.device_uuids(ordinal)
        if want in uuids:
            return ordinal
        seen.append(sorted(uuids))
    raise GpuInteropUnsupported(
        f"no CUDA device with UUID {want}; visible CUDA UUIDs: {seen}. "
        "Renderer and consumer must run on the same physical NVIDIA GPU."
    )


def _stream_handle(stream: Any) -> int:
    """Accept raw CUstream ints, torch.cuda.Stream, cupy.cuda.Stream."""
    if stream is None:
        return 0
    if isinstance(stream, int):
        return stream
    for attr in ("cuda_stream", "ptr", "handle"):
        value = getattr(stream, attr, None)
        if isinstance(value, int):
            return value
    raise TypeError(f"unsupported CUDA stream object {type(stream)!r}")


# ------------------------------------------------------------------- manifest
@dataclass(frozen=True)
class PlaneLayout:
    name: str
    width: int
    height: int
    format: str
    dtype: str
    channels: int
    pixel_bytes: int
    offset: int
    row_stride: int
    bytes: int

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "PlaneLayout":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__})

    @property
    def itemsize(self) -> int:
        return self.pixel_bytes // self.channels

    @property
    def shape(self) -> tuple[int, ...]:
        return (self.height, self.width, self.channels) if self.channels > 1 else (self.height, self.width)

    @property
    def strides(self) -> tuple[int, ...]:
        if self.channels > 1:
            return (self.row_stride, self.pixel_bytes, self.itemsize)
        return (self.row_stride, self.pixel_bytes)


@dataclass(frozen=True)
class DeviceIdentity:
    device_name: str
    vendor_id: int
    device_id: int
    api_version: int
    driver_version: int
    device_uuid: str
    driver_uuid: str

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "DeviceIdentity":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__})


@dataclass(frozen=True)
class StreamManifest:
    protocol: str
    stream_id: int
    label: str
    device: DeviceIdentity
    slots: int
    slot_bytes: int
    allocation_bytes: int
    dedicated: bool
    handle_order: tuple[str, ...]
    planes: tuple[PlaneLayout, ...]

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "StreamManifest":
        if d.get("protocol") != PROTOCOL:
            raise GpuInteropError(f"manifest protocol {d.get('protocol')!r} != {PROTOCOL!r}")
        order = tuple(d["handle_order"])
        if order != ("memory", "ready", "release"):
            raise GpuInteropError(f"unexpected handle order {order}")
        return cls(
            protocol=d["protocol"],
            stream_id=int(d["stream_id"]),
            label=d["label"],
            device=DeviceIdentity.from_dict(d["device"]),
            slots=int(d["slots"]),
            slot_bytes=int(d["slot_bytes"]),
            allocation_bytes=int(d["allocation_bytes"]),
            dedicated=bool(d["dedicated"]),
            handle_order=order,
            planes=tuple(PlaneLayout.from_dict(p) for p in d["planes"]),
        )

    @classmethod
    def from_json(cls, payload: bytes | str) -> "StreamManifest":
        return cls.from_dict(json.loads(payload))

    def plane(self, name: str) -> PlaneLayout:
        for p in self.planes:
            if p.name == name:
                return p
        raise GpuInteropError(f"stream {self.stream_id} has no plane {name!r}")


# --------------------------------------------------------------- CUDA objects
class _Context:
    """Retained primary context of the matched device; push/pop around driver calls."""

    def __init__(self, ordinal: int):
        self.drv = _Driver.get()
        self.ordinal = ordinal
        self.dev, self.ctx = self.drv.retain_primary(ordinal)
        self._closed = False

    def __enter__(self) -> "_Context":
        self.drv.push(self.ctx)
        return self

    def __exit__(self, *_exc) -> None:
        self.drv.pop()

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self.drv.release_primary(self.dev)


class _ExternalMemory:
    """Imported dedicated allocation mapped once for the slot's lifetime."""

    def __init__(self, cx: _Context, fd: int, allocation_bytes: int, mapped_bytes: int, dedicated: bool, owned_fds: list[int]):
        self.cx = cx
        self.handle = CUexternalMemory()
        self.ptr = CUdeviceptr()
        desc = CUDA_EXTERNAL_MEMORY_HANDLE_DESC()
        desc.type = CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD
        desc.handle.fd = fd
        desc.size = allocation_bytes
        desc.flags = CU_EXTERNAL_MEMORY_DEDICATED if dedicated else 0
        with cx:
            # On success CUDA owns `fd` (it must not be closed by us any more).
            cx.drv.check(cx.drv.lib.cuImportExternalMemory(ctypes.byref(self.handle), ctypes.byref(desc)), "cuImportExternalMemory")
            owned_fds.remove(fd)
            bdesc = CUDA_EXTERNAL_MEMORY_BUFFER_DESC()
            bdesc.offset = 0
            bdesc.size = mapped_bytes
            try:
                cx.drv.check(
                    cx.drv.lib.cuExternalMemoryGetMappedBuffer(ctypes.byref(self.ptr), self.handle, ctypes.byref(bdesc)),
                    "cuExternalMemoryGetMappedBuffer",
                )
            except CudaError:
                cx.drv.lib.cuDestroyExternalMemory(self.handle)
                self.handle = CUexternalMemory()
                raise

    def close(self) -> None:
        if self.handle.value is None:
            return
        with self.cx:
            if self.ptr.value:
                self.cx.drv.lib.cuMemFree_v2(self.ptr)
                self.ptr = CUdeviceptr()
            self.cx.drv.lib.cuDestroyExternalMemory(self.handle)
            self.handle = CUexternalMemory()


class _Timeline:
    """Imported Vulkan timeline semaphore."""

    def __init__(self, cx: _Context, fd: int, owned_fds: list[int]):
        self.cx = cx
        self.handle = CUexternalSemaphore()
        desc = CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC()
        desc.type = CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_TIMELINE_SEMAPHORE_FD
        desc.handle.fd = fd
        with cx:
            cx.drv.check(cx.drv.lib.cuImportExternalSemaphore(ctypes.byref(self.handle), ctypes.byref(desc)), "cuImportExternalSemaphore")
            owned_fds.remove(fd)

    def wait(self, value: int, stream: int) -> None:
        params = CUDA_EXTERNAL_SEMAPHORE_WAIT_PARAMS()
        params.params.fence.value = value
        with self.cx:
            self.cx.drv.check(
                self.cx.drv.lib.cuWaitExternalSemaphoresAsync(ctypes.byref(self.handle), ctypes.byref(params), 1, CUstream(stream)),
                "cuWaitExternalSemaphoresAsync",
            )

    def signal(self, value: int, stream: int) -> None:
        params = CUDA_EXTERNAL_SEMAPHORE_SIGNAL_PARAMS()
        params.params.fence.value = value
        with self.cx:
            self.cx.drv.check(
                self.cx.drv.lib.cuSignalExternalSemaphoresAsync(ctypes.byref(self.handle), ctypes.byref(params), 1, CUstream(stream)),
                "cuSignalExternalSemaphoresAsync",
            )

    def close(self) -> None:
        if self.handle.value is None:
            return
        with self.cx:
            self.cx.drv.lib.cuDestroyExternalSemaphore(self.handle)
            self.handle = CUexternalSemaphore()


class _Slot:
    def __init__(self, cx: _Context, manifest: StreamManifest, fds: Sequence[int]):
        mem_fd, ready_fd, release_fd = fds
        owned = [mem_fd, ready_fd, release_fd]
        self.memory: _ExternalMemory | None = None
        self.ready: _Timeline | None = None
        self.release: _Timeline | None = None
        try:
            self.memory = _ExternalMemory(cx, mem_fd, manifest.allocation_bytes, manifest.slot_bytes, manifest.dedicated, owned)
            self.ready = _Timeline(cx, ready_fd, owned)
            self.release = _Timeline(cx, release_fd, owned)
        except Exception:
            self.close()
            for fd in owned:
                os.close(fd)
            raise
        self.leased_generation = 0

    @property
    def base(self) -> int:
        assert self.memory is not None
        return int(self.memory.ptr.value or 0)

    def close(self) -> None:
        for obj in (self.release, self.ready, self.memory):
            if obj is not None:
                obj.close()
        self.release = self.ready = self.memory = None


# ---------------------------------------------------------------------- views
class PlaneView:
    """One plane of a leased slot as a `__cuda_array_interface__` producer.

    Holds a strong reference to its lease and is tracked by it: tensors made
    from this view (torch/cupy/numba keep the producer object alive) keep the
    lease alive, and the lease's release signal is deferred until every view
    is gone. Live tensor storage is never invalidated underneath a consumer.
    """

    def __init__(self, lease: "FrameLease", layout: PlaneLayout, ptr: int, stream: int):
        self.lease = lease
        self.layout = layout
        self.ptr = ptr
        self._stream = stream
        lease._track_view(self)

    @property
    def __cuda_array_interface__(self) -> dict[str, Any]:
        if self.lease.released:
            raise GpuInteropError(f"plane {self.layout.name!r} of a released lease")
        # CAI v3: 0 is disallowed; 1 denotes the legacy default stream.
        stream = self._stream if self._stream not in (0, None) else 1
        return {
            "shape": self.layout.shape,
            "typestr": self.layout.dtype,
            "data": (self.ptr, False),
            "strides": self.layout.strides,
            "version": 3,
            "stream": stream,
        }

    def as_torch(self, device: Any = None):
        """Zero-copy torch tensor on the renderer's GPU.

        Registers torch's *current* stream on that device with the lease
        (ready wait enqueued there; it joins the release), so the tensor may
        be consumed on whatever stream is current now. `device` must name the
        matched CUDA device; any other device would force a copy and is
        rejected.
        """
        import torch  # local import: torch is optional

        ordinal = self.lease.stream_obj.cuda_ordinal
        dev = torch.device("cuda", ordinal) if device is None else torch.device(device)
        index = dev.index if dev.index is not None else torch.cuda.current_device()
        if dev.type != "cuda" or index != ordinal:
            raise GpuInteropError(
                f"as_torch is a no-copy API: renderer memory lives on cuda:{ordinal}, requested {dev}"
            )
        self.lease.wait_on(torch.cuda.current_stream(ordinal))
        return torch.as_tensor(self, device=torch.device("cuda", ordinal))

    def copy_to_host(self) -> bytes:
        """DIAGNOSTIC device→host copy of the padded plane bytes (synchronous).

        Not part of the GPU path; only for validation tooling. Waits on the
        lease's streams first so the copy observes the completed frame.
        """
        self.lease.synchronize()
        buf = ctypes.create_string_buffer(self.layout.bytes)
        cx = self.lease.stream_obj._cx
        with cx:
            cx.drv.check(cx.drv.lib.cuMemcpyDtoH_v2(buf, CUdeviceptr(self.ptr), self.layout.bytes), "cuMemcpyDtoH")
        return buf.raw

    def numpy_from_host(self):
        """DIAGNOSTIC: `copy_to_host()` reshaped/unpadded as a numpy array."""
        import numpy as np

        raw = np.frombuffer(self.copy_to_host(), dtype=np.dtype(self.layout.dtype))
        rows = raw.reshape(self.layout.height, self.layout.row_stride // self.layout.itemsize)
        width_items = self.layout.width * self.layout.channels
        rows = rows[:, :width_items]
        return rows.reshape(self.layout.shape).copy()


class FrameLease:
    """A published slot generation this consumer is allowed to read.

    Lifecycle: created by `ImportedStream.lease` (ready wait enqueued on the
    consumer stream) → kernels on that stream or any stream registered with
    `wait_on` / `as_torch` → `release()`.

    `release()` *requests* the hand-back. The release signal is enqueued
    (stream-ordered after all registered streams) as soon as no `PlaneView`
    — and therefore no tensor built from one — is alive; until then the
    renderer sees the slot as outstanding (bounded backpressure holds) and
    the memory stays valid. `released` becomes true only once the signal was
    enqueued successfully; a failed enqueue leaves the lease retryable.
    Dropping a lease without `release()` behaves like `release()`.
    """

    def __init__(self, stream_obj: "ImportedStream", slot_index: int, generation: int, cuda_stream: int):
        self.stream_obj = stream_obj
        self.slot_index = slot_index
        self.generation = generation
        self._streams: list[int] = []
        self._live_views = 0
        self._release_requested = False
        self._released = False
        self._slot = stream_obj._slots[slot_index]
        self.wait_on(cuda_stream)

    @property
    def released(self) -> bool:
        """Release signal enqueued; the slot is the renderer's again."""
        return self._released

    @property
    def release_requested(self) -> bool:
        return self._release_requested

    @property
    def live_views(self) -> int:
        return self._live_views

    @property
    def streams(self) -> tuple[int, ...]:
        return tuple(self._streams)

    def wait_on(self, cuda_stream: Any) -> "FrameLease":
        """Register another consumer stream: it waits for the frame and joins the release."""
        if self._released:
            raise GpuInteropError("lease already released")
        handle = _stream_handle(cuda_stream)
        if handle not in self._streams:
            assert self._slot.ready is not None
            self._slot.ready.wait(self.generation, handle)
            self._streams.append(handle)
            self.stream_obj._used_streams.add(handle)
        return self

    def plane(self, name: str) -> PlaneView:
        if self._released:
            raise GpuInteropError("lease already released")
        layout = self.stream_obj.manifest.plane(name)
        return PlaneView(self, layout, self._slot.base + layout.offset, self._streams[0] if self._streams else 0)

    def planes(self) -> dict[str, PlaneView]:
        return {p.name: self.plane(p.name) for p in self.stream_obj.manifest.planes}

    def release(self) -> bool:
        """Request the hand-back. Returns True when the release signal was
        enqueued now (or earlier), False when it is deferred behind live views."""
        self._release_requested = True
        if self._released:
            return True
        if self._live_views:
            return False
        self._signal_release()
        return True

    def _signal_release(self) -> None:
        assert self._slot.release is not None
        streams = self._streams
        # No recorded stream means the ready wait itself failed; still hand
        # the slot back so the renderer does not wait on us forever.
        primary = streams[-1] if streams else 0
        if len(streams) > 1:
            self.stream_obj._join_streams(streams[:-1], primary)
        self._slot.release.signal(self.generation, primary)
        self._released = True
        self.stream_obj._lease_finished(self, primary)

    def _track_view(self, view: PlaneView) -> None:
        self._live_views += 1
        weakref.finalize(view, self._view_gone)

    def _view_gone(self) -> None:
        self._live_views -= 1
        if self._release_requested and not self._released and self._live_views == 0:
            try:
                self._signal_release()
            except Exception as exc:  # finalizer context: report, keep lease retryable
                warnings.warn(f"deferred release of slot {self.slot_index} gen {self.generation} failed: {exc}", RuntimeWarning, stacklevel=1)

    def synchronize(self) -> None:
        """Host-wait for every stream this lease was used on (diagnostics/teardown)."""
        cx = self.stream_obj._cx
        with cx:
            for s in self._streams:
                cx.drv.check(cx.drv.lib.cuStreamSynchronize(CUstream(s)), "cuStreamSynchronize")

    def __enter__(self) -> "FrameLease":
        return self

    def __exit__(self, *_exc) -> None:
        self.release()

    def __del__(self) -> None:
        # Views hold the lease strongly, so reaching here means no views exist.
        slot = getattr(self, "_slot", None)
        if getattr(self, "_released", True) or slot is None or slot.release is None:
            return
        if not self._release_requested:
            warnings.warn(
                f"FrameLease(slot={self.slot_index}, generation={self.generation}) dropped without release(); releasing",
                ResourceWarning,
                stacklevel=1,
            )
        try:
            self._signal_release()
        except Exception:
            pass

# --------------------------------------------------------------------- stream
class ImportedStream:
    """All slots of one renderer stream imported into CUDA on the matching GPU."""

    def __init__(self, manifest: StreamManifest, fds: Sequence[int], cuda_device: int | None = None):
        if len(fds) != manifest.slots * HANDLES_PER_SLOT:
            for fd in fds:
                os.close(fd)
            raise GpuInteropError(f"expected {manifest.slots * HANDLES_PER_SLOT} handles, got {len(fds)}")
        try:
            ordinal = match_cuda_device(manifest.device.device_uuid)
        except Exception:
            for fd in fds:
                os.close(fd)
            raise
        if cuda_device is not None and cuda_device != ordinal:
            for fd in fds:
                os.close(fd)
            raise GpuInteropUnsupported(
                f"renderer GPU {manifest.device.device_uuid} is CUDA device {ordinal}, not requested {cuda_device}"
            )
        self.manifest = manifest
        self.cuda_ordinal = ordinal
        self._cx = _Context(ordinal)
        self._slots: list[_Slot] = []
        self._leases: "weakref.WeakSet[FrameLease]" = weakref.WeakSet()
        self._used_streams: set[int] = set()
        self._completion_events: list[CUevent] = []
        self._closed = False
        self._torn_down = False
        try:
            for i in range(manifest.slots):
                self._slots.append(_Slot(self._cx, manifest, fds[i * HANDLES_PER_SLOT:(i + 1) * HANDLES_PER_SLOT]))
        except Exception:
            # Slots after the failing one still own their fds.
            for fd in fds[len(self._slots) * HANDLES_PER_SLOT + HANDLES_PER_SLOT:]:
                os.close(fd)
            self.close()
            raise

    # -- construction helpers
    @classmethod
    def from_handles(cls, manifest: Mapping[str, Any] | StreamManifest | bytes | str, fds: Sequence[int], cuda_device: int | None = None) -> "ImportedStream":
        """In-process hand-off: manifest (dict/JSON) + raw fds from
        `ExportedStream::into_parts`. Ownership of the fds transfers here."""
        if isinstance(manifest, (bytes, str)):
            manifest = StreamManifest.from_json(manifest)
        elif not isinstance(manifest, StreamManifest):
            manifest = StreamManifest.from_dict(manifest)
        return cls(manifest, list(fds), cuda_device)

    @classmethod
    def receive(cls, sock: socket.socket, cuda_device: int | None = None) -> "ImportedStream":
        """Receive `ExportedStream::send_over_unix` from a Unix socket."""
        manifest, fds = receive_stream(sock)
        return cls(manifest, fds, cuda_device)

    # -- leases
    @property
    def device(self) -> DeviceIdentity:
        return self.manifest.device

    def default_stream(self) -> int:
        """Current torch stream on the matched device if torch is loaded, else the legacy default stream."""
        torch = sys.modules.get("torch")
        if torch is not None and getattr(torch, "cuda", None) is not None and torch.cuda.is_available():
            return int(torch.cuda.current_stream(self.cuda_ordinal).cuda_stream)
        return 0

    def lease(self, slot: int, generation: int, cuda_stream: Any = None) -> FrameLease:
        """Enqueue the ready wait for (slot, generation) on `cuda_stream` and
        return the lease. `slot`/`generation` come from the renderer's
        `ReadyFrame` control message; a stale/duplicate generation is rejected."""
        if self._closed:
            raise GpuInteropError("stream closed")
        if not 0 <= slot < len(self._slots):
            raise GpuInteropError(f"slot {slot} out of range for {len(self._slots)} slots")
        s = self._slots[slot]
        if generation <= s.leased_generation:
            raise GpuInteropError(
                f"slot {slot} generation {generation} is not newer than already leased {s.leased_generation}"
            )
        handle = _stream_handle(cuda_stream) if cuda_stream is not None else self.default_stream()
        lease = FrameLease(self, slot, generation, handle)
        s.leased_generation = generation
        self._leases.add(lease)
        return lease

    def lease_from_notice(self, notice: Mapping[str, Any], cuda_stream: Any = None) -> FrameLease:
        """`notice` is a serialized `ReadyFrame` (`stream_id`, `slot`, `generation`)."""
        if int(notice["stream_id"]) != self.manifest.stream_id:
            raise GpuInteropError(f"notice for stream {notice['stream_id']}, this is {self.manifest.stream_id}")
        return self.lease(int(notice["slot"]), int(notice["generation"]), cuda_stream)

    def outstanding(self) -> int:
        """Leases whose release signal has not been enqueued yet (includes
        releases deferred behind live tensor views)."""
        return sum(1 for l in list(self._leases) if not l.released)

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def torn_down(self) -> bool:
        """Imports destroyed; only true after every lease and view is gone."""
        return self._torn_down

    # -- internals
    def _join_streams(self, waiters: Iterable[int], target: int) -> None:
        drv = self._cx.drv
        with self._cx:
            for s in waiters:
                ev = CUevent()
                drv.check(drv.lib.cuEventCreate(ctypes.byref(ev), CU_EVENT_DISABLE_TIMING), "cuEventCreate")
                try:
                    drv.check(drv.lib.cuEventRecord(ev, CUstream(s)), "cuEventRecord")
                    drv.check(drv.lib.cuStreamWaitEvent(CUstream(target), ev, 0), "cuStreamWaitEvent")
                finally:
                    drv.lib.cuEventDestroy_v2(ev)

    def _lease_finished(self, lease: FrameLease, stream: int) -> None:
        """Called once the lease's release signal is enqueued on `stream`.
        Records a completion event there so teardown can wait for the GPU
        without per-frame host synchronisation."""
        self._leases.discard(lease)
        drv = self._cx.drv
        ev = CUevent()
        with self._cx:
            drv.check(drv.lib.cuEventCreate(ctypes.byref(ev), CU_EVENT_DISABLE_TIMING), "cuEventCreate")
            try:
                drv.check(drv.lib.cuEventRecord(ev, CUstream(stream)), "cuEventRecord")
            except CudaError:
                drv.lib.cuEventDestroy_v2(ev)
                raise
        self._completion_events.append(ev)
        if self._closed:
            self._maybe_teardown()

    def _maybe_teardown(self) -> bool:
        if self._torn_down:
            return True
        if any(not l.released for l in list(self._leases)):
            return False
        self._torn_down = True
        drv = self._cx.drv
        with self._cx:
            for ev in self._completion_events:
                try:
                    drv.check(drv.lib.cuEventSynchronize(ev), "cuEventSynchronize")
                finally:
                    drv.lib.cuEventDestroy_v2(ev)
        self._completion_events.clear()
        for slot in self._slots:
            slot.close()
        self._slots.clear()
        self._cx.close()
        return True

    # -- teardown
    def close(self) -> bool:
        """Stop handing out leases and request release of every live lease.

        Imports are destroyed only once every lease's release signal has been
        enqueued — i.e. after all tensor views built from them are gone — and
        the GPU work recorded on the consumer streams has completed. Returns
        True if teardown happened now; otherwise it completes automatically
        when the last view/lease is dropped (`torn_down` reports it).
        """
        if self._torn_down:
            return True
        self._closed = True
        for lease in list(self._leases):
            if not lease.released:
                lease.release()
        return self._maybe_teardown()

    def __enter__(self) -> "ImportedStream":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass


# --------------------------------------------------------------- wire receive
def _recv_exact(sock: socket.socket, n: int) -> bytes:
    out = bytearray()
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise GpuInteropError("socket closed while receiving stream manifest")
        out += chunk
    return bytes(out)


def receive_stream(sock: socket.socket) -> tuple[StreamManifest, list[int]]:
    """Read one `WIRE_MAGIC ++ u32le(len) ++ JSON` frame with its SCM_RIGHTS fds.

    Returns the manifest and the fds in manifest order (memory, ready,
    release per slot). The caller owns the fds until they are imported.
    """
    data, fds, _flags, _addr = socket.recv_fds(sock, 8, SCM_MAX_FD)
    fds = list(fds)
    try:
        if not data:
            raise GpuInteropError("socket closed before stream manifest")
        if len(data) < 8:
            data += _recv_exact(sock, 8 - len(data))
        if data[:4] != WIRE_MAGIC:
            raise GpuInteropError(f"bad interop frame magic {data[:4]!r}")
        (length,) = struct.unpack("<I", data[4:8])
        manifest = StreamManifest.from_json(_recv_exact(sock, length))
        if len(fds) != manifest.slots * HANDLES_PER_SLOT:
            raise GpuInteropError(f"manifest lists {manifest.slots} slots but {len(fds)} handles arrived")
    except Exception:
        for fd in fds:
            os.close(fd)
        raise
    return manifest, fds
