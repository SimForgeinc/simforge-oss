#!/usr/bin/env python3
"""Qualify a real endpoint under an immutable Docker image and host-root sandbox.

Config names an exact image id, Python/server command, exact installed package
versions, a recorded MessagePack {hello, act} fixture, and finite limits.
The sandbox has no network, a read-only root, and size-bounded /tmp. No model
weights or dependencies are downloaded. A failed check still emits a receipt.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import selectors
import socket
import struct
import subprocess
import time

import msgpack


def rpc(connection, request):
    payload = msgpack.packb(request, use_bin_type=True)
    connection.sendall(struct.pack('<I', len(payload)) + payload)
    def receive(count):
        chunks = bytearray()
        while len(chunks) < count:
            part = connection.recv(count - len(chunks))
            if not part:
                raise RuntimeError('endpoint closed during response')
            chunks.extend(part)
        return chunks
    size = struct.unpack('<I', receive(4))[0]
    if size > 256 * 1024 * 1024:
        raise ValueError('oversized endpoint response')
    response = msgpack.unpackb(receive(size), raw=False)
    if not response.get('ok'):
        raise RuntimeError(f'endpoint rejected fixture: {response.get("error")}')
    return response.get('result', response)


def output_identity(result):
    # Timing and allocator telemetry are not policy behavior. Recurrent plans
    # and actual controls/trajectories remain in the compared identity.
    return {key: result[key] for key in ('action', 'controls', 'trajectory', 'trajectories', 'points', 'plan', 'health') if key in result}


def inside(config):
    record = {'schema': 'simforge.policy-qualification/v1', 'qualified': False, 'checks': {}, 'latencyMs': [], 'image': config['image']}
    checks = record['checks']
    processes = []
    try:
        pins = config['dependencies']
        if not pins or any(not isinstance(v, str) or any(c in v for c in '*<>=, ') for v in pins.values()):
            raise ValueError('dependencies must contain exact installed versions, never ranges')
        installed = {dist.metadata['Name']: dist.version for dist in importlib.metadata.distributions()}
        checks['pinnedDependencies'] = {'passed': installed == pins, 'expected': pins, 'installed': installed}
        if installed != pins:
            raise ValueError('installed dependencies differ from qualification pins')
        probe = Path('/simforge-qualification-root-write-probe')
        try:
            probe.write_text('must fail')
        except OSError as error:
            checks['readOnlyRoot'] = {'passed': error.errno == 30, 'errno': error.errno}
        else:
            probe.unlink()
            raise RuntimeError('root is writable')
        with open('/proc/net/route') as stream:
            routes = stream.read().splitlines()[1:]
        checks['offline'] = {'passed': len(routes) == 0}
        scratch = '/tmp/simforge-policy-qualify-scratch'
        fs = os.statvfs(scratch)
        checks['boundedScratch'] = {'passed': fs.f_blocks * fs.f_frsize <= config['scratchMiB'] * 1024 * 1024, 'bytes': fs.f_blocks * fs.f_frsize}
        fixture_bytes = Path(config['fixture']).read_bytes()
        fixture = msgpack.unpackb(fixture_bytes, raw=False)
        record['fixtureSha256'] = hashlib.sha256(fixture_bytes).hexdigest()
        socket_path = scratch + '/policy.sock'
        def launch():
            Path(socket_path).unlink(missing_ok=True)
            command = [part.replace('{socket}', socket_path) for part in config['command']]
            process = subprocess.Popen(command, env={**os.environ, **config.get('env', {}), 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'TMPDIR': scratch, 'PYTHONDONTWRITEBYTECODE': '1'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
            processes.append(process)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + config.get('readinessTimeoutS', 120)
            ready = None
            log = []
            pending = b''
            while time.monotonic() < deadline and process.poll() is None and ready is None:
                if selector.select(0.1):
                    pending += os.read(process.stdout.fileno(), 65536)
                    lines = pending.split(b'\n')
                    pending = lines.pop()
                    for raw in lines:
                        line = raw.decode('utf-8', errors='replace').rstrip()
                        log.append(line)
                        if line.startswith('READY '):
                            ready = line
            selector.close()
            if not ready or not Path(socket_path).is_socket():
                raise RuntimeError(f'no literal READY line plus socket before timeout; log={log[-12:]}')
            record.setdefault('readiness', []).append(ready)
            return process
        def connect():
            client = socket.socket(socket.AF_UNIX)
            client.settimeout(config.get('requestTimeoutS', 120))
            client.connect(socket_path)
            hello = rpc(client, fixture.get('hello', {'op': 'hello'}))
            record['model'] = {key: hello.get(key) for key in ('family', 'revision', 'checkpoint_digest', 'protocol')}
            return client
        def run(client, count=2):
            outputs = []
            for _ in range(count):
                began = time.perf_counter()
                outputs.append(output_identity(rpc(client, fixture['act'])))
                record['latencyMs'].append((time.perf_counter() - began) * 1000)
            return outputs
        server = launch()
        with connect() as client:
            baseline = run(client)
        with connect() as first, connect() as second:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                a, b = pool.submit(run, first), pool.submit(run, second)
                checks['concurrentSessionIsolation'] = {'passed': a.result() == baseline and b.result() == baseline, 'sessions': 2}
        server.terminate()
        server.wait(timeout=15)
        launch()
        with connect() as client:
            checks['restart'] = {'passed': run(client) == baseline}
        checks['readiness'] = {'passed': len(record['readiness']) == 2}
        latencies = sorted(record['latencyMs'])
        record['latency'] = {'p50': latencies[len(latencies) // 2], 'p95': latencies[min(len(latencies) - 1, int(len(latencies) * .95))], 'max': max(latencies), 'samples': len(latencies)}
        checks['latency'] = {'passed': max(latencies) <= config['maxLatencyMs'], 'limitMs': config['maxLatencyMs']}
    except Exception as error:
        record['error'] = f'{type(error).__name__}: {error}'
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        record['peakRssMiB'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
        checks['memory'] = {'passed': record['peakRssMiB'] <= config['maxRssMiB'], 'limitMiB': config['maxRssMiB']}
    required = {'pinnedDependencies', 'readOnlyRoot', 'offline', 'boundedScratch', 'concurrentSessionIsolation', 'restart', 'readiness', 'latency', 'memory'}
    record['qualified'] = not record.get('error') and required <= checks.keys() and all(check['passed'] for check in checks.values())
    return record


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--inside', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if config.get('schema') != 'simforge.policy-qualification-config/v1':
        parser.error('expected simforge.policy-qualification-config/v1')
    if args.inside:
        print('QUALIFICATION_RECEIPT ' + json.dumps(inside(config), allow_nan=False), flush=True)
        return
    if not args.out:
        parser.error('--out is required')
    if not config.get('image', '').startswith('sha256:') or len(config['image']) != 71:
        parser.error('image must be a full immutable local Docker sha256 image id')
    if not Path(config['command'][0]).is_file() or 'python' not in Path(config['command'][0]).name:
        parser.error('command[0] must be the server Python interpreter (not a shell launcher)')
    Path('/tmp/simforge-policy-qualify-scratch').mkdir(exist_ok=True)
    container = f'simforge-policy-qualify-{os.getpid()}-{time.monotonic_ns()}'
    command = ['docker', 'create', '--name', container, '--rm', '--network', 'none', '--read-only', '--pids-limit', '256', '--memory', f'{config["maxRssMiB"] + 1024}m',
               '--mount', 'type=bind,src=/,dst=/host,readonly', '--tmpfs', f'/host/tmp/simforge-policy-qualify-scratch:rw,size={config["scratchMiB"]}m,mode=1777',
               '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'HOME=' + str(Path.home()),
               *[item for key, value in config.get('env', {}).items() for item in ('--env', f'{key}={value}')],
               '--entrypoint', '/usr/sbin/chroot', config['image'], '/host', config['command'][0], str(Path(__file__).resolve()), '--config', str(args.config.resolve()), '--inside']
    try:
        # Complete creation before starting the deadline: killing `docker run`
        # during its create RPC can race cleanup and leave a late Created container.
        result = subprocess.run(command, capture_output=True, text=True, env=os.environ, timeout=60)
        if result.returncode == 0:
            result = subprocess.run(['docker', 'start', '--attach', container], capture_output=True, text=True, timeout=config.get('totalTimeoutS', 600))
        lines = [line for line in result.stdout.splitlines() if line.startswith('QUALIFICATION_RECEIPT ')]
        record = json.loads(lines[-1].split(' ', 1)[1]) if lines else {'schema': 'simforge.policy-qualification/v1', 'qualified': False, 'error': result.stderr or result.stdout, 'checks': {}}
    except subprocess.TimeoutExpired:
        record = {'schema': 'simforge.policy-qualification/v1', 'qualified': False, 'error': 'qualification totalTimeoutS exceeded; owned container removed', 'checks': {}}
    finally:
        # Killing the Docker client alone leaves its server container alive.
        cleanup = subprocess.run(['docker', 'rm', '--force', container], capture_output=True, text=True, timeout=30, check=False)
    record.update(configSha256=hashlib.sha256(args.config.read_bytes()).hexdigest(), command=config['command'], createdAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    record['cleanup'] = {'container': container, 'removed': cleanup.returncode == 0 or 'No such container' in cleanup.stderr}
    record['qualified'] = record['qualified'] and record['cleanup']['removed']
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'qualified': record['qualified'], 'receipt': str(args.out), 'error': record.get('error')}))
    raise SystemExit(0 if record['qualified'] else 1)


if __name__ == '__main__':
    main()
