"""MuJoCo Warp backend: ``nworld`` worlds of the workload stepped together on a
Warp device.

What this is: real ``mujoco_warp.step`` execution of the same compiled model
the CPU backend runs, with per-world seeds, masked reset, per-world snapshots
and contact/constraint capacity enforcement.

What this is not: a device-resident RL loop. Observations, rewards and
termination are computed on the host from a device-to-host copy of
``sensordata`` every decision (declared in ``capabilities``). Numerical
parity with the CPU backend is measured by the qualification tooling, never
assumed: the device solver runs in float32.

Determinism. MuJoCo Warp itself documents GPU execution as non-deterministic
(mujoco_warp#562): contacts are appended to one batch-wide array through a
global atomic counter, constraint rows are allocated per world through another,
and the composite-inertia, mass-matrix, contact-force, Hessian and cost
reductions accumulate through float32 atomics. Every world therefore sees a
different summation order and identically seeded worlds drift apart. This
backend closes that with Warp's deterministic execution mode
(``warp.DeterministicMode.RUN_TO_RUN``): accumulation atomics are sorted by
(destination, thread) and reduced in that fixed order, and slot-allocating
atomics are replayed with prefix-scanned, thread-ordered slots. Because every
MuJoCo Warp kernel indexes threads world-major, identical worlds then perform
bit-identical work. See :data:`DETERMINISM` for the exact module scope and the
one documented residual.
"""

from __future__ import annotations

import math
import sys
from typing import Any, Sequence

import mujoco
import numpy as np

from .cpu import load_model
from .profile import PROFILE_ID, Backend
from .scene_state import SceneStateRecorder, scene_state_digest
from .types import (
    BackendCapabilityError,
    BackendUnavailableError,
    BatchStepResult,
    ContactCapacityError,
    EpisodeStateError,
    ResetOptions,
    Snapshot,
)
from .workload import ACTION_SIZE, EXPORTED_BODIES, OBS, Workload, start_pose

#: Warp deterministic mode name applied to MuJoCo Warp kernels. ``RUN_TO_RUN``
#: is bit-exact repetition on the same GPU architecture, which is what batch
#: invariance and same-device replay need; cross-architecture reproducibility
#: is not claimed by this profile.
DETERMINISTIC_MODE = "RUN_TO_RUN"

#: Prefix of the Python modules whose Warp kernels implement ``mujoco_warp``.
#: Each Python module is one Warp module; deterministic mode is a Warp module
#: option, so it is applied per module.
MUJOCO_WARP_MODULE_PREFIX = "mujoco_warp._src."

#: MuJoCo Warp modules that must stay in Warp's default atomic mode, with the
#: source-grounded reason. Warp compiles every kernel of a module together, so a
#: single kernel that deterministic codegen rejects disables the mode for the
#: whole module even when the model never launches that kernel.
NONDETERMINISTIC_MODULES: dict[str, str] = {
    "mujoco_warp._src.sensor": (
        "mujoco_warp 3.12 _sensor_tactile issues wp.atomic_max and wp.atomic_add on sensordata_out "
        "(sensor.py:2306-2308); warp 1.17 deterministic mode supports one reduction family per array "
        "per kernel (warp/_src/deterministic.py get_or_create_scatter_target) and rejects the module at "
        "codegen. Tracked upstream as mujoco_warp#562."
    ),
}

#: The only atomic this model executes in a non-deterministic module:
#: ``_sensor_touch`` sums contact normal forces per touch site through hardware
#: float32 atomics. Two summands are order-invariant (``0 + a + b``); three or
#: more are not. A wheel cylinder on the ground plane produces exactly two active
#: contacts and on a course box exactly one (cylinder-box has no multi-contact),
#: so the sum is order-invariant everywhere except while a wheel touches the
#: plane and a box at the same time (ramp entry), where ``wheel_normal_force``
#: may differ across worlds/runs by one float32 ulp (~4e-6 N at 60 N). Physical
#: state is never affected: the touch sensor is read-only.
TOUCH_SENSOR_RESIDUAL = (
    "wheel_normal_force is summed by mujoco_warp._src.sensor._sensor_touch with hardware float32 atomics; "
    "the sum is order-invariant for <= 2 contacts per wheel (plane: 2, box: 1) and may differ by one "
    "float32 ulp when a wheel touches the ground plane and a course box simultaneously (ramp entry). "
    "State is unaffected."
)

#: Per-thread deterministic record bound for MuJoCo Warp's per-launch (module=
#: "unique") kernels. Warp sizes deterministic buffers from the static count of
#: atomic call sites per thread; the narrowphase kernels call ``write_contact``
#: inside data-dependent loops, so the bound is MuJoCo's maximum contacts per
#: geom pair (``mjMAXCONPAIR``). A record overflow raises outside CUDA graph
#: capture (the warm-up in ``MuJoCoWarpBatch.__init__`` runs uncaptured for
#: that reason) and is silent inside a captured graph, so the bound must hold.
UNIQUE_MODULE_MAX_RECORDS = int(mujoco.mjMAXCONPAIR)

#: Static description of the determinism policy for capability reports.
DETERMINISM: dict[str, Any] = {
    "mode": DETERMINISTIC_MODE,
    "mechanism": (
        "warp.config.deterministic + per-module 'deterministic' option: accumulation atomics are "
        "sorted by (destination, thread) and reduced in fixed order; slot-allocating atomics (contact "
        "and constraint-row counters) are replayed with thread-ordered prefix sums, which makes contact "
        "and efc row order world-major and identical across identical worlds"
    ),
    "excluded_modules": dict(NONDETERMINISTIC_MODULES),
    "residual": TOUCH_SENSOR_RESIDUAL,
    "scope": (
        "same GPU architecture; graph capture relies on static per-thread record bounds "
        f"(unique kernels: {UNIQUE_MODULE_MAX_RECORDS}, smooth: nv, solver: ceil(naconmax / JTCJ block)) "
        "and on naconmax not exceeding the convex narrowphase launch width "
        "(mujoco_warp collision_convex._ccd_grid_size: 2 waves x block x occupancy grid, device-dependent)"
    ),
}


def _import_warp():
    try:
        import warp as wp
    except ImportError as exc:
        raise BackendUnavailableError(
            "mujoco-warp backend requires the 'warp' extra: pip install 'simforge-oss-physics[warp]'"
        ) from exc
    # Warp modules snapshot these at creation: mujoco_warp's shared modules at
    # import (overridden per module below), its per-launch unique modules when
    # the first step builds them. Both must see the deterministic defaults.
    wp.config.deterministic = wp.DeterministicMode[DETERMINISTIC_MODE]
    wp.config.deterministic_max_records = max(wp.config.deterministic_max_records, UNIQUE_MODULE_MAX_RECORDS)
    try:
        import mujoco_warp as mjw
    except ImportError as exc:
        raise BackendUnavailableError(
            "mujoco-warp backend requires the 'warp' extra: pip install 'simforge-oss-physics[warp]'"
        ) from exc
    return wp, mjw


def mujoco_warp_modules() -> list[str]:
    """Imported ``mujoco_warp`` kernel modules (test modules excluded)."""
    return sorted(
        name
        for name in sys.modules
        if name.startswith(MUJOCO_WARP_MODULE_PREFIX) and not name.endswith("_test")
    )


#: Per-module record bounds this process has applied; bounds only grow so
#: batches of different sizes keep the largest requirement.
_applied_max_records: dict[str, int] = {}


def configure_deterministic_execution(wp, *, nv: int, ndof_tri: int, naconmax: int, device) -> dict[str, Any]:
    """Apply :data:`DETERMINISTIC_MODE` to every imported MuJoCo Warp module
    except :data:`NONDETERMINISTIC_MODULES`, with exact per-module record
    bounds for the shared modules whose kernels issue atomics inside
    data-dependent loops (the global :data:`UNIQUE_MODULE_MAX_RECORDS` default
    would oversize the solver's Hessian launch by that factor). Module options
    are process-wide. Returns the applied configuration for reports.
    """
    mode = wp.DeterministicMode[DETERMINISTIC_MODE]
    default = wp.DeterministicMode.NOT_GUARANTEED
    # smooth: _qLD_acc subtracts along a row of nnz <= nv entries and
    # _tendon_armature walks <= nv dof ancestors, one atomic per visit.
    smooth_records = int(nv)
    # solver: _update_gradient_JTCJ_dense accumulates H once per contact block
    # in a loop of ceil(naconmax / dim_block) iterations; dim_block mirrors
    # mujoco_warp 3.12 _update_gradient (sm_count * 6 * 256 / ndof_tri on CUDA,
    # naconmax on CPU).
    if device.is_cuda:
        dim_block = math.ceil(device.sm_count * 6 * 256 / max(ndof_tri, 1))
    else:
        dim_block = max(naconmax, 1)
    solver_records = max(1, math.ceil(naconmax / dim_block))
    records = {
        "mujoco_warp._src.smooth": smooth_records,
        "mujoco_warp._src.solver": solver_records,
    }
    applied: dict[str, dict[str, Any]] = {}
    for name in mujoco_warp_modules():
        if name in NONDETERMINISTIC_MODULES:
            wp.set_module_options({"deterministic": default}, module=name)
            continue
        options: dict[str, Any] = {"deterministic": mode}
        if name in records:
            bound = max(_applied_max_records.get(name, 0), records[name])
            _applied_max_records[name] = bound
            options["deterministic_max_records"] = bound
        wp.set_module_options(options, module=name)
        applied[name] = {"max_records": int(wp.get_module_options(name)["deterministic_max_records"])}
    return {
        **DETERMINISM,
        "deterministic_modules": applied,
        "unique_module_max_records": int(wp.config.deterministic_max_records),
        "device": str(device),
    }


def reject_unsupported(model: "mujoco.MjModel") -> None:
    """Refuse model features MuJoCo Warp documents as unsupported
    (README "MuJoCo API Compatibility", mujoco-warp 3.12). ``put_model`` performs
    the authoritative check; this gives a readable error first."""
    problems = []
    if model.opt.integrator == mujoco.mjtIntegrator.mjINT_IMPLICITFAST:
        problems.append("integrator implicitfast")
    if model.opt.solver == mujoco.mjtSolver.mjSOL_PGS:
        problems.append("solver PGS")
    if model.opt.noslip_iterations > 0:
        problems.append("noslip iterations")
    if model.nplugin > 0:
        problems.append("plugin actuators/sensors")
    if model.nflex > 0:
        problems.append("flex bodies (experimental in MJWarp; not admitted by this profile)")
    if problems:
        raise BackendCapabilityError("mujoco-warp does not support: " + ", ".join(problems))


class MuJoCoWarpBatch:
    """Batched finite-episode execution on MuJoCo Warp.

    All worlds advance together; a finished world must be reset through
    ``reset_worlds`` before the batch can step again. Per-world state is
    ``mjSTATE_FULLPHYSICS | mjSTATE_CTRL`` (time, qpos, qvel, act, ctrl): the
    device data does not expose the CPU solver's warm-start vector, so a
    restored Warp world resumes from complete physical state but not from
    identical solver-internal state.

    Construction configures Warp deterministic execution for MuJoCo Warp
    (``determinism`` holds the applied configuration) and runs one uncaptured
    warm-up decision so kernel build errors and deterministic record overflows
    surface here as ``BackendCapabilityError`` instead of silently inside a
    captured graph.
    """

    backend = Backend.MUJOCO_WARP
    state_spec = int(mujoco.mjtState.mjSTATE_FULLPHYSICS) | int(mujoco.mjtState.mjSTATE_CTRL)
    state_spec_name = "mjSTATE_FULLPHYSICS|mjSTATE_CTRL"

    def __init__(
        self,
        workload: Workload | None = None,
        *,
        nworld: int,
        device: str | None = None,
        nconmax: int = 32,
        njmax: int = 128,
        capture_graph: bool = True,
    ) -> None:
        if nworld < 1:
            raise ValueError("nworld must be >= 1")
        wp, mjw = _import_warp()
        self._wp, self._mjw = wp, mjw
        self.workload = workload or Workload()
        self.model = load_model(self.workload)
        reject_unsupported(self.model)
        self.mujoco_version = mujoco.__version__
        self.nworld = int(nworld)
        wp.init()
        self.device = wp.get_device(device) if device else wp.get_preferred_device()
        self._host_data = mujoco.MjData(self.model)
        self._state_size = mujoco.mj_stateSize(self.model, self.state_spec)
        with wp.ScopedDevice(self.device):
            try:
                self.m = mjw.put_model(self.model)
            except Exception as exc:  # mjwarp raises plain exceptions for unsupported fields
                raise BackendCapabilityError(f"mujoco-warp rejected the model: {exc}") from exc
            self.d = mjw.make_data(self.model, nworld=self.nworld, nconmax=nconmax, njmax=njmax)
            self.determinism = configure_deterministic_execution(
                wp,
                nv=self.model.nv,
                ndof_tri=int(self.m.dof_tri_row.size),
                naconmax=int(self.d.naconmax),
                device=self.device,
            )
        self._body_ids = np.array(
            [mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, b) for b in EXPORTED_BODIES]
        )
        self.recorders = [SceneStateRecorder(self.workload) for _ in range(self.nworld)]
        self.tick = np.zeros(self.nworld, dtype=np.int64)
        self.seeds = np.zeros(self.nworld, dtype=np.int64)
        self.starts: list[str] = ["approach"] * self.nworld
        self._lateral = np.zeros(self.nworld)
        self._yaw = np.zeros(self.nworld)
        self._prev_x = np.zeros(self.nworld)
        self.finished = np.ones(self.nworld, dtype=bool)
        self._graph = None
        self.graph_captured = False
        with wp.ScopedDevice(self.device):
            # Uncaptured warm-up from the model's rest pose (wheels in contact):
            # builds every kernel under the deterministic options and lets Warp
            # raise on deterministic record overflow, which a captured graph
            # cannot report. ``reset`` restores the state afterwards.
            try:
                self._advance()
            except Exception as exc:
                raise BackendCapabilityError(
                    f"mujoco-warp kernel build or warm-up failed under deterministic mode {DETERMINISTIC_MODE}: "
                    f"{type(exc).__name__}: {exc}"
                ) from exc
            if capture_graph and self.device.is_cuda:
                with wp.ScopedCapture() as capture:
                    self._advance()
                self._graph = capture.graph
                self.graph_captured = True

    # ------------------------------------------------------------------ api

    @property
    def time_s(self) -> np.ndarray:
        return self.d.time.numpy().astype(np.float64)

    def reset(self, seeds: Sequence[int], options: ResetOptions | None = None) -> BatchStepResult:
        """Reset every world; ``seeds`` has one entry per world."""
        if len(seeds) != self.nworld:
            raise ValueError(f"expected {self.nworld} seeds, got {len(seeds)}")
        return self.reset_worlds(np.ones(self.nworld, dtype=bool), seeds, options)

    def reset_worlds(
        self, mask: np.ndarray, seeds: Sequence[int], options: ResetOptions | None = None
    ) -> BatchStepResult:
        """Reset the worlds where ``mask`` is True. ``seeds`` is indexed by world
        (length ``nworld``; entries for unmasked worlds are ignored)."""
        wp, mjw = self._wp, self._mjw
        options = options or ResetOptions()
        mask = np.asarray(mask, dtype=bool)
        if mask.shape != (self.nworld,):
            raise ValueError(f"mask shape {mask.shape} != ({self.nworld},)")
        if len(seeds) != self.nworld:
            raise ValueError(f"expected {self.nworld} seeds, got {len(seeds)}")
        with wp.ScopedDevice(self.device):
            mjw.reset_data(self.m, self.d, reset=wp.array(mask, dtype=wp.bool))
            qpos = self.d.qpos.numpy()
            qvel = self.d.qvel.numpy()
            ctrl = self.d.ctrl.numpy()
            for w in np.flatnonzero(mask):
                seed = int(seeds[w])
                lateral, yaw = options.sample_pose_offsets(seed)
                pose = start_pose(
                    self.workload.spec,
                    options.start,
                    lateral_offset_m=lateral,
                    yaw_rad=yaw,
                    height_offset_m=options.height_offset_m,
                )
                qpos[w, :] = 0.0
                qpos[w, :7] = pose.qpos()
                qvel[w, :] = 0.0
                ctrl[w, :] = 0.0
                self.seeds[w] = seed
                self.starts[w] = options.start
                self._lateral[w], self._yaw[w] = lateral, yaw
                self.tick[w] = 0
                self.finished[w] = False
                self.recorders[w].clear()
            self._copy_in(self.d.qpos, qpos)
            self._copy_in(self.d.qvel, qvel)
            self._copy_in(self.d.ctrl, ctrl)
            mjw.forward(self.m, self.d)
        obs = self._observe()
        x = obs[:, OBS["chassis_pos"]][:, 0]
        self._prev_x[mask] = x[mask]
        self._record(mask)
        _, _, _, info = self.workload.evaluate(obs, self._prev_x, np.zeros((self.nworld, ACTION_SIZE)), self.tick)
        return BatchStepResult(
            observation=obs,
            reward=np.zeros(self.nworld),
            terminated=np.zeros(self.nworld, dtype=bool),
            truncated=np.zeros(self.nworld, dtype=bool),
            tick=self.tick.copy(),
            time_s=self.time_s,
            info=info,
        )

    def step(self, actions: np.ndarray) -> BatchStepResult:
        """Apply ``actions`` (nworld, 4) N*m and advance every world one decision."""
        if self.finished.any():
            raise EpisodeStateError(
                f"worlds {np.flatnonzero(self.finished).tolist()} are finished; reset them before stepping"
            )
        torque = self.workload.clip_action(actions)
        if torque.shape != (self.nworld, ACTION_SIZE):
            raise ValueError(f"actions shape {torque.shape} != ({self.nworld}, {ACTION_SIZE})")
        wp = self._wp
        with wp.ScopedDevice(self.device):
            self._copy_in(self.d.ctrl, torque)
            if self._graph is not None:
                wp.capture_launch(self._graph)
            else:
                self._advance()
        self._check_capacity()
        self.tick += 1
        obs = self._observe()
        reward, terminated, truncated, info = self.workload.evaluate(obs, self._prev_x, torque, self.tick)
        self._prev_x = obs[:, OBS["chassis_pos"]][:, 0].copy()
        self._record(np.ones(self.nworld, dtype=bool))
        self.finished = terminated | truncated
        return BatchStepResult(
            observation=obs,
            reward=reward,
            terminated=terminated,
            truncated=truncated,
            tick=self.tick.copy(),
            time_s=self.time_s,
            info=info,
        )

    def snapshot(self, world: int) -> Snapshot:
        self._check_world(world)
        with self._wp.ScopedDevice(self.device):
            self._mjw.get_data_into(self._host_data, self.model, self.d, world_id=world)
        state = np.empty(self._state_size, dtype=np.float64)
        mujoco.mj_getState(self.model, self._host_data, state, self.state_spec)
        return Snapshot(
            profile_id=PROFILE_ID,
            backend=self.backend.value,
            workload_id=self.workload.id,
            workload_digest=self.workload.digest,
            mujoco_version=self.mujoco_version,
            state_spec=self.state_spec,
            state_spec_name=self.state_spec_name,
            state=state,
            tick=int(self.tick[world]),
            time_s=float(self.time_s[world]),
            seed=int(self.seeds[world]),
            start=self.starts[world],  # type: ignore[arg-type]
            lateral_offset_m=float(self._lateral[world]),
            yaw_rad=float(self._yaw[world]),
            prev_x_m=float(self._prev_x[world]),
            finished=bool(self.finished[world]),
        )

    def restore(self, world: int, snapshot: Snapshot) -> None:
        self._check_world(world)
        snapshot.check_compatible(
            backend=self.backend,
            workload_digest=self.workload.digest,
            mujoco_version=self.mujoco_version,
            state_spec=self.state_spec,
        )
        mujoco.mj_setState(
            self.model, self._host_data, np.ascontiguousarray(snapshot.state, dtype=np.float64), self.state_spec
        )
        wp, mjw = self._wp, self._mjw
        with wp.ScopedDevice(self.device):
            for name in ("qpos", "qvel", "ctrl", "act"):
                dst = getattr(self.d, name)
                if dst.shape[1] == 0:
                    continue
                rows = dst.numpy()
                rows[world, :] = getattr(self._host_data, name)
                self._copy_in(dst, rows)
            time = self.d.time.numpy()
            time[world] = self._host_data.time
            self._copy_in(self.d.time, time)
            mjw.forward(self.m, self.d)
        self.tick[world] = snapshot.tick
        self.seeds[world] = snapshot.seed
        self.starts[world] = snapshot.start
        self._lateral[world], self._yaw[world] = snapshot.lateral_offset_m, snapshot.yaw_rad
        self._prev_x[world] = snapshot.prev_x_m
        self.finished[world] = snapshot.finished
        self.recorders[world].rewind(snapshot.tick)
        if len(self.recorders[world]) == 0:
            mask = np.zeros(self.nworld, dtype=bool)
            mask[world] = True
            self._record(mask)

    def export_scene_state(self, world: int, from_tick: int = 0) -> dict:
        self._check_world(world)
        return self.recorders[world].export(from_tick)

    def export_digest(self, world: int, from_tick: int = 0) -> str:
        return scene_state_digest(self.export_scene_state(world, from_tick))

    # -------------------------------------------------------------- helpers

    def _check_world(self, world: int) -> None:
        if not 0 <= world < self.nworld:
            raise IndexError(f"world {world} out of range [0, {self.nworld})")

    def _advance(self) -> None:
        """One decision of physics on the current device: ``substeps`` steps and
        a final ``forward`` so sensors reflect the post-step state."""
        mjw = self._mjw
        for _ in range(self.workload.spec.simulation.substeps_per_decision):
            mjw.step(self.m, self.d)
        mjw.forward(self.m, self.d)

    def _copy_in(self, dst, host: np.ndarray) -> None:
        """Host -> device copy into an existing Warp array (keeps graph-captured
        addresses valid)."""
        wp = self._wp
        src = wp.array(np.ascontiguousarray(host), dtype=dst.dtype, device=self.device)
        wp.copy(dst, src)

    def _observe(self) -> np.ndarray:
        return self.d.sensordata.numpy().astype(np.float64)

    def _check_capacity(self) -> None:
        nacon = int(self.d.nacon.numpy()[0])
        if nacon >= self.d.naconmax:
            raise ContactCapacityError(
                f"contacts {nacon} reached naconmax {self.d.naconmax}; raise nconmax (per world) to keep every contact"
            )
        nefc = self.d.nefc.numpy()
        over = np.flatnonzero(nefc >= self.d.njmax)
        if over.size:
            raise ContactCapacityError(
                f"worlds {over.tolist()} reached njmax {self.d.njmax} constraints; raise njmax"
            )

    def _record(self, mask: np.ndarray) -> None:
        xpos = self.d.xpos.numpy()[:, self._body_ids, :]
        xquat = self.d.xquat.numpy()[:, self._body_ids, :]
        sd = self.d.sensordata.numpy()
        time = self.time_s
        for w in np.flatnonzero(mask):
            self.recorders[w].record(
                int(self.tick[w]),
                float(time[w]),
                xpos[w],
                xquat[w],
                sd[w, OBS["chassis_linvel"]],
                sd[w, OBS["chassis_angvel"]],
            )
