"""Observation decoding, validation and synthetic-observation generation.

Observation schema (msgpack map or JSON object; ``simforge.policy-endpoint/v2``):

    cameras: list of camera maps, REQUIRED, at least one
        camera_id: int 0..6 (upstream CAMERA_NAMES_TO_INDICES)
        frames:   list of frame payloads, oldest -> newest (t0 LAST),
                  exactly ``num_frames_per_camera`` entries (4). Over the
                  msgpack wire these are binary; over HTTP they are base64
                  strings. Mutually exclusive with ``frames_paths``.
        frames_paths: list of absolute file paths, same ordering. Preferred
                  for local runs: avoids a base64 copy per camera per step.
        encoding: "raw" | "raw-b64" | "jpeg" | "png"   (default "raw")
        width/height: REQUIRED for raw/raw-b64 (H*W*3 uint8 RGB bytes).
                  ``w``/``h`` accepted as aliases.
    ego_history_xyz: 16 x [x, y, z] floats, ego frame at t0 (last == origin)
    ego_history_rot: 16 x 3x3 row-major floats (optional; default identity)
    ego_history_t_s: 16 floats, seconds relative to t0 (optional; strictly
                  increasing, last == 0.0). Validated and recorded in
                  provenance when present; its absence is recorded as
                  ``assumed-10hz`` rather than silently normalised away.
    nav_text: optional navigation instruction string

Nothing is ever fabricated here. A missing camera, a short frame window, a
wrong-length history or a camera set that violates the family contract is a
typed error, never a pad or a synthesized view. The single exception is
documented and labelled: ``BundleObservationBridge`` replicates the oldest
frame during the first ticks of an episode (cold start) and says so.
"""

from __future__ import annotations

import base64
import binascii
import io
import os
from typing import Any

import numpy as np

NUM_HISTORY_STEPS = 16
NUM_FRAMES_PER_CAMERA = 4
#: 512 x 384 == 196,608 px == upstream MAX_PIXELS: no resize surprises.
SYNTH_W, SYNTH_H = 512, 384
#: Nominal camera/history cadence. Upstream models consume 10 Hz windows.
NOMINAL_HZ = 10.0
#: Tolerance when checking a supplied ``ego_history_t_s`` against 10 Hz.
TIME_BASE_TOLERANCE_S = 5e-3

MIN_PIXELS = 163840
MAX_PIXELS = 196608

RAW_ENCODINGS = ("raw", "raw-b64")
IMAGE_ENCODINGS = ("jpeg", "png")


class ObservationError(ValueError):
    """A typed, caller-facing observation rejection.

    ``code`` is the wire error code the HTTP facade and the msgpack server
    both report, so a refusal is recorded per item instead of failing a
    whole batch.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        fields: list[str] | None = None,
        required_cameras: list[int] | None = None,
        detail: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.fields = fields or []
        self.required_cameras = required_cameras
        self.detail = detail or {}

    def as_wire(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.fields:
            error["fields"] = self.fields
        error["required_cameras"] = self.required_cameras
        if self.detail:
            error["detail"] = self.detail
        return error


def _dim(cam: dict[str, Any], *names: str) -> int | None:
    for name in names:
        value = cam.get(name)
        if value is not None:
            return int(value)
    return None


def validate_camera_set(
    camera_ids: list[int],
    required: tuple[int, ...] | None,
    variable: bool,
    *,
    family: str,
    task: str = "act",
    max_cameras: int = 7,
) -> None:
    """Enforce a family's camera contract. Never pads, never truncates."""
    if not camera_ids:
        raise ObservationError(
            "missing_fields",
            "observation.cameras is required and must be non-empty",
            fields=["obs.cameras"],
        )
    if len(set(camera_ids)) != len(camera_ids):
        raise ObservationError(
            "input_error",
            f"duplicate camera_id in observation: {camera_ids}",
            fields=["obs.cameras[].camera_id"],
        )
    outside = [c for c in camera_ids if not 0 <= c <= 6]
    if outside:
        raise ObservationError(
            "input_error",
            f"camera_id values outside 0..6: {outside}",
            fields=["obs.cameras[].camera_id"],
        )
    if len(camera_ids) > max_cameras:
        raise ObservationError(
            "camera_set_invalid",
            f"{family}: at most {max_cameras} cameras, got {len(camera_ids)}",
            required_cameras=list(required) if required else None,
        )
    if required is not None and not variable:
        if tuple(sorted(camera_ids)) != tuple(sorted(required)):
            raise ObservationError(
                "camera_set_invalid",
                (
                    f"{family} task {task!r} requires exactly cameras "
                    f"{list(required)}; got {camera_ids}. This model has no "
                    "camera-count conditioning, so a different set is rejected "
                    "rather than padded or cropped."
                ),
                required_cameras=list(required),
                detail={"required": list(required), "got": camera_ids},
            )


def validate_history_times(
    t_s: Any, declared_rate_hz: float | None = None
) -> dict[str, Any]:
    """Validate the ego-history time base and say whether it can be SCORED.

    Upstream inference does not consume the timestamps, so this is validation
    plus provenance and never a silent resampling: a clock that is not 10 Hz
    is reported, not corrected.

    The `scorable` flag is the load-bearing part. An absent time base used to
    be recorded as ``assumed-10hz`` and allowed to proceed, which meant a
    metric could be computed against a history whose real cadence nobody
    knew. That is now refused for scoring:

    * ``ego_history_t_s`` supplied      -> scorable
    * ``ego_history_rate_hz`` declared  -> scorable, recorded as declared
      (for a dataset whose rate is documented, e.g. PhysicalAI-AV at 10 Hz)
    * neither                           -> NOT scorable; the run is
      inference-only, and a caller that asked for a metric gets a typed
      ``missing_fields`` refusal naming ``obs.ego_history_t_s``.
    """
    if t_s is None:
        if declared_rate_hz is None:
            return {
                "ego_history_t_s": "absent",
                "time_base": "unknown",
                "scorable": False,
                "time_base_warning": (
                    "no ego-history timestamps and no declared sample rate; the "
                    "history cadence is unknown, so this input is inference-only "
                    "and cannot be scored. Supply obs.ego_history_t_s, or "
                    "obs.ego_history_rate_hz when the source's rate is documented."
                ),
            }
        rate = float(declared_rate_hz)
        if not 0.0 < rate <= 1000.0:
            raise ObservationError(
                "input_error",
                f"ego_history_rate_hz must be a positive rate, got {rate!r}",
                fields=["obs.ego_history_rate_hz"],
            )
        warning = None
        if abs(rate - NOMINAL_HZ) > 1e-6:
            warning = (
                f"declared history rate {rate:g} Hz differs from the "
                f"{NOMINAL_HZ:g} Hz window the model was trained on; the input "
                "is not resampled"
            )
        return {
            "ego_history_t_s": f"declared-{rate:g}hz",
            "time_base": "declared",
            "declared_rate_hz": rate,
            "scorable": True,
            "time_base_warning": warning,
        }
    times = np.asarray(t_s, dtype=np.float64)
    if times.shape != (NUM_HISTORY_STEPS,):
        raise ObservationError(
            "input_error",
            f"ego_history_t_s must be ({NUM_HISTORY_STEPS},), got {tuple(times.shape)}",
            fields=["obs.ego_history_t_s"],
        )
    if not np.all(np.isfinite(times)):
        raise ObservationError(
            "input_error",
            "ego_history_t_s contains non-finite values",
            fields=["obs.ego_history_t_s"],
        )
    deltas = np.diff(times)
    if np.any(deltas <= 0.0):
        raise ObservationError(
            "input_error",
            "ego_history_t_s must be strictly increasing (oldest first, t0 last)",
            fields=["obs.ego_history_t_s"],
        )
    if abs(float(times[-1])) > 1e-6:
        raise ObservationError(
            "input_error",
            f"ego_history_t_s must end at 0.0 (t0); got {float(times[-1])!r}",
            fields=["obs.ego_history_t_s"],
        )
    nominal = 1.0 / NOMINAL_HZ
    worst = float(np.max(np.abs(deltas - nominal)))
    warning = None
    if worst > TIME_BASE_TOLERANCE_S:
        warning = (
            f"history cadence deviates from {NOMINAL_HZ:g} Hz by up to "
            f"{worst * 1e3:.1f} ms; the model was trained on a "
            f"{nominal * 1e3:.0f} ms window and the input is not resampled"
        )
    return {
        "ego_history_t_s": "supplied",
        "time_base": "measured",
        "history_dt_max_error_s": worst,
        "scorable": True,
        "time_base_warning": warning,
    }


def decode_observation(
    obs: dict[str, Any],
    *,
    required_cameras: tuple[int, ...] | None = None,
    variable_cameras: bool = True,
    family: str = "alpamayo",
    task: str = "act",
    max_cameras: int = 7,
    num_frames: int = NUM_FRAMES_PER_CAMERA,
) -> dict[str, Any]:
    """Decode and validate a wire observation into model-ready tensors.

    Returns dict with:
        frames: uint8 tensor (N_cams, n_frames, 3, H, W), camera-id ascending
        frames_flat: uint8 tensor (N_cams * n_frames, 3, H, W)
        camera_indices: int64 tensor (N_cams,)
        camera_ids: list[int]
        ego_history_xyz: float32 (1, 1, 16, 3)
        ego_history_rot: float32 (1, 1, 16, 3, 3)
        nav_text: str | None
        time_base: provenance record from :func:`validate_history_times`
        exploratory_video: validated caller opt-in to unscored uploaded-video mode
    """
    exploratory_video = obs.get("exploratory_video", False)
    if not isinstance(exploratory_video, bool):
        raise ObservationError(
            "input_error",
            "exploratory_video must be a boolean",
            fields=["obs.exploratory_video"],
        )
    if exploratory_video and task == "act":
        required_cameras = None
        variable_cameras = True

    import torch

    cameras = obs.get("cameras")
    if not cameras:
        raise ObservationError(
            "missing_fields",
            "observation.cameras is required and must be non-empty",
            fields=["obs.cameras"],
        )

    cams = sorted(cameras, key=lambda c: int(c["camera_id"]))
    cam_ids = [int(c["camera_id"]) for c in cams]
    validate_camera_set(
        cam_ids,
        required_cameras,
        variable_cameras,
        family=family,
        task=task,
        max_cameras=max_cameras,
    )

    per_cam: list[Any] = []
    dims: tuple[int, int] | None = None
    for cam in cams:
        payloads = _frame_payloads(cam, num_frames)
        decoded = [_decode_frame(payload, cam) for payload in payloads]
        shapes = {tuple(frame.shape) for frame in decoded}
        if len(shapes) != 1:
            raise ObservationError(
                "input_error",
                f"camera {cam['camera_id']}: frame sizes differ within the "
                f"history window: {sorted(shapes)}",
                fields=["obs.cameras[].frames"],
            )
        shape = decoded[0].shape
        this = (int(shape[2]), int(shape[1]))  # (width, height)
        if dims is not None and this != dims:
            raise ObservationError(
                "input_error",
                f"camera {cam['camera_id']}: frame size {this} differs from "
                f"{dims} on another camera; all cameras must share one size",
                fields=["obs.cameras[].frames"],
            )
        dims = this
        per_cam.append(torch.stack(decoded, dim=0))  # (n_frames, 3, H, W)

    frames = torch.stack(per_cam, dim=0)  # (N_cams, n_frames, 3, H, W)
    camera_indices = torch.tensor(cam_ids, dtype=torch.int64)

    hist_xyz = obs.get("ego_history_xyz")
    if hist_xyz is None:
        raise ObservationError(
            "missing_fields",
            f"observation.ego_history_xyz is required ({NUM_HISTORY_STEPS} x [x,y,z]); "
            "ego history is never synthesized",
            fields=["obs.ego_history_xyz"],
        )
    hist_xyz_arr = np.asarray(hist_xyz, dtype=np.float32)
    if hist_xyz_arr.shape != (NUM_HISTORY_STEPS, 3):
        raise ObservationError(
            "input_error",
            f"ego_history_xyz must be ({NUM_HISTORY_STEPS}, 3), got "
            f"{tuple(hist_xyz_arr.shape)}",
            fields=["obs.ego_history_xyz"],
        )
    if not np.all(np.isfinite(hist_xyz_arr)):
        raise ObservationError(
            "input_error",
            "ego_history_xyz contains non-finite values",
            fields=["obs.ego_history_xyz"],
        )

    hist_rot = obs.get("ego_history_rot")
    if hist_rot is None:
        hist_rot_arr = np.broadcast_to(
            np.eye(3, dtype=np.float32), (NUM_HISTORY_STEPS, 3, 3)
        ).copy()
    else:
        hist_rot_arr = np.asarray(hist_rot, dtype=np.float32)
        if hist_rot_arr.shape != (NUM_HISTORY_STEPS, 3, 3):
            raise ObservationError(
                "input_error",
                f"ego_history_rot must be ({NUM_HISTORY_STEPS}, 3, 3), got "
                f"{tuple(hist_rot_arr.shape)}",
                fields=["obs.ego_history_rot"],
            )
        if not np.all(np.isfinite(hist_rot_arr)):
            raise ObservationError(
                "input_error",
                "ego_history_rot contains non-finite values",
                fields=["obs.ego_history_rot"],
            )

    time_base = validate_history_times(
        obs.get("ego_history_t_s"), obs.get("ego_history_rate_hz")
    )

    return {
        "frames": frames,
        "frames_flat": frames.flatten(0, 1),
        "camera_indices": camera_indices,
        "camera_ids": cam_ids,
        "frame_size": dims,
        "ego_history_xyz": torch.from_numpy(hist_xyz_arr)[None, None],
        "ego_history_rot": torch.from_numpy(hist_rot_arr)[None, None],
        "nav_text": obs.get("nav_text"),
        "history_t_s": obs.get("ego_history_t_s"),
        "time_base": time_base,
        "exploratory_video": exploratory_video,
    }


def _frame_payloads(cam: dict[str, Any], num_frames: int) -> list[Any]:
    """Resolve one camera's frame window to raw payloads."""
    frames = cam.get("frames")
    paths = cam.get("frames_paths")
    if frames is not None and paths is not None:
        raise ObservationError(
            "input_error",
            f"camera {cam.get('camera_id')}: pass exactly one of frames / "
            "frames_paths, not both",
            fields=["obs.cameras[].frames", "obs.cameras[].frames_paths"],
        )
    if paths is not None:
        if len(paths) != num_frames:
            raise ObservationError(
                "input_error",
                f"camera {cam.get('camera_id')}: expected {num_frames} "
                f"frames_paths, got {len(paths)}",
                fields=["obs.cameras[].frames_paths"],
            )
        payloads = []
        for path in paths:
            if not isinstance(path, str) or not os.path.isabs(path):
                raise ObservationError(
                    "input_error",
                    f"frames_paths entries must be absolute paths, got {path!r}",
                    fields=["obs.cameras[].frames_paths"],
                )
            try:
                with open(path, "rb") as handle:
                    payloads.append(handle.read())
            except OSError as exc:
                raise ObservationError(
                    "input_error",
                    f"cannot read frame {path!r}: {exc.strerror or exc}",
                    fields=["obs.cameras[].frames_paths"],
                ) from None
        return payloads
    if frames is None:
        raise ObservationError(
            "missing_fields",
            f"camera {cam.get('camera_id')}: frames or frames_paths is required",
            fields=["obs.cameras[].frames"],
        )
    if len(frames) != num_frames:
        raise ObservationError(
            "input_error",
            f"camera {cam.get('camera_id')}: expected {num_frames} frames "
            f"(oldest first, t0 last), got {len(frames)}",
            fields=["obs.cameras[].frames"],
        )
    return list(frames)


def _decode_frame(frame: Any, cam: dict[str, Any]):
    """Decode one frame payload to a uint8 (3, H, W) tensor."""
    import torch

    encoding = cam.get("encoding", "raw")
    if encoding not in RAW_ENCODINGS + IMAGE_ENCODINGS:
        raise ObservationError(
            "input_error",
            f"unknown frame encoding: {encoding!r} "
            f"(expected one of {list(RAW_ENCODINGS + IMAGE_ENCODINGS)})",
            fields=["obs.cameras[].encoding"],
        )

    payload = frame
    if isinstance(payload, str):
        # Base64 is how frames cross HTTP; raw binary is the msgpack path.
        try:
            payload = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError):
            raise ObservationError(
                "input_error",
                f"camera {cam.get('camera_id')}: frame is a string but not "
                "valid base64",
                fields=["obs.cameras[].frames"],
            ) from None
    elif not isinstance(payload, (bytes, bytearray, memoryview)):
        raise ObservationError(
            "input_error",
            f"camera {cam.get('camera_id')}: frame payload must be bytes or a "
            f"base64 string, got {type(payload).__name__}",
            fields=["obs.cameras[].frames"],
        )

    if encoding in RAW_ENCODINGS:
        width = _dim(cam, "width", "w")
        height = _dim(cam, "height", "h")
        if width is None or height is None:
            raise ObservationError(
                "missing_fields",
                f"camera {cam.get('camera_id')}: width/height are required for "
                f"encoding {encoding!r}",
                fields=["obs.cameras[].width", "obs.cameras[].height"],
            )
        arr = np.frombuffer(payload, dtype=np.uint8)
        if arr.size != height * width * 3:
            raise ObservationError(
                "input_error",
                f"camera {cam.get('camera_id')}: raw frame has {arr.size} bytes, "
                f"expected {height}x{width}x3 = {height * width * 3}",
                fields=["obs.cameras[].frames"],
            )
        arr = arr.reshape(height, width, 3)
    else:
        from PIL import Image

        try:
            arr = np.asarray(Image.open(io.BytesIO(bytes(payload))).convert("RGB"))
        except Exception as exc:
            raise ObservationError(
                "input_error",
                f"camera {cam.get('camera_id')}: cannot decode {encoding} frame: {exc}",
                fields=["obs.cameras[].frames"],
            ) from None
    return torch.from_numpy(np.ascontiguousarray(arr.transpose(2, 0, 1)))


# ---------------------------------------------------------------------------
# Synthetic observations (latency measurement / smoke tests only)
# ---------------------------------------------------------------------------

#: Camera sets used by the synthetic generator, keyed by count. These exist to
#: measure latency and to exercise the wire; they are never a substitute for a
#: real observation and no product path can reach them.
PROFILE_CAMERAS = {
    2: [1, 6],
    4: [0, 1, 2, 6],
    6: [0, 1, 2, 3, 5, 6],
    7: [0, 1, 2, 3, 4, 5, 6],
}


def synthetic_observation(
    num_cameras: int = 2,
    seed: int = 0,
    speed_mps: float = 8.0,
    width: int = SYNTH_W,
    height: int = SYNTH_H,
    camera_ids: list[int] | None = None,
    with_times: bool = False,
) -> dict[str, Any]:
    """Deterministic synthetic wire-format observation.

    Frames are a structured road-like gradient plus seeded noise so that
    different (seed, camera) pairs produce distinct inputs while remaining
    byte-reproducible. FOR BENCHMARKS AND WIRE TESTS ONLY: a trajectory
    sampled from this input is not an evaluation of anything.
    """
    if camera_ids is None:
        if num_cameras not in PROFILE_CAMERAS:
            raise ValueError(
                f"num_cameras must be one of {sorted(PROFILE_CAMERAS)} "
                "or camera_ids must be given"
            )
        camera_ids = PROFILE_CAMERAS[num_cameras]
    rng = np.random.default_rng(seed)

    yy = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None, None]
    xx = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :, None]

    cameras = []
    for cam_id in camera_ids:
        frames = []
        for t in range(NUM_FRAMES_PER_CAMERA):
            sky = np.array([120, 160, 210], dtype=np.float32) * (1.0 - yy)
            road = np.array([90, 90, 95], dtype=np.float32) * yy
            base = np.broadcast_to(sky + road, (height, width, 3)).copy()
            # dashed center line that "moves" with t to fake ego motion
            phase = (yy[..., 0] * 12 + t * 0.7 + cam_id) % 1.0
            lane = (np.abs(xx[..., 0] - 0.5) < 0.006) & (phase < 0.55)
            base[lane] = np.array([235, 220, 90], dtype=np.float32)
            noise = rng.normal(0.0, 6.0, size=(height, width, 3)).astype(np.float32)
            img = np.clip(base + noise, 0, 255).astype(np.uint8)
            frames.append(img.tobytes())
        cameras.append(
            {
                "camera_id": cam_id,
                "frames": frames,
                "encoding": "raw",
                "width": width,
                "height": height,
            }
        )

    dt = 1.0 / NOMINAL_HZ
    hist_xyz = [
        [-(NUM_HISTORY_STEPS - 1 - i) * speed_mps * dt, 0.0, 0.0]
        for i in range(NUM_HISTORY_STEPS)
    ]

    obs: dict[str, Any] = {
        "cameras": cameras,
        "ego_history_xyz": hist_xyz,
        "synthetic": True,
    }
    if with_times:
        obs["ego_history_t_s"] = [
            -(NUM_HISTORY_STEPS - 1 - i) * dt for i in range(NUM_HISTORY_STEPS)
        ]
    return obs
