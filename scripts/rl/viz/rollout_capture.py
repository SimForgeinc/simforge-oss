#!/usr/bin/env python3
"""Capture one real PPO checkpoint with the native Bevy bench, then score it.

Obtain the local GPU slot before invoking this command. Historical hard-coded
random/Phase-3 checkpoints and the removed capture socket server are not used.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'adapters/gym'))

from simforge_oss_gym.train.collect import render_one
from simforge_oss_gym.train.timelapse import assemble


def main() -> None:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--update', type=int, required=True)
    parser.add_argument('--duration', type=float, default=6)
    args = parser.parse_args()
    request = args.run / 'eval-requests' / f'update-{args.update:06d}.json'
    render_one(REPO, args.run, request, args.duration)
    assemble(args.run)


if __name__ == '__main__':
    main()
