#!/usr/bin/env python3
"""Evaluate a saved PPO teacher on native frozen episodes, without rendering.

This reports native reward/contact/route metrics, not the campaign scorer or a
promotion decision. For scored Bevy footage use `simforge drive run --policy
torch:<checkpoint>`. The removed reactive socket server is never started.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'adapters/gym'))

import torch
from simforge_oss_gym.episodes import load_episode_spec
from simforge_oss_gym.train.model import load_checkpoint
from simforge_oss_gym.train.ppo import evaluate


def main() -> None:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--threads', type=int, default=8)
    args = parser.parse_args()
    torch.set_num_threads(2)
    model, payload = load_checkpoint(args.checkpoint, args.device)
    metrics = evaluate(model, load_episode_spec(args.spec), torch.device(args.device), args.threads)
    report = {'checkpoint_sha256': hashlib.sha256(Path(args.checkpoint).read_bytes()).hexdigest(), 'update': payload['metadata']['update'], 'spec_sha256': hashlib.sha256(Path(args.spec).read_bytes()).hexdigest(), 'native_validation': metrics, 'qualification': 'native validation only; NOT campaign score or promotion'}
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in metrics.items() if k != 'per_episode'}))


if __name__ == '__main__':
    main()
