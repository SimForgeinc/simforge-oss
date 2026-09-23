"""Frozen native reward configuration and resolved trainer provenance."""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

REWARD = {'collisionPenalty': -20.0, 'goalBonus': 5.0, 'progressWeight': 0.05, 'proximityWeight': 0.0, 'comfortAccelWeight': 0.005}
EPISODE = {'decisionHz': 10, 'goal': {'routeEnd': True}, 'reward': REWARD, 'observation': {'stateVector': True, 'bev': None}}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def provenance(splits: dict[str, str], manifests: dict[str, str]) -> dict:
    from ..native import ENGINE_VERSION
    records = {}
    for name, source in splits.items():
        path = Path(source)
        record = {'episodes': str(path), 'episodesSha256': sha256(path)}
        episode_doc = json.loads(path.read_text())
        linked = episode_doc.get('provenance', {}).get('splitManifest')
        if name not in manifests and linked:
            manifests = {**manifests, name: str((path.parent / linked).resolve())}
        if name in manifests:
            manifest = Path(manifests[name])
            document = json.loads(manifest.read_text())
            if document.get('schema') != 'simforge.scenario-split/v1' or not document.get('digest'):
                raise ValueError(f'{manifest}: expected a digested simforge.scenario-split/v1 manifest')
            expected = document.get('materialization', {}).get('episodes', {}).get('sha256')
            if expected != record['episodesSha256'] or not linked or (path.parent / linked).resolve() != manifest.resolve():
                raise ValueError(f'{path}: materialization hash or linked split manifest differs from {manifest}')
            record.update(splitDigest=document['digest'], manifest=str(manifest), manifestSha256=sha256(manifest))
        else:
            record.update(splitDigest=record['episodesSha256'], digestKind='recorded-episodes; no admission claim')
        records[name] = record
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True, check=False)
    return {'splits': records, 'kernelVersion': ENGINE_VERSION, 'gitSha': result.stdout.strip() if result.returncode == 0 else None}
