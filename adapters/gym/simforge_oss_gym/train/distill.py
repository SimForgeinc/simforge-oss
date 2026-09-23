"""Behavior cloning from completed bench runs and kernel actuator labels.

A setpoint is NOT a control label. Legacy runs without appliedControl and the
pre-action state/navigation channel are rejected, never reverse-engineered.
"""
from __future__ import annotations

import json
import random
import time
from collections import Counter
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from .config import sha256
from .model import load_checkpoint, observations
from .serve import native_observation
from .store import register, resolve
from .student import FORMAT, OBS_PRESET, Student, image_tensor, navigation


def train(*, out: Path, dataset: dict, options: dict, trainer: dict, provenance: dict) -> None:
    if dataset.get('labels'):
        train_labels(out=out, dataset=dataset, options=options, trainer=trainer, provenance=provenance)
        return
    allowed = {'device', 'seed', 'torch_threads', 'sequence_length', 'epochs', 'learning_rate', 'max_frames'}
    if set(options) - allowed:
        raise ValueError(f'unknown distill options: {sorted(set(options) - allowed)}')
    if not dataset.get('runs') or not dataset.get('teacher'):
        raise ValueError('distill dataset requires runs:[completed bench dirs] and teacher:<checkpoint ref>')
    seed = int(options.get('seed', 42))
    torch.manual_seed(seed)
    random.seed(seed)
    torch.set_num_threads(int(options.get('torch_threads', 4)))
    device = torch.device(options.get('device', 'cpu'))
    maximum = int(options.get('max_frames', 100000))
    sequence = int(options.get('sequence_length', 4))
    epochs = int(options.get('epochs', 1))
    if min(maximum, sequence, epochs) < 1:
        raise ValueError('max_frames, sequence_length and epochs must be positive')
    teacher_path, _ = resolve(dataset['teacher'])
    teacher_sha = sha256(teacher_path)
    teacher, _ = load_checkpoint(teacher_path, 'cpu')
    sensor = dataset.get('sensor', 'camera_front_wide_120fov')
    samples, sequences, sources = [], [], []
    for source in dataset['runs']:
        run = Path(source)
        result = json.loads((run / 'result.json').read_text())
        meta = json.loads((run / 'run.json').read_text())
        if result.get('status') != 'succeeded' or meta.get('model', {}).get('checkpointDigest') != teacher_sha:
            raise ValueError(f'{run}: completed run must have been driven by the exact teacher checkpoint {teacher_sha}; DAgger relabelling is not implemented')
        rows = [json.loads(line) for line in (run / 'steps.jsonl').read_text().splitlines() if line.strip()]
        trace = {row['step']: row for row in (json.loads(line) for line in (run / 'trace.jsonl').read_text().splitlines()) if row.get('phase') == 'policy'}
        start = len(samples)
        for row in rows:
            if len(samples) == maximum:
                break
            obs = row.get('observation')
            if not obs or not row.get('appliedControl'):
                raise ValueError(f'{run} step {row["step"]}: missing pre-action observation/appliedControl; re-render using the current bench and kernel; setpoint-to-control guesses are prohibited')
            native = trace.get(row['step'] + max(0, meta['warmupFrames'] - 1), {})
            if native.get('appliedControl') != row['appliedControl']:
                raise ValueError(f'{run} step {row["step"]}: actuator label does not match kernel trace')
            state, objects = native_observation(obs)
            with torch.inference_mode():
                predicted = teacher.deterministic(*observations(state, objects, 'cpu'))[0].numpy()
            action = row['action']
            if not np.allclose(predicted, [action.get('targetSpeedMps'), action.get('targetAccelerationMps2')], atol=1e-5, rtol=1e-5):
                raise ValueError(f'{run} step {row["step"]}: replayed teacher/state label differs from applied policy; refuses fallback/foreign-policy frames')
            frame_index = meta['warmupFrames'] + row['step']
            frame = run / 'frames' / sensor / f'{frame_index}.png'
            expected = meta.get('frameDigests', {}).get(sensor, [])
            if frame_index >= len(expected) or sha256(frame) != expected[frame_index]:
                raise ValueError(f'{frame}: frame digest missing or mismatched')
            control = row['appliedControl']
            label = [control['throttle'] - control['brake'], control['steer']]
            if not np.isfinite(label).all() or max(abs(v) for v in label) > 1 or control.get('handbrake'):
                raise ValueError(f'{run}: actuator label outside student control contract')
            samples.append((frame, obs['motion'], navigation(obs['route']['points'], obs['pose']), label))
        sequences.extend(list(range(i, min(i + sequence, len(samples)))) for i in range(start, len(samples), sequence))
        sources.append({'run': str(run), 'resultSha256': sha256(run / 'result.json'), 'stepsSha256': sha256(run / 'steps.jsonl'), 'traceSha256': sha256(run / 'trace.jsonl'), 'frames': len(samples) - start})
        if len(samples) == maximum:
            break
    if len(samples) < maximum:
        raise ValueError(f'dataset has {len(samples)} qualified frames, requires {maximum}; provide additional completed teacher run dirs or explicitly lower max_frames')
    model = Student(imagenet=True).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=float(options.get('learning_rate', 0.0001)))
    before = model.control.weight.detach().clone()
    print(f'TRAINER_READY recipe=distill-student frames={len(samples)} device={device} out={out}', flush=True)
    rows = []
    with (out / 'metrics.jsonl').open('x', buffering=1) as stream:
        for epoch in range(1, epochs + 1):
            random.shuffle(sequences)
            total, frames = 0.0, 0
            model.train()
            for ids in sequences:
                rgb = torch.stack([image_tensor(Image.open(samples[i][0])) for i in ids])[None].to(device)
                motion = torch.as_tensor(np.asarray([samples[i][1] for i in ids], dtype=np.float32), device=device)[None]
                nav = torch.as_tensor(np.asarray([samples[i][2] for i in ids]), device=device)[None]
                label = torch.as_tensor([samples[i][3] for i in ids], dtype=torch.float32, device=device)[None]
                predicted, _ = model(rgb, motion, nav)
                loss = torch.nn.functional.smooth_l1_loss(predicted, label)
                if not torch.isfinite(loss):
                    raise FloatingPointError('non-finite student loss; checkpoint refused')
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                total += float(loss.detach()) * len(ids)
                frames += len(ids)
            row = {'update': epoch, 'frames': frames, 'loss': total / frames, 'parameters': sum(p.numel() for p in model.parameters())}
            rows.append(row)
            stream.write(json.dumps(row) + '\n')
            print(json.dumps(row), flush=True)
    if torch.equal(before, model.control.weight):
        raise RuntimeError('student optimization made no parameter update')
    metadata = {**rows[-1], 'env_steps': 0, 'trainer': trainer, 'provenance': {**provenance, 'dataset': sources, 'teacherSha256': teacher_sha, 'initialization': 'ResNet18_Weights.IMAGENET1K_V1'}, 'sequenceLength': sequence}
    checkpoint = out / 'checkpoints' / f'update-{epochs:06d}.pt'
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    temporary = checkpoint.with_suffix('.partial')
    torch.save({'format': FORMAT, 'obs_preset': OBS_PRESET, 'action_head': 'control', 'model': model.state_dict(), 'optimizer': optimizer.state_dict(), 'metadata': metadata}, temporary)
    temporary.replace(checkpoint)
    entry = register(checkpoint, recipe='distill-student', obs_preset=OBS_PRESET, action_head='control', metadata=metadata)
    (out / 'distillation.json').write_text(json.dumps({'schema': 'simforge.distillation/v1', 'frames': len(samples), 'sources': sources, 'metrics': rows, 'checkpoint': entry}, indent=2) + '\n')


class LabelSequences(torch.utils.data.Dataset):
    """Contiguous recurrent windows; their only learned inputs are RGB/motion/nav."""

    def __init__(self, samples: list[dict], sequence: int):
        self.samples = samples
        self.windows = []
        self.groups = []
        start = 0
        while start < len(samples):
            end = start + 1
            while end < len(samples) and samples[end]['episode'] == samples[start]['episode'] and samples[end]['step'] == samples[end - 1]['step'] + 1:
                end += 1
            for first in range(start, end - sequence + 1, sequence):
                self.windows.append(range(first, first + sequence))
                row = samples[first + sequence // 2]
                self.groups.append((row['kind'], row['family'], row['hazardWindow']))
            start = end
        if not self.windows:
            raise ValueError('dataset has no complete recurrent sequences')

    def __len__(self):
        return len(self.windows)

    def __getitem__(self, index):
        rows = [self.samples[i] for i in self.windows[index]]
        rgb = []
        for row in rows:
            with Image.open(row['frame']) as image:
                rgb.append(image_tensor(image))
        return (torch.stack(rgb), torch.tensor([r['motion'] for r in rows], dtype=torch.float32),
                torch.tensor([r['navigation'] for r in rows], dtype=torch.float32),
                torch.tensor([r['label'] for r in rows], dtype=torch.float32))


def replay_weights(groups: list[tuple[str, str, bool]]) -> tuple[torch.Tensor, list[dict]]:
    """Balance family, source and nominal/hazard marginals using real windows.

    A student that exits before reveal has no hazard windows. Its nominal
    windows must be paired with teacher hazard windows, not padded/relabelled
    and not allowed to silently turn a 50/50 replay into a 75/25 replay.
    """
    counts = Counter(groups)
    families = sorted({group[1] for group in counts})
    kinds = {group[0] for group in counts}
    if not families or kinds not in ({'demonstration'}, {'demonstration', 'student-visited'}):
        raise ValueError('replay requires demonstration sequences and optional student sequences')
    factors = {}
    for family in families:
        demonstration = [('demonstration', family, hazard) for hazard in (False, True)]
        if len(kinds) == 1:
            if any(group not in counts for group in demonstration):
                raise ValueError(f'{family}: real nominal and hazard windows are required')
            factors.update({group: 1.0 for group in demonstration})
            continue
        student = [('student-visited', family, hazard) for hazard in (False, True)]
        zero = demonstration[0] not in counts or student[1] not in counts
        one = demonstration[1] not in counts or student[0] not in counts
        if zero and one:
            raise ValueError(f'{family}: observed windows cannot support the registered replay marginals')
        diagonal = 0.0 if zero else 2.0 if one else 1.0
        factors.update({demonstration[0]: diagonal, demonstration[1]: 2.0 - diagonal,
                        student[0]: 2.0 - diagonal, student[1]: diagonal})
    # Identical arithmetic to the original sampler for fully supported BC
    # and DAgger groups, preserving their exact seeded sample streams.
    denominator = 2 * len(families)
    weights = torch.tensor([factors[group] / (counts[group] * denominator) for group in groups], dtype=torch.double)
    mass = {group: factors[group] / denominator for group in counts}
    total = sum(mass.values())
    receipt = [{'kind': group[0], 'family': group[1], 'hazardWindow': group[2],
                'availableSequences': counts[group], 'samplingProbability': value / total}
               for group, value in sorted(mass.items())]
    return weights, receipt


def train_labels(*, out: Path, dataset: dict, options: dict, trainer: dict, provenance: dict) -> None:
    """The same optimizer for offline BC and digest-verified DAgger labels."""
    from .dashboard import render_student_dashboard
    from .student import load_student

    allowed = {'device', 'seed', 'torch_threads', 'sequence_length', 'epochs', 'learning_rate',
               'max_frames', 'presentations', 'batch_sequences', 'loader_workers', 'initial_checkpoint'}
    if set(options) - allowed:
        raise ValueError(f'unknown distill options: {sorted(set(options) - allowed)}')
    seed = int(options.get('seed', 42))
    torch.manual_seed(seed)
    random.seed(seed)
    torch.set_num_threads(int(options.get('torch_threads', 2)))
    device = torch.device(options.get('device', 'cpu'))
    sequence = int(options.get('sequence_length', 4))
    epochs = int(options.get('epochs', 1))
    presentations = int(options.get('presentations', 100000))
    batch_sequences = int(options.get('batch_sequences', 8))
    if min(sequence, epochs, presentations, batch_sequences) < 1 or presentations % sequence:
        raise ValueError('positive budgets required; presentations must be divisible by sequence_length')
    teacher_path, _ = resolve(dataset['teacher'].removeprefix('torch:'))
    teacher_sha = sha256(teacher_path)
    samples, sources = [], []
    for source in dataset['labels']:
        file = Path(source['path'])
        receipt_path = file.with_suffix('.receipt.json')
        receipt = json.loads(receipt_path.read_text())
        if receipt.get('schema') != 'simforge.student-labels/v1' or receipt.get('teacherSha256') != teacher_sha or receipt.get('labelsSha256') != sha256(file):
            raise ValueError(f'{file}: label identity, teacher or digest differs')
        rows = [json.loads(line) for line in file.read_text().splitlines()]
        if len(rows) != receipt['frames']:
            raise ValueError(f'{file}: label accounting differs')
        limit = int(source.get('max_frames', len(rows)))
        if not 0 < limit <= len(rows):
            raise ValueError(f'{file}: selected frame budget outside available labels')
        rows = rows[:limit]
        if source.get('kind') not in ('demonstration', 'student-visited'):
            raise ValueError('label kind must be demonstration or student-visited')
        samples.extend({**row, 'kind': source['kind']} for row in rows)
        sources.append({'path': str(file), 'kind': source['kind'], 'frames': len(rows), 'availableFrames': receipt['frames'], 'receiptSha256': sha256(receipt_path), 'labelsSha256': receipt['labelsSha256']})
    unique = len({row['frame'] for row in samples})
    if unique != len(samples) or unique != int(options.get('max_frames', unique)):
        raise ValueError('unique labeled-frame budget differs or dataset contains duplicate frames')
    data = LabelSequences(samples, sequence)
    weights, replay_balance = replay_weights(data.groups)
    sampler = torch.utils.data.WeightedRandomSampler(weights, presentations // sequence, replacement=True,
                                                   generator=torch.Generator().manual_seed(seed))
    loader = torch.utils.data.DataLoader(data, batch_size=batch_sequences, sampler=sampler,
                                        num_workers=int(options.get('loader_workers', 2)),
                                        pin_memory=device.type == 'cuda')
    initial = options.get('initial_checkpoint')
    prior_presentations, prior_update, payload = 0, 0, None
    if initial:
        checkpoint, _ = resolve(initial.removeprefix('torch:'))
        model, payload = load_student(checkpoint, device)
        prior_presentations = payload['metadata'].get('presentationsTotal', 0)
        prior_update = payload['metadata']['update']
    else:
        model = Student(imagenet=True).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=float(options.get('learning_rate', 0.0001)))
    if payload:
        optimizer.load_state_dict(payload['optimizer'])
        sampler.generator.set_state(payload['sampler_state'].cpu())
        torch.set_rng_state(payload['rng_state'].cpu())
    before = model.control.weight.detach().clone()
    started, processed, updates = time.perf_counter(), 0, 0
    rows = []
    out.mkdir(parents=True, exist_ok=True)
    (out / 'dashboards').mkdir(exist_ok=True)
    print(f'TRAINER_READY recipe=distill-student frames={unique} presentations={presentations * epochs} device={device} out={out}', flush=True)
    with (out / 'metrics.jsonl').open('x', buffering=1) as stream:
        for epoch in range(1, epochs + 1):
            model.train()
            total_loss, epoch_frames = 0.0, 0
            for tensors in loader:
                rgb, motion, nav, labels = (tensor.to(device, non_blocking=True) for tensor in tensors)
                prediction, _ = model(rgb, motion, nav)
                loss = torch.nn.functional.smooth_l1_loss(prediction, labels)
                if not torch.isfinite(loss):
                    raise FloatingPointError('non-finite student loss')
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                frames = labels.shape[0] * sequence
                total_loss += float(loss.detach()) * frames
                epoch_frames += frames
                processed += frames
                updates += 1
                if updates % 100 == 0 or epoch_frames == presentations:
                    elapsed = time.perf_counter() - started
                    row = {'update': updates, 'epoch': epoch, 'seed': seed, 'frames': processed, 'presentationsTotal': prior_presentations + processed,
                           'loss': total_loss / epoch_frames, 'wall_seconds': elapsed, 'frames_per_second': processed / elapsed,
                           'uniqueFrames': unique, 'parameters': sum(p.numel() for p in model.parameters())}
                    rows.append(row)
                    stream.write(json.dumps(row) + '\n')
                    render_student_dashboard(rows, out / 'dashboard.png', out.name)
                    render_student_dashboard(rows, out / 'dashboards' / f'update-{updates:06d}.png', out.name)
                    print(json.dumps(row), flush=True)
            if epoch_frames != presentations:
                raise RuntimeError('optimizer presentation budget was not exactly exercised')
    if torch.equal(before, model.control.weight):
        raise RuntimeError('student optimization made no parameter update')
    metadata = {**rows[-1], 'update': prior_update + epochs, 'env_steps': 0, 'trainer': trainer,
                'provenance': {**provenance, 'dataset': sources, 'teacherSha256': teacher_sha,
                               'initialization': initial or 'ResNet18_Weights.IMAGENET1K_V1'},
                'sequenceLength': sequence, 'seed': seed, 'dataAccounting': dict(Counter(row['kind'] for row in samples)),
                'presentationsStage': processed, 'presentationsTotal': prior_presentations + processed,
                'replayBalance': replay_balance, 'replayBalanceScope': 'equal sequence-group marginals in expectation; finite sampled presentation counts may vary'}
    checkpoint = out / 'checkpoints' / f'update-{metadata["update"]:06d}.pt'
    checkpoint.parent.mkdir(exist_ok=True)
    temporary = checkpoint.with_suffix('.partial')
    torch.save({'format': FORMAT, 'obs_preset': OBS_PRESET, 'action_head': 'control', 'model': model.state_dict(), 'optimizer': optimizer.state_dict(), 'metadata': metadata,
                'sampler_state': sampler.generator.get_state(), 'rng_state': torch.get_rng_state()}, temporary)
    temporary.replace(checkpoint)
    entry = register(checkpoint, recipe='distill-student', obs_preset=OBS_PRESET, action_head='control', metadata=metadata)
    (out / 'distillation.json').write_text(json.dumps({'schema': 'simforge.distillation/v1', 'frames': unique, 'sources': sources, 'metrics': rows, 'metadata': metadata, 'checkpoint': entry}, indent=2) + '\n')
