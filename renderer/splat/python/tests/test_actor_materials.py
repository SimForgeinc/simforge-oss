"""Real GLBs retain linear base colours at the native shading boundary."""
import pathlib
import sys

import numpy as np
import torch
import trimesh
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from simforge_splat.render.actors import load_glb  # noqa: E402


def loaded_colors(tmp_path, visual):
    mesh = trimesh.creation.box()
    mesh.visual = visual(mesh)
    file = tmp_path / 'source.glb'
    file.write_bytes(trimesh.exchange.gltf.export_glb(trimesh.Scene(mesh)))
    return load_glb(file, 'source-colour', torch.device('cpu')).colors.numpy()


def test_vertex_colors_are_not_grey_substitutes_or_srgb_decoded(tmp_path):
    rgba = [204, 51, 26, 255]
    colors = loaded_colors(tmp_path, lambda mesh: trimesh.visual.ColorVisuals(
        mesh=mesh, vertex_colors=np.tile(rgba, (len(mesh.vertices), 1))))
    np.testing.assert_allclose(colors, np.broadcast_to(np.array(rgba[:3]) / 255, colors.shape), atol=1e-6)


def test_constant_linear_pbr_factor_is_not_grey_substituted(tmp_path):
    colors = loaded_colors(tmp_path, lambda mesh: trimesh.visual.TextureVisuals(
        uv=np.zeros((len(mesh.vertices), 2)),
        material=trimesh.visual.material.PBRMaterial(baseColorFactor=[0.8, 0.2, 0.1, 1.0])))
    np.testing.assert_allclose(colors, np.broadcast_to([0.8, 0.2, 0.1], colors.shape), atol=1 / 255)


def test_texture_srgb_is_decoded_before_linear_factor(tmp_path):
    colors = loaded_colors(tmp_path, lambda mesh: trimesh.visual.TextureVisuals(
        uv=np.zeros((len(mesh.vertices), 2)),
        material=trimesh.visual.material.PBRMaterial(
            baseColorTexture=Image.new('RGB', (1, 1), (128, 64, 32)),
            baseColorFactor=[0.5, 1.0, 0.25, 1.0])))
    srgb = np.array([128, 64, 32]) / 255
    linear = ((srgb + 0.055) / 1.055) ** 2.4
    expected = linear * np.array([128, 255, 64]) / 255
    np.testing.assert_allclose(colors, np.broadcast_to(expected, colors.shape), atol=1e-6)
