#!/usr/bin/env python3
"""Trusted-local persistent Blender geometry workbench; launch with Blender --background."""
import argparse
import hashlib
import json
import math
import queue
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from geometry_jobs import source_identity
COMMANDS = queue.Queue(maxsize=1)
LOCK = threading.Lock()
STATE = dict(ready=False, busy=True, progress='Starting Blender workbench', scene='Yale Street',
             revision=0, engine='cycles', samples=32, width=960, height=540, renderMs=None,
             frameUrl='/frame.png?revision=0', frameSha256=None, camera=None, selection=None,
             undoDepth=0, redoDepth=0, objectCount=0, meshCount=0, lastEdit=None, lastError=None,
             capabilities=dict(scope='geometry/material/visual authoring only; does not update SimForge physics, road rules, or NuRec splats',
                               codeExecution='Disposable resource-limited Blender worker; Landlock read/write confinement and TSYNC seccomp; inert JSON transfer, no worker blend/code imported'))


def publish(**values):
    with LOCK:
        STATE.update(values)


def cached():
    with LOCK:
        return json.loads(json.dumps(STATE, allow_nan=False))


class Handler(BaseHTTPRequestHandler):
    server_version = 'BlenderWorkbench/1'

    def log_message(self, format, *args):
        # Keep concurrent HTTP access logs out of the geometry program's output.
        if sys.__stderr__ is not None:
            sys.__stderr__.write('%s - %s\n' % (self.address_string(), format % args))

    def allowed(self):
        host = self.headers.get('Host', '')
        if host not in self.server.allowed_hosts:
            self.respond(403, {'ok': False, 'error': 'Only the configured loopback Host is permitted'})
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin != 'http://' + host:
            self.respond(403, {'ok': False, 'error': 'Foreign Origin is prohibited'})
            return False
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.respond(403, {'ok': False, 'error': 'Cross-site access is prohibited'})
            return False
        return True

    def respond(self, status, value, content_type='application/json'):
        payload = json.dumps(value, allow_nan=False).encode() if content_type == 'application/json' else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if not self.allowed():
            return
        path = urlsplit(self.path).path
        if path == '/api/state':
            return self.respond(200, cached())
        files = {'/': ('workbench.html', 'text/html; charset=utf-8'),
                 '/workbench.html': ('workbench.html', 'text/html; charset=utf-8'),
                 '/workbench.js': ('workbench.js', 'text/javascript; charset=utf-8'),
                 '/workbench.css': ('workbench.css', 'text/css; charset=utf-8')}
        if path == '/frame.png':
            file, mime = self.server.frame_path, 'image/png'
        elif path in files:
            name, mime = files[path]
            file = (ROOT / name).resolve()
            if file.parent != ROOT:
                return self.respond(403, {'ok': False, 'error': 'Path is outside static root'})
        else:
            return self.respond(404, {'ok': False, 'error': 'Not found'})
        try:
            self.respond(200, file.read_bytes(), mime)
        except FileNotFoundError:
            self.respond(404, {'ok': False, 'error': 'No rendered frame yet' if path == '/frame.png' else 'File not found'})

    def do_POST(self):
        if not self.allowed():
            return
        if urlsplit(self.path).path != '/api/action':
            return self.respond(404, {'ok': False, 'error': 'Not found'})
        if self.headers.get_content_type() != 'application/json':
            return self.respond(415, {'ok': False, 'error': 'application/json is required'})
        try:
            if self.headers.get('Transfer-Encoding'):
                raise ValueError('Transfer-Encoding is not supported')
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 64 * 1024 * 1024:
                raise ValueError('Request size must be between 1 byte and 64 MiB')
            self.connection.settimeout(30)
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError('Action must be a JSON object')
        except Exception as exc:
            return self.respond(400, {'ok': False, 'error': str(exc), 'state': cached()})
        with LOCK:
            if not STATE['ready'] or STATE['busy']:
                unavailable = True
            else:
                unavailable = False
                STATE.update(busy=True, progress='Queued ' + str(payload.get('op', 'action')))
        if unavailable:
            return self.respond(409, {'ok': False, 'error': 'Workbench is loading or busy', 'state': cached()})
        event, result = threading.Event(), {}
        COMMANDS.put((payload, event, result))
        event.wait()
        self.respond(200 if result.get('ok') else 400, result)


class Workbench:
    def __init__(self, args):
        import bpy
        import bmesh
        from mathutils import Matrix, Vector, Quaternion
        from blender_runner import Runner
        self.bpy, self.bmesh, self.Vector, self.Matrix, self.Quaternion = bpy, bmesh, Vector, Matrix, Quaternion
        self.args = args
        self.undo, self.redo = [], []
        self.retired_snapshots = []
        self.target = Vector((0, 0, 0))
        self.selection = None
        self.engine, self.samples = 'cycles', 32
        self.frame_path = args.state_dir / 'frame.png'
        self.baseline = args.state_dir / 'baseline.blend'
        self.history_limit = 12
        self.storage_limit = 8 * 1024 ** 3
        self.last_edit = None
        self.geometry_patches = []
        self.camera_name = None
        self.executions = {}
        self.active_execution = None
        self.execution_evidence = None
        self.asset_measurements = {}

        class SceneRunner(Runner):
            def import_asset(self, path):
                publish(progress='Importing ' + str(path))
                objects = super().import_asset(path)
                for obj in objects:
                    obj['wb_source'] = str(Path(path).resolve())
                return objects

        runner_args = SimpleNamespace(manifest=args.manifest, case=args.case, engine=self.engine,
                                      camera_count=1, out=args.state_dir, frames=1, repeats=1)
        self.runner = SceneRunner(runner_args, dict(unsupportedCapabilities=[]))
        publish(progress='Configuring ' + self.engine + ' GPU', width=self.runner.manifest['width'], height=self.runner.manifest['height'])
        self.runner.configure()
        publish(progress='Loading real map geometry')
        self.runner.load_geometry()
        publish(progress='Building lighting and cameras')
        self.runner.lighting()
        bpy.context.view_layer.update()
        self.capture_source_ground()
        for camera in self.runner.frames[0]['cameras']:
            if camera.get('grounding') is None:
                continue
            if camera['grounding'] != 'source-map':
                raise ValueError('Initial camera grounding must be source-map')
            target = self.vector(camera['target'], 3, 'initial camera target')
            eye = self.vector(camera['eye'], 3, 'initial camera eye')
            hits = []
            for name, tree, top in self.source_ground:
                hit, normal, _, _ = tree.ray_cast(self.Vector((target[0], -target[2], top)), self.Vector((0, 0, -1)))
                if hit is not None and abs(normal.z) > 0.1:
                    hits.append((hit.z, name))
            if not hits:
                raise ValueError('No immutable original road under initial camera target')
            height, source = max(hits)
            eye[1] += height - target[1]
            target[1] = height
            camera.update(eye=eye, target=target)
            publish(initialCameraGround=dict(sensorId=camera['sensorId'], target=target, sourceGroundObject=source))
        self.runner.apply_frame(self.runner.frames[0])
        spec = next((c for c in self.runner.frames[0]['cameras'] if c['sensorId'] == 'front'), self.runner.frames[0]['cameras'][0])
        self.camera_name = spec['sensorId']
        self.scene.camera = self.runner.cameras[self.camera_name]
        self.target = self.runner.point(spec['target'])
        self.home_eye = self.camera.location.copy()
        self.home_rotation = self.camera.rotation_quaternion.copy()
        self.home_target = self.target.copy()
        self.home_lens = self.camera.data.lens
        self.home_sensor_fit = self.camera.data.sensor_fit
        self.home_sensor_height = self.camera.data.sensor_height
        from geometry_jobs import initialize
        initialize(self)
        for actor_id, (root, _) in self.runner.actors.items():
            root['wb_execution'] = 'baseline'
            root['wb_actor_id'] = actor_id
        publish(sourceArtifacts=self.source_artifacts, scene=self.runner.case.get('name', args.case),
                mapId=self.runner.case.get('mapId', self.runner.manifest.get('mapId')),
                sourceGroundObjects=self.runner.case.get('sourceGroundObjects', []),
                sourceGroundSources=self.runner.case.get('sourceGroundSources', []))
        publish(progress='Packing textures and saving initial scene', historyLimit=self.history_limit,
                historyStorageLimitBytes=self.storage_limit, device=self.runner.result.get('device'),
                unsupportedCapabilities=self.runner.result['unsupportedCapabilities'])
        self.snapshot(self.baseline)
        self.check_storage()
        self.render()
        self.baseline_render_options = (self.engine, self.samples)
        self.publish_geometry_fingerprint(*self.geometry())
        self.refresh()
        publish(ready=True, busy=False, progress='Ready')

    @property
    def scene(self):
        return self.bpy.context.scene

    @property
    def camera(self):
        camera = self.scene.camera
        if camera is None or camera.type != 'CAMERA':
            camera = self.bpy.data.objects.get(self.camera_name)
            if camera is None or camera.type != 'CAMERA':
                camera = self.bpy.data.objects.new('WorkbenchCamera', self.bpy.data.cameras.new('WorkbenchCamera'))
                self.scene.collection.objects.link(camera)
                camera.location = self.home_eye
                camera.data.lens = self.home_lens
                camera.data.sensor_fit = self.home_sensor_fit
                camera.data.sensor_height = self.home_sensor_height
                camera.rotation_mode = 'QUATERNION'
                camera.rotation_quaternion = (self.target - camera.location).to_track_quat('-Z', 'Y')
            self.scene.camera = camera
        self.camera_name = camera.name
        return camera

    def source(self, obj):
        cursor = obj
        while cursor:
            if cursor.get('wb_source'):
                return cursor['wb_source']
            cursor = cursor.parent
        return None

    def selected(self):
        if self.selection:
            obj = self.scene.objects.get(self.selection['name'])
            if obj is not None:
                return obj
        return None

    def refresh(self):
        self.bpy.context.view_layer.update()
        obj = self.selected()
        if obj is None:
            self.selection = None
        else:
            self.selection.update(name=obj.name, source=self.source(obj), vertices=len(obj.data.vertices) if obj.type == 'MESH' else 0,
                                  polygons=len(obj.data.polygons) if obj.type == 'MESH' else 0)
        eye = self.camera.matrix_world.translation
        data = self.camera.data
        publish(camera=dict(eye=[eye.x, eye.z, -eye.y], target=[self.target.x, self.target.z, -self.target.y], frame='simforge-y-up-meters',
                            rotationBlenderWxyz=list(self.camera.rotation_quaternion),
                            projection=dict(type=data.type, lensMm=data.lens, sensorFit=data.sensor_fit,
                                            sensorWidthMm=data.sensor_width, sensorHeightMm=data.sensor_height,
                                            shiftX=data.shift_x, shiftY=data.shift_y, nearM=data.clip_start, farM=data.clip_end,
                                            width=self.scene.render.resolution_x, height=self.scene.render.resolution_y,
                                            pixelAspectX=self.scene.render.pixel_aspect_x, pixelAspectY=self.scene.render.pixel_aspect_y)),
                selection=self.selection, objectCount=len(self.scene.objects),
                meshCount=sum(obj.type == 'MESH' for obj in self.scene.objects), undoDepth=len(self.undo), redoDepth=len(self.redo),
                lastEdit=self.last_edit, visualOnlyPatches=self.geometry_patches, engine=self.engine, samples=self.samples,
                historyStorageBytes=self.storage_bytes())

    def snapshot(self, path=None):
        path = path or self.args.state_dir / (uuid.uuid4().hex + '.blend')
        self.scene['wb_metadata'] = json.dumps(dict(target=list(self.target), selection=self.selection,
                                                   camera=self.camera.name, lastEdit=self.last_edit,
                                                   activeExecution=self.active_execution,
                                                   geometryPatches=self.geometry_patches,
                                                   sourceArtifacts=self.source_artifacts,
                                                   sourceByPath=self.source_by_path,
                                                   executionEvidence=self.execution_evidence))
        self.bpy.context.preferences.filepaths.save_version = 0
        self.bpy.ops.file.pack_all()
        self.bpy.ops.wm.save_as_mainfile(filepath=str(path), check_existing=False, copy=True, compress=True, relative_remap=False)
        return path

    def restore(self, path):
        self.bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False, use_scripts=False)
        meta = json.loads(self.scene['wb_metadata'])
        self.target = self.Vector(meta['target'])
        self.selection = meta['selection']
        self.camera_name = meta['camera']
        self.last_edit = meta.get('lastEdit')
        self.geometry_patches = meta['geometryPatches']
        self.active_execution = meta.get('activeExecution')
        self.execution_evidence = meta.get('executionEvidence')
        self.source_artifacts = meta['sourceArtifacts']
        self.source_by_path = meta['sourceByPath']
        publish(sourceArtifacts=self.source_artifacts)
        publish(execution=self.execution_evidence)
        # A .blend restore replaces RNA handles; imported templates must be reacquired.
        self.runner.assets = {}
        self.runner.actors = {}
        self.runner.scene = self.scene
        # Disabled actor hierarchies are not evaluated on .blend load. Warm their
        # transforms before hiding them again, otherwise geometry queries report
        # identity child matrices until that actor is shown in a later frame.
        hidden = [obj for obj in self.scene.objects if obj.hide_viewport]
        for obj in hidden:
            obj.hide_viewport = False
        self.bpy.context.view_layer.update()
        for obj in hidden:
            obj.hide_viewport = True
        self.camera
        self.bpy.context.view_layer.update()
        self.publish_geometry_fingerprint(*self.geometry())
    def begin_authoring(self, payload):
        if type(payload.get('baseRevision')) is not int or payload['baseRevision'] != cached()['revision']:
            raise ValueError('Stale or missing baseRevision for authoring context')
        if self.geometry_patches:
            raise ValueError('Unadopted visual edits must be explicitly undone or reset before another authoring context')
        # A new run must not inherit actor poses, source inventory, sampling or undo history.
        # The immutable baseline stays resident in the same Blender process.
        self.restore(self.baseline)
        self.engine, self.samples = self.baseline_render_options
        self.retired_snapshots.extend(self.undo + self.redo)
        self.undo.clear()
        self.redo.clear()
        self.executions.clear()
        self.active_execution = self.execution_evidence = self.last_edit = self.selection = None
        for root in self.scene.objects:
            if root.get('wb_execution'):
                for obj in [root, *root.children_recursive]:
                    obj.hide_render = obj.hide_viewport = True
        self.check_storage()
        self.render()
        self.refresh()
        publish(execution=None)
        return dict(authoringContext='original-map-only', sourceArtifactCount=len(self.source_artifacts))


    def storage_bytes(self):
        return sum(p.stat().st_size for pattern in ('*.blend', '*.json') for p in self.args.state_dir.glob(pattern))

    def check_storage(self):
        def total():
            return self.storage_bytes()
        while self.retired_snapshots and (len(self.retired_snapshots) > self.history_limit or total() > self.storage_limit):
            self.retired_snapshots.pop(0).unlink(missing_ok=True)
        while len(self.undo) > self.history_limit:
            self.undo.pop(0).unlink(missing_ok=True)
        while total() > self.storage_limit and len(self.undo) > 1:
            self.undo.pop(0).unlink(missing_ok=True)
        if total() > self.storage_limit:
            raise RuntimeError('Snapshot storage exceeds 8 GiB; transaction cannot be committed')

    def configure_engine(self):
        render = self.scene.render
        expected_engine = 'BLENDER_EEVEE' if self.engine == 'eevee' else 'CYCLES'
        # Reassigning renderer properties can invalidate Cycles' retained scene data.
        if render.engine != expected_engine:
            render.engine = expected_engine
        if not render.use_persistent_data:
            render.use_persistent_data = True
        if self.engine == 'eevee':
            if self.scene.eevee.taa_render_samples != self.samples:
                self.scene.eevee.taa_render_samples = self.samples
            import gpu
            gpu.init()
            device = dict(backend=gpu.platform.backend_type_get(), vendor=gpu.platform.vendor_get(), name=gpu.platform.renderer_get())
            if '5080' not in device['name'].lower():
                raise RuntimeError('Required RTX5080 Eevee GPU unavailable: ' + str(device))
        else:
            prefs = self.bpy.context.preferences.addons['cycles'].preferences
            changed_backend = prefs.compute_device_type != 'OPTIX'
            reset_cycles = changed_backend
            if changed_backend:
                prefs.compute_device_type = 'OPTIX'
            if changed_backend or not any(d.type == 'OPTIX' and '5080' in d.name for d in prefs.devices):
                prefs.get_devices_for_type('OPTIX')
            for item in prefs.devices:
                enabled = item.type == 'OPTIX' and '5080' in item.name
                if item.use != enabled:
                    item.use = enabled
                    reset_cycles = True
            devices = [dict(name=d.name, type=d.type) for d in prefs.devices if d.use]
            if not devices:
                raise RuntimeError('Required RTX5080 OptiX GPU unavailable; CPU fallback prohibited')
            for attribute, value in (('device', 'GPU'), ('samples', self.samples),
                                     ('use_adaptive_sampling', False), ('use_denoising', True),
                                     ('denoiser', 'OPTIX'), ('seed', 0), ('use_animated_seed', False)):
                if getattr(self.scene.cycles, attribute) != value:
                    setattr(self.scene.cycles, attribute, value)
                    reset_cycles = True
            if reset_cycles:
                # Persistent Cycles sessions otherwise keep the old sampling parameters.
                render.engine = expected_engine
            device = dict(backend='OPTIX', devices=devices, cpuEnabled=False)
        publish(device=device, persistentData=True, ditherIntensity=render.dither_intensity)

    def render(self):
        self.camera
        self.configure_engine()
        for attribute, value in (('resolution_x', self.runner.manifest['width']),
                                 ('resolution_y', self.runner.manifest['height']), ('resolution_percentage', 100)):
            if getattr(self.scene.render, attribute) != value:
                setattr(self.scene.render, attribute, value)
        if self.scene.render.image_settings.file_format != 'PNG':
            self.scene.render.image_settings.file_format = 'PNG'
        publish(progress='Rendering ' + self.engine + ' on GPU')
        start = time.perf_counter()
        self.bpy.context.view_layer.update()
        self.bpy.ops.render.render(write_still=False)
        render_ms = (time.perf_counter() - start) * 1000
        start = time.perf_counter()
        temporary = self.args.state_dir / 'next-frame.png'
        self.bpy.data.images['Render Result'].save_render(str(temporary), scene=self.scene)
        sha = hashlib.sha256(temporary.read_bytes()).hexdigest()
        temporary.replace(self.frame_path)
        revision = cached()['revision'] + 1
        publish(revision=revision, frameUrl='/frame.png?revision=' + str(revision), frameSha256=sha,
                renderMs=render_ms, writeMs=(time.perf_counter() - start) * 1000)

    def capture_source_ground(self):
        from mathutils.bvhtree import BVHTree
        names = self.runner.case.get('sourceGroundObjects', [])
        if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
            raise ValueError('sourceGroundObjects must be exact original mesh names')
        sources = self.runner.case.get('sourceGroundSources', [])
        if not isinstance(sources, list) or any(not isinstance(source, str) for source in sources):
            raise ValueError('sourceGroundSources must contain explicit static-map asset paths')
        if len(set(sources)) != len(sources):
            raise ValueError('Duplicate sourceGroundSources are ambiguous')
        selected = []
        for name in names:
            matches = [obj for obj in self.scene.objects if obj.name == name and obj.type == 'MESH']
            if len(matches) != 1 or self.source(matches[0]) not in self.runner.case['staticGlbs']:
                raise ValueError('Source ground mesh is not an exact static-map object: ' + name)
            selected.append(matches[0])
        for source in sources:
            if self.runner.case['staticGlbs'].count(source) != 1:
                raise ValueError('Source ground asset must occur exactly once in staticGlbs: ' + source)
            matches = [obj for obj in self.scene.objects if obj.type == 'MESH' and self.source(obj) == source]
            if not matches:
                raise ValueError('Source ground asset has no imported meshes: ' + source)
            selected.extend(sorted(matches, key=lambda obj: obj.name))
        if len(set(selected)) != len(selected):
            raise ValueError('Overlapping source-ground object and asset selections are ambiguous')
        self.source_ground = []
        for obj in selected:
            name = obj.name
            vertices = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
            if not vertices or not obj.data.polygons:
                raise ValueError('Source ground mesh has no surface: ' + name)
            tree = BVHTree.FromPolygons(vertices, [list(p.vertices) for p in obj.data.polygons])
            self.source_ground.append((name, tree, max(v.z for v in vertices) + 1))

    @staticmethod
    def finite(value, label):
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError(label + ' must be a finite number')
        return value

    @classmethod
    def vector(cls, value, size, label):
        if not isinstance(value, list) or len(value) != size:
            raise ValueError(label + ' must contain ' + str(size) + ' numbers')
        return [cls.finite(component, label) for component in value]

    def validate_asset(self, binding, verified_sources=None):
        if not isinstance(binding.get('path'), str) or not Path(binding['path']).is_absolute():
            raise ValueError('Asset paths must be explicit absolute paths')
        path = Path(binding['path']).resolve(strict=True)
        key = str(path)
        if verified_sources is not None and key in verified_sources:
            digest = verified_sources[key]
            if binding.get('sha256') != digest:
                raise ValueError('Asset SHA256 mismatch: ' + key)
            return key, digest
        if not path.is_file() or path.suffix.lower() != '.glb':
            raise ValueError('Only self-contained real GLB assets are supported')
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if binding.get('sha256') != digest:
            raise ValueError('Asset SHA256 mismatch: ' + key)
        prior = self.source_by_path.get(key)
        if prior is not None and prior != source_identity(key, digest):
            raise ValueError('Previously imported source bytes changed; use a new immutable asset path: ' + key)
        # Reject external buffers/textures: a GLB hash must close over all imported bytes.
        import struct
        if len(data) < 20 or data[:4] != b'glTF' or struct.unpack_from('<II', data, 4) != (2, len(data)):
            raise ValueError('Invalid GLB header: ' + key)
        length, kind = struct.unpack_from('<II', data, 12)
        if kind != 0x4E4F534A or 20 + length > len(data):
            raise ValueError('Missing GLB JSON chunk')
        document = json.loads(data[20:20 + length])
        for item in document.get('buffers', []) + document.get('images', []):
            if item.get('uri') and not item['uri'].startswith('data:'):
                raise ValueError('External GLB resource is not hash-bound: ' + item['uri'])
        if verified_sources is not None:
            verified_sources[key] = digest
        return key, digest

    def import_execution_asset(self, path, digest):
        # Paths remain immutable bindings; identical content shares native templates.
        content_prefix = 'source:' + digest + ':'
        for source, source_id in self.source_by_path.items():
            if source_id.startswith(content_prefix) and source in self.runner.assets:
                templates = self.runner.assets[source]
                self.runner.assets[path] = templates
                return templates
        return self.runner.import_asset(path)

    def inspect_asset(self, payload):
        path, digest = self.validate_asset(payload)
        measurement = self.asset_measurements.get(digest)
        was_cached = measurement is not None
        if measurement is None:
            bpy = self.bpy
            groups = ('objects', 'meshes', 'materials', 'images', 'armatures', 'actions', 'cameras', 'lights',
                      'collections', 'node_groups', 'textures', 'worlds', 'scenes')
            before = {name: set(getattr(bpy.data, name)) for name in groups}
            old_assets, old_ids = dict(self.runner.assets), dict(self.runner.ids)
            old_runner_scene = self.runner.scene
            old_scene, old_layer = self.scene, bpy.context.view_layer
            old_camera, old_active = old_scene.camera, old_layer.objects.active
            old_selected = {obj for obj in old_layer.objects if obj.select_get(view_layer=old_layer)}
            temporary = None
            templates = []
            succeeded = False
            try:
                temporary = bpy.data.scenes.new('AssetInspection')
                temporary.frame_set(old_scene.frame_current, subframe=old_scene.frame_subframe)
                layer = temporary.view_layers[0]
                self.runner.scene = temporary
                with bpy.context.temp_override(scene=temporary, view_layer=layer, collection=temporary.collection,
                                               object=None, active_object=None, selected_objects=[], selected_editable_objects=[]):
                    templates = self.import_execution_asset(path, digest)
                    root = self.runner.clone_asset(templates, 'asset-inspection', self.Matrix.Identity(4))
                    for obj in [root, *root.children_recursive]:
                        obj.hide_render = obj.hide_viewport = False
                        obj.hide_set(False, view_layer=layer)
                    layer.update()
                    graph = bpy.context.evaluated_depsgraph_get()
                    lower, upper = [math.inf] * 3, [-math.inf] * 3
                    for obj in root.children_recursive:
                        if obj.type != 'MESH':
                            continue
                        evaluated = obj.evaluated_get(graph)
                        mesh = evaluated.to_mesh()
                        try:
                            for vertex in mesh.vertices:
                                point = evaluated.matrix_world @ vertex.co
                                for axis, value in enumerate((point.x, point.z, -point.y)):
                                    if not math.isfinite(value):
                                        raise ValueError('Asset contains non-finite evaluated geometry: ' + path)
                                    lower[axis] = min(lower[axis], value)
                                    upper[axis] = max(upper[axis], value)
                        finally:
                            evaluated.to_mesh_clear()
                    if not all(math.isfinite(value) for value in lower + upper):
                        raise ValueError('Bound asset contains no evaluated mesh vertices: ' + path)
                    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest:
                        raise ValueError('Asset changed during import: ' + path)
                    measurement = dict(frame='simforge-y-up', bounds=dict(min=lower, max=upper),
                                       dims=dict(l=upper[0] - lower[0], w=upper[2] - lower[2], h=upper[1] - lower[1]),
                                       measurement='Native evaluated mesh vertex envelope at identity actor root, in meters; '
                                                   'same imported frozen pose and cleared object/data/shape-key/material animation '
                                                   'as rigid-root replay, including parent transforms, evaluated modifiers and '
                                                   'all mesh accessories. Excludes embedded cameras/lights, shader displacement '
                                                   'and animation sweeps; not a physical body collider or declared catalog dimensions.')
                for image in set(bpy.data.images) - before['images']:
                    image['wb_image_id'] = uuid.uuid4().hex
                    if image.has_data:
                        image.pack()
                for group in ('meshes', 'materials'):
                    for item in set(getattr(bpy.data, group)) - before[group]:
                        item['wb_original_name'] = item.name
                succeeded = True
            finally:
                self.runner.scene = old_runner_scene
                if not succeeded:
                    self.runner.assets = old_assets
                self.runner.ids = old_ids
                # Templates alone survive success, always unlinked; every temporary
                # clone and collection is removed even if import/evaluation fails.
                retained = set(templates) if succeeded else set()
                for obj in set(bpy.data.objects) - before['objects'] - retained:
                    bpy.data.objects.remove(obj, do_unlink=True)
                for group in groups[1:]:
                    if succeeded and group not in ('collections', 'scenes'):
                        continue
                    collection = getattr(bpy.data, group)
                    for item in set(collection) - before[group]:
                        collection.remove(item, do_unlink=True)
                old_scene.camera = old_camera
                for obj in old_layer.objects:
                    selected = obj in old_selected
                    if obj.select_get(view_layer=old_layer) != selected:
                        obj.select_set(selected, view_layer=old_layer)
                old_layer.objects.active = old_active
            self.asset_measurements[digest] = measurement
        source_id = source_identity(path, digest)
        if path not in self.source_by_path:
            self.source_by_path[path] = source_id
            self.source_artifacts.append(dict(id=source_id, uri=Path(path).as_uri(), sha256=digest))
            publish(sourceArtifacts=self.source_artifacts)
        return dict(asset=dict(path=path, sha256=digest, **measurement), cached=was_cached)

    def validate_execution(self, payload):
        scene = payload.get('scene')
        if not isinstance(scene, dict) or scene.get('version') != 'simforge.scene-state.v1':
            raise ValueError('scene must be a simforge.scene-state.v1 document')
        map_id = self.runner.case.get('mapId', self.runner.manifest.get('mapId'))
        if not map_id or scene.get('mapId') != map_id or scene.get('frame') != 'scene-yup':
            raise ValueError('Scene mapId/frame must match the explicitly configured mapId and scene-yup frame')
        for key in ('dt', 'tickHz'):
            if self.finite(scene.get(key), key) <= 0:
                raise ValueError(key + ' must be positive')
        if not 0 <= self.finite(scene.get('timeOfDay'), 'timeOfDay') < 24:
            raise ValueError('timeOfDay must be in [0,24)')
        if scene.get('profile', 'sensor') not in ('sensor', 'cinematic'):
            raise ValueError('Unknown render profile')
        weather = scene.get('weather')
        if not isinstance(weather, dict) or weather.get('preset') not in ('clear', 'fog', 'rain', 'night'):
            raise ValueError('Invalid canonical weather')
        for key in ('fogDensity', 'rainIntensity', 'wetness'):
            if not 0 <= self.finite(weather.get(key, 0), key) <= 1:
                raise ValueError(key + ' must be in [0,1]')
        grounding = payload.get('grounding')
        if grounding not in ('source-map', 'explicit'):
            raise ValueError('grounding must be source-map or explicit')
        if grounding == 'source-map' and not self.source_ground:
            raise ValueError('source-map requires explicit sourceGroundObjects or sourceGroundSources')
        if scene.get('groundY') is not None:
            self.finite(scene['groundY'], 'groundY')
        actors, frames = scene.get('actors'), scene.get('frames')
        if not isinstance(actors, list) or not isinstance(frames, list) or not frames:
            raise ValueError('actors and nonempty frames arrays required')
        if type(scene.get('tickCount')) is not int or scene['tickCount'] != len(frames):
            raise ValueError('tickCount must equal frames.length')
        descriptions = {}
        for actor in actors:
            if not isinstance(actor, dict) or not isinstance(actor.get('id'), str) or not actor['id'] or actor['id'] in descriptions:
                raise ValueError('Actor IDs must be nonempty and unique')
            if not isinstance(actor.get('catalogId'), str) or not actor['catalogId']:
                raise ValueError('Every actor requires catalogId')
            if actor.get('actorClass') not in ('car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian', 'prop'):
                raise ValueError('Invalid actorClass')
            if 'dims' in actor:
                if not isinstance(actor['dims'], dict):
                    raise ValueError('Invalid actor dimensions')
                for key in ('l', 'w', 'h'):
                    if self.finite(actor['dims'].get(key), 'dims.' + key) <= 0:
                        raise ValueError('Actor dimensions must be positive')
            if 'color' in actor:
                import re
                if not isinstance(actor['color'], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', actor['color']):
                    raise ValueError('Invalid actor color')
            descriptions[actor['id']] = actor
        bindings = payload.get('assetBindings')
        if not isinstance(bindings, list) or len(bindings) != len(actors):
            raise ValueError('Exactly one explicit asset binding per actor required')
        assets = {}
        verified_sources = {}
        for binding in bindings:
            if not isinstance(binding, dict):
                raise ValueError('Invalid asset binding')
            actor_id = binding.get('actorId')
            if actor_id not in descriptions or actor_id in assets or binding.get('catalogId') != descriptions[actor_id]['catalogId']:
                raise ValueError('Asset actorId/catalogId mismatch or duplicate')
            path, digest = self.validate_asset(binding, verified_sources)
            ground_offset = self.finite(binding.get('groundOffsetM', 0), 'groundOffsetM')
            if abs(ground_offset) > 0.05 or (ground_offset != 0 and binding['catalogId'] != 'gallery.generated.' + digest):
                raise ValueError('Ground offsets require a hash-bound generated static asset and must be within 0.05m')
            assets[actor_id] = dict(actorId=actor_id, catalogId=binding['catalogId'], path=str(path), sha256=digest,
                                   groundOffsetM=ground_offset)
        timeline = {actor_id: ([], []) for actor_id in descriptions}
        present = set()
        last_tick, last_t = -1, -math.inf
        for index, frame in enumerate(frames):
            if not isinstance(frame, dict) or type(frame.get('tick')) is not int or frame['tick'] <= last_tick:
                raise ValueError('Frame ticks must be strictly increasing nonnegative integers')
            t = self.finite(frame.get('t'), 'frame.t')
            if t <= last_t or not isinstance(frame.get('actors'), list):
                raise ValueError('Frame times must increase; actors must be an array')
            last_tick, last_t = frame['tick'], t
            seen = set()
            for record in frame['actors']:
                if not isinstance(record, dict) or record.get('id') not in descriptions or record['id'] in seen:
                    raise ValueError('Unknown or duplicate frame actor')
                actor_id, kind = record['id'], record.get('kind')
                seen.add(actor_id)
                for key, size in (('position', 3), ('rotation', 4), ('velocity', 3)):
                    self.vector(record.get(key), size, key)
                if 'acceleration' in record:
                    self.vector(record['acceleration'], 3, 'acceleration')
                self.finite(record.get('yawRad'), 'yawRad')
                if sum(x * x for x in record['rotation']) < 1e-12:
                    raise ValueError('Zero actor rotation')
                if kind == 'spawn' and actor_id not in present:
                    present.add(actor_id)
                elif kind == 'despawn' and actor_id in present:
                    present.remove(actor_id)
                elif kind != 'update' or actor_id not in present:
                    raise ValueError('Invalid spawn/update/despawn transition for ' + actor_id)
                timeline[actor_id][0].append(index)
                timeline[actor_id][1].append(record)
        identity = hashlib.sha256(json.dumps(dict(scene=scene, assetBindings=sorted(assets.values(), key=lambda x: x['actorId']),
                                                  grounding=grounding), sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
        return identity, dict(scene=scene, assets=assets, timeline=timeline, grounding=grounding, roots={})

    def bind_execution(self, payload):
        identity, execution = self.validate_execution(payload)
        previous = self.executions.get(identity)
        scene_ids = {obj.get('wb_object_id') for obj in self.scene.objects}
        if previous is not None and all(root_id in scene_ids for root_id in previous['roots'].values()):
            return dict(executionId=identity, cached=True, findings=self.execution_findings())
        # Documents and actor roots are retained for arbitrary inter-execution seeking.
        bpy = self.bpy
        groups = ('objects', 'meshes', 'materials', 'images', 'armatures', 'actions', 'cameras', 'lights',
                  'collections', 'node_groups', 'textures', 'worlds', 'scenes')
        before = {name: set(getattr(bpy.data, name)) for name in groups}
        old_assets, old_ids = dict(self.runner.assets), dict(self.runner.ids)
        old_camera = self.scene.camera
        old_active = bpy.context.view_layer.objects.active
        try:
            for actor_id, binding in execution['assets'].items():
                templates = self.import_execution_asset(binding['path'], binding['sha256'])
                if not any(obj.type == 'MESH' and len(obj.data.vertices) for obj in templates):
                    raise ValueError('Bound asset contains no mesh: ' + binding['path'])
                root = self.runner.clone_asset(templates, 'execution:' + identity[:12] + ':' + actor_id, self.Matrix.Identity(4))
                root['wb_execution'], root['wb_actor_id'] = identity, actor_id
                for obj in [root, *root.children_recursive]:
                    obj['wb_object_id'] = uuid.uuid4().hex
                    obj['wb_original_name'] = obj.name
                    obj['wb_source'] = binding['path']
                    obj.hide_render = True
                    obj.hide_viewport = True
                execution['roots'][actor_id] = root['wb_object_id']
            for path, digest in {binding['path']: binding['sha256'] for binding in execution['assets'].values()}.items():
                if hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest:
                    raise ValueError('Asset changed during import: ' + path)
            for group in ('meshes', 'materials'):
                for item in set(getattr(bpy.data, group)) - before[group]:
                    item['wb_original_name'] = item.name
            for image in set(bpy.data.images) - before['images']:
                image['wb_image_id'] = uuid.uuid4().hex
                if image.has_data:
                    image.pack()
        except BaseException:
            for group in groups:
                collection = getattr(bpy.data, group)
                for item in set(collection) - before[group]:
                    collection.remove(item, do_unlink=True)
            self.runner.assets, self.runner.ids = old_assets, old_ids
            raise
        finally:
            self.scene.camera = old_camera
            bpy.context.view_layer.objects.active = old_active
        if previous is not None:
            stale = set(previous['roots'].values())
            for root in [obj for obj in self.scene.objects if obj.get('wb_object_id') in stale]:
                for obj in [*root.children_recursive, root]:
                    bpy.data.objects.remove(obj, do_unlink=True)
        for binding in execution['assets'].values():
            source_id = source_identity(binding['path'], binding['sha256'])
            if binding['path'] not in self.source_by_path:
                self.source_by_path[binding['path']] = source_id
                self.source_artifacts.append(dict(id=source_id, uri=Path(binding['path']).as_uri(), sha256=binding['sha256']))
        self.executions[identity] = execution
        publish(sourceArtifacts=self.source_artifacts)
        self.refresh()
        return dict(executionId=identity, cached=False, actorCount=len(execution['assets']),
                    frameCount=len(execution['scene']['frames']), findings=self.execution_findings())

    @staticmethod
    def execution_findings():
        return ['Canonical rigid-root replay, not Blender dynamics or policy execution.',
                'Original road grounding ignores visual edits; holes cannot cause physical descent.',
                'Manifest lighting retained; scene weather/timeOfDay/profile are recorded but not applied.',
                'Asset native scale/material/pose retained; declared dims/color, animation, articulation and deformation are not applied.',
                'Actor-relative camera is an inspection recipe, not an attested policy sensor.']

    def render_execution_frame(self, payload):
        from bisect import bisect_right
        identity = payload.get('executionId')
        if identity not in self.executions:
            raise ValueError('Unknown executionId; bind the canonical document first')
        execution = self.executions[identity]
        index = payload.get('frameIndex')
        frames = execution['scene']['frames']
        if type(index) is not int or not 0 <= index < len(frames):
            raise ValueError('frameIndex is outside the canonical document')
        samples = payload.get('samples', self.samples)
        if type(samples) is not int or not 1 <= samples <= 4096:
            raise ValueError('samples must be an integer in [1,4096]')
        roots = {obj['wb_object_id']: obj for obj in self.scene.objects if obj.get('wb_execution')}
        poses = {}
        for actor_id, (indices, records) in execution['timeline'].items():
            offset = bisect_right(indices, index) - 1
            if offset < 0 or records[offset]['kind'] == 'despawn':
                continue
            record = records[offset]
            position = list(record['position'])
            ground_source = None
            if execution['grounding'] == 'source-map':
                hits = []
                for name, tree, top in self.source_ground:
                    hit, normal, _, _ = tree.ray_cast(self.Vector((position[0], -position[2], top)), self.Vector((0, 0, -1)))
                    if hit is not None and abs(normal.z) > 0.1:
                        hits.append((hit.z, name))
                if not hits:
                    raise ValueError('No immutable original road under actor ' + actor_id)
                position[1], ground_source = max(hits)
                position[1] += execution['assets'][actor_id]['groundOffsetM']
            elif execution['scene'].get('groundY') is not None:
                position[1] = execution['scene']['groundY']
            root = roots.get(execution['roots'][actor_id])
            if root is None:
                raise ValueError('Bound actor removed by geometry history; rebind in an intact workbench: ' + actor_id)
            poses[actor_id] = dict(position=position, rotation=record['rotation'], yawRad=record['yawRad'],
                                   sourceGroundObject=ground_source)
        recipe = payload.get('camera')
        if not isinstance(recipe, dict):
            raise ValueError('Explicit camera recipe required')
        fov = self.finite(recipe.get('fovYDeg'), 'fovYDeg')
        if not 1 < fov < 179:
            raise ValueError('fovYDeg must be in (1,179)')
        if recipe.get('kind') == 'world':
            eye = self.vector(recipe.get('eye'), 3, 'eye')
            target = self.vector(recipe.get('target'), 3, 'target')
        elif recipe.get('kind') == 'actor-relative':
            actor_id = recipe.get('actorId')
            if actor_id not in poses:
                raise ValueError('Camera actor is absent at this frame')
            pose = poses[actor_id]
            yaw = pose['yawRad']
            def relative(key):
                forward, up, right = self.vector(recipe.get(key), 3, key)
                x, y, z = pose['position']
                return [x + forward * math.cos(yaw) + right * math.sin(yaw), y + up,
                        z - forward * math.sin(yaw) + right * math.cos(yaw)]
            eye, target = relative('offset'), relative('targetOffset')
        else:
            raise ValueError('Camera kind must be world or actor-relative')
        if sum((a - b) ** 2 for a, b in zip(eye, target)) < 1e-10:
            raise ValueError('Camera eye and target must differ')
        camera = self.camera
        saved_camera = (camera.matrix_world.copy(), camera.data.lens, camera.data.sensor_fit, camera.data.sensor_height)
        saved_rotation_mode = camera.rotation_mode
        saved_target, saved_samples = self.target.copy(), self.samples
        touched = [(obj, obj.matrix_world.copy(), obj.hide_render, obj.hide_viewport)
                   for root in roots.values() for obj in [root, *root.children_recursive]]
        try:
            for obj, _, _, _ in touched:
                obj.hide_render = obj.hide_viewport = True
            for actor_id, pose in poses.items():
                root = roots[execution['roots'][actor_id]]
                for obj in [root, *root.children_recursive]:
                    obj.hide_render = obj.hide_viewport = False
                root.matrix_world = self.runner.transform(pose['position'], pose['rotation'])
            camera.location = self.runner.point(eye)
            self.target = self.runner.point(target)
            camera.rotation_mode = 'QUATERNION'
            camera.rotation_quaternion = (self.target - camera.location).to_track_quat('-Z', 'Y')
            camera.data.sensor_fit = 'VERTICAL'
            camera.data.sensor_height = 24
            camera.data.lens = 24 / (2 * math.tan(math.radians(fov) / 2))
            self.samples = samples
            self.bpy.context.view_layer.update()
            depsgraph = self.bpy.context.evaluated_depsgraph_get()
            descriptions = {actor['id']: actor for actor in execution['scene']['actors']}
            for actor_id, pose in poses.items():
                root = roots[execution['roots'][actor_id]]
                inverse = root.matrix_world.inverted()
                world_corners, local_corners = [], []
                for obj in root.children_recursive:
                    if obj.type != 'MESH' or obj.hide_render:
                        continue
                    evaluated = obj.evaluated_get(depsgraph)
                    if not len(evaluated.data.vertices):
                        continue
                    for corner in evaluated.bound_box:
                        world = evaluated.matrix_world @ self.Vector(corner)
                        local = inverse @ world
                        if not all(math.isfinite(value) for value in (*world, *local)):
                            raise ValueError('Nonfinite rendered actor bounds: ' + actor_id)
                        local_corners.append(local)
                        world_corners.append((world.x, world.z, -world.y))
                if not world_corners:
                    raise ValueError('Present actor has no rendered mesh bounds: ' + actor_id)
                local_extent = [max(point[axis] for point in local_corners) - min(point[axis] for point in local_corners)
                                for axis in range(3)]
                measured = dict(zip(('l', 'w', 'h'), local_extent))
                declared = descriptions[actor_id].get('dims')
                pose['geometry'] = dict(
                    declaredDims=declared, measuredDims=measured,
                    dimensionDeltaM={key: measured[key] - declared[key] for key in measured} if declared else None,
                    worldBounds=dict(min=[min(point[axis] for point in world_corners) for axis in range(3)],
                                     max=[max(point[axis] for point in world_corners) for axis in range(3)]),
                    measurement='Envelope of evaluated mesh-object bounding boxes; root-local +X length, +Y width, +Z height in Blender; world bounds scene-yup metres. Not engine collider dimensions.',
                    scalingApplied=False)
            self.render()
        except BaseException:
            for obj, matrix, hidden_render, hidden_viewport in touched:
                obj.matrix_world = matrix
                obj.hide_render, obj.hide_viewport = hidden_render, hidden_viewport
            camera.rotation_mode = saved_rotation_mode
            camera.matrix_world, camera.data.lens, camera.data.sensor_fit, camera.data.sensor_height = saved_camera
            self.target, self.samples = saved_target, saved_samples
            self.bpy.context.view_layer.update()
            raise
        self.active_execution = identity
        self.execution_evidence = dict(executionId=identity, frameIndex=index, tick=frames[index]['tick'], t=frames[index]['t'],
            mapId=execution['scene']['mapId'], grounding=execution['grounding'], actors=[
                dict(actorId=actor_id, **pose, asset=execution['assets'][actor_id]) for actor_id, pose in poses.items()],
            camera=dict(recipe=recipe, eye=eye, target=target, fovYDeg=fov, policySensorAttested=False),
            samples=samples, engine=self.engine, findings=self.execution_findings(),
            declaredRenderIntent={key: execution['scene'].get(key) for key in ('weather', 'timeOfDay', 'profile')})
        publish(execution=self.execution_evidence, geometryFingerprint=None,
                geometryFingerprintScope='Invalidated by canonical actor pose update; geometry edit fingerprints include actor transforms.')
        self.refresh()
        return dict(evidence=self.execution_evidence)

    def number(self, payload, key, default=0):
        value = float(payload.get(key, default))
        if not math.isfinite(value):
            raise ValueError(key + ' must be finite')
        return value

    def look(self, payload):
        camera = self.camera
        mode = payload.get('mode')
        dx, dy = self.number(payload, 'dx'), self.number(payload, 'dy')
        offset = camera.location - self.target
        distance = max(offset.length, 0.1)
        if mode == 'home':
            camera.location = self.home_eye
            camera.data.lens = self.home_lens
            camera.data.sensor_fit = self.home_sensor_fit
            camera.data.sensor_height = self.home_sensor_height
            self.target = self.home_target.copy()
        elif mode == 'world':
            if payload.get('frame') != 'simforge-y-up':
                raise ValueError('World camera requires explicit simforge-y-up coordinates in meters')
            eye = self.vector(payload.get('eye'), 3, 'eye')
            target = self.vector(payload.get('target'), 3, 'target')
            fov = self.finite(payload.get('fovYDeg'), 'fovYDeg')
            if not 1 < fov < 179 or sum((a - b) ** 2 for a, b in zip(eye, target)) < 1e-10:
                raise ValueError('World camera requires distinct eye/target and vertical FOV in (1,179)')
            camera.location = self.runner.point(eye)
            self.target = self.runner.point(target)
            camera.data.sensor_fit = 'VERTICAL'
            camera.data.lens = camera.data.sensor_height / (2 * math.tan(math.radians(fov) / 2))
        elif mode == 'orbit':
            radius = distance
            azimuth = math.atan2(offset.y, offset.x) - dx * math.tau
            elevation = max(-math.pi / 2 + 0.02, min(math.pi / 2 - 0.02, math.asin(max(-1, min(1, offset.z / distance))) + dy * math.pi))
            camera.location = self.target + self.Vector((radius * math.cos(elevation) * math.cos(azimuth), radius * math.cos(elevation) * math.sin(azimuth), radius * math.sin(elevation)))
        elif mode == 'pan':
            rotation = camera.matrix_world.to_quaternion()
            height = 2 * distance * math.tan(camera.data.angle_y / 2)
            ratio = self.scene.render.resolution_x / self.scene.render.resolution_y
            shift = rotation @ self.Vector((-dx * height * ratio, dy * height, 0))
            self.target += shift
            camera.location += shift
        elif mode == 'dolly':
            new_distance = min(100000, max(0.2, distance * math.exp(max(-4, min(4, self.number(payload, 'amount'))))))
            camera.location = self.target + offset.normalized() * new_distance
        elif mode == 'frame-selection':
            obj = self.selected()
            if obj is None:
                raise ValueError('Select an object first')
            corners = [obj.matrix_world @ self.Vector(corner) for corner in obj.bound_box]
            center = sum(corners, self.Vector()) / 8
            radius = max((corner - center).length for corner in corners)
            self.target = center
            camera.location = center + offset.normalized() * max(2, radius / math.sin(min(camera.data.angle_x, camera.data.angle_y) / 2) * 1.2)
        else:
            raise ValueError('Unknown look mode: ' + str(mode))
        camera.rotation_mode = 'QUATERNION'
        camera.rotation_quaternion = self.home_rotation if mode == 'home' else (self.target - camera.location).to_track_quat('-Z', 'Y')
        self.render()

    def ray_hit(self, payload):
        if payload.get('frameRevision') != cached()['revision']:
            raise ValueError('The displayed frame is stale; wait for the current render before picking')
        u, v = self.number(payload, 'u'), self.number(payload, 'v')
        if not 0 <= u <= 1 or not 0 <= v <= 1:
            raise ValueError('Pick coordinates must be in [0, 1]')
        camera = self.camera
        self.bpy.context.view_layer.update()
        depsgraph = self.bpy.context.evaluated_depsgraph_get()
        projection = camera.calc_matrix_camera(depsgraph, x=self.scene.render.resolution_x, y=self.scene.render.resolution_y,
                                                scale_x=self.scene.render.pixel_aspect_x, scale_y=self.scene.render.pixel_aspect_y)
        inverse = projection.inverted()
        def unproject(z):
            p = inverse @ self.Vector((u * 2 - 1, 1 - v * 2, z, 1))
            return camera.matrix_world @ (p.xyz / p.w)
        near, far = unproject(-1), unproject(1)
        direction = (far - near).normalized()
        found, point, normal, face, obj, matrix = self.scene.ray_cast(depsgraph, near, direction, distance=(far - near).length)
        if not found:
            return None
        obj = obj.original
        return dict(objectId=obj.get('wb_object_id'), name=obj.name, source=self.source(obj),
                    point=list(point), normal=list(normal), faceIndex=face,
                    vertices=len(obj.data.vertices) if obj.type == 'MESH' else 0,
                    polygons=len(obj.data.polygons) if obj.type == 'MESH' else 0,
                    frame='Blender-z-up-meters')

    def pick(self, payload):
        hit = self.ray_hit(payload)
        for selected in self.bpy.context.selected_objects:
            selected.select_set(False)
        if hit:
            obj = self.bpy.data.objects[hit['name']]
            obj.select_set(True)
            self.bpy.context.view_layer.objects.active = obj
        self.selection = hit

    def measure(self, payload):
        hits = {}
        for key in ('from', 'to'):
            endpoint = payload.get(key)
            if not isinstance(endpoint, dict):
                raise ValueError('Measurement requires from/to image coordinates')
            hit = self.ray_hit(dict(**endpoint, frameRevision=payload.get('frameRevision')))
            if hit is None:
                raise ValueError('Measurement ' + key + ' does not intersect scene geometry')
            hits[key] = hit
        delta = self.Vector(hits['to']['point']) - self.Vector(hits['from']['point'])
        return dict(frameRevision=payload['frameRevision'], metric='euclidean',
                    frame='Blender-z-up-meters', units='m', distance=delta.length,
                    delta=list(delta), endpoints=hits,
                    support='Rendered triangle intersections; not lane travel distance or surveyed road semantics')

    def geometry(self):
        from array import array
        meshes = {}
        objects = {}
        for obj in self.scene.objects:
            mesh = obj.data if obj.type == 'MESH' else None
            if mesh is not None and mesh.name not in meshes:
                digest = hashlib.sha256()
                for collection, attribute, size, kind in ((mesh.vertices, 'co', 3, 'f'), (mesh.edges, 'vertices', 2, 'i'),
                                                          (mesh.loops, 'vertex_index', 1, 'i'), (mesh.polygons, 'loop_total', 1, 'i'),
                                                          (mesh.polygons, 'material_index', 1, 'i')):
                    values = array(kind, [0]) * (len(collection) * size)
                    collection.foreach_get(attribute, values)
                    digest.update(values.tobytes())
                meshes[mesh.name] = dict(hash=digest.hexdigest(), vertices=len(mesh.vertices), polygons=len(mesh.polygons))
            objects[obj.name] = dict(type=obj.type, mesh=mesh.name if mesh else None,
                                     matrix=[float(x) for row in obj.matrix_world for x in row],
                                     materials=[slot.material.name if slot.material else None for slot in obj.material_slots])
        return objects, meshes

    def publish_geometry_fingerprint(self, objects, meshes):
        geometry_objects = {name: record for name, record in objects.items() if record['type'] == 'MESH'}
        digest = hashlib.sha256(json.dumps([geometry_objects, meshes], sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
        publish(geometryFingerprint=digest,
                geometryFingerprintScope='Scene-linked base meshes: names, vertex coordinates, edge/loop topology, polygon material indices, object world transforms and material-slot names. Excludes camera, evaluated modifiers, material shader values and textures.')

    def transaction(self, operation, code=None, base_revision=None):
        if operation == 'undo' and not self.undo:
            raise ValueError('Nothing to undo')
        if operation == 'redo' and not self.redo:
            raise ValueError('Nothing to redo')
        publish(progress='Saving transaction snapshot')
        before = self.snapshot()
        new_artifacts = []
        try:
            self.check_storage()
            if operation == 'edit':
                from geometry_jobs import execute
                _, before_meshes = self.geometry()
                publish(progress='Running confined disposable geometry worker')
                self.last_edit = execute(self, before, code, base_revision)
                if any(self.last_edit[key] for key in ('addedObjects', 'removedObjects', 'changedObjects')):
                    self.geometry_patches.append({key: self.last_edit[key] for key in ('jobId', 'geometryAsset', 'evidenceAsset', 'status')})
                new_artifacts = [self.args.state_dir / (self.last_edit['jobId'] + '.evidence.json'),
                                 self.args.state_dir / (self.last_edit['geometryAsset']['sha256'] + '.geometry.json')]
                after_objects, after_meshes = self.geometry()
                self.last_edit.update(verticesBefore=sum(m['vertices'] for m in before_meshes.values()),
                                      verticesAfter=sum(m['vertices'] for m in after_meshes.values()),
                                      polygonsBefore=sum(m['polygons'] for m in before_meshes.values()),
                                      polygonsAfter=sum(m['polygons'] for m in after_meshes.values()))
                self.publish_geometry_fingerprint(after_objects, after_meshes)
            elif operation == 'undo':
                self.restore(self.undo[-1])
            elif operation == 'redo':
                self.restore(self.redo[-1])
            elif operation == 'reset':
                self.restore(self.baseline)
            self.camera
            self.check_storage()
            self.render()
        except BaseException as exc:
            failure = traceback.format_exc()
            try:
                self.restore(before)
                for artifact in new_artifacts:
                    artifact.unlink(missing_ok=True)
            except BaseException:
                publish(ready=False, progress='Rollback failed; restart required', lastError=failure + '\nROLLBACK FAILURE:\n' + traceback.format_exc())
                raise RuntimeError(cached()['lastError']) from exc
            finally:
                before.unlink(missing_ok=True)
            raise RuntimeError(failure + '\nScene restored to its pre-transaction snapshot.') from exc
        if operation == 'undo':
            self.undo.pop().unlink(missing_ok=True)
            self.redo.append(before)
        elif operation == 'redo':
            self.redo.pop().unlink(missing_ok=True)
            self.undo.append(before)
        else:
            for path in self.redo:
                path.unlink(missing_ok=True)
            self.redo.clear()
            self.undo.append(before)

    def action(self, payload):
        op = payload.get('op')
        publish(lastError=None, progress='Running ' + str(op))
        if op == 'begin-authoring':
            return self.begin_authoring(payload)
        if op == 'export-geometry':
            from geometry_export import export_geometry
            return export_geometry(self, payload)
        if op == 'inspect-asset':
            return self.inspect_asset(payload)
        if op == 'bind-execution':
            return self.bind_execution(payload)
        if op == 'render-frame':
            return self.render_execution_frame(payload)
        if op == 'inspect':
            from geometry_jobs import inspect
            return dict(inspection=dict(baseRevision=cached()['revision'], **inspect(self, payload)))
        if op == 'measure':
            return dict(measurement=self.measure(payload))
        if op == 'pick':
            self.pick(payload)
        elif op == 'look':
            camera = self.camera
            location, rotation, target = camera.location.copy(), camera.rotation_quaternion.copy(), self.target.copy()
            projection = camera.data.lens, camera.data.sensor_fit, camera.data.sensor_height
            try:
                self.look(payload)
            except BaseException:
                camera.location, camera.rotation_quaternion = location, rotation
                camera.data.lens, camera.data.sensor_fit, camera.data.sensor_height = projection
                self.target = target
                raise
        elif op == 'render':
            engine = payload.get('engine', self.engine)
            samples = payload.get('samples', self.samples)
            if engine not in ('eevee', 'cycles'):
                raise ValueError('Engine must be eevee or cycles')
            if not isinstance(samples, int) or isinstance(samples, bool) or not 1 <= samples <= 4096:
                raise ValueError('Samples must be an integer from 1 to 4096')
            old_engine, old_samples = self.engine, self.samples
            self.engine, self.samples = engine, samples
            try:
                self.render()
            except Exception:
                self.engine, self.samples = old_engine, old_samples
                raise
        elif op in ('edit', 'undo', 'redo', 'reset'):
            code = payload.get('code')
            if op == 'edit' and (not isinstance(code, str) or not code.strip()):
                raise ValueError('Edit requires nonempty Python code')
            base_revision = payload.get('baseRevision')
            if type(base_revision) is not int or base_revision != cached()['revision']:
                raise ValueError('Stale or missing baseRevision; inspect/state and retry deliberately')
            self.transaction(op, code, base_revision)
        else:
            raise ValueError('Unknown operation: ' + str(op))
        self.refresh()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--case', default='daylight')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--worker-python', default='/usr/bin/python3')
    parser.add_argument('--worker-timeout', type=int, default=120)
    parser.add_argument('--worker-cpu-seconds', type=int, default=90)
    parser.add_argument('--worker-memory-mib', type=int, default=16384)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    if min(args.worker_timeout, args.worker_cpu_seconds, args.worker_memory_mib) <= 0:
        parser.error('Worker resource limits must be positive')
    args.manifest = args.manifest.resolve()
    args.state_dir = args.state_dir.resolve()
    args.state_dir.mkdir(parents=True, exist_ok=True)
    # Each launch gets its own bounded history, without removing another session's files.
    args.state_dir = args.state_dir / ('session-' + uuid.uuid4().hex)
    args.state_dir.mkdir()
    publish(stateDirectory=str(args.state_dir))
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    server.allowed_hosts = {'127.0.0.1:' + str(args.port), 'localhost:' + str(args.port)}
    server.frame_path = args.state_dir / 'frame.png'
    threading.Thread(target=server.serve_forever, name='workbench-http', daemon=True).start()
    print('Workbench HTTP ready at http://127.0.0.1:' + str(args.port), flush=True)
    try:
        workbench = Workbench(args)
    except BaseException:
        error = traceback.format_exc()
        publish(ready=False, busy=False, progress='Scene loading failed', lastError=error)
        print(error, flush=True)
        workbench = None
    try:
        while True:
            payload, event, result = COMMANDS.get()
            try:
                response = workbench.action(payload)
                publish(busy=False, progress='Ready')
                result.update(ok=True, state=cached(), **(response or {}))
            except BaseException:
                error = traceback.format_exc()
                print(error, flush=True)
                try:
                    workbench.refresh()
                except BaseException:
                    error += '\nSTATE REFRESH FAILURE:\n' + traceback.format_exc()
                publish(busy=False, lastError=error, progress='Action failed' if cached()['ready'] else 'Restart required')
                result.update(ok=False, error=error, state=cached())
            finally:
                event.set()
                COMMANDS.task_done()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
