#!/usr/bin/env python3
"""Build the labelled footage-calibration set (contract-§2 cell dirs + labels).

Classes (design inherited from tools/tg-research/instrument/PREREG.md B+/healthy
"naturalism" axis, extended per the 2026-08-16 owner amendment — see PREREG-v2 in
research/edge-case-corpus/reports/rethink/footage/):

  good   — cells regenerated from gold/example templates that PASS the frozen gate
           (tg_gate.gate_cell v2, verdict/band from the batch result.json).
  absurd — cells regenerated from committed physically-broken templates, kept only
           when the class's deterministic absurdity marker is verified on the raw
           trace (tools/tg-research/instrument/metrics.py, reused read-only):
             c7-*-baseline    -> prop_overlap_count >= 1   (VRU inside occluder)
             b1-frozen-ego    -> frozen_ego == 1           (ego never really moves)
             b2-zero-kph      -> authored_stop_violations >= 1 (0-speed non-static actor)

Ambient traffic OFF for both classes (density is Stream C's variable, not ours;
mixing it into one class would confound the axis).

Output: <run>/cells/<label>/<cellId>/{instance.json,trace.json.gz,meta.json},
<run>/labels.json, <run>/set-manifest.json (commands, counts, exclusions).
"""
import argparse
import gzip
import json
import os
import random
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import futil                                                               # noqa: E402

sys.path.insert(0, os.path.join(futil.REPO, 'tools', 'tg-research', 'instrument'))
import tg_gate                                                             # noqa: E402
from metrics import compute_metrics                                        # noqa: E402

CLI = ['node', os.path.join(futil.REPO, 'packages', 'cli', 'bin', 'uniscenarios.js')]
MAPS = ('easterbrook-discovery-school,belmont-research-center,'
        'richmond-field-station,yale-street,el-camino-road')
INSTR = os.path.join(futil.REPO, 'tools', 'tg-research', 'instrument')
PROBES = os.path.join(futil.REPO, 'tools', 'gates', 'probes')
EX = os.path.join(futil.REPO, 'examples')

GOOD_TEMPLATES = [
    os.path.join(EX, 'mechanisms', 'corridor', 'lead-hard-brake.template.json'),
    os.path.join(EX, 'mechanisms', 'obstacle', 'disabled-vehicle.template.json'),
    os.path.join(EX, 'mechanisms', 'obstacle', 'fallen-cargo.template.json'),
    os.path.join(EX, 'mechanisms', 'obstacle', 'animal-crossing.template.json'),
    os.path.join(EX, 'mechanisms', 'remaining', 'oncoming-overtake.template.json'),
    os.path.join(EX, 'mechanisms', 'junction-vru', 'cyclist-crossing-path.template.json'),
    os.path.join(PROBES, 'c7-bus-shelter-fixed.template.json'),
    os.path.join(PROBES, 'c7-hedge-corner-fixed.template.json'),
    # wave 2 (added 2026-08-16 BEFORE any judge verdict; PREREG-v2 amendment note):
    # the first 8 yielded only 4 gate-passing templates — widen mechanism diversity
    os.path.join(EX, 'mechanisms', 'corridor', 'cut-in-brake.template.json'),
    os.path.join(EX, 'mechanisms', 'corridor', 'cutout-reveals-stopped.template.json'),
    os.path.join(EX, 'mechanisms', 'corridor', 'queue-tail.template.json'),
    os.path.join(EX, 'mechanisms', 'corridor', 'merge-gap-collapse.template.json'),
    os.path.join(EX, 'mechanisms', 'junction-vru', 'adult-midblock-crossing.template.json'),
    os.path.join(EX, 'mechanisms', 'junction-vru', 'left-turn-crosswalk.template.json'),
    os.path.join(EX, 'mechanisms', 'junction-vru', 'right-turn-crosswalk.template.json'),
    os.path.join(EX, 'mechanisms', 'parking-transit', 'backing-out-vehicle.template.json'),
    os.path.join(EX, 'mechanisms', 'parking-transit', 'vehicle-pulls-out.template.json'),
    os.path.join(EX, 'mechanisms', 'parking-transit', 'delivery-double-park.template.json'),
    os.path.join(EX, 'mechanisms', 'remaining', 'slow-vulnerable-lead.template.json'),
    os.path.join(EX, 'mechanisms', 'remaining', 'cross-traffic-stop-violation.template.json'),
]
ABSURD_TEMPLATES = [
    os.path.join(INSTR, 'broken-templates', 'b1-frozen-ego.template.json'),
    os.path.join(INSTR, 'broken-templates', 'b2-zero-kph.template.json'),
    os.path.join(PROBES, 'c7-bus-shelter-baseline.template.json'),
    os.path.join(PROBES, 'c7-fence-run-baseline.template.json'),
    os.path.join(PROBES, 'c7-hedge-corner-baseline.template.json'),
    os.path.join(PROBES, 'c7-parked-row-child-baseline.template.json'),
    os.path.join(PROBES, 'c7-skip-container-baseline.template.json'),
]
SEED = 20260816


def short(tpl):
    return os.path.basename(tpl).replace('.template.json', '')


def brief_for(tpl):
    name = short(tpl)
    if name.startswith('c7-'):
        return f'occlusion probe: {name}'      # arms C6 honestly: mechanism IS occlusion
    return name


def run_batch(tpl, out_dir, draws, max_sites, concurrency):
    cmd = CLI + ['batch', tpl, '--maps', MAPS, '--max-sites', str(max_sites),
                 '--draws', str(draws), '--concurrency', str(concurrency),
                 '--ambient', 'off', '--out', out_dir]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    return {'cmd': ' '.join(cmd), 'rc': p.returncode, 'tail': p.stdout[-300:]}


def marker_check(name, g, trace, instance):
    """(label_valid, marker_name, marker_value) for absurd templates."""
    m = compute_metrics(trace, instance)
    if name.startswith('c7-'):
        return (m.get('prop_overlap_count') or 0) >= 1, 'prop_overlap_count', m.get('prop_overlap_count')
    if name.startswith('b1-'):
        return m.get('frozen_ego') == 1, 'frozen_ego', m.get('frozen_ego')
    if name.startswith('b2-'):
        return (m.get('authored_stop_violations') or 0) >= 1, 'authored_stop_violations', m.get('authored_stop_violations')
    raise ValueError(f'unknown absurd template {name}')


def harvest(batch_root, tpl, label, run_id, log):
    """All (candidate_cell_record) from one template's batch output."""
    name = short(tpl)
    tpl_sha = futil.sha256_file(tpl)
    recs = []
    for dirpath, _, files in os.walk(batch_root):
        for f in sorted(files):
            if not f.endswith('.instance.json'):
                continue
            stem = f[:-len('.instance.json')]
            inst_p = os.path.join(dirpath, f)
            trace_p = os.path.join(dirpath, stem + '.trace.json.gz')
            res_p = os.path.join(dirpath, stem + '.result.json')
            if not (os.path.isfile(trace_p) and os.path.isfile(res_p)):
                log.append({'skip': inst_p, 'reason': 'missing trace/result'})
                continue
            res = futil.load_json(res_p)
            if res.get('status') != 'ok':
                log.append({'skip': inst_p, 'reason': f'status={res.get("status")}'})
                continue
            g = tg_gate.gate_cell(trace_p, verdict=res.get('verdict'), band=res.get('band'),
                                  brief=brief_for(tpl), version=2)
            if 'error' in g:
                log.append({'skip': inst_p, 'reason': g['error']})
                continue
            keep, marker, mval = True, None, None
            if label == 'good':
                keep = bool(g['pass'])
                if not keep:
                    log.append({'skip': inst_p, 'reason': f'gate fail {tg_gate.first_failure(g)}'})
            else:
                trace = tg_gate.load_trace(trace_p)
                instance = futil.load_json(inst_p)
                keep, marker, mval = marker_check(name, g, trace, instance)
                if not keep:
                    log.append({'skip': inst_p, 'reason': f'marker {marker}={mval} unverified'})
            if not keep:
                continue
            site = os.path.basename(dirpath)[:8]
            draw = stem.split('draw-')[-1]
            cell_id = f'footage-{run_id}-{name}-{res["mapId"]}-{site}-{draw}'
            recs.append({'cellId': cell_id, 'template': name, 'templateSha256': tpl_sha,
                         'label': label, 'map': res['mapId'], 'site': res.get('siteId') or site,
                         'draw': int(draw), 'seed': res.get('paramSeed'),
                         'instance': inst_p, 'trace': trace_p,
                         'gate': {'pass': bool(g['pass']),
                                  'firstFailure': tg_gate.first_failure(g),
                                  'clearanceM': g.get('clearanceM'),
                                  'tMinClearance': g.get('closestT')},
                         'marker': ({'name': marker, 'value': mval} if marker else None)})
    return recs


def stratified_sample(recs, target, rng):
    """Round-robin across (template, map) groups so no template dominates."""
    groups = {}
    for r in recs:
        groups.setdefault((r['template'], r['map']), []).append(r)
    for g in groups.values():
        rng.shuffle(g)
    order = sorted(groups)
    rng.shuffle(order)
    out = []
    while len(out) < target and any(groups[k] for k in order):
        for k in order:
            if groups[k] and len(out) < target:
                out.append(groups[k].pop())
    return out


def emit_cell(rec, run_id, cells_root):
    d = os.path.join(cells_root, rec['label'], rec['cellId'])
    os.makedirs(d, exist_ok=True)
    shutil.copyfile(rec['instance'], os.path.join(d, 'instance.json'))
    shutil.copyfile(rec['trace'], os.path.join(d, 'trace.json.gz'))
    meta = {'cellId': rec['cellId'], 'briefId': rec['template'], 'stream': futil.STREAM,
            'templateSha256': rec['templateSha256'], 'map': rec['map'], 'site': rec['site'],
            'draw': rec['draw'], 'seed': rec['seed'], 'gate': rec['gate'],
            'notes': f'calibration label={rec["label"]}'
                     + (f' marker={rec["marker"]["name"]}={rec["marker"]["value"]}'
                        if rec['marker'] else '')}
    futil.dump_json(os.path.join(d, 'meta.json'), meta)
    return d


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--run', required=True, help='run dir, e.g. /tmp/tgr-footage-calib1')
    ap.add_argument('--run-id', default='calib1')
    ap.add_argument('--target-per-class', type=int, default=24)
    ap.add_argument('--draws', type=int, default=2)
    ap.add_argument('--max-sites', type=int, default=2)
    ap.add_argument('--concurrency', type=int, default=6)
    ap.add_argument('--skip-batch', action='store_true', help='reuse existing batch outputs')
    args = ap.parse_args()

    rng = random.Random(SEED)
    batches_root = os.path.join(args.run, 'batches')
    cells_root = os.path.join(args.run, 'cells')
    os.makedirs(batches_root, exist_ok=True)
    batch_log, harvest_log = [], []

    sets = [('good', GOOD_TEMPLATES), ('absurd', ABSURD_TEMPLATES)]
    for label, tpls in sets:
        for tpl in tpls:
            out_dir = os.path.join(batches_root, label, short(tpl))
            if not args.skip_batch or not os.path.isdir(out_dir):
                r = run_batch(tpl, out_dir, args.draws, args.max_sites, args.concurrency)
                r.update({'template': short(tpl), 'label': label})
                batch_log.append(r)
                print(f'batch {label}/{short(tpl)} rc={r["rc"]}')

    labels, kept = {}, {'good': [], 'absurd': []}
    for label, tpls in sets:
        recs = []
        for tpl in tpls:
            recs.extend(harvest(os.path.join(batches_root, label, short(tpl)),
                                tpl, label, args.run_id, harvest_log))
        sample = stratified_sample(recs, args.target_per_class, rng)
        for rec in sample:
            emit_cell(rec, args.run_id, cells_root)
            labels[rec['cellId']] = label
            kept[label].append(rec['cellId'])
        print(f'{label}: {len(recs)} candidates -> {len(sample)} sampled')

    futil.dump_json(os.path.join(args.run, 'labels.json'), labels)
    futil.dump_json(os.path.join(args.run, 'set-manifest.json'), {
        'seed': SEED, 'maps': MAPS, 'draws': args.draws, 'maxSites': args.max_sites,
        'ambient': 'off', 'targetPerClass': args.target_per_class,
        'goodTemplates': [short(t) for t in GOOD_TEMPLATES],
        'absurdTemplates': [short(t) for t in ABSURD_TEMPLATES],
        'kept': {k: sorted(v) for k, v in kept.items()},
        'counts': {k: len(v) for k, v in kept.items()},
        'batchLog': batch_log, 'exclusions': harvest_log,
    })
    print(json.dumps({k: len(v) for k, v in kept.items()}))
    if any(len(v) < 20 for v in kept.values()):
        print('WARNING: a class is under 20 cells', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
