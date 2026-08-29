"""M4 promotion runner (pre-registered caps: <= 12 re-cast attempts).

Selection: clusters ordered by event count, one attempt per cluster (its most severe
event: T1 first, then lowest TTC), until 12 attempts or clusters exhausted. Each
attempt: build template (recast.py) -> validate -> batch --all-maps, ambient ON,
draws 4 -> gate every cell (frozen gate) -> portability over passing cells.

Also runs the registered perturbation arm: 3 mined ego-involved cells re-run with a
density bump and gated DIRECTLY (expected structural fail at C2/C3: the gate cannot
see ambient actors). Usage: promote.py <events.jsonl> [--out DIR]
"""
import argparse, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
sys.path.insert(0, HERE)
import tg_gate as G                                                        # noqa: E402
import probe_lib as P                                                      # noqa: E402
import recast                                                              # noqa: E402

CLI = ['node', os.path.join(ROOT, 'packages', 'cli', 'bin', 'uniscenarios.js')]
MAX_ATTEMPTS = 12


def severity_key(e):
    return (0 if e['tier'] == 'T1' else 1,
            e['ttcRrS'] if e['ttcRrS'] is not None else 99,
            e['minClearanceM'])


def select_attempts(events):
    clusters = {}
    for e in events:
        clusters.setdefault(tuple(e['signature']) + (e['category'],), []).append(e)
    ordered = sorted(clusters.items(), key=lambda kv: -len(kv[1]))
    picked, used_families = [], {}
    for sig, evs in ordered:
        if len(picked) >= MAX_ATTEMPTS:
            break
        ev = sorted(evs, key=severity_key)[0]
        fam, builder = recast.family_for(ev)
        if fam is None:
            continue
        # diversity: at most 3 attempts per family
        if used_families.get(fam, 0) >= 3:
            continue
        used_families[fam] = used_families.get(fam, 0) + 1
        picked.append((sig, fam, builder, ev, len(evs)))
    return picked


def run_attempt(idx, sig, fam, builder, ev, cluster_n, base, ambient_seed):
    adir = os.path.join(base, 'attempt-%02d-%s' % (idx, fam))
    os.makedirs(adir)
    tpl_path = os.path.join(adir, 'recast.template.json')
    tpl = builder(ev)
    json.dump(tpl, open(tpl_path, 'w'), indent=1)
    rec = {'attempt': idx, 'family': fam, 'cluster': list(sig), 'clusterSize': cluster_n,
           'sourceEvent': {k: ev[k] for k in ('cell', 'pair', 'kinds', 'tier',
                                              'minClearanceM', 'ttcRrS', 'maxDecel',
                                              'category', 'signature', 'egoInvolved')},
           'template': tpl_path}
    v = subprocess.run(CLI + ['template', 'validate', tpl_path], capture_output=True,
                       text=True, timeout=300, cwd=ROOT)
    try:
        vout = json.loads(v.stdout.splitlines()[-1])
    except Exception:                                                       # noqa: BLE001
        vout = {'ok': False, 'raw': (v.stdout or v.stderr)[-300:]}
    rec['validate'] = {'ok': bool(vout.get('ok')),
                       'findings': [f.get('reason') for f in (vout.get('findings') or [])][:5]}
    if not vout.get('ok'):
        rec['status'] = 'invalid'
        return rec
    out = os.path.join(adir, 'batch')
    os.makedirs(out)
    args = CLI + ['batch', tpl_path, '--all-maps', '--draws', '4', '--concurrency', '6',
                  '--ambient', 'heavy', '--ambient-seed', str(ambient_seed),
                  '--out', out]
    t0 = time.time()
    p = subprocess.run(args, capture_output=True, text=True, timeout=3000, cwd=ROOT)
    rec['batchWallS'] = round(time.time() - t0, 1)
    summ_path = os.path.join(out, 'batch-summary.json')
    if not os.path.exists(summ_path):
        rec['status'] = 'no-batch'
        rec['stderr'] = (p.stderr or p.stdout)[-400:]
        return rec
    summary = json.load(open(summ_path))
    recs = P.gate_summary(summary)
    census = P.loss_census(recs)
    passing = [r for r in recs if r.get('pass')]
    port = G.portability(passing)
    rec.update({
        'cells': len(recs), 'passed': len(passing),
        'admissionRate': round(len(passing) / len(recs), 4) if recs else None,
        'firstFailureCensus': census['share'], 'portability': port,
        'admitted': bool(passing) and port['ok'],
        'passingCells': [{'map': r.get('mapId'), 'site': r.get('site'),
                          'draw': r.get('draw'), 'trace': r.get('trace'),
                          'clearanceM': r.get('clearanceM'), 'minTTC': r.get('minTTC')}
                         for r in passing][:20],
        'status': 'done'})
    return rec


def perturbation_arm(events, base):
    """3 ego-involved mined cells, re-run with a density bump, gated directly."""
    ego_evs = [e for e in events if e['egoInvolved'] and e['tier'] == 'T1'][:3] or \
              [e for e in events if e['egoInvolved']][:3]
    out_recs = []
    for i, ev in enumerate(ego_evs):
        c = ev['cell']
        out = os.path.join(base, 'perturb-%d' % i)
        os.makedirs(out)
        tpl = os.path.join(HERE, 'templates', 'world-%s.template.json' % c['template'])
        args = CLI + ['batch', tpl, '--map', c['map'], '--max-sites', '12', '--draws', '1',
                      '--concurrency', '6', '--ambient', c['preset'],
                      '--ambient-seed', str(c['seed']),
                      '--ambient-density', str((c['density'] or 16) + 8), '--out', out]
        p = subprocess.run(args, capture_output=True, text=True, timeout=1800, cwd=ROOT)
        summ_path = os.path.join(out, 'batch-summary.json')
        if not os.path.exists(summ_path):
            out_recs.append({'source': c, 'error': (p.stderr or '')[-200:]})
            continue
        summary = json.load(open(summ_path))
        row = next((r for r in summary.get('results', [])
                    if r.get('siteId') == c['site']), None)
        if row is None or not row.get('traceFile'):
            out_recs.append({'source': c, 'error': 'site not re-run'})
            continue
        g = G.gate_cell(row['traceFile'], verdict=row.get('verdict'),
                        band=row.get('band'), version=2)
        out_recs.append({'source': {k: c[k] for k in ('template', 'map', 'preset',
                                                      'seed', 'site')},
                         'perturbation': 'density +8',
                         'pass': g['pass'], 'firstFailure': G.first_failure(g),
                         'clearanceM': g['clearanceM'],
                         'C': {k: g[k] for k in ('C1', 'C2', 'C3', 'C4', 'C5')}})
    return out_recs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('events')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    base = args.out or '/tmp/tgr-worldgen-m4-%d' % int(time.time() * 1000)
    os.makedirs(base, exist_ok=True)
    events = [json.loads(l) for l in open(args.events)]
    picked = select_attempts(events)
    print('attempts: %d  (from %d events)' % (len(picked), len(events)), flush=True)
    results = []
    for i, (sig, fam, builder, ev, n) in enumerate(picked):
        rec = run_attempt(i, sig, fam, builder, ev, n, base,
                          ambient_seed=ev['cell']['seed'])
        results.append(rec)
        print(json.dumps({k: rec.get(k) for k in ('attempt', 'family', 'status',
                                                  'cells', 'passed', 'admitted',
                                                  'firstFailureCensus')}), flush=True)
    print('perturbation arm:', flush=True)
    perturb = perturbation_arm(events, base)
    print(json.dumps(perturb, indent=1), flush=True)
    attempts_admitted = sum(1 for r in results if r.get('admitted'))
    summary = {
        'base': base, 'attempts': len(results),
        'attemptsAdmitted': attempts_admitted,
        'promotionRate': round(attempts_admitted / len(results), 4) if results else None,
        'cellsRun': sum(r.get('cells') or 0 for r in results),
        'cellsPassed': sum(r.get('passed') or 0 for r in results),
        'attemptRecords': results, 'perturbationArm': perturb,
    }
    json.dump(summary, open(os.path.join(base, 'promotion-results.json'), 'w'), indent=1)
    print(json.dumps({k: summary[k] for k in ('base', 'attempts', 'attemptsAdmitted',
                                              'promotionRate', 'cellsRun',
                                              'cellsPassed')}, indent=1))


if __name__ == '__main__':
    main()
