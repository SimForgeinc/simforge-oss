#!/usr/bin/env python3
"""Scaled footage-review run — Stream B (runs ONLY after calibration PASS).

Sources of cells:
  w7        regenerate a representative W7-luna DEV subset: for each sampled row, take
            the FINAL decision dict from the committed trail (author→repair→revise),
            compile through the frozen author_llm COMPILERS (no LLM call), batch,
            gate every cell with frozen tg_gate, emit contract-§2 cell dirs.
            Rows sampled stratified by (admitted, category), seeded. Both admitted and
            rejected rows are included — the scaled question is whether judge scores
            discriminate WITHIN the pipeline's output, keyed per-cell by gate pass.
  roots     any contract-§2 cell roots announced by FreeformLane/EmergentLane over hub
            (rendered+judged in place; their meta.json is authoritative).

Judging: the FROZEN judge (model/effort/strategy from calibration-results.json) writes
contract-§3 cell/review-<model>.json. Inter-model agreement: every AGREE_EVERY-th cell
(seeded order) is additionally judged by the other two models at the chosen effort.

Usage:
  scale_run.py w7    --run /tmp/tgr-footage-scale1 --calib /tmp/tgr-footage-calib1 [--rows 24]
  scale_run.py roots --run /tmp/tgr-footage-scale1 --calib ... --roots DIR [DIR...]
  scale_run.py judge --run /tmp/tgr-footage-scale1 --calib ...
  scale_run.py analyze --run ... --calib ...
"""
import argparse
import itertools
import json
import os
import random
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import futil                                                               # noqa: E402
import judge as judge_mod                                                  # noqa: E402
import render_cells                                                        # noqa: E402

sys.path.insert(0, os.path.join(futil.REPO, 'tools', 'gates'))
sys.path.insert(0, os.path.join(futil.REPO, 'research', 'edge-case-corpus', 'tools', 'vista'))

SEED = 20260816
W7_DEV = os.path.join(futil.REPO, 'research', 'edge-case-corpus', 'reports',
                      'training-grade', 'W7-luna-DEV.json')
MAPS = ('easterbrook-discovery-school,belmont-research-center,'
        'richmond-field-station,yale-street,el-camino-road')
CLI = ['node', os.path.join(futil.REPO, 'packages', 'cli', 'bin', 'uniscenarios.js')]
AGREE_EVERY = 3       # every 3rd cell gets all three models at the chosen effort


def chosen_judge(calib_run):
    res = futil.load_json(os.path.join(calib_run, 'calibration-results.json'))
    if not res.get('calibrationPassed'):
        raise SystemExit('calibration did not pass; scaling is not allowed (plan §3B)')
    model, effort = res['chosenJudge'].split('/')
    return model, effort, res['strategy']


def final_decision(row):
    d = None
    for r in row.get('rounds', []):
        if r.get('kind') in ('author', 'repair', 'revise') and isinstance(r.get('decision'), dict):
            d = r['decision']
    return d


def stage_w7(run, n_rows, draws, max_sites):
    import author_llm as W
    briefs, dev, held = W.A.load_splits()
    brief_by_id = {b['id']: b for b in briefs}
    rows = futil.load_json(W7_DEV)['rows']
    rng = random.Random(SEED)
    by_stratum = {}
    for r in rows:
        d = final_decision(r)
        if d is None or r['id'] not in brief_by_id:
            continue
        by_stratum.setdefault((bool(r.get('admitted')), r['category'].split('.')[0]), []).append(r)
    for v in by_stratum.values():
        v.sort(key=lambda r: r['id'])
        rng.shuffle(v)
    picked, order = [], sorted(by_stratum)
    while len(picked) < n_rows and any(by_stratum[k] for k in order):
        for k in order:
            if by_stratum[k] and len(picked) < n_rows:
                picked.append(by_stratum[k].pop())
    print(f'w7: {len(picked)} rows over {len(order)} strata')

    cells_root = os.path.join(run, 'cells', 'w7')
    log = []
    for row in picked:
        d = final_decision(row)
        brief = brief_by_id[row['id']]
        try:
            tpl = W.COMPILERS[d['family']](brief, d)
        except Exception as e:                                             # noqa: BLE001
            log.append({'id': row['id'], 'error': f'compile: {e}'})
            continue
        tpl_path = os.path.join(run, 'templates', f'{row["id"]}.template.json')
        os.makedirs(os.path.dirname(tpl_path), exist_ok=True)
        json.dump(tpl, open(tpl_path, 'w'), indent=1)
        out_dir = os.path.join(run, 'batches', row['id'])
        cmd = CLI + ['batch', tpl_path, '--maps', MAPS, '--max-sites', str(max_sites),
                     '--draws', str(draws), '--concurrency', '6', '--ambient', 'off',
                     '--out', out_dir]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        n = emit_cells(out_dir, row, brief, cells_root)
        log.append({'id': row['id'], 'admittedW7': bool(row.get('admitted')),
                    'category': row['category'], 'rc': p.returncode, 'cells': n,
                    'cmd': ' '.join(cmd)})
        print(f'w7 {row["id"]} admitted={row.get("admitted")} cells={n}')
    futil.dump_json(os.path.join(run, 'w7-build-log.json'), log)
    print(f'w7 cells total: {len(futil.discover_cells(cells_root))}')


def emit_cells(batch_root, row, brief, cells_root):
    import tg_gate as G
    n = 0
    for dirpath, _, files in os.walk(batch_root):
        for f in sorted(files):
            if not f.endswith('.instance.json'):
                continue
            stem = f[:-len('.instance.json')]
            trace_p = os.path.join(dirpath, stem + '.trace.json.gz')
            res_p = os.path.join(dirpath, stem + '.result.json')
            if not (os.path.isfile(trace_p) and os.path.isfile(res_p)):
                continue
            res = futil.load_json(res_p)
            if res.get('status') != 'ok':
                continue
            g = G.gate_cell(trace_p, verdict=res.get('verdict'), band=res.get('band'),
                            brief=brief['brief'], version=2)
            if 'error' in g:
                continue
            site = os.path.basename(dirpath)[:8]
            draw = stem.split('draw-')[-1]
            cid = f'footage-scale1-{row["id"]}-{res["mapId"]}-{site}-{draw}'
            d = os.path.join(cells_root, cid)
            os.makedirs(d, exist_ok=True)
            shutil.copyfile(os.path.join(dirpath, f), os.path.join(d, 'instance.json'))
            shutil.copyfile(trace_p, os.path.join(d, 'trace.json.gz'))
            futil.dump_json(os.path.join(d, 'meta.json'), {
                'cellId': cid, 'briefId': row['id'], 'stream': futil.STREAM,
                'templateSha256': None, 'map': res['mapId'], 'site': res.get('siteId') or site,
                'draw': int(draw), 'seed': res.get('paramSeed'),
                'gate': {'pass': bool(g['pass']), 'firstFailure': G.first_failure(g),
                         'clearanceM': g.get('clearanceM'), 'tMinClearance': g.get('closestT')},
                'notes': f'w7 regen admittedW7={bool(row.get("admitted"))} '
                         f'category={row["category"]}'})
            n += 1
    return n


def stage_roots(run, roots):
    """Register sibling cell roots (judged in place, not copied)."""
    reg_path = os.path.join(run, 'roots.json')
    reg = futil.load_json(reg_path) if os.path.isfile(reg_path) else []
    for r in roots:
        r = os.path.abspath(r)
        if r not in reg:
            n = len(futil.discover_cells(r))
            print(f'root {r}: {n} cells')
            reg.append(r)
    futil.dump_json(reg_path, reg)


def all_cells(run):
    cells = futil.discover_cells(os.path.join(run, 'cells'))
    reg_path = os.path.join(run, 'roots.json')
    if os.path.isfile(reg_path):
        for r in futil.load_json(reg_path):
            cells.extend(futil.discover_cells(r))
    return cells


def stage_judge(run, calib_run, workers, render_workers, agree_every=AGREE_EVERY):
    model, effort, strategy = chosen_judge(calib_run)
    print(f'frozen judge: {model}/{effort} strategy={strategy} agreeEvery={agree_every}')
    cells = all_cells(run)
    # render whatever lacks a redacted render
    need = [c for c in cells if not os.path.isfile(
        os.path.join(c, 'render', 'render-manifest.json'))]
    if need:
        print(f'rendering {len(need)} cells first')
        args = argparse.Namespace(width=800, height=500, scale=8.0, fps=4,
                                  redact=True, camera='follow-ego',
                                  dev_assets=os.path.join(futil.REPO, 'dev-assets'),
                                  force=False)
        with ThreadPoolExecutor(max_workers=render_workers) as pool:
            list(pool.map(lambda c: render_cells.render_cell(c, args), need))

    rng = random.Random(SEED + 3)
    ordered = sorted(cells)
    rng.shuffle(ordered)
    jobs = []
    for i, c in enumerate(ordered):
        models = [model] if i % agree_every else list(futil.MODELS)
        for m in models:
            if not os.path.isfile(os.path.join(c, f'review-{m}.json')):
                jobs.append((c, m))
    print(f'judging: {len(jobs)} verdicts to produce over {len(cells)} cells')
    for m in sorted({m for _, m in jobs}):
        futil.assert_vision_session(m)
    lock = threading.Lock()
    log_path = os.path.join(run, 'judge-log.jsonl')

    def one(job):
        c, m = job
        try:
            v = judge_mod.judge_cell(c, m, effort, strategy)
            judge_mod.write_contract_verdict(c, v)
            with lock:
                with open(log_path, 'a') as f:
                    f.write(json.dumps({'cell': c, 'model': m,
                                        'tokens': v['_meta']['tokens'],
                                        'latencyS': v['_meta']['latencyS']}) + '\n')
            return None
        except Exception as e:                                             # noqa: BLE001
            with lock:
                with open(log_path, 'a') as f:
                    f.write(json.dumps({'cell': c, 'model': m, 'error': str(e)[:300]}) + '\n')
            return str(e)

    errs = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for err in pool.map(one, jobs):
            if err:
                errs += 1
                print(f'ERR {err[:160]}', file=sys.stderr)
    print(f'judged with {errs} errors; vision log: {json.dumps(futil.vision_log())}')


def stage_analyze(run, calib_run):
    model, effort, strategy = chosen_judge(calib_run)
    cells = all_cells(run)
    rows = []
    for c in cells:
        meta = futil.load_json(os.path.join(c, 'meta.json'))
        for m in futil.MODELS:
            p = os.path.join(c, f'review-{m}.json')
            if os.path.isfile(p):
                v = futil.load_json(p)
                rows.append({'cell': c, 'meta': meta, 'v': v, 'model': m})
    primary = [r for r in rows if r['model'] == model]
    def gate_state(r):
        g = r['meta'].get('gate') or {}
        return g.get('pass')       # True / False / None (not yet gated)
    by_gate = {'pass': [r for r in primary if gate_state(r) is True],
               'fail': [r for r in primary if gate_state(r) is False]}
    ungated = [r for r in primary if gate_state(r) is None]
    out = {'frozenJudge': f'{model}/{effort}/{strategy}', 'nCells': len(cells),
           'nVerdicts': len(rows), 'nUngated': len(ungated)}
    for k, sel in by_gate.items():
        out[f'realism_{k}'] = futil.summarize_scores([r['v']['realism'] for r in sel])
        out[f'dynamism_{k}'] = futil.summarize_scores([r['v']['dynamism'] for r in sel])
        out[f'plausibleRate_{k}'] = (round(sum(r['v']['plausible'] for r in sel) / len(sel), 3)
                                     if sel else None)
    rp = [r['v']['realism'] for r in by_gate['pass']]
    rf = [r['v']['realism'] for r in by_gate['fail']]
    if rp and rf:
        out['realismAUC_gatePass_vs_fail'] = round(futil.auc_mannwhitney(rp, rf), 4)
    # per-stream and per-source buckets
    per_stream = {}
    for r in primary:
        per_stream.setdefault(r['meta'].get('stream', '?'), []).append(r['v']['realism'])
    out['realismByStream'] = {k: futil.summarize_scores(v) for k, v in sorted(per_stream.items())}
    # inter-model agreement on the every-Nth subsample
    agree = {}
    for m1, m2 in itertools.combinations(futil.MODELS, 2):
        v1 = {r['cell']: r['v']['realism'] for r in rows if r['model'] == m1}
        v2 = {r['cell']: r['v']['realism'] for r in rows if r['model'] == m2}
        common = sorted(set(v1) & set(v2))
        if len(common) >= 8:
            import calibrate
            agree[f'{m1}~{m2}'] = {'n': len(common),
                                   'spearman': round(calibrate._spearman(
                                       [v1[c] for c in common], [v2[c] for c in common]), 3)}
    out['interModelAgreement'] = agree
    # cost
    toks, lats = [], []
    log_path = os.path.join(run, 'judge-log.jsonl')
    if os.path.isfile(log_path):
        for line in open(log_path):
            r = json.loads(line)
            if 'error' not in r:
                toks.append((r['tokens']['in'] or 0) + (r['tokens']['out'] or 0))
                lats.append(r['latencyS'])
    if toks:
        out['cost'] = {'verdicts': len(toks), 'meanTokens': round(sum(toks) / len(toks), 1),
                       'meanLatencyS': round(sum(lats) / len(lats), 2),
                       'totalTokens': sum(toks)}
    futil.dump_json(os.path.join(run, 'scale-results.json'), out)
    print(json.dumps(out, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('stages', nargs='+', choices=['w7', 'roots', 'judge', 'analyze'])
    ap.add_argument('--run', required=True)
    ap.add_argument('--calib', required=True)
    ap.add_argument('--rows', type=int, default=24)
    ap.add_argument('--draws', type=int, default=1)
    ap.add_argument('--max-sites', type=int, default=2)
    ap.add_argument('--roots', nargs='*', default=[])
    ap.add_argument('--workers', type=int, default=12)
    ap.add_argument('--render-workers', type=int, default=4)
    ap.add_argument('--agree-every', type=int, default=AGREE_EVERY,
                    help='1 = all three models on every cell')
    args = ap.parse_args()
    for s in args.stages:
        if s == 'w7':
            stage_w7(args.run, args.rows, args.draws, args.max_sites)
        elif s == 'roots':
            stage_roots(args.run, args.roots)
        elif s == 'judge':
            stage_judge(args.run, args.calib, args.workers, min(args.render_workers, 4),
                        args.agree_every)
        elif s == 'analyze':
            stage_analyze(args.run, args.calib)


if __name__ == '__main__':
    main()
