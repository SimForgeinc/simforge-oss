"""Authored render -> scorable Alpamayo clip. The conversion, productized.

The chain the product promises is: author a scenario, simulate it, render it
with the native renderer, and feed THAT render to a model for a real result.
The conversion in the middle is the part most likely to be done quietly by an
operator with a notebook, and quiet conversions are where fabricated inputs
enter. So it lives here, in code, with typed refusals a UI can display.

Three refusals matter more than the rest, because each has a plausible,
tempting, wrong alternative:

* ONE VIDEO FANNED OUT TO A MULTI-CAMERA RIG. A fixed-rig model takes N
  distinct views and has no camera-identity channel, so duplicated streams
  cannot be detected by the network - it will happily return a trajectory
  computed from four copies of the front camera. Per-camera content digests
  are compared and identical streams are refused.
* AN UNDECLARED TIME BASE. The model was trained at a fixed cadence. A
  render at 24 fps cannot be resampled to 10 Hz by nearest-frame selection
  without up to +/-20.8 ms of jitter, which is silently absorbed and shows
  up as a metric difference nobody can attribute. Either the render cadence
  divides the model cadence exactly, or the sample times are declared and
  the jitter is reported.
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


def assert_distinct_streams(streams: dict[str, list[bytes]]) -> dict[str, str]:
    """Refuse a single video fanned out across a multi-camera rig.

    This is the failure the plan calls out by name. A fixed-rig model cannot
    detect duplicated views, so the refusal has to happen here or not at all.
    """
    digests = {sensor: _stream_digest(frames) for sensor, frames in streams.items()}
    seen: dict[str, list[str]] = {}
    for sensor, digest in digests.items():
        seen.setdefault(digest, []).append(sensor)
    duplicates = {d: s for d, s in seen.items() if len(s) > 1}
    if duplicates:
        raise _refuse(
            "input_error",
            "identical image content supplied for multiple cameras: "
            + "; ".join(", ".join(sorted(s)) for s in duplicates.values())
            + ". A multi-camera model takes distinct views and has no "
            "camera-identity channel, so duplicated streams cannot be "
            "detected by the network - it would return a trajectory computed "
            "from copies of one camera. Render each camera in the rig.",
            duplicateGroups=[sorted(s) for s in duplicates.values()],
        )
    return digests


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
) -> ClipConversion:
    """Convert one authored render into a model observation.

    ``streams`` maps the renderer's sensor ids to the frames it produced for
    that camera, oldest first, already sampled at the model cadence via
    :func:`sample_indices`. ``ego_world_xyz`` is the simulation's per-frame
    ego position in world coordinates, indexed like the render.
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

    digests = assert_distinct_streams(streams)

    exact, jitter = render_fps_is_compatible(render_fps)

    # Time base. A declared cadence makes the run scorable; an exact divisor
    # additionally means no resampling error at all.
    time_base: dict[str, Any] = {
        "render_fps": render_fps,
        "model_hz": NOMINAL_HZ,
        "cadence_divides_exactly": exact,
        "worst_resample_error_s": jitter,
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

    observation: dict[str, Any] = {
        "cameras": cameras,
        "ego_history_xyz": ego_history,
        # Declared, not measured: the renderer's cadence is authored and
        # fixed, which is exactly the case the decoder accepts as declared.
        "ego_history_rate_hz": NOMINAL_HZ,
    }

    provenance = {
        "source": "authored-scenario-render",
        "rigProfile": rig_profile,
        "cameraMap": camera_map,
        "streamDigests": digests,
        "timeBase": time_base,
        "t0RenderIndex": t0_index,
        "historyRenderIndices": history_indices,
        "scorable": reference_future is not None,
        "unscoredReason": unscored_reason,
        # Never synthetic: every pixel and pose came from the simulation.
        "synthetic": False,
    }
    return ClipConversion(observation, reference_future, provenance)
