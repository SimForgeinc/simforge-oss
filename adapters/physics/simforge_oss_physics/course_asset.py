"""Portable render resource for the workload course, derived from the same
geometry the MJCF is generated from.

``build_course_glb`` writes a self-contained glTF 2.0 binary (no external
textures, no dependencies beyond numpy) with one node per static collision
geom: ``ground`` (finite slab standing in for MuJoCo's infinite plane),
``ramp`` and ``sidewalk`` (the plateau). Node names become the renderer's
instance-ID legend names. Vertex data is in the y-up scene frame
(``scene = (x, z, -y)`` of the MuJoCo world frame) so the GLB, the exported
scene-state actors and the native renderer share one frame with no runtime
transform.

``write_course_resources`` persists the GLB content-addressed
(``course/<sha256>.glb``) with a manifest that binds it to the workload
digest, and ``render_scene_spec`` produces the renderer service's prewarm
``SceneSpec`` document (``renderer/service/src/server.rs``) with absolute GLB
paths resolved against the resource directory.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
from pathlib import Path
from typing import Any

import numpy as np

from .profile import PROFILE_ID
from .workload import CourseSpec, Workload, ramp_slab_pose

COURSE_MANIFEST_SCHEMA = "simforge.physics-course-resource/v1"

#: Half-extent of the finite ground slab standing in for MuJoCo's infinite
#: plane, measured from the course centre along +-x and +-z (scene frame).
GROUND_HALF_EXTENT_M = 30.0
#: Thickness of the ground slab below y = 0.
GROUND_THICKNESS_M = 0.2


def _quat_rotate(q_wxyz: np.ndarray, v: np.ndarray) -> np.ndarray:
    w, x, y, z = q_wxyz
    r = np.array([x, y, z])
    return v + 2.0 * np.cross(r, np.cross(r, v) + w * v)


def _box_mesh(half: np.ndarray, center: np.ndarray, quat_wxyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Box in the MuJoCo frame -> (positions, normals, indices) in the scene
    frame, 24 vertices with per-face normals, CCW winding facing outward."""
    faces = (
        (np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0]), np.array([0.0, 0.0, 1.0])),
        (np.array([-1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0]), np.array([0.0, 1.0, 0.0])),
        (np.array([0.0, 1.0, 0.0]), np.array([0.0, 0.0, 1.0]), np.array([1.0, 0.0, 0.0])),
        (np.array([0.0, -1.0, 0.0]), np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0])),
        (np.array([0.0, 0.0, 1.0]), np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0])),
        (np.array([0.0, 0.0, -1.0]), np.array([0.0, 1.0, 0.0]), np.array([1.0, 0.0, 0.0])),
    )
    positions, normals, indices = [], [], []
    for n, u, v in faces:
        base = len(positions)
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            local = (n + su * u + sv * v) * half
            positions.append(center + _quat_rotate(quat_wxyz, local))
            normals.append(_quat_rotate(quat_wxyz, n))
        indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    pos = np.array(positions)
    nrm = np.array(normals)
    to_scene = lambda a: np.stack([a[:, 0], a[:, 2], -a[:, 1]], axis=1)  # noqa: E731
    return to_scene(pos).astype(np.float32), to_scene(nrm).astype(np.float32), np.array(indices, dtype=np.uint32)


def course_meshes(course: CourseSpec) -> list[tuple[str, np.ndarray, np.ndarray, np.ndarray, tuple[float, float, float]]]:
    """(name, positions, normals, indices, base colour) for each static geom
    in the same poses ``build_mjcf`` uses."""
    ramp_half, ramp_center, ramp_quat = ramp_slab_pose(course)
    plateau_half = np.array([course.plateau_length_m / 2.0, course.half_width_m, course.ramp_rise_m / 2.0])
    plateau_center = np.array([(course.ramp_end_x_m + course.curb_x_m) / 2.0, 0.0, course.ramp_rise_m / 2.0])
    ground_center = np.array([course.goal_x_m / 2.0, 0.0, -GROUND_THICKNESS_M / 2.0])
    ground_half = np.array([GROUND_HALF_EXTENT_M, GROUND_HALF_EXTENT_M, GROUND_THICKNESS_M / 2.0])
    identity = np.array([1.0, 0.0, 0.0, 0.0])
    # Node names double as legend names; the renderer's semantic taxonomy
    # classes "ground"/"sidewalk"/"road" substrings as drivable ROAD surface.
    return [
        ("ground", *_box_mesh(ground_half, ground_center, identity), (0.55, 0.55, 0.55)),
        ("ramp_road", *_box_mesh(ramp_half, ramp_center, ramp_quat), (0.70, 0.70, 0.65)),
        ("sidewalk", *_box_mesh(plateau_half, plateau_center, identity), (0.70, 0.70, 0.65)),
    ]


def _pad4(data: bytes, fill: bytes) -> bytes:
    return data + fill * ((4 - len(data) % 4) % 4)


def build_course_glb(workload: Workload) -> bytes:
    """Deterministic glTF 2.0 binary of the course. Byte-identical for a spec."""
    buffer = bytearray()
    buffer_views: list[dict[str, Any]] = []
    accessors: list[dict[str, Any]] = []
    meshes: list[dict[str, Any]] = []
    nodes: list[dict[str, Any]] = []
    materials: list[dict[str, Any]] = []

    def add_view(data: bytes, target: int) -> int:
        while len(buffer) % 4:
            buffer.append(0)
        buffer_views.append({"buffer": 0, "byteOffset": len(buffer), "byteLength": len(data), "target": target})
        buffer.extend(data)
        return len(buffer_views) - 1

    def add_accessor(view: int, count: int, component_type: int, kind: str, arr: np.ndarray) -> int:
        acc: dict[str, Any] = {"bufferView": view, "componentType": component_type, "count": count, "type": kind}
        if kind == "VEC3":
            acc["min"] = [float(v) for v in arr.min(axis=0)]
            acc["max"] = [float(v) for v in arr.max(axis=0)]
        else:
            acc["min"] = [int(arr.min())]
            acc["max"] = [int(arr.max())]
        accessors.append(acc)
        return len(accessors) - 1

    for index, (name, positions, normals, indices, color) in enumerate(course_meshes(workload.spec.course)):
        pos_acc = add_accessor(add_view(positions.tobytes(), 34962), len(positions), 5126, "VEC3", positions)
        nrm_acc = add_accessor(add_view(normals.tobytes(), 34962), len(normals), 5126, "VEC3", normals)
        idx_acc = add_accessor(add_view(indices.tobytes(), 34963), len(indices), 5125, "SCALAR", indices)
        materials.append(
            {
                "name": f"{name}_material",
                "pbrMetallicRoughness": {"baseColorFactor": [*color, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.9},
            }
        )
        meshes.append(
            {
                "name": name,
                "primitives": [
                    {"attributes": {"POSITION": pos_acc, "NORMAL": nrm_acc}, "indices": idx_acc, "material": index, "mode": 4}
                ],
            }
        )
        nodes.append({"name": name, "mesh": index})

    gltf = {
        "asset": {
            "version": "2.0",
            "generator": "simforge-oss-physics course_asset",
            "extras": {
                "profile": PROFILE_ID,
                "workloadId": workload.id,
                "workloadDigest": workload.digest,
                "frame": "scene-yup",
                "units": "m",
            },
        },
        "scene": 0,
        "scenes": [{"name": workload.map_id, "nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(buffer)}],
    }
    json_chunk = _pad4(json.dumps(gltf, sort_keys=True, separators=(",", ":")).encode(), b" ")
    bin_chunk = _pad4(bytes(buffer), b"\0")
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    return b"".join(
        [
            struct.pack("<4sII", b"glTF", 2, total),
            struct.pack("<II", len(json_chunk), 0x4E4F534A),
            json_chunk,
            struct.pack("<II", len(bin_chunk), 0x004E4942),
            bin_chunk,
        ]
    )


def write_course_resources(workload: Workload, resource_dir: Path) -> dict[str, Any]:
    """Persist ``course/<sha256>.glb`` and ``course/manifest.json`` under
    ``resource_dir``; returns the manifest. Paths in the manifest are relative
    to ``resource_dir`` so job outputs move between machines."""
    course_dir = resource_dir / "course"
    course_dir.mkdir(parents=True, exist_ok=True)
    glb = build_course_glb(workload)
    digest = hashlib.sha256(glb).hexdigest()
    glb_rel = f"course/{digest}.glb"
    glb_path = resource_dir / glb_rel
    if not glb_path.exists():
        tmp = glb_path.with_suffix(".glb.tmp")
        tmp.write_bytes(glb)
        tmp.replace(glb_path)
    course = workload.spec.course
    manifest = {
        "schema": COURSE_MANIFEST_SCHEMA,
        "profile": PROFILE_ID,
        "mapId": workload.map_id,
        "workloadId": workload.id,
        "workloadDigest": workload.digest,
        "frame": "scene-yup",
        "files": [{"path": glb_rel, "kind": "glb", "sha256": digest, "bytes": len(glb)}],
        "meshes": [name for name, *_ in course_meshes(course)],
        "geometry": {
            "rampStartXM": course.ramp_start_x_m,
            "rampEndXM": course.ramp_end_x_m,
            "curbXM": course.curb_x_m,
            "goalXM": course.goal_x_m,
            "rampRiseM": course.ramp_rise_m,
            "inclineRad": course.incline_rad,
            "halfWidthM": course.half_width_m,
            "groundHalfExtentM": GROUND_HALF_EXTENT_M,
        },
    }
    manifest_path = course_dir / "manifest.json"
    tmp = manifest_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    tmp.replace(manifest_path)
    return manifest


def render_scene_spec(manifest: dict[str, Any], resource_dir: Path, *, profile: str = "sensor") -> dict[str, Any]:
    """Renderer service prewarm ``SceneSpec`` (camelCase, absolute GLB paths)
    for the course. Lighting is left to the renderer's declared defaults; the
    exported scene-state carries weather/timeOfDay per tick."""
    if manifest.get("schema") != COURSE_MANIFEST_SCHEMA:
        raise ValueError(f"not a course manifest: {manifest.get('schema')!r}")
    glbs = [str((resource_dir / f["path"]).resolve()) for f in manifest["files"] if f["kind"] == "glb"]
    goal = manifest["geometry"]["goalXM"]
    return {
        "glbs": glbs,
        "profile": profile,
        "nearM": 0.05,
        "farM": float(math.ceil(goal + 2.0 * GROUND_HALF_EXTENT_M)),
        "warmupFrames": 10,
    }
