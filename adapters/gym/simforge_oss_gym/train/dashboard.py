"""Matplotlib evidence from measured updates; no synthetic rollout imagery."""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


HTML = '''<!doctype html><meta charset="utf-8"><title>Native PPO teacher — live</title>
<style>body{margin:20px;background:#101620;color:#e5edf8;font:16px system-ui}a{color:#6abfff}img{width:100%;max-width:1600px}pre{white-space:pre-wrap}</style>
<h1>Render-free native PPO teacher — live process, not a qualified policy</h1>
<p>LOS-gated objects + ego motion. Longitudinal setpoints; native route-following steering.
Reward and termination are the existing Rust kernel. Missing safety/ground-truth gates are recorded in run-config.json.</p>
<p><a href="metrics.jsonl">Measured updates</a> · <a href="checkpoints/">Checkpoints</a> · <a href="rollouts/">Bevy evaluations</a> · <a href="training-timelapse.mp4">Training video</a> · <a href="run-config.json">Recipe and deviations</a></p>
<img id="chart" src="dashboard.png"><pre id="status"></pre>
<script>async function refresh(){let t=Date.now();document.querySelector('#chart').src='dashboard.png?t='+t;try{document.querySelector('#status').textContent=JSON.stringify(await(await fetch('status.json?t='+t)).json(),null,2)}catch(e){}}setInterval(refresh,5000);refresh()</script>'''


def render_dashboard(rows: list[dict], out: Path) -> None:
    fig, axes = plt.subplots(3, 3, figsize=(14, 10), dpi=100, facecolor='#111822')
    keys = [('reward_mean', 'Native reward / decision'), ('episode_return_mean', 'Completed-episode return (rolling 100)'), ('collision_rate', 'Native collision episode fraction'), ('route_completion', 'Geometric route completion fraction'), ('env_steps_per_s', 'Native decisions / wall second'), ('wall_seconds', 'Elapsed wall time (seconds)'), ('reward_progress_mean', 'Signed route progress reward / decision'), ('reward_stuck_mean', 'Unnecessary stop penalty / decision'), ('reward_jerk_mean', 'Jerk penalty / decision')]
    for axis, (key, title) in zip(axes.flat, keys):
        axis.set_facecolor('#192536')
        pairs = [(r['env_steps'], r[key]) for r in rows if r.get(key) is not None]
        if pairs:
            axis.plot([p[0] for p in pairs], [p[1] for p in pairs], color='#5ac8f5', linewidth=2, marker='o' if len(pairs) == 1 else None)
        if key in ('collision_rate', 'route_completion'):
            axis.set_ylim(-0.03, 1.03)
        axis.set_title(title, color='white', fontsize=10)
        axis.tick_params(colors='#d0d8e5', labelsize=8)
        axis.grid(alpha=0.15)
        axis.set_xlabel('Environment decisions', color='#aebcce', fontsize=8)
        for spine in axis.spines.values():
            spine.set_color('#506078')
    latest = rows[-1] if rows else {}
    fig.suptitle(f"Native PPO teacher  |  update {latest.get('update', 0)}  |  {latest.get('env_steps', 0):,} decisions\nMeasured training process — setpoint prototype, not safety-qualified", color='white', fontsize=15)
    fig.tight_layout(rect=(0, 0, 1, 0.92))
    temporary = out.with_name(out.stem + '.partial.png')
    fig.savefig(temporary)
    plt.close(fig)
    temporary.replace(out)


def publish(run: Path, rows: list[dict], status: dict) -> None:
    render_dashboard(rows, run / 'dashboard.png')
    temporary = run / 'status.partial.json'
    temporary.write_text(json.dumps(status, indent=2, allow_nan=False) + '\n')
    temporary.replace(run / 'status.json')
    if not (run / 'index.html').exists():
        (run / 'index.html').write_text(HTML)


def render_student_dashboard(rows: list[dict], out: Path, title: str) -> None:
    """Chronological measured student dashboard, explicitly a single-seed view."""
    fig, axes = plt.subplots(1, 3, figsize=(14, 6), dpi=100)
    x = [row['presentationsTotal'] for row in rows]
    for axis, key, label in zip(axes, ('loss', 'frames_per_second', 'wall_seconds'),
                                ('Smooth-L1 control loss (epoch cumulative)', 'Training presentations / second', 'Stage wall time (seconds)')):
        axis.plot(x, [row[key] for row in rows], color='#0072B2')
        axis.set_xlabel('Cumulative training frame presentations')
        axis.set_ylabel(label)
        axis.grid(alpha=0.2)
    fig.suptitle(f'{title}\nSingle seed {rows[-1]["seed"]}; measured optimization, not a safety qualification')
    fig.tight_layout(rect=(0, 0, 1, 0.88))
    temporary = out.with_name(out.stem + '.partial.png')
    fig.savefig(temporary)
    plt.close(fig)
    temporary.replace(out)
