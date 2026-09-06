"""Trusted parent-side worker orchestration and inert-data application."""
import hashlib
import json
import os
import shutil
import signal
import subprocess
import uuid
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()

def source_identity(path, content_digest):
    uri_digest = hashlib.sha256(Path(path).resolve().as_uri().encode()).hexdigest()
    return 'source:' + content_digest + ':' + uri_digest

def log_tail(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.lseek(fd, max(0, os.fstat(fd).st_size - 32768), os.SEEK_SET)
        return os.read(fd, 32768).decode('utf-8', errors='replace')
    finally:
        os.close(fd)

def output_size(root):
    total = count = 0
    pending = [root]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                count += 1
                if count > 4096:
                    raise RuntimeError('Worker output file-count limit exceeded')
                if entry.is_dir(follow_symlinks=False):
                    pending.append(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
                if total > 2 * 1024**3:
                    raise RuntimeError('Worker output storage limit exceeded')

def initialize(workbench):
    bpy = workbench.bpy
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    paths = {str(workbench.args.manifest)}
    case = workbench.runner.case
    paths.update(case.get('staticGlbs', []))
    paths.update(case.get('vegGlbs', []))
    paths.update(a['assetPath'] for a in case.get('actors', []))
    paths.update(item['sidecar'] for item in workbench.runner.result.get('vegetation', []))
    if case['lighting'].get('hdriPath'):
        paths.add(case['lighting']['hdriPath'])
    for image in bpy.data.images:
        if image.source == 'FILE' and image.filepath:
            path = Path(bpy.path.abspath(image.filepath)).resolve()
            if path.is_file():
                paths.add(str(path))
        image['wb_image_id'] = uuid.uuid4().hex
    workbench.source_artifacts = []
    workbench.source_by_path = {}
    for path in sorted({str(Path(value).resolve()) for value in paths}):
        content_digest = sha(path)
        identity = source_identity(path, content_digest)
        workbench.source_artifacts.append({'id': identity, 'uri': Path(path).as_uri(), 'sha256': content_digest})
        workbench.source_by_path[path] = identity
    for obj in workbench.scene.objects:
        obj['wb_object_id'] = uuid.uuid4().hex
        obj['wb_original_name'] = obj.name
    for group in (bpy.data.meshes, bpy.data.materials):
        for item in group:
            item['wb_original_name'] = item.name

def inspect(workbench, payload):
    offset, limit = payload.get('offset', 0), payload.get('limit', 100)
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError('Inspect requires offset >= 0 and limit 1..1000')
    selected = payload.get('objectIds')
    if selected is not None and (not isinstance(selected, list) or any(not isinstance(x, str) for x in selected)):
        raise ValueError('objectIds must be a string array')
    depsgraph = workbench.bpy.context.evaluated_depsgraph_get()
    objects = sorted((o for o in workbench.scene.objects if selected is None or o.get('wb_object_id') in selected), key=lambda o: o['wb_object_id'])
    result = []
    for obj in objects[offset:offset + limit]:
        evaluated = obj.evaluated_get(depsgraph)
        bounds = [evaluated.matrix_world @ workbench.Vector(c) for c in evaluated.bound_box] if obj.type == 'MESH' else []
        source = workbench.source(obj)
        result.append(dict(objectId=obj['wb_object_id'], name=obj.name, type=obj.type, sourceId=workbench.source_by_path.get(source), sourceUri=Path(source).as_uri() if source else None,
            worldBounds={'min': [min(c[i] for c in bounds) for i in range(3)], 'max': [max(c[i] for c in bounds) for i in range(3)]} if bounds else None,
            matrixWorld=[list(row) for row in obj.matrix_world], vertices=len(obj.data.vertices) if obj.type == 'MESH' else 0, polygons=len(obj.data.polygons) if obj.type == 'MESH' else 0,
            materials=[s.material.name if s.material else None for s in obj.material_slots]))
    return dict(frame={'axes': 'blender-z-up', 'units': 'm'}, sourceArtifacts=workbench.source_artifacts, objects=result, total=len(objects), offset=offset)

def execute(workbench, snapshot, code, base_revision):
    args = workbench.args
    job_id = uuid.uuid4().hex
    job = args.state_dir / ('job-' + job_id)
    job.mkdir(mode=0o700)
    output = job / 'out'
    output.mkdir()
    for name in ('home', 'tmp', 'cache'):
        (output / name).mkdir()
    selected = workbench.selected()
    request = dict(jobId=job_id, snapshot=str(snapshot), selected=selected.name if selected else None,
        hit=workbench.selection.get('point') if workbench.selection else None, code=code, baseRevision=base_revision, output=str(output / 'geometry.json'))
    request_path = job / 'request.json'
    request_path.write_text(json.dumps(request, allow_nan=False))
    binary = Path(workbench.bpy.app.binary_path).resolve(strict=True)
    command = [str(binary), '--background', '--factory-startup', '--disable-autoexec', '-noaudio', '--threads', '1', '--python-exit-code', '1', '--python', str(ROOT / 'geometry_worker.py'), '--', str(request_path)]
    reads = [str(ROOT)]
    reads += [str(snapshot), str(request_path), str(binary)]
    if binary.parent not in {Path('/usr/bin'), Path('/bin')}:
        reads.append(str(binary.parent))
    reads += [str(Path(p).resolve()) for p in ('/usr/lib', '/usr/local/lib', '/lib', '/lib64', '/usr/share/blender', '/usr/share/fonts', '/usr/share/fontconfig', '/usr/share/locale', '/etc/fonts', '/etc/ld.so.cache', '/dev/null', '/dev/urandom', '/proc/cpuinfo', '/proc/meminfo', '/sys/devices/system/cpu') if Path(p).exists()]
    launch = job / 'launch.json'
    launch.write_text(json.dumps(dict(readPaths=reads, output=str(output), command=command, cpuSeconds=args.worker_cpu_seconds, memoryBytes=args.worker_memory_mib * 1024**2)))
    environment = dict(PATH='/usr/bin:/bin', LANG='C.UTF-8', HOME=str(output / 'home'), TMPDIR=str(output / 'tmp'), XDG_CACHE_HOME=str(output / 'cache'), PYTHONNOUSERSITE='1', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1')
    log = output / 'worker.log'
    written = []
    try:
        with log.open('wb') as stream:
            child = subprocess.Popen([args.worker_python, str(ROOT / 'guarded_blender.py'), str(launch)], stdin=subprocess.DEVNULL, stdout=stream, stderr=stream, env=environment, close_fds=True, start_new_session=True)
            try:
                deadline = time.monotonic() + args.worker_timeout
                while True:
                    output_size(output)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError('Geometry worker wall-time limit exceeded')
                    try:
                        status = child.wait(timeout=min(0.2, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        pass
            except BaseException:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                raise
        if status:
            raise RuntimeError('Geometry worker failed (no scene changes): ' + log_tail(log))
        path = output / 'geometry.json'
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 256 * 1024**2:
            raise ValueError('Worker output missing, unsafe, or exceeds 256 MiB')
        patch = json.loads(path.read_text(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite JSON')))
        if patch.get('schema') != 'simforge.blender-geometry/v1' or patch.get('baseRevision') != base_revision or patch.get('jobId') != job_id:
            raise ValueError('Worker patch identity/revision mismatch')
        evidence = apply(workbench, patch)
        actual_patch = evidence.pop('_actualPatch')
        geometry_bytes = json.dumps(actual_patch, sort_keys=True, allow_nan=False, separators=(',', ':')).encode()
        geometry_hash = hashlib.sha256(geometry_bytes).hexdigest()
        geometry_path = args.state_dir / (geometry_hash + '.geometry.json')
        geometry_path.write_bytes(geometry_bytes)
        written.append(geometry_path)
        evidence['geometryAsset'] = {'uri': geometry_path.as_uri(), 'sha256': geometry_hash, 'kind': 'mesh', 'format': 'simforge.blender-geometry/v1'}
        evidence.update(jobId=job_id, baseRevision=base_revision, sourceArtifacts=workbench.source_artifacts, output=log_tail(log))
        evidence_path = args.state_dir / (job_id + '.evidence.json')
        evidence_path.write_text(json.dumps(evidence, allow_nan=False, indent=2))
        written.append(evidence_path)
        evidence['evidenceAsset'] = {'uri': evidence_path.as_uri(), 'sha256': sha(evidence_path)}
        return evidence
    except BaseException as error:
        failure = args.state_dir / (job_id + '.failure.json')
        failure.write_text(json.dumps(dict(jobId=job_id, baseRevision=base_revision, code=code,
            error=str(error), workerLog=log_tail(log) if log.exists() else None,
            nativeReports={str(p.relative_to(output)): log_tail(p) for p in output.glob('**/*.crash.txt') if not p.is_symlink() and p.is_file()}),
            allow_nan=False, indent=2))
        for artifact in written:
            artifact.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(job)

def apply(workbench, patch):
    from geometry_data import object_data, create_object, digest
    bpy = workbench.bpy
    current = {obj['wb_object_id']: obj for obj in workbench.scene.objects}
    changed, removed = patch['changed'], patch['removed']
    if not isinstance(changed, list) or not isinstance(removed, list):
        raise ValueError('Invalid patch collections')
    if len(changed) > 1000:
        raise ValueError('A geometry transaction may change at most 1000 objects')
    from geometry_validation import validate
    for item in changed:
        validate(item)
    ids = [item['id'] for item in changed]
    if any(not isinstance(key, str) or not key or len(key) > 200 for key in ids + removed) or len(set(ids + removed)) != len(ids + removed):
        raise ValueError('Duplicate/invalid patch handles')
    if any(key not in current or current[key].type not in {'MESH', 'EMPTY'} for key in removed):
        raise ValueError('Unknown/nongeometry removal')
    images = {image['wb_image_id']: image for image in bpy.data.images if image.get('wb_image_id')}
    mesh_cache, material_cache = {}, {}
    before_records = {}
    for item in changed:
        old = current.get(item['id'])
        if old is not None:
            record = object_data(old)
            before_records[item['id']] = record
            if old.type == 'MESH':
                mesh_cache[digest([record['mesh'], record['materials']])] = old.data
                for slot, material in zip(old.material_slots, record['materials']):
                    material_cache[digest(material)] = slot.material
    staged = {}
    changed = [item for item in changed if item['id'] not in before_records or digest(item) != digest(before_records[item['id']])]
    removed_evidence = [{'objectId': key, 'beforeSha256': digest(object_data(current[key])), 'name': current[key].name} for key in removed]
    evidence = []
    for item in changed:
        key = item['id']
        old = current.get(key)
        if old is not None and old.type not in {'MESH', 'EMPTY'}:
            raise ValueError('Cannot replace a nongeometry object')
        before = before_records.get(key)
        obj = create_object(bpy, item, images, mesh_cache, material_cache)
        # Re-encode actual Blender data, not worker assertions, for evidence.
        actual = object_data(obj)
        if old:
            for name in old.keys():
                if name.startswith('wb_') and name not in {'wb_object_id', 'wb_original_name'}:
                    obj[name] = old[name]
        staged[key] = obj
        evidence.append(dict(objectId=key, beforeSha256=digest(before) if before else None, afterSha256=digest(actual),
            beforeMeshSha256=digest(before['mesh']) if before and before['mesh'] else None, afterMeshSha256=digest(actual['mesh']) if actual['mesh'] else None,
            beforeMaterialsSha256=digest(before['materials']) if before else None, afterMaterialsSha256=digest(actual['materials']), name=item['name']))
    final_ids = (set(current) - set(removed)) | set(staged)
    for item in changed:
        if item['parent'] is not None and (item['parent'] not in final_ids or item['parent'] == item['id']):
            raise ValueError('Invalid geometry parent')
    parents = {key: obj.parent.get('wb_object_id') if obj.parent else None for key, obj in current.items() if key in final_ids}
    parents.update({item['id']: item['parent'] for item in changed})
    for key in final_ids:
        seen = set()
        cursor = key
        while cursor in parents:
            if cursor in seen:
                raise ValueError('Cyclic geometry parent graph')
            seen.add(cursor)
            cursor = parents[cursor]
    # A scene snapshot surrounds the entire operation, including render. Untouched
    # objects stay the exact original Blender datablocks; child world poses survive.
    child_parents = [(obj, obj.parent.get('wb_object_id'), obj.matrix_world.copy()) for obj in current.values() if obj.parent and obj['wb_object_id'] not in staged and obj['wb_object_id'] not in removed]
    for key, obj in staged.items():
        old = current.get(key)
        collections = list(old.users_collection) if old else [workbench.scene.collection]
        for collection in collections:
            collection.objects.link(obj)
    for key in set(staged) | set(removed):
        if key in current:
            bpy.data.objects.remove(current[key], do_unlink=True)
    final = {obj['wb_object_id']: obj for obj in workbench.scene.objects}
    for item in changed:
        obj = staged[item['id']]
        obj.name = item['name']
        obj.parent = final.get(item['parent'])
        obj.matrix_world = workbench.Matrix(item['matrix'])
    for obj, parent_id, matrix in child_parents:
        obj.parent = final.get(parent_id)
        obj.matrix_world = matrix
    bpy.context.view_layer.update()
    actual_records = []
    for item in evidence:
        actual = object_data(final[item['objectId']])
        actual_records.append(actual)
        item.update(afterSha256=digest(actual), afterMeshSha256=digest(actual['mesh']) if actual['mesh'] else None, afterMaterialsSha256=digest(actual['materials']))
        obj = final[item['objectId']]
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        corners = [evaluated.matrix_world @ workbench.Vector(c) for c in evaluated.bound_box] if obj.type == 'MESH' else []
        item['worldBounds'] = {'min': [min(c[i] for c in corners) for i in range(3)], 'max': [max(c[i] for c in corners) for i in range(3)]} if corners else None
        item['sourceId'] = workbench.source_by_path.get(workbench.source(obj))
    return dict(addedObjects=sum(key not in current for key in staged), removedObjects=len(removed), changedObjects=sum(key in current for key in staged),
        addedNames=[item['name'] for item in changed if item['id'] not in current], changedNames=[item['name'] for item in changed if item['id'] in current], removedObjectIds=removed,
        changedObjectEvidence=evidence, removedObjectEvidence=removed_evidence, patchSha256=digest(patch), status='visual-only',
        frame={'axes': 'blender-z-up', 'units': 'm'}, requiredEffects=['bounds', 'ground', 'collision', 'occlusion', 'driveability'], satisfiedEffects=[],
        _actualPatch=dict(schema='simforge.blender-geometry/v1', baseRevision=patch['baseRevision'], jobId=patch['jobId'], changed=actual_records, removed=removed))
