"""Per-sensor MP4 export for CARLA renders.

Every sensor owns exactly one playable video: cameras adopt the h264 stream
their backend encoder already produced (raw frames pipe straight into ffmpeg
and never land on disk), LiDAR renders as a top-down point cloud coloured by
range, and radar as a range/azimuth plot coloured by radial velocity — the
same two visualisations the browser renderer ships, so a clip reads the same
in either engine.
"""
from __future__ import annotations
import shutil

import math
import subprocess
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any

VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720
CAMERA_MODALITIES = frozenset({"rgb", "depth", "semantic", "instance", "normals"})
LIDAR_MODALITIES = frozenset({"lidar", "semantic-lidar"})
_BACKGROUND = (3, 7, 11)


class SensorVideoError(RuntimeError):
    """A sensor video could not be produced from the captured frames."""


#: Encoder arguments of every lidar/radar visualization (recorded per artifact).
SENSOR_VISUALIZATION_CODEC_ARGS: tuple[str, ...] = (
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
)
#: Radar returns are coloured by radial velocity on one fixed scale for the
#: whole clip (CARLA reports it in m/s), saturating at this speed, so a colour
#: means the same velocity in every frame.
RADAR_VELOCITY_SCALE_MPS = 20.0
#: The lidar plot shows returns within this range (or the sensor range, if
#: shorter); returns cluster within a few tens of metres, and a 200 m view
#: collapses the cloud into a dot.
LIDAR_VIEW_RANGE_M = 60.0


def visualization_scales(sensor: Any) -> dict[str, float]:
    """The fixed scales a sensor's visualization was drawn with."""
    if sensor.modality in LIDAR_MODALITIES:
        return {"viewRangeM": max(1.0, min(float(sensor.config["rangeM"]), LIDAR_VIEW_RANGE_M))}
    if sensor.modality == "radar":
        return {"viewRangeM": max(1.0, float(sensor.config["rangeM"])), "velocityScaleMps": RADAR_VELOCITY_SCALE_MPS}
    return {}


def _ffmpeg_common(fps: float, destination: Path) -> list[str]:
    # No `-fs`: a size cap would truncate the video silently. The caller
    # checks the finished file against its budget and its frame count.
    return [
        "-an", *SENSOR_VISUALIZATION_CODEC_ARGS, "-r", f"{fps:g}", "-movflags", "+faststart",
        str(destination),
    ]


def _frame_paths(sensor_dir: Path, extension: str, expected_frame_count: int) -> list[Path]:
    frames = sorted(sensor_dir.glob(f"*.{extension}"))
    if len(frames) != expected_frame_count:
        raise SensorVideoError(
            f"{sensor_dir.name} has {len(frames)} {extension} frames, expected {expected_frame_count}"
        )
    return frames


def encode_camera_video(
    sensor_dir: Path,
    fps: float,
    destination: Path,
    expected_frame_count: int,
    max_bytes: int,
) -> Path:
    """Adopt the camera's streamed h264 file; cameras persist no frame files."""
    stream = sensor_dir / "stream.mp4"
    if not stream.is_file() or stream.stat().st_size == 0:
        raise SensorVideoError(f"camera {sensor_dir.name} produced no encoded video stream")
    if stream.stat().st_size > max_bytes:
        raise SensorVideoError(f"camera video {sensor_dir.name} exceeds its budget")
    shutil.copyfile(stream, destination)
    return destination


def _blank_frame() -> bytearray:
    row = bytes(_BACKGROUND) * VIDEO_WIDTH
    return bytearray(row * VIDEO_HEIGHT)


def _plot(frame: bytearray, x: int, y: int, colour: tuple[int, int, int], radius: int = 1) -> None:
    for dy in range(-radius, radius + 1):
        row = y + dy
        if row < 0 or row >= VIDEO_HEIGHT:
            continue
        base = row * VIDEO_WIDTH * 3
        for dx in range(-radius, radius + 1):
            column = x + dx
            if column < 0 or column >= VIDEO_WIDTH:
                continue
            offset = base + column * 3
            frame[offset] = colour[0]
            frame[offset + 1] = colour[1]
            frame[offset + 2] = colour[2]


def _range_colour(ratio: float) -> tuple[int, int, int]:
    """Near returns warm, far returns cool, matching the browser point-cloud ramp."""
    ratio = 0.0 if ratio < 0 else 1.0 if ratio > 1 else ratio
    return (
        int(255 * (1.0 - 0.75 * ratio)),
        int(90 + 130 * (1.0 - abs(ratio - 0.5) * 2)),
        int(70 + 185 * ratio),
    )


def _velocity_colour(velocity: float, scale: float) -> tuple[int, int, int]:
    """Approaching returns blue, receding returns red, saturating at `scale` m/s."""
    magnitude = min(1.0, abs(velocity) / scale) if scale > 0 else 0.0
    if velocity < 0:
        return (60, int(150 + 105 * magnitude), 255)
    return (255, int(120 - 60 * magnitude), int(90 - 40 * magnitude))


def _grid(frame: bytearray, range_m: float, scale: float, origin_x: int, origin_y: int) -> None:
    for ring in range(1, int(range_m // 20) + 1):
        radius = ring * 20 * scale
        if radius < 4:
            continue
        steps = max(64, int(radius * 4))
        for step in range(steps):
            angle = 2 * math.pi * step / steps
            _plot(
                frame,
                origin_x + int(radius * math.sin(angle)),
                origin_y - int(radius * math.cos(angle)),
                (22, 42, 52),
                radius=0,
            )


def _read_lidar_points(path: Path) -> list[tuple[float, float, float, float | None]]:
    """(x, y, z, intensity) per return; intensity is None for semantic lidar,
    which has no intensity channel. A malformed file fails the video."""
    points: list[tuple[float, float, float, float | None]] = []
    with path.open("r", encoding="ascii") as handle:
        properties: list[str] = []
        declared: int | None = None
        for line in handle:
            if line.startswith("element vertex "):
                declared = int(line.split()[2])
            elif line.startswith("property "):
                properties.append(line.split()[2])
            elif line.startswith("end_header"):
                break
        else:
            raise SensorVideoError(f"{path.name} has no PLY header")
        if properties[:3] != ["x", "y", "z"] or declared is None:
            raise SensorVideoError(f"{path.name} is not an x/y/z point cloud")
        intensity_index = properties.index("I") if "I" in properties else None
        for number, line in enumerate(handle):
            parts = line.split()
            if len(parts) != len(properties):
                raise SensorVideoError(f"{path.name} point {number} has {len(parts)} fields, expected {len(properties)}")
            try:
                values = [float(item) for item in parts]
            except ValueError as exc:
                raise SensorVideoError(f"{path.name} point {number} is not numeric") from exc
            points.append((values[0], values[1], values[2], None if intensity_index is None else values[intensity_index]))
    if len(points) != declared:
        raise SensorVideoError(f"{path.name} declares {declared} points but holds {len(points)}")
    return points


def _read_radar_detections(path: Path) -> list[tuple[float, float, float, float]]:
    detections: list[tuple[float, float, float, float]] = []
    with path.open("r", encoding="utf-8") as handle:
        header = handle.readline()
        if not header.startswith("depth_m,azimuth_rad,altitude_rad,velocity_mps"):
            raise SensorVideoError(f"{path.name} has no radar CSV header")
        for number, line in enumerate(handle):
            parts = line.rstrip("\n").split(",")
            if len(parts) < 4:
                raise SensorVideoError(f"{path.name} detection {number} has {len(parts)} fields")
            try:
                detections.append((float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError as exc:
                raise SensorVideoError(f"{path.name} detection {number} is not numeric") from exc
    return detections


def _lidar_frames(frames: Sequence[Path], span: float) -> Iterator[bytes]:
    scale = min(VIDEO_WIDTH / (span * 2.2), VIDEO_HEIGHT / (span * 2.2))
    origin_x, origin_y = VIDEO_WIDTH // 2, VIDEO_HEIGHT // 2
    for path in frames:
        frame = _blank_frame()
        _grid(frame, span, scale, origin_x, origin_y)
        for x, y, _z, intensity in _read_lidar_points(path):
            distance = math.hypot(x, y)
            if distance > span:
                continue
            colour = _range_colour(distance / span)
            shade = 1.0 if intensity is None else 0.55 + 0.45 * min(1.0, max(0.0, intensity))
            _plot(
                frame,
                origin_x - int(y * scale),
                origin_y - int(x * scale),
                (int(colour[0] * shade), int(colour[1] * shade), int(colour[2] * shade)),
            )
        yield bytes(frame)


def _radar_frames(frames: Sequence[Path], span: float, velocity_scale: float) -> Iterator[bytes]:
    scale = min(VIDEO_WIDTH * 0.45, VIDEO_HEIGHT * 0.85) / span
    origin_x, origin_y = VIDEO_WIDTH // 2, int(VIDEO_HEIGHT * 0.92)
    for path in frames:
        frame = _blank_frame()
        _grid(frame, span, scale, origin_x, origin_y)
        detections = _read_radar_detections(path)
        for depth, azimuth, _altitude, velocity in detections:
            if depth > span:
                continue
            _plot(
                frame,
                origin_x + int(math.sin(azimuth) * depth * scale),
                origin_y - int(math.cos(azimuth) * depth * scale),
                _velocity_colour(velocity, velocity_scale),
                radius=2,
            )
        yield bytes(frame)


def _encode_raw_frames(
    frames: Iterator[bytes],
    fps: float,
    destination: Path,
    check_abort: Callable[[], None],
) -> Path:
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{VIDEO_WIDTH}x{VIDEO_HEIGHT}", "-framerate", f"{fps:g}", "-i", "-",
        *_ffmpeg_common(fps, destination),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for payload in frames:
            check_abort()
            process.stdin.write(payload)
    finally:
        process.stdin.close()
        stderr = process.stderr.read() if process.stderr else b""
        code = process.wait()
    if code:
        raise SensorVideoError(f"ffmpeg failed for {destination.name}: {stderr.decode(errors='replace')[:400]}")
    return destination


def encode_sensor_video(
    sensor: Any,
    output_dir: Path,
    destination: Path,
    fps: float,
    expected_frame_count: int,
    max_bytes: int,
    check_abort: Callable[[], None],
) -> Path:
    """Produce one MP4 for `sensor` from the frames it already captured."""
    sensor_dir = output_dir / sensor.artifact_name
    if not sensor_dir.is_dir():
        raise SensorVideoError(f"sensor {sensor.artifact_name} captured no frames")
    modality = sensor.modality
    if modality in CAMERA_MODALITIES:
        return encode_camera_video(sensor_dir, fps, destination, expected_frame_count, max_bytes)
    scales = visualization_scales(sensor)
    if modality in LIDAR_MODALITIES:
        frames = _frame_paths(sensor_dir, "ply", expected_frame_count)
        return _encode_raw_frames(_lidar_frames(frames, scales["viewRangeM"]), fps, destination, check_abort)
    if modality == "radar":
        frames = _frame_paths(sensor_dir, "csv", expected_frame_count)
        return _encode_raw_frames(
            _radar_frames(frames, scales["viewRangeM"], scales["velocityScaleMps"]), fps, destination, check_abort,
        )
    raise SensorVideoError(f"sensor {sensor.artifact_name} has no video representation for {modality}")
