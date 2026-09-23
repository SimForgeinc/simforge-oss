"""Serve registered teacher/student checkpoints over the negotiated v3 bench wire."""
from __future__ import annotations

import argparse
import io
import json
import socketserver
import struct
import time
from pathlib import Path

import msgpack
import numpy as np
import torch
from simforge_policy_endpoint import capabilities, receipt

from .config import sha256
from .model import FORMAT as TEACHER_FORMAT, Teacher, observations
from .store import resolve


def native_observation(obs: dict) -> tuple[np.ndarray, np.ndarray]:
    state = np.asarray(obs.get('state_vector'), dtype=np.float32)
    raw = np.asarray(obs.get('objects', []), dtype=np.float32)
    if state.shape != (10,) or not np.isfinite(state).all():
        raise ValueError('act requires the real native state_vector[10]')
    if raw.size == 0:
        raw = np.empty((0, 5), dtype=np.float32)
    if raw.ndim != 2 or raw.shape[1] != 5 or not np.isfinite(raw).all():
        raise ValueError('act objects must be finite [range,bearing,range_rate,LOS,valid] rows')
    objects = np.zeros((64, 5), dtype=np.float32)
    objects[:min(64, len(raw))] = raw[:64]
    return state[None], objects[None]


def main() -> None:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--checkpoint', required=True, help='model-store run/update ref or checkpoint path')
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--threads', type=int, default=2)
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    checkpoint, entry = resolve(args.checkpoint)
    payload = torch.load(checkpoint, map_location=args.device, weights_only=True)
    is_teacher = payload.get('format') == TEACHER_FORMAT
    if is_teacher:
        model = Teacher(payload['hidden']).to(args.device)
    else:
        from .student import FORMAT, Student, image_tensor, navigation
        from PIL import Image
        if payload.get('format') != FORMAT:
            raise ValueError(f'unsupported checkpoint format {payload.get("format")!r}')
        model = Student(imagenet=False).to(args.device)
    model.load_state_dict(payload['model'], strict=True)
    model.eval()
    digest = sha256(checkpoint)
    metadata = payload['metadata']
    hello = {'family': 'simforge-policy', 'revision': entry['revision'] if entry else f"update-{metadata['update']:06d}",
             'checkpoint_digest': digest, 'obsPreset': 'visible' if is_teacher else 'cams:student-front',
             'actionHead': 'setpoint' if is_teacher else 'control', 'recipe': 'ppo-teacher' if is_teacher else 'distill-student',
             'device': args.device, 'torch': str(torch.__version__), 'env_steps': metadata.get('env_steps', 0), 'update': metadata['update'],
             **capabilities(cameras=not is_teacher, ego_steps=0 if is_teacher else 2, camera_frames=0 if is_teacher else 1, horizon_s=0.1, hz=10, frame='control'),
             'promoted': False}

    class Handler(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            hidden = None  # Recurrent state belongs to this connection, never the server/model.
            while True:
                header = self.rfile.read(4)
                if len(header) != 4:
                    return
                length = struct.unpack('<I', header)[0]
                if length > 256 * 1024 * 1024:
                    return
                data = self.rfile.read(length)
                if len(data) != length:
                    return
                try:
                    request = msgpack.unpackb(data, raw=False)
                    op = request.get('op')
                    if op == 'hello':
                        hidden = None
                        result = hello
                    elif op == 'reset':
                        hidden = None
                        result = {'reset': True}
                    elif op == 'act':
                        started = time.perf_counter()
                        obs = request['obs']
                        with torch.inference_mode():
                            if is_teacher:
                                state, objects = native_observation(obs)
                                action = model.deterministic(*observations(state, objects, args.device))[0].cpu().numpy()
                                command = {'targetSpeedMps': float(action[0]), 'targetAccelerationMps2': float(action[1])}
                            else:
                                cameras = obs.get('cameras', [])
                                if len(cameras) != 1 or not cameras[0].get('frames'):
                                    raise ValueError('student requires exactly one current real front camera frame')
                                camera = cameras[0]
                                frame = camera['frames'][-1]
                                if camera.get('encoding') == 'raw':
                                    image = Image.frombytes('RGB', (int(camera['width']), int(camera['height'])), frame)
                                else:
                                    image = Image.open(io.BytesIO(frame))
                                rgb = image_tensor(image)[None, None].to(args.device)
                                motion = torch.tensor(obs['motion'], dtype=torch.float32, device=args.device)[None, None]
                                nav = torch.from_numpy(navigation(obs['route']['points'], obs['pose']))[None, None].to(args.device)
                                output, hidden = model(rgb, motion, nav, hidden)
                                action = output[0, 0].cpu().numpy()
                                command = {'control': {'throttle': max(float(action[0]), 0.0), 'brake': max(-float(action[0]), 0.0), 'steer': float(action[1])}}
                        if not np.isfinite(action).all():
                            raise FloatingPointError('checkpoint produced a non-finite action')
                        result = {'action': command, **receipt(obs, command, horizon_s=0.1),
                                  'timings': {'infer_ms': (time.perf_counter() - started) * 1000},
                                  'extras': {'checkpointSha256': digest, 'update': metadata['update'], 'recipe': hello['recipe']}}
                    else:
                        raise ValueError('supported operations: hello, reset, act')
                    response = {'ok': True, 'result': result}
                except (ValueError, KeyError, TypeError, FloatingPointError) as error:
                    response = {'ok': False, 'error': str(error)}
                encoded = msgpack.packb(response, use_bin_type=True)
                self.wfile.write(struct.pack('<I', len(encoded)) + encoded)
                self.wfile.flush()

    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True

    socket_path = Path(args.socket)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    if socket_path.exists():
        raise FileExistsError(f'refusing to replace existing socket {socket_path}')
    try:
        with Server(str(socket_path), Handler) as server:
            print('READY ' + json.dumps(hello), flush=True)
            server.serve_forever()
    finally:
        socket_path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
