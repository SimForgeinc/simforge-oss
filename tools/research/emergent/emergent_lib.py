"""Shared helpers for EmergentLane (rethink stream C).

Cell discovery + frozen-gate application over `uniscenarios batch` output dirs.
The gate itself is imported from the frozen tools/gates/tg_gate.py — never copied.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
import tg_gate as G  # noqa: E402

CLI = ['node', os.path.join(ROOT, 'packages', 'cli', 'bin', 'uniscenarios.js')]


def run_cli(args, timeout=3600):
    """Run the bundled CLI; returns (exitCode, stdout). Never raises on exit!=0."""
    p = subprocess.run(CLI + list(args), capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def collect_cells(out_dir):
    """Walk one batch --out dir: [{map, site, draw, instance, result, trace}]."""
    cells = []
    for map_id in sorted(os.listdir(out_dir)):
        map_dir = os.path.join(out_dir, map_id)
        if not os.path.isdir(map_dir):
            continue
        for site in sorted(os.listdir(map_dir)):
            site_dir = os.path.join(map_dir, site)
            if not os.path.isdir(site_dir):
                continue
            for name in sorted(os.listdir(site_dir)):
                if not name.endswith('.result.json'):
                    continue
                stem = name[:-len('.result.json')]
                cells.append({
                    'map': map_id, 'site': site, 'draw': stem,
                    'instance': os.path.join(site_dir, stem + '.instance.json'),
                    'result': os.path.join(site_dir, name),
                    'trace': os.path.join(site_dir, stem + '.trace.json.gz'),
                })
    return cells


def gate_cell(cell, brief=None):
    """Frozen gate over one collected cell. Adds map/site/draw and the death cause.

    Death causes: gate first-failure (C1..C6), 'no-trace' (cell errored before
    simulation), or 'harness:evidence-mismatch' (trace_input_hash_mismatch finding;
    engine control-lane repair after materializer hash — EngineLane defect, not physics).
    """
    res = json.load(open(cell['result']))
    verdict, band = res.get('verdict'), res.get('band')
    findings = {f.get('code') for f in (res.get('findings') or [])}
    if not os.path.exists(cell['trace']):
        return {'pass': False, 'cause': 'no-trace', 'map': cell['map'],
                'site': cell['site'], 'draw': cell['draw'], 'verdict': verdict,
                'band': band, 'findings': sorted(findings)}
    g = G.gate_cell(cell['trace'], verdict=verdict, band=band, brief=brief, version=2)
    g['map'] = cell['map']
    g['site'] = cell['site']
    g['drawName'] = cell['draw']
    cause = G.first_failure(g)
    if cause == 'C5' and 'trace_input_hash_mismatch' in findings:
        cause = 'harness:evidence-mismatch'
    g['cause'] = cause
    g['findingCodes'] = sorted(findings)
    # Trim bulk: perChallenger can be large on dense cells and we never print it.
    g.pop('perChallenger', None)
    return g


def summarize(gated):
    """Pass rate + death census for a list of gated cells."""
    n = len(gated)
    passed = [g for g in gated if g.get('pass')]
    census = {}
    for g in gated:
        if g.get('pass'):
            continue
        census[g.get('cause') or 'unknown'] = census.get(g.get('cause') or 'unknown', 0) + 1
    return {'cells': n, 'passed': len(passed),
            'passRate': round(len(passed) / n, 4) if n else None,
            'deathCensus': dict(sorted(census.items(), key=lambda kv: -kv[1]))}
