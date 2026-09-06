"""Typed records crossing the adapter boundary: reset options, step results,
snapshots and the errors a consumer must handle."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

import numpy as np

from .profile import PROFILE_ID, Backend
from .workload import StartRegion


class PhysicsAdapterError(Exception):
    """Base class for adapter errors."""


class BackendCapabilityError(PhysicsAdapterError):
    """The requested backend cannot execute this model/configuration."""


class BackendUnavailableError(BackendCapabilityError):
    """A backend's runtime dependency or device is missing."""


class ContactCapacityError(PhysicsAdapterError):
    """A batched world exceeded its declared contact/constraint capacity.

    Overflow is an error, never a silent drop of contacts."""


class SnapshotIncompatibleError(PhysicsAdapterError):
    """Snapshot identity does not match the restoring session."""


class EpisodeStateError(PhysicsAdapterError):
    """API call out of episode order (step before reset, step after end)."""


@dataclass(frozen=True)
class ResetOptions:
    """Deterministic reset parameters. ``seed`` drives the pose jitter only."""

    start: StartRegion = "approach"
    #: Uniform lateral jitter bound applied to the start pose.
    lateral_jitter_m: float = 0.05
    #: Uniform yaw jitter bound (rad) about the surface normal.
    yaw_jitter_rad: float = 0.035
    #: Extra height along the surface normal (free-fall qualification).
    height_offset_m: float = 0.0

    def sample_pose_offsets(self, seed: int) -> tuple[float, float]:
        """(lateral_offset_m, yaw_rad) from ``numpy.random.default_rng(seed)``
        (PCG64). Recorded on the snapshot so a reset is reconstructable."""
        rng = np.random.default_rng(seed)
        lateral = float(rng.uniform(-self.lateral_jitter_m, self.lateral_jitter_m)) if self.lateral_jitter_m else 0.0
        yaw = float(rng.uniform(-self.yaw_jitter_rad, self.yaw_jitter_rad)) if self.yaw_jitter_rad else 0.0
        return lateral, yaw


@dataclass(frozen=True)
class StepResult:
    """One decision's outcome for one world.

    ``observation`` is a float64 copy laid out per ``OBSERVATION_LAYOUT``; it is
    never aliased to solver memory, so retaining it across steps is safe.
    """

    observation: np.ndarray
    reward: float
    terminated: bool
    truncated: bool
    tick: int
    time_s: float
    info: Mapping[str, Any] = field(default_factory=dict)

    @property
    def done(self) -> bool:
        return self.terminated or self.truncated


@dataclass(frozen=True)
class BatchStepResult:
    """One decision's outcome for ``n`` worlds; arrays have leading dim ``n``."""

    observation: np.ndarray
    reward: np.ndarray
    terminated: np.ndarray
    truncated: np.ndarray
    tick: np.ndarray
    time_s: np.ndarray
    info: Mapping[str, np.ndarray] = field(default_factory=dict)

    def world(self, index: int) -> StepResult:
        return StepResult(
            observation=self.observation[index].copy(),
            reward=float(self.reward[index]),
            terminated=bool(self.terminated[index]),
            truncated=bool(self.truncated[index]),
            tick=int(self.tick[index]),
            time_s=float(self.time_s[index]),
            info={k: v[index].item() if hasattr(v[index], "item") else v[index] for k, v in self.info.items()},
        )


@dataclass(frozen=True)
class Snapshot:
    """Complete resumable state of one world plus the identity needed to
    refuse restoring it anywhere else.

    ``state`` is the MuJoCo state vector for ``state_spec`` (a
    ``mujoco.mjtState`` bitmask). The CPU backend stores
    ``mjSTATE_INTEGRATION`` (time, qpos, qvel, act, ctrl, applied forces,
    mocap, warm-start); the Warp backend stores what the device exposes:
    ``mjSTATE_FULLPHYSICS | mjSTATE_CTRL``. ``state_spec_name`` says which.
    """

    profile_id: str
    backend: str
    workload_id: str
    workload_digest: str
    mujoco_version: str
    state_spec: int
    state_spec_name: str
    state: np.ndarray
    tick: int
    time_s: float
    seed: int
    start: StartRegion
    lateral_offset_m: float
    yaw_rad: float
    prev_x_m: float
    finished: bool

    def to_dict(self) -> dict[str, Any]:
        d = {k: getattr(self, k) for k in self.__dataclass_fields__}
        d["state"] = [float(v) for v in self.state.tolist()]
        return d

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Snapshot":
        fields = dict(d)
        fields["state"] = np.asarray(fields["state"], dtype=np.float64)
        return cls(**fields)

    def check_compatible(self, *, backend: Backend, workload_digest: str, mujoco_version: str, state_spec: int) -> None:
        mismatches = []
        if self.profile_id != PROFILE_ID:
            mismatches.append(f"profile {self.profile_id!r} != {PROFILE_ID!r}")
        if self.backend != backend.value:
            mismatches.append(f"backend {self.backend!r} != {backend.value!r}")
        if self.workload_digest != workload_digest:
            mismatches.append("workload digest differs")
        if self.mujoco_version != mujoco_version:
            mismatches.append(f"mujoco {self.mujoco_version!r} != {mujoco_version!r}")
        if self.state_spec != state_spec:
            mismatches.append(f"state spec {self.state_spec} != {state_spec}")
        if mismatches:
            raise SnapshotIncompatibleError("; ".join(mismatches))
