"""Backend capability reports: what each backend executes, at which precision,
with which transport and determinism class, and what it refuses."""

from __future__ import annotations

import importlib.metadata
import platform
from typing import Any

import mujoco

from .profile import PROFILE_ID, Backend, ReproducibilityClass
from .warp import DETERMINISM
from .workload import ACTION_SIZE, OBSERVATION_LAYOUT, Workload


def _dist_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _common(workload: Workload) -> dict[str, Any]:
    sim = workload.spec.simulation
    return {
        "profile": PROFILE_ID,
        "workload": {"id": workload.id, "digest": workload.digest, "mapId": workload.map_id},
        "mujoco_version": mujoco.__version__,
        "python": platform.python_version(),
        "physics_dt_s": sim.physics_dt_s,
        "decision_hz": sim.decision_hz,
        "substeps_per_decision": sim.substeps_per_decision,
        "observation": [f.__dict__ for f in OBSERVATION_LAYOUT],
        "action": {"size": ACTION_SIZE, "units": "N*m per wheel, order fl fr rl rr", "clip": workload.spec.robot.motor_torque_max_nm},
        "physical_scope": {
            "modelled": [
                "rigid chassis + 4 rigid cylinder wheels on hinge joints",
                "torque-controlled wheels with viscous bearing damping and rotor armature",
                "soft-contact Coulomb sliding friction (condim 3, elliptic cone) against plane/box course",
                "curb-cut ramp climb and vertical curb drop",
            ],
            "not_modelled": [
                "tyre deformation, suspension, rolling resistance, torsional friction",
                "motor electrical dynamics, gearbox backlash",
                "deformable or granular terrain",
                "vehicle-scale suspension/tyre/terrain profiles (separate requirements, see PLAN.md PHYSICS)",
            ],
        },
    }


def cpu_capabilities(workload: Workload | None = None) -> dict[str, Any]:
    workload = workload or Workload()
    return {
        **_common(workload),
        "backend": Backend.MUJOCO_CPU.value,
        "available": True,
        "precision": "float64",
        "worlds_per_session": 1,
        "snapshot_state_spec": "mjSTATE_INTEGRATION",
        "snapshot_resume": "bit-identical continuation on the same build (qualified by snapshot_restore_identity)",
        "observation_transport": "host memory (numpy copy of sensordata)",
        "reproducibility": ReproducibilityClass.SAME_BUILD_REPLAY.value,
        "device": "cpu",
    }


def warp_capabilities(workload: Workload | None = None, *, probe_device: bool = True) -> dict[str, Any]:
    """Report Warp backend availability. ``probe_device`` initialises Warp and
    enumerates CUDA devices; set False for a dependency-only report."""
    workload = workload or Workload()
    report: dict[str, Any] = {
        **_common(workload),
        "backend": Backend.MUJOCO_WARP.value,
        "precision": "float32",
        "snapshot_state_spec": "mjSTATE_FULLPHYSICS|mjSTATE_CTRL",
        "snapshot_resume": "complete physical state; solver warm-start not captured, so continuation is not bit-identical",
        "observation_transport": "device-to-host copy of sensordata per decision (host-side reward/termination)",
        "reproducibility": ReproducibilityClass.CROSS_BACKEND_MEASURED.value,
        "determinism": DETERMINISM,
        "cpu_parity": "measured by qualification (cpu_warp_divergence); not presumed",
        "refuses": [
            "integrator implicitfast",
            "solver PGS",
            "noslip iterations",
            "plugin actuators/sensors",
            "flex bodies",
            "contact or constraint counts reaching the declared capacity (ContactCapacityError)",
        ],
        "mujoco_warp_version": _dist_version("mujoco-warp"),
        "warp_version": _dist_version("warp-lang"),
    }
    try:
        import warp as wp
        import mujoco_warp  # noqa: F401
    except ImportError as exc:
        report.update({"available": False, "reason": f"import failed: {exc}"})
        return report
    if not probe_device:
        report.update({"available": None, "reason": "device not probed"})
        return report
    wp.init()
    cuda = [
        {"alias": d.alias, "name": d.name, "arch": d.arch, "total_memory_bytes": d.total_memory}
        for d in wp.get_cuda_devices()
    ]
    report.update(
        {
            "available": True,
            "cuda_devices": cuda,
            "graph_capture": bool(cuda),
            "device_note": "CPU Warp device executes but is a development path, not the throughput profile" if not cuda else None,
        }
    )
    return report
