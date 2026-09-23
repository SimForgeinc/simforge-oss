"""DAgger labels from a render-free native checkpoint at the student's exact state.

The observed action is replayed only after restoring the teacher counterfactual.
No Python controller, reward, termination, or setpoint-to-pedal approximation.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from ..episodes import load_episode_spec
from ..native import EpisodeBatch
from .config import sha256
from .model import load_checkpoint, observations
from .store import resolve
from .student import navigation


def admission_timings(episodes: Path) -> dict[tuple[int, int], dict]:
    document = json.loads(episodes.read_text())
    manifest_path = episodes.parent / document['provenance']['splitManifest']
    manifest = json.loads(manifest_path.read_text())
    timings = {}
    for proof in manifest['admission']['proofs']:
        if proof['status'] != 'admitted':
            continue
        receipt_path = manifest_path.parent / proof['receipt']['path']
        if sha256(receipt_path) != proof['receipt']['sha256']:
            raise ValueError('admission timing receipt digest differs')
        for run in json.loads(receipt_path.read_text())['runs']:
            onsets = [row['tS'] for row in run['benchWindow']['hazardOnsets']]
            margins = [row['revealToConflictS'] for row in run['occlusion']['relations'] if 'revealToConflictS' in row]
            if not onsets:
                raise ValueError('hazard replay requires a measured admission onset')
            timings[(proof['cell'], int(run['seed']))] = {
                'onsetS': min(onsets), 'revealToConflictS': min(margins) if margins else None,
                'receiptSha256': proof['receipt']['sha256']}
    return timings


def relabel(collections: list[Path], teacher_ref: str, out: Path) -> dict:
    teacher_path, _ = resolve(teacher_ref.removeprefix('torch:'))
    teacher, _ = load_checkpoint(teacher_path, 'cpu')
    teacher.eval()
    torch.set_num_threads(2)
    loaded = {}
    sources, frame_count, counterfactuals = [], 0, 0
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('x') as destination:
        for collection in collections:
            doc = json.loads(collection.read_text())
            for item in doc['episodes']:
                directory = Path(item['directory'])
                rollout = json.loads((directory / 'rollout.json').read_text())
                if sha256(directory / 'trace.jsonl') != rollout['traceSha256']:
                    raise ValueError(f'{directory}: native trace digest differs')
                source = rollout['source']
                if source not in loaded:
                    loaded[source] = (load_episode_spec(source), admission_timings(Path(source)))
                episode = loaded[source][0].episodes[rollout['index']]
                timing = loaded[source][1][(rollout['provenance']['cell'], int(rollout['input']['seed']))]
                spec = {**rollout['episodeSpec'], 'observation': {'channels': [{'kind': 'visible'}]}}
                batch = EpisodeBatch([json.dumps(spec)], [episode.graph], 1)
                view = batch.reset_all([int(rollout['input']['seed'])])
                family = rollout['provenance']['replayKey']['templateId']
                frames = 0
                rows = [json.loads(line) for line in (directory / 'steps.jsonl').read_text().splitlines()]
                for row in rows:
                    logged = row['observation']
                    if not np.array_equal(view.state_vector[0], np.asarray(logged['state_vector'], dtype=view.state_vector.dtype)):
                        raise ValueError(f'{directory} step {row["step"]}: replay state diverged')
                    active = view.objects[0][view.objects[0, :, 4] != 0]
                    if not np.array_equal(active, np.asarray(logged['objects'], dtype=active.dtype).reshape(-1, 5)):
                        raise ValueError(f'{directory} step {row["step"]}: replay visible objects diverged')
                    with torch.inference_mode():
                        prediction = teacher.deterministic(*observations(view.state_vector, view.objects, 'cpu'))[0].numpy()
                    teacher_action = {'k': 's', 'speedMps': float(prediction[0]), 'accelerationMps2': float(prediction[1])}
                    checkpoint, digest = batch.checkpoint(), batch.trace_digests()
                    batch.step_all_json(json.dumps([teacher_action]))
                    teacher_step = json.loads(batch.trace_json(0).rstrip().rsplit('\n', 1)[-1])
                    control = teacher_step['appliedControl']
                    label = [control['throttle'] - control['brake'], control['steer']]
                    if not np.isfinite(label).all() or max(abs(v) for v in label) > 1 or control.get('handbrake'):
                        raise ValueError('teacher counterfactual outside student control contract')
                    view = batch.restore(checkpoint)
                    if batch.trace_digests() != digest:
                        raise RuntimeError('counterfactual restore changed native trajectory')
                    view = batch.step_all_json(json.dumps([row['action']]))
                    replay = json.loads(batch.trace_json(0).rstrip().rsplit('\n', 1)[-1])
                    if replay['appliedControl'] != row['appliedControl']:
                        raise ValueError(f'{directory} step {row["step"]}: native actuator replay differs')
                    if rollout['policy'].removeprefix('torch:') == teacher_ref.removeprefix('torch:'):
                        if not np.allclose([row['action']['speedMps'], row['action']['accelerationMps2']], prediction, atol=1e-5, rtol=1e-5) or control != row['appliedControl']:
                            raise ValueError('demonstration did not execute the exact frozen teacher')
                    else:
                        counterfactuals += 1
                    frame = directory / row['frame']
                    if sha256(frame) != row['frameSha256']:
                        raise ValueError(f'{frame}: RGB digest mismatch')
                    # Frozen scripted-admission onset classifies replay windows;
                    # it is not claimed to be the diverged student's observed reveal.
                    sample = {'episode': str(directory), 'step': row['step'], 'frame': str(frame), 'frameSha256': row['frameSha256'], 'motion': logged['motion'], 'navigation': navigation(logged['route']['points'], logged['pose']).tolist(), 'label': label, 'family': family, 'hazardWindow': logged['pose']['tS'] >= timing['onsetS'], 'admissionTiming': timing, 'teacherAction': teacher_action, 'counterfactualTraceDigest': teacher_step['digest']}
                    destination.write(json.dumps(sample, separators=(',', ':')) + '\n')
                    frames += 1; frame_count += 1
                sources.append({'directory': str(directory), 'frames': frames, 'rolloutSha256': sha256(directory / 'rollout.json'), 'stepsSha256': sha256(directory / 'steps.jsonl'), 'traceSha256': rollout['traceSha256']})
                print(f'RELABELLED episodes={len(sources)} frames={frame_count}', flush=True)
    receipt = {'schema': 'simforge.student-labels/v1', 'teacher': teacher_ref, 'teacherSha256': sha256(teacher_path), 'frames': frame_count, 'teacherQueries': frame_count, 'counterfactualStudentFrames': counterfactuals, 'labelsSha256': sha256(out), 'sources': sources, 'restoreChecks': frame_count, 'stateAndActuatorReplayChecks': frame_count}
    out.with_suffix('.receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--collection', action='append', required=True, type=Path)
    parser.add_argument('--teacher', required=True)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(relabel(args.collection, args.teacher, args.out)), flush=True)


if __name__ == '__main__':
    main()
