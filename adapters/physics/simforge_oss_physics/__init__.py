"""simforge-oss-physics: the ``articulated-mujoco-v1`` physical profile.

Public integration API (consumed by native/Python session work):

- ``Workload`` / ``WorkloadSpec``: the delivery-robot curb/ramp workload, its
  explicit dimensions, masses, controls, course, timestep and episode rules;
  ``Workload.mjcf`` / ``Workload.digest`` identify the compiled model.
- ``OBSERVATION_LAYOUT`` / ``OBS`` / ``ACTION_SIZE``: typed observation and
  action layouts shared by every backend.
- ``MuJoCoCpuSession``: one-world episode API (``reset``/``step``/``snapshot``/
  ``restore``/``export_scene_state``) on the MuJoCo CPU solver.
- ``MuJoCoWarpBatch`` (``simforge_oss_physics.warp``): batched worlds on
  MuJoCo Warp with capability rejection; import lazily, it needs the ``warp``
  extra.
- ``ResetOptions``, ``StepResult``, ``BatchStepResult``, ``Snapshot`` and the
  error types in ``types``.
- ``cpu_capabilities`` / ``warp_capabilities`` and
  ``qualification.run_qualification`` for truthful support reports.
"""

from .capabilities import cpu_capabilities, warp_capabilities
from .course_asset import build_course_glb, render_scene_spec, write_course_resources
from .profile import PROFILE_ID, SCENE_STATE_VERSION, Backend, ReproducibilityClass
from .scene_state import SceneStateRecorder, merge_scene_state, scene_state_digest, to_service_states
from .types import (
    BackendCapabilityError,
    BackendUnavailableError,
    BatchStepResult,
    ContactCapacityError,
    EpisodeStateError,
    PhysicsAdapterError,
    ResetOptions,
    Snapshot,
    SnapshotIncompatibleError,
    StepResult,
)
from .workload import (
    ACTION_SIZE,
    OBS,
    OBSERVATION_LAYOUT,
    OBSERVATION_SIZE,
    WHEELS,
    CourseSpec,
    EpisodeRules,
    RobotSpec,
    SimulationSpec,
    Workload,
    WorkloadSpec,
    build_mjcf,
    start_pose,
)
from .cpu import MuJoCoCpuSession

__all__ = [
    "ACTION_SIZE",
    "OBS",
    "OBSERVATION_LAYOUT",
    "OBSERVATION_SIZE",
    "PROFILE_ID",
    "SCENE_STATE_VERSION",
    "WHEELS",
    "Backend",
    "BackendCapabilityError",
    "BackendUnavailableError",
    "BatchStepResult",
    "ContactCapacityError",
    "CourseSpec",
    "EpisodeRules",
    "EpisodeStateError",
    "MuJoCoCpuSession",
    "PhysicsAdapterError",
    "ReproducibilityClass",
    "ResetOptions",
    "RobotSpec",
    "SceneStateRecorder",
    "SimulationSpec",
    "Snapshot",
    "SnapshotIncompatibleError",
    "StepResult",
    "Workload",
    "WorkloadSpec",
    "build_mjcf",
    "cpu_capabilities",
    "scene_state_digest",
    "start_pose",
    "warp_capabilities",
    "build_course_glb",
    "merge_scene_state",
    "render_scene_spec",
    "to_service_states",
    "write_course_resources",
]
