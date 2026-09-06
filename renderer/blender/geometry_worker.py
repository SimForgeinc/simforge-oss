"""Invoked only by the trusted workbench, in an inherited Landlock domain."""
import json
import math
import sys
import os
import time
import traceback
from pathlib import Path
import hashlib
from array import array

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import bmesh
from mathutils import Vector, Matrix
from guarded_blender import deny_authority
from geometry_data import object_data, digest, props

def finish():
    sys.stdout.flush()
    sys.stderr.flush()
    # Disposable worker: kernel teardown avoids GUI/audio-library shutdown paths
    # that cannot acquire network/process authority after confinement.
    os._exit(0)

def fail(kind, value, tb):
    traceback.print_exception(kind, value, tb)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(1)

sys.excepthook = fail
started = time.monotonic()
request = json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_text())
bpy.context.preferences.filepaths.use_scripts_auto_execute = False
bpy.ops.wm.open_mainfile(filepath=request['snapshot'], load_ui=False, use_scripts=False)
bpy.context.view_layer.update()
# TSYNC covers Blender's existing helper threads; no code runs if it fails.
deny_authority()
cache = {}
base = {obj['wb_object_id']: digest(object_data(obj, fingerprint=True, cache=cache))
        for obj in bpy.context.scene.objects if obj.type in {'MESH', 'EMPTY'}}
cache.clear()
print(f'Geometry fingerprints ready in {time.monotonic() - started:.3f}s', flush=True)
originals = {obj['wb_object_id']: obj.as_pointer() for obj in bpy.context.scene.objects}
data_names = {item.as_pointer(): item.name for group in (bpy.data.meshes, bpy.data.materials) for item in group}
def image_state(image):
    packed = [hashlib.sha256(item.packed_file.data).hexdigest() for item in image.packed_files]
    pixels = None
    if image.is_dirty and image.type not in {'RENDER_RESULT', 'COMPOSITING'}:
        buffer = array('f', [0]) * len(image.pixels)
        image.pixels.foreach_get(buffer)
        pixels = hashlib.sha256(buffer).hexdigest()
    return [props(image), image.is_dirty, packed, pixels]

def protected_state():
    return digest({'objects': {obj.name: [props(obj), props(obj.data) if obj.data else None, [list(row) for row in obj.matrix_world]] for obj in bpy.context.scene.objects if obj.type not in {'MESH', 'EMPTY'}},
                   'images': {image.name: image_state(image) for image in bpy.data.images},
                   'scene': props(bpy.context.scene), 'render': props(bpy.context.scene.render)})
protected = protected_state()
print(f'Protected state ready in {time.monotonic() - started:.3f}s', flush=True)
selected = bpy.data.objects.get(request['selected']) if request['selected'] else None
hit = Vector(request['hit']) if request['hit'] else None
namespace = dict(__name__='__workbench__', bpy=bpy, bmesh=bmesh, math=math, Vector=Vector, Matrix=Matrix, selected=selected, hit=hit)
exec(compile(request['code'], '<geometry-worker>', 'exec'), namespace, namespace)
if bpy.context.object and bpy.context.object.mode != 'OBJECT':
    bpy.ops.object.mode_set(mode='OBJECT')
bpy.context.view_layer.update()
if protected_state() != protected:
    raise ValueError('Nongeometry scene/camera/light/image edits are outside the inert geometry contract')
for group in (bpy.data.meshes, bpy.data.materials):
    for item in group:
        if data_names.get(item.as_pointer()) != item.name:
            item['wb_original_name'] = item.name
result = {}
present = set()
cache = {}
for index, obj in enumerate(bpy.context.scene.objects):
    if obj.type not in {'MESH', 'EMPTY'}:
        continue
    if not obj.get('wb_object_id') or (obj.get('wb_object_id') in originals and obj.as_pointer() != originals[obj['wb_object_id']]):
        obj['wb_object_id'] = request['jobId'] + ':' + str(index)
    key = obj['wb_object_id']
    if key in present:
        raise ValueError('Duplicate object handle; copied objects must remove wb_object_id')
    present.add(key)
    obj['wb_original_name'] = obj.name
    current = digest(object_data(obj, fingerprint=True, cache=cache))
    if current != base.get(key):
        result[key] = object_data(obj)
response = dict(schema='simforge.blender-geometry/v1', baseRevision=request['baseRevision'], jobId=request['jobId'], changed=list(result.values()), removed=sorted(base.keys() - present))
Path(request['output']).write_text(json.dumps(response, allow_nan=False, separators=(',', ':')))
print(f'Geometry output ready in {time.monotonic() - started:.3f}s', flush=True)
finish()
