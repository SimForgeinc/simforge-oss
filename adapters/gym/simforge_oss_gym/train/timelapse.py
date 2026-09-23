"""Animate measured curve prefixes beside real chronological Bevy checkpoint clips."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np

from .dashboard import render_dashboard


def assemble(run: Path) -> Path:
    evaluations = sorted((run / 'rollouts').glob('update-*/evaluation.json'))
    if not evaluations:
        raise ValueError('no scored Bevy evaluation videos exist; refusing to fabricate rollouts')
    rows = [json.loads(line) for line in (run / 'metrics.jsonl').read_text().splitlines() if line.strip()]
    work = run / 'timelapse-parts'
    work.mkdir(exist_ok=True)
    parts = []
    previous = 0
    provenance = []
    renderer_digest = hashlib.sha256(Path(__file__).read_bytes() + Path(__file__).with_name('dashboard.py').read_bytes()).hexdigest()
    for receipt_path in evaluations:
        receipt = json.loads(receipt_path.read_text())
        video = Path(receipt['video'])
        update = receipt['update']
        directory = work / f'update-{update:06d}'
        directory.mkdir(exist_ok=True)
        eligible = [r for r in rows if r['update'] <= update]
        start = max(1, sum(r['update'] <= previous for r in eligible))
        part = directory / 'segment.mp4'
        cache_path = directory / 'segment.json'
        video_stat = video.stat()
        identity = hashlib.sha256(json.dumps({'renderer': renderer_digest, 'receipt': receipt, 'metrics': eligible, 'previous_update': previous, 'video_size': video_stat.st_size, 'video_mtime_ns': video_stat.st_mtime_ns}, sort_keys=True).encode()).hexdigest()
        if part.exists() and cache_path.exists():
            cached = json.loads(cache_path.read_text())
            if cached['identity'] == identity:
                parts.append(part)
                provenance.append(cached['provenance'])
                previous = update
                continue
        duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(video)], text=True).strip())
        count = max(1, math.ceil(duration))
        indexes = np.linspace(start, len(eligible), count, dtype=int)
        for frame, index in enumerate(indexes):
            render_dashboard(eligible[:max(1, int(index))], directory / f'curves-{frame:03d}.png')
        val = receipt['native_validation']
        score = receipt['score']
        title = f"NATIVE PPO TRAINING  |  checkpoint update {update}  |  {receipt['env_steps']:,} decisions\nLeft: measured curve history     Right: native Bevy closed-loop held-out rollout"
        footer = f"80-episode native validation: return {val['episode_return_mean']:.2f} | collision {val['collision_rate']:.1%} | geometric completion {val['route_completion']:.1%}\nThis {duration:.1f}s Bevy clip: drivingScore {score['drivingScore']:.3f} | score completion {score['routeCompletion']:.1%}\nLongitudinal setpoint prototype; native route steering. No safety/promotion, learned steering, student or DAgger claim."
        (directory / 'title.txt').write_text(title)
        (directory / 'footer.txt').write_text(footer)
        font = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
        filters = f"[0:v]scale=960:550,pad=960:820:0:100:color=0x111822,setsar=1[a];[1:v]scale=960:720:force_original_aspect_ratio=decrease,pad=960:820:(ow-iw)/2:80:color=0x111822,setsar=1[b];[a][b]hstack=inputs=2,pad=1920:1080:0:110:color=0x111822,drawtext=fontfile={font}:textfile={directory / 'title.txt'}:expansion=none:fontcolor=white:fontsize=30:x=28:y=24:line_spacing=10,drawtext=fontfile={font}:textfile={directory / 'footer.txt'}:expansion=none:fontcolor=white:fontsize=23:x=28:y=930:line_spacing=12[v]"
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', str(directory / 'curves-%03d.png'), '-i', str(video), '-filter_complex', filters, '-map', '[v]', '-t', str(duration), '-r', '10', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '4', str(part)], check=True)
        parts.append(part)
        provenance.append({'update': update, 'checkpoint_sha256': receipt['sha256'], 'env_steps': receipt['env_steps'], 'native_video': str(video), 'score': str(Path(receipt['native_run']) / 'score.json'), 'duration_s': duration, 'curve_prefix_updates': [int(eligible[int(i)-1]['update']) for i in indexes]})
        cache_path.write_text(json.dumps({'identity': identity, 'provenance': provenance[-1]}, indent=2) + '\n')
        previous = update
    listing = work / 'concat.txt'
    listing.write_text(''.join(f"file '{part.as_posix()}'\n" for part in parts))
    output = run / 'training-timelapse.mp4'
    temporary = run / 'training-timelapse.partial.mp4'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(listing), '-c', 'copy', '-movflags', '+faststart', str(temporary)], check=True)
    temporary.replace(output)
    (run / 'training-timelapse.json').write_text(json.dumps({'video': str(output), 'segments': provenance, 'qualification': 'measured learning process and native Bevy evaluation; not a policy promotion'}, indent=2) + '\n')
    print(f'TIMELAPSE_READY {output}', flush=True)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--run', required=True)
    args = parser.parse_args()
    assemble(Path(args.run))


if __name__ == '__main__':
    main()
