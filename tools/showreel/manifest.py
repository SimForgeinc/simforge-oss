#!/usr/bin/env python3
"""Index durable drive artifacts and explicit collaborator contributions.

python3 tools/showreel/manifest.py --root ~/simforge-assets/runs/drive \
  --output ~/simforge-assets/runs/drive/SHOWREEL/manifest.json

Optional --additions is JSON with safety_segments, training_segments, caveats,
and final (boolean). Only completed report/score/run artifact sets are included;
training paths are explicit, never inferred from filenames as a success claim.
"""
import argparse
import datetime as dt
import json
from pathlib import Path

POLICIES = ['alpamayo-1.5', 'qwen-drive', 'jev', 'auto-e2e', 'scripted']
LABELS = {'alpamayo-1.5': 'Alpamayo 1.5', 'qwen-drive': 'Qwen-Drive',
          'jev': 'Jev', 'auto-e2e': 'AutoE2E', 'scripted': 'Scripted baseline'}
NOTES = {
    'alpamayo-1.5': 'Native RGB cameras + ego history. NF4 weights; reported text is not proof of correct driving.',
    'qwen-drive': 'Planner-SFT in reasoning mode. NF4 weights; read its literal reasoning alongside the motion.',
    'jev': 'Text/state-input policy, not a vision model. Probability bars are the recorded choice distribution.',
    'auto-e2e': 'FP32 checkpoint with native route/map BEV and ego history. No text reasoning is emitted.',
    'scripted': 'Deterministic native route follower and speed setpoint. This is the reference, not a trained model.',
}


def load(path):
    return json.loads(Path(path).read_text())


def card(identity, chapter, title, bullets, *, subtitle='', duration=10):
    return {'id': identity, 'chapter': chapter, 'kind': 'card', 'title': title,
            'subtitle': subtitle, 'bullets': bullets, 'duration_s': duration,
            'description': ' '.join(bullets)}


def run_clip(identity, chapter, run_dir, *, title=None, notes=None):
    run = load(run_dir / 'run.json')
    policy, duration = run['policy'], run['steps'] / run['decisionHz']
    speed = 0.125 if duration <= 1.1 else 1.0
    precision = run.get('model', {}).get('quant') or 'not reported / not applicable'
    playback = '8x slow playback (no interpolation)' if speed < 1 else '1x simulation-time playback'
    return {'id': identity, 'chapter': chapter, 'kind': 'video',
            'title': title or LABELS.get(policy, policy),
            'subtitle': f'{duration:g} s closed loop | seed {run["seed"]} | {precision} | {playback}',
            'description': f'{run_dir.name}: {duration:g} s of actual decisions; the {run["warmupFrames"]/run["decisionHz"]:g} s authored warm-up is omitted. {notes or NOTES.get(policy, "")}',
            'source': str(run_dir / 'drive.mp4'), 'run_dir': str(run_dir),
            'native_frames': str(run_dir / 'frames/camera_front_wide_120fov'),
            'closed_loop_only': True, 'speed': speed,
            'panel_note': notes or NOTES.get(policy, '')}


def completed(run_dir):
    return all((run_dir / name).is_file() for name in
               ('result.json', 'run.json', 'score.json', 'steps.jsonl', 'drive.mp4'))


def build(root, additions):
    segments = []
    final = bool(additions.get('final'))
    status = 'FINAL EVIDENCE SNAPSHOT' if final else 'INTERIM — experiments and training still in progress'
    now = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    segments.append(card('title', '01 / What you are watching', 'SimForge | closed-loop driving + training', [
        'One video. Native Bevy driving footage, recorded model decisions, scored episodes and available training evidence.',
        f'{status} — assembled {now}.',
        'Local driving GPU: NVIDIA RTX 5080, 16 GiB; local VLA runs are serialized. Remote A100 work is labeled in its own chapters.',
        'Text narration only. Offline simulation time is NOT real-time inference performance.'
    ], subtitle='Alpamayo 1.5 / Qwen-Drive / Jev / AutoE2E / scripted baseline', duration=13))
    segments.append(card('reading-guide', '01 / Reading the evidence', 'What the panels mean', [
        'Camera pixels are native renderer output. The kernel advances after each policy decision; the policy sees the resulting state.',
        'Qwen and Alpamayo: literal model-reported text. Jev: its actual selected choice and probability distribution.',
        'Metrics are read from report.json / score.json. No missing value is turned into zero; no training progress is invented.',
        'Short 1 s clips play 8x slower for legibility. Longer clips play at simulation speed. Warm-up is excluded from solo decision clips.'
    ], duration=13))
    corrected = root / 'heat'
    preview = root / 'heat-preview'
    heat_dir = corrected if (corrected / 'report.json').is_file() else preview
    if (heat_dir / 'heat.mp4').is_file() and (heat_dir / 'report.json').is_file():
        segments.append(card('heat-intro', '02 / Four-model smoke heat', 'Same benign corridor. Four real policies.', [
            'Garching benign corridor, seed 42. Ten closed-loop decisions per policy at 10 Hz: 1 s, not a long-horizon driving result.',
            'Top left: Alpamayo 1.5. Top right: Qwen-Drive. Bottom left: Jev. Bottom right: AutoE2E.',
            'The corrected heat replaces the earlier heat-preview path. All reported precision labels come from model provenance.'
        ], duration=11))
        segments.append({'id': 'smoke-heat', 'chapter': '02 / Four-model smoke heat', 'kind': 'video',
                         'title': 'Four-model heat | native Bevy closed loop',
                         'subtitle': '1 s recorded episode | seed 42 | offline-simtime | 8x slow playback',
                         'source': str(heat_dir / 'heat.mp4'), 'speed': 0.125, 'side_panel': True,
                         'notes': ['TOP LEFT\nAlpamayo 1.5 / NF4', 'TOP RIGHT\nQwen-Drive / NF4',
                                   'BOTTOM LEFT\nJev / text-state input', 'BOTTOM RIGHT\nAutoE2E / FP32',
                                   'One short smoke episode. Read the full metrics table next.'],
                         'links': [str(heat_dir / 'report.json')],
                         'description': 'Real synchronized four-model composition, slowed for reading; no extrapolated performance claim.'})
        segments.append({'id': 'smoke-metrics', 'chapter': '02 / Four-model smoke heat', 'kind': 'table',
                         'title': 'Measured smoke-heat results',
                         'subtitle': 'Values from report.json | score and route completion are scorer outputs',
                         'reports': [str(heat_dir / 'report.json')], 'duration_s': 13,
                         'notes': ['Only 1 s of decisions. This is not full-route completion or a statistical model ranking.',
                                   'Latency is wall-clock time per decision, including held choices; playback is offline simulation time.',
                                   'Offroad is an infraction count. Missing precision is n/a, not NF4.'],
                         'description': 'The exact report values rendered as a readable table; raw CSV/JSON linked in the index.'})
    segments.append(card('solo-intro', '03 / Policy close-ups', 'Read the decisions, not just the road', [
        'Each solo uses the recorded native camera frames with a larger decision panel from steps.jsonl. Panel speed/timestamps describe the outcome of that decision.',
        'The short smoke episodes are included first. Longer completed demo heats are indexed later in this video.',
        'Jev is text/state-input; AutoE2E uses map/route BEV and ego history. These are not identical input modalities.'
    ], duration=10))
    solos = []
    for policy in POLICIES:
        run_dir = heat_dir / f'drive-corridor__{policy}__seed42'
        if not completed(run_dir):
            run_dir = root / f'drive-corridor__{policy}__seed42'
        if not completed(run_dir):
            continue
        solos.append(run_dir)
        clip = run_clip(f'solo-{policy.replace(".", "-")}', '03 / Policy close-ups', run_dir)
        original = root / f'drive-corridor__{policy}__seed42'
        if original != run_dir and completed(original):
            clip['links'] = [str(original / name) for name in ('drive.mp4', 'run.json', 'score.json', 'result.json')]
        segments.append(clip)
    if solos:
        segments.append({'id': 'five-policy-metrics', 'chapter': '03 / Policy close-ups', 'kind': 'table',
                         'title': 'Five policy runs | scored evidence',
                         'subtitle': 'Four corrected heat runs + scripted reference | all 1 s / seed 42',
                         'runs': [str(p) for p in solos], 'duration_s': 13,
                         'notes': ['Sources: individual score.json files; mean latency recomputed from recorded steps.jsonl.',
                                   'One benign corridor and one seed. Not an equal-input benchmark or real-world safety evidence.'],
                         'description': 'Five-model metric overview including the deterministic baseline.'})
    for report_path in sorted((root / 'demo').glob('*/report.json')):
        heat = load(report_path)
        if heat.get('schema') != 'simforge.drive-heat-report/v1' or len(heat.get('runs', [])) < 4:
            continue
        video = report_path.parent / 'heat.mp4'
        if not video.is_file() or not all(completed(Path(r['runDir'])) for r in heat['runs']):
            continue
        identity = report_path.parent.name
        run_dirs = [Path(r['runDir']) for r in heat['runs']]
        run = load(run_dirs[0] / 'run.json')
        holds = heat.get('presentation', {}).get('terminalHolds', [])
        hold_note = '; '.join(f'{item["policy"]} terminal frame held after {item["startsAtDecisionS"]:g} s'
                              for item in holds)
        clip_note = hold_note or 'No terminal-frame holds are reported.'
        segments.append(card(f'{identity}-intro', '04 / Longer demo heats', f'Longer heat | {identity}', [
            f'{run["scenarioId"]}, seed {run["seed"]}. {run["durationS"]:g} s requested per policy; native Bevy renderer.',
            'These are new completed experiments, not extensions fabricated from the 1 s smoke clips.',
            clip_note,
            'Read each score alongside model-health and scenario limitations in the linked source artifacts.'
        ], duration=9))
        segments.append({'id': f'{identity}-heat', 'chapter': '04 / Longer demo heats', 'kind': 'video',
                         'title': f'Closed-loop heat | {identity}',
                         'subtitle': f'{run["durationS"]:g} s requested | seed {run["seed"]} | 1x simulation-time playback',
                         'source': str(video),
                         'links': [str(report_path)] + [str(report_path.parent / name) for name in
                                   ('heat-synchronized.mp4', 'metrics.json', 'report.md',
                                    'run-verification.json', 'video-verification.json')
                                   if (report_path.parent / name).is_file()]
                                  + [str(directory / 'drive.mp4') for directory in run_dirs]
                                  + [str(report_path.parent / 'solo' / item['policy'] / 'drive.mp4')
                                     for item in heat['runs']
                                     if (report_path.parent / 'solo' / item['policy'] / 'drive.mp4').is_file()],
                         'description': f'Completed native heat from {report_path.parent}. {clip_note}'})
        segments.append({'id': f'{identity}-table', 'chapter': '04 / Longer demo heats', 'kind': 'table',
                         'title': f'Heat metrics | {identity}', 'subtitle': 'Direct report.json values; no cross-scenario averaging',
                         'reports': [str(report_path)], 'duration_s': 13,
                         'notes': ['Scores are local to this scenario and episode horizon.',
                                   'Read model-health receipts before interpreting any score as qualified performance.'],
                         'description': f'Metrics and original evidence links for {identity}.'})
        if identity == 'corridor-seed42':
            for run_dir in run_dirs:
                policy = load(run_dir / 'run.json')['policy']
                segments.append(run_clip(f'long-solo-{policy.replace(".", "-")}', '04 / Longer policy close-ups', run_dir))
                solo_path = report_path.parent / 'solo' / policy / 'drive.mp4'
                if solo_path.is_file():
                    segments[-1]['links'] = [str(solo_path)]
    segments.extend(additions.get('model_segments', []))
    long_auto = root / 'long-auto/drive-corridor__auto-e2e__seed42'
    if completed(long_auto):
        segments.append(card('auto-failure-intro', '05 / Failure modes are evidence', 'AutoE2E | the longer run reveals failure', [
            '20 s closed-loop episode, 200 decisions. Keep the full rollout, including the failure, in view.',
            'The score records 3 off-road infractions. A clean 1 s smoke clip does not predict a clean longer episode.',
            'This is a simulation-domain failure case, not a claim about real-world driving capability.'
        ], duration=10))
        segments.append(run_clip('auto-failure', '05 / Failure modes are evidence', long_auto,
                                 title='AutoE2E | 20 s failure-mode rollout',
                                 notes='The scorer records 3 off-road infractions. No model-reported text reasoning is available.'))
        labelled_failure = root / 'demo/auto-e2e-failure'
        segments[-1]['links'] = [str(labelled_failure / name) for name in
                                ('failure-labelled.mp4', 'evidence.json', 'report.json')
                                if (labelled_failure / name).is_file()]
        segments.append({'id': 'auto-failure-metrics', 'chapter': '05 / Failure modes are evidence', 'kind': 'table',
                         'title': 'AutoE2E | long-run score', 'subtitle': '20 s / 200 closed-loop decisions',
                         'runs': [str(long_auto)], 'duration_s': 10,
                         'notes': ['Source: long-auto score.json. Route completion and score differ because penalties apply.',
                                   'Cross-track telemetry is unavailable in this source; it is not invented.'],
                         'description': 'Measured long-horizon AutoE2E failure score and off-road count.'})
    if additions.get('safety_segments'):
        segments.extend(additions['safety_segments'])
    else:
        segments.append(card('safety-status', '06 / Jev safety and refusal', 'Safety stress clips | not yet included', [
            'The current Jev smoke clip has feasible candidates and a real choice distribution.',
            'A dedicated adversarial refusal/safety clip has not yet been supplied for this snapshot.',
            'No benign driving clip is relabeled as a refusal, and no unverified refusal is called a safety success.'
        ], duration=9))
    if additions.get('training_segments'):
        segments.extend(additions['training_segments'])
    else:
        segments.append(card('training-status', '07 / Closed-loop training', 'Training | work in progress, not a fabricated curve', [
            'TrainViz is implementing and running render-free PPO on the Rust EnvSession / SessionBatch substrate.',
            'No durable training dashboard, checkpoint rollout or timelapse has been supplied at this snapshot time.',
            'This card will be replaced with actual live-metric snapshots, checkpoint rollouts and timelapse as artifacts arrive.',
            'The broader teacher → pixels student → DAgger recipe remains a plan; no convergence or held-out gain is claimed.'
        ], duration=13))
    segments.append(card('artifact-paths', '08 / Open the evidence', 'Exact artifact locations', [
        f'ONE VIDEO: {root}/SHOWREEL/showreel.mp4',
        f'INDEX: {root}/SHOWREEL/README.md and index.html',
        f'SMOKE HEAT: {heat_dir}/heat.mp4 and report.json',
        f'LONG FAILURE: {long_auto}/drive.mp4',
        f'NEW DEMOS: {root}/demo/ (completed reports only)',
        f'TRAINING: {root}/training/ (exact experiment paths linked in the index)',
        'All included videos, rendered metrics, raw scores and provenance are linked by chapter in README.md and index.html.'
    ], duration=16))
    caveats = [
        'The original heat/solo smoke episodes contain only 1 s of closed-loop decisions after a 6.4 s authored warm-up; the warm-up is not model driving.',
        'The initial scenario is a benign Garching corridor; longer or edge-case runs are labeled separately. Single episodes are not statistical comparisons.',
        'Alpamayo 1.5 and Qwen-Drive use NF4 weights; AutoE2E reports FP32; Jev is a remote text/state policy; scripted is deterministic. Input modalities differ.',
        'Offline-simtime playback is not real-time performance. Recorded decision latency is a separate wall-clock measurement.',
        'Model-generated reasoning is displayed literally, not endorsed. Choice distributions are recorded data, not an uncertainty calibration claim.',
        'Scorer availability and validity gates matter. Missing metrics are not silently converted into zeros; no real-world safety, transfer, or leaderboard equivalence is claimed.'
    ] + additions.get('caveats', [])
    segments.append(card('closing', '08 / Known caveats', 'Visible progress. Honest limitations.', [
        '1 s smoke clips are not long-run results. Benign corridors are not a safety benchmark.',
        'NF4 VLA inference, FP32 AutoE2E, state/text Jev and a scripted reference use different input paths.',
        'Training progress is not convergence; checkpoint playback is not held-out promotion.',
        'No real-world safety or transfer claims. Consult the per-run provenance, scorer outputs and model-health evidence.',
        'Open SHOWREEL/README.md or index.html for every included clip and table.'
    ], duration=14))
    return {'schema': 'simforge.showreel-manifest/v1', 'status': status, 'generated_at': now,
            'caveats': caveats, 'segments': segments}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--additions', type=Path)
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    additions = load(args.additions) if args.additions else {}
    manifest = build(root, additions)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    print(f'MANIFEST {args.output} segments={len(manifest["segments"])}', flush=True)


if __name__ == '__main__':
    main()
