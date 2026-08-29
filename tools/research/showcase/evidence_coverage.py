#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path('/home/path/UniScenarios-training-grade')
CASES = json.loads((ROOT / 'apps/showcase/campaigns/edge-cases.json').read_text())['cases']
UN = ROOT / 'showcase-data' / 'evidence-underlay'
D3 = ROOT / 'showcase-data' / 'evidence-3d'
refus = {r['case']: r for r in json.loads((D3 / 'refusals.json').read_text())}

rows = []
for c in CASES:
    cid = c['id']
    has2d = (UN / cid).is_dir() and any((UN / cid).glob('*/*.mp4'))
    has3d = (D3 / cid).is_dir() and any((D3 / cid).glob('*/*.mp4'))
    if has3d:
        state = '3D + 2D'
    elif has2d:
        r = refus.get(cid, {})
        state = '2D only (%s)' % r.get('class', 'pending')
    else:
        state = 'no video (authoring unsupported)'
    rows.append((cid, c['title'], state))

print('%-32s %-40s %s' % ('case', 'evidence', 'title'))
for cid, title, state in rows:
    print('%-32s %-40s %s' % (cid[:31], state[:39], title[:46]))

n3 = sum(1 for r in rows if r[2].startswith('3D'))
n2 = sum(1 for r in rows if r[2].startswith('2D'))
n0 = sum(1 for r in rows if r[2].startswith('no video'))
print('\n3D+2D: %d   2D only: %d   none: %d   total: %d' % (n3, n2, n0, len(rows)))
cls = {}
for cid, _t, state in rows:
    if state.startswith('2D only'):
        k = state[state.find('(') + 1:-1]
        cls[k] = cls.get(k, 0) + 1
print('2D-only reasons:', json.dumps(cls))
out = ROOT / 'showcase-data' / 'campaigns' / 'evidence-coverage.json'
out.write_text(json.dumps({'rows': [{'case': a, 'title': b, 'evidence': c} for a, b, c in rows],
                           'summary': {'both': n3, 'twoDOnly': n2, 'none': n0}}, indent=1))
print('wrote', out.relative_to(ROOT))
