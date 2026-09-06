"""In-process NuRec -> PyTorch sensor path (the direct-tensor branch of the splat backend).

The reconstruction renders into CUDA tensors already; this module hands those results to a
policy in the same process without staging any image on the host. Per registered camera the
consumer opens a *stream*: a bounded pool of `slots`, each a set of preallocated device planes
(one per declared pass). Every `render()` packs the tick's passes into one leased slot per camera
(GPU-local quantize/resample/copy - the same `backend.pack_*` ops the host path uses, so the
bytes are identical to what the shm ring would carry) and returns a `TensorFrame` of leases.

Ownership and synchronization contract (shared with `simforge_native.gpu`)
--------------------------------------------------------------------------
* Producer side: the render and the pack run on the caller's current CUDA stream (the tracer's
  kernels are stream-ordered with torch like the rest of the pipeline; the host path relies on
  the same ordering). After packing, a `ready` event is recorded on that stream.
* Consumer side: `render(consumer_stream=...)` registers the consumer stream (default: torch's
  *actual* current stream on the renderer device at call time) and enqueues a wait on `ready` on
  it before returning, so kernels the consumer launches there observe complete frames without a
  host sync. Any further stream that reads the planes must be registered with
  `TensorLease.wait_on(stream)`; unregistered streams are a consumer bug this module cannot see.
* Exported views are never freed or recycled underneath the consumer. `plane()` returns a torch
  view of the slot storage. `release()` returns the *lease*; the slot is handed back to the pool
  only when no exported tensor aliases its storage any more (checked through the storage use
  count, version-gated below). Until then the slot is *held*: it is neither packed into nor
  freed, and the events that order the producer after the consumer's reads are recorded on the
  registered streams at that actual handback - after every use the views could have had.
  No per-frame host/device synchronization is involved: the check is a refcount read.
* Bounded output memory: one capacity account covers every slot storage - free, leased, held,
  and those of retired streams. `render()` first reclaims held slots whose views are gone; if no
  slot is free it may allocate a replacement slot only while the account stays under
  `output_capacity_bytes`; otherwise it waits up to `wait_ms` for a release or a dropped view,
  then raises `LeaseExhausted`. Default capacity is exactly the declared pools, i.e. retained
  views defer reuse and never grow memory. Slots are never stolen.
* Held views survive later frames, `reset_cameras`, camera re-registration/resize,
  `load_scene_state` and scene eviction: those *retire* the affected streams (no further packing)
  instead of freeing them; a retired stream's slots leave the account as their views drop and
  its leases release. `close_stream` behaves the same. A new stream must be opened afterwards.

What this is not
----------------
* Not zero-copy from a DLPack conversion: one GPU-local pack copy per plane is inherent (float
  radiance -> declared plane format); there is no host copy.
* Not IPC: `torch.Tensor.__dlpack__` on a leased plane is a same-process, same-device handoff.
  A separate process uses `simforge_splat.service` (host shm, declared as such in `hello`).
* Not a second renderer: pixel semantics are `backend.SplatBackend`'s; only the destination differs.
"""
from __future__ import annotations

import logging
import threading
import time
import warnings
from collections import deque
from dataclasses import dataclass
from typing import Any

import torch

from .backend import (
    CapabilityError,
    FrameIdentity,
    SplatBackend,
    SplatSession,
    TickRender,
    output_spec,
    pack_depth,
    pack_id,
    pack_rgb8,
    parse_passes,
)
from .protocol import TENSOR_TRANSPORT as TRANSPORT

log = logging.getLogger("simforge_splat.tensor")

# Host-side poll interval while waiting for a consumer to drop a retained view (no device sync).
_HOLD_POLL_S = 0.002

# pass -> declared plane format -> (dtype, channels). `rgb8` follows the camera's `output`
# size (area resample, exactly the host path's policy view); every other format is published at
# the package's calibrated resolution.
PLANE_FORMATS: dict[str, dict[str, tuple[torch.dtype, int]]] = {
    "rgb": {"rgb8": (torch.uint8, 3), "rgb32f": (torch.float32, 3)},
    "depth": {"depth32f": (torch.float32, 1)},
    "id": {"rgba8": (torch.uint8, 4)},
}


class NuRecTensorError(RuntimeError):
    """Lifecycle/protocol violation on the in-process tensor path."""


class NuRecTensorUnsupported(NuRecTensorError, CapabilityError):
    """The request names a device, stream, channel, format or torch build this path does not provide."""


class LeaseExhausted(NuRecTensorError):
    """Every slot is leased or held by retained views, the capacity is spent, and nothing was
    handed back within `wait_ms`."""


# ------------------------------------------------------------- torch lifetime API (gated)
# Storage use count is the only way to learn whether an exported view (or a tensor rebuilt from
# its DLPack capsule) still aliases a slot. It is a private torch entry point; its presence and
# semantics are checked once, and a torch without it is an explicit capability failure.
def _storage_use_count_api():
    fn = getattr(torch._C, "_storage_Use_Count", None)
    if fn is None:
        raise NuRecTensorUnsupported(
            f"torch {torch.__version__} lacks torch._C._storage_Use_Count; the in-process tensor path cannot "
            "prove exported views are gone before reusing a slot (use simforge_splat.service instead)"
        )
    probe = torch.empty(1)
    base = fn(probe.untyped_storage()._cdata)
    view = probe.view(1)
    with_view = fn(probe.untyped_storage()._cdata)
    del view
    if with_view != base + 1 or fn(probe.untyped_storage()._cdata) != base:
        raise NuRecTensorUnsupported(f"torch {torch.__version__}: _storage_Use_Count does not track tensor views as expected")
    return fn, base


_USE_COUNT, _OWN_REFERENCES = _storage_use_count_api()


def _exported_references(plane: torch.Tensor) -> int:
    """Tensors other than the pool's own that alias `plane`'s storage."""
    return _USE_COUNT(plane.untyped_storage()._cdata) - _OWN_REFERENCES


@dataclass(frozen=True)
class PlaneSpec:
    name: str  # pass: rgb | depth | id
    format: str
    dtype: torch.dtype
    channels: int
    width: int
    height: int

    @property
    def shape(self) -> tuple[int, ...]:
        return (self.height, self.width, self.channels) if self.channels > 1 else (self.height, self.width)

    @property
    def bytes(self) -> int:
        return self.width * self.height * self.channels * torch.empty((), dtype=self.dtype).element_size()

    def wire(self) -> dict[str, Any]:
        return {"name": self.name, "format": self.format, "dtype": str(self.dtype).removeprefix("torch."),
                "channels": self.channels, "width": self.width, "height": self.height, "bytes": self.bytes}


@dataclass(frozen=True)
class StreamInfo:
    sensor_id: str
    stream_id: int
    slots: int
    planes: tuple[PlaneSpec, ...]

    @property
    def slot_bytes(self) -> int:
        return sum(p.bytes for p in self.planes)

    def wire(self) -> dict[str, Any]:
        return {"sensorId": self.sensor_id, "streamId": self.stream_id, "slots": self.slots, "slotBytes": self.slot_bytes,
                "planes": [p.wire() for p in self.planes]}


class _Account:
    """Output-memory capacity shared by every stream of one sensor (live and retired)."""

    def __init__(self, cond: threading.Condition, capacity: int | None):
        self.cond = cond  # guards everything below
        self.capacity = capacity  # None until the first stream fixes the default
        self.used = 0
        self.streams: list["_Stream"] = []

    def reserve(self, n: int) -> bool:
        if self.capacity is not None and self.used + n > self.capacity:
            return False
        self.used += n
        return True

    def free(self, n: int) -> None:
        self.used -= n

    def reclaim(self) -> None:
        """Hand back every held slot whose views are gone; forget drained retired streams."""
        for stream in list(self.streams):
            stream.reclaim()
            if stream.retired and not stream.slots:
                self.streams.remove(stream)


class _Slot:
    __slots__ = ("index", "planes", "ready", "releases", "state", "consumers", "generation")

    def __init__(self, index: int, planes: dict[str, torch.Tensor]):
        self.index = index
        self.planes = planes
        self.ready = torch.cuda.Event()
        self.releases: list[torch.cuda.Event] = []
        self.state = "free"  # free | leased | held
        self.consumers: list[torch.cuda.Stream] = []
        self.generation = 0

    def retained(self) -> bool:
        return any(_exported_references(t) > 0 for t in self.planes.values())

    def record_handback(self) -> None:
        """Order later producer writes after every registered consumer stream's work so far."""
        self.releases = []
        for s in self.consumers:
            ev = torch.cuda.Event()
            ev.record(s)
            self.releases.append(ev)
        self.consumers = []


class _Stream:
    """Bounded slot pool of one camera, charged to the sensor's capacity account."""

    def __init__(self, info: StreamInfo, device: torch.device, account: _Account):
        self.info = info
        self.device = device
        self.account = account
        self.cond = account.cond
        self.retired = False
        self.slots: list[_Slot] = []
        self.free: deque[_Slot] = deque()
        with self.cond:
            if not account.reserve(info.slots * info.slot_bytes):
                raise LeaseExhausted(
                    f"{info.sensor_id}: {info.slots} slots x {info.slot_bytes} B exceed the remaining output capacity "
                    f"({account.capacity - account.used} of {account.capacity} B free); release/drop retained frames or raise output_capacity_bytes"
                )
            for _ in range(info.slots):
                self._add_slot()
            account.streams.append(self)

    def _add_slot(self) -> _Slot:
        slot = _Slot(len(self.slots), {p.name: torch.empty(p.shape, dtype=p.dtype, device=self.device) for p in self.info.planes})
        self.slots.append(slot)
        self.free.append(slot)
        return slot

    def acquire(self, wait_s: float | None) -> _Slot:
        deadline = None if wait_s is None else time.monotonic() + wait_s
        with self.cond:
            while True:
                self.account.reclaim()
                if self.retired:
                    raise NuRecTensorError(f"stream {self.info.stream_id} ({self.info.sensor_id}) is retired")
                if self.free:
                    slot = self.free.popleft()
                    slot.state = "leased"
                    return slot
                # every slot is leased or held by retained views: grow only within the account
                if self.account.reserve(self.info.slot_bytes):
                    slot = self._add_slot()
                    self.free.popleft()
                    slot.state = "leased"
                    return slot
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    held = sum(1 for s in self.slots if s.state == "held")
                    raise LeaseExhausted(
                        f"{self.info.sensor_id}: {len(self.slots)} slots ({held} held by retained views), output capacity "
                        f"{self.account.used}/{self.account.capacity} B spent, nothing handed back within the wait; "
                        "release leases / drop retained tensors or raise output_capacity_bytes"
                    )
                self.cond.wait(_HOLD_POLL_S if remaining is None else min(remaining, _HOLD_POLL_S))

    def give_back(self, slot: _Slot) -> None:
        """Slot returns without ever having been published (render failed)."""
        with self.cond:
            slot.state = "free"
            self.free.append(slot)
            self.cond.notify_all()

    def release(self, slot: _Slot, consumers: list[torch.cuda.Stream]) -> None:
        """The lease ended; hand the slot back now if no view aliases it, else hold it."""
        with self.cond:
            slot.consumers = consumers
            slot.state = "held"
            self._try_handback(slot)
            self.cond.notify_all()

    def reclaim(self) -> None:
        for slot in list(self.slots):
            if slot.state == "held":
                self._try_handback(slot)

    def _try_handback(self, slot: _Slot) -> None:
        if slot.retained():
            return
        slot.record_handback()
        if self.retired:
            self._drop(slot)
        else:
            slot.state = "free"
            self.free.append(slot)

    def _drop(self, slot: _Slot) -> None:
        slot.planes = {}
        self.slots.remove(slot)
        self.account.free(self.info.slot_bytes)

    def retire(self) -> None:
        with self.cond:
            self.retired = True
            for slot in list(self.free):
                self._drop(slot)  # never leased or handed back: nothing can alias it
            self.free.clear()
            self.reclaim()
            self.cond.notify_all()

    def counts(self) -> dict[str, int]:
        c = {"free": 0, "leased": 0, "held": 0}
        for s in self.slots:
            c[s.state] += 1
        return c


class TensorLease:
    """One published slot generation the consumer may read; `release()` ends the lease, holding a
    view keeps the storage (and defers the slot's reuse) beyond it."""

    def __init__(self, stream: _Stream, slot: _Slot, identity: FrameIdentity, consumer_stream: torch.cuda.Stream):
        self._stream = stream
        self._slot = slot
        self.identity = identity
        self.sensor_id = stream.info.sensor_id
        self.stream_id = stream.info.stream_id
        self.slot = slot.index
        self.generation = identity.generation
        self._consumers: list[torch.cuda.Stream] = []
        self._released = False
        self.wait_on(consumer_stream)

    @property
    def released(self) -> bool:
        return self._released

    @property
    def planes(self) -> tuple[PlaneSpec, ...]:
        return self._stream.info.planes

    def wait_on(self, consumer_stream: torch.cuda.Stream) -> "TensorLease":
        """Register another consumer stream: it waits for the frame and joins the handback."""
        if self._released:
            raise NuRecTensorError("lease already released")
        _check_stream(consumer_stream, self._stream.device)
        if all(consumer_stream.cuda_stream != s.cuda_stream for s in self._consumers):
            consumer_stream.wait_event(self._slot.ready)
            self._consumers.append(consumer_stream)
        return self

    def plane(self, name: str) -> torch.Tensor:
        """The declared plane as a torch view of the slot storage (read-only by contract).

        A view alive after `release()` holds the slot: its contents never change while the view
        exists, and the pool does not reuse the slot until every such tensor is gone."""
        if self._released:
            raise NuRecTensorError(f"plane {name!r} of a released lease")
        try:
            base = self._slot.planes[name]
        except KeyError:
            raise NuRecTensorError(f"stream {self.stream_id} ({self.sensor_id}) declares no plane {name!r}") from None
        return base.view(base.shape)

    def tensors(self) -> dict[str, torch.Tensor]:
        return {p.name: self.plane(p.name) for p in self.planes}

    def release(self) -> None:
        """End the lease (idempotent). The slot is handed back once no exported view aliases it."""
        if self._released:
            return
        self._released = True
        self._stream.release(self._slot, self._consumers)

    def synchronize(self) -> None:
        """Host-wait for every registered consumer stream (diagnostics/teardown only)."""
        for s in self._consumers:
            s.synchronize()

    def __enter__(self) -> "TensorLease":
        return self

    def __exit__(self, *_exc) -> None:
        self.release()

    def __del__(self) -> None:
        if not getattr(self, "_released", True):
            warnings.warn(
                f"TensorLease({self.sensor_id}, slot={self.slot}, generation={self.generation}) dropped without release(); releasing late",
                ResourceWarning, stacklevel=1,
            )
            try:
                self.release()
            except Exception:
                pass


class TensorFrame:
    """Every camera's lease for one rendered tick plus the tick's identity/evidence."""

    def __init__(self, tick: TickRender, leases: dict[str, TensorLease], server_ms: float):
        self.identity = tick.identity
        self.sim_tick = tick.identity.sim_tick
        self.passes = tick.passes
        self.leases = leases
        self.visibility = tick.visibility
        self.source_evidence = tick.source_evidence
        self.source_timestamp_us = tick.source_timestamp_us
        self.server_ms = server_ms

    def __getitem__(self, sensor_id: str) -> TensorLease:
        return self.leases[sensor_id]

    @property
    def device(self) -> dict[str, dict[str, int]]:
        """`DeviceReady` per sensor, the same triple the V5 wire carries for device streams."""
        return {sid: {"stream": l.stream_id, "slot": l.slot, "generation": l.generation} for sid, l in self.leases.items()}

    def envelope(self) -> dict[str, Any]:
        """The V5 `render_bundle` envelope minus the host-ring fields (no frames were published)."""
        return {"ok": True, "sim_tick": self.sim_tick, "frame": self.identity.wire(), "frames": [],
                "device": self.device, "visibility": self.visibility, "sourceEvidence": self.source_evidence,
                "server_ms": self.server_ms}

    def release(self) -> None:
        for lease in self.leases.values():
            lease.release()

    def __enter__(self) -> "TensorFrame":
        return self

    def __exit__(self, *_exc) -> None:
        self.release()


def _check_stream(stream: Any, device: torch.device | None) -> torch.cuda.Stream:
    if not isinstance(stream, torch.cuda.Stream):
        raise NuRecTensorUnsupported(f"consumer stream must be a torch.cuda.Stream, got {type(stream).__name__}")
    if device is not None and stream.device != device:
        raise NuRecTensorUnsupported(f"consumer stream is on {stream.device}; the renderer is on {device} (peer-GPU consumption is not provided by this path)")
    return stream


class NuRecTensorSensor:
    """In-process sensor adapter over a `SplatBackend`.

    Call `load_scene_state`, `set_cameras`, `open_stream`, `render` from one owner thread;
    `TensorLease.release()` may come from any thread.

    `output_capacity_bytes` bounds every slot storage this sensor owns (free, leased, held by
    retained views, retired). `None` fixes it to the sum of the pools as they are opened, so
    retained views only defer reuse; a larger value lets `render()` allocate replacement slots up
    to that bound while consumers hold frames.
    """

    def __init__(self, backend: SplatBackend, *, slots: int = 3, wait_ms: int | None = None,
                 output_capacity_bytes: int | None = None):
        if slots < 1:
            raise ValueError("slots must be >= 1")
        if output_capacity_bytes is not None and output_capacity_bytes <= 0:
            raise ValueError("output_capacity_bytes must be positive")
        self.backend = backend
        self.device = backend.device
        self.session = SplatSession()
        self.default_slots = int(slots)
        self.wait_s = None if wait_ms is None else wait_ms / 1000.0
        self._cond = threading.Condition()
        self._account = _Account(self._cond, output_capacity_bytes)
        self._pools_only = output_capacity_bytes is None
        self._streams: dict[str, _Stream] = {}
        self._next_stream_id = 1
        self._closed = False

    @classmethod
    def open(cls, scenes_root, catalog_roots, *, hood, slots: int = 3, wait_ms: int | None = None,
             output_capacity_bytes: int | None = None, **backend_kw) -> "NuRecTensorSensor":
        """`hood`: overlay directory or `"none"` (see `backend.SplatBackend`); explicit, no default."""
        return cls(SplatBackend(scenes_root, catalog_roots, hood=hood, **backend_kw), slots=slots, wait_ms=wait_ms,
                   output_capacity_bytes=output_capacity_bytes)

    # -- capabilities ------------------------------------------------------------
    def capabilities(self) -> dict[str, Any]:
        return {
            "transport": TRANSPORT,
            "device": {"index": self.device.index, "name": torch.cuda.get_device_name(self.device)},
            "renderer": self.backend.renderer_info(),
            "determinism": self.backend.determinism,
            "passes": {name: sorted(formats) for name, formats in PLANE_FORMATS.items()},
            "unsupported": {
                "semantic": "no semantic legend in a reconstruction",
                "jpeg": "no encoder; quantized planes only",
                "lidar/radar": "camera-only backend",
                "separate-process": "use simforge_splat.service (host shm ring, declared host copy)",
                "peer-gpu": "consumer streams must be on the renderer's device",
            },
            "hostStaging": "none in render(); validation copies are explicit consumer actions",
            "dlpack": "torch.Tensor.__dlpack__ on a leased plane: same process, same device; not IPC",
            "leases": {
                "defaultSlots": self.default_slots,
                "waitMs": None if self.wait_s is None else int(self.wait_s * 1000),
                "outputCapacityBytes": self._account.capacity,
                "retention": "a view alive after release() holds its slot (no reuse, no free); handback events are recorded when the last view is gone",
                "viewTracking": f"torch._C._storage_Use_Count (torch {torch.__version__}, probed at import)",
            },
        }

    def memory(self) -> dict[str, Any]:
        """Capacity account and per-stream slot states (live and retired)."""
        with self._cond:
            self._account.reclaim()
            return {
                "capacityBytes": self._account.capacity,
                "usedBytes": self._account.used,
                "streams": [{"streamId": st.info.stream_id, "sensorId": st.info.sensor_id, "retired": st.retired,
                             "slotBytes": st.info.slot_bytes, **st.counts()} for st in self._account.streams],
            }

    # -- resident state ------------------------------------------------------------
    def load_scene_state(self, states: list[dict[str, Any]] | dict[str, Any]) -> dict[str, Any]:
        self._ensure_open()
        docs = [states] if isinstance(states, dict) else list(states)
        previous = self.session.scene_key
        map_id = self.session.load_scene_state(docs)
        scene = self.backend.scene_for(map_id)
        if previous is not None and previous != map_id:
            # calibrated resolutions belong to the package: every open stream is stale
            self._retire_all("scene changed")
        return {"ok": True, "ticks": len(docs), "map_id": map_id, "sceneRevision": self.session.scene_revision,
                "calibratedCameras": {cid: list(scene.camera_resolution(cid)) for cid in scene.scene.cameras}}

    def set_cameras(self, cameras: list[dict[str, Any]]) -> bool:
        """Upsert the retained rig. A changed rig retires the streams of every changed/removed camera."""
        self._ensure_open()
        before = {c["sensorId"]: c for c in self.session.cameras}
        changed = self.session.set_cameras(cameras)
        if changed:
            after = {c["sensorId"]: c for c in self.session.cameras}
            for sid in list(self._streams):
                if sid not in after or after[sid] != before.get(sid):
                    self._retire(sid, "camera re-registered or removed")
        return changed

    def reset_cameras(self) -> None:
        self._ensure_open()
        self.session.reset_cameras()
        self._retire_all("rig reset")

    # -- streams ------------------------------------------------------------------
    def open_stream(self, sensor_id: str, planes: dict[str, str], slots: int | None = None) -> StreamInfo:
        """Allocate `slots` leasable outputs for a registered camera; `planes` maps pass -> format.

        Charged to the capacity account; with the default (pools-only) capacity the account grows
        by exactly this pool, otherwise the pool must fit the remaining capacity.
        """
        self._ensure_open()
        if self.session.scene_key is None:
            raise NuRecTensorError("open_stream: load_scene_state first (plane sizes come from the package calibration)")
        cam_spec = next((c for c in self.session.cameras if c["sensorId"] == sensor_id), None)
        if cam_spec is None:
            raise NuRecTensorError(f"open_stream: camera {sensor_id!r} is not in the retained rig (set_cameras first)")
        if sensor_id in self._streams:
            raise NuRecTensorError(f"open_stream: {sensor_id!r} already has stream {self._streams[sensor_id].info.stream_id}; close it first")
        if not planes:
            raise ValueError("open_stream: declare at least one plane")
        scene = self.backend.scene_for(self.session.scene_key)
        calibrated = scene.camera_resolution(sensor_id)
        spec = output_spec(cam_spec, calibrated)
        declared: list[PlaneSpec] = []
        for name in parse_passes(list(planes)):
            fmt = planes[name]
            try:
                dtype, channels = PLANE_FORMATS[name][fmt]
            except KeyError:
                raise NuRecTensorUnsupported(f"{sensor_id}: pass {name!r} has no plane format {fmt!r}; one of {sorted(PLANE_FORMATS[name])}") from None
            if name == "rgb" and fmt == "rgb8":
                width, height = spec.width, spec.height
            else:
                if name == "rgb" and (spec.width, spec.height) != calibrated:
                    raise NuRecTensorUnsupported(f"{sensor_id}: rgb32f is published at the calibrated {calibrated[0]}x{calibrated[1]} only; declare rgb8 for a resampled view")
                width, height = calibrated
            declared.append(PlaneSpec(name, fmt, dtype, channels, width, height))
        n = int(slots) if slots is not None else self.default_slots
        if n < 1:
            raise ValueError("slots must be >= 1")
        info = StreamInfo(sensor_id, self._next_stream_id, n, tuple(declared))
        with self._cond:
            self._account.reclaim()
            if self._pools_only:
                # the declared pools ARE the capacity: retained views defer reuse, never grow memory
                self._account.capacity = (self._account.capacity or 0) + n * info.slot_bytes
        stream = _Stream(info, self.device, self._account)
        self._next_stream_id += 1
        self._streams[sensor_id] = stream
        return info

    def stream(self, sensor_id: str) -> StreamInfo:
        return self._streams[sensor_id].info

    def close_stream(self, sensor_id: str, grace_ms: int = 0) -> dict[str, Any]:
        """Retire a stream after waiting up to `grace_ms` for outstanding leases. Slots still held
        by retained views stay allocated (and accounted) until those views are gone."""
        stream = self._streams.get(sensor_id)
        if stream is None:
            raise NuRecTensorError(f"close_stream: {sensor_id!r} has no open stream")
        deadline = time.monotonic() + grace_ms / 1000.0
        with self._cond:
            while any(s.state == "leased" for s in stream.slots) and time.monotonic() < deadline:
                self._cond.wait(deadline - time.monotonic())
            outstanding = sum(1 for s in stream.slots if s.state == "leased")
        self._retire(sensor_id, "closed")
        with self._cond:
            held = sum(1 for s in stream.slots if s.state == "held")
        return {"ok": True, "sensor_id": sensor_id, "outstanding_consumer_leases": outstanding,
                "held_by_views": held, "abandoned_producer_leases": 0}

    def outstanding(self) -> int:
        """Leases not yet released (live and retired streams)."""
        with self._cond:
            return sum(sum(1 for s in st.slots if s.state == "leased") for st in self._account.streams)

    def held(self) -> int:
        """Released slots still aliased by consumer views (deferred reuse), live and retired."""
        with self._cond:
            self._account.reclaim()
            return sum(sum(1 for s in st.slots if s.state == "held") for st in self._account.streams)

    # -- rendering ----------------------------------------------------------------
    def render(self, sim_tick: int, consumer_stream: torch.cuda.Stream | None = None) -> TensorFrame:
        """Render the retained rig for `sim_tick` into one leased slot per camera.

        Every retained camera must have an open stream; the pass set rendered is the union of the
        declared planes (each camera receives exactly its declared ones).
        """
        self._ensure_open()
        if not self.session.cameras:
            raise NuRecTensorError("render: no cameras retained (set_cameras first)")
        consumer = _check_stream(consumer_stream, self.device) if consumer_stream is not None else torch.cuda.current_stream(self.device)
        missing = [c["sensorId"] for c in self.session.cameras if c["sensorId"] not in self._streams]
        if missing:
            raise NuRecTensorError(f"render: cameras without an open stream: {missing}")
        passes = parse_passes(sorted({p.name for st in self._streams.values() for p in st.info.planes}))
        t0 = time.perf_counter()
        acquired: list[tuple[_Stream, _Slot]] = []
        try:
            for cam in self.session.cameras:
                stream = self._streams[cam["sensorId"]]
                acquired.append((stream, stream.acquire(self.wait_s)))
            tick = self.backend.render_tick(self.session, sim_tick, passes)
        except BaseException:
            for stream, slot in acquired:
                stream.give_back(slot)
            raise
        producer = torch.cuda.current_stream(self.device)
        by_sensor = {c.sensor_id: c for c in tick.cameras}
        leases: dict[str, TensorLease] = {}
        for stream, slot in acquired:
            render = by_sensor[stream.info.sensor_id]
            for ev in slot.releases:  # the consumers' last reads of this slot precede our writes
                producer.wait_event(ev)
            slot.releases = []
            for plane in stream.info.planes:
                out = slot.planes[plane.name]
                if plane.name == "rgb":
                    if plane.format == "rgb8":
                        pack_rgb8(render.rgb, out)
                    else:
                        out.copy_(render.rgb)
                elif plane.name == "depth":
                    pack_depth(render.depth, out)
                else:
                    pack_id(render.ids, out)
            slot.ready.record(producer)
            slot.generation = tick.identity.generation
            leases[stream.info.sensor_id] = TensorLease(stream, slot, tick.identity, consumer)
        return TensorFrame(tick, leases, (time.perf_counter() - t0) * 1000.0)

    # -- lifecycle ----------------------------------------------------------------
    def _retire(self, sensor_id: str, why: str) -> None:
        stream = self._streams.pop(sensor_id, None)
        if stream is None:
            return
        stream.retire()
        log.info("retired tensor stream %d (%s): %s", stream.info.stream_id, sensor_id, why)

    def _retire_all(self, why: str) -> None:
        for sid in list(self._streams):
            self._retire(sid, why)

    def _ensure_open(self) -> None:
        if self._closed:
            raise NuRecTensorError("sensor is closed")

    def close(self) -> None:
        """Retire every stream. Outstanding leases and retained views stay readable until their own end."""
        if self._closed:
            return
        self._closed = True
        self._retire_all("sensor closed")

    def __enter__(self) -> "NuRecTensorSensor":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()
