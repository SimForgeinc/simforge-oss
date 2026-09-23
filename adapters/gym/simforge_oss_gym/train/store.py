"""Immutable local simforge-policy entries, shared on disk with model-store."""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from .config import sha256

SCHEMA = 'simforge.policy-checkpoint/v1'


def root() -> Path:
    return Path(os.environ.get('SIMFORGE_ASSETS_ROOT', '~/simforge-assets')).expanduser().resolve() / 'models' / 'simforge-policy'


def revision_parts(ref: str) -> tuple[str, str]:
    parts = ref.removeprefix('simforge-policy/').split('/')
    if len(parts) != 2 or any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', part) or part in ('.', '..') for part in parts):
        raise ValueError('policy ref must be <run>/<update> or simforge-policy/<run>/<update>')
    return parts[0], parts[1]


def resolve(ref: str) -> tuple[Path, dict | None]:
    candidate = Path(ref).expanduser()
    if candidate.is_file():
        return candidate.resolve(), None
    run, update = revision_parts(ref)
    directory = root() / run / update
    entry = json.loads((directory / 'entry.json').read_text())
    checkpoint = directory / 'checkpoint.pt'
    if entry.get('schema') != SCHEMA or entry.get('family') != 'simforge-policy' or entry.get('revision') != f'{run}/{update}':
        raise ValueError(f'{directory}: invalid checkpoint entry identity')
    if sha256(checkpoint) != entry['sha256']:
        raise ValueError(f'{checkpoint}: checkpoint SHA-256 mismatch')
    promotion = entry.get('promotion')
    if type(entry.get('promoted')) is not bool or entry['promoted'] != (isinstance(promotion, dict) and promotion.get('verdict') == 'qualified'):
        raise ValueError('promoted flag must match a qualified promotion receipt')
    if promotion is not None:
        receipt = promotion.get('receipt', {})
        if promotion.get('verdict') not in ('qualified', 'exploratory', 'insufficient-evidence') or not re.fullmatch(r'promotions/[a-f0-9]{64}\.json', receipt.get('path', '')) or not re.fullmatch(r'[a-f0-9]{64}', receipt.get('sha256', '')):
            raise ValueError('invalid promotion receipt reference')
        receipt_path = directory / receipt['path']
        if sha256(receipt_path) != receipt['sha256']:
            raise ValueError('promotion receipt SHA-256 mismatch')
        report = json.loads(receipt_path.read_text())
        if report.get('schema') != 'simforge.promotion/v1' or report.get('policy', '').removeprefix('torch:').removeprefix('simforge-policy/') != entry['revision'] or report.get('verdict') != promotion['verdict'] or report.get('checkpoint', {}).get('sha256') != entry['sha256']:
            raise ValueError('promotion receipt checkpoint/verdict identity mismatch')
    return checkpoint, entry


def register(checkpoint: Path, *, recipe: str, obs_preset: str, action_head: str, metadata: dict) -> dict:
    run, update = revision_parts(f'{checkpoint.parent.parent.name}/{checkpoint.stem}')
    digest = sha256(checkpoint)
    trainer = metadata.get('trainer')
    prov = metadata.get('provenance')
    if not trainer or not trainer.get('configDigest') or not prov:
        raise ValueError('checkpoint export requires trainer configDigest and provenance; use simforge train --recipe --config')
    entry = {'schema': SCHEMA, 'family': 'simforge-policy', 'revision': f'{run}/{update}', 'sha256': digest,
             'obsPreset': obs_preset, 'actionHead': action_head, 'trainer': {**trainer, 'recipe': recipe},
             'provenance': prov, 'checkpoint': 'checkpoint.pt', 'promoted': False}
    target = root() / run / update
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        previous = json.loads((target / 'entry.json').read_text())
        immutable = {key: value for key, value in previous.items() if key not in ('promoted', 'promotion')}
        if immutable != {key: value for key, value in entry.items() if key != 'promoted'} or sha256(target / 'checkpoint.pt') != digest:
            raise FileExistsError(f'{target}: immutable policy revision already exists with different content')
        return previous
    staging = Path(tempfile.mkdtemp(prefix=f'.{update}-', dir=target.parent))
    try:
        shutil.copyfile(checkpoint, staging / 'checkpoint.pt')
        (staging / 'entry.json').write_text(json.dumps(entry, indent=2, allow_nan=False) + '\n')
        staging.rename(target)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print(f'CHECKPOINT_REGISTERED torch:{entry["revision"]} sha256={digest}', flush=True)
    return entry
