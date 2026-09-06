"""Lease ownership contract: a slot is never rewritten while any exported
storage — including detached / dtype-viewed / sliced aliases whose original
wrapper is gone — is still alive.

The protocol tests run on the host with a stand-in producer. The CUDA test
exercises the real ``torch.as_tensor`` storage-deleter retention on a device
and is skipped without one.
"""

from __future__ import annotations

import gc
import weakref

import numpy as np
import pytest

warp = pytest.importorskip("warp")

from simforge_oss_gpu import LeaseExhaustedError  # noqa: E402
from simforge_oss_gpu import batch as B  # noqa: E402


class _RingOnly:
    """Minimal batch stand-in: only the slot ring and release bookkeeping."""

    device = "cpu"
    stream = None

    def __init__(self, slots: int) -> None:
        self._slots = [B._Slot({n: warp.zeros(2, dtype=warp.float64, device="cpu") for n in B.OUTPUT_FIELDS}) for _ in range(slots)]
        self._next_slot = 0
        self._generation = 0

    _acquire_slot = B.RoadwayGpuBatch._acquire_slot
    _release_slot = B.RoadwayGpuBatch._release_slot

    def lease(self) -> B.OutputLease:
        idx = self._acquire_slot()
        slot = self._slots[idx]
        self._generation += 1
        slot.generation = self._generation
        slot.leased = True
        return B.OutputLease(self, idx, slot.generation, slot.arrays, np.zeros(1), None)


class _Storage:
    """Stands in for a Torch storage that retains the SlotView producer."""

    def __init__(self, producer: object) -> None:
        self.producer = producer


class _Producer:
    __slots__ = ("__weakref__",)


def _export(lease: B.OutputLease) -> _Storage:
    producer = _Producer()
    lease._exports.add(weakref.ref(producer, lease._export_collected))
    return _Storage(producer)


def test_handback_waits_for_every_alias_of_exported_storage() -> None:
    ring = _RingOnly(slots=1)
    lease = ring.lease()
    storage = _export(lease)
    original, detached, sliced = storage, storage, storage  # aliases share the storage
    lease.release()
    assert lease.release_requested and not lease.released
    del original
    with pytest.raises(LeaseExhaustedError):
        ring.lease()
    del detached
    gc.collect()
    assert not lease.released
    del sliced, storage
    gc.collect()
    assert lease.released
    assert ring.lease().slot == 0


def test_acquire_scans_for_free_slot_not_only_next() -> None:
    ring = _RingOnly(slots=2)
    first = ring.lease()
    second = ring.lease()
    second.release()
    gc.collect()
    assert second.released
    # _next_slot points at slot 0 (still leased); slot 1 is free.
    assert ring.lease().slot == 1
    first.release()


@pytest.mark.skipif(not warp.is_cuda_available(), reason="needs a CUDA device")
def test_detach_del_original_blocks_slot_reuse_on_device() -> None:
    """The exact case: detach(), drop the original wrapper, then request the
    next output. The slot must stay retained until the detached alias dies."""
    import torch

    class _Batch(_RingOnly):
        device = "cuda:0"

        def __init__(self) -> None:
            self.stream = warp.Stream(self.device)
            self._slots = [B._Slot({n: warp.zeros((4, 3), dtype=warp.float64, device=self.device) for n in B.OUTPUT_FIELDS})]
            self._next_slot = 0
            self._generation = 0

        @property
        def torch_device(self):
            return torch.device("cuda", 0)

        def lease(self) -> B.OutputLease:
            idx = self._acquire_slot()
            slot = self._slots[idx]
            self._generation += 1
            slot.generation = self._generation
            slot.leased = True
            return B.OutputLease(self, idx, slot.generation, slot.arrays, np.zeros(1), self.stream.record_event())

    batch = _Batch()
    lease = batch.lease()
    tensors = lease.torch()
    detached = tensors["state_vector"].detach()
    as_int = tensors["reward"].view(torch.int64)
    sliced = tensors["objects"][1:3]
    del tensors
    gc.collect()
    lease.release()
    assert not lease.released
    with pytest.raises(LeaseExhaustedError):
        batch.lease()
    del detached, as_int
    gc.collect()
    assert not lease.released
    del sliced
    gc.collect()
    assert lease.released
    assert batch.lease().slot == 0
