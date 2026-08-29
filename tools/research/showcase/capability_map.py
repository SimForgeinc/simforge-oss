#!/usr/bin/env python3
"""Classify why each of the 67 cases stopped, over every attempt on disk.

stopClass is read from artifacts, never guessed:
  accepted            - semantic match + deterministic 3D render + video
  render-refused      - oracle matched, 3D exporter refused (camera/ground); 2D video exists
  oracle-rejected     - simulated and 2D-reviewed, oracle said the mechanism is not shown
  gate-rejected       - simulated, frozen gate/eligibility admitted nothing
  no-sites            - matcher found no hostable site on the 5 dev maps
  author-unsupported  - authoring exhausted its semantic-contract repairs
  infra-quota         - model provider usage limit / gateway outage (NOT a capability verdict)
  other-infra         - any other operational failure
"""
import json, re
from pathlib import Path

ROOT = Path('/home/path/UniScenarios-training-grade')
JOBS = ROOT / 'showcase-data' / 'jobs'
CASES = json.loads((ROOT / 'apps/showcase/campaigns/edge-cases.json').read_text())['cases']
ORDER = ['submitted', 'author-ok', 'contract-valid', 'cells-ok', 'gate-pass', 'eligible',
         '2d-ok', 'semantic-reviewed', 'semantic-2d', '3d-ok', 'accepted']
RANK = {s: i for i, s in enumerate(ORDER)}
PRIORITY = ['accepted', 'render-refused', 'oracle-rejected', 'gate-rejected', 'no-sites',
            'author-unsupported', 'infra-quota', 'other-infra', 'never-attempted']


def load(p):
    try:
        return json.loads(Path(p).read_text())
    except Exception:
        return None


def classify(jobdir):
    bench = load(jobdir / '95-benchmark.json') or {}
    funnel = bench.get('funnel') or {}
    outcome = bench.get('outcome') or {}
    err = json.dumps(load(jobdir / 'job-error.json') or {})
    blob = err + json.dumps(outcome)
    reached = [s for s in ORDER if funnel.get(s) is True]
    furthest = reached[-1] if reached else 'none'
    v2 = sorted((jobdir / '60-render2d').glob('*/rollout.mp4')) if (jobdir / '60-render2d').is_dir() else []
    v3 = sorted((jobdir / '65-render3d').glob('*/rollout.mp4')) if (jobdir / '65-render3d').is_dir() else []

    if outcome.get('accepted') is True and v3:
        cls = 'accepted'
    elif 'usage_limit' in blob or 'usage limit' in blob or 'rate_limit' in blob:
        cls = 'infra-quota'
    elif outcome.get('semanticAccepted') is True:
        cls = 'render-refused'
    elif 'exhausted semantic-contract repairs' in blob:
        cls = 'author-unsupported'
    elif funnel.get('semantic-reviewed') is True or funnel.get('2d-ok') is True:
        cls = 'oracle-rejected'
    elif funnel.get('cells-ok') is True:
        cls = 'gate-rejected'
    elif 'no matching sites' in blob:
        cls = 'no-sites'
    elif 'model access unavailable' in blob or 'gateway' in blob.lower():
        cls = 'infra-quota'
    elif err and err != '{}':
        cls = 'other-infra'
    else:
        cls = 'oracle-rejected' if v2 else 'other-infra'
    return {
        'jobId': jobdir.name, 'furthest': furthest, 'rank': RANK.get(furthest, -1),
        'stopClass': cls,
        'video2d': str(v2[0].relative_to(ROOT)) if v2 else None,
        'video3d': str(v3[0].relative_to(ROOT)) if v3 else None,
        'defects': outcome.get('defectCodes') or [],
    }


attempts = {c['id']: [] for c in CASES}
for jobdir in sorted(p for p in JOBS.iterdir() if p.is_dir()):
    brief = load(jobdir / '00-brief.json')
    if not brief:
        continue
    case = brief.get('campaignCaseId')
    if case in attempts:
        attempts[case].append(classify(jobdir))

rows = []
for c in CASES:
    tries = attempts[c['id']]
    if not tries:
        rows.append({'case': c['id'], 'title': c['title'], 'stopClass': 'never-attempted',
                     'attempts': 0, 'video2d': None, 'video3d': None, 'furthest': 'none'})
        continue
    best = min(tries, key=lambda t: (PRIORITY.index(t['stopClass']), -t['rank']))
    rows.append({'case': c['id'], 'title': c['title'], 'stopClass': best['stopClass'],
                 'attempts': len(tries), 'furthest': best['furthest'],
                 'video2d': best['video2d'] or next((t['video2d'] for t in tries if t['video2d']), None),
                 'video3d': best['video3d'] or next((t['video3d'] for t in tries if t['video3d']), None),
                 'defects': best['defects']})

counts = {}
for r in rows:
    counts[r['stopClass']] = counts.get(r['stopClass'], 0) + 1
print('stopClass distribution over 67 cases:')
for k in PRIORITY:
    if counts.get(k):
        print(f'  {k:20s} {counts[k]:3d}')
print(f"\n2D evidence video: {sum(1 for r in rows if r['video2d'])}/67   "
      f"3D product video: {sum(1 for r in rows if r['video3d'])}/67")
print(f"needs re-run (infra, not capability): {counts.get('infra-quota', 0) + counts.get('other-infra', 0)}")

out = ROOT / 'showcase-data' / 'campaigns' / 'capability-map.json'
out.write_text(json.dumps({'summary': counts, 'cases': rows}, indent=1))
print(f'wrote {out.relative_to(ROOT)}')
