"""Real single-frame BEV inference over the planner's resident VLM and images."""
from __future__ import annotations

import hashlib
from typing import Any, Mapping

import numpy as np
from PIL import Image

from .scene import CAMERA_IDS, CAMERA_SENSOR_IDS, CAMERA_VIEWS, SceneInputError, _camera_entries, _numeric_array


class LivePerceptionFrame:
    """The upstream processor's frame interface, without disk I/O or GT inputs."""

    def __init__(self, scene: Any, observation: Mapping[str, Any]) -> None:
        from qwen_drive_perception import geometry

        self.cam_order = list(CAMERA_SENSOR_IDS)
        self.content = []
        self.images = {}
        self.projections = []
        self.input_digests = []
        by_id = _camera_entries(observation)
        for camera_id, sensor, view in zip(CAMERA_IDS, CAMERA_SENSOR_IDS, CAMERA_VIEWS):
            # These are the exact current PIL images already decoded for planning.
            image = scene.views[view][-1].image
            if not isinstance(image, Image.Image):
                raise SceneInputError("live perception requires decoded planner images")
            self.images[sensor] = image
            self.content.extend([{"text": view}, {"image": sensor}])
            entry = by_id[camera_id]
            self.input_digests.append({
                "cameraId": camera_id, "encoding": entry.get("encoding", "raw"),
                "sha256": hashlib.sha256(entry["frames"][-1]).hexdigest(),
            })
            calibration = by_id[camera_id].get("calibration")
            if not isinstance(calibration, Mapping):
                raise SceneInputError(f"--bev requires camera {camera_id} calibration")
            intrinsic = _numeric_array(calibration.get("intrinsic"), "camera intrinsic")
            camera_to_ego = _numeric_array(calibration.get("camera_to_ego"), "camera_to_ego")
            if intrinsic.shape != (3, 3) or camera_to_ego.shape != (4, 4):
                raise SceneInputError("calibration requires 3x3 intrinsic and 4x4 camera_to_ego")
            self.projections.append(geometry.build_lidar2img(
                intrinsic, camera_to_ego[:3, :3], camera_to_ego[:3, 3],
            ))
        self.content.append({"text": "Analyze the scene."})

    def image(self, camera: str) -> Image.Image:
        return self.images[camera]

    def img_metas(self, image_size=(896, 512)) -> dict[str, Any]:
        from qwen_drive_perception.geometry import apply_image_scale

        width, height = image_size
        return {
            "sample_token": "simforge-live",
            # Select the upstream 80x80x6.4m occupancy range, not a claim that
            # this three-camera renderer rig is a nuScenes training example.
            "dataset_type": "nuscenes",
            "cam_order": self.cam_order,
            "lidar2img": np.stack([
                apply_image_scale(projection, width / image.width, height / image.height)
                for projection, image in zip(self.projections, self.images.values())
            ]).astype(np.float32),
            # No lidar input is consumed. Use the ego origin as the head's
            # reference frame, so returned detections are already ego-frame.
            "lidar2ego": np.repeat(np.eye(4, dtype=np.float32)[None], len(self.cam_order), axis=0),
            "img_shape": [(height, width)] * len(self.cam_order),
            "box_coord_system": "ego",
        }


def encode_grid(labels: np.ndarray, extent: tuple[float, float, float, float], classes: tuple[str, ...], palette: tuple) -> dict[str, Any]:
    """RLE a nearest-sampled uint8 raster; top is +X, left is +Y."""
    height, width = labels.shape
    scale = min(1.0, 128 / max(height, width))
    small = np.asarray(Image.fromarray(labels.astype(np.uint8, copy=False)).resize(
        (max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.NEAREST,
    ))
    flat = small.ravel()
    starts = np.r_[0, np.flatnonzero(flat[1:] != flat[:-1]) + 1]
    lengths = np.diff(np.r_[starts, flat.size])
    runs = np.column_stack((flat[starts], lengths)).ravel().tolist()
    xmin, ymin, xmax, ymax = extent
    return {
        "encoding": "rle-u8", "width": small.shape[1], "height": small.shape[0],
        "extentM": list(extent),
        "resolutionM": [(xmax - xmin) / small.shape[0], (ymax - ymin) / small.shape[1]],
        "classes": list(classes), "palette": ["#%02x%02x%02x" % tuple(color) for color in palette],
        "data": runs,
    }


def compact_bev(result: Mapping[str, Any]) -> dict[str, Any]:
    from qwen_drive_perception.configuration_perception import (
        DET_CLASS_NAMES, MAP_CLASS_NAMES, MAP_PALETTE, MAP_XBOUND, MAP_YBOUND,
        NUSCENES_OCC_PC_RANGE, OCC_CLASS_NAMES, OCC_PALETTE,
    )

    occupancy = np.asarray(result["occ"], dtype=np.uint8)
    if occupancy.ndim != 3:
        raise ValueError(f"unexpected occupancy shape {occupancy.shape}")
    # Highest semantic (non-background, non-empty) voxel wins. Background is
    # retained only in pillars with no semantic voxel; empty remains empty.
    z = np.arange(occupancy.shape[2])[None, None, :]
    semantic_z = np.where(occupancy < 8, z, -1).max(axis=2)
    nonempty_z = np.where(occupancy != 9, z, -1).max(axis=2)
    selected_z = np.maximum(0, np.where(semantic_z >= 0, semantic_z, nonempty_z))
    projected = np.take_along_axis(occupancy, selected_z[..., None], axis=2)[..., 0]
    pc = NUSCENES_OCC_PC_RANGE
    boxes = []
    for box, score, label in zip(result["boxes"], result["scores"], result["labels"]):
        if not np.isfinite(box).all() or not np.isfinite(score):
            raise ValueError("perception returned a non-finite detection")
        if score >= 0.25:
            # Upstream calls the heading-aligned extent w; our wire calls it l.
            boxes.append([float(box[0]), float(box[1]), float(box[6]), float(box[3]), float(box[4]), int(label), float(score)])
    return {
        "schema": "simforge.bev/v1", "source": "Qwen-Drive perception", "frame": "ego-x-forward-y-left",
        "coverage": "3 front cameras; out-of-training rig; rear unobserved",
        "cameraIds": list(CAMERA_IDS), "inputFrame": "current-planner-frames",
        "viewExtentM": [0, -20, 40, 20],
        "map": encode_grid(np.asarray(result["map"]).T[::-1, ::-1],
            (MAP_XBOUND[0], MAP_YBOUND[0], MAP_XBOUND[1], MAP_YBOUND[1]), MAP_CLASS_NAMES, MAP_PALETTE),
        "occupancy": encode_grid(projected[::-1, ::-1], (pc[0], pc[1], pc[3], pc[4]), OCC_CLASS_NAMES, OCC_PALETTE),
        "occupancyProjection": "highest semantic voxel, else highest background, else empty; nearest downsample",
        "detections": boxes, "detectionClasses": list(DET_CLASS_NAMES), "scoreThreshold": 0.25,
    }


class QwenPerception:
    def __init__(self, planner: Any, model_dir: Any, device: str) -> None:
        import torch
        from qwen_drive_perception import QwenDrivePerception
        from qwen_drive_perception.dataset import PerceptionProcessor

        self.processor = PerceptionProcessor(planner.processor.tokenizer)
        # Move only the bf16 head before attaching: .to() after attach would
        # recursively convert the shared NF4 backbone as well.
        self.head = QwenDrivePerception.from_pretrained(str(model_dir / "perception"), dtype=torch.bfloat16)
        self.head.to(device).eval()
        self.head.attach(planner.vlm, self.processor)
        self.device = device

    def infer(self, scene: Any, observation: Mapping[str, Any]) -> dict[str, Any]:
        frame = LivePerceptionFrame(scene, observation)
        inputs, metadata = self.processor(frame, device=self.device)
        # Upstream asks the generative VLM for every vocabulary logit and every
        # decoder state, but consumes only the final state. Avoid retaining
        # those unused tensors through the ~3 GiB voxel-pooling peak. These
        # scoped hooks do not alter features, head precision, grids or planning.
        def last_logit_only(_module, args, kwargs):
            return args, {**kwargs, "logits_to_keep": 1}

        def final_state_only(_module, _args, output):
            output.logits = None
            output.hidden_states = (output.hidden_states[-1],)
            return output

        vlm = self.head._vlm
        before = vlm.register_forward_pre_hook(last_logit_only, with_kwargs=True)
        after = vlm.register_forward_hook(final_state_only)
        try:
            bev = compact_bev(self.head.infer(inputs, metadata))
        finally:
            after.remove()
            before.remove()
        bev["inputFrameDigests"] = frame.input_digests
        return bev
