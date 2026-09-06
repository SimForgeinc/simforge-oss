"""Inert Blender geometry transfer. Unsupported semantics fail rather than flatten.
No worker blend, Python, drivers, handlers, file paths or custom node classes enter
our renderer. Mesh buffers, built-in shader graphs and geometric modifiers only.
"""
import hashlib
import json
import math
from array import array
from mathutils import Matrix

MODIFIERS = {'BEVEL', 'SOLIDIFY', 'SUBSURF', 'TRIANGULATE', 'DECIMATE', 'WELD', 'WEIGHTED_NORMAL', 'EDGE_SPLIT', 'SMOOTH', 'LAPLACIANSMOOTH', 'REMESH'}
# These use only values, sockets and existing packed images, not external code/files.
NODES = {'ShaderNode' + name for name in '''OutputMaterial BsdfPrincipled BsdfDiffuse BsdfGlossy BsdfGlass BsdfRefraction BsdfTransparent BsdfTranslucent BsdfAnisotropic BsdfToon Emission Background Holdout VolumeAbsorption VolumeScatter VolumePrincipled AddShader MixShader MixRGB Mix Math VectorMath Value RGB Fresnel LayerWeight LightPath NewGeometry TexCoord Mapping Normal NormalMap Bump Displacement VectorDisplacement TexImage TexNoise TexVoronoi TexWave TexChecker TexBrick TexGradient TexWhiteNoise TexMusgrave SeparateXYZ CombineXYZ SeparateRGB CombineRGB SeparateColor CombineColor RGBToBW HueSaturation BrightContrast Gamma Invert Clamp MapRange VectorRotate VectorTransform Wavelength Blackbody UVMap VertexColor Attribute Wireframe Bevel AmbientOcclusion ObjectInfo ParticleInfo HairInfo CameraData Tangent'''.split()}
SKIP = {'rna_type', 'name', 'name_full', 'type', 'is_evaluated', 'original', 'tag', 'users', 'use_fake_user', 'is_embedded_data', 'is_missing', 'is_runtime_data', 'session_uid', 'is_library_indirect', 'asset_data', 'override_library', 'library', 'id_data'}
# Image.pixels is a lazy full-resolution float buffer, not scalar RNA metadata.
SKIP.add('pixels')

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()

def numeric_value(value):
    if isinstance(value, (int, float, bool)):
        return value
    # mathutils sequences expose the sequence protocol without necessarily
    # exposing __iter__; matrices yield nested Vector rows.
    return [numeric_value(component) for component in value]

def props(value):
    result = {}
    for prop in value.bl_rna.properties:
        key = prop.identifier
        if key in SKIP or prop.is_readonly or value.is_property_readonly(key) or prop.type not in {'BOOLEAN', 'INT', 'FLOAT', 'STRING', 'ENUM'}:
            continue
        item = getattr(value, key)
        if prop.type in {'BOOLEAN', 'INT', 'FLOAT'}:
            item = numeric_value(item)
        elif isinstance(item, set):
            item = sorted(item)
        result[key] = item
    return result

def apply_props(value, values):
    if not isinstance(values, dict):
        raise ValueError('Expected RNA property map')
    properties = value.bl_rna.properties
    for key in values:
        prop = properties.get(key)
        if prop is None or key in SKIP or prop.is_readonly or prop.type not in {'BOOLEAN', 'INT', 'FLOAT', 'STRING', 'ENUM'}:
            raise ValueError('Unsupported RNA property: ' + key)
    # Mode flags can make dependent numeric/vector properties writable.
    ordered = sorted(values, key=lambda key: properties[key].type not in {'BOOLEAN', 'ENUM'})
    for key in ordered:
        item = values[key]
        prop = properties[key]
        if value.is_property_readonly(key):
            raise ValueError('RNA property is read-only in this mode: ' + key)
        if prop.type == 'ENUM' and prop.is_enum_flag:
            item = set(item)
        setattr(value, key, item)

def inert(target):
    if target is not None and getattr(target, 'animation_data', None):
        raise ValueError('Animation/drivers cannot cross geometry boundary: ' + target.name)
    if target is not None and getattr(target, 'library', None):
        raise ValueError('Linked libraries cannot cross geometry boundary')

def socket_values(sockets):
    return [list(s.default_value) if hasattr(s.default_value, '__len__') and not isinstance(s.default_value, str) else s.default_value for s in sockets if hasattr(s, 'default_value')]

def tree_data(tree, depth=0):
    if depth > 8:
        raise ValueError('Shader group nesting exceeds eight levels')
    inert(tree)
    result = {'nodes': [], 'links': [], 'interface': []}
    for socket in tree.interface.items_tree:
        if socket.item_type != 'SOCKET':
            raise ValueError('Shader interface panels require a dedicated codec')
        result['interface'].append({'name': socket.name, 'direction': socket.in_out, 'type': socket.socket_type, 'props': props(socket)})
    for node in tree.nodes:
        if node.bl_idname not in NODES | {'ShaderNodeGroup', 'NodeGroupInput', 'NodeGroupOutput', 'NodeReroute', 'NodeFrame'}:
            raise ValueError('Unsupported shader node (not flattened): ' + node.bl_idname)
        image = getattr(node, 'image', None)
        if image is not None and not image.get('wb_image_id'):
            raise ValueError('New image assets require a separate trusted asset import')
        for prop in node.bl_rna.properties:
            if prop.type == 'POINTER' and prop.identifier not in {'rna_type', 'id_data', 'parent', 'image', 'texture_mapping', 'color_mapping', 'image_user', 'node_tree'} and getattr(node, prop.identifier, None) is not None:
                raise ValueError('Unsupported shader structure: ' + prop.identifier)
        structures = {}
        for key in ('texture_mapping', 'color_mapping', 'image_user'):
            target = getattr(node, key, None)
            if target is not None:
                if key == 'color_mapping' and target.use_color_ramp:
                    raise ValueError('Enabled texture color ramps require a dedicated codec')
                structures[key] = props(target)
        group = getattr(node, 'node_tree', None)
        result['nodes'].append({'type': node.bl_idname, 'name': node.name, 'props': props(node), 'structures': structures,
            'image': image.get('wb_image_id') if image else None, 'group': tree_data(group, depth + 1) if group else None,
            'parent': node.parent.name if node.parent else None, 'inputs': socket_values(node.inputs), 'outputs': socket_values(node.outputs)})
    nodes = list(tree.nodes)
    for link in tree.links:
        result['links'].append([nodes.index(link.from_node), list(link.from_node.outputs).index(link.from_socket), nodes.index(link.to_node), list(link.to_node.inputs).index(link.to_socket)])
    return result

def material_data(material):
    if material is None:
        return None
    inert(material)
    result = {'name': material.get('wb_original_name', material.name), 'props': props(material), 'nodes': [], 'links': [], 'interface': []}
    if material.use_nodes:
        result.update(tree_data(material.node_tree))
    return result

def mesh_data(mesh, fingerprint=False):
    inert(mesh)
    if mesh.shape_keys:
        raise ValueError('Shape keys require a dedicated lossless codec')
    result = {'name': mesh.get('wb_original_name', mesh.name), 'props': props(mesh), 'buffers': {}, 'attributes': []}
    for collection, field, size, kind in [('vertices', 'co', 3, 'f'), ('edges', 'vertices', 2, 'i'), ('loops', 'vertex_index', 1, 'i'), ('loops', 'edge_index', 1, 'i'), ('polygons', 'loop_start', 1, 'i'), ('polygons', 'loop_total', 1, 'i'), ('polygons', 'material_index', 1, 'i'), ('polygons', 'use_smooth', 1, 'b')]:
        entries = getattr(mesh, collection)
        values = array(kind, [0]) * (len(entries) * size)
        entries.foreach_get(field, values)
        result['buffers'][collection + '.' + field] = hashlib.sha256(values).hexdigest() if fingerprint else list(values)
    if mesh.has_custom_normals:
        normals = array('f', [0]) * (len(mesh.corner_normals) * 3)
        mesh.corner_normals.foreach_get('vector', normals)
        result['normals'] = hashlib.sha256(normals).hexdigest() if fingerprint else [list(normals[i:i + 3]) for i in range(0, len(normals), 3)]
    else:
        result['normals'] = None
    # Blender's internal topology attributes are represented in the buffers.
    internal = {'position', '.edge_verts', '.corner_vert', '.corner_edge', 'material_index', 'sharp_face', 'custom_normal'}
    kinds = {'FLOAT': ('value', 1), 'INT': ('value', 1), 'BOOLEAN': ('value', 1), 'FLOAT_VECTOR': ('vector', 3), 'FLOAT2': ('vector', 2), 'FLOAT_COLOR': ('color', 4), 'BYTE_COLOR': ('color', 4)}
    for attr in mesh.attributes:
        if attr.name in internal:
            continue
        if attr.data_type not in kinds:
            raise ValueError('Unsupported mesh attribute: ' + attr.data_type)
        field, size = kinds[attr.data_type]
        values = array('i' if attr.data_type in {'INT', 'BOOLEAN'} else 'f', [0]) * (len(attr.data) * size)
        attr.data.foreach_get(field, values)
        result['attributes'].append({'name': attr.name, 'type': attr.data_type, 'domain': attr.domain, 'field': field, 'size': size,
                                     'values': hashlib.sha256(values).hexdigest() if fingerprint else list(values)})
    result['activeUV'] = mesh.uv_layers.active.name if mesh.uv_layers.active else None
    result['renderUV'] = next((u.name for u in mesh.uv_layers if u.active_render), None)
    result['activeColorIndex'] = mesh.color_attributes.active_color_index
    result['renderColorIndex'] = mesh.color_attributes.render_color_index
    return result

OBJECT_RENDER_PROPS = {'color', 'pass_index', 'visible_camera', 'visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_volume_scatter', 'visible_shadow', 'is_holdout', 'is_shadow_catcher', 'hide_viewport', 'display_type'}

def object_data(obj, fingerprint=False, cache=None):
    inert(obj)
    if obj.type not in {'MESH', 'EMPTY'}:
        raise ValueError('Only mesh/empty geometry can be edited')
    if obj.constraints or obj.vertex_groups or obj.instance_type != 'NONE':
        raise ValueError('Constraints, vertex groups and instances require a dedicated codec')
    if any(slot.link != 'DATA' for slot in obj.material_slots):
        raise ValueError('Object-linked material slots require a dedicated codec')
    mods = []
    for modifier in obj.modifiers:
        if modifier.type not in MODIFIERS:
            raise ValueError('Unsupported modifier (not baked/flattened): ' + modifier.type)
        for prop in modifier.bl_rna.properties:
            if prop.type == 'POINTER' and prop.identifier not in {'rna_type', 'id_data'} and getattr(modifier, prop.identifier, None) is not None:
                raise ValueError('Modifier pointer references require a dedicated codec')
        mods.append({'name': modifier.name, 'type': modifier.type, 'props': props(modifier)})
    mesh = None
    if obj.type == 'MESH':
        key = ('mesh', obj.data.as_pointer())
        mesh = cache.get(key) if cache is not None else None
        if mesh is None:
            mesh = mesh_data(obj.data, fingerprint=fingerprint)
            if cache is not None:
                cache[key] = mesh
    materials = []
    for slot in obj.material_slots:
        key = ('material', slot.material.as_pointer() if slot.material else 0)
        material = cache.get(key) if cache is not None else None
        if material is None:
            material = material_data(slot.material)
            if fingerprint:
                material = digest(material)
            if cache is not None:
                cache[key] = material
        materials.append(material)
    return {'id': obj.get('wb_object_id'), 'name': obj.get('wb_original_name', obj.name), 'type': obj.type,
        'parent': obj.parent.get('wb_object_id') if obj.parent else None,
        'matrix': [list(row) for row in obj.matrix_world], 'hideRender': obj.hide_render,
        'renderProps': {key: value for key, value in props(obj).items() if key in OBJECT_RENDER_PROPS},
        'mesh': mesh, 'materials': materials, 'modifiers': mods}

def build_tree(bpy, tree, spec, images, depth=0):
    if depth > 8 or len(spec['nodes']) > 256 or len(spec['links']) > 1024 or len(spec['interface']) > 128:
        raise ValueError('Shader graph complexity limit exceeded')
    tree.nodes.clear()
    for socket in spec['interface']:
        if socket['type'] not in {'NodeSocketFloat', 'NodeSocketInt', 'NodeSocketBool', 'NodeSocketVector', 'NodeSocketColor', 'NodeSocketShader'}:
            raise ValueError('Unsupported shader interface socket')
        item = tree.interface.new_socket(name=socket['name'], in_out=socket['direction'], socket_type=socket['type'])
        apply_props(item, socket['props'])
    nodes = []
    for data in spec['nodes']:
        if data['type'] not in NODES | {'ShaderNodeGroup', 'NodeGroupInput', 'NodeGroupOutput', 'NodeReroute', 'NodeFrame'}:
            raise ValueError('Untrusted shader node type')
        node = tree.nodes.new(data['type'])
        node.name = data['name']
        if data['group'] is not None:
            if data['type'] != 'ShaderNodeGroup':
                raise ValueError('Only shader group nodes may contain a tree')
            node.node_tree = bpy.data.node_groups.new(data['name'], 'ShaderNodeTree')
            build_tree(bpy, node.node_tree, data['group'], images, depth + 1)
        apply_props(node, data['props'])
        for key, values in data['structures'].items():
            if key not in {'texture_mapping', 'color_mapping', 'image_user'} or (key == 'color_mapping' and values.get('use_color_ramp')):
                raise ValueError('Unsupported shader structure')
            apply_props(getattr(node, key), values)
        if data['image'] is not None:
            node.image = images[data['image']]
        for field in ('inputs', 'outputs'):
            sockets = [s for s in getattr(node, field) if hasattr(s, 'default_value')]
            if len(sockets) != len(data[field]):
                raise ValueError('Shader socket shape mismatch')
            for socket, value in zip(sockets, data[field]):
                socket.default_value = value
        nodes.append(node)
    for node, data in zip(nodes, spec['nodes']):
        if data['parent'] is not None:
            parent = tree.nodes.get(data['parent'])
            if parent is None or parent.bl_idname != 'NodeFrame':
                raise ValueError('Invalid shader node parent')
            node.parent = parent
    for a, b, c, d in spec['links']:
        if min(a, b, c, d) < 0:
            raise ValueError('Invalid shader socket index')
        tree.links.new(nodes[a].outputs[b], nodes[c].inputs[d])

def create_material(bpy, spec, images):
    if spec is None:
        return None
    mat = bpy.data.materials.new(spec['name'])
    mat['wb_original_name'] = spec['name']
    apply_props(mat, spec['props'])
    if mat.use_nodes:
        build_tree(bpy, mat.node_tree, spec, images)
    return mat

def create_mesh(bpy, spec, images, materials):
    data = spec['mesh']
    buffers = data['buffers']
    if data is not None:
        mesh = bpy.data.meshes.new(data['name'])
        mesh['wb_original_name'] = data['name']
        apply_props(mesh, data['props'])
        for collection, key, size in [('vertices', 'vertices.co', 3), ('edges', 'edges.vertices', 2), ('loops', 'loops.vertex_index', 1), ('polygons', 'polygons.loop_total', 1)]:
            getattr(mesh, collection).add(len(buffers[key]) // size)
        expected = {'vertices.co', 'edges.vertices', 'loops.vertex_index', 'loops.edge_index', 'polygons.loop_start', 'polygons.loop_total', 'polygons.material_index', 'polygons.use_smooth'}
        if set(buffers) != expected:
            raise ValueError('Invalid mesh buffer fields')
        for key, values in buffers.items():
            collection, field = key.split('.')
            getattr(mesh, collection).foreach_set(field, values)
        if mesh.validate(verbose=False, clean_customdata=False):
            raise ValueError('Invalid mesh topology rejected')
        kinds = {'FLOAT': ('value', 1), 'INT': ('value', 1), 'BOOLEAN': ('value', 1), 'FLOAT_VECTOR': ('vector', 3), 'FLOAT2': ('vector', 2), 'FLOAT_COLOR': ('color', 4), 'BYTE_COLOR': ('color', 4)}
        for attr in data['attributes']:
            if (attr['field'], attr['size']) != kinds.get(attr['type']):
                raise ValueError('Invalid attribute field')
            item = mesh.attributes.get(attr['name']) or mesh.attributes.new(attr['name'], attr['type'], attr['domain'])
            item.data.foreach_set(attr['field'], attr['values'])
        if data['activeUV']:
            mesh.uv_layers.active = mesh.uv_layers[data['activeUV']]
        if data['renderUV']:
            mesh.uv_layers[data['renderUV']].active_render = True
        if data['activeColorIndex'] >= 0:
            mesh.color_attributes.active_color_index = data['activeColorIndex']
        if data['renderColorIndex'] >= 0:
            mesh.color_attributes.render_color_index = data['renderColorIndex']
        mesh.update()
        if data['normals'] is not None:
            mesh.normals_split_custom_set(data['normals'])
        for material in spec['materials']:
            key = digest(material)
            if key not in materials:
                materials[key] = create_material(bpy, material, images)
            mesh.materials.append(materials[key])
        return mesh
    return None

def create_object(bpy, spec, images, meshes, materials):
    if spec['type'] not in {'MESH', 'EMPTY'}:
        raise ValueError('Invalid geometry object type')
    mesh = None
    if spec['type'] == 'MESH':
        key = digest([spec['mesh'], spec['materials']])
        if key not in meshes:
            meshes[key] = create_mesh(bpy, spec, images, materials)
        mesh = meshes[key]
    obj = bpy.data.objects.new(spec['name'], mesh)
    obj['wb_object_id'] = spec['id']
    obj['wb_original_name'] = spec['name']
    obj.matrix_world = Matrix(spec['matrix'])
    obj.hide_render = spec['hideRender']
    if set(spec['renderProps']) - OBJECT_RENDER_PROPS:
        raise ValueError('Unsupported object render property')
    apply_props(obj, spec['renderProps'])
    for modifier in spec['modifiers']:
        if modifier['type'] not in MODIFIERS:
            raise ValueError('Untrusted modifier type')
        apply_props(obj.modifiers.new(modifier['name'], modifier['type']), modifier['props'])
    return obj
