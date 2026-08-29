#!/usr/bin/env python3
"""Regression tests for the frozen-gate implementation. Run: .venv/bin/python tools/gates/test_tg_gate.py

TG-G1 is the reason this file exists: the broad-phase cull in the closest-approach search was
unsound and silently reported the t=0 separation as the closest approach for any trajectory that
started far apart and closed later. That is wrong on C2 (when) and C3 (how close) at once.
"""
import math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tg_gate as G


def synth(gaps, dt=0.1, warmup=2.0):
    """Ego at the origin heading +x; challenger straight ahead at the given gaps, one per tick."""
    n = len(gaps)
    return {'header': {'warmupSeconds': warmup, 'clipSeconds': dt * (n - 1), 'dt': dt,
                       'mapId': 'synthetic', 'seed': 1, 'inputHash': 'x',
                       'actorMetadata': {'ego': {'dims': {'l': 4.0, 'w': 2.0}},
                                         'chal': {'dims': {'l': 4.0, 'w': 2.0}}}},
            'metrics': {'minTTC': {'value': 1.0, 't': dt * (n - 1)}, 'requiredDecelMax': {'ego': 2.0},
                        'collisions': [], 'triggerNeverFired': [], 'declaredOcclusion': [],
                        'occluderIneffective': []},
            'events': [],
            'ticks': {'t': [round(i * dt, 3) for i in range(n)],
                      'actors': {
                          'ego':  {'x': [0.0] * n, 'y': [0.0] * n, 'headingRad': [0.0] * n,
                                   'present': [True] * n, 'speedMps': [10.0] * n,
                                   's': [0.0] * n, 'laneRsl': ['a'] * n},
                          'chal': {'x': list(gaps), 'y': [0.0] * n, 'headingRad': [0.0] * n,
                                   'present': [True] * n, 'speedMps': [0.0] * n,
                                   's': [0.0] * n, 'laneRsl': ['a'] * n}}}}


def check(name, got, want, tol=1e-6):
    ok = abs(got - want) <= tol if isinstance(want, float) else got == want
    print('%-4s %-52s got=%s want=%s' % ('PASS' if ok else 'FAIL', name, got, want))
    return ok


def main():
    ok = True

    # TG-G1: starts far (100 m), closes to 12 m centre-to-centre => OBB clearance 8 m, at the END.
    gaps = [100.0 - i * (88.0 / 50) for i in range(51)]      # 100 -> 12 over 5.0 s
    f = G.trace_facts(synth(gaps))
    ok &= check('TG-G1 closest clearance is the true minimum', round(f['clearanceM'], 3), 8.0, 1e-3)
    ok &= check('TG-G1 closest-approach time is the END, not t=0', f['closestT'], 5.0, 1e-6)

    # The converse: a trajectory that starts close and recedes IS a spawn artifact.
    gaps = [12.0 + i * (88.0 / 50) for i in range(51)]
    f = G.trace_facts(synth(gaps))
    ok &= check('receding trajectory: closest approach at t=0', f['closestT'], 0.0, 1e-6)
    ok &= check('receding trajectory: clearance is the t=0 value', round(f['clearanceM'], 3), 8.0, 1e-3)

    # C2 arithmetic: warmup 2.0 + margin 0.5 => a conflict at 2.4 s fails, 2.6 s passes.
    for t_close, want in ((2.4, False), (2.6, True)):
        n = 101
        gaps = [100.0 - i * (88.0 / (t_close / 0.05)) if i * 0.05 <= t_close else
                12.0 + (i * 0.05 - t_close) * 20 for i in range(n)]
        tr = synth(gaps, dt=0.05)
        f = G.trace_facts(tr)
        c2 = f['closestT'] is not None and f['closestT'] > f['warmupSeconds'] + G.C2_MARGIN
        ok &= check('C2 at closest t=%.2f (warmup 2.0 + 0.5)' % t_close, c2, want)

    # OBB clearance is NOT the circumscribed-circle proxy: car+pedestrian at 3.0 m centre distance.
    A = G._corners(0, 0, 0, 4.8, 1.9)
    B = G._corners(3.0, 0, 0, 0.6, 0.6)
    ok &= check('OBB clearance of car/ped at 3.0 m centres', round(G.obb_clearance(A, B), 3), 0.3, 1e-3)
    ok &= check('overlapping boxes clear at 0.0', G.obb_clearance(A, G._corners(0.5, 0, 0, 4.8, 1.9)), 0.0)

    print('\n%s' % ('ALL GATE TESTS PASS' if ok else 'GATE TESTS FAILED'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
