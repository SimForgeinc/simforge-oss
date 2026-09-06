"""simforge-oss-gpu: Warp/CUDA batched execution of the ``roadway-dynamic-gpu-v1`` profile.

Public surface (bound by ``simforge_oss_gym`` and the native runner):

* :func:`compile_scenario` / :class:`EpisodeConfig` — admission and compilation;
  raises :class:`ProfileAdmissionError` listing every unsupported feature.
* :class:`RoadwayGpuBatch` — ``reset`` / ``step`` / ``checkpoint`` / ``restore``
  over N worlds; :class:`ActionBatch` in, :class:`OutputLease` out.
* :class:`LaneGraph` — topology-index loader shared with the compiler.
* :func:`capabilities` — profile, numerics and admission metadata.
"""

from .batch import CHECKPOINT_FORMAT, OUTPUT_FIELDS, ActionBatch, Checkpoint, OutputLease, RoadwayGpuBatch
from .capabilities import capabilities
from .errors import (
    ActionShapeError,
    AdmissionIssue,
    BackendUnavailableError,
    CheckpointIncompatibleError,
    EpisodeStateError,
    GpuBatchError,
    LeaseExhaustedError,
    ProfileAdmissionError,
)
from .lane_graph import LaneGraph
from .profile import CAPABILITIES, CAPACITIES, OBJECT_FEATURES, PROFILE_ID, STATE_VECTOR_SIZE, Numerics, ReproducibilityClass
from .scenario import CompiledScenario, EpisodeConfig, compile_scenario

__all__ = [
    "ActionBatch",
    "ActionShapeError",
    "AdmissionIssue",
    "BackendUnavailableError",
    "CAPABILITIES",
    "CAPACITIES",
    "CHECKPOINT_FORMAT",
    "Checkpoint",
    "CheckpointIncompatibleError",
    "CompiledScenario",
    "EpisodeConfig",
    "EpisodeStateError",
    "GpuBatchError",
    "LaneGraph",
    "LeaseExhaustedError",
    "Numerics",
    "OBJECT_FEATURES",
    "OUTPUT_FIELDS",
    "OutputLease",
    "PROFILE_ID",
    "ProfileAdmissionError",
    "ReproducibilityClass",
    "RoadwayGpuBatch",
    "STATE_VECTOR_SIZE",
    "capabilities",
    "compile_scenario",
]
