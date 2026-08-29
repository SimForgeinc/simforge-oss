#!/usr/bin/env python3
"""NO-RELAXATION TRIPWIRE. Run this on every continuation, before and after every work item.

It proves three separate things, because each has failed independently in this project's history:

  1. MANIFEST INTEGRITY -- the pre-registered gate JSONs still hash to the frozen
     sha256 1a08698e95fca4bc (v1) / 3823182614e5a5ba (v2).
     Convention (reverse-engineered and confirmed against BOTH manifests):
         sha256(json.dumps({k: v for k, v in gate.items() if k != 'sha256'}, sort_keys=True))

  2. IMPLEMENTATION INTEGRITY -- the numeric thresholds actually compiled into tg_gate.py match
     the numbers written in the frozen criteria TEXT. A gate can be relaxed without touching the
     manifest by editing one constant; this catches that.

  3. EVIDENCE DISCIPLINE -- the C3 implementation computes true OBB clearance and never reads the
     engine's `minDistance` circumscribed-circle proxy.

Exit 0 = gate unchanged. Non-zero = STOP, something relaxed the frozen contract.
"""
import hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EC = os.path.join(ROOT, 'research', 'edge-case-corpus')

V1_PATH = os.path.join(EC, 'agent-authoring', 'round3', 'PHYSICAL-GATE.json')
V2_PATH = os.path.join(EC, 'PHYSICAL-GATE-v2.json')
EXPECT = {'v1': '1a08698e95fca4bc97bd192ac2199be27b13e43ba066a654ee513d0f74f44c2d',
          'v2': '3823182614e5a5ba48db3dec06d09bbc178e874483f13f43176c32b930d79754'}

sys.path.insert(0, HERE)
import tg_gate as G                                                        # noqa: E402


def gate_sha(gate):
    body = {k: v for k, v in gate.items() if k != 'sha256'}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def main():
    fails, checks = [], []

    # ---- 1. manifest integrity
    gates = {}
    for tag, path in (('v1', V1_PATH), ('v2', V2_PATH)):
        if not os.path.exists(path):
            fails.append('%s manifest MISSING at %s' % (tag, path)); continue
        g = json.load(open(path)); gates[tag] = g
        got, want = gate_sha(g), EXPECT[tag]
        ok = (got == want) and (g.get('sha256') == want)
        checks.append(('manifest-%s' % tag, ok, '%s (declared %s)' % (got[:16], str(g.get('sha256'))[:16])))
        if not ok:
            fails.append('%s sha256 %s != frozen %s -- THE GATE CHANGED' % (tag, got[:16], want[:16]))

    # ---- 2. implementation integrity: constants vs the frozen criteria TEXT
    if 'v2' in gates:
        text = ' '.join(gates['v2']['criteria'])
        # numbers as pre-registered, paired with the constant that must equal them
        want_consts = [
            ('C1 maxSpeedMps',   r'maxSpeedMps\s*>=\s*([\d.]+)',        G.C1_SPEED),
            ('C1 distance',      r'distanceTravelledM\s*>=\s*([\d.]+)', G.C1_DIST),
            ('C2 margin',        r'warmupSeconds\s*\+\s*([\d.]+)',      G.C2_MARGIN),
            ('C3 clearance',     r'closest approach\s*<=\s*([\d.]+)',   G.C3_CLEARANCE),
            ('C4 decel',         r'requiredDecelMax\s*>=\s*([\d.]+)',   G.C4_DECEL),
            ('C4 ttc',           r'minTTC\s*<=\s*([\d.]+)',             G.C4_TTC),
        ]
        for name, pat, impl in want_consts:
            m = re.search(pat, text)
            if not m:
                fails.append('%s: cannot find the threshold in the frozen criteria text' % name)
                checks.append((name, False, 'threshold not found in manifest')); continue
            declared = float(m.group(1))
            # A LOOSER implementation is a contract breach. An IDENTICAL one is required here;
            # deliberate tightening must be re-pre-registered as a new gate version.
            ok = abs(declared - float(impl)) < 1e-9
            checks.append((name, ok, 'manifest %.3f vs impl %.3f' % (declared, float(impl))))
            if not ok:
                fails.append('%s: implementation %.3f != pre-registered %.3f' % (name, float(impl), declared))

        # C6 must still be armed by occlusion intent and require a proven, effective occluder
        ok6 = (G.OCC_OK_STATUS == ('revealed_before_conflict', 'blocked_at_conflict'))
        checks.append(('C6 statuses', ok6, str(G.OCC_OK_STATUS)))
        if not ok6:
            fails.append('C6 accepted-status set changed')

        ok_port = (G.PORT_MIN_MAPS, G.PORT_MIN_SITES) == (2, 3)
        checks.append(('portability >=2 maps/>=3 sites', ok_port,
                       '%d maps / %d sites' % (G.PORT_MIN_MAPS, G.PORT_MIN_SITES)))
        if not ok_port:
            fails.append('portability clause changed')

    # ---- 3. evidence discipline: C3 must not read minDistance
    src = open(os.path.join(HERE, 'tg_gate.py')).read()
    code = '\n'.join(l for l in src.splitlines()
                     if not l.lstrip().startswith('#') and 'minDistance' not in l or "'minDistance'" in l)
    uses_proxy = bool(re.search(r"metrics.*\[\s*['\"]minDistance", src)) or \
                 bool(re.search(r"get\(\s*['\"]minDistance", src))
    checks.append(('C3 uses true OBB clearance, not minDistance', not uses_proxy,
                   'obb_clearance present: %s' % ('def obb_clearance' in src)))
    if uses_proxy:
        fails.append('tg_gate.py reads the minDistance proxy -- C3 evidence discipline broken')
    if 'def obb_clearance' not in src:
        fails.append('obb_clearance() missing from tg_gate.py')

    width = max(len(c[0]) for c in checks) if checks else 10
    for name, ok, detail in checks:
        print('%-4s %-*s  %s' % ('PASS' if ok else 'FAIL', width, name, detail))
    print()
    if fails:
        print('GATE-HASH TRIPWIRE: FAIL (%d)' % len(fails))
        for f in fails:
            print('  ! ' + f)
        return 1
    print('GATE-HASH TRIPWIRE: PASS -- frozen gate v1 %s / v2 %s unchanged'
          % (EXPECT['v1'][:16], EXPECT['v2'][:16]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
