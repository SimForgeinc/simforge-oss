"""Prepare native RGB/depth/seg controls, run Cosmos-Transfer2.5, seal exact pairs.

This is an offline dataset pass, never an evaluation sensor or metric authority.
Missing runtime/weights and changed output frame counts fail without a paired
completion manifest. --prepare-only emits inputs/config, not generated samples.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

# Resident renderer/service/src/carla.rs: class byte is RGBA byte 2.
# These are visualization colors for supplied label regions, NOT a claim that
# SimForge labels are Cosmos/SAM2 training labels or instance segmentation.
PALETTE = {0: (0, 0, 0), 1: (70, 70, 70), 4: (220, 20, 60), 7: (128, 64, 128),
           9: (107, 142, 35), 10: (0, 0, 142), 12: (220, 220, 0), 18: (250, 170, 30)}


def digest(file: Path) -> str:
    with file.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def save_json(file: Path, value: object) -> None:
    temporary = file.with_suffix(file.suffix + '.partial')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(file)


def encode_video(file: Path, images, width: int, height: int, fps: float) -> None:
    command = ['ffmpeg', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{width}x{height}',
               '-r', str(fps), '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv444p', str(file)]
    with subprocess.Popen(command, stdin=subprocess.PIPE) as process:
        try:
            for image in images:
                if image.shape != (height, width, 3):
                    raise ValueError('control image dimensions changed within a recording')
                process.stdin.write(np.ascontiguousarray(image, dtype=np.uint8).tobytes())
            process.stdin.close()
            if process.wait() != 0:
                raise RuntimeError(f'ffmpeg failed encoding {file}')
        except BaseException:
            process.kill()
            raise


def prepare(run: Path, out: Path, sensor: str | None, prompt: str) -> tuple[dict, list[dict]]:
    document = json.loads((run / 'run.json').read_text())
    controls = document.get('controls', {})
    if controls.get('depthFormat') != 'reverse-z-f32-le' or controls.get('segFormat') != 'carla-class-id-blue':
        raise ValueError('recorded run needs native controls; record with drive run --record-controls')
    sensor = sensor or 'camera_front_wide_120fov'
    start = document['warmupFrames']
    count = document['steps']
    fps = document['decisionHz']
    if count <= 0:
        raise ValueError('run has no recorded policy frames')
    rows = []
    for step in range(count):
        index = start + step
        row = {'step': step, 'frameIndex': index}
        hashes = {}
        for field, folder, ext, digests in [
            ('raw', 'frames', 'png', document['frameDigests']),
            ('depth', 'frames-depth', 'f32', document['passFrameDigests']['depth']),
            ('seg', 'frames-seg', 'png', document['passFrameDigests']['seg']),
        ]:
            file = run / folder / sensor / f'{index}.{ext}'
            value = digest(file)
            if value != digests[sensor][index]:
                raise ValueError(f'input digest mismatch: {file}')
            row[field] = str(file)
            hashes[field] = value
        row['sha256'] = hashes
        rows.append(row)
    with Image.open(rows[0]['raw']) as first:
        width, height = first.size
    def depth_frames():
        for row in rows:
            frame = np.fromfile(row['depth'], dtype='<f4').reshape(height, width)
            if not np.isfinite(frame).all() or frame.min() < 0 or frame.max() > 1:
                raise ValueError('native depth is not finite normalized reverse-Z')
            yield frame
    # One fixed scaling for the entire clip, never per-frame normalization/flicker.
    # Two streaming reads avoid retaining every depth frame for a long recording.
    depth_max = max(float(frame.max()) for frame in depth_frames())
    if depth_max <= 0:
        raise ValueError('depth control is empty (all far-plane/zero)')
    encode_video(out / 'rgb.mp4', (np.asarray(Image.open(row['raw']).convert('RGB')) for row in rows), width, height, fps)
    depth_images = (np.repeat(np.clip(frame / depth_max * 255, 0, 255).astype(np.uint8)[:, :, None], 3, axis=2) for frame in depth_frames())
    encode_video(out / 'depth.mp4', depth_images, width, height, fps)
    def labels():
        lut = np.zeros((256, 3), dtype=np.uint8)
        for key, color in PALETTE.items():
            lut[key] = color
        for row in rows:
            pixels = np.asarray(Image.open(row['seg']).convert('RGBA'))
            classes = pixels[:, :, 2]
            if not set(np.unique(classes).tolist()) <= PALETTE.keys():
                raise ValueError('seg control contains classes outside the resident CARLA taxonomy')
            yield lut[classes]
    encode_video(out / 'seg.mp4', labels(), width, height, fps)
    spec = {'name': 'simforge-paired', 'video_path': str(out / 'rgb.mp4'), 'prompt': prompt,
            'seed': document['seed'], 'guidance': 3, 'num_steps': 35, 'max_frames': count,
            'resolution': '720', 'keep_input_resolution': True,
            'depth': {'control_path': str(out / 'depth.mp4'), 'control_weight': 0.5},
            'seg': {'control_path': str(out / 'seg.mp4'), 'control_weight': 0.2},
            'edge': {'control_weight': 0.3}}
    save_json(out / 'cosmos-spec.json', spec)
    metadata = {'schema': 'simforge.appearance-inputs/v1', 'status': 'prepared', 'sourceRun': str(run),
                'runJsonSha256': digest(run / 'run.json'), 'traceSha256': digest(run / 'trace.jsonl'),
                'sensorId': sensor, 'fps': fps, 'width': width, 'height': height, 'frames': count,
                'depth': {'encoding': 'reverse-Z / clip max -> uint8 (near bright)', 'clipMax': depth_max, 'metricDepth': False},
                'seg': {'encoding': 'CARLA class byte 2 -> fixed visualization palette', 'palette': PALETTE,
                        'limitation': 'class regions, not SAM2 instance masks; no training-domain equivalence claimed'},
                'controls': {name: {'path': str(out / f'{name}.mp4'), 'sha256': digest(out / f'{name}.mp4')} for name in ('rgb', 'depth', 'seg')},
                'pairs': rows}
    save_json(out / 'inputs.json', metadata)
    return metadata, rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--sensor')
    parser.add_argument('--prompt', default='Photorealistic forward-facing driving camera on an urban road. Preserve the road layout, vehicles, pedestrians, motion and camera viewpoint.')
    parser.add_argument('--cosmos-root', type=Path, default=Path(os.environ.get('SIMFORGE_COSMOS_ROOT', '~/cosmos/cosmos-transfer2.5')).expanduser())
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    run = args.run.resolve()
    out = (args.out or run / 'cosmos').resolve()
    out.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    command = None
    try:
        metadata, rows = prepare(run, out, args.sensor, args.prompt)
        root = args.cosmos_root.resolve()
        python = root / '.venv/bin/python'
        gpus = int(os.environ.get('SIMFORGE_COSMOS_NPROC', '1'))
        command = [str(python)]
        if gpus > 1:
            command += ['-m', 'torch.distributed.run', '--standalone', f'--nproc_per_node={gpus}']
        command += ['examples/inference.py', '-i', str(out / 'cosmos-spec.json'), '-o', str(out / 'generated')]
        save_json(out / 'invocation.json', {'command': command, 'cwd': str(root), 'CUDA_VISIBLE_DEVICES': os.environ.get('CUDA_VISIBLE_DEVICES'),
            'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'guardrails': 'upstream enabled default'})
        if args.prepare_only:
            print(json.dumps({'ok': True, 'status': 'prepared-not-generated', 'frames': len(rows), 'out': str(out)}))
            return 0
        if not python.is_file() or not (root / 'examples/inference.py').is_file():
            raise FileNotFoundError(f'Cosmos runtime absent: need {python} and {root / "examples/inference.py"}; see invocation.json')
        environment = {**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}
        with (out / 'inference.log').open('w') as log:
            subprocess.run(command, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=3600)
        generated = out / 'generated/simforge-paired.mp4'
        if not generated.is_file():
            raise RuntimeError('Cosmos produced no expected generated video (check guardrails/inference.log)')
        probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate',
                                '-of', 'json', str(generated)], capture_output=True, text=True, check=True)
        rate = json.loads(probe.stdout)['streams'][0]['avg_frame_rate']
        numerator, denominator = map(int, rate.split('/'))
        if denominator == 0 or abs(numerator / denominator - metadata['fps']) > 1e-6:
            raise ValueError('Cosmos output frame rate differs from source; refusing retimed pairing')
        enhanced = out / 'frames-enhanced'
        enhanced.mkdir()
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(generated), '-fps_mode', 'passthrough', '-start_number', '0', str(enhanced / '%d.png')], check=True)
        files = list(enhanced.glob('*.png'))
        if len(files) != len(rows):
            raise ValueError(f'Cosmos emitted {len(files)} frames for {len(rows)} inputs; refusing guessed/trimmed/padded pairing')
        for row in rows:
            file = enhanced / f'{row["step"]}.png'
            with Image.open(file) as image:
                if image.size != (metadata['width'], metadata['height']):
                    raise ValueError('Cosmos output geometry differs from source; refusing implicit resize')
            row['enhanced'] = str(file)
            row['sha256']['enhanced'] = digest(file)
        save_json(out / 'paired-manifest.json', {**metadata, 'schema': 'simforge.appearance-pairs/v1', 'status': 'generated',
            'method': 'cosmos-transfer2.5', 'wallSeconds': time.monotonic() - started, 'pairs': rows,
            'generatedVideo': {'path': str(generated), 'sha256': digest(generated)}})
        print(json.dumps({'ok': True, 'status': 'generated', 'frames': len(rows), 'manifest': str(out / 'paired-manifest.json')}))
        return 0
    except Exception as error:
        blocker = {'schema': 'simforge.appearance-blocker/v1', 'status': 'blocked', 'reason': str(error),
                   'exception': type(error).__name__, 'command': command, 'wallSeconds': time.monotonic() - started,
                   'pairedSamples': 0, 'sourceRun': str(run)}
        save_json(out / 'blocker.json', blocker)
        print(json.dumps(blocker), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
