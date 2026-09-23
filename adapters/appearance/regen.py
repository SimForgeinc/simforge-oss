"""Research-only REGEN ONNX frame filter; never replaces the kernel RGB pass.

Wire: little-endian u32 JSON header length, JSON, then header['bytes'] RGBA.
The checkpoint is external, content-addressed, and never downloaded implicitly.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import socket
import struct
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort


def digest(path: Path) -> str:
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def receive(connection: socket.socket, size: int) -> bytearray:
    result = bytearray(size)
    view = memoryview(result)
    while view:
        count = connection.recv_into(view)
        if count == 0:
            raise EOFError('appearance connection closed')
        view = view[count:]
    return result


class Regen:
    def __init__(self, model: Path):
        # CUDA/cuDNN wheels can be installed without torch. No CPU fallback claim.
        if hasattr(ort, 'preload_dlls'):
            ort.preload_dlls(directory='')
        if 'CUDAExecutionProvider' not in ort.get_available_providers():
            raise RuntimeError('REGEN requires onnxruntime-gpu with CUDAExecutionProvider')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        self.session = ort.InferenceSession(str(model), sess_options=options, providers=[
            ('CUDAExecutionProvider', {'cudnn_conv_algo_search': 'HEURISTIC'}),
        ])
        if self.session.get_providers()[0] != 'CUDAExecutionProvider':
            raise RuntimeError('CUDA initialization failed; refusing CPU fallback')
        self.session.disable_fallback()
        self.input = self.session.get_inputs()[0]
        if self.input.type != 'tensor(float)' or len(self.input.shape) != 4 or self.input.shape[1] != 3:
            raise ValueError('REGEN input must be float32 NCHW RGB')
        self.identity = 'regen-rgb-minus1-plus1-u8-v1:' + digest(model)

    def __call__(self, rgb: np.ndarray) -> np.ndarray:
        height, width, _ = rgb.shape
        expected = self.input.shape
        if any(isinstance(size, int) and size != actual for size, actual in zip(expected, (1, 3, height, width))):
            raise ValueError(f'ONNX input shape {expected} does not match {(1,3,height,width)}; export for the camera resolution')
        image = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None], dtype=np.float32)
        image *= np.float32(2.0 / 255.0)
        image -= np.float32(1.0)
        output = self.session.run(None, {self.input.name: image})[0]
        if output.shape != image.shape or not np.isfinite(output).all():
            raise ValueError('REGEN returned invalid shape or non-finite pixels')
        output = (output[0].transpose(1, 2, 0) + np.float32(1.0)) * np.float32(127.5)
        rgba = np.empty((height, width, 4), dtype=np.uint8)
        rgba[:, :, :3] = np.clip(output, 0, 255).astype(np.uint8)
        rgba[:, :, 3] = 255
        return rgba


def serve(model: Regen, socket_path: Path, metrics_path: Path) -> None:
    previous: dict[str, tuple[int, np.ndarray, np.ndarray]] = {}
    with socket.socket(socket.AF_UNIX) as listener, metrics_path.open('x', buffering=1) as metrics:
        listener.bind(str(socket_path))
        listener.listen(1)
        print('READY ' + json.dumps({'identity': model.identity, 'providers': model.session.get_providers(),
            'onnxruntime': ort.__version__, 'inputShape': model.input.shape}), flush=True)
        connection, _ = listener.accept()
        with connection:
            connection.settimeout(120)
            while True:
                try:
                    size = struct.unpack('<I', receive(connection, 4))[0]
                except EOFError:
                    break
                if size > 65536:
                    raise ValueError('appearance header exceeds 64KiB')
                header = json.loads(receive(connection, size))
                try:
                    if header['schema'] != 'simforge.appearance-filter/v1' or header['identity'] != model.identity:
                        raise ValueError('appearance protocol or checkpoint identity mismatch')
                    width, height, stride = (int(header[key]) for key in ('width', 'height', 'rowStride'))
                    if not (0 < width <= 8192 and 0 < height <= 8192 and width * 4 <= stride <= width * 4 + 255
                            and header['bytes'] == stride * height):
                        raise ValueError('invalid appearance input geometry')
                    payload = receive(connection, header['bytes'])
                    started = time.perf_counter()
                    rgb = np.ndarray((height, width, 4), np.uint8, buffer=payload, strides=(stride, 4, 1))[:, :, :3]
                    enhanced = model(rgb)
                    inference_ms = (time.perf_counter() - started) * 1000
                    sensor, tick = header['sensorId'], header['tick']
                    last = previous.get(sensor)
                    row = {'sensorId': sensor, 'tick': tick, 'width': width, 'height': height,
                        'filterMs': inference_ms, 'rawTemporalL1': None, 'enhancedTemporalL1': None}
                    if last and tick > last[0]:
                        row['rawTemporalL1'] = float(np.abs(rgb.astype(np.float32) - last[1]).mean() / 255)
                        row['enhancedTemporalL1'] = float(np.abs(enhanced[:, :, :3].astype(np.float32) - last[2]).mean() / 255)
                    previous[sensor] = (tick, rgb.copy(), enhanced[:, :, :3].copy())
                    metrics.write(json.dumps(row) + '\n')
                    response = {'ok': True, 'identity': model.identity, 'width': width, 'height': height, 'bytes': enhanced.nbytes}
                    body = json.dumps(response).encode()
                    connection.sendall(struct.pack('<I', len(body)) + body)
                    connection.sendall(memoryview(enhanced).cast('B'))
                except Exception as error:
                    body = json.dumps({'ok': False, 'error': str(error)}).encode()
                    connection.sendall(struct.pack('<I', len(body)) + body)
                    raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--onnx', type=Path, required=True)
    parser.add_argument('--socket', type=Path, required=True)
    parser.add_argument('--metrics', type=Path, required=True)
    args = parser.parse_args()
    model = Regen(args.onnx)
    serve(model, args.socket, args.metrics)


if __name__ == '__main__':
    main()
