"""M5 novelty: kinematic signatures of the ADMITTED authored corpus vs mined events.

Signature (registered): (headingBucket, laneRelation, kindPair, movementClass) at the
ego-challenger closest approach, computed with the same primitives as mine.py, over
every gold-corpus-v3 trace (ego x non-ambient challengers; these corpora predate
ambient, so every non-ego actor is a challenger or prop actor).

Usage: novelty.py <mined-events.jsonl> [--gold <dir>]
"""
import argparse, collections, json, math, os, sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
sys.path.insert(0, HERE)
import tg_gate as G                                                        # noqa: E402
from mine import heading_bucket, STATIC_MPS                                # noqa: E402

GOLD = os.path.join(ROOT, 'research', 'edge-case-corpus', 'gold-corpus-v3')


def gold_signatures(gold_dir):
    """One signature per (archetype, trace, challenger) at true OBB closest approach."""
    manifest = json.load(open(os.path.join(gold_dir, 'MANIFEST.json')))
    sigs = collections.Counter()
    cat_of = {}
    n_traces = 0
    for arch, entry in manifest['corpus'].items():
        cat_of[arch] = entry['category']
        for fn in entry['files']:
            if not fn.endswith('.trace.json.gz'):
                continue
            path = os.path.join(gold_dir, arch, fn)
            if not os.path.exists(path):
                continue
            n_traces += 1
            tr = G.load_trace(path)
            f = G.trace_facts(tr)
            if 'error' in f:
                continue
            meta = tr['header'].get('actorMetadata', {})
            ts = tr['ticks']['t']
            actors = tr['ticks']['actors']
            ego = actors['ego']
            for aid, pc in (f.get('perChallenger') or {}).items():
                if pc['t'] is None:
                    continue
                k = min(range(len(ts)), key=lambda i: abs(ts[i] - pc['t']))
                a = actors[aid]
                if not (ego['present'][k] and a['present'][k]):
                    continue
                dh = math.degrees(abs(math.atan2(
                    math.sin(ego['headingRad'][k] - a['headingRad'][k]),
                    math.cos(ego['headingRad'][k] - a['headingRad'][k]))))
                lane_e = (ego.get('laneRsl') or [None])[k] if ego.get('laneRsl') else None
                lane_a = (a.get('laneRsl') or [None])[k] if a.get('laneRsl') else None
                lane_rel = 'same' if (lane_e is not None and lane_e == lane_a) else 'different'
                se, sa = ego['speedMps'][k] or 0.0, a['speedMps'][k] or 0.0
                if min(se, sa) < STATIC_MPS:
                    movement = 'counterpart-stopped'
                elif max(se, sa) < 3.0:
                    movement = 'low-speed-both'
                else:
                    movement = 'both-moving'
                kind = meta.get(aid, {}).get('kind', '?')
                kinds = '+'.join(sorted(['car', kind]))   # ego treated as car
                sigs[(heading_bucket(dh), lane_rel, kinds, movement)] += 1
    return sigs, cat_of, n_traces


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('events')
    ap.add_argument('--gold', default=GOLD)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    gold_sigs, cat_of, n_traces = gold_signatures(args.gold)
    gold_set = set(gold_sigs)
    mined = [json.loads(l) for l in open(args.events)]
    mined_sigs = collections.Counter(tuple(e['signature']) for e in mined)
    novel = {s: c for s, c in mined_sigs.items() if s not in gold_set}
    novel_events = sum(novel.values())
    gold_cats = collections.Counter(v.split('.')[0].upper() for v in cat_of.values())
    out = {
        'goldTraces': n_traces, 'goldSignatureTypes': len(gold_sigs),
        'goldSignatures': {' | '.join(k): v for k, v in gold_sigs.most_common()},
        'minedSignatureTypes': len(mined_sigs), 'minedEvents': len(mined),
        'novelSignatureTypes': len(novel),
        'novelEventShare': round(novel_events / len(mined), 4) if mined else None,
        'novelSignatures': {' | '.join(k): v for k, v in
                            sorted(novel.items(), key=lambda kv: -kv[1])},
        'goldCategorySpectrum': dict(gold_cats.most_common()),
    }
    path = args.out or os.path.join(os.path.dirname(args.events), 'novelty.json')
    json.dump(out, open(path, 'w'), indent=1)
    print(json.dumps({k: out[k] for k in ('goldTraces', 'goldSignatureTypes',
                                          'minedSignatureTypes', 'novelSignatureTypes',
                                          'novelEventShare')}, indent=1))
    print('novel:', list(out['novelSignatures'].items())[:12])


if __name__ == '__main__':
    main()
