"""Validate untrusted JSON before passing any mesh buffers to Blender native APIs."""
import math


def finite_tree(value, depth=0):
    if depth > 32:
        raise ValueError('Geometry JSON nesting exceeds limit')
    if isinstance(value, dict):
        if any(not isinstance(k, str) or len(k) > 512 for k in value):
            raise ValueError('Invalid JSON property name')
        for item in value.values():
            finite_tree(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            finite_tree(item, depth + 1)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('Non-finite geometry value')
    elif isinstance(value, str):
        if len(value) > 4096:
            raise ValueError('Geometry string exceeds limit')
    elif value is not None and not isinstance(value, (int, bool)):
        raise ValueError('Non-JSON geometry value')


def validate(spec):
    finite_tree(spec)
    if not isinstance(spec['name'], str) or not spec['name'] or len(spec['name']) > 63:
        raise ValueError('Invalid Blender object name')
    matrix = spec['matrix']
    if len(matrix) != 4 or any(len(row) != 4 or any(type(v) not in {int, float} for v in row) for row in matrix):
        raise ValueError('Expected finite 4x4 world matrix')
    if len(spec['modifiers']) > 16 or len(spec['materials']) > 128:
        raise ValueError('Modifier/material limit exceeded')
    for modifier in spec['modifiers']:
        limits = {'levels': 4, 'render_levels': 4, 'segments': 16, 'octree_depth': 7, 'iterations': 100}
        if any(key in modifier['props'] and modifier['props'][key] > maximum for key, maximum in limits.items()):
            raise ValueError('Modifier resource limit exceeded')
    for material in spec['materials']:
        if material is None:
            continue
        if len(material['nodes']) > 256 or len(material['links']) > 1024:
            raise ValueError('Shader complexity limit exceeded')
        for link in material['links']:
            if len(link) != 4 or any(type(v) is not int or v < 0 for v in link):
                raise ValueError('Invalid shader link')
            if link[0] >= len(material['nodes']) or link[2] >= len(material['nodes']):
                raise ValueError('Invalid shader node index')
    if spec['type'] != 'MESH':
        if spec['mesh'] is not None or spec['materials'] or spec['modifiers']:
            raise ValueError('Empty objects cannot contain mesh data')
        return
    mesh = spec['mesh']
    b = mesh['buffers']
    vertices, edges, loops, polygons = len(b['vertices.co']) // 3, len(b['edges.vertices']) // 2, len(b['loops.vertex_index']), len(b['polygons.loop_total'])
    if vertices > 2_000_000 or edges > 6_000_000 or loops > 8_000_000 or polygons > 2_000_000:
        raise ValueError('Mesh resource limit exceeded')
    if len(b['vertices.co']) != vertices * 3 or len(b['edges.vertices']) != edges * 2 or len(b['loops.edge_index']) != loops:
        raise ValueError('Invalid mesh buffer shape')
    for key in ('polygons.loop_start', 'polygons.material_index', 'polygons.use_smooth'):
        if len(b[key]) != polygons:
            raise ValueError('Invalid polygon buffer length')
    for key, bound in [('edges.vertices', vertices), ('loops.vertex_index', vertices), ('loops.edge_index', edges)]:
        if any(type(v) is not int or not 0 <= v < bound for v in b[key]):
            raise ValueError('Out-of-bounds mesh index')
    offset = 0
    for start, size in zip(b['polygons.loop_start'], b['polygons.loop_total']):
        if type(start) is not int or type(size) is not int or start != offset or size < 3:
            raise ValueError('Invalid polygon loop range')
        offset += size
    if offset != loops:
        raise ValueError('Polygon loops do not cover corner buffer')
    if any(type(v) is not int or not 0 <= v < max(1, len(spec['materials'])) for v in b['polygons.material_index']):
        raise ValueError('Invalid polygon material index')
    counts = {'POINT': vertices, 'EDGE': edges, 'FACE': polygons, 'CORNER': loops}
    if len(mesh['attributes']) > 128:
        raise ValueError('Attribute count limit exceeded')
    names = set()
    for attr in mesh['attributes']:
        if attr['name'] in names or attr['domain'] not in counts or attr['size'] not in (1, 2, 3, 4) or len(attr['values']) != counts[attr['domain']] * attr['size']:
            raise ValueError('Invalid mesh attribute layout')
        names.add(attr['name'])
    if mesh['normals'] is not None and (len(mesh['normals']) != loops or any(len(n) != 3 for n in mesh['normals'])):
        raise ValueError('Invalid split normals')
