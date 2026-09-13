#!/usr/bin/env python3
"""WORK-ZONE GATE (W3). Does a lane closure actually close the lane?

W3 exit criterion, from the brief:
  * `close_lane` produces ZERO ego-into-device contacts on a 40-cell probe
  * a work-zone archetype is admitted at >= 2 maps and >= 3 sites

Two probes:

  contact    the solved closure alone. Counts cells in which the ego's body overlaps a channelizing
             device. Cells in which the EGO NEVER DRIVES are reported separately and are not
             allowed to count as a success: a frozen ego trivially hits nothing, and an earlier
             version of this fix scored 0 contacts that way (36/456 cells with the ego moving,
             median distance 0.0 m). Gate criterion C1 exists for exactly that reason.
  archetype  the closure PLUS a worker stepping into the shifted running lane -- the mechanism that
             makes a work zone an encounter rather than furniture. Gated with gate v2.

Usage:  probe_workzone.py [--draws N] [--max-sites K] [--out report.json]
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import probe_lib as P                                                      # noqa: E402
import tg_gate as G                                                        # noqa: E402

PROBES = os.path.join(HERE, 'probes')
CONTACT_TEMPLATE = os.path.join(PROBES, 'w3-workzone-closure.template.json')
ARCH_TEMPLATE = os.path.join(PROBES, 'c8-worker-intrusion.template.json')
ARCH_BRIEF = 'road works lane closure with a worker stepping into the running lane'
MIN_DRIVING_CELLS = 40


def device_contacts(rec):
    trace = G.load_trace(rec['trace'])
    return [c for c in (trace['metrics'].get('collisions') or [])
            if str(c.get('a', '')).startswith('prop:') or str(c.get('b', '')).startswith('prop:')]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--draws', type=int, default=20)
    ap.add_argument('--max-sites', type=int, default=10)
    ap.add_argument('--concurrency', type=int, default=7)
    ap.add_argument('--out')
    a = ap.parse_args()

    out1 = P.unique_outdir('w3-contact')
    s1 = P.run_batch(CONTACT_TEMPLATE, out1, maps=None, draws=a.draws,
                     max_sites=a.max_sites, concurrency=a.concurrency)
    r1 = [r for r in P.gate_summary(s1) if r.get('firstFailure') != 'NOTRACE']
    driving = [r for r in r1 if r.get('distanceTravelledM', 0) >= G.C1_DIST]
    contacts = [r for r in r1 if device_contacts(r)]
    rejected = {}
    for r in s1.get('results', []):
        if r.get('status') != 'ok':
            code = (r.get('error') or {}).get('code') or 'unknown'
            rejected[code] = rejected.get(code, 0) + 1

    out2 = P.unique_outdir('w3-arch')
    s2 = P.run_batch(ARCH_TEMPLATE, out2, maps=None, draws=a.draws,
                     max_sites=a.max_sites, concurrency=a.concurrency)
    r2 = [r for r in P.gate_summary(s2, brief=ARCH_BRIEF, version=2)
          if r.get('firstFailure') != 'NOTRACE']
    census = P.loss_census(r2)
    port = G.portability(r2)
    # An ADMITTED work-zone cell that clips a cone is not an admitted work-zone cell. The gate's own
    # C5 counts prop contacts, but assert it here too: this is the specific failure W3 exists to
    # remove, so it gets its own named check rather than being trusted to fall out of C5.
    admitted_with_contact = [r for r in r2 if r.get('pass') and device_contacts(r)]
    arch_driving = [r for r in r2 if r.get('distanceTravelledM', 0) >= G.C1_DIST]

    rep = {
      'gate': 'work-zone probe (W3)',
      'contactProbe': {
        'feasibleCells': len(r1),
        'cellsWhereEgoDrove': len(driving),
        'egoIntoDeviceContactCells': len(contacts),
        'maps': len({r['mapId'] for r in r1}), 'sites': len({(r['mapId'], r['site']) for r in r1}),
        'rejectedBySolver': rejected,
        'pass': bool(len(contacts) == 0 and len(driving) >= MIN_DRIVING_CELLS)},
      'archetypeProbe': {
        'feasibleCells': census['cells'], 'admitted': census['passed'],
        'cellsWhereEgoDrove': len(arch_driving),
        'admittedCellsWithDeviceContact': len(admitted_with_contact),
        'firstFailure': census['counts'],
        'perCriterion': {k: sum(1 for r in r2 if r.get(k)) for k in ('C1', 'C2', 'C3', 'C4', 'C5', 'C6')},
        'maps': port['nMaps'], 'sites': port['nSites'],
        'pass': bool(census['passed'] > 0 and port['ok'] and not admitted_with_contact)},
    }
    rep['pass'] = bool(rep['contactProbe']['pass'] and rep['archetypeProbe']['pass'])
    print(json.dumps(rep, indent=1))
    if a.out:
        json.dump(rep, open(a.out, 'w'), indent=1)
    print('\nWORK-ZONE GATE: contact probe %s | archetype probe %s'
          % ('PASS' if rep['contactProbe']['pass'] else 'FAIL',
             'PASS' if rep['archetypeProbe']['pass'] else 'FAIL'))
    return 0 if rep['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
