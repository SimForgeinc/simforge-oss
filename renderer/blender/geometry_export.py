"""Trusted promotion of current addition-only previews; never executes agent code."""
import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse

from geometry_data import digest, object_data
from geometry_jobs import sha


def unsupported(reason):
    raise ValueError('export-geometry capability: ' + reason)


def artifact(binding, root):
    uri = urlparse(binding['uri'])
    if uri.scheme != 'file' or uri.netloc:
        unsupported('job evidence must be a local trusted artifact')
    path = Path(unquote(uri.path))
    if path.is_symlink() or path.resolve().parent != root.resolve() or sha(path) != binding['sha256']:
        unsupported('job artifact identity no longer matches the trusted ledger')
    return json.loads(path.read_text())


def material_supported(material, default):
    if material is None or not material.use_nodes or material.animation_data or material.node_tree.animation_data:
        unsupported('every face requires an unanimated opaque constant Principled material')
    nodes = list(material.node_tree.nodes)
    shaders = [node for node in nodes if node.bl_idname == 'ShaderNodeBsdfPrincipled']
    outputs = [node for node in nodes if node.bl_idname == 'ShaderNodeOutputMaterial']
    if len(nodes) != 2 or len(shaders) != 1 or len(outputs) != 1:
        unsupported('only a single constant Principled BSDF connected directly to Material Output is supported; textures/procedural/volume shaders remain visual-only')
    shader, output = shaders[0], outputs[0]
    links = list(material.node_tree.links)
    if len(links) != 1 or links[0].from_node != shader or links[0].to_node != output or links[0].to_socket.name != 'Surface' or shader.mute or output.mute:
        unsupported('material surface must be the direct, unmuted Principled BSDF')
    if material.use_backface_culling or getattr(material, 'use_screen_refraction', False):
        unsupported('backface-culling/refraction render overrides are unsupported')
    if len(shader.inputs) != len(default.inputs):
        unsupported('Principled interface differs from the native exporter reference')
    for index, socket in enumerate(shader.inputs):
        if not hasattr(socket, 'default_value'):
            continue
        value = socket.default_value
        value = list(value) if hasattr(value, '__len__') else value
        if socket.identifier in {'Base Color', 'Metallic', 'Roughness'}:
            values = value if isinstance(value, list) else [value]
            if any(not math.isfinite(v) or not 0 <= v <= 1 for v in values):
                unsupported('PBR constants must be finite values in [0,1]')
            if socket.identifier == 'Base Color' and value[3] != 1:
                unsupported('transparent material base color is unsupported')
        else:
            expected = default.inputs[index]
            if socket.identifier != expected.identifier:
                unsupported('Principled socket identity differs from the native reference')
            reference = expected.default_value
            reference = list(reference) if hasattr(reference, '__len__') else reference
            if value != reference:
                unsupported('non-default Principled input is unsupported: ' + socket.identifier)


def publish(path, data):
    """Never overwrite an existing content-addressed artifact."""
    if path.exists():
        if path.read_bytes() != data:
            unsupported('content-addressed destination has different bytes')
        return
    fd, temporary = tempfile.mkstemp(prefix='.geometry-publish-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if path.read_bytes() != data:
                unsupported('content-addressed destination changed during publication')
    finally:
        os.unlink(temporary)


def export_geometry(workbench, payload):
    job_id = payload.get('jobId')
    if not isinstance(job_id, str) or not re.fullmatch(r'[0-9a-f]{32}', job_id):
        unsupported('jobId must identify a successful geometry job')
    ledger = workbench.geometry_patches
    if len(ledger) != 1 or ledger[0]['jobId'] != job_id:
        unsupported('promotion requires exactly one current addition-only job; restore the original scene before creating another job')
    entry = ledger[0]
    root = workbench.args.state_dir
    evidence = artifact(entry['evidenceAsset'], root)
    patch = artifact(entry['geometryAsset'], root)
    if evidence.get('jobId') != job_id or patch.get('jobId') != job_id or evidence.get('status') != 'visual-only' or patch.get('schema') != 'simforge.blender-geometry/v1':
        unsupported('persisted job identity/schema/status does not match the current ledger')
    records = evidence.get('changedObjectEvidence', [])
    if not records or evidence.get('changedObjects') != 0 or evidence.get('removedObjects') != 0 or patch.get('removed') or evidence.get('removedObjectEvidence') or any(item.get('beforeSha256') is not None or item.get('sourceId') is not None for item in records):
        unsupported('source replacements/removals cannot be promoted; only newly added geometry is supported')
    ids = [item['objectId'] for item in records]
    if len(set(ids)) != len(ids) or evidence.get('addedObjects') != len(ids) or {item['id'] for item in patch['changed']} != set(ids):
        unsupported('job evidence and geometry additions disagree')
    for source in evidence['sourceArtifacts']:
        uri = urlparse(source['uri'])
        if uri.scheme != 'file' or uri.netloc or sha(Path(unquote(uri.path))) != source['sha256']:
            unsupported('immutable source artifact bytes have changed')
    current = {obj.get('wb_object_id'): obj for obj in workbench.scene.objects}
    patch_records = {item['id']: item for item in patch['changed']}
    objects = []
    for item in records:
        obj = current.get(item['objectId'])
        if obj is None or digest(object_data(obj)) != item['afterSha256'] or digest(patch_records[item['objectId']]) != item['afterSha256']:
            unsupported('affected geometry/material/transform identity is stale: ' + item['objectId'])
        if obj.type != 'MESH' or obj.parent or obj.modifiers or obj.constraints or obj.animation_data or obj.data.shape_keys:
            unsupported('only unparented static meshes without modifiers, constraints, or shape keys can be promoted; apply static modifiers in the geometry job first')
        if obj.hide_render or obj.hide_viewport or obj.hide_get() or obj.is_holdout or obj.is_shadow_catcher or any(not getattr(obj, name, True) for name in ('visible_camera', 'visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_volume_scatter', 'visible_shadow')):
            unsupported('hidden objects and per-ray visibility overrides cannot be represented by this static asset')
        if any(collection.hide_render for collection in obj.users_collection):
            unsupported('hidden collection geometry cannot be promoted')
        if not obj.data.polygons or not obj.material_slots or any(p.material_index >= len(obj.material_slots) for p in obj.data.polygons):
            unsupported('meshes require material-bound surface polygons')
        # Blender's selection flags are editor state, not exported appearance.
        selection_attributes = {'.select_vert', '.select_edge', '.select_poly', '.uv_select_vert', '.uv_select_edge', '.uv_select_face'}
        allowed_attributes = {'position', '.edge_verts', '.corner_vert', '.corner_edge', 'material_index', 'sharp_face', 'sharp_edge', 'custom_normal'} | selection_attributes | {uv.name for uv in obj.data.uv_layers}
        if any(attr.name not in allowed_attributes for attr in obj.data.attributes):
            unsupported('non-UV mesh attributes/vertex colors require a dedicated faithful exporter')
        if obj.matrix_world.to_3x3().determinant() <= 0:
            unsupported('mirrored or singular object transforms require applied geometry first')
        objects.append(obj)
    map_id = workbench.runner.case.get('mapId', workbench.runner.manifest.get('mapId'))
    if not map_id or not workbench.source_ground:
        unsupported('explicit mapId and immutable sourceGroundObjects or sourceGroundSources are required')
    bpy = workbench.bpy
    groups = ('objects', 'meshes', 'materials', 'images', 'armatures', 'actions', 'cameras', 'lights', 'collections', 'node_groups', 'textures', 'worlds', 'scenes')
    before = {name: set(getattr(bpy.data, name)) for name in groups}
    old_scene, old_layer = workbench.scene, bpy.context.view_layer
    old_active = old_layer.objects.active
    old_selected = {obj for obj in old_layer.objects if obj.select_get(view_layer=old_layer)}
    try:
        reference = bpy.data.materials.new('ExportPBRReference')
        reference.use_nodes = True
        default = next(node for node in reference.node_tree.nodes if node.bl_idname == 'ShaderNodeBsdfPrincipled')
        for obj in objects:
            for slot in obj.material_slots:
                material_supported(slot.material, default)
        graph = bpy.context.evaluated_depsgraph_get()
        temporary = bpy.data.scenes.new('GeneratedStaticExport')
        temporary.unit_settings.system = 'METRIC'
        temporary.unit_settings.scale_length = 1
        layer = temporary.view_layers[0]
        copies = []
        material_copies = {}
        lower, upper = [math.inf] * 3, [-math.inf] * 3
        for obj in objects:
            evaluated = obj.evaluated_get(graph)
            mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=graph)
            mesh.transform(evaluated.matrix_world)
            for index, material in enumerate(mesh.materials):
                if material not in material_copies:
                    material_copies[material] = material.copy()
                mesh.materials[index] = material_copies[material]
            copy = bpy.data.objects.new('generated-' + obj['wb_object_id'], mesh)
            temporary.collection.objects.link(copy)
            copies.append(copy)
            for vertex in mesh.vertices:
                for axis, value in enumerate(vertex.co):
                    if not math.isfinite(value):
                        unsupported('evaluated vertices must be finite')
                    lower[axis] = min(lower[axis], value)
                    upper[axis] = max(upper[axis], value)
        dimensions = dict(l=upper[0] - lower[0], w=upper[1] - lower[1], h=upper[2] - lower[2])
        if any(not math.isfinite(value) or value <= 0 for value in dimensions.values()):
            unsupported('generated mesh must have a finite positive three-dimensional envelope')
        center = [(lower[0] + upper[0]) / 2, (lower[1] + upper[1]) / 2, lower[2]]
        heights = []
        for x, y in [(center[0], center[1]), (lower[0], lower[1]), (lower[0], upper[1]), (upper[0], lower[1]), (upper[0], upper[1])]:
            hits = []
            for _, tree, top in workbench.source_ground:
                hit, normal, _, _ = tree.ray_cast(workbench.Vector((x, y, top)), workbench.Vector((0, 0, -1)))
                if hit is not None and abs(normal.z) > 0.1:
                    hits.append(hit.z)
            if not hits or abs(lower[2] - max(hits)) > 0.05:
                unsupported('footprint center and four corners must be supported within 0.05m by immutable source ground')
            heights.append(max(hits))
        offset = lower[2] - heights[0]
        translation = workbench.Matrix.Translation(-workbench.Vector(center))
        for copy in copies:
            copy.data.transform(translation)
        with tempfile.TemporaryDirectory(prefix='.geometry-export-', dir=root) as directory:
            path = Path(directory) / 'asset.glb'
            with bpy.context.temp_override(scene=temporary, view_layer=layer, collection=temporary.collection, object=None, active_object=None, selected_objects=copies, selected_editable_objects=copies):
                for copy in copies:
                    copy.select_set(True, view_layer=layer)
                layer.update()
                result = bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, use_active_scene=True, export_yup=True, export_animations=False, export_cameras=False, export_lights=False, export_extras=False, export_materials='EXPORT')
                if result != {'FINISHED'} or not path.is_file():
                    unsupported('Blender glTF exporter did not finish')
                blob = path.read_bytes()
                asset_hash = hashlib.sha256(blob).hexdigest()
                workbench.validate_asset({'path': str(path), 'sha256': asset_hash})
                import struct
                length = struct.unpack_from('<I', blob, 12)[0]
                document = json.loads(blob[20:20 + length])
                if document.get('animations') or document.get('skins') or any(p.get('mode', 4) != 4 for mesh in document.get('meshes', []) for p in mesh['primitives']):
                    unsupported('export contains unsupported non-static/non-triangle semantics')
                expected_pbr = []
                for material in material_copies:
                    shader = next(node for node in material.node_tree.nodes if node.bl_idname == 'ShaderNodeBsdfPrincipled')
                    expected_pbr.append(list(shader.inputs['Base Color'].default_value) + [shader.inputs['Metallic'].default_value, shader.inputs['Roughness'].default_value])
                for material in document.get('materials', []):
                    pbr = material.get('pbrMetallicRoughness', {})
                    actual = pbr.get('baseColorFactor', [1, 1, 1, 1]) + [pbr.get('metallicFactor', 1), pbr.get('roughnessFactor', 1)]
                    if material.get('alphaMode', 'OPAQUE') != 'OPAQUE' or not any(all(abs(a - b) <= 1e-6 for a, b in zip(actual, expected)) for expected in expected_pbr):
                        unsupported('GLB export changed opaque constant PBR material values')
                if not document.get('materials') or any('material' not in primitive for mesh in document.get('meshes', []) for primitive in mesh['primitives']):
                    unsupported('GLB export dropped surface materials')
                # Re-import real bytes in isolation: verify the canonical Y-up envelope
                # survives the exporter/importer used for replay, without Runner caches.
                exported = set(bpy.data.objects)
                result = bpy.ops.import_scene.gltf(filepath=str(path))
                if result != {'FINISHED'}:
                    unsupported('GLB verification import did not finish')
                layer.update()
                verify_graph = bpy.context.evaluated_depsgraph_get()
                lo, hi = [math.inf] * 3, [-math.inf] * 3
                for obj in set(bpy.data.objects) - exported:
                    if obj.type != 'MESH':
                        continue
                    evaluated = obj.evaluated_get(verify_graph)
                    mesh = evaluated.to_mesh()
                    try:
                        for vertex in mesh.vertices:
                            point = evaluated.matrix_world @ vertex.co
                            for axis, value in enumerate((point.x, point.z, -point.y)):
                                lo[axis] = min(lo[axis], value)
                                hi[axis] = max(hi[axis], value)
                    finally:
                        evaluated.to_mesh_clear()
                expected_lo = [-dimensions['l'] / 2, 0, -dimensions['w'] / 2]
                expected_hi = [dimensions['l'] / 2, dimensions['h'], dimensions['w'] / 2]
                if any(not math.isfinite(a) or abs(a - b) > max(1e-5, abs(b) * 1e-6) for a, b in zip(lo + hi, expected_lo + expected_hi)):
                    unsupported('GLB round trip changed normalized dimensions/axes/placement')
            asset_path = root / (asset_hash + '.glb')
            descriptor = dict(schema='simforge.generated-static-geometry/v1', jobId=job_id, mapId=map_id,
                sourceArtifacts=evidence['sourceArtifacts'], objectIds=ids,
                asset=dict(id='generated:' + asset_hash, uri=asset_path.as_uri(), sha256=asset_hash, kind='mesh', format='glb', frame='simforge-y-up'),
                placement=dict(position=[center[0], center[2], -center[1]], headingRad=0, groundOffsetM=offset),
                dimensions=dimensions, support=dict(motion='static', collision='planar-opaque-obb', occlusion='planar-opaque-obb'))
            descriptor_bytes = json.dumps(descriptor, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
            descriptor_hash = hashlib.sha256(descriptor_bytes).hexdigest()
            descriptor_path = root / (descriptor_hash + '.generated-static-geometry.json')
            publish(asset_path, blob)
            publish(descriptor_path, descriptor_bytes)
            return dict(descriptor=dict(uri=descriptor_path.as_uri(), sha256=descriptor_hash))
    finally:
        for name in groups:
            collection = getattr(bpy.data, name)
            for item in set(collection) - before[name]:
                collection.remove(item, do_unlink=True)
        for obj in old_layer.objects:
            obj.select_set(obj in old_selected, view_layer=old_layer)
        old_layer.objects.active = old_active
