"""Authored render -> scorable Alpamayo clip. The conversion, productized.

The chain the product promises is: author a scenario, simulate it, render it
with the native renderer, and feed THAT render to a model for a real result.
The conversion in the middle is the part most likely to be done quietly by an
operator with a notebook, and quiet conversions are where fabricated inputs
enter. So it lives here, in code, with typed refusals a UI can display.

Three refusals matter more than the rest, because each has a plausible,
tempting, wrong alternative:

* DUPLICATED IMAGE CONTENT ACROSS A MULTI-CAMERA RIG. A fixed-rig model
  takes N distinct views and has no camera-identity channel, so duplicated
  streams cannot be detected by the network - it will happily return a
  trajectory computed from four copies of the front camera. Per-camera
  content digests are compared and identical streams are refused.

  What the digest proves, precisely: the CONTENT is duplicated. It does not
  prove one video was fanned out. A genuinely uniform scene - dense fog, a
  night frame, a camera pointed at a wall, a render that failed to a black
  buffer - can produce identical bytes from distinct cameras. That is why
  the refusal names duplicated content rather than accusing the caller of
  fanning out a video, and why `allow_identical_streams` exists: a caller
  who knows the scene is legitimately uniform can proceed, and the decision
  is recorded in provenance instead of being silently permitted.
* A FALSELY DECLARED TIME BASE. The model was trained at a fixed cadence,
  and a render at 24 fps cannot be resampled to 10 Hz by nearest-frame
  selection without up to +/-20.8 ms of error. The wrong fix is to declare
  `ego_history_rate_hz = 10` and let the decoder believe the samples are
  evenly spaced - that is pretending, and it makes the gate pass by
  weakening it. So this module emits `ego_history_t_s`: the ACTUAL sample
  times of the frames it selected, computed from the render cadence. The
  decoder then measures the real spacing and applies its own 5 ms tolerance
  to a true value. A 30 or 20 fps render yields exact times and passes
  cleanly; a 24 fps render yields the times it really has and is reported
  as such rather than corrected.
* A MISSING REFERENCE FUTURE. Without it the run is inference-only. That is
  legitimate - but it must be labelled, never scored, and a simulated clip
  usually HAS a future, so the common case is a scorable one and it would be
  a shame to throw it away by picking t0 at the end of the clip.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from simforge_alpamayo.bridge import (
    RIG_CAMERA_IDS,
    ego_history_from_positions,
    profile_camera_map,
)
from simforge_alpamayo.obs import (
    NOMINAL_HZ,
    NUM_FRAMES_PER_CAMERA,
    NUM_HISTORY_STEPS,
    ObservationError,
)

#: Frames of future the model's horizon covers, at the model cadence.
FUTURE_STEPS = 64

#: Seconds of clip needed on each side of t0. History is short; the future is
#: what constrains where t0 may sit.
HISTORY_SECONDS = (NUM_HISTORY_STEPS - 1) / NOMINAL_HZ
FUTURE_SECONDS = FUTURE_STEPS / NOMINAL_HZ


def _refuse(code: str, message: str, **detail: Any) -> ObservationError:
    """Build a typed refusal, routing extras into the wire `detail` map.

    ObservationError takes `fields` and `required_cameras` as named wire
    fields and everything else as `detail`, so a UI reads one shape for
    every refusal in the pipeline rather than a per-call-site invention.
    """
    fields = detail.pop("fields", None)
    required_cameras = detail.pop("required_cameras", None)
    return ObservationError(
        code,
        message,
        fields=fields,
        required_cameras=required_cameras,
        detail=detail or None,
    )


def render_fps_is_compatible(render_fps: float) -> tuple[bool, float]:
    """Does a render cadence resample to the model cadence exactly?

    Returns ``(exact, worst_jitter_s)``. 20 and 30 fps divide 10 Hz exactly;
    24 fps does not, and its worst nearest-frame error is half a render
    frame - about 20.8 ms, which is four times the tolerance the decoder
    accepts on a declared time base.
    """
    if render_fps <= 0:
        raise ValueError(f"render_fps must be positive, got {render_fps}")
    ratio = render_fps / NOMINAL_HZ
    exact = abs(ratio - round(ratio)) < 1e-9 and round(ratio) >= 1
    return exact, 0.0 if exact else 0.5 / render_fps


def sample_indices(render_fps: float, t0_index: int, count: int, *, backwards: bool) -> list[int]:
    """Render-frame indices closest to the model's cadence around t0.

    Selection is by TIME, not by stride, so a non-dividing render cadence
    produces the nearest available frame and the resulting error is reported
    rather than hidden.
    """
    step = render_fps / NOMINAL_HZ
    if backwards:
        offsets = [-(count - 1 - i) for i in range(count)]
    else:
        offsets = [i + 1 for i in range(count)]
    return [int(round(t0_index + offset * step)) for offset in offsets]


@dataclass
class ClipConversion:
    """A converted clip plus everything a reviewer needs to trust it."""

    observation: dict[str, Any]
    reference_future_xyz: list[list[float]] | None
    provenance: dict[str, Any]

    @property
    def scorable(self) -> bool:
        return self.reference_future_xyz is not None


def validate_rig(family_required: tuple[int, ...] | None, rig_profile: str) -> dict[str, int]:
    """Check an authored rig against a family's camera contract.

    Returns the sensor-id -> camera-index map for the rig, which is also the
    naming contract the renderer must satisfy.
    """
    try:
        camera_map = profile_camera_map(rig_profile)
    except ValueError as exc:  # bridge raises ValueError for an unknown rig
        raise _refuse(
            "input_error",
            f"unknown rig profile {rig_profile!r}",
            known=sorted(RIG_CAMERA_IDS),
        ) from exc

    rig_ids = tuple(sorted(camera_map.values()))
    if family_required is not None and rig_ids != tuple(sorted(family_required)):
        raise _refuse(
            "camera_set_invalid",
            f"rig {rig_profile!r} provides camera ids {list(rig_ids)} but the "
            f"model requires exactly {list(family_required)}. Cameras are "
            "positional for this model: a rig with the wrong set cannot be "
            "corrected by reordering or by substituting a nearby view.",
            expected=list(family_required),
            got=list(rig_ids),
            rigProfile=rig_profile,
        )
    return camera_map


def _stream_digest(frames: list[bytes]) -> str:
    digest = hashlib.sha256()
    for frame in frames:
        digest.update(hashlib.sha256(frame).digest())
    return digest.hexdigest()


def find_duplicate_streams(
    streams: dict[str, list[bytes]],
) -> tuple[dict[str, str], list[list[str]]]:
    """Return per-camera content digests and any groups sharing content."""
    digests = {sensor: _stream_digest(frames) for sensor, frames in streams.items()}
    by_digest: dict[str, list[str]] = {}
    for sensor, digest in digests.items():
        by_digest.setdefault(digest, []).append(sensor)
    duplicates = [sorted(group) for group in by_digest.values() if len(group) > 1]
    return digests, duplicates


def assert_distinct_streams(
    streams: dict[str, list[bytes]], *, allow_identical: bool = False
) -> tuple[dict[str, str], list[list[str]]]:
    """Refuse duplicated image content across a multi-camera rig.

    A fixed-rig model cannot detect duplicated views, so this check happens
    here or not at all. The refusal states what the evidence supports -
    identical CONTENT - and not that a video was fanned out, because a
    legitimately uniform scene (fog, night, a failed-to-black render) can
    also produce identical bytes from distinct cameras.

    ``allow_identical`` lets a caller who knows the scene is uniform proceed.
    It never silences the finding: the groups are returned either way and
    recorded in provenance.
    """
    digests, duplicates = find_duplicate_streams(streams)
    if duplicates and not allow_identical:
        raise _refuse(
            "input_error",
            "identical image content supplied for multiple cameras: "
            + "; ".join(", ".join(group) for group in duplicates)
            + ". This model takes distinct views and has no camera-identity "
            "channel, so duplicated content cannot be detected by the "
            "network - it would return a trajectory computed from copies of "
            "one camera. Note what this shows: the CONTENT is identical. It "
            "does not prove one video was fanned out; a uniform scene (dense "
            "fog, night, or a render that failed to a black buffer) can also "
            "produce identical bytes from distinct cameras. If the scene is "
            "genuinely uniform, pass allow_identical_streams=True and the "
            "decision is recorded rather than assumed.",
            duplicateGroups=duplicates,
        )
    return digests, duplicates


def convert_render_to_clip(
    *,
    streams: dict[str, list[bytes]],
    rig_profile: str,
    family_required: tuple[int, ...] | None,
    width: int,
    height: int,
    render_fps: float,
    t0_index: int,
    ego_world_xyz: list[list[float]],
    ego_heading_rad: float,
    total_frames: int,
    encoding: str = "raw",
    allow_identical_streams: bool = False,
    capture_profile_version: str | None = None,
    model_requirement_version: str | None = None,
) -> ClipConversion:
    """Convert one authored render into a model observation.

    ``streams`` maps the renderer's sensor ids to the frames it produced for
    that camera, oldest first, already sampled at the model cadence via
    :func:`sample_indices`. ``ego_world_xyz`` is the simulation's per-frame
    ego position in world coordinates, indexed like the render.

    ``capture_profile_version`` and ``model_requirement_version`` are the
    identity tags produced by ``captureProfileVersion`` and
    ``modelRequirementVersion`` in ``@simforge-oss/engine``. They are PASSED
    IN, never computed here: re-deriving them in Python would be a second
    hash implementation of the same payload, and two implementations of one
    digest is how a comparison silently stops matching. When absent they are
    recorded as ``None`` with a reason rather than guessed, and a consumer
    reports the run as having incomplete identity.
    """
    camera_map = validate_rig(family_required, rig_profile)

    missing = sorted(set(camera_map) - set(streams))
    if missing:
        raise _refuse(
            "missing_fields",
            f"rig {rig_profile!r} requires streams for {sorted(camera_map)}; "
            f"missing {missing}. The renderer emits one video per "
            "actorId+sensorId+modality, so a missing entry means that camera "
            "was not fitted or not rendered - it must not be substituted.",
            fields=[f"streams.{sensor}" for sensor in missing],
        )

    for sensor, frames in streams.items():
        if len(frames) != NUM_FRAMES_PER_CAMERA:
            raise _refuse(
                "input_error",
                f"camera {sensor!r} supplied {len(frames)} frames; the model "
                f"consumes exactly {NUM_FRAMES_PER_CAMERA} per camera, "
                "oldest first",
                expected=NUM_FRAMES_PER_CAMERA,
                got=len(frames),
            )

    digests, duplicate_groups = assert_distinct_streams(
        streams, allow_identical=allow_identical_streams
    )

    exact, jitter = render_fps_is_compatible(render_fps)

    # Time base. A declared cadence makes the run scorable; an exact divisor
    # additionally means no resampling error at all.
    time_base: dict[str, Any] = {
        "render_fps": render_fps,
        "model_hz": NOMINAL_HZ,
        "cadence_divides_exactly": exact,
        "worst_resample_error_s": jitter,
        # The times handed to the decoder are real, so the decoder's own
        # tolerance is applied to a true spacing rather than to a fiction.
        "sample_times": "actual",
    }

    # Reference future. Refuse to invent one; refuse also to silently drop a
    # real one by placing t0 too late in the clip.
    future_end = t0_index + int(round(FUTURE_STEPS * render_fps / NOMINAL_HZ))
    reference_future: list[list[float]] | None = None
    unscored_reason: str | None = None
    if future_end < total_frames and len(ego_world_xyz) > future_end:
        indices = sample_indices(render_fps, t0_index, FUTURE_STEPS, backwards=False)
        future_world = [ego_world_xyz[i] for i in indices]
        reference_future = ego_history_from_positions(
            [*future_world, ego_world_xyz[t0_index]],
            heading_rad=ego_heading_rad,
            steps=FUTURE_STEPS + 1,
        )[:-1]
    else:
        unscored_reason = (
            f"no reference future: t0 at render frame {t0_index} leaves "
            f"{max(total_frames - t0_index, 0)} frames, and "
            f"{FUTURE_SECONDS:.1f} s ({FUTURE_STEPS} model steps) are needed "
            f"after t0. The run is inference-only. Move t0 at least "
            f"{FUTURE_SECONDS:.1f} s before the end of the clip to make it "
            "scorable - a simulated clip normally has the future available."
        )

    history_indices = sample_indices(render_fps, t0_index, NUM_HISTORY_STEPS, backwards=True)
    if history_indices[0] < 0:
        raise _refuse(
            "input_error",
            f"t0 at render frame {t0_index} leaves less than "
            f"{HISTORY_SECONDS:.1f} s of history; the model consumes "
            f"{NUM_HISTORY_STEPS} past poses at {NOMINAL_HZ:g} Hz and the "
            "history must not be padded for a scored run",
            needFramesBefore=history_indices[0] * -1,
        )

    ego_history = ego_history_from_positions(
        [ego_world_xyz[i] for i in history_indices],
        heading_rad=ego_heading_rad,
        steps=NUM_HISTORY_STEPS,
    )

    cameras = [
        {
            "camera_id": camera_map[sensor],
            "frames": streams[sensor],
            "encoding": encoding,
            "width": width,
            "height": height,
        }
        for sensor in sorted(camera_map, key=lambda s: camera_map[s])
    ]

    # ACTUAL sample times, relative to t0, from the frames really selected.
    # Never a nominal 10 Hz: if the render cadence does not divide the model
    # cadence, these are unevenly spaced and the decoder must see that.
    history_t_s = [
        (index - t0_index) / render_fps for index in history_indices
    ]

    observation: dict[str, Any] = {
        "cameras": cameras,
        "ego_history_xyz": ego_history,
        "ego_history_t_s": history_t_s,
    }

    provenance = {
        "source": "authored-scenario-render",
        # Grouped to match the shape the comparison reader consumes:
        # rig.captureVersion is the family-free sensor-comparability key and
        # model.requirementVersion is metadata that must never enter it.
        "rig": {
            "profile": rig_profile,
            "captureVersion": capture_profile_version,
            "cameraMap": camera_map,
            "cameraIds": sorted(camera_map.values()),
        },
        "model": {
            "requirementVersion": model_requirement_version,
        },
        "identityComplete": bool(capture_profile_version),
        "identityNote": (
            None
            if capture_profile_version
            else "no capture profile version supplied; the caller must pass "
            "captureProfileVersion(rigId) from @simforge-oss/engine. It is "
            "not computed here, because a second implementation of the same "
            "digest is how two runs stop comparing."
        ),
        "streamDigests": digests,
        # Recorded whether or not it was allowed, so a reviewer sees it.
        "duplicateContentGroups": duplicate_groups,
        "identicalStreamsAllowed": bool(allow_identical_streams),
        "timeBase": time_base,
        "t0RenderIndex": t0_index,
        "historyRenderIndices": history_indices,
        "scorable": reference_future is not None,
        "unscoredReason": unscored_reason,
        # Never synthetic: every pixel and pose came from the simulation.
        "synthetic": False,
    }
    return ClipConversion(observation, reference_future, provenance)
