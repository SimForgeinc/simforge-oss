#!/usr/bin/env python3
"""VISTA2 run orchestrator.

Usage:
  .venv/bin/python tools/research/vista2/run_vista2.py --run-id pilot1 \
      --briefs c1-lead-stopped,c5b-runner,c7b-van-hides-ped \
      --model gpt-5.6-luna --effort medium

  --briefs sample        -> the frozen shared sample (tools/research/shared/briefs-sample.json)
  --briefs sample-dev    -> its 30 DEV briefs only
  --briefs sample-owner  -> its 20 owner briefs only

Per session preflight (fatal on failure): frozen-gate tripwire, vision assertion for
the exact model+effort, gateway reachability. Every episode writes a transcript, a
guide snapshot, cell artifacts (contract section 2) from its final emit, and a metrics
row. Output root: /tmp/tgr-vista-<run-id>/ (never reused).
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, time

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))

import vagent  # noqa: E402
import vworld  # noqa: E402

HARNESS_FILES = ['vrender.py', 'vworld.py', 'vagent.py', 'run_vista2.py']


def harness_sha256():
    h = hashlib.sha256()
    for f in HARNESS_FILES:
        h.update(open(os.path.join(_HERE, f), 'rb').read())
    return h.hexdigest()


def preflight(model, effort):
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'gates',
                                                     'verify_gate_hash.py')],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('GATE TRIPWIRE FAILED — stopping.\n' + r.stdout + r.stderr)
    env = dict(os.environ, VISTA_MODEL=model, VISTA_EFFORT=effort)
    env.setdefault('OPENAI_BASE_URL', 'http://127.0.0.1:4141/v1')
    env.setdefault('OPENAI_API_KEY', 'x')
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'gates',
                                                     'assert_vision.py')],
                       capture_output=True, text=True, env=env)
    print(r.stdout.strip())
    if r.returncode != 0:
        raise SystemExit('VISION ASSERTION FAILED for %s/%s — stopping.' % (model, effort))
    return True


def load_briefs(spec):
    sample_path = os.path.join(ROOT, 'tools', 'research', 'shared', 'briefs-sample.json')
    if spec.startswith('sample'):
        s = json.load(open(sample_path))
        if spec == 'sample-dev':
            return s['dev']
        if spec == 'sample-owner':
            return s['owner']
        return s['dev'] + s['owner']
    corpus = json.load(open(os.path.join(ROOT, 'research', 'edge-case-corpus',
                                         'agent-authoring', 'brief-corpus-full.json')))
    byid = {b['id']: b for b in corpus['briefs']}
    s = json.load(open(sample_path))
    byid.update({b['id']: b for b in s['dev'] + s['owner']})
    out = []
    for bid in spec.split(','):
        bid = bid.strip()
        if bid not in byid:
            raise SystemExit('unknown brief id %r' % bid)
        out.append(byid[bid])
    return out


def write_cells(run_id, brief_id, episode, cells_root):
    """Cell artifacts per RETHINK-CONTRACTS section 2, from the episode's final emit."""
    res = episode.emit_result
    if not res:
        return []
    tpl_sha = hashlib.sha256(open(res['template'], 'rb').read()).hexdigest()
    made = []
    for c in res['cells']:
        tf, inf = c.get('traceFile'), c.get('instanceFile')
        if not tf or not os.path.exists(tf):
            continue
        cell_id = 'vista2-%s-%s-%s-%s-%s' % (run_id, brief_id, c.get('mapId'),
                                             str(c.get('site'))[:8], c.get('draw'))
        d = os.path.join(cells_root, cell_id)
        os.makedirs(d, exist_ok=True)
        shutil.copy(tf, os.path.join(d, 'trace.json.gz'))
        if inf and os.path.exists(inf):
            shutil.copy(inf, os.path.join(d, 'instance.json'))
        meta = {'cellId': cell_id, 'briefId': brief_id, 'stream': 'vista',
                'templateSha256': tpl_sha, 'map': c.get('mapId'), 'site': c.get('site'),
                'draw': c.get('draw'), 'seed': c.get('seed'),
                'gate': {'pass': bool(c.get('pass')),
                         'firstFailure': c.get('firstFailure'),
                         'clearanceM': c.get('clearanceM'),
                         'tMinClearance': c.get('closestT')},
                'notes': 'vista2 visual closed-loop authoring; final emit of episode'}
        json.dump(meta, open(os.path.join(d, 'meta.json'), 'w'), indent=1)
        made.append(cell_id)
    return made


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run-id', required=True)
    ap.add_argument('--briefs', required=True)
    ap.add_argument('--model', default='gpt-5.6-luna')
    ap.add_argument('--effort', default='medium')
    ap.add_argument('--budget', type=int, default=40)
    ap.add_argument('--wall-cap', type=int, default=2400)
    ap.add_argument('--guide', default=None,
                    help='seed GUIDE.md from this file (default: fresh empty)')
    ap.add_argument('--keep-sim-traces', action='store_true')
    args = ap.parse_args()

    os.environ.setdefault('OPENAI_BASE_URL', 'http://127.0.0.1:4141/v1')
    os.environ.setdefault('OPENAI_API_KEY', 'x')

    run_dir = '/tmp/tgr-vista-%s' % args.run_id
    if os.path.exists(run_dir):
        raise SystemExit('%s exists — run dirs are never reused' % run_dir)
    os.makedirs(run_dir)
    cells_root = os.path.join(run_dir, 'cells')
    os.makedirs(cells_root)

    preflight(args.model, args.effort)
    briefs = load_briefs(args.briefs)
    sha = harness_sha256()
    cfg = {'runId': args.run_id, 'model': args.model, 'effort': args.effort,
           'budget': args.budget, 'wallCapS': args.wall_cap,
           'harnessSha256': sha, 'briefs': [b['id'] for b in briefs],
           'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    json.dump(cfg, open(os.path.join(run_dir, 'run-config.json'), 'w'), indent=1)
    print('run %s | harness sha256 %s | %d briefs | %s/%s'
          % (args.run_id, sha[:16], len(briefs), args.model, args.effort))

    guide_path = os.path.join(run_dir, 'GUIDE.md')
    if args.guide:
        shutil.copy(args.guide, guide_path)
    else:
        open(guide_path, 'w').write('')
    snap_dir = os.path.join(run_dir, 'guide-snapshots')
    os.makedirs(snap_dir)

    metrics_path = os.path.join(run_dir, 'metrics.jsonl')
    for n, brief in enumerate(briefs, 1):
        print('[%d/%d] %s: %s' % (n, len(briefs), brief['id'], brief['brief'][:70]),
              flush=True)
        llm = vagent.LLM(args.model, args.effort,
                         os.path.join(run_dir, brief['id'] + '.llm.jsonl'))
        ep = vagent.Episode(brief, run_dir, llm, guide_path,
                            budget=args.budget, wall_cap_s=args.wall_cap)
        t0 = time.time()
        try:
            row = ep.run()
        except Exception as e:  # noqa: BLE001
            row = {'briefId': brief['id'], 'admitted': False,
                   'error': 'episode crash: %s' % str(e)[:300],
                   'wallS': round(time.time() - t0, 1), 'usage': dict(llm.usage)}
        row['cellIds'] = write_cells(args.run_id, brief['id'], ep, cells_root) \
            if isinstance(ep, vagent.Episode) else []
        with open(metrics_path, 'a') as f:
            f.write(json.dumps(row) + '\n')
        shutil.copy(guide_path, os.path.join(snap_dir, '%02d-%s.md' % (n, brief['id'])))
        if not args.keep_sim_traces:
            work = os.path.join(run_dir, brief['id'], 'work')
            for fn in os.listdir(work) if os.path.isdir(work) else []:
                if fn.endswith('.trace.json.gz'):
                    os.unlink(os.path.join(work, fn))
        print('    admitted=%s actions=%s turns=%s wall=%ss tokens_in=%s out=%s'
              % (row.get('admitted'), row.get('actions'), row.get('turns'),
                 row.get('wallS'), row['usage'].get('input_tokens'),
                 row['usage'].get('output_tokens')), flush=True)

    print('done. metrics: %s | cells: %s | guide: %s'
          % (metrics_path, cells_root, guide_path))


if __name__ == '__main__':
    main()
