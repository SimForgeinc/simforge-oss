"""Additive policy-endpoint/v3 metadata; no inference or world-clock authority."""
from __future__ import annotations

import hashlib
import json
import math

VERSION = 'simforge.policy-endpoint/v3'


def capabilities(*, cameras: bool, ego_steps: int, camera_frames: int, horizon_s: float, hz: float, frame: str = 'ego') -> dict:
    return {'protocol': VERSION,
            'calibrationRequirements': {'model': 'pinhole', 'intrinsics': cameras, 'exposure': cameras, 'resize': cameras},
            'historyRequirements': {'egoSteps': ego_steps, 'cameraFrames': camera_frames},
            'planContract': {'horizonS': horizon_s, 'hz': hz, 'frame': frame}}


def receipt(obs: dict, action: object, *, horizon_s: float, fallback: str | None = None) -> dict:
    """Legacy callers omit v3 anchors; their response stays byte-shape compatible."""
    if obs.get('protocol') != VERSION:
        return {}
    ego = obs.get('ego', {})
    anchor = ego.get('anchor', {})
    ts, tick = anchor.get('ts'), obs.get('adoptionTick')
    if not isinstance(ts, (float, int)) or not math.isfinite(ts) or not isinstance(tick, int) or tick < 0:
        raise ValueError('v3 requires finite ego.anchor.ts and nonnegative integer adoptionTick')
    if not ego.get('valid') or not isinstance(anchor.get('pose'), dict):
        raise ValueError('v3 requires a valid timestamped ego pose')
    if not isinstance(ego.get('ageS'), (float, int)) or ego['ageS'] < 0:
        raise ValueError('v3 requires a nonnegative ego ageS')
    identity = json.dumps({'anchor': anchor, 'tick': tick, 'action': action}, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return {'plan': {'id': hashlib.sha256(identity.encode()).hexdigest(), 'anchorTs': ts, 'horizonS': horizon_s, 'adoptionTick': tick},
            'health': {'fallback': ('prologue' if obs.get('phase') == 'warmup' else 'closedLoop') if fallback else 'none', 'reason': fallback}}
