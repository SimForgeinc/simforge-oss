#!/usr/bin/env python3
"""Generate the frozen rethink brief sample — RETHINK-CONTRACTS.md section 5.

Deterministic (seed recorded in the output). Committed output:
`tools/research/shared/briefs-sample.json`. All comparative arms (A/C/E) use exactly
this sample; it is committed BEFORE any arm runs and never regenerated afterwards.

Composition:
1. 30 DEV briefs from research/edge-case-corpus/agent-authoring/brief-corpus-full.json
   (DEV split only, tranche1+tranche2; HELDOUT untouched), stratified by category with
   proportional allocation (largest remainder), seeded sampling within category.
2. Up to 20 owner-list scenarios from research/edge-case-corpus/OWNER-EDGE-CASES.md that
   the W6 structural pre-check logic (tools/gates/precheck_briefs.py: required_structures
   x structure-inventory.json) says the five maps can host. Exclusions are recorded with
   reasons:
     - missing_structures: the pre-check names a structure with zero sites/unmatchable.
     - unstructured_space: the item's setting is off the road network (gas station
       forecourt, drive-thru, airport drop-off zone, campground, unpaved lot, grass
       field, private road). The W6 text rules cannot see these settings (they default
       to plain_corridor), and RETHINK-PLAN.md section 2 records them as map facts, so
       admitting them via the pre-check's silence would be dishonest. Documented rule,
       applied after the pre-check.
     - over_quota: hostable but cut by the seeded stratified cap of 20.
"""
import json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
import precheck_briefs as W6                                                # noqa: E402

SEED = 20260816
DEV_N = 30
OWNER_N = 20
CORPUS = os.path.join(ROOT, 'research', 'edge-case-corpus', 'agent-authoring',
                      'brief-corpus-full.json')
OWNER_MD = os.path.join(ROOT, 'research', 'edge-case-corpus', 'OWNER-EDGE-CASES.md')
INVENTORY = os.path.join(ROOT, 'tools', 'gates', 'structure-inventory.json')
OUT = os.path.join(HERE, 'briefs-sample.json')

# Settings that are OFF the mapped road network. The W6 text rules have no vocabulary
# for them (they fall through to plain_corridor), so they get an explicit, documented
# exclusion rule instead of a silent pass.
UNSTRUCTURED = re.compile(
    r'gas station|drive.?thru|drop.?off zones? at airport|campground|'
    r'dirt or gravel lot|grass field|private road', re.I)


def slug(s, n=42):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', s.lower())).strip('-')[:n]


def parse_owner_items(path):
    items, group = [], None
    for line in open(path):
        line = line.rstrip()
        m = re.match(r'^## (.+)$', line)
        if m:
            group = m.group(1).strip()
            continue
        m = re.match(r'^- (.+)$', line)
        if m and group and not group.lower().startswith('owner directives'):
            text = m.group(1).strip()
            items.append({'id': 'owner-%s-%s' % (slug(group, 18), slug(text)),
                          'category': 'OWNER.%s' % slug(group, 24),
                          'brief': text, 'group': group})
    return items


def allocate(counts, total):
    """Proportional allocation with largest remainder; every category >= 0."""
    keys = sorted(counts)
    grand = sum(counts.values())
    exact = {k: total * counts[k] / grand for k in keys}
    base = {k: int(exact[k]) for k in keys}
    left = total - sum(base.values())
    for k in sorted(keys, key=lambda k: (-(exact[k] - base[k]), k))[:left]:
        base[k] += 1
    return base


def main():
    rng = random.Random(SEED)
    corpus = json.load(open(CORPUS))
    dev = set()
    for key in ('tranche1Split', 'tranche2Split'):
        dev |= set((corpus.get(key) or {}).get('DEV') or [])
    dev_briefs = [b for b in corpus['briefs'] if b['id'] in dev]

    by_cat = {}
    for b in dev_briefs:
        by_cat.setdefault(b['category'], []).append(b)
    alloc = allocate({k: len(v) for k, v in by_cat.items()}, DEV_N)
    dev_sample = []
    for cat in sorted(by_cat):
        pool = sorted(by_cat[cat], key=lambda b: b['id'])
        take = min(alloc[cat], len(pool))
        dev_sample += rng.sample(pool, take)
    dev_sample.sort(key=lambda b: b['id'])

    inv = json.load(open(INVENTORY))
    owner_items = parse_owner_items(OWNER_MD)
    hostable, excluded = [], []
    for it in owner_items:
        pc = W6.precheck({'id': it['id'], 'category': '', 'brief': it['brief']}, inv)
        if pc['missing']:
            excluded.append({**it, 'reason': 'missing_structures',
                             'missing': pc['missing'], 'requires': pc['requires']})
        elif UNSTRUCTURED.search(it['brief']):
            excluded.append({**it, 'reason': 'unstructured_space',
                             'requires': pc['requires']})
        else:
            hostable.append({**it, 'requires': pc['requires'],
                             'notPortable': pc['notPortable']})

    # Seeded stratified cap across owner groups (round-robin in group order).
    by_group = {}
    for it in hostable:
        by_group.setdefault(it['group'], []).append(it)
    for g in by_group:
        rng.shuffle(by_group[g])
    picked, over = [], []
    order = sorted(by_group)
    while len(picked) < OWNER_N and any(by_group[g] for g in order):
        for g in order:
            if by_group[g] and len(picked) < OWNER_N:
                picked.append(by_group[g].pop(0))
    for g in order:
        for it in by_group[g]:
            over.append({**it, 'reason': 'over_quota'})
    excluded += over
    picked.sort(key=lambda b: b['id'])

    out = {
        'kind': 'rethink-briefs-sample',
        'version': 1,
        'seed': SEED,
        'generator': 'tools/research/shared/make_briefs_sample.py',
        'sources': {'devCorpus': os.path.relpath(CORPUS, ROOT),
                    'ownerList': os.path.relpath(OWNER_MD, ROOT),
                    'inventory': os.path.relpath(INVENTORY, ROOT)},
        'devAllocationByCategory': alloc,
        'dev': [{'id': b['id'], 'category': b['category'], 'brief': b['brief']}
                for b in dev_sample],
        'owner': [{'id': b['id'], 'category': b['category'], 'brief': b['brief'],
                   'group': b['group'], 'requires': b['requires'],
                   'notPortable': b['notPortable']} for b in picked],
        'ownerExcluded': [{k: v for k, v in e.items() if k != 'notPortable'}
                          for e in excluded],
        'counts': {'dev': len(dev_sample), 'owner': len(picked),
                   'ownerExcluded': len(excluded)},
    }
    json.dump(out, open(OUT, 'w'), indent=1)
    print('wrote %s: %d DEV + %d owner (%d excluded: %s)' % (
        OUT, len(dev_sample), len(picked), len(excluded),
        {r: sum(1 for e in excluded if e['reason'] == r)
         for r in {e['reason'] for e in excluded}}))
    for e in excluded:
        print('  EXCLUDED %-46s %s %s' % (e['id'], e['reason'],
                                          e.get('missing', '')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
