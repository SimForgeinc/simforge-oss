"""``RoadwayGpuBatch``: N independent episodes of one admitted document on a CUDA device.

Steady-state contract
---------------------
``reset`` and ``step`` launch kernels and device-to-device copies only. No
per-world Python loop, no ``.numpy()`` / ``.item()`` on the hot path, no
host-side event or reward assembly. The only host traffic per decision is the
caller's own action upload (also a device array when the policy runs on the
same device) and whatever the caller chooses to read back.

Output ownership and streams
----------------------------
All producer work runs on one explicit Warp stream owned by the batch. Every
``reset``/``step`` publishes its outputs into one slot of a bounded ring of
*owned* device buffers and returns it as an :class:`OutputLease`. A slot is
handed back — and only then may be rewritten — when **both** hold:

1. the consumer called ``lease.release()`` (or left the ``with`` block), and
2. every piece of Torch *storage* exported by ``lease.torch()`` has been
   freed. Exports are built with ``torch.as_tensor`` from a lease-owned
   ``__cuda_array_interface__`` producer (:class:`SlotView`); Torch's storage
   deleter holds that producer, so ``detach()``, dtype views, slices,
   ``view()``, DLPack re-imports and any other alias of the storage keep the
   producer alive. The lease tracks the producers by weak reference and defers
   the handback until the last one is collected, keeping total storage bounded
   to ``lease_slots``.

``lease.torch()`` registers the consuming Torch stream: the consumer stream
waits (device-side) for the producer's readiness event before the tensors are
returned, and at handback an event recorded on every registered consumer
stream is waited for by the producer before the slot is reused. Additional
consumer streams are registered explicitly with ``lease.register_stream``; a
consumer may also hand an explicit event to ``release``. There is no host
synchronisation anywhere in this protocol. When every slot is retained the
next call raises :class:`LeaseExhaustedError` rather than mutating a view.

A world that terminated or truncated is *ended*: further ``step`` calls skip
it on device (its outputs keep the final values) until the caller includes it
in a ``reset`` mask. This keeps the ended check on device too; a consumer that
wants Gymnasium auto-reset semantics passes ``done`` straight back as the
reset mask.

Determinism
-----------
Per-world seeds are recorded, hashed into the checkpoint identity and exposed
on every result. In the admitted profile no seeded subsystem exists (ambient
driver variation is rejected at admission), so two worlds with different seeds
and identical actions produce identical trajectories — exactly as the reference
``EnvSession.reset(seed)`` does for such documents. They are still carried so a
future admitted seeded feature cannot silently change the contract.
"""

from __future__ import annotations

import hashlib
import json
import math
import weakref
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

import numpy as np

from . import kernels as K
from .errors import (
    ActionShapeError,
    BackendUnavailableError,
    CheckpointIncompatibleError,
    EpisodeStateError,
    LeaseExhaustedError,
)
from .lane_graph import LaneGraph
from .profile import (
    CAPACITIES,
    NUMERICS_NOTES,
    OBJECT_FEATURES,
    PROFILE_ID,
    STATE_VECTOR_SIZE,
    Numerics,
    ReproducibilityClass,
)
from .scenario import CompiledScenario, EpisodeConfig, compile_scenario

try:  # warp is a hard dependency of this package; guard only to give a clear error
    import warp as wp
except ImportError as exc:  # pragma: no cover
    raise BackendUnavailableError("simforge-oss-gpu requires warp-lang >= 1.17") from exc


CHECKPOINT_FORMAT = "simforge.gpu-batch-checkpoint/1"


@dataclass(frozen=True)
class ActionBatch:
    """Zero-order-hold ego actions for every world.

    ``values`` is ``(N, 9)`` float64: motionDirection, targetSpeedMps,
    targetAccelerationMps2, previewPoint.x, previewPoint.y (xodr-local),
    previewHeadingRad, control.throttle, control.brake, control.steer.
    ``valid`` is ``(N, 7)`` int32: pending, motionDirection, targetSpeed,
    targetAcceleration, previewPoint, previewHeading, control. A row with
    ``pending == 0`` is the reference ``pendingAction === null`` (no override);
    ``pending == 1`` with all other flags zero is ``step({})``.
    Both arrays live on the batch device.
    """

    values: "wp.array"
    valid: "wp.array"
    #: Event recorded on the stream that produced the arrays; the batch's
    #: producer stream waits for it before reading (``None`` = already ordered
    #: on the producer stream or produced synchronously from the host).
    ready_event: Any = None

    @staticmethod
    def hold_choreography(num_worlds: int, device: str) -> "ActionBatch":
        """``step({})`` for every world: the authored choreography drives the ego."""
        valid = np.zeros((num_worlds, K.AV_N), dtype=np.int32)
        valid[:, 0] = 1
        return ActionBatch(
            wp.zeros((num_worlds, K.AC_N), dtype=wp.float64, device=device),
            wp.array(valid, dtype=wp.int32, device=device),
        )

    @staticmethod
    def from_dicts(actions: Sequence[Mapping[str, Any] | None], device: str) -> "ActionBatch":
        """Host-side encoder of ``EnvAction`` dicts (tooling and tests; not the hot path)."""
        n = len(actions)
        values = np.zeros((n, K.AC_N), dtype=np.float64)
        valid = np.zeros((n, K.AV_N), dtype=np.int32)
        for i, action in enumerate(actions):
            if action is None:
                continue
            valid[i, 0] = 1
            if "motionDirection" in action:
                valid[i, 1] = 1
                values[i, 0] = float(action["motionDirection"])
            if "targetSpeedMps" in action:
                valid[i, 2] = 1
                values[i, 1] = float(action["targetSpeedMps"])
            if "targetAccelerationMps2" in action:
                valid[i, 3] = 1
                values[i, 2] = float(action["targetAccelerationMps2"])
            if "previewPoint" in action:
                valid[i, 4] = 1
                values[i, 3] = float(action["previewPoint"]["x"])
                values[i, 4] = float(action["previewPoint"]["y"])
            if "previewHeadingRad" in action:
                valid[i, 5] = 1
                values[i, 5] = float(action["previewHeadingRad"])
            if "control" in action:
                valid[i, 6] = 1
                c = action["control"]
                values[i, 6] = float(c["throttle"])
                values[i, 7] = float(c["brake"])
                values[i, 8] = float(c["steer"])
        return ActionBatch(wp.array(values, dtype=wp.float64, device=device), wp.array(valid, dtype=wp.int32, device=device))

    @staticmethod
    def from_torch(values: Any, valid: Any, stream: Any = None) -> "ActionBatch":
        """Wrap device tensors without copying (``values`` float64 ``(N, 9)``,
        ``valid`` int32 ``(N, 7)``). ``stream`` is the Torch stream that wrote
        them (default: Torch's current stream for the tensor device); an event
        is recorded on it so ``step`` orders the read after the policy's kernels
        without host synchronisation. Call again after every policy update, or
        call :meth:`mark_ready` on a reused batch."""
        batch = ActionBatch(wp.from_torch(values, dtype=wp.float64), wp.from_torch(valid, dtype=wp.int32))
        return batch.mark_ready(stream if stream is not None else _torch_current_stream(values.device))

    def mark_ready(self, torch_stream: Any) -> "ActionBatch":
        """Record readiness of the action arrays on ``torch_stream`` (a
        ``torch.cuda.Stream``) and return ``self``."""
        producer = wp.stream_from_torch(torch_stream)
        object.__setattr__(self, "ready_event", producer.record_event())
        return self


def _torch_current_stream(device: Any) -> Any:
    import torch

    return torch.cuda.current_stream(device)


def _as_warp_event(event: Any, device: str) -> "wp.Event":
    if isinstance(event, wp.Event):
        return event
    # torch.cuda.Event exposes the raw CUevent handle
    return wp.Event(device, cuda_event=event.cuda_event)


OUTPUT_FIELDS: tuple[str, ...] = (
    "t_s", "state_vector", "objects", "objects_valid", "reward", "reward_terms", "terminated", "truncated", "ended",
    "actor_state", "actor_flags", "physics_state",
)
# output field -> State array it is published from
_OUTPUT_SOURCE = {
    "t_s": "t_out", "state_vector": "state_vector", "objects": "obj", "objects_valid": "obj_valid", "reward": "reward",
    "reward_terms": "reward_terms", "terminated": "terminated", "truncated": "truncated", "ended": "ended",
    "actor_state": "sem", "actor_flags": "flags", "physics_state": "phys",
}


_TYPESTR = {"float64": "<f8", "int32": "<i4", "int8": "|i1"}


class SlotView:
    """``__cuda_array_interface__`` producer for one field of a leased slot.

    Held by the Torch storage deleter of every tensor created from it, so the
    lease can observe the storage's lifetime (not the first wrapper's) through a
    weak reference to this object."""

    __slots__ = ("lease", "name", "_cai", "__weakref__")

    def __init__(self, lease: "OutputLease", name: str, array: "wp.array", stream_handle: int) -> None:
        self.lease = lease
        self.name = name
        # CAI v3: 0 is disallowed; 1 denotes the legacy default stream.
        stream = stream_handle if stream_handle not in (0, None) else 1
        self._cai = {
            "shape": tuple(int(d) for d in array.shape),
            "typestr": _TYPESTR[array.dtype.__name__],
            "data": (int(array.ptr), False),
            "strides": tuple(int(s) for s in array.strides),
            "version": 3,
            "stream": stream,
        }

    @property
    def __cuda_array_interface__(self) -> dict[str, Any]:
        if self.lease.released:
            raise EpisodeStateError(f"field {self.name!r} of a released lease")
        return self._cai


class OutputLease:
    """Owned device outputs of one ``reset``/``step``.

    Fields (all ``warp.array`` on the batch device, valid until handback):

    * ``t_s`` (N) float64 snapshot time
    * ``state_vector`` (N, 10) float64 — observations.ts layout
    * ``objects`` (N, A, 4) float64 [range, bearing, rangeRate, los], rows in actor-slot order
    * ``objects_valid`` (N, A) int32 gate mask (ego row always 0)
    * ``reward`` (N) float64; ``reward_terms`` (N, 5) [progress, proximity, comfort, collision, goal]
    * ``terminated``, ``truncated``, ``ended`` (N) int32
    * ``actor_state`` (N, A, 14) float64 (``kernels.SEM_*``), ``actor_flags`` (N, A, 12) int32 (``kernels.FL_*``),
      ``physics_state`` (N, A, 15) float64 (``kernels.PH_*``)

    Lifecycle: ``torch()`` exports tensors aliasing the slot and registers the
    consuming stream; ``release()`` requests handback; the slot is actually
    handed back when the release was requested *and* every exported storage
    (including every derived view of it) has been freed. ``released`` becomes
    true only at that point.
    """

    __slots__ = ("_batch", "slot", "generation", "released", "release_requested", "seeds", "_ready",
                 "_streams", "_exports", "_release_event", "__weakref__") + OUTPUT_FIELDS

    def __init__(self, batch: "RoadwayGpuBatch", slot: int, generation: int, arrays: Mapping[str, "wp.array"],
                 seeds: np.ndarray, ready: "wp.Event") -> None:
        self._batch = batch
        self.slot = slot
        self.generation = generation
        self.released = False
        self.release_requested = False
        self.seeds = seeds
        self._ready = ready
        self._streams: list[Any] = []
        self._exports: set[weakref.ref] = set()
        self._release_event: Any = None
        for name in OUTPUT_FIELDS:
            setattr(self, name, arrays[name])

    # ----------------------------------------------------------- exports

    def torch(self, stream: Any = None) -> dict[str, Any]:
        """Zero-copy PyTorch tensors aliasing the leased slot, ordered after
        the producer on ``stream`` (a ``torch.cuda.Stream``; default: Torch's
        current stream on the batch device). The stream is registered as a
        consumer for the handback fence."""
        self._check()
        import torch

        torch_stream = stream if stream is not None else _torch_current_stream(self._batch.torch_device)
        consumer = self.register_stream(torch_stream)
        consumer.wait_event(self._ready)
        device = self._batch.torch_device
        tensors: dict[str, Any] = {}
        for name in OUTPUT_FIELDS:
            view = SlotView(self, name, getattr(self, name), torch_stream.cuda_stream)
            # torch.as_tensor from a CAI producer wraps the memory with a storage
            # deleter that keeps `view` alive for as long as the storage exists.
            tensors[name] = torch.as_tensor(view, device=device)
            self._exports.add(weakref.ref(view, self._export_collected))
        return tensors

    def register_stream(self, torch_stream: Any) -> "wp.Stream":
        """Register an additional consuming Torch stream (returns its Warp
        view). An event is recorded on every registered stream at handback."""
        self._check()
        stream = wp.stream_from_torch(torch_stream)
        if all(s.cuda_stream != stream.cuda_stream for s in self._streams):
            self._streams.append(stream)
        return stream

    def numpy(self) -> dict[str, np.ndarray]:
        """Owned host copies (synchronises the device; diagnostics, conformance and tests only)."""
        self._check()
        wp.synchronize_event(self._ready)
        return {name: getattr(self, name).numpy() for name in OUTPUT_FIELDS}

    # ----------------------------------------------------------- release

    def release(self, consumer_event: Any = None) -> None:
        """Request handback. ``consumer_event`` (``warp.Event`` or
        ``torch.cuda.Event`` recorded after the consumer's last use) is waited
        for by the producer in addition to the registered streams' events. The
        slot is handed back now if no exported tensor is alive, otherwise as
        soon as the last one is collected."""
        if self.released or self.release_requested:
            return
        self.release_requested = True
        self._release_event = consumer_event
        self._try_handback()

    @property
    def exported_views_alive(self) -> int:
        """Number of exported storages (producers) still alive."""
        return sum(1 for ref in self._exports if ref() is not None)

    def _export_collected(self, ref: weakref.ref) -> None:
        self._exports.discard(ref)
        if self.release_requested and not self.released:
            self._try_handback()

    def _try_handback(self) -> None:
        if self.exported_views_alive > 0:
            return
        events: list["wp.Event"] = []
        if self._release_event is not None:
            events.append(_as_warp_event(self._release_event, self._batch.device))
        for stream in self._streams:
            events.append(stream.record_event())
        self._batch._release_slot(self.slot, self.generation, events)
        self.released = True
        self._streams = []
        self._release_event = None

    def _check(self) -> None:
        if self.released or self.release_requested:
            raise EpisodeStateError("lease already released")

    def __enter__(self) -> "OutputLease":
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()


class _Slot:
    __slots__ = ("arrays", "leased", "generation", "pending_events")

    def __init__(self, arrays: dict[str, "wp.array"]) -> None:
        self.arrays = arrays
        self.leased = False
        self.generation = 0
        self.pending_events: list["wp.Event"] = []


@dataclass
class Checkpoint:
    """Complete resumable device state of every world plus the identity needed to
    refuse restoring it into a different batch."""

    format: str
    profile_id: str
    document_digest: str
    topology_digest: str
    episode_digest: str
    num_worlds: int
    seeds: np.ndarray
    arrays: dict[str, np.ndarray] = field(default_factory=dict)

    def identity(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "profileId": self.profile_id,
            "documentDigest": self.document_digest,
            "topologyDigest": self.topology_digest,
            "episodeDigest": self.episode_digest,
            "numWorlds": self.num_worlds,
        }


_STATE_ARRAYS = (
    "tick", "t", "finished", "prev_coll_t_valid", "prev_coll_t", "active_pair", "ego_collision", "goal_fired",
    "decision_count", "prev_ego_s_valid", "prev_ego_s", "ended", "terminated", "truncated", "reward", "reward_terms",
    "action_f", "action_valid", "state_vector", "t_out", "sem", "flags", "cmd", "phys", "snap", "snap_live",
    "conf", "conf_n", "obj", "obj_valid", "prev_range", "prev_range_valid", "it_state", "it_time",
)


def _episode_digest(episode: EpisodeConfig) -> str:
    payload = json.dumps(
        {
            "decisionHz": episode.decision_hz, "clipSeconds": episode.clip_seconds, "warmupExcluded": episode.warmup_excluded,
            "maxDecisions": episode.max_decisions, "goalInteractionId": episode.goal_interaction_id,
            "goalRouteEnd": episode.goal_route_end, "reward": episode.reward, "stateVector": episode.state_vector,
            "objectListRangeM": episode.object_list_range_m,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _pad_rows(arr: np.ndarray, width: int, dtype: Any) -> np.ndarray:
    """Warp arrays need at least one element; padded rows are never indexed
    because every kernel loop is bounded by the compiled counts."""
    if arr.size == 0:
        return np.zeros((1, width), dtype=dtype) if width > 0 else np.zeros(1, dtype=dtype)
    return arr


class RoadwayGpuBatch:
    """Batched ``roadway-dynamic-gpu-v1`` execution of one admitted document."""

    def __init__(
        self,
        document: Mapping[str, Any],
        graph: LaneGraph,
        *,
        num_worlds: int,
        episode: EpisodeConfig | Mapping[str, Any] | None = None,
        device: str = "cuda:0",
        seeds: Sequence[int] | None = None,
        use_cuda_graph: bool = True,
        lease_slots: int = 4,
    ) -> None:
        if num_worlds <= 0 or num_worlds > CAPACITIES["maxWorlds"]:
            raise EpisodeStateError(f"num_worlds must be in 1..{CAPACITIES['maxWorlds']}, got {num_worlds}")
        self.scenario: CompiledScenario = compile_scenario(dict(document), graph, episode)
        self.num_worlds = int(num_worlds)
        dev = wp.get_device(device)
        if not dev.is_cuda:
            raise BackendUnavailableError(
                f"{PROFILE_ID} executes on CUDA devices; {device!r} is not a CUDA device. "
                "The CPU reference is the native simforge-core engine, not this package."
            )
        self.device = str(dev)
        self.use_cuda_graph = bool(use_cuda_graph) and dev.is_cuda
        self.episode_digest = _episode_digest(self.scenario.episode)
        self.seeds = np.asarray(seeds if seeds is not None else np.arange(num_worlds), dtype=np.int64)
        if self.seeds.shape != (num_worlds,):
            raise EpisodeStateError(f"seeds must have shape ({num_worlds},), got {self.seeds.shape}")
        if lease_slots < 1:
            raise EpisodeStateError("lease_slots must be >= 1")
        self._static = self._build_static()
        self._state = self._allocate_state()
        self._slots = [_Slot(self._allocate_slot()) for _ in range(lease_slots)]
        self._next_slot = 0
        self._generation = 0
        #: Explicit producer stream; every launch and publication copy runs here.
        self.stream = wp.Stream(self.device)
        self._graph = None
        self._graph_actions: ActionBatch | None = None
        self._has_reset = False
        wp.load_module(K, device=self.device)

    # ------------------------------------------------------------ metadata

    @property
    def torch_device(self) -> Any:
        """``torch.device`` of the batch (for stream registration)."""
        import torch

        return torch.device("cuda", wp.get_device(self.device).ordinal)

    @property
    def actor_ids(self) -> list[str]:
        return list(self.scenario.actor_ids)

    @property
    def ego_id(self) -> str:
        return self.scenario.actor_ids[self.scenario.ego_index]

    def capabilities(self) -> dict[str, Any]:
        """Profile / numerics / capacity metadata for the runner and bindings."""
        sc = self.scenario
        return {
            "profileId": PROFILE_ID,
            "backend": "warp-cuda",
            "device": self.device,
            "warpVersion": wp.config.version,
            "numerics": Numerics.DEVICE_F64.value,
            "reproducibility": {
                "sameBatch": ReproducibilityClass.SAME_BUILD_REPLAY.value,
                "againstCpuReference": ReproducibilityClass.CROSS_BACKEND_MEASURED.value,
            },
            "numericsNotes": list(NUMERICS_NOTES),
            "cudaGraph": self.use_cuda_graph,
            "capacities": dict(CAPACITIES),
            "compiled": dict(sc.counts),
            "documentDigest": sc.document_digest,
            "topologyDigest": sc.topology_digest,
            "episodeDigest": self.episode_digest,
            "numWorlds": self.num_worlds,
            "decisionTicks": sc.decision_ticks,
            "dt": sc.dt,
            "substepS": sc.substep_s,
            "stateVectorSize": STATE_VECTOR_SIZE,
            "objectFeatures": OBJECT_FEATURES,
            "actorIds": list(sc.actor_ids),
            "egoId": self.ego_id,
            "hostSyncOnHotPath": False,
        }

    # ------------------------------------------------------------ lifecycle

    def reset(self, mask: Sequence[bool] | np.ndarray | None = None, seeds: Sequence[int] | None = None) -> OutputLease:
        """Rebuild the masked worlds (all when ``mask`` is None) and consume the
        warm-up prologue so the returned observation sits at ``t = 0``."""
        n = self.num_worlds
        if mask is None:
            mask_np = np.ones(n, dtype=np.int32)
        else:
            mask_np = np.asarray(mask).astype(np.int32).reshape(n)
        if seeds is not None:
            seeds_np = np.asarray(seeds, dtype=np.int64).reshape(n)
            self.seeds = np.where(mask_np == 1, seeds_np, self.seeds)
        mask_dev = wp.array(mask_np, dtype=wp.int32, device=self.device)
        st, s = self._static, self._state
        slot = self._acquire_slot()
        with wp.ScopedStream(self.stream):
            wp.launch(K.k_reset_world, dim=n, inputs=[st, s, mask_dev])
            wp.launch(K.k_set_active_from_mask, dim=n, inputs=[s, mask_dev])
            warmup_ticks = (self.scenario.warmup_ticks + 1) if self.scenario.episode.warmup_excluded else 0
            for _ in range(warmup_ticks):
                self._launch_tick()
            wp.launch(K.k_observe_objects, dim=(n, st.n_actors), inputs=[st, s, wp.float64(0.0)])
            wp.launch(K.k_observe_world, dim=n, inputs=[st, s, 1])
            self._publish(slot)
        self._has_reset = True
        return self._lease(slot)

    def step(self, actions: ActionBatch) -> OutputLease:
        """Apply one policy decision to every non-ended world and advance
        ``decisionTicks`` engine ticks. Returns an owned lease; raises
        :class:`LeaseExhaustedError` when every slot is still retained."""
        if not self._has_reset:
            raise EpisodeStateError("step() before reset()")
        n = self.num_worlds
        if tuple(actions.values.shape) != (n, K.AC_N):
            raise ActionShapeError((n, K.AC_N), tuple(actions.values.shape), "actions.values")
        if tuple(actions.valid.shape) != (n, K.AV_N):
            raise ActionShapeError((n, K.AV_N), tuple(actions.valid.shape), "actions.valid")
        slot = self._acquire_slot()
        with wp.ScopedStream(self.stream):
            if actions.ready_event is not None:
                self.stream.wait_event(actions.ready_event)
            if self.use_cuda_graph:
                self._step_graph(actions)
            else:
                self._launch_decision(actions)
            self._publish(slot)
        return self._lease(slot)

    # ------------------------------------------------------------ leases

    def _acquire_slot(self) -> int:
        """Round-robin scan for a genuinely free slot."""
        count = len(self._slots)
        for offset in range(count):
            idx = (self._next_slot + offset) % count
            if not self._slots[idx].leased:
                self._next_slot = (idx + 1) % count
                return idx
        raise LeaseExhaustedError(
            f"all {count} output slots are retained (released leases still have live exported tensors count too); "
            "release a lease and drop its tensors before the next reset/step"
        )

    def _publish(self, idx: int) -> None:
        """Device-to-device copy of the working arrays into the owned slot,
        ordered after the consumer's release event on the batch stream."""
        slot = self._slots[idx]
        for event in slot.pending_events:
            self.stream.wait_event(event)
        slot.pending_events = []
        for name in OUTPUT_FIELDS:
            wp.copy(slot.arrays[name], getattr(self._state, _OUTPUT_SOURCE[name]), stream=self.stream)
        self._generation += 1
        slot.generation = self._generation
        slot.leased = True

    def _lease(self, idx: int) -> OutputLease:
        slot = self._slots[idx]
        ready = self.stream.record_event()
        return OutputLease(self, idx, slot.generation, slot.arrays, self.seeds.copy(), ready)

    def _release_slot(self, idx: int, generation: int, consumer_events: list["wp.Event"]) -> None:
        slot = self._slots[idx]
        if slot.generation != generation or not slot.leased:
            return
        slot.pending_events = list(consumer_events)
        slot.leased = False

    def _allocate_slot(self) -> dict[str, "wp.array"]:
        s = self._state
        return {
            name: wp.zeros(getattr(s, _OUTPUT_SOURCE[name]).shape, dtype=getattr(s, _OUTPUT_SOURCE[name]).dtype, device=self.device)
            for name in OUTPUT_FIELDS
        }

    # ------------------------------------------------------------ checkpoint

    def checkpoint(self) -> Checkpoint:
        """Complete mutable state of every world (host copy; synchronises)."""
        wp.synchronize_stream(self.stream)
        arrays = {name: getattr(self._state, name).numpy().copy() for name in _STATE_ARRAYS}
        arrays["sbody_n"] = self._state.sbody_n.numpy().copy()
        return Checkpoint(
            format=CHECKPOINT_FORMAT, profile_id=PROFILE_ID, document_digest=self.scenario.document_digest,
            topology_digest=self.scenario.topology_digest, episode_digest=self.episode_digest,
            num_worlds=self.num_worlds, seeds=self.seeds.copy(), arrays=arrays,
        )

    def restore(self, checkpoint: Checkpoint) -> OutputLease:
        mine = Checkpoint(CHECKPOINT_FORMAT, PROFILE_ID, self.scenario.document_digest, self.scenario.topology_digest,
                          self.episode_digest, self.num_worlds, self.seeds).identity()
        theirs = checkpoint.identity()
        mismatches = [f"{k}: {theirs[k]!r} != {mine[k]!r}" for k in mine if theirs.get(k) != mine[k]]
        if mismatches:
            raise CheckpointIncompatibleError("; ".join(mismatches))
        for name in _STATE_ARRAYS:
            target = getattr(self._state, name)
            source = checkpoint.arrays[name]
            if tuple(source.shape) != tuple(target.shape):
                raise CheckpointIncompatibleError(f"{name}: shape {source.shape} != {target.shape}")
            wp.copy(target, wp.array(source, dtype=target.dtype, device=self.device), stream=self.stream)
        self.seeds = np.asarray(checkpoint.seeds, dtype=np.int64).copy()
        self._has_reset = True
        slot = self._acquire_slot()
        with wp.ScopedStream(self.stream):
            self._publish(slot)
        return self._lease(slot)

    # ------------------------------------------------------------ internals

    def _launch_tick(self) -> None:
        st, s = self._static, self._state
        n, a = self.num_worlds, st.n_actors
        wp.launch(K.k_tick_begin, dim=n, inputs=[st, s])
        wp.launch(K.k_detect_collisions, dim=n, inputs=[st, s])
        wp.launch(K.k_triggers, dim=n, inputs=[st, s])
        wp.launch(K.k_conflict_samples, dim=(n, a), inputs=[st, s])
        wp.launch(K.k_plan, dim=(n, a), inputs=[st, s])
        wp.launch(K.k_apply, dim=(n, a), inputs=[st, s])
        wp.launch(K.k_contacts, dim=n, inputs=[st, s])
        wp.launch(K.k_tick_end, dim=n, inputs=[st, s])

    def _launch_decision(self, actions: ActionBatch) -> None:
        st, s = self._static, self._state
        n = self.num_worlds
        wp.launch(K.k_set_active_not_ended, dim=n, inputs=[s])
        wp.launch(K.k_decision_begin, dim=n, inputs=[s, actions.values, actions.valid])
        for _ in range(self.scenario.decision_ticks):
            self._launch_tick()
        wp.launch(K.k_observe_objects, dim=(n, st.n_actors), inputs=[st, s, wp.float64(1.0 / self.scenario.episode.decision_hz)])
        wp.launch(K.k_observe_world, dim=n, inputs=[st, s, 0])

    def _step_graph(self, actions: ActionBatch) -> None:
        """Capture the decision once into a CUDA graph. The action arrays are
        baked into the graph by pointer, so a caller must keep writing into the
        same ``ActionBatch`` storage; a different storage recaptures."""
        if self._graph is None or self._graph_actions is None or (
            self._graph_actions.values.ptr != actions.values.ptr or self._graph_actions.valid.ptr != actions.valid.ptr
        ):
            with wp.ScopedCapture(stream=self.stream) as capture:
                self._launch_decision(actions)
            self._graph = capture.graph
            self._graph_actions = actions
        wp.capture_launch(self._graph, stream=self.stream)

    def _build_static(self) -> "K.Static":
        sc = self.scenario
        ep = sc.episode
        t = sc.tables
        st = K.Static()
        st.n_actors = sc.num_actors
        st.n_colliders = sc.counts["colliders"]
        st.n_occluders = sc.counts["occluders"]
        st.n_interactions = sc.counts["interactions"]
        st.ego = sc.ego_index
        st.perception_ego = sc.perception_ego_index
        st.goal_interaction = sc.interaction_ids.index(ep.goal_interaction_id) if ep.goal_interaction_id in sc.interaction_ids else -1
        st.goal_route_end = int(ep.goal_route_end)
        st.dt = sc.dt
        count = max(1, math.ceil(sc.dt / sc.substep_s - 1e-12))
        st.substep_count = count
        st.substep_h = sc.dt / count
        st.warmup_ticks = sc.warmup_ticks
        st.total_ticks = sc.warmup_ticks + sc.clip_ticks
        st.friction_scale = sc.friction_scale
        st.visibility_range_m = sc.visibility_range_m
        st.traffic_speed_factor = sc.traffic_speed_factor
        st.object_list_range_m = ep.object_list_range_m
        st.clip_seconds = sc.clip_seconds
        st.dt_decision_s = 1.0 / ep.decision_hz
        st.max_decisions = int(ep.max_decisions) if ep.max_decisions is not None else 0
        st.rw_collision_penalty = ep.reward["collisionPenalty"]
        st.rw_goal_bonus = ep.reward["goalBonus"]
        st.rw_progress_weight = ep.reward["progressWeight"]
        st.rw_proximity_weight = ep.reward["proximityWeight"]
        st.rw_proximity_range_m = ep.reward["proximityRangeM"]
        st.rw_comfort_weight = ep.reward["comfortAccelWeight"]

        def dev(name: str, dtype: Any) -> "wp.array":
            arr = t[name]
            if arr.size == 0:
                arr = _pad_rows(arr, arr.shape[1] if arr.ndim == 2 else 0, arr.dtype)
            return wp.array(arr, dtype=dtype, device=self.device)

        i32, f64 = wp.int32, wp.float64
        for name in ("lane_pt_start", "lane_pt_count", "lane_ws_start", "lane_ws_count"):
            setattr(st, name, dev(name, i32))
        for name in ("lane_pt_x", "lane_pt_y", "lane_pt_cum", "lane_pt_heading", "lane_ws_s", "lane_ws_w",
                     "lane_length", "lane_speed_limit", "lane_width"):
            setattr(st, name, dev(name, f64))
        for name in ("actor_kind", "actor_static", "actor_dynamic", "actor_dynamics_model", "actor_present_at_start",
                     "actor_cruise_override_valid", "actor_motion_direction", "actor_route_leg_start",
                     "actor_route_leg_count", "actor_pedestrian_like", "actor_knockdown_vulnerable", "actor_road_actor",
                     "leg_lane", "leg_reversed", "solver_body_order", "it_actor", "it_verb", "it_trigger"):
            setattr(st, name, dev(name, i32))
        for name in ("actor_cruise_override", "actor_route_length", "leg_s_start", "leg_length"):
            setattr(st, name, dev(name, f64))
        for name in ("actor_dims", "actor_rules", "actor_comfort", "actor_limits", "actor_physics", "actor_init",
                     "collider_obb", "occluder_obb", "it_f", "cond_leaf", "polygon_pts"):
            setattr(st, name, dev(name, f64))
        st.it_i = dev("it_i", i32)
        st.cond_root = dev("cond_root", i32)
        return st

    def _allocate_state(self) -> "K.State":
        n = self.num_worlds
        a = self.scenario.num_actors
        b = a + self.scenario.counts["colliders"]
        it = max(1, self.scenario.counts["interactions"])
        s = K.State()
        d = self.device
        z = lambda shape, dtype: wp.zeros(shape, dtype=dtype, device=d)  # noqa: E731
        s.active = z(n, wp.int32)
        s.tick = z(n, wp.int32)
        s.t = z(n, wp.float64)
        s.finished = z(n, wp.int32)
        s.prev_coll_t_valid = z(n, wp.int32)
        s.prev_coll_t = z(n, wp.float64)
        s.active_pair = z((n, a, b), wp.int8)
        s.detected = z((n, a, b), wp.int8)
        s.ego_collision = z(n, wp.int32)
        s.goal_fired = z(n, wp.int32)
        s.decision_count = z(n, wp.int32)
        s.prev_ego_s_valid = z(n, wp.int32)
        s.prev_ego_s = z(n, wp.float64)
        s.ended = z(n, wp.int32)
        s.terminated = z(n, wp.int32)
        s.truncated = z(n, wp.int32)
        s.reward = z(n, wp.float64)
        s.reward_terms = z((n, K.RW_N), wp.float64)
        s.action_f = z((n, K.AC_N), wp.float64)
        s.action_valid = z((n, K.AV_N), wp.int32)
        s.state_vector = z((n, STATE_VECTOR_SIZE), wp.float64)
        s.t_out = z(n, wp.float64)
        s.sem = z((n, a, K.SEM_N), wp.float64)
        s.flags = z((n, a, K.FL_N), wp.int32)
        s.cmd = z((n, a, K.CMD_N), wp.float64)
        s.phys = z((n, a, K.PH_N), wp.float64)
        s.snap = z((n, a, 3), wp.float64)
        s.snap_live = z((n, a), wp.int32)
        s.plan = z((n, a, K.PL_N), wp.float64)
        s.conf = z((n, a, 14, 2), wp.float64)
        s.conf_n = z((n, a), wp.int32)
        s.obj = z((n, a, OBJECT_FEATURES), wp.float64)
        s.obj_valid = z((n, a), wp.int32)
        s.prev_range = z((n, a), wp.float64)
        s.prev_range_valid = z((n, a), wp.int32)
        s.it_state = z((n, it, K.IT_N), wp.int32)
        s.it_time = z((n, it, 2), wp.float64)
        s.sbody = z((n, b, K.SB_N), wp.float64)
        s.sbody_slot = z((n, b), wp.int32)
        s.sbody_n = z(n, wp.int32)
        s.speed_before = z((n, a), wp.float64)
        return s
