"""Profile identity for the articulated physics extension.

``articulated-mujoco-v1`` is a new, separately versioned physical model. It is
not an extension of the planar ``dynamic-v1`` roadway profile and never runs
inside it: a scenario is executed by exactly one
profile, and the profile id is recorded on every snapshot, export and
qualification report this package produces.
"""

from __future__ import annotations

from enum import Enum

#: Physics profile id recorded on snapshots, exports and reports.
PROFILE_ID = "articulated-mujoco-v1"

#: scene-state document version emitted by every SimForge emitter
#: (``packages/engine/src/scene-state/schema.ts`` ``SCENE_STATE_VERSION``), so
#: renderers and digests treat the articulated and roadway exports identically.
SCENE_STATE_VERSION = "simforge.scene-state.v1"


class Backend(str, Enum):
    """Execution backend. Selected explicitly per session; never inferred."""

    #: ``mujoco.mj_step`` on the host, one world per session, float64 state.
    MUJOCO_CPU = "mujoco-cpu"
    #: ``mujoco_warp.step`` batched worlds on a Warp device, float32 state.
    MUJOCO_WARP = "mujoco-warp"


class ReproducibilityClass(str, Enum):
    """Determinism claim attached to a backend; see PLAN.md determinism classes."""

    #: Same build, same backend, same device: bit-identical replay.
    SAME_BUILD_REPLAY = "same-build-replay"
    #: Different backends of the same model: numerically close, not identical.
    CROSS_BACKEND_MEASURED = "cross-backend-measured"
