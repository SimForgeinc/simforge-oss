#!/usr/bin/env python3
"""Run with blender -b --factory-startup --python-exit-code 1 --python FILE -- FLAGS."""
import argparse
import json
import math
import re
import sys
import time
import traceback
from pathlib import Path


def ms(start):
    return (time.perf_counter() - start) * 1000


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--case', required=True)
    parser.add_argument('--engine', choices=('eevee', 'cycles'), required=True)
    parser.add_argument('--camera-count', type=int, choices=(1, 4), required=True)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--frames', type=int, help='Setup-only frame count override')
    parser.add_argument('--repeats', type=int, help='Setup-only repeat count override')
    return parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])


class Runner:
    def __init__(self, args, result):
        import bpy
        from mathutils import Matrix, Quaternion, Vector
        self.bpy, self.Matrix, self.Quaternion, self.Vector = bpy, Matrix, Quaternion, Vector
        self.args, self.result = args, result
        self.basis = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
        self.inverse_basis = self.basis.inverted()
        self.assets, self.actors, self.ids = {}, {}, {}
        self.manifest = json.loads(args.manifest.read_text())
        self.case = next(c for c in self.manifest['cases'] if c['id'] == args.case)
        def source_path(value):
            path = Path(value)
            return str((path if path.is_absolute() else args.manifest.resolve().parent / path).resolve(strict=True))
        for key in ('staticGlbs', 'vegGlbs', 'sourceGroundSources'):
            if key in self.case:
                self.case[key] = [source_path(path) for path in self.case[key]]
        for actor in self.case['actors']:
            actor['assetPath'] = source_path(actor['assetPath'])
        if self.case['lighting'].get('hdriPath'):
            self.case['lighting']['hdriPath'] = source_path(self.case['lighting']['hdriPath'])
        count = args.frames if args.frames is not None else self.manifest['frameCount']
        self.repeats = args.repeats if args.repeats is not None else self.manifest['repeats']
        if count < 1 or count > len(self.case['frames']) or self.repeats < 1:
            raise ValueError('Invalid frame/repeat count; overrides cannot create missing poses')
        self.frames = self.case['frames'][:count]
        self.result.update(renderer=args.engine, version=bpy.app.version_string, caseId=args.case,
                           cameraCount=args.camera_count, manifestPath=str(args.manifest.resolve()))

    def gap(self, capability, reason, **details):
        self.result['unsupportedCapabilities'].append(dict(capability=capability, reason=reason, **details))

    def point(self, value):
        return self.Vector((value[0], -value[2], value[1]))

    def transform(self, position, rotation=(0, 0, 0, 1), scale=1):
        if isinstance(scale, (int, float)):
            scale = (scale, scale, scale)
        q = self.Quaternion((rotation[3], rotation[0], rotation[1], rotation[2]))
        if q.magnitude == 0:
            raise ValueError('Zero actor quaternion')
        q.normalize()
        matrix = self.Matrix.LocRotScale(self.Vector(position), q, self.Vector(scale))
        return self.basis @ matrix @ self.inverse_basis

    def identifier(self, key):
        if key not in self.ids:
            self.ids[key] = len(self.ids) + 1
        return self.ids[key]

    def configure(self):
        bpy = self.bpy
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene = self.scene = bpy.context.scene
        scene.unit_settings.system = 'METRIC'
        scene.unit_settings.scale_length = 1
        scene.render.engine = 'BLENDER_EEVEE' if self.args.engine == 'eevee' else 'CYCLES'
        scene.render.resolution_x = self.manifest['width']
        scene.render.resolution_y = self.manifest['height']
        scene.render.resolution_percentage = 100
        scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
        scene.render.fps = int(self.manifest['fps'])
        scene.render.fps_base = 1
        scene.render.film_transparent = False
        scene.render.use_motion_blur = False
        scene.render.use_compositing = False
        scene.render.use_sequencer = False
        scene.render.use_persistent_data = bool(self.manifest.get('persistentData', False))
        scene.render.image_settings.file_format = 'PNG'
        scene.render.image_settings.color_mode = 'RGB'
        scene.render.image_settings.color_depth = '8'
        scene.render.image_settings.compression = 15
        scene.view_settings.view_transform = 'AgX'
        scene.view_settings.look = 'AgX - Base Contrast'
        scene.view_settings.exposure = self.case['lighting'].get('exposureEv', 0)
        scene.view_settings.gamma = 1
        scene.display_settings.display_device = 'sRGB'
        if self.args.engine == 'eevee':
            scene.eevee.taa_render_samples = 32
            import gpu
            gpu.init()
            self.result['device'] = dict(backend=gpu.platform.backend_type_get(),
                                         vendor=gpu.platform.vendor_get(), name=gpu.platform.renderer_get())
            name = self.result['device']['name'].lower()
            if '5080' not in name:
                raise RuntimeError('Eevee requires the scheduled RTX5080; observed ' + str(self.result['device']))
        else:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            prefs.compute_device_type = 'OPTIX'
            prefs.get_devices_for_type('OPTIX')
            for device in prefs.devices:
                device.use = device.type == 'OPTIX' and '5080' in device.name
            devices = [dict(name=d.name, type=d.type, id=d.id) for d in prefs.devices if d.use]
            if not devices:
                raise RuntimeError('Required RTX5080 OptiX GPU unavailable; CPU fallback prohibited')
            scene.cycles.device = 'GPU'
            scene.cycles.samples = 32
            scene.cycles.use_adaptive_sampling = False
            scene.cycles.use_denoising = True
            scene.cycles.denoiser = 'OPTIX'
            scene.cycles.seed = 0
            scene.cycles.use_animated_seed = False
            self.result['device'] = dict(backend='OPTIX', devices=devices, cpuEnabled=False)
        self.result['config'] = dict(width=scene.render.resolution_x, height=scene.render.resolution_y,
            fps=self.manifest['fps'], frameCount=len(self.frames), repeats=self.repeats,
            warmupFrames=self.manifest['warmupFrames'], samples=32,
            denoise=self.args.engine == 'cycles', seed=0 if self.args.engine == 'cycles' else None,
            viewTransform='AgX', look='AgX - Base Contrast', exposureEv=scene.view_settings.exposure,
            motionBlur=False, depthOfField=False, png=dict(colorMode='RGB', bitDepth=8, compression=15),
            persistentData=scene.render.use_persistent_data,
            physics='frozen manifest poses', setupOverride=self.args.frames is not None or self.args.repeats is not None)
        self.result['timingSemantics'] = {
            'loadMs': 'Scene configuration, GLB import, instantiation, lighting, camera construction and dependency update; excludes Blender process startup.',
            'renderMs': 'Synchronous bpy.ops.render.render wall time, including scene sync, GPU work and render-result readback; not GPU kernel time.',
            'writeMs': 'Render Result save_render wall time including AgX/color conversion, PNG compression and file IO; no fsync.',
            'repeatWallMs': 'All frame updates, camera updates, render and PNG save calls; excludes JSON serialization and diagnostics.',
            'firstFrameMs': 'First camera render before warmup, no PNG save.',
        }

    def import_asset(self, path):
        path = str(Path(path).resolve(strict=True))
        if path in self.assets:
            return self.assets[path]
        bpy = self.bpy
        start = time.perf_counter()
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path, import_pack_images=False,
                                  import_scene_as_collection=False, import_select_created_objects=False)
        objects = [obj for obj in bpy.data.objects if obj not in before]
        # Disable all imported animation, including shape-key and material animation.
        # The importer-created pose is frozen; no implicit first clip keeps playing.
        for obj in objects:
            targets = [obj, obj.data]
            if obj.type == 'MESH':
                targets.append(obj.data.shape_keys)
                for material in obj.data.materials:
                    if material:
                        targets.extend((material, material.node_tree))
            for target in targets:
                if target is not None and hasattr(target, 'animation_data_clear'):
                    target.animation_data_clear()
        bpy.context.view_layer.update()
        # Keep templates unlinked, not hide_render: linked clones must remain visible.
        for obj in objects:
            for collection in list(obj.users_collection):
                collection.objects.unlink(obj)
        self.assets[path] = objects
        self.result.setdefault('imports', []).append(dict(path=path, importMs=ms(start), objects=len(objects)))
        return objects

    def clone_asset(self, templates, key, matrix):
        bpy = self.bpy
        root = bpy.data.objects.new(key, None)
        self.scene.collection.objects.link(root)
        # Unlinked templates (especially after .blend restore) need not have
        # evaluated matrix_world values. Compose their stored hierarchy instead.
        worlds = {}
        def source_world(source):
            if source not in worlds:
                local = source.matrix_basis.copy()
                worlds[source] = (source_world(source.parent) @ source.matrix_parent_inverse @ local
                                  if source.parent is not None else local)
            return worlds[source]
        clones = {}
        for source in templates:
            if source.type in {'LIGHT', 'CAMERA'}:
                self.gap('embeddedCameraOrLight', 'Excluded GLB camera/light; manifest owns these inputs', assetObject=source.name)
                continue
            obj = source.copy()  # Geometry/materials stay shared.
            self.scene.collection.objects.link(obj)
            clones[source] = obj
            obj.pass_index = min(self.identifier(key), 32767)
        for source, obj in clones.items():
            if source.parent in clones:
                obj.parent = clones[source.parent]
            else:
                obj.parent = root
                obj.matrix_parent_inverse.identity()
                obj.matrix_basis = source_world(source)
            for modifier in obj.modifiers:
                if modifier.type == 'ARMATURE' and modifier.object in clones:
                    modifier.object = clones[modifier.object]
        root.matrix_world = matrix
        return root

    def load_geometry(self):
        for index, path in enumerate(self.case['staticGlbs']):
            self.clone_asset(self.import_asset(path), f'static:{index}:{Path(path).name}', self.Matrix.Identity(4))
        for tile, path in enumerate(self.case.get('vegGlbs', [])):
            templates = self.import_asset(path)
            stem = re.sub(r'\.lod\d+$', '', str(Path(path).with_suffix('')))
            sidecar_path = Path(stem + '.instances.json')
            sidecar = json.loads(sidecar_path.read_text())
            names, counts, flat = sidecar['prototypes'], sidecar['counts'], sidecar['transforms']
            if len(names) != len(counts) or len(flat) != 16 * sum(counts):
                raise ValueError(f'Malformed native vegetation sidecar: {sidecar_path}')
            offset = 0
            for name, count in zip(names, counts):
                # Blender's numeric collision suffix grows beyond three digits.
                matches = [o for o in templates if o.name == name or re.sub(r'\.\d{3,}$', '', o.name) == name]
                if len(matches) != 1:
                    raise ValueError(f'Ambiguous/missing vegetation prototype {name} in {path}')
                proto = matches[0]
                subtree = [proto, *proto.children_recursive]
                # Native expansion applies instance * prototype_local, not ancestors.
                ancestor_inverse = proto.parent.matrix_world.inverted() if proto.parent else self.Matrix.Identity(4)
                parts = [(o, ancestor_inverse @ o.matrix_world) for o in subtree if o.type == 'MESH']
                if not parts and count:
                    raise ValueError(f'Vegetation prototype has no geometry: {name}')
                for instance in range(count):
                    values = flat[offset:offset + 16]
                    offset += 16
                    raw = self.Matrix([values[r::4] for r in range(4)])
                    matrix = self.basis @ raw @ self.inverse_basis
                    key = f'veg:{tile}:{name}:{instance}'
                    for source, local in parts:
                        obj = source.copy()
                        self.scene.collection.objects.link(obj)
                        obj.parent = None
                        obj.matrix_world = matrix @ local
                        obj.pass_index = min(self.identifier(key), 32767)
            self.result.setdefault('vegetation', []).append(dict(path=path, sidecar=str(sidecar_path), instances=sum(counts)))
        for actor in self.case['actors']:
            if actor['id'] in self.actors:
                raise ValueError('Duplicate actor ID: ' + actor['id'])
            templates = self.import_asset(actor['assetPath'])
            if actor.get('animationClip') is not None:
                self.gap('selectedAnimationClip', 'Named/indexed animation playback is not implemented; imported pose frozen',
                         actorId=actor['id'], clip=actor['animationClip'])
            self.actors[actor['id']] = (self.clone_asset(templates, 'actor:' + actor['id'], self.Matrix.Identity(4)), actor.get('assetScale', 1))
        if len(self.ids) > 32767:
            self.gap('objectIndexOverflow', 'Blender pass_index limited to 32767; diagnostic ID omitted rather than returning collisions')
        self.result['instanceIds'] = self.ids
        self.result['animationSemantics'] = 'Imported GLB pose frozen, all imported animation disabled; only manifest actor-root transforms change.'

    def lighting(self):
        bpy, light = self.bpy, self.case['lighting']
        world = bpy.data.worlds.new('ManifestWorld')
        self.scene.world = world
        world.use_nodes = True
        background = world.node_tree.nodes.get('Background')
        background.inputs['Color'].default_value = (*light.get('worldColor', [0, 0, 0]), 1)
        background.inputs['Strength'].default_value = light.get('worldStrength', 0)
        if light.get('hdriPath'):
            texture = world.node_tree.nodes.new('ShaderNodeTexEnvironment')
            texture.image = bpy.data.images.load(str(Path(light['hdriPath']).resolve(strict=True)), check_existing=True)
            world.node_tree.links.new(texture.outputs['Color'], background.inputs['Color'])
            self.gap('calibratedHdriOrientation', 'HDRI uses Blender world equirectangular convention, no shared calibrated rotation is specified')
        sun = bpy.data.lights.new('ManifestSun', 'SUN')
        sun.energy = light.get('sunLux', 0) / 683.0
        sun.color = light.get('sunColor', [1, 1, 1])
        sun.angle = math.radians(0.526)
        obj = bpy.data.objects.new('ManifestSun', sun)
        self.scene.collection.objects.link(obj)
        direction = self.point(light['sunDirection'])
        if direction.length == 0:
            raise ValueError('sunDirection cannot be zero')
        obj.rotation_mode = 'QUATERNION'
        obj.rotation_quaternion = direction.to_track_quat('-Z', 'Y')
        bpy.context.view_layer.update()
        actual_direction = obj.matrix_world.to_3x3() @ self.Vector((0, 0, -1))
        direction_error = (actual_direction - direction.normalized()).length
        self.result['appliedLighting'] = dict(sunDirectionBlender=list(actual_direction),
            requestedDirectionBlender=list(direction.normalized()), directionError=direction_error,
            sunEnergyWm2=sun.energy, exposureEv=self.scene.view_settings.exposure)
        if direction_error > 1e-5:
            raise RuntimeError('Blender sun transform did not apply the requested direction')
        for kind, entries in [('POINT', light.get('pointLights', [])), ('SPOT', light.get('spotLights', []))]:
            for index, spec in enumerate(entries):
                data = bpy.data.lights.new(f'Manifest{kind}{index}', kind)
                if 'lumens' not in spec:
                    raise ValueError(f'{kind} light must specify lumens; no implicit photometry fallback')
                data.energy = spec['lumens'] / 683.0
                data.normalize = True
                data.color = spec.get('color', [1, 1, 1])
                data.shadow_soft_size = spec.get('radius', 0.1)
                lamp = bpy.data.objects.new(data.name, data)
                self.scene.collection.objects.link(lamp)
                lamp.location = self.point(spec['position'])
                if kind == 'SPOT':
                    lamp.rotation_mode = 'QUATERNION'
                    lamp.rotation_quaternion = self.point(spec['direction']).to_track_quat('-Z', 'Y')
                    data.spot_size = math.radians(spec['outerAngleDeg']) * 2
                    data.spot_blend = 1 - spec.get('innerAngleDeg', 0) / spec['outerAngleDeg']
        self.result['lighting'] = light
        self.gap('calibratedPhotometry', 'sunLux/683 -> W/m²; point/spot lumens/683 -> W (555nm luminous efficacy approximation). Colored spectra, world strength, AgX and native exposure are not radiometrically calibrated; sunDirection denotes light propagation.')
        self.cameras = {}
        for camera in self.frames[0]['cameras']:
            sensor = camera['sensorId']
            if not re.fullmatch(r'[A-Za-z0-9_-]+', sensor):
                raise ValueError('Unsafe sensorId: ' + sensor)
            data = bpy.data.cameras.new(sensor)
            data.type = 'PERSP'
            data.sensor_fit = 'VERTICAL'
            data.sensor_height = 24
            data.clip_start = camera.get('near', 0.1)
            data.clip_end = camera.get('far', 10000)
            data.dof.use_dof = False
            obj = bpy.data.objects.new(sensor, data)
            self.scene.collection.objects.link(obj)
            self.cameras[sensor] = obj

    def apply_frame(self, frame):
        start = time.perf_counter()
        poses = {actor['id']: actor for actor in frame['actors']}
        if set(poses) != set(self.actors):
            raise ValueError('Frame actor set differs from declared actors')
        for identity, (root, scale) in self.actors.items():
            actor = poses[identity]
            root.matrix_world = self.transform(actor['position'], actor['rotation'], scale)
        for spec in frame['cameras']:
            camera = self.cameras[spec['sensorId']]
            eye, target = self.point(spec['eye']), self.point(spec['target'])
            camera.location = eye
            camera.rotation_mode = 'QUATERNION'
            camera.rotation_quaternion = (target - eye).to_track_quat('-Z', 'Y')
            camera.data.lens = camera.data.sensor_height / (2 * math.tan(math.radians(spec['fovDeg']) / 2))
        self.bpy.context.view_layer.update()
        return ms(start)

    def selected_cameras(self, frame):
        cameras = frame['cameras']
        if self.args.camera_count == 1:
            cameras = [camera for camera in cameras if camera['sensorId'] == 'front']
        if len(cameras) != self.args.camera_count:
            raise ValueError('Manifest does not contain requested camera set')
        return cameras

    def render(self, sensor, path=None):
        start = time.perf_counter()
        self.scene.camera = self.cameras[sensor]
        camera_ms = ms(start)
        start = time.perf_counter()
        self.bpy.ops.render.render(write_still=False)
        render_ms = ms(start)
        write_ms = 0.0
        if path is not None:
            start = time.perf_counter()
            path.parent.mkdir(parents=True, exist_ok=True)
            self.bpy.data.images['Render Result'].save_render(str(path), scene=self.scene)
            write_ms = ms(start)
        return dict(cameraUpdateMs=camera_ms, renderMs=render_ms, writeMs=write_ms)

    def diagnostics(self):
        start = time.perf_counter()
        frame = self.frames[len(self.frames) // 2]
        self.apply_frame(frame)
        layer = self.bpy.context.view_layer
        layer.use_pass_z = True
        has_ids = self.args.engine == 'cycles' and len(self.ids) <= 32767
        layer.use_pass_object_index = has_ids
        if not has_ids:
            self.gap('objectIdDiagnostic', 'Eevee has no native IndexOB pass, or scene exceeds Blender pass_index range; no RGB surrogate emitted')
        settings = self.scene.render.image_settings
        settings.media_type = 'MULTI_LAYER_IMAGE'
        settings.file_format = 'OPEN_EXR_MULTILAYER'
        settings.color_mode = 'RGBA'
        settings.color_depth = '32'
        settings.exr_codec = 'ZIP'
        diagnostic = dict(frameIndex=frame['index'], outsideRgbTiming=True, files=[],
                          format='32-bit float lossless ZIP multilayer OpenEXR',
                          depthSemantics='Depth/Z: Blender camera-ray distance in scene meters, first visible surface, un-antialiased; background uses renderer far sentinel. Not camera-axis z.',
                          idSemantics='IndexOB: non-antialiased model instance pass_index; 0 background, lookup in instanceIds. Static ID is per GLB, vegetation per sidecar instance, actor per actor ID.' if has_ids else None)
        self.result['diagnostic'] = diagnostic
        for spec in self.selected_cameras(frame):
            path = self.args.out / 'diagnostic' / (spec['sensorId'] + '.exr')
            timing = self.render(spec['sensorId'], path)
            diagnostic['files'].append(dict(sensorId=spec['sensorId'], path=str(path), **timing))
        diagnostic['wallMs'] = ms(start)

    def run(self):
        start = time.perf_counter()
        self.configure()
        self.load_geometry()
        self.lighting()
        self.bpy.context.view_layer.update()
        self.result['loadMs'] = ms(start)
        self.apply_frame(self.frames[0])
        sensor = self.selected_cameras(self.frames[0])[0]['sensorId']
        self.result['firstFrameMs'] = self.render(sensor)['renderMs']
        for index in range(self.manifest['warmupFrames']):
            start = time.perf_counter()
            frame = self.frames[index % len(self.frames)]
            self.apply_frame(frame)
            for spec in self.selected_cameras(frame):
                self.render(spec['sensorId'])
            self.result['warmupMs'].append(ms(start))
        for repeat_index in range(self.repeats):
            repeat = dict(index=repeat_index, frames=[])
            self.result['repeats'].append(repeat)
            start = time.perf_counter()
            for frame in self.frames:
                update_ms = self.apply_frame(frame)
                for camera_index, spec in enumerate(self.selected_cameras(frame)):
                    path = self.args.out / f'repeat-{repeat_index}' / spec['sensorId'] / f"frame-{frame['index']:04d}.png"
                    timing = self.render(spec['sensorId'], path)
                    repeat['frames'].append(dict(frameIndex=frame['index'], timeS=frame['timeS'],
                        sensorId=spec['sensorId'], frameUpdateMs=update_ms if camera_index == 0 else 0,
                        rgbPath=str(path), **timing))
            repeat['wallMs'] = ms(start)
            save_result(self.args.out, self.result)
        try:
            self.diagnostics()
        except Exception as exc:
            self.gap('depthIdDiagnostic', f'Diagnostic failed outside measured RGB runs: {exc}', traceback=traceback.format_exc())
        self.result['status'] = 'ok'


def save_result(out, result):
    temporary = out / 'result.json.tmp'
    temporary.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    temporary.replace(out / 'result.json')


def main():
    args = arguments()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    result = dict(schema='simforge.renderer-bakeoff-result/v1', status='running',
                  renderer=args.engine, errors=[], unsupportedCapabilities=[], warmupMs=[], repeats=[])
    save_result(args.out, result)
    start = time.perf_counter()
    try:
        Runner(args, result).run()
    except Exception as exc:
        result['status'] = 'error'
        result['errors'].append(dict(type=type(exc).__name__, message=str(exc), traceback=traceback.format_exc()))
        raise
    finally:
        result['scriptWallMs'] = ms(start)
        save_result(args.out, result)


if __name__ == '__main__':
    main()
