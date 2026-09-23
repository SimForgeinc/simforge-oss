from __future__ import annotations
from .._compat_env import simforge_env
import shutil

import hashlib
import gzip
import json
import os
import platform
import subprocess
import zipfile
import tempfile
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Mapping

from .transport import download, upload
from ..actor_bindings import load as load_actor_bindings
from .backend import RenderBackend, presentation_video_codec_args, runtime_asset_bindings
# historical name retained for stored-data compat
from .compiler import (
    LIFECYCLE_ABSENT,
    ExecutionPlan,
    PlanFrame,
    compile_xosc14,
    substitute_actor_catalog_bindings,
)
from .contract import (
    CAMERA_MODALITIES,
    EXECUTION_MODE_PHYSICS_VALIDATION,
    EXECUTION_MODE_TRACE_REPLAY,
    EXECUTION_PURPOSE,
    REPLAY_PARITY_TOLERANCES,
    ContractError,
    Lease,
    MAX_ARTIFACT_BYTES,
    MAX_CAPTURE_FRAMES,
    MAX_CATALOG_BYTES,
    MAX_DURATION_SECONDS,
    MAX_MANIFEST_BYTES,
    MAX_OUTPUT_BYTES,
    MAX_SENSOR_PIXELS,
    MAX_TRAFFIC_BYTES,
    MAX_XODR_BYTES,
    MAX_XOSC_BYTES,
    SCHEMA,
    reject_unsafe_xml_envelope,
)
from .parity import ParityAccumulator
from .replay import RenderPose, ReplayParityGate, expected_replay_poses, timeline_observation
from .timeline import BoundTimeline, PlanTimeline, RenderWindow, load_bound_timeline, resolve_render_window
from .sensor_video import SENSOR_VISUALIZATION_CODEC_ARGS, encode_sensor_video, visualization_scales
from .materialized_traffic import merge_materialized_traffic, parse_materialized_traffic
from .validation import validate_xosc14
from .policy import (
    SUBSTITUTION_CARLA_ACTOR_BODY,
    CarlaRenderError,
    RenderPolicy,
    lidar_ticks_per_revolution,
    substitution_record,
)

Download = Callable[[str, int], bytes]
ArtifactBody = bytes | Path
Upload = Callable[[str, ArtifactBody, str, Mapping[str, str] | None], None]
Validate = Callable[[bytes], Mapping[str, object]]
Control = Callable[[Mapping[str, object]], bool]
Deadline = float | Callable[[], float]


class CancellationRequested(RuntimeError):
    pass


class LeaseDeadlineExceeded(RuntimeError):
    pass


class _BoundedWriter:
    def __init__(self, target: Any, max_bytes: int, label: str):
        self.target = target
        self.max_bytes = max_bytes
        self.label = label
        self.written = 0

    def write(self, body: bytes) -> int:
        if self.written + len(body) > self.max_bytes:
            raise ContractError(f"{self.label} exceeds the shared temporary-disk budget")
        count = self.target.write(body)
        self.written += count
        return count

    def flush(self) -> None:
        self.target.flush()

    def tell(self) -> int:
        return self.target.tell()


class _ExecutionFence:
    """Cheap local deadline checks with bounded control-plane polling."""

    def __init__(self, deadline: Callable[[], float | None], control: Control | None, poll_interval_s: float = 5.0):
        self.deadline = deadline
        self.control = control
        self.poll_interval_s = poll_interval_s
        self.last_poll = float("-inf")
        self.last_stage: str | None = None

    def check(self, stage: str, completed_frames: int = 0, total_frames: int = 1) -> None:
        now = time.monotonic()
        deadline = self.deadline()
        if deadline is not None and now >= deadline:
            raise LeaseDeadlineExceeded(f"lease deadline exceeded during {stage}")
        if self.control and (stage != self.last_stage or now - self.last_poll >= self.poll_interval_s):
            self.last_stage = stage
            self.last_poll = now
            if self.control({"stage": stage, "completedFrames": completed_frames, "totalFrames": total_frames}):
                raise CancellationRequested("render cancellation requested by control plane")
        deadline = self.deadline()
        if deadline is not None and time.monotonic() >= deadline:
            raise LeaseDeadlineExceeded(f"lease deadline exceeded during {stage}")


def _attestation(
    validation: Mapping[str, object],
    execution_mode: str,
    runtime_evidence: Mapping[str, object],
) -> dict[str, object]:
    # Identity is attested from the worker environment and never invented: an
    # unset value is recorded as null, not as the version the image usually has.
    worker_image = os.environ.get("SIMFORGE_WORKER_IMAGE_DIGEST")
    worker_revision = os.environ.get("SIMFORGE_WORKER_REVISION")
    return {
        "schema": "simforge.worker-attestation/v1",
        "workerImageDigest": worker_image,
        "workerRevision": worker_revision,
        "carlaVersion": os.environ.get("SIMFORGE_CARLA_VERSION"),
        "carlaServerVersion": runtime_evidence.get("carlaServerVersion"),
        "engineVersion": os.environ.get("SIMFORGE_ENGINE_VERSION"),
        "pythonVersion": platform.python_version(),
        "hostNode": platform.node(),
        "hostPlatform": platform.platform(),
        "executionMode": execution_mode,
        "purpose": EXECUTION_PURPOSE[execution_mode],
        "scenarioRender": execution_mode == EXECUTION_MODE_TRACE_REPLAY,
        "physicsAuthority": execution_mode == EXECUTION_MODE_PHYSICS_VALIDATION,
        "acceptanceEligible": True,
        "workerIdentityComplete": bool(worker_image) and bool(worker_revision),
        "runtimeEvidence": dict(runtime_evidence),
        "xoscValidation": dict(validation),
    }


def _trace_to_path(plan: ExecutionPlan, readbacks: list[Mapping[str, Mapping[str, object]]], signal_readbacks: list[Mapping[str, str]], collision_readbacks: list[list[Mapping[str, object]]], control_sha256: str, source_input_digest: str, materialized_traffic_digest: str, destination: Path, max_bytes: int, abort: Callable[[], None], readback_times: list[float] | None = None) -> Path:
    if len(readbacks) != len(plan.frames) or len(signal_readbacks) != len(plan.frames) or len(collision_readbacks) != len(plan.frames):
        raise RuntimeError("trace readbacks are not frame-closed")
    times = readback_times if readback_times is not None else [frame.t for frame in plan.frames]
    if len(times) != len(plan.frames):
        raise RuntimeError("trace readback labels are not frame-closed")
    with destination.open("wb") as raw:
        bounded = _BoundedWriter(raw, max_bytes, "trace")
        with gzip.GzipFile(filename="", mode="wb", fileobj=bounded, compresslevel=6, mtime=0) as encoded:
            encoded.write(b'{"executionPackageControlSha256":')
            encoded.write(json.dumps(control_sha256).encode())
            encoded.write(b',"sourceInputDigest":')
            encoded.write(json.dumps(source_input_digest).encode())
            encoded.write(b',"materializedTrafficDigest":')
            encoded.write(json.dumps(materialized_traffic_digest).encode())
            encoded.write(b',"fixedTimestepS":')
            encoded.write(json.dumps(plan.fixed_timestep_s, separators=(",", ":")).encode())
            encoded.write(b',"frames":[')
            for index, (frame, readback, signals, collisions, observed_t) in enumerate(zip(plan.frames, readbacks, signal_readbacks, collision_readbacks, times)):
                abort()
                if index:
                    encoded.write(b",")
                # ``t`` is the clip time the readback actually shows: the
                # sampled capture time in replay, and the post-tick time
                # (one step after the applied frame) under physics validation.
                encoded.write(json.dumps({"index": frame.index, "t": observed_t, "actors": readback, "signals": signals, "collisions": collisions}, sort_keys=True, separators=(",", ":")).encode())
            encoded.write(b'],"planSha256":')
            encoded.write(json.dumps(plan.sha256).encode())
            encoded.write(b',"schema":"simforge.render-trace/v1","signalStateSource":"backend-verified"}')
            abort()
    return destination


def _archive_sensor_data(
    sensor_dir: Path,
    destination: Path,
    max_bytes: int,
    abort: Callable[[], None] | None = None,
) -> Path:
    """Consolidate one LiDAR or radar stream into a single upload artifact."""
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for frame in sorted(sensor_dir.rglob("*")):
            if not frame.is_file():
                continue
            if abort:
                abort()
            archive.write(frame, arcname=str(frame.relative_to(sensor_dir)))
    if destination.stat().st_size > max_bytes:
        raise ContractError(f"sensor data artifact {sensor_dir.name} exceeds its budget")
    return destination


def _collect_camera_video(
    frame_dir: Path,
    camera_name: str,
    fps: float,
    destination: Path,
    expected_frame_count: int,
    max_bytes: int,
    check_abort: Callable[[str, int, int], None],
    deadline_monotonic: Callable[[], float],
) -> Path:
    """Adopt the camera's streamed h264 file and prove it frame-closed.

    Individual camera frames are never written to disk: the backend pipes raw
    frames into one ffmpeg encoder per camera and this collector validates the
    resulting stream against the capture schedule.
    """
    stream = frame_dir / camera_name / "stream.mp4"
    if not stream.is_file() or stream.stat().st_size == 0:
        raise RuntimeError(f"camera {camera_name} produced no encoded video stream")
    if stream.stat().st_size > max_bytes:
        raise ContractError(f"camera video {camera_name} exceeds its output budget")
    _verify_video_frames(stream, f"camera video {camera_name}", fps, expected_frame_count, check_abort, deadline_monotonic)
    shutil.copyfile(stream, destination)
    return destination


def _verify_video_frames(
    stream: Path,
    label: str,
    fps: float,
    expected_frame_count: int,
    check_abort: Callable[[str, int, int], None],
    deadline_monotonic: Callable[[], float],
) -> None:
    """Prove an encoded video holds exactly the scheduled frames."""
    probe = _run_process([
        "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames,duration", "-of", "json", str(stream),
    ], "probe_video", check_abort, deadline_monotonic)
    if probe.returncode:
        raise RuntimeError(f"ffprobe failed: {probe.stderr.decode(errors='replace')}")
    try:
        stream_info = json.loads(probe.stdout)["streams"][0]
        frame_count = int(stream_info["nb_read_frames"])
        duration = float(stream_info["duration"])
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("ffprobe did not return frame-closed video metadata") from exc
    expected_duration = expected_frame_count / fps
    if frame_count != expected_frame_count or abs(duration - expected_duration) > (1 / fps):
        raise RuntimeError(
            f"{label} is not frame-closed: {frame_count} frames/{duration}s, "
            f"expected {expected_frame_count}/{expected_duration}s"
        )


def _catalog_dims(entry: Mapping[str, object]) -> Mapping[str, float] | None:
    dims = entry.get("dims")
    if not isinstance(dims, Mapping):
        return None
    narrowed: dict[str, float] = {}
    for axis in ("l", "w", "h"):
        value = dims.get(axis)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            return None
        narrowed[axis] = float(value)
    return narrowed


#: Catalog binding fidelities that mean "this blueprint is the authored body".
#: Anything else (`semantic-substitute`, a generated blueprint the image does
#: not ship) is a different body, i.e. a substitution.
EXACT_BINDING_FIDELITIES = frozenset({"exact", "native-blueprint"})
ROAD_USER_VEHICLE_KINDS = frozenset({"vehicle", "car", "truck", "bus", "van", "motorcycle", "bicycle", "scooter"})


def _native_prefixes(kind: str) -> tuple[str, ...] | None:
    if kind in ROAD_USER_VEHICLE_KINDS:
        return ("vehicle.", "bike.")
    if kind == "pedestrian":
        return ("walker.",)
    return None


def _resolve_actor_bodies(
    plan: ExecutionPlan,
    catalog: Mapping[str, Mapping[str, object]],
    policy: RenderPolicy,
    abort: Callable[[], None] | None = None,
    spawnable: frozenset[str] | None = None,
) -> tuple[ExecutionPlan, tuple[dict[str, object], ...]]:
    """Bind every actor to the CARLA body it is rendered with, or fail.

    An actor renders its catalog binding when that binding is the authored
    body (`fidelity` exact or native-blueprint) and, once the world is loaded,
    the runtime was observed to place it (`spawnable`: a cook registers the
    superset blueprint registry while shipping assets for only part of it).

    Anything else is a substitution and fails `carla_blueprint_unavailable`
    unless the intent allows `carla-actor-body`. When allowed, a road user
    moves to the dimensionally nearest same-class body the runtime can place
    (never across `actorClass`, so a car cannot become a bus and a child
    walker can become an adult only because the intent said so, recorded);
    a catalog-declared substitute body (`semantic-substitute`) is used as the
    catalog binds it. Each substitution is returned as a manifest record.
    """
    check = abort or (lambda: None)
    replacements: dict[str, str] = {}
    records: list[dict[str, object]] = []
    allowed = policy.allows(SUBSTITUTION_CARLA_ACTOR_BODY)

    def refuse(actor_id: str, catalog_id: str, reason: str) -> None:
        raise CarlaRenderError(
            "carla_blueprint_unavailable",
            f'actor {actor_id} (catalog "{catalog_id}"): {reason}; the render intent does not allow '
            f"the {SUBSTITUTION_CARLA_ACTOR_BODY} substitution",
        )

    for actor_id, binding in sorted(plan.actors.items()):
        check()
        entry = catalog.get(binding.catalog_name)
        if not isinstance(entry, Mapping):
            raise ContractError(f"asset catalog has no CARLA binding for {actor_id} ({binding.catalog_name})")
        blueprint = entry.get("blueprintId")
        fidelity = entry.get("fidelity")
        if isinstance(blueprint, str) and blueprint and (not isinstance(fidelity, str) or not fidelity):
            raise CarlaRenderError(
                "carla_catalog_binding_incomplete",
                f'catalog "{binding.catalog_name}" (actor {actor_id}) declares no CARLA binding fidelity, '
                "so CARLA cannot tell its body from a substitute",
            )
        prefixes = _native_prefixes(binding.kind)
        native = isinstance(blueprint, str) and (prefixes is None or blueprint.startswith(prefixes))
        placeable = native and (spawnable is None or blueprint in spawnable)
        if placeable and fidelity in EXACT_BINDING_FIDELITIES:
            continue
        if placeable:
            # The catalog itself binds a different body (e.g. a cone of other
            # dimensions for the authored one).
            if not allowed:
                refuse(actor_id, binding.catalog_name, f"the catalog binds {blueprint}, a {fidelity} of the authored body")
            records.append(substitution_record(
                SUBSTITUTION_CARLA_ACTOR_BODY, actor_id, binding.catalog_name, str(blueprint),
                reason=f"catalog binding fidelity {fidelity}", renderedCatalogId=binding.catalog_name,
            ))
            continue
        reason = (
            (f"no CARLA body is bound: {entry['unavailableReason']}" if entry.get("unavailableReason")
             else f"the catalog binds no native CARLA body ({blueprint!r})") if not native
            else f"this CARLA runtime cannot place {blueprint}"
        )
        if prefixes is None:
            # Props and other non-road users have no class-level substitute.
            raise CarlaRenderError("carla_blueprint_unavailable", f'actor {actor_id} (catalog "{binding.catalog_name}"): {reason}')
        if not allowed:
            refuse(actor_id, binding.catalog_name, reason)
        authored_class = entry.get("actorClass")
        if not isinstance(authored_class, str) or not authored_class:
            raise ContractError(f'road user {actor_id} catalog "{binding.catalog_name}" declares no actorClass')
        authored_dims = _catalog_dims(entry)
        if authored_dims is None:
            raise CarlaRenderError(
                "carla_blueprint_unavailable",
                f'actor {actor_id} (catalog "{binding.catalog_name}"): {reason}, and the catalog gives no '
                "dimensions to choose the nearest substitute body by",
            )
        candidates: list[tuple[float, str, Mapping[str, float], str]] = []
        for candidate_id, candidate in catalog.items():
            candidate_blueprint = candidate.get("blueprintId")
            if (
                candidate.get("actorClass") != authored_class
                or not isinstance(candidate_blueprint, str)
                or not candidate_blueprint.startswith(prefixes)
                or candidate.get("fidelity") not in EXACT_BINDING_FIDELITIES
                or (spawnable is not None and candidate_blueprint not in spawnable)
            ):
                continue
            dims = _catalog_dims(candidate)
            if dims is None:
                continue
            distance = sum(abs(dims[axis] - authored_dims[axis]) for axis in ("l", "w", "h"))
            candidates.append((distance, candidate_id, dims, candidate_blueprint))
        if not candidates:
            raise CarlaRenderError(
                "carla_blueprint_unavailable",
                f'actor {actor_id} (catalog "{binding.catalog_name}"): {reason}, and no same-class '
                f'("{authored_class}") catalog body with dimensions is placeable',
            )
        _, substitute_id, substitute_dims, substitute_blueprint = min(candidates, key=lambda item: (item[0], item[1]))
        replacements[actor_id] = substitute_id
        records.append(substitution_record(
            SUBSTITUTION_CARLA_ACTOR_BODY, actor_id, binding.catalog_name, substitute_id,
            reason=reason,
            actorClass=authored_class,
            renderedBlueprintId=substitute_blueprint,
            lengthDeltaM=substitute_dims["l"] - authored_dims["l"],
            widthDeltaM=substitute_dims["w"] - authored_dims["w"],
            heightDeltaM=substitute_dims["h"] - authored_dims["h"],
        ))
    return (
        substitute_actor_catalog_bindings(plan, replacements, abort),
        tuple(records),
    )


def _run_process(
    command: list[str],
    stage: str,
    check_abort: Callable[[str, int, int], None],
    deadline_monotonic: Callable[[], float],
) -> Any:
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        while True:
            check_abort(stage, 0, 1)
            remaining = deadline_monotonic() - time.monotonic()
            if remaining <= 0:
                raise LeaseDeadlineExceeded(f"lease deadline exceeded during {stage}")
            try:
                stdout, stderr = process.communicate(timeout=min(1.0, remaining))
                check_abort(stage, 1, 1)
                return type("ProcessResult", (), {"returncode": process.returncode, "stdout": stdout, "stderr": stderr})()
            except subprocess.TimeoutExpired:
                continue
    except BaseException:
        process.kill()
        process.communicate()
        raise


def _capture_schedule(
    plan: ExecutionPlan,
    fps: float,
    abort: Callable[[], None] | None = None,
    execution_mode: str = EXECUTION_MODE_TRACE_REPLAY,
    window: RenderWindow | None = None,
) -> dict[int, tuple[int, float, float]]:
    """Map each output frame to the 50 Hz tick it is rendered on.

    Returns ``{tick: (outputFrameIndex, scheduledTimeS, contentTimeS)}``.
    Output frame ``k`` is scheduled at exactly ``start + k / fps`` (``start``
    is the window's clip start, 0 for the full clip) and rendered on the
    nearest tick. Its content time is what the pixels actually show:

    * fps dividing 50 (1, 2, 5, 10, 25, 50): the tick *is* the scheduled time;
    * other fps in trace replay (the product's 20/24/30): the sampler is
      evaluated at exactly the scheduled time on that tick, so the frame
      still shows its scheduled instant (sub-tick sampling, never
      nearest-tick snapping);
    * physics validation cannot sample off-tick: the pixels show the world
      one step after the applied frame, and are labelled with that time.
    """
    check = abort or (lambda: None)
    check()
    if not plan.frames or plan.frames[0].t != 0:
        raise RuntimeError("execution plan must begin at t=0")
    window = window or resolve_render_window(plan, None, execution_mode)
    exact_count = (window.end_s - window.start_s) * fps
    expected_count = round(exact_count)
    if abs(exact_count - expected_count) > 1e-6:
        raise CarlaRenderError(
            "carla_clip_frame_count_fractional",
            f"the {window.end_s - window.start_s:g} s clip at {fps:g} fps is {exact_count:g} frames; "
            "CARLA renders a whole number of frames and does not round the clip",
        )
    # A window starting on a frame boundary labels its frames exactly like
    # the full-clip render labels the same frames.
    start_frames = window.start_s * fps
    aligned_start = round(start_frames) if abs(start_frames - round(start_frames)) <= 1e-6 else None
    dt = plan.fixed_timestep_s
    replay = execution_mode == EXECUTION_MODE_TRACE_REPLAY
    schedule: dict[int, tuple[int, float, float]] = {}
    for output_index in range(expected_count):
        if output_index % 50 == 0:
            check()
        scheduled_time = (
            (aligned_start + output_index) / fps if aligned_start is not None
            else window.start_s + output_index / fps
        )
        plan_index = round(scheduled_time / dt)
        if plan_index in schedule or not window.start_tick <= plan_index < window.end_tick:
            raise CarlaRenderError(
                "carla_render_fps_unrepresentable",
                f"render fps {fps:g} cannot be represented by unique 50 Hz CARLA frames",
            )
        tick_time = plan.frames[plan_index].t
        content_time = scheduled_time if replay else round(tick_time + dt, 9)
        schedule[plan_index] = (output_index, scheduled_time, content_time)
    check()
    return schedule


def capture_policy(fps: float, execution_mode: str) -> str:
    divides = abs(50.0 / fps - round(50.0 / fps)) < 1e-9
    if divides:
        return "tick-aligned" if execution_mode == EXECUTION_MODE_TRACE_REPLAY else "tick-aligned-post-step"
    return "sub-tick-sampled" if execution_mode == EXECUTION_MODE_TRACE_REPLAY else "nearest-tick-post-step"


def _annotations_to_path(plan: ExecutionPlan, readbacks: list[Mapping[str, Mapping[str, float]]], capture_schedule: Mapping[int, tuple[int, float, float]], destination: Path, max_bytes: int, abort: Callable[[], None], sampled_frames: Mapping[int, PlanFrame] | None = None, first_tick: int = 0) -> Path:
    """``readbacks[i]`` is the readback of tick ``first_tick + i`` (the render window's start)."""
    with destination.open("wb") as target:
        bounded = _BoundedWriter(target, max_bytes, "annotations")
        for plan_index, (output_index, scheduled_time, content_time) in sorted(capture_schedule.items(), key=lambda item: item[1][0]):
            abort()
            frame = (sampled_frames or {}).get(plan_index, plan.frames[plan_index])
            actors = readbacks[plan_index - first_tick]
            bounded.write(json.dumps({
            "schema": "simforge.annotation-frame/v1",
            "index": output_index,
            "scheduledTimeS": scheduled_time,
            "contentTimeS": content_time,
            "simulationFrameIndex": frame.index,
            "t": content_time,
            "actors": actors,
            "signals": frame.signals,
            }, sort_keys=True, separators=(",", ":")).encode() + b"\n")
        abort()
    return destination


def _visual_cue(key: str) -> bool:
    """`cue.*` keys are OpenSCENARIO `UserDefinedAnimation` requests; all but
    `audio.*` (no picture) ask for something to be seen."""
    return key.startswith("cue.") and not key.startswith("cue.audio.")


def _appearance_capability(
    plan: ExecutionPlan,
    abort: Callable[[], None] | None = None,
    rendered_keys: set[str] | None = None,
) -> dict[str, list[str]]:
    """Report which authored appearance state reached pixels, and which did not.

    `rendered_keys` is what the replay actually applied (the sampler's frames,
    which for a baked render timeline differ from the xosc plan). Visual cues
    never reach this point (they fail the job); audio cues have no picture and
    are listed as not rendered.
    """
    authored: set[str] = set()
    despawned: set[str] = set()
    for frame in plan.frames:
        if abort:
            abort()
        for actor_id, state in frame.actors.items():
            if state.lifecycle == LIFECYCLE_ABSENT:
                despawned.add(actor_id)
            authored.update(state.appearance)
    applied = authored if rendered_keys is None else set(rendered_keys)
    return {
        "rendered": sorted(key for key in applied if not key.startswith("cue.")),
        "unrenderedCues": sorted(key for key in authored if key.startswith("cue.")),
        "despawnedActors": sorted(despawned),
    }


def _preflight_appearance(plan: ExecutionPlan) -> None:
    """Refuse authored appearance CARLA cannot render."""
    visual_cues = sorted({
        f"{actor_id}:{key}"
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        for key in state.appearance
        if _visual_cue(key)
    })
    if visual_cues:
        # CARLA 0.10 has no named-animation library to pose a walker's arm or
        # a paddle; rendering without the pose would show a different scene.
        raise CarlaRenderError(
            "carla_appearance_cue_unsupported",
            "CARLA cannot render authored UserDefinedAnimation poses: " + ", ".join(visual_cues[:12]),
        )


def _preflight_execution_semantics(lease: Lease, plan: ExecutionPlan) -> dict[str, str]:
    """Reject semantics the selected execution mode cannot honestly execute.

    Physics validation used to drop actors it could not execute (knockdown
    poses, appearance cues, reverse non-vehicles, moving static objects) and
    still succeed; an actor missing from the output is never acceptable, so
    each of those now fails the job, naming the actors.
    """
    if lease.render_spec.execution_mode != "native-physics":
        return {}
    downed_actors = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if state.downed
    })
    unsupported = {
        actor_id: "authored knockdown poses need a post-spawn teleport native physics cannot make"
        for actor_id in downed_actors
    }
    cue_actors = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if any(key.startswith("cue.") for key in state.appearance)
    })
    for actor_id in cue_actors:
        unsupported.setdefault(actor_id, "appearance cues are not executable under native physics")
    reverse_non_vehicles = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if state.speed_mps < -1e-6
        and plan.actors[actor_id].kind not in ROAD_USER_VEHICLE_KINDS
    })
    for actor_id in reverse_non_vehicles:
        unsupported.setdefault(actor_id, "a non-vehicle cannot move in reverse under native physics")
    unsupported_moving = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if abs(state.speed_mps) > 1e-6
        and plan.actors[actor_id].kind in {"animal", "static", "static_object"}
    })
    for actor_id in unsupported_moving:
        unsupported.setdefault(actor_id, "a moving non-actuated actor cannot be driven by native physics")
    if unsupported:
        raise CarlaRenderError(
            "carla_physics_validation_unsupported",
            "native physics cannot execute these actors, and dropping them would change the output: "
            + "; ".join(f"{actor_id}: {reason}" for actor_id, reason in sorted(unsupported.items())),
        )
    invalid_vehicle_appearance = sorted({
        actor_id
        for frame in plan.frames
        for actor_id, state in frame.actors.items()
        if any(key.startswith(("light.", "door.")) for key in state.appearance)
        and plan.actors[actor_id].kind not in ROAD_USER_VEHICLE_KINDS
    })
    if invalid_vehicle_appearance:
        raise ContractError(
            "native physics vehicle appearance actions target non-vehicle actors: "
            + ", ".join(invalid_vehicle_appearance)
        )
    despawned = set(_appearance_capability(plan)["despawnedActors"])
    invalid_mounts = sorted({
        sensor.actor_id for sensor in lease.render_spec.sensors
        if sensor.actor_id in despawned
    })
    if invalid_mounts:
        raise ContractError(
            "native sensors cannot remain frame-closed when their attached actor is deleted: "
            + ", ".join(invalid_mounts)
        )
    return {}


def _optional_backend_call(backend: RenderBackend, name: str, *args: object, abort: Callable[[], None]) -> Any:
    method = getattr(backend, name, None)
    if not callable(method):
        return None
    return method(*args, abort=abort)


def _preflight_asset_semantics(
    plan: ExecutionPlan,
    catalog: Mapping[str, Mapping[str, object]],
) -> None:
    vehicle_kinds = {"vehicle", "car", "truck", "bus", "van", "motorcycle", "bicycle", "scooter"}
    for actor_id, binding in plan.actors.items():
        entry = catalog.get(binding.catalog_name)
        blueprint = entry.get("blueprintId") if entry else None
        if not blueprint:
            raise ContractError(f"asset catalog has no CARLA blueprint for {actor_id}")
        if binding.kind in vehicle_kinds and not blueprint.startswith(("vehicle.", "bike.")):
            raise ContractError(f"vehicle actor {actor_id} is bound to non-vehicle CARLA blueprint {blueprint}")
        if binding.kind == "pedestrian" and not blueprint.startswith("walker."):
            raise ContractError(f"pedestrian actor {actor_id} is bound to non-walker CARLA blueprint {blueprint}")


def _manifest_to_path(
    lease: Lease,
    plan: ExecutionPlan,
    sensor_records: list[Mapping[str, Any]],
    validation: Mapping[str, object],
    parity: Mapping[str, object],
    parity_evidence: Mapping[str, object],
    attestation: Mapping[str, object],
    artifacts: list[Mapping[str, object]],
    destination: Path,
    max_bytes: int,
    abort: Callable[[], None],
    substitutions: tuple[Mapping[str, object], ...],
    extras: Mapping[str, object] | None = None,
    rendered_appearance: set[str] | None = None,
) -> Path:
    value = {
        **dict(extras or {}),
        "schema": "simforge.render-manifest/v1",
        "jobId": lease.job_id,
        "attempt": lease.attempt,
        "executionPackageId": lease.execution_package.id,
        "executionPackageControlSha256": lease.execution_package.control_sha256,
        "executionManifestSha256": lease.execution_package.manifest.sha256,
        "revisionId": lease.execution_package.revision_id,
        "sourceInputDigest": lease.execution_package.source_input_digest,
        "materializedTrafficDigest": lease.execution_package.materialized_traffic_digest,
        "planSha256": plan.sha256,
        "renderSpec": asdict(lease.render_spec),
        "jobMode": lease.job_mode,
        "ambient": {key: value for key, value in lease.execution_package.ambient.items() if key != "materializedTraffic"},
        "inputs": {
            "manifest": {"sha256": lease.execution_package.manifest.sha256, "sizeBytes": lease.execution_package.manifest.size_bytes},
            "xosc": {"sha256": lease.execution_package.xosc.sha256, "sizeBytes": lease.execution_package.xosc.size_bytes, "xsdSha256": lease.execution_package.xosc.xsd_sha256},
            "xodr": {"sha256": lease.execution_package.xodr.sha256, "sizeBytes": lease.execution_package.xodr.size_bytes, "mapName": lease.execution_package.xodr.map_name},
            "assetCatalog": {"sha256": lease.execution_package.asset_catalog.sha256, "sizeBytes": lease.execution_package.asset_catalog.size_bytes, "catalogVersionId": lease.execution_package.asset_catalog.catalog_version_id},
            "actorBindings": load_actor_bindings().evidence(),
        },
        "runtimeRequirements": asdict(lease.execution_package.runtime_requirements),
        "xoscValidation": dict(validation),
        "workerAttestation": dict(attestation),
        "parity": dict(parity),
        "substitutions": [dict(item) for item in substitutions],
        "parityEvidence": dict(parity_evidence),
        "artifacts": [dict(item) for item in artifacts],
        "sensorFrames": sensor_records,
        "capture": {
            "frameCount": len(sensor_records) // max(1, len(lease.render_spec.sensors)),
            "fps": lease.render_spec.fps,
            # The plan here is the rendered window; its first frame is the
            # window start (clip t=0 for a full render).
            "durationS": plan.frames[-1].t - plan.frames[0].t,
            "policy": capture_policy(lease.render_spec.fps, lease.render_spec.execution_mode),
            "labelSemantics": "contentTimeS is the clip time the pixels show",
        },
        "capabilities": {
            "execution": lease.render_spec.execution_mode,
            "sensors": sorted({sensor.modality for sensor in lease.render_spec.sensors}),
            "fixedTimestepS": plan.fixed_timestep_s,
            "appearance": _appearance_capability(plan, abort, rendered_appearance),
        },
    }
    with destination.open("wb") as target:
        bounded = _BoundedWriter(target, max_bytes, "manifest")
        for chunk in json.JSONEncoder(sort_keys=True, separators=(",", ":")).iterencode(value):
            abort()
            bounded.write(chunk.encode())
        abort()
    return destination


def _collision_onsets(events: object, fixed_timestep_s: float, *, authored: bool) -> dict[tuple[str, str], int]:
    result: dict[tuple[str, str], int] = {}
    if not isinstance(events, (list, tuple)):
        return result
    for item in events:
        if not isinstance(item, Mapping):
            continue
        if authored:
            if item.get("kind") != "collision":
                continue
            left, right = item.get("a"), item.get("b")
            t = item.get("t")
            if not isinstance(t, (int, float)):
                continue
            frame = round(float(t) / fixed_timestep_s)
        else:
            pair = item.get("pair")
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                continue
            left, right = pair
            frame = item.get("frame")
            if not isinstance(frame, int):
                continue
        if not isinstance(left, str) or not left or not isinstance(right, str) or not right or left == right:
            continue
        pair_key = tuple(sorted((left, right)))
        result[pair_key] = min(frame, result.get(pair_key, frame))
    return result



_ENVIRONMENT_FIELDS = (
    "cloudiness",
    "precipitation",
    "precipitation_deposits",
    "wind_intensity",
    "sun_azimuth_angle",
    "sun_altitude_angle",
    "fog_density",
    "fog_distance",
    "wetness",
)


def _environment_values_match(
    actual: object,
    expected: Mapping[str, float],
) -> bool:
    if not isinstance(actual, Mapping) or set(actual) != set(_ENVIRONMENT_FIELDS):
        return False
    for field in _ENVIRONMENT_FIELDS:
        value = actual.get(field)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        difference = (
            abs((float(expected[field]) - float(value) + 180.0) % 360.0 - 180.0)
            if field == "sun_azimuth_angle"
            else abs(float(expected[field]) - float(value))
        )
        if difference > 1e-4:
            return False
    return True


def _environment_evidence_is_accepted(environment: object, requested: object) -> bool:
    """The runtime showed exactly the requested environment.

    Either CARLA applied the weather and read it back, or the cooked map bakes
    exactly this environment (per-map registry). A cooked map's baked lighting
    is never accepted in place of a different request.
    """
    if not isinstance(environment, Mapping):
        return False
    expected = {field: float(getattr(requested, field)) for field in _ENVIRONMENT_FIELDS}
    return (
        environment.get("schema") == "simforge.environment-evidence/v1"
        and set(environment) == {"schema", "available", "exact", "requested", "observed", "mode"}
        and environment.get("available") is True
        and environment.get("exact") is True
        and environment.get("mode") in {"runtime-weather", "cooked-baked"}
        and _environment_values_match(environment.get("requested"), expected)
        and _environment_values_match(environment.get("observed"), expected)
    )

def _runtime_semantic_failures(
    lease: Lease,
    runtime_evidence: Mapping[str, object],
    expected_capture_count: int,
) -> list[str]:
    """Runtime closure checks shared by every execution mode."""
    failures: list[str] = []
    environment = runtime_evidence.get("environment")
    if not _environment_evidence_is_accepted(environment, lease.render_spec.environment):
        failures.append("environment-readback")
    sensor_evidence = runtime_evidence.get("sensors")
    expected_sensor_ids = {sensor.artifact_name for sensor in lease.render_spec.sensors}
    if not isinstance(sensor_evidence, Mapping) or set(sensor_evidence) != expected_sensor_ids:
        failures.append("sensor-identity-closure")
    else:
        for sensor_id in sorted(expected_sensor_ids):
            value = sensor_evidence[sensor_id]
            if not isinstance(value, Mapping) or value.get("capturedFrames") != expected_capture_count:
                failures.append(f"sensor-frame-closure:{sensor_id}")
    if any(sensor.modality == "rgb" for sensor in lease.render_spec.sensors):
        visual = runtime_evidence.get("visualQuality")
        if not isinstance(visual, Mapping) or visual.get("verdict") != "pass":
            failures.append("visual-quality")
    return failures


def _map_binding(runtime_evidence: Mapping[str, object], lease: Lease) -> tuple[str | None, list[str]]:
    """(binding, failures) for the runtime world against the package XODR."""
    map_evidence = runtime_evidence.get("map")
    if (
        not isinstance(map_evidence, Mapping)
        or map_evidence.get("schema") != "simforge.carla-map-evidence/v1"
        or map_evidence.get("available") is not True
        or map_evidence.get("packageXodrSha256") != lease.execution_package.xodr.sha256
        or map_evidence.get("binding") != "exact"
        or map_evidence.get("exact") is not True
        or map_evidence.get("source") != "cooked-custom-map"
        or map_evidence.get("identityMode") not in {"xodr-byte-exact", "approved-cooked-digest"}
    ):
        return None, ["map-binding"]
    return str(map_evidence["binding"]), []


def _replay_parity_evidence(
    lease: Lease,
    plan: ExecutionPlan,
    replay_report: Mapping[str, Any],
    runtime_evidence: Mapping[str, object],
    artifacts: list[Mapping[str, object]],
    expected_capture_count: int,
    spawn_placement: Mapping[str, object] | None,
) -> dict[str, object]:
    """Parity evidence for trace replay: CARLA vs the sampler, blocking."""
    metadata = plan.semantic_metadata
    semantic_failures: list[str] = []
    if not metadata.get("complete"):
        semantic_failures.append("semantic-metadata-incomplete")
    if int(replay_report.get("lifecycleMismatches", 0)):
        semantic_failures.append("actor-lifecycle")
    if int(replay_report.get("signalMismatches", 0)):
        semantic_failures.append("traffic-signal-state")
    if runtime_evidence.get("available") is True:
        if runtime_evidence.get("executionMode") != EXECUTION_MODE_TRACE_REPLAY or runtime_evidence.get("motionApplication") != "kinematic-trace-replay":
            semantic_failures.append("replay-authority")
        binding, map_failures = _map_binding(runtime_evidence, lease)
        semantic_failures.extend(map_failures)
        semantic_failures.extend(_runtime_semantic_failures(lease, runtime_evidence, expected_capture_count))
    else:
        binding = None
    trajectory_passed = replay_report.get("verdict") == "pass"
    produced_kinds = {str(item.get("kind")) for item in artifacts if isinstance(item.get("kind"), str)}
    expected_kinds: set[str] = set(lease.render_spec.outputs)
    if "video" in lease.render_spec.outputs:
        primary_rgb = next((sensor for sensor in lease.render_spec.sensors if sensor.modality == "rgb"), None)
        expected_kinds.update(
            f"sensorVideo:{sensor.artifact_name}" for sensor in lease.render_spec.sensors if sensor is not primary_rgb
        )
    expected_kinds.update(
        f"sensorData:{sensor.artifact_name}"
        for sensor in lease.render_spec.sensors
        if sensor.modality in {"lidar", "semantic-lidar", "radar"}
    )
    predicted_kinds = {kind for kind in ("manifest", "parity-report") if kind in lease.artifact_uploads}
    verified_kinds = sorted(produced_kinds | predicted_kinds)
    missing_kinds = sorted(expected_kinds - set(verified_kinds))
    divergences: list[dict[str, object]] = []
    staged = spawn_placement.get("stagedActorIds", ()) if isinstance(spawn_placement, Mapping) else ()
    for actor_id in staged:
        divergences.append({"code": f"spawn-placement:staged:{actor_id}", "classification": "informational"})
    semantics_passed = not semantic_failures
    artifacts_passed = not missing_kinds
    overall = semantics_passed and trajectory_passed and artifacts_passed
    metrics: dict[str, float] = {
        "samples": float(replay_report.get("samples", 0)),
        "max.positionM": float(replay_report.get("maxPositionErrorM", 0.0)),
        "max.rotationDeg": float(replay_report.get("maxRotationErrorDeg", 0.0)),
        "acceptanceThreshold.positionM": float(replay_report["tolerances"]["positionM"]),
        "acceptanceThreshold.rotationDeg": float(replay_report["tolerances"]["rotationDeg"]),
        "violations.pose": float(replay_report.get("violationCount", 0)),
    }
    for klass, stats in dict(replay_report.get("byClass", {})).items():
        metrics[f"{klass}.max.positionM"] = float(stats["maxPositionErrorM"])
        metrics[f"{klass}.max.rotationDeg"] = float(stats["maxRotationErrorDeg"])
        metrics[f"{klass}.samples"] = float(stats["samples"])
    return {
        "schema": "uniscenario.parity-evidence/v1",
        "identity": {
            "revisionId": lease.execution_package.revision_id,
            "executionPackageId": lease.execution_package.id,
            "executionPackageControlSha256": lease.execution_package.control_sha256,
            "sourceInputDigest": lease.execution_package.source_input_digest,
            "planSha256": plan.sha256,
        },
        "execution": {
            "mode": EXECUTION_MODE_TRACE_REPLAY,
            "purpose": EXECUTION_PURPOSE[EXECUTION_MODE_TRACE_REPLAY],
            "fixedTimestepS": plan.fixed_timestep_s,
            "mapBinding": binding,
        },
        "semantics": {
            "verdict": "pass" if semantics_passed else "fail",
            "evaluatedInteractionCount": len(metadata.get("interactionIds", [])),
            "unclassifiedDifferenceCount": len(semantic_failures),
            "failedCheckIds": sorted(set(semantic_failures)),
        },
        "trajectory": {
            "verdict": "pass" if trajectory_passed else "fail",
            "acceptanceGate": "replay-sampler-parity",
            "evaluatedActorCount": len(plan.actors),
            "droppedActorIds": sorted(
                str(item) for item in (spawn_placement.get("droppedActorIds", ()) if isinstance(spawn_placement, Mapping) else ())
            ),
            "nudgedActorIds": [],
            "failedActorIds": list(replay_report.get("failedActorIds", [])),
            "postContactFailedActorIds": [],
            "postContactClassification": "not-applicable",
            "metrics": metrics,
        },
        "collisions": {
            # Nothing is simulated in replay: contacts are the trace's events.
            "verdict": "pass",
            "source": "timeline",
            "evaluatedPairCount": 0,
            "failedPairs": [],
        },
        "artifacts": {
            "verdict": "pass" if artifacts_passed else "fail",
            "verifiedKinds": verified_kinds,
            "missingKinds": missing_kinds,
        },
        "divergences": divergences,
        "verdict": "pass" if overall else "fail",
    }


def _parity_evidence(
    lease: Lease,
    plan: ExecutionPlan,
    parity: object,
    runtime_evidence: Mapping[str, object],
    artifacts: list[Mapping[str, object]],
    expected_capture_count: int,
    spawn_placement: Mapping[str, object] | None = None,
) -> dict[str, object]:
    metadata = plan.semantic_metadata
    semantic_failures: list[str] = []
    if not metadata.get("complete"):
        semantic_failures.append("semantic-metadata-incomplete")
    for field, check_id in (
        ("lifecycle_mismatches", "actor-lifecycle"),
        ("signal_mismatches", "traffic-signal-state"),
        ("discrete_mismatches", "actor-discrete-state"),
    ):
        if int(getattr(parity, field, 0)) > 0:
            semantic_failures.append(check_id)
    if lease.render_spec.execution_mode == "native-physics":
        if (
            runtime_evidence.get("available") is not True
            or runtime_evidence.get("physicsAuthority") is not True
            or runtime_evidence.get("motionApplication") != "native-controls"
        ):
            semantic_failures.append("native-physics-authority")
        map_evidence = runtime_evidence.get("map")
        runtime_xodr_sha256 = (
            map_evidence.get("runtimeXodrSha256")
            if isinstance(map_evidence, Mapping) else None
        )
        signal_identity_mode = (
            map_evidence.get("signalIdentityMode")
            if isinstance(map_evidence, Mapping) else None
        )
        signal_id_map = (
            map_evidence.get("signalIdMap")
            if isinstance(map_evidence, Mapping) else None
        )
        if (
            not isinstance(map_evidence, Mapping)
            or map_evidence.get("schema") != "simforge.carla-map-evidence/v1"
            or map_evidence.get("available") is not True
            or map_evidence.get("source") != "cooked-custom-map"
            or map_evidence.get("identityMode") not in {"xodr-byte-exact", "approved-cooked-digest"}
            or map_evidence.get("requestedMapName") != lease.execution_package.xodr.map_name
            or map_evidence.get("loadedMapName") != lease.execution_package.xodr.map_name
            or map_evidence.get("packageXodrSha256") != lease.execution_package.xodr.sha256
            or not isinstance(runtime_xodr_sha256, str)
            or len(runtime_xodr_sha256) != 64
            or any(character not in "0123456789abcdef" for character in runtime_xodr_sha256)
            or map_evidence.get("xodrByteExact") is not (
                runtime_xodr_sha256 == lease.execution_package.xodr.sha256
            )
            or map_evidence.get("binding") != "exact"
            or signal_identity_mode not in {
                "direct-opendrive-id", "approved-cooked-map-remap",
            }
            or not isinstance(signal_id_map, Mapping)
            or any(
                not isinstance(authored_id, str)
                or not authored_id
                or not isinstance(runtime_id, str)
                or not runtime_id
                for authored_id, runtime_id in signal_id_map.items()
            )
            or len(set(signal_id_map.values())) != len(signal_id_map)
            or (signal_identity_mode == "direct-opendrive-id" and bool(signal_id_map))
            or (signal_identity_mode == "approved-cooked-map-remap" and not signal_id_map)
            or map_evidence.get("exact") is not True
        ):
            semantic_failures.append("cooked-map-identity")
        environment = runtime_evidence.get("environment")
        if not _environment_evidence_is_accepted(environment, lease.render_spec.environment):
            semantic_failures.append("environment-readback")
        sensor_evidence = runtime_evidence.get("sensors")
        expected_sensor_ids = {sensor.artifact_name for sensor in lease.render_spec.sensors}
        if not isinstance(sensor_evidence, Mapping) or set(sensor_evidence) != expected_sensor_ids:
            semantic_failures.append("sensor-identity-closure")
        else:
            for sensor_id in sorted(expected_sensor_ids):
                value = sensor_evidence[sensor_id]
                if not isinstance(value, Mapping) or value.get("capturedFrames") != expected_capture_count:
                    semantic_failures.append(f"sensor-frame-closure:{sensor_id}")
        if any(sensor.modality == "rgb" for sensor in lease.render_spec.sensors):
            visual = runtime_evidence.get("visualQuality")
            if not isinstance(visual, Mapping) or visual.get("verdict") != "pass":
                semantic_failures.append("visual-quality")

    global_failed_actor_ids = list(getattr(parity, "failed_actor_ids", ()))
    violation_counts = dict(getattr(parity, "violation_counts", {}))
    reference_violation_counts = dict(getattr(parity, "reference_violation_counts", {}))
    reference_thresholds = dict(getattr(parity, "reference_thresholds", {}))
    acceptance_thresholds = dict(getattr(parity, "acceptance_thresholds", {}))
    max_error = dict(getattr(parity, "max_error", {}))
    expected_collisions = _collision_onsets(metadata.get("events"), plan.fixed_timestep_s, authored=True)
    actual_collisions = _collision_onsets(getattr(parity, "collision_events", ()), plan.fixed_timestep_s, authored=False)
    collision_pairs = sorted(set(expected_collisions) | set(actual_collisions))
    failed_pairs = [
        list(pair)
        for pair in collision_pairs
        if expected_collisions.get(pair) != actual_collisions.get(pair)
    ]
    collisions_passed = not failed_pairs

    # Native contact response is intentionally CARLA-owned. Once every
    # authored pair and onset matches exactly, trajectory acceptance remains
    # strict through the first-contact frame and the later physics tail is
    # evidence, not a replay requirement. A missing, unexpected, or mistimed
    # contact disables this exception and keeps the full trajectory blocking.
    segments = getattr(parity, "segments", {})
    through_contact = segments.get("throughFirstContact", {}) if isinstance(segments, Mapping) else {}
    post_contact = segments.get("postContact", {}) if isinstance(segments, Mapping) else {}
    through_violations = dict(through_contact.get("violationCounts", {})) if isinstance(through_contact, Mapping) else {}
    post_violations = dict(post_contact.get("violationCounts", {})) if isinstance(post_contact, Mapping) else {}
    post_max_error = dict(post_contact.get("maxError", {})) if isinstance(post_contact, Mapping) else {}
    segment_failed = getattr(parity, "segment_failed_actor_ids", {})
    matched_authored_contact = bool(expected_collisions) and collisions_passed
    if matched_authored_contact:
        failed_actor_ids = list(segment_failed.get("throughFirstContact", ())) if isinstance(segment_failed, Mapping) else []
        blocking_violations = through_violations
        acceptance_gate = "through-first-contact"
    else:
        failed_actor_ids = global_failed_actor_ids
        blocking_violations = violation_counts
        acceptance_gate = "full-trajectory"
    post_contact_failed_actor_ids = (
        list(segment_failed.get("postContact", ())) if isinstance(segment_failed, Mapping) else []
    )
    trajectory_passed = not failed_actor_ids and not any(int(value) for value in blocking_violations.values())
    trajectory_metrics: dict[str, float] = {"samples": float(getattr(parity, "samples", 0))}
    for key, value in sorted(max_error.items()):
        trajectory_metrics[f"max.{key}"] = float(value)
    for key, value in sorted(violation_counts.items()):
        trajectory_metrics[f"violations.{key}"] = float(value)
    for key, value in sorted(reference_violation_counts.items()):
        trajectory_metrics[f"referenceViolations.{key}"] = float(value)
    for key, value in sorted(reference_thresholds.items()):
        trajectory_metrics[f"referenceThreshold.{key}"] = float(value)
    for key, value in sorted(acceptance_thresholds.items()):
        trajectory_metrics[f"acceptanceThreshold.{key}"] = float(value)
    for prefix, segment_value in (("throughFirstContact", through_contact), ("postContact", post_contact)):
        if not isinstance(segment_value, Mapping):
            continue
        trajectory_metrics[f"{prefix}.samples"] = float(segment_value.get("samples", 0))
        for key, value in sorted(dict(segment_value.get("maxError", {})).items()):
            trajectory_metrics[f"{prefix}.max.{key}"] = float(value)
        for key, value in sorted(dict(segment_value.get("violationCounts", {})).items()):
            trajectory_metrics[f"{prefix}.violations.{key}"] = float(value)

    produced_kinds = {
        str(item.get("kind")) for item in artifacts
        if isinstance(item.get("kind"), str)
    }
    expected_kinds: set[str] = set(lease.render_spec.outputs)
    if "video" in lease.render_spec.outputs:
        primary_rgb = next(
            (sensor for sensor in lease.render_spec.sensors if sensor.modality == "rgb"), None,
        )
        expected_kinds.update(
            f"sensorVideo:{sensor.artifact_name}"
            for sensor in lease.render_spec.sensors
            if sensor is not primary_rgb
        )
    expected_kinds.update(
        f"sensorData:{sensor.artifact_name}"
        for sensor in lease.render_spec.sensors
        if sensor.modality in {"lidar", "semantic-lidar", "radar"}
    )
    if lease.render_spec.execution_mode == "native-physics":
        expected_kinds.update({"manifest", "parity-report"})
    predicted_kinds = {
        kind for kind in ("manifest", "parity-report")
        if kind in lease.artifact_uploads
    }
    verified_kinds = sorted(produced_kinds | predicted_kinds)
    missing_kinds = sorted(expected_kinds - set(verified_kinds))

    placement_actors = (
        spawn_placement.get("actors")
        if isinstance(spawn_placement, Mapping) else None
    )
    placement_actors = placement_actors if isinstance(placement_actors, Mapping) else {}
    dropped_actor_ids = sorted(
        str(item) for item in (
            spawn_placement.get("droppedActorIds", ())
            if isinstance(spawn_placement, Mapping) else ()
        )
    )
    nudged_actor_ids = sorted(
        str(item) for item in (
            spawn_placement.get("nudgedActorIds", ())
            if isinstance(spawn_placement, Mapping) else ()
        )
    )

    divergences: list[dict[str, object]] = []
    if matched_authored_contact:
        for key, value in sorted(post_max_error.items()):
            if float(value) > 0:
                divergences.append({
                    "code": f"native-physics:post-contact:{key}",
                    "classification": "expected-carla-physics",
                    "details": {
                        "segment": "postContact",
                        "maximum": float(value),
                        "violationCount": int(post_violations.get(key, 0)),
                    },
                })
    elif trajectory_passed:
        for key, value in sorted(max_error.items()):
            reference_violations = int(reference_violation_counts.get(key, 0))
            if reference_violations > 0:
                divergences.append({
                    "code": f"native-physics:{key}",
                    "classification": "expected-carla-physics",
                    "details": {
                        "maximum": float(value),
                        "referenceThreshold": float(reference_thresholds[key]),
                        "acceptanceThreshold": float(acceptance_thresholds[key]),
                        "referenceViolationCount": reference_violations,
                        "acceptanceViolationCount": int(violation_counts.get(key, 0)),
                    },
                })
    for actor_id in dropped_actor_ids:
        details = placement_actors.get(actor_id)
        details = dict(details) if isinstance(details, Mapping) else {}
        dropped_kind = (
            "dropped-execution-semantics"
            if details.get("cause") == "execution-semantics"
            else "dropped-unplaceable"
        )
        divergences.append({
            "code": f"spawn-placement:{dropped_kind}:{actor_id}",
            "classification": "spawn-placement-drop",
            "details": details,
        })
    for actor_id in nudged_actor_ids:
        details = placement_actors.get(actor_id)
        divergences.append({
            "code": f"spawn-placement:nudged:{actor_id}",
            "classification": "spawn-placement-nudge",
            "details": dict(details) if isinstance(details, Mapping) else {},
        })

    semantics_passed = not semantic_failures
    artifacts_passed = not missing_kinds
    overall = (
        lease.render_spec.execution_mode == "native-physics"
        and semantics_passed
        and trajectory_passed
        and collisions_passed
        and artifacts_passed
    )
    return {
        "schema": "uniscenario.parity-evidence/v1",
        "identity": {
            "revisionId": lease.execution_package.revision_id,
            "executionPackageId": lease.execution_package.id,
            "executionPackageControlSha256": lease.execution_package.control_sha256,
            "sourceInputDigest": lease.execution_package.source_input_digest,
            "planSha256": plan.sha256,
        },
        "execution": {
            "mode": lease.render_spec.execution_mode,
            "purpose": EXECUTION_PURPOSE[lease.render_spec.execution_mode],
            "fixedTimestepS": plan.fixed_timestep_s,
        },
        "semantics": {
            "verdict": "pass" if semantics_passed else "fail",
            "evaluatedInteractionCount": len(metadata.get("interactionIds", [])),
            "unclassifiedDifferenceCount": len(semantic_failures),
            "failedCheckIds": sorted(set(semantic_failures)),
        },
        "trajectory": {
            "verdict": "pass" if trajectory_passed else "fail",
            "acceptanceGate": acceptance_gate,
            "evaluatedActorCount": len(plan.actors) - len(dropped_actor_ids),
            "droppedActorIds": dropped_actor_ids,
            "nudgedActorIds": nudged_actor_ids,
            "failedActorIds": sorted(failed_actor_ids),
            "postContactFailedActorIds": sorted(post_contact_failed_actor_ids),
            "postContactClassification": "expected-carla-physics" if matched_authored_contact else "blocking",
            "metrics": trajectory_metrics,
        },
        "collisions": {
            "verdict": "pass" if collisions_passed else "fail",
            "evaluatedPairCount": len(collision_pairs),
            "failedPairs": failed_pairs,
        },
        "artifacts": {
            "verdict": "pass" if artifacts_passed else "fail",
            "verifiedKinds": verified_kinds,
            "missingKinds": missing_kinds,
        },
        "divergences": divergences,
        "verdict": "pass" if overall else "fail",
    }


def _verify_execution_manifest(lease: Lease, body: bytes) -> Mapping[str, Any]:
    lease.execution_package.manifest.verify(body, "manifest")
    try:
        manifest = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("execution manifest must be valid UTF-8 JSON") from exc
    if not isinstance(manifest, Mapping) or manifest.get("contract") != SCHEMA:
        raise ContractError(f"execution manifest contract must equal {SCHEMA}")
    if manifest.get("openScenarioProfile") != "ASAM OpenSCENARIO XML 1.4":
        raise ContractError("execution manifest identifies an unsupported OpenSCENARIO profile")
    if manifest.get("xsdSha256") != lease.execution_package.xosc.xsd_sha256:
        raise ContractError("execution manifest XSD digest does not match the control package")
    revision = manifest.get("revision")
    if not isinstance(revision, Mapping) or revision.get("id") != lease.execution_package.revision_id:
        raise ContractError("execution manifest revision does not match the control package")
    if not isinstance(revision.get("sha256"), str) or len(revision["sha256"]) != 64:
        raise ContractError("execution manifest revision digest is missing")
    if manifest.get("sourceInputDigest") != lease.execution_package.source_input_digest:
        raise ContractError("execution manifest source input digest does not match the control package")
    if manifest.get("materializedTrafficDigest") != lease.execution_package.materialized_traffic_digest:
        raise ContractError("execution manifest materialized traffic digest does not match the control package")
    map_value = manifest.get("map")
    if not isinstance(map_value, Mapping) or (
        map_value.get("assetId") != lease.execution_package.map_asset_id
        or map_value.get("versionId") != lease.execution_package.map_version_id
        or map_value.get("xodrSha256") != lease.execution_package.xodr.sha256
    ):
        raise ContractError("execution manifest map digest does not match the control package")
    catalog = manifest.get("assetCatalog")
    if not isinstance(catalog, Mapping) or (
        catalog.get("versionId") != lease.execution_package.asset_catalog.catalog_version_id
        or catalog.get("manifestSha256") != lease.execution_package.asset_catalog.sha256
    ):
        raise ContractError("execution manifest asset catalog does not match the control package")
    ambient = manifest.get("ambient")
    control_ambient = lease.execution_package.ambient
    ambient_fields = {
        "mode": control_ambient["ambientMode"],
        "ambientConfig": control_ambient["ambientConfig"],
        "configSha256": control_ambient["configSha256"],
        "resultSha256": control_ambient["resultSha256"],
        **({"runtimeVersion": control_ambient["runtimeVersion"], "seed": control_ambient["seed"]} if control_ambient["ambientMode"] == "native" else {}),
        **({
            "sumoVersion": control_ambient["sumoVersion"],
            "networkSha256": control_ambient["networkSha256"],
            "seed": control_ambient["seed"],
        } if control_ambient["ambientMode"] == "sumo" else {}),
    }
    if not isinstance(ambient, Mapping):
        raise ContractError("execution manifest ambient provenance does not match the control package")
    manifest_ambient = dict(ambient)
    ambient_materialized = manifest_ambient.pop("materializedTraffic", None)
    if manifest_ambient != ambient_fields:
        raise ContractError("execution manifest ambient provenance does not match the control package")
    expected_materialized_identity = {
        "sha256": lease.execution_package.materialized_traffic_digest,
        "sizeBytes": lease.execution_package.ambient["materializedTraffic"].size_bytes,
        "sourceInputDigest": lease.execution_package.source_input_digest,
        "mapAssetId": lease.execution_package.map_asset_id,
        "mapVersionId": lease.execution_package.map_version_id,
    }
    if not isinstance(ambient_materialized, Mapping) or set(ambient_materialized) != {"artifactId", *expected_materialized_identity} or (
        not isinstance(ambient_materialized.get("artifactId"), str) or not ambient_materialized["artifactId"]
        or any(ambient_materialized.get(key) != expected for key, expected in expected_materialized_identity.items())
    ):
        raise ContractError("execution manifest ambient materialized traffic identity does not match the control package")
    manifest_materialized = manifest.get("materializedTraffic")
    overlap_actor_ids = manifest_materialized.get("overlapActorIds") if isinstance(manifest_materialized, Mapping) else None
    if not isinstance(overlap_actor_ids, list) or not all(
        isinstance(actor_id, str) and actor_id.startswith("ambient:") for actor_id in overlap_actor_ids
    ) or overlap_actor_ids != sorted(set(overlap_actor_ids)):
        raise ContractError("execution manifest materialized traffic overlap membership is invalid")
    if not isinstance(manifest_materialized, Mapping) or set(manifest_materialized) != {"artifactId", "sha256", "sizeBytes", "overlapActorIds"} or (
        manifest_materialized.get("artifactId") != ambient_materialized["artifactId"]
        or manifest_materialized.get("sha256") != lease.execution_package.materialized_traffic_digest
        or manifest_materialized.get("sizeBytes") != lease.execution_package.ambient["materializedTraffic"].size_bytes
    ):
        raise ContractError("execution manifest materialized traffic file does not match the control package")
    files = manifest.get("files")
    if not isinstance(files, list):
        raise ContractError("execution manifest files must be an array")
    xosc_entries = [item for item in files if isinstance(item, Mapping) and item.get("kind") == "xosc"]
    expected_xosc = {
        "kind": "xosc", "mediaType": "application/xml",
        "sha256": lease.execution_package.xosc.sha256,
        "sizeBytes": lease.execution_package.xosc.size_bytes,
    }
    if xosc_entries != [expected_xosc]:
        raise ContractError("execution manifest XOSC file does not match the control package")
    return manifest

def _verify_xosc_source_input_digest(lease: Lease, xosc: bytes) -> None:
    reject_unsafe_xml_envelope(xosc)
    try:
        root = ET.fromstring(xosc)
    except ET.ParseError as exc:
        raise ContractError("OpenSCENARIO XML is not well formed") from exc
    values = [
        item.get("value")
        for item in root.findall("./FileHeader/Properties/Property")
        if item.get("name") in {"simforge.provenance.inputHash", "uniscenarios.provenance.inputHash"}
    ]
    if values != [lease.execution_package.source_input_digest]:
        raise ContractError("OpenSCENARIO source input digest does not match the control package")


def _enforce_render_budgets(lease: Lease, plan: ExecutionPlan, capture_count: int) -> None:
    duration = plan.frames[-1].t
    if duration < 0 or duration > MAX_DURATION_SECONDS:
        raise ContractError(f"scenario duration must be between 0 and {MAX_DURATION_SECONDS:g} seconds")
    if capture_count > MAX_CAPTURE_FRAMES:
        raise ContractError(f"render capture exceeds {MAX_CAPTURE_FRAMES} frames")
    camera_pixels = sum(
        int(sensor.config["width"]) * int(sensor.config["height"])
        for sensor in lease.render_spec.sensors
        if sensor.modality in CAMERA_MODALITIES
    ) * capture_count
    if camera_pixels > MAX_SENSOR_PIXELS:
        raise ContractError(f"render capture exceeds {MAX_SENSOR_PIXELS} sensor pixels")
    point_bytes = 0
    for sensor in lease.render_spec.sensors:
        if sensor.modality in {"lidar", "semantic-lidar", "radar"}:
            bytes_per_point = 24 if sensor.modality == "semantic-lidar" else 16
            point_bytes += int(sensor.config["pointsPerSecond"]) * bytes_per_point * duration
    # Cameras never land raw frames on disk: each streams into its ffmpeg
    # encoder and only the encoded mp4 plus per-frame bookkeeping remains.
    frame_file_count = len(lease.render_spec.sensors) * capture_count
    projected_bytes = point_bytes + frame_file_count * 4096
    if projected_bytes > MAX_OUTPUT_BYTES:
        raise ContractError("projected raw capture exceeds the temporary-disk budget")


def _body_size(body: ArtifactBody) -> int:
    return body.stat().st_size if isinstance(body, Path) else len(body)


def _capture_temp_bytes(output_dir: Path, abort: Callable[[], None]) -> int:
    total = 0
    if not output_dir.exists():
        return 0
    for path in output_dir.rglob("*"):
        if not path.is_file():
            continue
        abort()
        total += path.stat().st_size + 4096
        if total > MAX_OUTPUT_BYTES:
            raise ContractError("captured frames exceed the shared temporary-disk budget")
    abort()
    return total


def _body_digest(
    body: ArtifactBody,
    deadline_monotonic: Callable[[], float] | None = None,
    abort: Callable[[], None] | None = None,
) -> str:
    digest = hashlib.sha256()
    if isinstance(body, Path):
        with body.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic():
                    raise LeaseDeadlineExceeded("lease deadline exceeded while hashing artifact")
                if abort:
                    abort()
                digest.update(chunk)
    else:
        digest.update(body)
    return digest.hexdigest()


def _enforce_output_budget(current_bytes: int, body: ArtifactBody, kind: str) -> None:
    size = _body_size(body)
    if size > MAX_ARTIFACT_BYTES:
        raise ContractError(f"artifact {kind} exceeds {MAX_ARTIFACT_BYTES} bytes")
    if current_bytes + size > MAX_OUTPUT_BYTES:
        raise ContractError(f"render outputs exceed {MAX_OUTPUT_BYTES} bytes")


def _artifact(
    kind: str,
    body: ArtifactBody,
    media_type: str,
    reservation: Mapping[str, Any] | None,
    uploader: Upload,
    metadata: Mapping[str, object] | None = None,
    authorize_upload: Callable[[str, str, int, str, Mapping[str, Any]], Mapping[str, Any]] | None = None,
    deadline_monotonic: Callable[[], float] | None = None,
    abort: Callable[[], None] | None = None,
    precomputed_digest: str | None = None,
) -> dict[str, object]:
    size = _body_size(body)
    digest = precomputed_digest or _body_digest(body, deadline_monotonic, abort)
    if not reservation:
        raise RuntimeError(f"control plane did not reserve required artifact upload {kind}")
    bound = authorize_upload(kind, digest, size, media_type, reservation) if authorize_upload else reservation
    required_headers = bound.get("requiredHeaders")
    if not isinstance(required_headers, Mapping) or not required_headers:
        raise ContractError(f"artifact upload binding {kind} has no requiredHeaders contract")
    if not all(isinstance(name, str) and name and isinstance(value, str) for name, value in required_headers.items()):
        raise ContractError(f"artifact upload binding {kind} has invalid requiredHeaders")
    content_types = [value for name, value in required_headers.items() if name.lower() == "content-type"]
    if content_types != [media_type]:
        raise ContractError(f"artifact upload binding {kind} has mismatched content-type")
    if uploader is upload:
        uploader(
            bound["uploadUrl"], body, media_type, dict(required_headers),
            deadline_monotonic=deadline_monotonic, abort=abort,
        )
    else:
        if abort:
            abort()
        uploader(bound["uploadUrl"], body, media_type, dict(required_headers))
        if abort:
            abort()
    return {"kind": kind, "artifactUrl": bound["artifactUrl"], "sha256": digest, "sizeBytes": size, "mediaType": media_type, **({"metadata": dict(metadata)} if metadata else {})}


#: Actor kinds CARLA renders with a blueprint rider (BP_Base2wheeled + AB_Biker).
RIDDEN_TWO_WHEELER_KINDS = frozenset({"bicycle", "motorcycle", "scooter"})
RIDER_POSE_STATIC_WARNING = "carla_rider_pose_static"
RIDER_POSE_STATIC_MESSAGE = (
    "CARLA trace replay has no wheel/crank state: two-wheeler riders hold a static pose "
    "(pedals do not turn); native renders pedal from the timeline odometer."
)


def ridden_two_wheelers(plan: ExecutionPlan, execution_mode: str) -> list[str]:
    """Actors whose rider CARLA cannot animate under trace replay (their legs follow wheel state)."""
    if execution_mode != EXECUTION_MODE_TRACE_REPLAY:
        return []
    return sorted(actor_id for actor_id, binding in plan.actors.items() if binding.kind in RIDDEN_TWO_WHEELER_KINDS)


def _approximations(execution_mode: str, runtime_evidence: Mapping[str, object],
                    riders: list[str] | None = None) -> list[dict[str, object]]:
    """What this render shows that is known not to be exact, stated plainly."""
    items: list[dict[str, object]] = []
    if execution_mode != EXECUTION_MODE_TRACE_REPLAY:
        items.append({"id": "physics-validation", "detail": "CARLA physics drove the vehicles; poses diverge from the scenario trace by design"})
        return items
    items.extend([
        {"id": "suspension", "detail": "no suspension dynamics; body attitude is the timeline's road and acceleration pitch/roll"},
        {"id": "wheel-spin", "detail": "wheels of kinematic vehicles do not spin or steer"},
        {"id": "walker-gait", "detail": "walker gait is CARLA's speed-driven locomotion blend, not a replayed skeleton; the render fails if a walking walker's legs do not move (walkerAnimation evidence)"},
        {"id": "radar-doppler", "detail": "radar velocity comes from CARLA's velocity of a kinematic body; use the timeline speed for Doppler truth"},
        {"id": "collisions", "detail": "contacts are the trace's events; CARLA reports no physical impulses"},
    ])
    if riders:
        items.append({"id": "rider-pose-static", "code": RIDER_POSE_STATIC_WARNING,
                      "detail": RIDER_POSE_STATIC_MESSAGE, "actorIds": list(riders)})
    return items


def _compiled_substitutions(
    execution_manifest: Mapping[str, Any],
    policy: RenderPolicy,
) -> tuple[dict[str, object], ...]:
    """Body substitutions the compiler already baked into the package."""
    compiled = execution_manifest.get("carlaVehicleFallbacks")
    if compiled is None:
        return ()
    if not isinstance(compiled, list) or any(not isinstance(item, Mapping) for item in compiled):
        raise ContractError("execution manifest carlaVehicleFallbacks must be an array of objects")
    if compiled and not policy.allows(SUBSTITUTION_CARLA_ACTOR_BODY):
        raise CarlaRenderError(
            "carla_blueprint_unavailable",
            "the execution package substitutes actor bodies at compile time ("
            + ", ".join(str(item.get("actorId")) for item in compiled)
            + f") and the render intent does not allow {SUBSTITUTION_CARLA_ACTOR_BODY}",
        )
    records = []
    for item in compiled:
        actor_id, authored, fallback = item.get("actorId"), item.get("authoredCatalogId"), item.get("fallbackCatalogId")
        if not all(isinstance(value, str) and value for value in (actor_id, authored, fallback)):
            raise ContractError(
                "execution manifest carlaVehicleFallbacks entries need actorId, authoredCatalogId and fallbackCatalogId"
            )
        records.append(substitution_record(
            SUBSTITUTION_CARLA_ACTOR_BODY, str(actor_id), str(authored), str(fallback),
            reason="compile-time substitution in the execution package",
        ))
    return tuple(records)


def _probe_blueprints(
    plan: ExecutionPlan,
    catalog: Mapping[str, Mapping[str, object]],
    policy: RenderPolicy,
) -> set[str]:
    """Blueprints whose placeability decides this render's bodies."""
    probe: set[str] = set()
    classes: set[str] = set()
    for binding in plan.actors.values():
        entry = catalog.get(binding.catalog_name)
        if not isinstance(entry, Mapping):
            continue
        blueprint = entry.get("blueprintId")
        if isinstance(blueprint, str):
            probe.add(blueprint)
        actor_class = entry.get("actorClass")
        if _native_prefixes(binding.kind) is not None and isinstance(actor_class, str):
            classes.add(actor_class)
    if policy.allows(SUBSTITUTION_CARLA_ACTOR_BODY):
        # A substitute must be proven placeable too.
        for entry in catalog.values():
            blueprint = entry.get("blueprintId")
            if (
                entry.get("actorClass") in classes and isinstance(blueprint, str)
                and blueprint.startswith(("vehicle.", "bike.", "walker."))
            ):
                probe.add(blueprint)
    return probe


def _verify_timeline_appearance(plan: ExecutionPlan, rendered: set[str]) -> None:
    """A baked render timeline must render every appearance state the xosc authors."""
    authored = {
        key
        for frame in plan.frames
        for state in frame.actors.values()
        for key in state.appearance
        if not key.startswith("cue.")
    }
    if {"light.indicatorLeft", "light.indicatorRight"} <= rendered:
        # Hazards render through both indicators; the timeline sampler checks
        # every tick that they show the authored warningLights state.
        authored.discard("light.warningLights")
    missing = sorted(authored - rendered)
    if missing:
        raise CarlaRenderError(
            "carla_timeline_appearance_incomplete",
            "the render timeline does not render authored appearance state: " + ", ".join(missing),
        )


def _replay_geometry(backend: RenderBackend, plan: ExecutionPlan) -> dict[str, Any]:
    """The renderer-side mapping the replay gate needs from the backend.

    A backend that does not expose it (unit fakes) replays every actor as a
    base-origin body with no calibration.
    """
    classes = getattr(backend, "actor_classes", None)
    resolved = dict(classes) if isinstance(classes, Mapping) and classes else {actor_id: "vehicle" for actor_id in plan.actors}
    # Every plan actor is expected, spawned or not: a body CARLA failed to
    # show is a lifecycle mismatch, never an actor nobody grades.
    for actor_id, binding in plan.actors.items():
        resolved.setdefault(actor_id, _plan_motion_class(binding.kind))
    bottoms = getattr(backend, "bottom_offsets", None)
    z_offset = getattr(backend, "z_offset_m", None)
    return {
        "classes": resolved,
        "bottoms": dict(bottoms) if isinstance(bottoms, Mapping) else {},
        "zOffsetM": float(z_offset) if isinstance(z_offset, (int, float)) else 0.0,
        "dropped": set(),
    }


def _plan_motion_class(kind: str) -> str:
    if kind in ROAD_USER_VEHICLE_KINDS:
        return "vehicle"
    if kind == "pedestrian":
        return "walker"
    return "prop"


def _observed_render_pose(value: Mapping[str, Any]) -> RenderPose | None:
    try:
        return RenderPose(
            float(value["x"]), float(value["y"]), float(value["z"]),
            float(value["headingDeg"]),
            float(value.get("pitchDeg", 0.0)), float(value.get("rollDeg", 0.0)),
        )
    except (KeyError, TypeError, ValueError):
        return None


def execute_lease(
    lease: Lease,
    backend: RenderBackend,
    validator: Validate,
    downloader: Download = download,
    uploader: Upload = upload,
    progress: Callable[[str, Mapping[str, object]], None] | None = None,
    control: Control | None = None,
    authorize_upload: Callable[[str, str, int, str, Mapping[str, Any]], Mapping[str, Any]] | None = None,
    deadline_monotonic: Deadline | None = None,
    runtime_asset_overrides: Mapping[str, Mapping[str, str]] | None = None,
    render_timeline: bytes | None = None,
    policy: RenderPolicy = RenderPolicy(),
) -> dict[str, object]:
    emit = progress or (lambda _event, _payload: None)
    def deadline_value() -> float | None:
        if deadline_monotonic is None:
            return None
        return deadline_monotonic() if callable(deadline_monotonic) else deadline_monotonic

    def absolute_deadline() -> float:
        value = deadline_value()
        return value if value is not None else float("inf")

    def rpc_timeout(stage: str) -> float:
        deadline = deadline_value()
        return 60.0 if deadline is None else max(0.001, min(60.0, deadline - time.monotonic()))

    fence = _ExecutionFence(deadline_value, control)
    check_abort = fence.check

    def backend_fence(stage: str, completed_frames: int = 0, total_frames: int = 1) -> None:
        check_abort(stage, completed_frames, total_frames)
        backend.set_rpc_timeout(rpc_timeout(stage))

    def fetch(stage: str, url: str, maximum: int) -> bytes:
        check_abort(stage)
        if downloader is download:
            body = downloader(
                url, maximum,
                deadline_monotonic=absolute_deadline,
                abort=lambda: check_abort(stage),
            )
        else:
            body = downloader(url, maximum)
        check_abort(stage)
        return body

    package = lease.execution_package
    manifest_bytes = fetch("download_manifest", package.manifest.url, MAX_MANIFEST_BYTES)
    execution_manifest = _verify_execution_manifest(lease, manifest_bytes)
    xosc = fetch("download_xosc", package.xosc.url, MAX_XOSC_BYTES)
    xodr = fetch("download_xodr", package.xodr.url, MAX_XODR_BYTES)
    catalog_bytes = fetch("download_asset_catalog", package.asset_catalog.url, MAX_CATALOG_BYTES)
    materialized_traffic = package.ambient.get("materializedTraffic")
    traffic_bytes: bytes | None = None
    if materialized_traffic:
        traffic_bytes = fetch("download_materialized_traffic", materialized_traffic.url, MAX_TRAFFIC_BYTES)
        materialized_traffic.verify(traffic_bytes, "materializedTraffic")
    elif package.ambient["ambientMode"] != "disabled":
        raise ContractError("non-disabled ambient traffic requires materializedTraffic")
    package.xosc.verify(xosc, "xosc")
    _verify_xosc_source_input_digest(lease, xosc)
    package.xodr.verify(xodr, "xodr")
    package.asset_catalog.verify(catalog_bytes, "assetCatalog")
    check_abort("validate_xosc")
    validation = validator(xosc)
    if validation.get("valid") is not True or validation.get("xmlSha256") != package.xosc.sha256 or validation.get("xsdSha256") != package.xosc.xsd_sha256:
        raise RuntimeError("worker XSD validation receipt is not hash-closed to the execution package")
    emit("assets_validated", {"xoscSha256": package.xosc.sha256, "xodrSha256": package.xodr.sha256})
    check_abort("compile_xosc")
    plan = compile_xosc14(xosc, abort=lambda: check_abort("compile_xosc"))
    if traffic_bytes is not None:
        mode = package.ambient["ambientMode"]
        provider_version = (
            "none" if mode == "disabled" else
            package.ambient["runtimeVersion"] if mode == "native" else
            package.ambient["sumoVersion"]
        )
        provider_seed = "" if mode == "disabled" else package.ambient["seed"]
        materialized = parse_materialized_traffic(
            traffic_bytes,
            expected_digest=package.ambient["resultSha256"],
            source_input_digest=package.source_input_digest,
            map_asset_id=package.map_asset_id,
            map_version_id=package.map_version_id,
            provider_id=mode,
            provider_version=provider_version,
            provider_seed=provider_seed,
            fixed_step_seconds=plan.fixed_timestep_s,
            duration_seconds=plan.frames[-1].t,
        )
        plan = merge_materialized_traffic(
            plan,
            materialized,
            frozenset(execution_manifest["materializedTraffic"]["overlapActorIds"]),
        )
    check_abort("compile_xosc")
    _preflight_appearance(plan)
    _preflight_execution_semantics(lease, plan)
    actor_ids = set(plan.actors)
    unknown_mounts = sorted({
        sensor.actor_id for sensor in lease.render_spec.sensors
        if sensor.actor_id and sensor.actor_id not in actor_ids
    })
    if unknown_mounts:
        raise RuntimeError(f"sensor mounts reference unknown actors: {', '.join(unknown_mounts)}")
    try:
        catalog_manifest = json.loads(catalog_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("asset catalog manifest must be valid UTF-8 JSON") from exc
    check_abort("index_asset_catalog")
    actor_binding_table = load_actor_bindings()
    catalog = runtime_asset_bindings(
        catalog_manifest,
        expected_catalog_version_id=package.asset_catalog.catalog_version_id,
        manifest_sha256=hashlib.sha256(catalog_bytes).hexdigest(),
        actor_bindings=actor_binding_table,
        abort=lambda: check_abort("index_asset_catalog"),
    )
    for catalog_id, binding in (runtime_asset_overrides or {}).items():
        existing = catalog.get(catalog_id)
        if existing is not None and existing != binding:
            raise ContractError(f"runtime asset override conflicts with catalog entry {catalog_id}")
        catalog[catalog_id] = dict(binding)
    check_abort("index_asset_catalog")
    compiled_substitutions = _compiled_substitutions(execution_manifest, policy)
    authored_plan = plan
    plan, substitutions = _resolve_actor_bodies(
        authored_plan, catalog, policy, lambda: check_abort("index_asset_catalog"),
    )
    _preflight_asset_semantics(plan, catalog)
    emit("plan_compiled", {
        "planSha256": plan.sha256,
        "frames": len(plan.frames),
        "fixedTimestepS": plan.fixed_timestep_s,
    })
    execution_mode = lease.render_spec.execution_mode
    replay = execution_mode == EXECUTION_MODE_TRACE_REPLAY
    accumulator = ParityAccumulator(lease.parity_thresholds)
    # Replay parity is blocking at the fixed float32/UE bound; a lease may only
    # tighten it (its thresholds are native-physics ceilings otherwise).
    replay_gate = ReplayParityGate({
        "positionM": min(REPLAY_PARITY_TOLERANCES["positionM"], lease.parity_thresholds.get("positionM", float("inf"))),
        "rotationDeg": REPLAY_PARITY_TOLERANCES["rotationDeg"],
    })
    # Poses come from the shared render-timeline sampler when the package
    # ships a baked timeline, otherwise from the plan compiled from the xosc
    # trajectory-replay export (same sampling rules).
    sampler = PlanTimeline(plan)
    if render_timeline is not None:
        check_abort("load_render_timeline")
        sampler = load_bound_timeline(render_timeline, plan, lambda: check_abort("execute"))
        if sampler.tick_count() != len(plan.frames):
            raise ContractError(
                f"render timeline has {sampler.tick_count()} ticks but the execution plan has {len(plan.frames)}"
            )
        timeline_xodr = sampler.timeline.xodr_sha256
        if timeline_xodr is not None and timeline_xodr != package.xodr.sha256:
            raise ContractError("render timeline heights come from a different XODR than the execution package")
    # With a baked timeline the shared comparator grades the run too.
    comparator_records: list[str] | None = [] if isinstance(sampler, BoundTimeline) else None
    readbacks: list[Mapping[str, Mapping[str, object]]] = []
    readback_times: list[float] = []
    signal_readbacks: list[Mapping[str, str]] = []
    collision_readbacks: list[list[Mapping[str, object]]] = []
    sampled_frames: dict[int, PlanFrame] = {}
    rendered_appearance: set[str] = set()
    # The rendered part of the clip: the whole of it unless the render spec
    # asks for a sub-clip, which replay renders exactly (never widened).
    window = resolve_render_window(plan, lease.render_spec.clip, execution_mode)
    window_ticks = window.ticks()
    tick_total = window.tick_count
    capture_schedule = _capture_schedule(plan, lease.render_spec.fps, lambda: check_abort("schedule_capture"), execution_mode, window) if lease.job_mode == "full_render" else {}
    expected_capture_count = len(capture_schedule)
    _enforce_render_budgets(lease, plan, expected_capture_count)
    if lease.job_mode == "full_render":
        annotation_schedule = capture_schedule
    else:
        annotation_schedule = {}
        for frame in window.frames(plan):
            if frame.index % 50 == 0:
                check_abort("schedule_annotations", frame.index - window.start_tick, tick_total)
            observed_t = frame.t if replay else round(frame.t + plan.fixed_timestep_s, 9)
            annotation_schedule[frame.index] = (frame.index, frame.t, observed_t)
    with tempfile.TemporaryDirectory(prefix="scenario-render-") as directory:
        output_dir = Path(directory) / "frames"
        runtime_evidence: Mapping[str, object] = {
            "schema": "simforge.carla-runtime-evidence/v1",
            "available": False,
            "executionMode": lease.render_spec.execution_mode,
            "purpose": EXECUTION_PURPOSE[lease.render_spec.execution_mode],
            "physicsAuthority": lease.render_spec.execution_mode == EXECUTION_MODE_PHYSICS_VALIDATION,
            "acceptanceEligible": True,
        }
        try:
            check_abort("configure_execution")
            backend.configure_execution(lease.render_spec.execution_mode)
            backend_fence("load_opendrive")
            backend.load_opendrive(package.xodr.map_name, xodr, plan.fixed_timestep_s)
            backend.video_fps = float(lease.render_spec.fps)
            check_abort("load_opendrive")
            signal_ids: set[str] = set()
            for frame in plan.frames:
                if frame.index % 50 == 0:
                    check_abort("collect_signals", frame.index, len(plan.frames))
                signal_ids.update(frame.signals)
            backend.bind_signals(tuple(sorted(signal_ids)), abort=lambda: backend_fence("bind_signals"))
            backend_fence("configure_environment")
            backend.configure_environment(lease.render_spec.environment)
            check_abort("configure_environment")
            # The blueprint registry is a superset of what the cook shipped, so
            # availability is only knowable once a world is loaded. Bodies are
            # resolved again, from the authored plan, against what this runtime
            # was observed to place.
            spawnable = _optional_backend_call(
                backend,
                "spawnable_blueprints",
                _probe_blueprints(authored_plan, catalog, policy),
                abort=lambda: backend_fence("verify_blueprints"),
            )
            if spawnable is not None:
                plan, substitutions = _resolve_actor_bodies(
                    authored_plan, catalog, policy,
                    lambda: backend_fence("verify_blueprints"),
                    spawnable=frozenset(spawnable),
                )
                check_abort("verify_blueprints")
            substitutions = (*compiled_substitutions, *substitutions)
            for record in substitutions:
                emit("substitution", record)
            # Seek: bodies spawn at their pose on the window's first tick (the
            # clip start for a full render); absent ones are never spawned.
            start_frame = plan.frames[window.start_tick]
            backend.spawn(plan.actors, start_frame, catalog, abort=lambda: backend_fence("spawn_actors"))
            check_abort("spawn_actors")
            spawn_placement = _optional_backend_call(
                backend,
                "spawn_placement_report",
                abort=lambda: check_abort("spawn_actors"),
            )
            if isinstance(spawn_placement, Mapping):
                dropped_actor_ids = {
                    str(item) for item in spawn_placement.get("droppedActorIds", ())
                }
                dropped_mounts = sorted({
                    sensor.actor_id for sensor in lease.render_spec.sensors
                    if sensor.actor_id in dropped_actor_ids
                })
                if dropped_mounts:
                    raise ContractError(
                        "spawn placement dropped sensor host actors: "
                        + ", ".join(dropped_mounts)
                    )
                static_planar_offsets: dict[str, tuple[float, float]] = {}
                placement_actors = spawn_placement.get("actors")
                if isinstance(placement_actors, Mapping):
                    for actor_id, item in placement_actors.items():
                        binding = plan.actors.get(actor_id)
                        if (
                            binding is None
                            or not binding.static
                            or not isinstance(item, Mapping)
                            or item.get("outcome") != "nudged"
                        ):
                            continue
                        authored = item.get("authored")
                        placed = item.get("placed")
                        if isinstance(authored, Mapping) and isinstance(placed, Mapping):
                            static_planar_offsets[str(actor_id)] = (
                                float(placed["x"]) - float(authored["x"]),
                                float(placed["y"]) - float(authored["y"]),
                            )
                accumulator.configure_spawn_placement(dropped_actor_ids, static_planar_offsets)
            else:
                spawn_placement = None
            if lease.job_mode == "full_render":
                backend.configure_sensors(lease.render_spec, output_dir, MAX_OUTPUT_BYTES, abort=lambda: backend_fence("configure_sensors"))
                check_abort("configure_sensors")
            stability = backend.prepare_scenario(start_frame, abort=lambda: backend_fence("prepare_scenario"))
            check_abort("prepare_scenario")
            # Fail closed before t=0 on an actor that is displaced from its
            # placement, hanging above the ground or buried in it. Per-tick
            # readback/airborne/motion gates run inside backend.tick().
            _optional_backend_call(
                backend,
                "validate_placement",
                abort=lambda: backend_fence("validate_placement"),
            )
            check_abort("validate_placement")
            emit("interaction_started" if lease.job_mode == "interaction_2d" else "render_started", {"frames": tick_total, "executionMode": execution_mode})
            geometry = _replay_geometry(backend, plan) if replay else None
            for position, index in enumerate(window_ticks):
                check_abort("execute", position, tick_total)
                backend_fence("execute", position, tick_total)
                capture = capture_schedule.get(index)
                if replay:
                    # The render timeline is sampled at the instant the pixels
                    # of this tick show: the capture time when one falls here.
                    frame = sampler.frame_at(index, capture[2] if capture is not None else plan.frames[index].t)
                    if capture is not None:
                        sampled_frames[index] = frame
                else:
                    frame = plan.frames[index]
                backend.apply(frame, abort=lambda: backend_fence("execute", position, tick_total))
                actual = backend.tick(None if capture is None else {
                    "outputFrameIndex": capture[0], "scheduledTimeS": capture[1], "contentTimeS": capture[2],
                }, abort=lambda: backend_fence("execute", position, tick_total))
                signals = backend.signal_readback(abort=lambda: backend_fence("execute", position, tick_total))
                if replay:
                    # Contacts are the trace's events; CARLA observes none.
                    collisions: list[Mapping[str, object]] = []
                    replay_gate.observe(
                        frame,
                        expected_replay_poses(
                            frame, geometry["classes"], geometry["bottoms"], geometry["zOffsetM"],
                            skip=geometry["dropped"],
                        ),
                        {
                            actor_id: _observed_render_pose(value)
                            for actor_id, value in actual.items()
                            if value.get("present", True)
                        },
                        expected_signals=frame.signals,
                        observed_signals=signals,
                    )
                    if comparator_records is not None:
                        comparator_records.append(json.dumps({
                            "t": frame.t,
                            "actors": [
                                timeline_observation(
                                    actor_id, pose,
                                    walker=geometry["classes"].get(actor_id) == "walker",
                                    downed=frame.actors[actor_id].downed,
                                    bottom_offset_m=geometry["bottoms"].get(actor_id, 0.0),
                                    z_offset_m=geometry["zOffsetM"],
                                )
                                for actor_id, value in sorted(actual.items())
                                if value.get("present", True)
                                and actor_id not in sampler.props
                                and (pose := _observed_render_pose(value)) is not None
                            ],
                        }, separators=(",", ":")))
                    readback_times.append(frame.t)
                    for state in frame.actors.values():
                        if state.lifecycle != LIFECYCLE_ABSENT:
                            rendered_appearance.update(state.appearance)
                else:
                    collisions = _optional_backend_call(
                        backend,
                        "collision_readback",
                        frame.index,
                        frame.t,
                        abort=lambda: backend_fence("execute", position, tick_total),
                    ) or []
                    # A physics tick applied for frame i leaves the world at
                    # t_{i+1}: that is the state read back and the one it is
                    # compared with (the former one-tick label offset).
                    if index + 1 < len(plan.frames):
                        accumulator.observe(plan.frames[index + 1], actual, actual_signals=signals, collision_events=collisions)
                    readback_times.append(round(frame.t + plan.fixed_timestep_s, 9))
                readbacks.append(actual)
                signal_readbacks.append(signals)
                collision_readbacks.append(collisions)
                if position and position % 250 == 0:
                    emit("progress", {"completedFrames": position + 1, "totalFrames": tick_total})
            if lease.job_mode == "full_render":
                backend.finalize_capture(expected_capture_count, abort=lambda: backend_fence("finalize_capture", expected_capture_count, expected_capture_count))
            evidence = _optional_backend_call(
                backend,
                "runtime_evidence",
                abort=lambda: backend_fence("collect_runtime_evidence", tick_total, tick_total),
            )
            if evidence is not None:
                runtime_evidence = evidence
        except BaseException as original_error:
            try:
                backend.cleanup()
            except BaseException as cleanup_error:
                raise original_error.with_traceback(original_error.__traceback__) from cleanup_error
            raise
        else:
            backend.cleanup()
        check_abort("collect_sensor_manifest")
        sensor_records = backend.sensor_manifest(abort=lambda: check_abort("collect_sensor_manifest"))
        check_abort("collect_sensor_manifest")
        capture_temp_bytes = _capture_temp_bytes(output_dir, lambda: check_abort("measure_capture_storage"))
        artifact_temp_limit = MAX_OUTPUT_BYTES - capture_temp_bytes
        if artifact_temp_limit <= 0:
            raise ContractError("captured frames leave no shared temporary-disk budget for artifacts")
        artifacts: list[dict[str, object]] = []
        output_bytes = 0
        def add_artifact(item: dict[str, object]) -> None:
            nonlocal output_bytes
            output_bytes += int(item["sizeBytes"])
            artifacts.append(item)
            emit("artifact_uploaded", {"kind": item["kind"], "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]})
        def make_artifact(
            kind: str,
            body: ArtifactBody,
            media_type: str,
            reservation: Mapping[str, Any] | None,
            metadata: Mapping[str, object] | None = None,
            precomputed_digest: str | None = None,
        ) -> dict[str, object]:
            try:
                if _body_size(body) > artifact_temp_limit:
                    raise ContractError(f"artifact {kind} exceeds the shared temporary-disk budget")
                _enforce_output_budget(output_bytes, body, kind)
                check_abort(f"upload_{kind}", len(plan.frames), len(plan.frames))
                return _artifact(
                    kind, body, media_type, reservation, uploader, metadata, authorize_upload,
                    deadline_monotonic=absolute_deadline,
                    abort=lambda: check_abort(f"upload_{kind}", len(plan.frames), len(plan.frames)),
                    precomputed_digest=precomputed_digest,
                )
            finally:
                if isinstance(body, Path):
                    body.unlink(missing_ok=True)
        if "trace" in lease.render_spec.outputs or "trace" in lease.artifact_uploads:
            trace_body = _trace_to_path(window.restrict(plan), readbacks, signal_readbacks, collision_readbacks, package.control_sha256, package.source_input_digest, package.materialized_traffic_digest, Path(directory) / "trace.json.gz", min(artifact_temp_limit, MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes), lambda: check_abort("serialize_trace"), readback_times)
            add_artifact(make_artifact("trace", trace_body, "application/gzip", lease.artifact_uploads.get("trace"), {"format": "json", "contentEncoding": "gzip"}))
        if "video" in lease.render_spec.outputs:
            check_abort("collect_camera_videos", len(plan.frames), len(plan.frames))
            video_encoder = simforge_env("PRESENTATION_VIDEO_ENCODER", "software")
            camera_sensors = [
                sensor for sensor in lease.render_spec.sensors
                if sensor.modality in CAMERA_MODALITIES
            ]
            primary_rgb_sensor = next(
                sensor for sensor in camera_sensors if sensor.modality == "rgb"
            )
            for index, sensor in enumerate(camera_sensors):
                remaining_bytes = min(MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes, artifact_temp_limit)
                body = _collect_camera_video(
                    output_dir,
                    sensor.artifact_name,
                    lease.render_spec.fps,
                    Path(directory) / f"camera-video-{index:02d}.mp4",
                    expected_capture_count,
                    remaining_bytes,
                    check_abort,
                    absolute_deadline,
                )
                check_abort("collect_camera_videos", len(plan.frames), len(plan.frames))
                # The primary RGB camera's stream doubles as the review MP4
                # ("video"); every other camera uploads its own stream.
                upload_kind = (
                    "video" if sensor is primary_rgb_sensor
                    else f"sensorVideo:{sensor.artifact_name}"
                )
                add_artifact(make_artifact(
                    upload_kind,
                    body,
                    "video/mp4",
                    lease.artifact_uploads.get(upload_kind),
                    {
                        "actorId": sensor.actor_id,
                        "sensorId": sensor.sensor_id,
                        "modality": sensor.modality,
                        "outputName": sensor.role,
                        "codec": "h264",
                        "container": "mp4",
                        "format": "mp4-h264",
                        "encoder": video_encoder,
                        "encoderArgs": list(presentation_video_codec_args()),
                        "width": int(sensor.config["width"]),
                        "height": int(sensor.config["height"]),
                        "frameCount": expected_capture_count,
                        "fps": lease.render_spec.fps,
                        "durationS": window.duration_s(plan),
                    },
                ))
            visualization_sensors = [
                sensor for sensor in lease.render_spec.sensors
                if sensor.modality in {"lidar", "semantic-lidar", "radar"}
            ]
            for index, sensor in enumerate(visualization_sensors):
                check_abort("encode_sensor_visualization", index, len(visualization_sensors))
                remaining_bytes = min(MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes, artifact_temp_limit)
                viz_body = encode_sensor_video(
                    sensor,
                    output_dir,
                    Path(directory) / f"sensor-viz-{index:02d}.mp4",
                    lease.render_spec.fps,
                    expected_capture_count,
                    remaining_bytes,
                    lambda: check_abort("encode_sensor_visualization", index, len(visualization_sensors)),
                )
                # The encoder no longer truncates at a size cap, so a
                # visualization is either whole or the job fails.
                if viz_body.stat().st_size > remaining_bytes:
                    raise ContractError(f"sensor visualization {sensor.artifact_name} exceeds its output budget")
                _verify_video_frames(
                    viz_body, f"sensor visualization {sensor.artifact_name}", lease.render_spec.fps,
                    expected_capture_count, check_abort, absolute_deadline,
                )
                upload_kind = f"sensorVideo:{sensor.artifact_name}"
                add_artifact(make_artifact(
                    upload_kind,
                    viz_body,
                    "video/mp4",
                    lease.artifact_uploads.get(upload_kind),
                    {
                        "actorId": sensor.actor_id,
                        "sensorId": sensor.sensor_id,
                        "modality": sensor.modality,
                        "outputName": sensor.role,
                        "codec": "h264",
                        "container": "mp4",
                        "format": "mp4-h264",
                        "representation": "visualization",
                        "encoderArgs": list(SENSOR_VISUALIZATION_CODEC_ARGS),
                        **visualization_scales(sensor),
                        "frameCount": expected_capture_count,
                        "fps": lease.render_spec.fps,
                        "durationS": window.duration_s(plan),
                    },
                ))
        data_sensors = [
            sensor for sensor in lease.render_spec.sensors
            if sensor.modality in {"lidar", "semantic-lidar", "radar"}
        ]
        for sensor in data_sensors:
            check_abort("package_sensor_data", 0, len(data_sensors))
            sensor_dir = output_dir / sensor.artifact_name
            if not sensor_dir.is_dir():
                raise CarlaRenderError(
                    "carla_sensor_capture_missing",
                    f"sensor {sensor.artifact_name} captured no data directory",
                )
            data_body = _archive_sensor_data(
                sensor_dir,
                Path(directory) / f"sensor-data-{sensor.artifact_name}.zip",
                MAX_ARTIFACT_BYTES,
                lambda: check_abort("package_sensor_data", 0, len(data_sensors)),
            )
            upload_kind = f"sensorData:{sensor.artifact_name}"
            add_artifact(make_artifact(
                upload_kind,
                data_body,
                "application/zip",
                lease.artifact_uploads.get(upload_kind),
                {
                    "actorId": sensor.actor_id,
                    "sensorId": sensor.sensor_id,
                    "modality": sensor.modality,
                    "outputName": sensor.role,
                    "fps": lease.render_spec.fps,
                    **({
                        "sweep": {
                            "policy": "latest-full-revolution",
                            "ticksPerRevolution": lidar_ticks_per_revolution(
                                float(sensor.config["rotationFrequencyHz"]), plan.fixed_timestep_s,
                            ),
                            "motionCompensation": "none",
                        },
                    } if sensor.modality in {"lidar", "semantic-lidar"} else {}),
                },
            ))
        if "annotations" in lease.render_spec.outputs:
            annotations_body = _annotations_to_path(plan, readbacks, annotation_schedule, Path(directory) / "annotations.ndjson", min(artifact_temp_limit, MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes), lambda: check_abort("serialize_annotations"), sampled_frames, window.start_tick)
            add_artifact(make_artifact("annotations", annotations_body, "application/x-ndjson", lease.artifact_uploads.get("annotations"), {"frameCount": len(annotation_schedule), "fps": lease.render_spec.fps, "durationS": window.duration_s(plan)}))
        parity = accumulator.report()
        replay_report = replay_gate.report() if replay else None
        comparator_passed = True
        if replay and render_timeline is not None:
            # Only what the window shows must render: state authored outside
            # it is not in any rendered frame.
            _verify_timeline_appearance(window.restrict(authored_plan), rendered_appearance)
        if replay_report is not None and comparator_records is not None:
            import simforge_oss_timeline
            comparator = simforge_oss_timeline.compare_observed(
                sampler.timeline, "\n".join(comparator_records), "carla",
            )
            comparator_passed = comparator.get("pass") is True
            replay_report = {
                **replay_report,
                "comparator": {key: value for key, value in comparator.items() if key != "perActor"},
                "verdict": "pass" if replay_report["verdict"] == "pass" and comparator_passed else "fail",
            }
        attestation = _attestation(validation, execution_mode, runtime_evidence)
        if stability:
            attestation["nativeStability"] = stability
        if spawn_placement:
            attestation["spawnPlacement"] = dict(spawn_placement)
        if replay:
            parity_evidence = _replay_parity_evidence(
                lease, plan, replay_report, runtime_evidence, artifacts,
                expected_capture_count, spawn_placement,
            )
        else:
            parity_evidence = _parity_evidence(
                lease,
                plan,
                parity,
                runtime_evidence,
                artifacts,
                expected_capture_count,
                spawn_placement,
            )
        accepted = parity_evidence["verdict"] == "pass"
        purpose = EXECUTION_PURPOSE[execution_mode]
        parity_value = {
            **({} if replay else asdict(parity)),
            **({"rawStrictAccepted": parity.reference_accepted} if not replay else {}),
            "executionMode": execution_mode,
            "purpose": purpose,
            "replay": replay_report,
            "accepted": accepted,
            "acceptanceEligible": True,
            "verdict": f"{'accepted' if accepted else 'failed'}-{purpose}",
        }
        if "parity-report" in lease.artifact_uploads:
            parity_body = json.dumps(
                parity_evidence,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            add_artifact(make_artifact(
                "parity-report",
                parity_body,
                "application/json",
                lease.artifact_uploads.get("parity-report"),
                {"schema": "uniscenario.parity-evidence/v1"},
            ))
        if "manifest" in lease.render_spec.outputs:
            manifest_body = _manifest_to_path(
                lease,
                window.restrict(plan),
                sensor_records,
                validation,
                parity_value,
                parity_evidence,
                attestation,
                artifacts,
                Path(directory) / "manifest.json",
                min(artifact_temp_limit, MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES - output_bytes),
                lambda: check_abort("serialize_manifest"),
                substitutions,
                {
                    "execution": {
                        "mode": execution_mode,
                        "purpose": purpose,
                        "scenarioRender": replay,
                        "label": "Trace replay" if replay else "CARLA physics validation (not the scenario render)",
                    },
                    "timeline": dict(sampler.evidence()),
                    "renderWindow": dict(window.evidence(plan)),
                    "approximations": _approximations(execution_mode, runtime_evidence, ridden_two_wheelers(plan, execution_mode)),
                },
                rendered_appearance if replay else None,
            )
            add_artifact(make_artifact("manifest", manifest_body, "application/json", lease.artifact_uploads.get("manifest")))
    return {
        # Status is the blocking pose gate; ``parity.accepted`` additionally
        # folds in the semantic/runtime closure the control plane requires.
        "status": "succeeded" if ((replay_gate.passed and comparator_passed) if replay else parity.accepted) else "failed-parity",
        "planSha256": plan.sha256,
        "sourceInputDigest": package.source_input_digest,
        "materializedTrafficDigest": package.materialized_traffic_digest,
        "attestation": attestation,
        "parity": parity_value,
        "parityEvidence": parity_evidence,
        "substitutions": [dict(item) for item in substitutions],
        "riderPoseStatic": ridden_two_wheelers(plan, lease.render_spec.execution_mode),
        "artifacts": artifacts,
    }


def filesystem_validator(xsd_path: Path) -> Validate:
    return lambda xml: validate_xosc14(xml, xsd_path)
