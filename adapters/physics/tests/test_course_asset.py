import json
import struct

import numpy as np
import pytest

pytest.importorskip("mujoco")

from simforge_oss_physics import MuJoCoCpuSession, Workload
from simforge_oss_physics.course_asset import (
    COURSE_MANIFEST_SCHEMA,
    build_course_glb,
    course_meshes,
    render_scene_spec,
    write_course_resources,
)
from simforge_oss_physics.scene_state import to_service_states


def parse_glb(data: bytes) -> tuple[dict, bytes]:
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF" and version == 2 and length == len(data)
    json_len, json_type = struct.unpack_from("<II", data, 12)
    assert json_type == 0x4E4F534A
    gltf = json.loads(data[20 : 20 + json_len])
    bin_len, bin_type = struct.unpack_from("<II", data, 20 + json_len)
    assert bin_type == 0x004E4942
    return gltf, data[28 + json_len : 28 + json_len + bin_len]


def test_course_glb_is_valid_deterministic_and_bound_to_workload():
    w = Workload()
    a, b = build_course_glb(w), build_course_glb(w)
    assert a == b
    gltf, blob = parse_glb(a)
    assert gltf["asset"]["extras"]["workloadDigest"] == w.digest
    assert [n["name"] for n in gltf["nodes"]] == ["ground", "ramp_road", "sidewalk"]
    assert gltf["buffers"][0]["byteLength"] == len(blob)
    for acc in gltf["accessors"]:
        view = gltf["bufferViews"][acc["bufferView"]]
        size = {5126: 4, 5125: 4}[acc["componentType"]] * (3 if acc["type"] == "VEC3" else 1)
        assert view["byteLength"] == acc["count"] * size


def test_course_mesh_surfaces_match_analytic_course_heights_in_scene_frame():
    w = Workload()
    course = w.spec.course
    meshes = {name: (pos, nrm) for name, pos, nrm, _idx, _c in course_meshes(course)}
    # Top faces (scene +y normal) sit at the analytic surface height for their x.
    for name in ("ground", "ramp_road", "sidewalk"):
        pos, nrm = meshes[name]
        top = pos[nrm[:, 1] > 0.5]
        assert len(top) == 4
        for x, y, _z in top:
            if name == "ground":
                assert y == pytest.approx(0.0, abs=1e-6)
            else:
                assert y == pytest.approx(course.surface_height_m(float(x) - 1e-9 if name == "sidewalk" else float(x)), abs=1e-5)
    # Ramp top spans exactly ramp_start..ramp_end in x and +-half_width in scene z.
    ramp_top = meshes["ramp_road"][0][meshes["ramp_road"][1][:, 1] > 0.5]
    assert ramp_top[:, 0].min() == pytest.approx(course.ramp_start_x_m, abs=1e-5)
    assert ramp_top[:, 0].max() == pytest.approx(course.ramp_end_x_m, abs=1e-5)
    assert np.abs(ramp_top[:, 2]).max() == pytest.approx(course.half_width_m, abs=1e-5)


def test_resources_are_content_addressed_and_scene_spec_resolves(tmp_path):
    w = Workload()
    manifest = write_course_resources(w, tmp_path)
    assert manifest["schema"] == COURSE_MANIFEST_SCHEMA and manifest["mapId"] == w.map_id
    (entry,) = manifest["files"]
    path = tmp_path / entry["path"]
    assert path.name == f"{entry['sha256']}.glb" and path.stat().st_size == entry["bytes"]
    again = write_course_resources(w, tmp_path)
    assert again == manifest
    spec = render_scene_spec(manifest, tmp_path)
    assert spec["glbs"] == [str(path.resolve())] and spec["profile"] == "sensor"
    assert spec["farM"] > manifest["geometry"]["goalXM"]


def test_service_stream_preserves_full_pose_and_descriptors():
    s = MuJoCoCpuSession()
    s.reset(0)
    s.step(np.array([1.0, 1.0, 1.0, 1.0]))
    doc = s.export_scene_state()
    states = to_service_states(doc)
    assert len(states) == doc["tickCount"]
    first = states[1]["actors"][0]
    src = doc["frames"][1]["actors"][0]
    assert first["catalogId"] == "robot.delivery-4w" and first["dims"] == doc["actors"][0]["dims"]
    assert first["transform"] == {"position": src["position"], "rotation": src["rotation"]}
    assert states[1]["tick"] == 1 and states[1]["mapId"] == doc["mapId"] and states[1]["groundY"] is None
