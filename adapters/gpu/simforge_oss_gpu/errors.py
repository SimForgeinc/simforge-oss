"""Errors a consumer of the GPU batch must handle."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AdmissionIssue:
    """One reason a document cannot run on this profile."""

    code: str
    path: str
    message: str

    def __str__(self) -> str:
        return f"{self.code} at {self.path}: {self.message}"


class GpuBatchError(Exception):
    """Base class for this package's errors."""


class ProfileAdmissionError(GpuBatchError):
    """The document uses features outside the profile or exceeds a capacity.

    All issues are collected before raising so an author sees the whole gap,
    not the first offending field."""

    def __init__(self, issues: list[AdmissionIssue]) -> None:
        self.issues = list(issues)
        super().__init__("document not admitted:\n  " + "\n  ".join(str(i) for i in self.issues))


class BackendUnavailableError(GpuBatchError):
    """Warp or a CUDA device is missing."""


class EpisodeStateError(GpuBatchError):
    """API call out of order (step before reset, unknown world index, ...)."""


class CheckpointIncompatibleError(GpuBatchError):
    """Checkpoint identity does not match the restoring batch."""


@dataclass
class ActionShapeError(GpuBatchError):
    """An action tensor does not match the batch layout."""

    expected: tuple[int, ...]
    actual: tuple[int, ...]
    name: str = field(default="actions")

    def __str__(self) -> str:
        return f"{self.name}: expected shape {self.expected}, got {self.actual}"


class LeaseExhaustedError(GpuBatchError):
    """Every output slot is still leased to a consumer. Release a lease (or
    construct the batch with more ``lease_slots``) before the next step; the
    batch never overwrites a retained view."""
