#!/usr/bin/env python3
"""Stream an uploaded primary video through a trajectory/reasoning compositor.

The camera pane preserves the decoded source geometry. Predictions are selected by
actual frame PTS (latest prediction whose t0 is at or before the frame), rather
than by frame number or exact floating-point timestamp equality. Only model
returned trajectories and reasoning are rendered.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

BG = (26, 26, 46)
PANEL_BG = (16, 16, 18)
BOX_BG = (26, 27, 32)
BOX_BORDER = (70, 74, 84)
WHITE = (238, 240, 244)
MUTED = (150, 156, 168)
TEAL = (78, 205, 196)
ORANGE = (255, 151, 54)
BLUE = (67, 142, 255)
GRAY = (136, 136, 136)
YELLOW = (255, 217, 61)
_NUMPY_WRAPPER = re.compile(r"^\[(['\"])(.*)\1\]$", re.DOTALL)


def font(size: int, bold: bool = False):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    candidate = Path("/usr/share/fonts/truetype/dejavu") / name
    try:
        return ImageFont.truetype(str(candidate), size)
    except OSError:
        return ImageFont.load_default()


def clean_reasoning(value: object) -> str:
    text = "" if value is None else str(value).strip()
    wrapped = _NUMPY_WRAPPER.match(text)
    return (wrapped.group(2) if wrapped else text).strip()


def wrap_text(draw: ImageDraw.ImageDraw, text: str, text_font, width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if not current or draw.textlength(candidate, font=text_font) <= width:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def probe(ffprobe: str, source: Path) -> tuple[int, int, float, list[float], float]:
    completed = subprocess.run(
        [
            ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height,avg_frame_rate,duration:stream_side_data=rotation:frame=best_effort_timestamp_time,pkt_pts_time",
            "-of", "json", str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    document = json.loads(completed.stdout)
    stream = document["streams"][0]
    numerator, denominator = (int(part) for part in stream["avg_frame_rate"].split("/"))
    fps = numerator / denominator
    raw_times = [
        float(frame.get("best_effort_timestamp_time", frame.get("pkt_pts_time")))
        for frame in document.get("frames", [])
        if frame.get("best_effort_timestamp_time", frame.get("pkt_pts_time")) is not None
    ]
    if not raw_times or not math.isfinite(fps) or fps <= 0:
        raise RuntimeError("source video has no usable frame timestamps or frame rate")
    first = raw_times[0]
    rotation = next((entry["rotation"] for entry in stream.get("side_data_list", []) if "rotation" in entry), 0)
    width, height = int(stream["width"]), int(stream["height"])
    if abs(round(rotation)) % 180 == 90:
        width, height = height, width
    frame_times = [value - first for value in raw_times]
    duration = max(float(stream.get("duration", 0)), frame_times[-1] + 1 / fps)
    return width, height, min(fps, 60), frame_times, duration


def active_prediction(items: list[dict], common_time_us: int) -> dict | None:
    low, high = 0, len(items)
    while low < high:
        middle = (low + high) // 2
        if int(items[middle]["input"]["t0Us"]) <= common_time_us:
            low = middle + 1
        else:
            high = middle
    if not low:
        return None
    item = items[low - 1]
    if common_time_us - int(item["input"]["t0Us"]) > float(item.get("horizonS", 6.4)) * 1_000_000:
        return None
    return item


def project_sample(sample: list[list[float]], projection: dict, camera_height: float) -> list[tuple[float, float]]:
    matrix = projection["K"]
    fx, fy = float(matrix[0][0]), float(matrix[1][1])
    cx, cy = float(matrix[0][2]), float(matrix[1][2])
    extrinsics = projection["extrinsicsRigFromCamera"]
    points: list[tuple[float, float]] = []
    for point in sample:
        if len(point) < 2:
            continue
        rig = [float(point[0]), float(point[1]), float(point[2]) if len(point) > 2 else 0.0]
        relative = [rig[index] - float(extrinsics[index][3]) for index in range(3)]
        optical = [sum(float(extrinsics[row][column]) * relative[row] for row in range(3)) for column in range(3)]
        if optical[2] <= 0.05:
            continue
        points.append((fx * optical[0] / optical[2] + cx, fy * optical[1] / optical[2] + cy))
    return points


def draw_camera_overlay(image: Image.Image, prediction: dict | None, camera_height: float) -> None:
    if not prediction or prediction.get("status") != "ok" or not prediction.get("projection"):
        return
    draw = ImageDraw.Draw(image, "RGBA")
    width, height = image.size
    for sample_index, sample in enumerate(prediction.get("points", [])):
        projected = project_sample(sample, prediction["projection"], camera_height)
        visible = [(x, y) for x, y in projected if -width <= x <= 2 * width and -height <= y <= 2 * height]
        if len(visible) >= 2:
            color = ORANGE + (240,) if sample_index == 0 else BLUE + (150,)
            draw.line(visible, fill=color, width=max(3, width // 320), joint="curve")
            radius = max(2, width // 480)
            for x, y in visible:
                if 0 <= x < width and 0 <= y < height:
                    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)


def chart_coordinates(point: list[float], bounds: tuple[int, int, int, int]) -> tuple[float, float]:
    left, top, right, bottom = bounds
    forward = float(point[0])
    lateral = float(point[1])
    x = left + ((-lateral + 20.0) / 40.0) * (right - left)
    y = bottom - ((forward + 10.0) / 90.0) * (bottom - top)
    return x, y


def draw_panel(panel: Image.Image, prediction: dict | None, common_time_s: float, assumptions: dict) -> None:
    draw = ImageDraw.Draw(panel, "RGBA")
    width, height = panel.size
    pad = max(8, min(18, width // 32, height // 24))
    title_font = font(max(14, min(28, width // 24)), True)
    body_font = font(max(11, min(20, width // 39)))
    meta_font = font(max(9, min(16, width // 46)))
    draw.text((pad, pad), "AlpaMayo prediction", font=title_font, fill=WHITE)
    timestamp = "-" if prediction is None else str(prediction["input"]["t0Us"])
    metadata_y = pad + max(27, height // 16)
    draw.text(
        (pad, metadata_y),
        f"video t={common_time_s:.3f}s  prediction t0Us={timestamp}",
        font=meta_font,
        fill=MUTED,
    )

    chart_top = max(metadata_y + 18, int(height * 0.16))
    chart_bottom = max(chart_top + 55, int(height * 0.47))
    chart = (pad + 26, chart_top, width - pad, chart_bottom)
    draw.rectangle(chart, fill=BG + (255,), outline=BOX_BORDER + (255,), width=1)
    for meters in (-20, -10, 0, 10, 20):
        x, _ = chart_coordinates([0, -meters, 0], chart)
        draw.line((x, chart_top, x, chart_bottom), fill=(255, 255, 255, 38), width=1)
    for meters in (0, 20, 40, 60, 80):
        _, y = chart_coordinates([meters, 0, 0], chart)
        draw.line((chart[0], y, chart[2], y), fill=(255, 255, 255, 38), width=1)
    ego_x, ego_y = chart_coordinates([0, 0, 0], chart)
    draw.rectangle((ego_x - 7, ego_y - 12, ego_x + 7, ego_y + 12), fill=YELLOW + (255,), outline=WHITE + (255,))
    if prediction and prediction.get("status") == "ok":
        history_speed = float(assumptions["egoSpeedMps"])
        history = [[history_speed * (index - 15) * 0.1, 0, 0] for index in range(16)]
        draw.line([chart_coordinates(point, chart) for point in history], fill=GRAY + (210,), width=2)
        for sample_index, sample in enumerate(prediction.get("points", [])):
            coords = [chart_coordinates(point, chart) for point in sample if len(point) >= 2]
            if len(coords) >= 2:
                draw.line(coords, fill=(TEAL if sample_index == 0 else BLUE) + (235,), width=3)

    reasoning_top = chart_bottom + max(5, height // 90)
    draw.text((pad, reasoning_top), "Model reasoning", font=title_font, fill=TEAL)
    box_top = reasoning_top + max(25, height // 18)
    box_bottom = max(box_top + 35, int(height * 0.78))
    draw.rectangle((pad, box_top, width - pad, box_bottom), fill=BOX_BG + (255,), outline=BOX_BORDER + (255,))
    returned = [] if prediction is None else [clean_reasoning(value) for value in prediction.get("reasoning", [])]
    reasoning = "\n\n".join(value for value in returned if value)
    if reasoning:
        y = box_top + 10
        for line in wrap_text(draw, reasoning, body_font, width - 4 * pad):
            if y + 20 > box_bottom:
                break
            draw.text((2 * pad, y), line, font=body_font, fill=WHITE)
            y += max(17, height // 32)
    else:
        draw.text((2 * pad, box_top + 12), "No reasoning returned by the model at this timestamp.", font=body_font, fill=MUTED)

    assumptions_top = box_bottom + max(5, height // 90)
    draw.text((pad, assumptions_top), "Explicit upload assumptions", font=body_font, fill=WHITE)
    label = (
        f"pinhole HFOV={assumptions['horizontalFovDeg']}°; camera height={assumptions['cameraHeightM']}m; yaw={assumptions['primaryYawDeg']}°; "
        f"ego history=constant-speed straight at {assumptions['egoSpeedMps']}m/s"
    )
    y = assumptions_top + max(19, height // 35)
    for line in wrap_text(draw, label, meta_font, width - 2 * pad):
        if y + 16 > height:
            break
        draw.text((pad, y), line, font=meta_font, fill=MUTED)
        y += max(14, height // 42)


def compose(args: argparse.Namespace) -> None:
    width, height, fps, frame_times, duration = probe(args.ffprobe, args.source)
    result = json.loads(args.result.read_text())
    items = sorted(result["items"], key=lambda item: int(item["input"]["t0Us"]))
    assumptions = result["provenance"]["video"]["assumptions"]
    panel_width = max(480, min(760, width * 2 // 3))
    output_width = width + panel_width
    if output_width % 2:
        panel_width += 1
        output_width += 1
    output_height = height + (height % 2)
    frame_bytes = width * height * 3

    decoder = subprocess.Popen(
        [args.ffmpeg, "-v", "error", "-i", str(args.source), "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    encoder = subprocess.Popen(
        [
            args.ffmpeg, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{output_width}x{output_height}", "-r", f"{fps:.12g}", "-i", "-",
            "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(args.output),
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        raw = decoder.stdout.read(frame_bytes) if decoder.stdout else b""
        if len(raw) != frame_bytes:
            raise RuntimeError("source video did not decode its first frame")
        source_index = 0
        # Resample presentation only. Inference retained the original PTS;
        # output frames hold the latest source frame, never a future frame.
        for output_index in range(math.ceil(duration * fps - 1e-9)):
            frame_time_s = output_index / fps
            while source_index + 1 < len(frame_times) and frame_times[source_index + 1] <= frame_time_s + 1e-9:
                source_index += 1
                raw = decoder.stdout.read(frame_bytes) if decoder.stdout else b""
                if len(raw) != frame_bytes:
                    raise RuntimeError(f"short decoded frame {source_index}: {len(raw)} of {frame_bytes} bytes")
            common_time_s = frame_time_s + args.primary_offset_seconds
            prediction = active_prediction(items, round(common_time_s * 1_000_000))
            source_image = Image.fromarray(np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3)))
            draw_camera_overlay(source_image, prediction, float(assumptions["cameraHeightM"]))
            panel = Image.new("RGB", (panel_width, output_height), PANEL_BG)
            draw_panel(panel, prediction, common_time_s, assumptions)
            output = Image.new("RGB", (output_width, output_height), (0, 0, 0))
            output.paste(source_image, (0, 0))
            output.paste(panel, (width, 0))
            if encoder.stdin is None:
                raise RuntimeError("overlay encoder stdin unavailable")
            encoder.stdin.write(np.asarray(output, dtype=np.uint8).tobytes())
        if encoder.stdin:
            encoder.stdin.close()
        if decoder.stdout:
            while decoder.stdout.read(frame_bytes):
                pass
        decoder_code = decoder.wait()
        encoder_code = encoder.wait()
        if decoder_code != 0 or encoder_code != 0:
            raise RuntimeError(f"ffmpeg overlay pipeline failed: decoder={decoder_code}, encoder={encoder_code}")
    finally:
        if decoder.poll() is None:
            decoder.terminate()
        if encoder.poll() is None:
            encoder.terminate()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", required=True)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--primary-offset-seconds", required=True, type=float)
    compose(parser.parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
