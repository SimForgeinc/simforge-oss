"""Qualification of the articulated profile against analytic references and
identity invariants.

Every check is a gate with an explicit tolerance, a measurement, and a
``pass``/``fail``/``not-run``/``measured`` status. ``measured`` checks report a
number without a pass criterion (cross-backend divergence). Absence of a
result is never a pass. Passing this suite establishes that the solver
integration, contact force balance, no-slip rolling dynamics, ramp threshold
behaviour, curb-drop stability, timestep convergence, determinism and
snapshot/export identity hold for **this workload and these declared
dimensions**; it is not generic real-world validation of the robot or of
MuJoCo.
"""

from __future__ import annotations

import dataclasses
import json
import math
import platform
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import mujoco
import numpy as np

from .cpu import MuJoCoCpuSession
from .profile import PROFILE_ID, Backend
from .scene_state import yaw_from_quaternion
from .types import BackendUnavailableError, ContactCapacityError, ResetOptions, Snapshot, StepResult
from .workload import ACTION_SIZE, OBS, SimulationSpec, Workload, WorkloadSpec

Status = str  # "pass" | "fail" | "not-run" | "measured"

NO_JITTER = ResetOptions(lateral_jitter_m=0.0, yaw_jitter_rad=0.0)


@dataclass
class CheckResult:
    name: str
    status: Status
    measured: dict[str, Any] = field(default_factory=dict)
    expected: dict[str, Any] = field(default_factory=dict)
    tolerance: dict[str, Any] = field(default_factory=dict)
    note: str = ""


def _gate(name: str, ok: bool, **kw: Any) -> CheckResult:
    return CheckResult(name=name, status="pass" if ok else "fail", **kw)


def run_episode(
    session: MuJoCoCpuSession,
    seed: int,
    options: ResetOptions,
    torque_fn: Callable[[int], np.ndarray],
    decisions: int,
    stop: Callable[[StepResult], bool] | None = None,
) -> list[StepResult]:
    """Reset, then step ``decisions`` times (or until ``stop``/done).
    Returns every result including the reset observation."""
    results = [session.reset(seed, options)]
    for k in range(decisions):
        res = session.step(torque_fn(k))
        results.append(res)
        if res.done or (stop is not None and stop(res)):
            break
    return results


def constant_torque(per_wheel_nm: float) -> Callable[[int], np.ndarray]:
    return lambda _k: np.full(ACTION_SIZE, per_wheel_nm)


def scripted_torque(k: int) -> np.ndarray:
    """Deterministic drive + weave profile used by the identity checks."""
    base = 0.8
    weave = 0.4 * math.sin(k / 12.0)
    return np.array([base + weave, base - weave, base + weave, base - weave])


def pitch_from_quaternion(q: np.ndarray) -> float:
    w, x, y, z = (float(v) for v in q)
    s = 2.0 * (w * y - z * x)
    return math.asin(max(-1.0, min(1.0, s)))


# --------------------------------------------------------------------- checks


def check_free_fall(workload: Workload) -> CheckResult:
    """Chassis dropped from 0.5 m with motors off. Semi-implicit Euler gives
    ``z_n = z_analytic - g t dt / 2``; the position gate is that discretisation
    bound plus 1e-4 m, the velocity gate is exactness to 1e-6 m/s."""
    sim = workload.spec.simulation
    g = sim.gravity_mps2
    drop = 0.5
    t_contact = math.sqrt(2.0 * drop / g)
    decisions = int(t_contact / sim.decision_dt_s) - 1
    session = MuJoCoCpuSession(workload)
    options = dataclasses.replace(NO_JITTER, height_offset_m=drop)
    results = run_episode(session, 0, options, constant_torque(0.0), decisions)
    z0 = results[0].observation[OBS["chassis_pos"]][2]
    max_pos_err = 0.0
    max_vel_err = 0.0
    for res in results[1:]:
        t = res.tick * sim.decision_dt_s
        z = res.observation[OBS["chassis_pos"]][2]
        vz = res.observation[OBS["chassis_linvel"]][2]
        max_pos_err = max(max_pos_err, abs(z - (z0 - 0.5 * g * t * t)) - 0.5 * g * t * sim.physics_dt_s)
        max_vel_err = max(max_vel_err, abs(vz + g * t))
    ok = max_pos_err <= 1e-4 and max_vel_err <= 1e-6 and all(r.info["wheels_in_contact"] == 0 for r in results)
    return _gate(
        "free_fall_analytic",
        ok,
        measured={"max_position_error_beyond_discretisation_m": max_pos_err, "max_velocity_error_mps": max_vel_err, "decisions": len(results) - 1},
        expected={"z(t)": "z0 - g t^2 / 2", "vz(t)": "-g t", "contacts": 0},
        tolerance={"position_m": 1e-4, "velocity_mps": 1e-6},
    )


def check_static_rest(workload: Workload) -> CheckResult:
    """After 2 s at rest the wheel normal forces sum to ``m g`` and the body is still."""
    robot, sim = workload.spec.robot, workload.spec.simulation
    session = MuJoCoCpuSession(workload)
    results = run_episode(session, 0, NO_JITTER, constant_torque(0.0), int(2.0 / sim.decision_dt_s))
    obs = results[-1].observation
    weight = robot.total_mass_kg * sim.gravity_mps2
    total_normal = float(np.sum(obs[OBS["wheel_normal_force"]]))
    speed = float(np.linalg.norm(obs[OBS["chassis_linvel"]]))
    z = float(obs[OBS["chassis_pos"]][2])
    penetration = robot.chassis_center_height_m - z
    force_rel_err = abs(total_normal - weight) / weight
    ok = force_rel_err <= 0.02 and speed <= 1e-3 and results[-1].info["wheels_in_contact"] == 4 and 0.0 <= penetration <= 0.01
    return _gate(
        "static_rest_force_balance",
        ok,
        measured={"sum_normal_force_n": total_normal, "speed_mps": speed, "penetration_m": penetration, "per_wheel_n": obs[OBS["wheel_normal_force"]].tolist()},
        expected={"sum_normal_force_n": weight, "wheels_in_contact": 4},
        tolerance={"force_relative": 0.02, "speed_mps": 1e-3, "penetration_m": 0.01},
    )


def check_flat_rolling(workload: Workload) -> CheckResult:
    """Constant 0.3 N*m per wheel for 3 s on the approach: measured speed matches
    the closed-form rigid no-slip model with viscous hinge damping, the wheels
    do not slip (``v = mean(omega) r``), and heading holds."""
    robot, sim = workload.spec.robot, workload.spec.simulation
    torque = 0.3
    duration = 3.0
    session = MuJoCoCpuSession(workload)
    results = run_episode(session, 0, NO_JITTER, constant_torque(torque), int(duration / sim.decision_dt_s))
    obs = results[-1].observation
    t = results[-1].tick * sim.decision_dt_s
    v_meas = float(obs[OBS["chassis_linvel"]][0])
    v_ref = workload.flat_rolling_speed_analytic(torque, t)
    omega = float(np.mean(obs[OBS["wheel_angvel"]]))
    slip = abs(v_meas - omega * robot.wheel_radius_m) / max(abs(v_meas), 1e-9)
    yaw = abs(yaw_from_quaternion(obs[OBS["chassis_quat"]]))
    x = float(obs[OBS["chassis_pos"]][0])
    on_approach = x + robot.wheelbase_m / 2 + robot.wheel_radius_m < workload.spec.course.ramp_start_x_m
    rel_err = abs(v_meas - v_ref) / v_ref
    ok = rel_err <= 0.03 and slip <= 0.03 and yaw <= math.radians(1.0) and on_approach and not results[-1].done
    return _gate(
        "flat_rolling_no_slip",
        ok,
        measured={"speed_mps": v_meas, "speed_relative_error": rel_err, "slip_ratio": slip, "yaw_rad": yaw, "x_m": x, "t_s": t},
        expected={"speed_mps": v_ref, "model": "v(t) = tau r / c (1 - exp(-4 c t / (M_eff r^2)))", "effective_mass_kg": workload.effective_rolling_mass_kg()},
        tolerance={"speed_relative": 0.03, "slip_ratio": 0.03, "yaw_rad": math.radians(1.0)},
        note="still on the flat approach; ramp not reached" if on_approach else "ramp reached: check invalid",
    )


def check_ramp_threshold(workload: Workload) -> CheckResult:
    """From rest at mid-ramp, total torque at 0.5x and 1.5x ``m g r sin(alpha)``
    must roll down / drive up with along-slope displacement within 15 % of
    ``a t^2 / 2`` after 1 s (damping ignored in the reference)."""
    course, sim = workload.spec.course, workload.spec.simulation
    hold = workload.torque_to_hold_on_ramp_nm()
    duration = 1.0
    decisions = int(duration / sim.decision_dt_s)
    tangent = np.array([math.cos(course.incline_rad), 0.0, math.sin(course.incline_rad)])
    measured: dict[str, Any] = {"hold_torque_total_nm": hold}
    ok = True
    for label, factor in (("below", 0.5), ("above", 1.5)):
        total = factor * hold
        session = MuJoCoCpuSession(workload)
        options = dataclasses.replace(NO_JITTER, start="ramp")
        results = run_episode(session, 0, options, constant_torque(total / 4.0), decisions)
        p0 = results[0].observation[OBS["chassis_pos"]]
        p1 = results[-1].observation[OBS["chassis_pos"]]
        t = results[-1].tick * sim.decision_dt_s
        displacement = float(np.dot(p1 - p0, tangent))
        a_ref = workload.ramp_acceleration_analytic(total)
        d_ref = 0.5 * a_ref * t * t
        rel_err = abs(displacement - d_ref) / abs(d_ref)
        sign_ok = (displacement < -0.01) if factor < 1.0 else (displacement > 0.01)
        contact_ok = results[-1].info["wheels_in_contact"] == 4
        ok = ok and sign_ok and rel_err <= 0.15 and contact_ok and not results[-1].done
        measured[label] = {
            "total_torque_nm": total,
            "displacement_along_slope_m": displacement,
            "reference_displacement_m": d_ref,
            "relative_error": rel_err,
            "wheels_in_contact": results[-1].info["wheels_in_contact"],
        }
    return _gate(
        "ramp_torque_threshold",
        ok,
        measured=measured,
        expected={"below_hold": "rolls down", "above_hold": "drives up", "displacement": "a t^2 / 2 with a = (tau/r - m g sin(alpha)) / M_eff"},
        tolerance={"displacement_relative": 0.15, "min_abs_displacement_m": 0.01},
    )


def check_curb_drop(workload: Workload) -> CheckResult:
    """Drive off the sidewalk edge at 0.6 N*m per wheel until both axles have
    dropped, then brake with a wheel-speed-proportional torque
    (``-0.5 N*m*s/rad * omega``, clipped) for 3 s: the robot must stay upright,
    land on all four wheels, come to rest at rest height and not reach the goal.
    Coasting is not a stopping strategy for this model: hinge damping is
    0.005 N*m*s/rad and rolling resistance is not modelled, so a free-rolling
    robot keeps most of its speed. A stability gate for the workload, not a
    claim about real landing loads."""
    robot, course, sim = workload.spec.robot, workload.spec.course, workload.spec.simulation
    session = MuJoCoCpuSession(workload)
    options = dataclasses.replace(NO_JITTER, start="plateau")
    clear_x = course.curb_x_m + robot.wheelbase_m / 2.0 + robot.wheel_radius_m + 0.1
    drive = run_episode(
        session, 0, options, constant_torque(0.6), int(6.0 / sim.decision_dt_s),
        stop=lambda r: r.observation[OBS["chassis_pos"]][0] > clear_x,
    )
    peak_vz = min(float(r.observation[OBS["chassis_linvel"]][2]) for r in drive)
    peak_force = max(float(np.sum(r.observation[OBS["wheel_normal_force"]])) for r in drive)
    brake: list[StepResult] = []
    if not drive[-1].done:
        res = drive[-1]
        for _ in range(int(3.0 / sim.decision_dt_s)):
            res = session.step(-0.5 * res.observation[OBS["wheel_angvel"]])
            brake.append(res)
            if res.done:
                break
    final = (brake or drive)[-1]
    obs = final.observation
    z = float(obs[OBS["chassis_pos"]][2])
    x = float(obs[OBS["chassis_pos"]][0])
    up_z = float(final.info["up_z"])
    speed = float(np.linalg.norm(obs[OBS["chassis_linvel"]]))
    height_err = abs(z - robot.chassis_center_height_m)
    ok = (
        clear_x < x < course.goal_x_m
        and up_z > 0.95
        and final.info["wheels_in_contact"] == 4
        and height_err <= 0.01
        and speed <= 0.05
        and not final.done
    )
    return _gate(
        "curb_drop_recovery",
        ok,
        measured={"x_m": x, "z_m": z, "rest_height_error_m": height_err, "up_z": up_z, "speed_mps": speed, "peak_descent_mps": peak_vz, "peak_total_normal_force_n": peak_force, "wheels_in_contact": final.info["wheels_in_contact"], "terminated": final.terminated, "truncated": final.truncated, "drive_decisions": len(drive) - 1, "brake_decisions": len(brake)},
        expected={"x_m": f"in ({clear_x}, {course.goal_x_m})", "up_z": "> 0.95", "wheels_in_contact": 4, "rest_height_m": robot.chassis_center_height_m, "done": False},
        tolerance={"rest_height_m": 0.01, "speed_mps": 0.05},
    )


def check_timestep_convergence(workload: Workload) -> CheckResult:
    """Ramp climb (1.0 N*m per wheel, 4 s) at 2 ms and 1 ms physics steps with
    identical 20 ms decisions: final pose within 2 cm / 1 deg / 5 cm/s."""
    base = workload.spec
    fine = dataclasses.replace(
        base,
        simulation=dataclasses.replace(
            base.simulation,
            physics_dt_s=base.simulation.physics_dt_s / 2.0,
            substeps_per_decision=base.simulation.substeps_per_decision * 2,
        ),
    )
    finals = []
    for spec in (base, fine):
        session = MuJoCoCpuSession(Workload(spec))
        results = run_episode(session, 0, NO_JITTER, constant_torque(1.0), int(4.0 / spec.simulation.decision_dt_s))
        finals.append(results[-1])
    a, b = finals[0].observation, finals[1].observation
    pos_err = float(np.linalg.norm(a[OBS["chassis_pos"]] - b[OBS["chassis_pos"]]))
    yaw_err = abs(yaw_from_quaternion(a[OBS["chassis_quat"]]) - yaw_from_quaternion(b[OBS["chassis_quat"]]))
    pitch_err = abs(pitch_from_quaternion(a[OBS["chassis_quat"]]) - pitch_from_quaternion(b[OBS["chassis_quat"]]))
    speed_err = float(np.linalg.norm(a[OBS["chassis_linvel"]] - b[OBS["chassis_linvel"]]))
    climbed = a[OBS["chassis_pos"]][0] > workload.spec.course.ramp_end_x_m
    ok = pos_err <= 0.02 and yaw_err <= math.radians(1.0) and pitch_err <= math.radians(1.0) and speed_err <= 0.05 and climbed
    return _gate(
        "ramp_climb_timestep_convergence",
        ok,
        measured={"position_error_m": pos_err, "yaw_error_rad": yaw_err, "pitch_error_rad": pitch_err, "speed_error_mps": speed_err, "final_x_m": float(a[OBS["chassis_pos"]][0]), "reached_plateau": bool(climbed)},
        expected={"physics_dt_s": [base.simulation.physics_dt_s, fine.simulation.physics_dt_s], "reached_plateau": True},
        tolerance={"position_m": 0.02, "angle_rad": math.radians(1.0), "speed_mps": 0.05},
    )


def check_determinism(workload: Workload) -> CheckResult:
    """Two sessions, same seed and scripted torques: bit-identical observations
    and identical scene-state digests."""
    decisions = 150
    runs = []
    for _ in range(2):
        session = MuJoCoCpuSession(workload)
        results = run_episode(session, 7, ResetOptions(), scripted_torque, decisions)
        runs.append((np.stack([r.observation for r in results]), session.export_digest()))
    identical = bool(np.array_equal(runs[0][0], runs[1][0])) and runs[0][1] == runs[1][1]
    return _gate(
        "determinism_replay",
        identical,
        measured={"observations_identical": bool(np.array_equal(runs[0][0], runs[1][0])), "digest_a": runs[0][1], "digest_b": runs[1][1], "decisions": runs[0][0].shape[0] - 1},
        expected={"observations": "bit-identical", "digest": "equal"},
        tolerance={"bits": 0},
    )


def check_snapshot_restore(workload: Workload) -> CheckResult:
    """Snapshot at decision 40 of an 80-decision scripted run; a fresh session
    restores the JSON round-tripped snapshot and replays decisions 41..80:
    observations bit-identical and the tick-40+ scene-state segments equal."""
    split, total = 40, 80
    a = MuJoCoCpuSession(workload)
    results_a = run_episode(a, 11, ResetOptions(), scripted_torque, split)
    snap = a.snapshot()
    for k in range(split, total):
        results_a.append(a.step(scripted_torque(k)))
    snap_rt = Snapshot.from_dict(json.loads(json.dumps(snap.to_dict())))
    b = MuJoCoCpuSession(workload)
    b.restore(snap_rt)
    results_b = []
    for k in range(split, total):
        results_b.append(b.step(scripted_torque(k)))
    tail_a = np.stack([r.observation for r in results_a[split + 1 :]])
    tail_b = np.stack([r.observation for r in results_b])
    obs_identical = bool(np.array_equal(tail_a, tail_b))
    digest_a = a.export_digest(from_tick=split)
    digest_b = b.export_digest(from_tick=split)
    return _gate(
        "snapshot_restore_identity",
        obs_identical and digest_a == digest_b and b.tick == a.tick,
        measured={"observations_identical": obs_identical, "segment_digest_uninterrupted": digest_a, "segment_digest_restored": digest_b, "state_size": int(snap.state.shape[0]), "state_spec": snap.state_spec_name},
        expected={"observations": "bit-identical after restore", "segment_digest": "equal"},
        tolerance={"bits": 0},
    )


CPU_CHECKS: tuple[Callable[[Workload], CheckResult], ...] = (
    check_free_fall,
    check_static_rest,
    check_flat_rolling,
    check_ramp_threshold,
    check_curb_drop,
    check_timestep_convergence,
    check_determinism,
    check_snapshot_restore,
)


# ---------------------------------------------------------------- warp checks


def check_warp_batch_identity(workload: Workload, nworld: int = 8) -> CheckResult:
    """All worlds seeded identically and driven identically must agree to
    1e-6 (float32 batch invariance); a second batch measures run-to-run repeatability.
    The batch runs under the Warp deterministic configuration reported in
    ``measured["determinism"]``."""
    from .warp import MuJoCoWarpBatch

    decisions = 100
    trajectories = []
    for _ in range(2):
        batch = MuJoCoWarpBatch(workload, nworld=nworld)
        batch.reset([5] * nworld, ResetOptions())
        obs = []
        for k in range(decisions):
            res = batch.step(np.tile(scripted_torque(k), (nworld, 1)))
            obs.append(res.observation)
            if res.terminated.any() or res.truncated.any():
                break
        trajectories.append(np.stack(obs))
    traj = trajectories[0]
    cross_world = float(np.max(np.abs(traj - traj[:, :1, :])))
    run_to_run = float(np.max(np.abs(trajectories[0] - trajectories[1])))
    return _gate(
        "warp_batch_identity",
        cross_world <= 1e-6,
        measured={
            "cross_world_max_abs_diff": cross_world,
            "run_to_run_max_abs_diff": run_to_run,
            "nworld": nworld,
            "decisions": int(traj.shape[0]),
            "graph_captured": batch.graph_captured,
            "device": str(batch.device),
            "determinism": batch.determinism,
        },
        expected={"cross_world_max_abs_diff": 0.0},
        tolerance={"cross_world_abs": 1e-6},
        note="run_to_run is reported, not gated",
    )


def check_warp_capacity_rejection(workload: Workload) -> CheckResult:
    """A batch declared with room for one contact must raise
    ``ContactCapacityError`` when four wheels touch the ground."""
    from .warp import MuJoCoWarpBatch

    batch = MuJoCoWarpBatch(workload, nworld=1, nconmax=1, njmax=4, capture_graph=False)
    batch.reset([0], NO_JITTER)
    try:
        for _ in range(25):
            batch.step(np.zeros((1, ACTION_SIZE)))
    except ContactCapacityError as exc:
        return _gate("warp_capacity_rejection", True, measured={"error": str(exc)}, expected={"raises": "ContactCapacityError"})
    return _gate("warp_capacity_rejection", False, measured={"error": None}, expected={"raises": "ContactCapacityError"})


def check_cpu_warp_divergence(workload: Workload) -> CheckResult:
    """Same ramp-climb episode on both backends; final pose difference is
    reported. No pass criterion: parity is measured, not presumed."""
    from .warp import MuJoCoWarpBatch

    decisions = int(4.0 / workload.spec.simulation.decision_dt_s)
    cpu = MuJoCoCpuSession(workload)
    cpu_results = run_episode(cpu, 0, NO_JITTER, constant_torque(1.0), decisions)
    batch = MuJoCoWarpBatch(workload, nworld=1)
    batch.reset([0], NO_JITTER)
    warp_obs = None
    for k in range(len(cpu_results) - 1):
        res = batch.step(np.full((1, ACTION_SIZE), 1.0))
        warp_obs = res.observation[0]
        if res.terminated[0] or res.truncated[0]:
            break
    a, b = cpu_results[-1].observation, warp_obs
    return CheckResult(
        name="cpu_warp_divergence",
        status="measured",
        measured={
            "position_diff_m": float(np.linalg.norm(a[OBS["chassis_pos"]] - b[OBS["chassis_pos"]])),
            "yaw_diff_rad": abs(yaw_from_quaternion(a[OBS["chassis_quat"]]) - yaw_from_quaternion(b[OBS["chassis_quat"]])),
            "speed_diff_mps": float(np.linalg.norm(a[OBS["chassis_linvel"]] - b[OBS["chassis_linvel"]])),
            "cpu_final_x_m": float(a[OBS["chassis_pos"]][0]),
            "warp_final_x_m": float(b[OBS["chassis_pos"]][0]),
            "decisions": len(cpu_results) - 1,
        },
        note="float64 CPU vs float32 Warp; informational",
    )


WARP_CHECKS: tuple[Callable[[Workload], CheckResult], ...] = (
    check_warp_batch_identity,
    check_warp_capacity_rejection,
    check_cpu_warp_divergence,
)


# ---------------------------------------------------------------------- report


def run_qualification(workload: Workload | None = None, *, warp: bool = False) -> dict[str, Any]:
    workload = workload or Workload()
    results: list[CheckResult] = []
    for check in CPU_CHECKS:
        started = time.perf_counter()
        try:
            res = check(workload)
        except Exception as exc:  # a crashing check is a failed gate, not a missing one
            res = CheckResult(name=check.__name__.removeprefix("check_"), status="fail", note=f"{type(exc).__name__}: {exc}")
        res.measured["elapsed_s"] = round(time.perf_counter() - started, 3)
        results.append(res)
    for check in WARP_CHECKS:
        name = check.__name__.removeprefix("check_")
        if not warp:
            results.append(CheckResult(name=name, status="not-run", note="warp backend not requested"))
            continue
        started = time.perf_counter()
        try:
            res = check(workload)
        except BackendUnavailableError as exc:
            res = CheckResult(name=name, status="not-run", note=str(exc))
        except Exception as exc:
            res = CheckResult(name=name, status="fail", note=f"{type(exc).__name__}: {exc}")
        res.measured["elapsed_s"] = round(time.perf_counter() - started, 3)
        results.append(res)
    gates = [r for r in results if r.status in ("pass", "fail")]
    return {
        "profile": PROFILE_ID,
        "workload": {"id": workload.id, "digest": workload.digest, "spec": workload.spec.to_dict()},
        "backends": [Backend.MUJOCO_CPU.value] + ([Backend.MUJOCO_WARP.value] if warp else []),
        "mujoco_version": mujoco.__version__,
        "platform": platform.platform(),
        "generated_at_unix_s": int(time.time()),
        "gates_passed": sum(r.status == "pass" for r in gates),
        "gates_failed": sum(r.status == "fail" for r in gates),
        "not_run": [r.name for r in results if r.status == "not-run"],
        "all_gates_passed": bool(gates) and all(r.status == "pass" for r in gates),
        "scope": (
            "Passing gates qualify the declared delivery-robot curb/ramp workload on the named backend and MuJoCo "
            "build against analytic rigid-body references and identity invariants. They do not establish real-world "
            "validity of the robot, tyre/terrain behaviour, vehicle-scale suspension, or CPU/GPU numerical parity."
        ),
        "checks": [dataclasses.asdict(r) for r in results],
    }
