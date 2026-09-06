"""Delivery-robot curb/ramp workload: explicit dimensions, masses, controls,
course geometry, MJCF generation, observation/action layouts and episode rules.

Every physical quantity is a named, unit-suffixed field of a frozen spec. The
MJCF is generated from the spec, and ``Workload.digest`` binds the generated
model text and the spec together so snapshots and exports can prove which
model produced them.

Frames: MuJoCo world frame is x forward along the course, y left, z up (same
axes as the engine's xodr-local frame). ``frames.py`` converts to the y-up
scene frame for export.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field
from typing import Literal, Sequence

import numpy as np

from .profile import PROFILE_ID

WheelName = Literal["fl", "fr", "rl", "rr"]
#: Wheel order used by every per-wheel array (actions, sensors, exports).
WHEELS: tuple[WheelName, ...] = ("fl", "fr", "rl", "rr")

StartRegion = Literal["approach", "ramp", "plateau"]


@dataclass(frozen=True)
class RobotSpec:
    """Four-wheel skid-steer sidewalk delivery robot.

    Values are the workload's declared reference dimensions, not a specific
    commercial vehicle. Masses are assigned to geoms; MuJoCo derives inertia
    from the geom shape and mass (uniform density).
    """

    chassis_length_m: float = 0.70
    chassis_width_m: float = 0.50
    chassis_height_m: float = 0.30
    chassis_mass_kg: float = 30.0
    #: Gap between the wheel axle plane and the chassis underside.
    chassis_axle_gap_m: float = 0.02
    wheelbase_m: float = 0.45
    wheel_radius_m: float = 0.10
    wheel_width_m: float = 0.05
    wheel_mass_kg: float = 1.5
    #: Clearance between the chassis side face and the inner wheel face.
    wheel_side_gap_m: float = 0.005
    #: Viscous bearing/gearbox damping on each wheel hinge (0.075 N*m at 15 rad/s).
    wheel_damping_nms_per_rad: float = 0.005
    #: Reflected rotor inertia added to each wheel hinge.
    wheel_armature_kgm2: float = 0.01
    #: Per-wheel motor torque limit; actions are clipped to +-this value.
    motor_torque_max_nm: float = 3.0
    #: Coulomb sliding friction coefficient for wheel/ground and chassis/ground
    #: contacts (rubber on dry concrete reference range 0.6-1.0). Contacts use
    #: condim=3: no torsional or rolling friction is modelled.
    friction_sliding: float = 0.9

    @property
    def total_mass_kg(self) -> float:
        return self.chassis_mass_kg + 4.0 * self.wheel_mass_kg

    @property
    def chassis_center_height_m(self) -> float:
        """Chassis body origin height above the contact surface at rest."""
        return self.wheel_radius_m + self.chassis_axle_gap_m + self.chassis_height_m / 2.0

    @property
    def wheel_offset_z_m(self) -> float:
        """Wheel centre z in the chassis frame."""
        return -(self.chassis_axle_gap_m + self.chassis_height_m / 2.0)

    @property
    def track_m(self) -> float:
        return self.chassis_width_m + 2.0 * (self.wheel_side_gap_m + self.wheel_width_m / 2.0)


@dataclass(frozen=True)
class CourseSpec:
    """Flat approach -> curb-cut ramp up -> raised sidewalk -> vertical curb drop -> run-out.

    ``ramp_rise_m`` equals the curb height: the ramp is the curb cut that
    climbs onto the sidewalk and the robot drops off the far edge.
    """

    approach_length_m: float = 2.0
    ramp_rise_m: float = 0.10
    #: Horizontal run of the ramp. 1.2 m for 0.10 m rise is the 1:12 grade.
    ramp_run_m: float = 1.2
    plateau_length_m: float = 2.0
    runout_length_m: float = 1.8
    #: Half width of ramp/plateau slabs; the episode corridor is narrower.
    half_width_m: float = 1.0
    slab_thickness_m: float = 0.10

    @property
    def ramp_start_x_m(self) -> float:
        return self.approach_length_m

    @property
    def ramp_end_x_m(self) -> float:
        return self.approach_length_m + self.ramp_run_m

    @property
    def curb_x_m(self) -> float:
        return self.ramp_end_x_m + self.plateau_length_m

    @property
    def goal_x_m(self) -> float:
        return self.curb_x_m + self.runout_length_m

    @property
    def incline_rad(self) -> float:
        return math.atan2(self.ramp_rise_m, self.ramp_run_m)

    @property
    def grade(self) -> float:
        return self.ramp_rise_m / self.ramp_run_m

    def surface_height_m(self, x: float) -> float:
        """Top-of-course height under horizontal position ``x``."""
        if x < self.ramp_start_x_m:
            return 0.0
        if x < self.ramp_end_x_m:
            return (x - self.ramp_start_x_m) * self.grade
        if x < self.curb_x_m:
            return self.ramp_rise_m
        return 0.0


@dataclass(frozen=True)
class SimulationSpec:
    physics_dt_s: float = 0.002
    #: Physics steps per decision; 10 x 2 ms = 50 Hz decisions.
    substeps_per_decision: int = 10
    #: Episode truncation horizon in decisions (1500 x 20 ms = 30 s).
    max_decisions: int = 1500
    gravity_mps2: float = 9.81

    @property
    def decision_dt_s(self) -> float:
        return self.physics_dt_s * self.substeps_per_decision

    @property
    def decision_hz(self) -> float:
        return 1.0 / self.decision_dt_s


@dataclass(frozen=True)
class EpisodeRules:
    """Termination and reward definitions. All thresholds are explicit."""

    #: Terminate when the chassis up-vector's world z drops below this (60 deg).
    tip_up_z_min: float = 0.5
    #: Terminate when |y| exceeds this lateral bound.
    corridor_half_width_m: float = 0.9
    #: Reward = forward progress (m per decision) minus effort penalty.
    effort_weight_per_nm2: float = 1e-3


@dataclass(frozen=True)
class WorkloadSpec:
    robot: RobotSpec = field(default_factory=RobotSpec)
    course: CourseSpec = field(default_factory=CourseSpec)
    simulation: SimulationSpec = field(default_factory=SimulationSpec)
    rules: EpisodeRules = field(default_factory=EpisodeRules)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ObservationField:
    name: str
    size: int
    units: str
    frame: str


#: Observation vector layout, in order. Every entry is a MuJoCo sensor so the
#: CPU and Warp backends read the same ``sensordata`` array.
OBSERVATION_LAYOUT: tuple[ObservationField, ...] = (
    ObservationField("chassis_pos", 3, "m", "world"),
    ObservationField("chassis_quat", 4, "unit quaternion wxyz", "world"),
    ObservationField("chassis_linvel", 3, "m/s", "world"),
    ObservationField("chassis_angvel", 3, "rad/s", "world"),
    ObservationField("imu_accel", 3, "m/s^2 (includes gravity)", "chassis body"),
    ObservationField("imu_gyro", 3, "rad/s", "chassis body"),
    ObservationField("wheel_angvel", 4, "rad/s about +y hinge, order fl fr rl rr", "wheel hinge"),
    ObservationField("wheel_normal_force", 4, "N summed contact normal force, order fl fr rl rr", "contact"),
)

OBSERVATION_SIZE = sum(f.size for f in OBSERVATION_LAYOUT)


def observation_slices() -> dict[str, slice]:
    out: dict[str, slice] = {}
    offset = 0
    for f in OBSERVATION_LAYOUT:
        out[f.name] = slice(offset, offset + f.size)
        offset += f.size
    return out


OBS = observation_slices()

#: Action vector: per-wheel motor torque in N*m, order fl fr rl rr.
ACTION_SIZE = 4


def quat_about_y(angle_rad: float) -> np.ndarray:
    """MuJoCo (w, x, y, z) quaternion for a rotation about +y."""
    return np.array([math.cos(angle_rad / 2.0), 0.0, math.sin(angle_rad / 2.0), 0.0])


def quat_about_z(angle_rad: float) -> np.ndarray:
    return np.array([math.cos(angle_rad / 2.0), 0.0, 0.0, math.sin(angle_rad / 2.0)])


def quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product of (w, x, y, z) quaternions: ``a`` applied after ``b``."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ]
    )


def _fmt(values: Sequence[float]) -> str:
    return " ".join(repr(float(v)) for v in values)


def ramp_slab_pose(course: CourseSpec) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(half-sizes, centre, quaternion) of the ramp box whose top surface runs
    from ``(ramp_start_x, 0)`` to ``(ramp_end_x, ramp_rise)``."""
    a = course.incline_rad
    slant = math.hypot(course.ramp_run_m, course.ramp_rise_m)
    hz = course.slab_thickness_m / 2.0
    normal = np.array([-math.sin(a), 0.0, math.cos(a)])
    top_mid = np.array([course.ramp_start_x_m + course.ramp_run_m / 2.0, 0.0, course.ramp_rise_m / 2.0])
    center = top_mid - normal * hz
    half = np.array([slant / 2.0, course.half_width_m, hz])
    return half, center, quat_about_y(-a)


@dataclass(frozen=True)
class StartPose:
    """Chassis free-joint pose: position (m) and (w, x, y, z) quaternion."""

    position: np.ndarray
    quaternion: np.ndarray

    def qpos(self) -> np.ndarray:
        return np.concatenate([self.position, self.quaternion])


def start_pose(
    spec: WorkloadSpec,
    region: StartRegion,
    *,
    lateral_offset_m: float = 0.0,
    yaw_rad: float = 0.0,
    height_offset_m: float = 0.0,
) -> StartPose:
    """Rest pose of the chassis with all four wheels on the named course region.

    ``approach`` places the chassis origin at x=0; ``ramp`` at the ramp's
    mid-slope; ``plateau`` 0.5 m before the curb edge so both axles are on the
    sidewalk. ``height_offset_m`` lifts the robot along the surface normal
    (used to start a free fall). Yaw is applied about the surface normal.
    """
    course, robot = spec.course, spec.robot
    h = robot.chassis_center_height_m + height_offset_m
    if region == "approach":
        pitch, base = 0.0, np.array([0.0, 0.0, 0.0])
    elif region == "plateau":
        pitch, base = 0.0, np.array([course.curb_x_m - 0.5, 0.0, course.ramp_rise_m])
    elif region == "ramp":
        pitch = course.incline_rad
        base = np.array(
            [
                course.ramp_start_x_m + course.ramp_run_m / 2.0,
                0.0,
                course.ramp_rise_m / 2.0,
            ]
        )
    else:
        raise ValueError(f"unknown start region {region!r}")
    normal = np.array([-math.sin(pitch), 0.0, math.cos(pitch)])
    position = base + normal * h + np.array([0.0, lateral_offset_m, 0.0])
    quaternion = quat_mul(quat_about_y(-pitch), quat_about_z(yaw_rad))
    return StartPose(position=position, quaternion=quaternion)


def build_mjcf(spec: WorkloadSpec) -> str:
    """Generate the MJCF model text for the workload. Deterministic for a spec."""
    r, c, s = spec.robot, spec.course, spec.simulation
    wheel_y = r.track_m / 2.0
    wheel_z = r.wheel_offset_z_m
    wheel_x = r.wheelbase_m / 2.0
    wheel_pos = {
        "fl": (wheel_x, wheel_y, wheel_z),
        "fr": (wheel_x, -wheel_y, wheel_z),
        "rl": (-wheel_x, wheel_y, wheel_z),
        "rr": (-wheel_x, -wheel_y, wheel_z),
    }
    # Cylinder axis is local z; rotate it onto the y (axle) axis.
    wheel_quat = (math.sqrt(0.5), math.sqrt(0.5), 0.0, 0.0)
    ramp_half, ramp_center, ramp_quat = ramp_slab_pose(c)
    plateau_half = (c.plateau_length_m / 2.0, c.half_width_m, c.ramp_rise_m / 2.0)
    plateau_center = ((c.ramp_end_x_m + c.curb_x_m) / 2.0, 0.0, c.ramp_rise_m / 2.0)
    rest = start_pose(spec, "approach")

    wheels_xml = []
    for name in WHEELS:
        wheels_xml.append(
            f"""      <body name="wheel_{name}" pos="{_fmt(wheel_pos[name])}">
        <joint name="wheel_{name}" type="hinge" axis="0 1 0" damping="{r.wheel_damping_nms_per_rad!r}" armature="{r.wheel_armature_kgm2!r}"/>
        <geom name="wheel_{name}_geom" type="cylinder" size="{r.wheel_radius_m!r} {r.wheel_width_m / 2.0!r}" quat="{_fmt(wheel_quat)}" mass="{r.wheel_mass_kg!r}" rgba="0.15 0.15 0.15 1"/>
        <site name="wheel_touch_{name}" type="sphere" size="{r.wheel_radius_m + 0.01!r}" rgba="0 0 0 0"/>
      </body>"""
        )
    motors_xml = "\n".join(
        f'    <motor name="motor_{n}" joint="wheel_{n}" gear="1" ctrllimited="true" '
        f'ctrlrange="{-r.motor_torque_max_nm!r} {r.motor_torque_max_nm!r}"/>'
        for n in WHEELS
    )
    wheel_vel_xml = "\n".join(f'    <jointvel name="wheel_angvel_{n}" joint="wheel_{n}"/>' for n in WHEELS)
    wheel_force_xml = "\n".join(
        f'    <touch name="wheel_normal_force_{n}" site="wheel_touch_{n}"/>' for n in WHEELS
    )
    return f"""<mujoco model="simforge-delivery-robot-curb-ramp">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="{s.physics_dt_s!r}" gravity="0 0 {-s.gravity_mps2!r}" integrator="Euler" cone="elliptic" solver="Newton"/>
  <default>
    <geom friction="{r.friction_sliding!r}" condim="3"/>
  </default>
  <worldbody>
    <geom name="ground" type="plane" size="0 0 1" rgba="0.55 0.55 0.55 1"/>
    <geom name="ramp" type="box" size="{_fmt(ramp_half)}" pos="{_fmt(ramp_center)}" quat="{_fmt(ramp_quat)}" rgba="0.7 0.7 0.65 1"/>
    <geom name="plateau" type="box" size="{_fmt(plateau_half)}" pos="{_fmt(plateau_center)}" rgba="0.7 0.7 0.65 1"/>
    <body name="chassis" pos="{_fmt(rest.position)}" quat="{_fmt(rest.quaternion)}">
      <freejoint name="root"/>
      <geom name="chassis_geom" type="box" size="{_fmt((r.chassis_length_m / 2.0, r.chassis_width_m / 2.0, r.chassis_height_m / 2.0))}" mass="{r.chassis_mass_kg!r}" rgba="0.9 0.5 0.1 1"/>
      <site name="imu" pos="0 0 0"/>
{chr(10).join(wheels_xml)}
    </body>
  </worldbody>
  <actuator>
{motors_xml}
  </actuator>
  <sensor>
    <framepos name="chassis_pos" objtype="body" objname="chassis"/>
    <framequat name="chassis_quat" objtype="body" objname="chassis"/>
    <framelinvel name="chassis_linvel" objtype="body" objname="chassis"/>
    <frameangvel name="chassis_angvel" objtype="body" objname="chassis"/>
    <accelerometer name="imu_accel" site="imu"/>
    <gyro name="imu_gyro" site="imu"/>
{wheel_vel_xml}
{wheel_force_xml}
  </sensor>
</mujoco>
"""


#: Bodies exported to scene-state, in order.
EXPORTED_BODIES: tuple[str, ...] = ("chassis",) + tuple(f"wheel_{n}" for n in WHEELS)


class Workload:
    """The delivery-robot curb/ramp workload bound to one spec."""

    id = "delivery-robot-curb-ramp"

    def __init__(self, spec: WorkloadSpec | None = None) -> None:
        self.spec = spec or WorkloadSpec()
        self.mjcf = build_mjcf(self.spec)
        digest = hashlib.sha256()
        digest.update(PROFILE_ID.encode())
        digest.update(b"\0")
        digest.update(json.dumps(self.spec.to_dict(), sort_keys=True, separators=(",", ":")).encode())
        digest.update(b"\0")
        digest.update(self.mjcf.encode())
        #: Binds profile, spec and generated model text.
        self.digest = digest.hexdigest()

    @property
    def map_id(self) -> str:
        return f"physics:{self.id}:{self.digest[:16]}"

    # ---------------------------------------------------------------- physics

    def torque_to_hold_on_ramp_nm(self) -> float:
        """Total wheel torque balancing gravity along the ramp slope
        (``m g r sin(alpha)``), ignoring bearing damping. Analytic reference
        for the ramp threshold qualification."""
        r, c, s = self.spec.robot, self.spec.course, self.spec.simulation
        return r.total_mass_kg * s.gravity_mps2 * r.wheel_radius_m * math.sin(c.incline_rad)

    def effective_rolling_mass_kg(self) -> float:
        """Translational-equivalent mass of the rigid no-slip model:
        ``m_total + 4 (I_wheel + armature) / r^2`` with ``I_wheel = m_w r^2 / 2``
        (solid cylinder about its axis, as MuJoCo derives from geom mass)."""
        r = self.spec.robot
        i_wheel = 0.5 * r.wheel_mass_kg * r.wheel_radius_m**2
        return r.total_mass_kg + 4.0 * (i_wheel + r.wheel_armature_kgm2) / r.wheel_radius_m**2

    def flat_rolling_speed_analytic(self, torque_per_wheel_nm: float, t_s: float) -> float:
        """Speed of the rigid no-slip model on flat ground from rest under
        constant per-wheel torque with viscous hinge damping ``c``:
        ``v(t) = v_inf (1 - exp(-t/T))``, ``v_inf = tau r / c``,
        ``T = M_eff r^2 / (4 c)``."""
        r = self.spec.robot
        c = r.wheel_damping_nms_per_rad
        v_inf = torque_per_wheel_nm * r.wheel_radius_m / c
        tau = self.effective_rolling_mass_kg() * r.wheel_radius_m**2 / (4.0 * c)
        return v_inf * (1.0 - math.exp(-t_s / tau))

    def ramp_acceleration_analytic(self, total_torque_nm: float) -> float:
        """Along-slope acceleration of the rigid no-slip model on the ramp,
        ignoring bearing damping: ``(tau_total / r - m g sin(alpha)) / M_eff``."""
        r, c, s = self.spec.robot, self.spec.course, self.spec.simulation
        drive = total_torque_nm / r.wheel_radius_m
        gravity = r.total_mass_kg * s.gravity_mps2 * math.sin(c.incline_rad)
        return (drive - gravity) / self.effective_rolling_mass_kg()

    def clip_action(self, action: np.ndarray) -> np.ndarray:
        limit = self.spec.robot.motor_torque_max_nm
        return np.clip(np.asarray(action, dtype=np.float64), -limit, limit)

    # ---------------------------------------------------------------- episode

    def up_z(self, obs: np.ndarray) -> np.ndarray:
        """World z component of the chassis +z axis for each row of ``obs``."""
        q = obs[..., OBS["chassis_quat"]]
        w, x, y, z = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
        # Third column of the rotation matrix, z row: R[2][2].
        return 1.0 - 2.0 * (x * x + y * y)

    def evaluate(
        self,
        obs: np.ndarray,
        prev_x: np.ndarray,
        action: np.ndarray,
        tick: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, np.ndarray]]:
        """Reward, terminated, truncated and per-row info for a batch.

        ``obs`` has shape (n, OBSERVATION_SIZE); ``prev_x`` (n,) is the chassis
        x before the step; ``action`` (n, 4) the applied torques; ``tick`` (n,)
        the decision index after the step.
        """
        rules, course, sim = self.spec.rules, self.spec.course, self.spec.simulation
        pos = obs[..., OBS["chassis_pos"]]
        x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
        progress = x - prev_x
        effort = np.sum(np.square(action), axis=-1)
        reward = progress - rules.effort_weight_per_nm2 * effort
        up_z = self.up_z(obs)
        reached = x >= course.goal_x_m
        tipped = up_z < rules.tip_up_z_min
        off_corridor = np.abs(y) > rules.corridor_half_width_m
        fallen = z < -0.5
        terminated = reached | tipped | off_corridor | fallen
        truncated = (~terminated) & (tick >= sim.max_decisions)
        contact = obs[..., OBS["wheel_normal_force"]] > 0.0
        info = {
            "progress_m": progress,
            "effort_nm2": effort,
            "goal_distance_m": course.goal_x_m - x,
            "up_z": up_z,
            "wheels_in_contact": np.sum(contact, axis=-1),
            "reached_goal": reached,
            "tipped": tipped,
            "off_corridor": off_corridor,
        }
        return reward, terminated, truncated, info
