"""Immutable fork metadata consumed before native assembly, never mutating the USDZ.

Masks select Gaussian CENTERS in source-world z-up axis-aligned boxes, inclusive
boundaries. Contributions from centers outside a box may overlap it. This is not
support-footprint clipping, recovered geometry, road truth or qualification.
"""
from pathlib import Path
import hashlib
import json
import numpy as np
import torch


def rigid_transform(value):
    m = np.asarray(value, dtype=np.float64)
    if (m.shape != (4, 4) or not np.isfinite(m).all()
            or not np.allclose(m[3], [0, 0, 0, 1], atol=1e-8)
            or not np.allclose(m[:3, :3].T @ m[:3, :3], np.eye(3), atol=1e-6)
            or not np.isclose(np.linalg.det(m[:3, :3]), 1, atol=1e-6)):
        raise ValueError("source patch transform must be a proper rigid 4x4")
    return m


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load_source_patch(scene, background, root, device):
    patch = background.get('sourcePatch')
    if not patch:
        return {}, []
    if patch.get('schema') != 'simforge.nurec-source-patch/v1' or patch.get('upstream') != 'a435e9ccd72a934333b17e70d913a664e80e0820':
        raise ValueError('unknown source patch schema or backend revision')
    root = Path(root).resolve()
    for name, digest in patch['bundleDigests'].items():
        path = (root / name).resolve()
        if not path.is_relative_to(root) or file_digest(path) != digest:
            raise ValueError(f'fork artifact changed: {name}')
    cache = {}
    original_path = root / 'source-background.json'
    original = json.loads(original_path.read_text())
    provenance = json.loads((root / 'import-provenance.json').read_text())
    if file_digest(original_path) != patch['baseBackgroundSha256'] or patch['baseBackgroundSha256'] != provenance['outputDigests']['background.json']['sha256']:
        raise ValueError('fork base background changed')
    unchanged = {key: value for key, value in background.items() if key != 'sourcePatch'}
    unchanged['actorTracks'] = original['actorTracks']
    if unchanged != original:
        raise ValueError('fork altered capture, calibration, or background identity')

    def mesh(spec, key):
        path = (root / spec['path']).resolve()
        from .render.actors import load_glb
        if not path.is_relative_to(root) or spec.get('frame') != 'simforge-y-up':
            raise ValueError('explicit GLB must be inside fork and y-up metres')
        if file_digest(path) != spec['sha256']:
            raise ValueError(f'authored mesh changed: {path}')
        if path not in cache:
            cache[path] = load_glb(path, key, device)
        return cache[path], rigid_transform(spec['transformSource']), None, key

    actor_meshes = {aid: mesh(spec, aid) for aid, spec in patch.get('meshes', {}).items()}
    replacements = []
    masks = {}
    scene.source_patch_regions = []
    n2w = torch.from_numpy(np.linalg.inv(scene.world_to_nre).astype(np.float32)).to(device)
    for region in patch.get('regions', []):
        if region.get('frame') != 'source-world-z-up' or region.get('selection') != 'gaussian-center':
            raise ValueError('only source-world Gaussian-center masks are supported')
        low, high = np.asarray(region['min']), np.asarray(region['max'])
        if low.shape != (3,) or high.shape != (3,) or not np.isfinite([low, high]).all() or not (low < high).all():
            raise ValueError('invalid source region bounds')
        lo = torch.as_tensor(low, dtype=torch.float32, device=device)
        hi = torch.as_tensor(high, dtype=torch.float32, device=device)
        if not region.get('layers') or not region.get('replacements'):
            raise ValueError('region needs explicit static layers and authored replacements')
        selected_count = 0
        for name in region['layers']:
            layer = scene.layers.get(name)
            if layer is None or layer.cuboid_ids is not None:
                raise ValueError(f'region targets missing/non-static Gaussian layer: {name}')
            pos = layer.positions @ n2w[:3, :3].T + n2w[:3, 3]
            selected = ((pos >= lo) & (pos <= hi)).all(dim=1)
            selected_count += int(selected.sum().item())
            masks[name] = masks[name] | selected if name in masks else selected
        if selected_count == 0:
            raise ValueError(f"unsupported_nurec_region: {region['id']!r} selects no static Gaussian centers; refusing mesh-only replacement")
        scene.source_patch_regions.append({'id': region['id'], 'selectedGaussians': selected_count,
                                           'selection': 'gaussian-center', 'qualification': 'not-run'})
        replacements.extend(mesh(spec, f"region:{region['id']}:{i}") for i, spec in enumerate(region['replacements']))
    # Filter all aligned properties ONCE, before SplatRenderer builds packed buffers.
    for name, selected in masks.items():
        layer = scene.layers[name]
        keep = ~selected
        for field in ('positions', 'rotations', 'scales', 'densities', 'albedo', 'specular'):
            setattr(layer, field, getattr(layer, field)[keep].contiguous())
    return actor_meshes, replacements
