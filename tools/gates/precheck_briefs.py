#!/usr/bin/env python3
"""FEASIBILITY PRE-CHECK (W6). Refuse a brief the five maps cannot host, before authoring it.

W6 exit criterion, from the brief:
  * agrees with the blind plausibility measurement at >= 0.85 on the seven archetypes already
    measured
  * over all 208 briefs, produces a ranked list of exactly which categories the maps cannot host,
    with site counts

This is NOT another validator on the output. It is a query against real map structure taken BEFORE
any authoring: a brief names the kind of place it needs, and the maps either contain enough of that
place to satisfy the frozen portability clause (>= 2 maps AND >= 3 sites) or they do not. The blind
measurement found the property is essentially binary -- 8/8, 8/8, 8/8, 7/8 against 1/8, 1/8, 1/8 --
so a structural query is the right instrument.

Site counts come from `uniscenarios sites match --all-maps` on one probe anchor per structure. They
are measured, cached in structure-inventory.json, and never assumed.

Usage:  precheck_briefs.py [--refresh] [--validate] [--out report.json]
"""
import argparse, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EC = os.path.join(ROOT, 'research', 'edge-case-corpus')
CLI = ['node', os.path.join(ROOT, 'packages', 'cli', 'bin', 'simforge.js')]
INVENTORY = os.path.join(HERE, 'structure-inventory.json')

MIN_MAPS, MIN_SITES = 2, 3          # the frozen portability clause, not a new threshold

# --------------------------------------------------------------------- probes
# One anchor per road STRUCTURE a brief can require. Deliberately minimal: each probe asks for the
# structure and nothing else, so a zero result means "the maps do not contain this", not "my probe
# was over-constrained".
def _anchor(aid, corridor, features=()):
    return {'scenarioVersion': 2, 'metricSubject': 'ego',
            'meta': {'name': aid, 'createdAt': '2026-08-15T00:00:00.000Z',
                     'modifiedAt': '2026-08-15T00:00:00.000Z', 'appVersion': 'uniscenarios/0.0.1',
                     'archetype': 'probe.structure', 'author': 'agent/training-grade-lane'},
            'params': {'declarations': [], 'constraints': []},
            'environment': {'weather': 'clear', 'timeOfDay': 'noon'},
            'anchor': {'id': aid, 'corridor': corridor, 'features': list(features),
                       'policy': {'allowMirror': True, 'maxSitesPerMap': 64,
                                  'diversity': 'moderate', 'minScore': 0.4}},
            'roles': [{'id': 'ego', 'kind': 'on_reference',
                       'actor': {'class': 'car', 'catalogId': 'vehicle.sedan'},
                       'pose': {'laneOffset': 0, 's': 0, 'tFrac': 0, 'headingOffsetRad': 0},
                       'initialSpeedKph': 30}],
            'props': [], 'closures': [],
            'choreography': {'clipSeconds': 10, 'warmupSeconds': 1, 'interactions': []},
            'invariants': []}

BASE = {'runwayDownstreamM': {'value': [120, None], 'essentiality': 'required'}}
REQ = lambda v: {'value': v, 'essentiality': 'required'}

STRUCTURE_PROBES = {
  'plain_corridor':      _anchor('s-plain', dict(BASE)),
  'multilane_same_dir':  _anchor('s-multilane', {**BASE, 'throughLanesSameDir': REQ([2, 8])}),
  'wide_lane_for_closure': _anchor('s-wideclosure', {**BASE, 'throughLanesSameDir': REQ([1, 8]),
                                                     'runwayDownstreamM': REQ([300, None])}),
  'junction_any':        _anchor('s-junction', dict(BASE), [
      {'id': 'jx', 'kind': 'junction', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'junction_signalized': _anchor('s-signal', dict(BASE), [
      {'id': 'jx', 'kind': 'junction', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'},
       'control': {'value': ['signalized'], 'essentiality': 'required'}}]),
  'junction_stop':       _anchor('s-stop', dict(BASE), [
      {'id': 'jx', 'kind': 'junction', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'},
       'control': {'value': ['all_way_stop', 'minor_stop'], 'essentiality': 'required'}}]),
  'multilane_junction':  _anchor('s-mljx', {**BASE, 'throughLanesSameDir': REQ([2, 8])}, [
      {'id': 'jx', 'kind': 'junction', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  # A roundabout is a junction CONTROL class, not a feature kind. An earlier version of this probe
  # asked for kind:'roundabout', which is not in the union, so the template was INVALID and the
  # matcher was never run -- it reported 0 sites for a reason that had nothing to do with the maps.
  'roundabout':          _anchor('s-roundabout', dict(BASE), [
      {'id': 'rb', 'kind': 'junction', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'},
       'control': {'value': ['roundabout'], 'essentiality': 'required'}}]),
  'crossing':            _anchor('s-crossing', dict(BASE), [
      {'id': 'cx', 'kind': 'crossing', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'parking_zone':        _anchor('s-parking', dict(BASE), [
      {'id': 'pz', 'kind': 'parking_zone', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'parking_aisle':       _anchor('s-aisle', {**BASE, 'speedLimitKph': REQ([0, 25]),
                                             'requiresAdjacent': REQ(['parking'])}),
  'kerbside_parking_residential': _anchor('s-kerbside',
      {**BASE, 'speedLimitKph': REQ([0, 40]), 'throughLanesSameDir': REQ([1, 1]),
       'requiresAdjacent': REQ(['parking'])}),
  'bike_lane':           _anchor('s-bike', {**BASE, 'requiresAdjacent': REQ(['bike'])}),
  'bus_stop':            _anchor('s-busstop', dict(BASE), [
      {'id': 'bs', 'kind': 'bus_stop', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'school_zone':         _anchor('s-school', dict(BASE), [
      {'id': 'sz', 'kind': 'school_zone', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'work_zone_suitable':  _anchor('s-wz', dict(BASE), [
      {'id': 'wz', 'kind': 'work_zone_suitable', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'crest':               _anchor('s-crest', dict(BASE), [
      {'id': 'cr', 'kind': 'crest', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'occlusion_zone':      _anchor('s-occ', dict(BASE), [
      {'id': 'oz', 'kind': 'occlusion_zone', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'rail_crossing':       _anchor('s-rail', dict(BASE), [
      {'id': 'rc', 'kind': 'rail_crossing', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'driveway':            _anchor('s-driveway', dict(BASE), [
      {'id': 'dw', 'kind': 'driveway', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'merge_or_diverge':    _anchor('s-merge', dict(BASE), [
      {'id': 'mg', 'kind': 'merge', 'essentiality': 'required',
       'atM': {'value': [0, 0], 'essentiality': 'required'}}]),
  'oncoming_lane':       _anchor('s-oncoming', {**BASE, 'throughLanesSameDir': REQ([1, 1]),
                                                'speedLimitKph': REQ([30, 80])}),
}

# ------------------------------------------------- brief text -> required structures
# Each rule is (regex over the brief text, structures it requires). A brief requires the UNION of
# every rule it matches, plus whatever its category requires.
TEXT_RULES = [
  (r'\bparking (aisle|lot|garage|structure)\b|\baisle\b',      ['parking_aisle']),
  (r'\bkerbside|curbside|parked (car|van|vehicle)s? (on|along|both)|residential street\b',
                                                               ['kerbside_parking_residential']),
  (r'\bparked\b|\bparking\b|\bdouble.?park|\bbay\b|\breverse|\bbacking\b',  ['parking_zone']),
  (r'\broundabout|\bcirculating\b|\bmini.?roundabout',         ['roundabout']),
  (r'\bsignal|\btraffic light|\bred light|\bgreen\b|\byellow\b|\bamber\b|\bphase\b|\bpreemption\b',
                                                               ['junction_signalized']),
  (r'\bstop sign|\ball.?way stop|\bstop.controlled',           ['junction_stop']),
  (r'\bjunction|\bintersection|\bcrossroads|\bturn(s|ing)? (across|left|right)\b|\bt.bone\b',
                                                               ['junction_any']),
  (r'\bcrossing\b|\bcrosswalk|\bzebra|\bpelican\b',            ['crossing']),
  (r'\bcyclist|\bbicycl|\bbike\b|\be.?scooter|\bmotorcycl|\bptw\b|\bfiltering\b', ['bike_lane']),
  (r'\bbus\b|\bbus stop|\balighting\b',                        ['bus_stop']),
  (r'\bschool|\bchild|\bpupil|\bcrossing guard|\bdrop.?off',   ['school_zone']),
  (r'\bwork ?zone|\broad ?works|\bcone|\btaper|\bflagger|\blane closure|\bconstruction\b',
                                                               ['work_zone_suitable']),
  (r'\bcrest\b|\bbrow of|\bhill\b|\bblind summit',             ['crest']),
  (r'\bocclu|\bhidden\b|\bhides?\b|\bobscur|\bblind spot|\bbehind (a|the|parked)', ['occlusion_zone']),
  (r'\brail|\blevel crossing|\btram\b',                        ['rail_crossing']),
  (r'\bdriveway\b',                                            ['driveway']),
  (r'\bmerge\b|\bmerging\b|\bslip road|\bon.?ramp|\blane drop|\blane ends|\bzip\b',
                                                               ['merge_or_diverge']),
  (r'\bmulti.?lane|\badjacent lane|\bnext lane|\bovertak|\bweave|\blane change|\bcut.in\b',
                                                               ['multilane_same_dir']),
  (r'\boncoming\b|\bhead.?on|\bopposing\b|\bwrong.?way|\bcontraflow', ['oncoming_lane']),
]

CATEGORY_RULES = {
  'C4.roundabout': ['roundabout'],
  'C11.parking':   ['parking_zone'],
  'C12.school':    ['school_zone'],
  'C8.workzone':   ['work_zone_suitable'],
}


def required_structures(brief):
    text = ('%s %s' % (brief.get('brief', ''), brief.get('id', ''))).lower()
    out = set()
    for pattern, structures in TEXT_RULES:
        if re.search(pattern, text):
            out.update(structures)
    out.update(CATEGORY_RULES.get(brief.get('category', ''), []))
    if not out:
        out.add('plain_corridor')
    return sorted(out)


def measure_inventory():
    """Run every structure probe against all five maps and record real site counts."""
    inv = {}
    for name, template in STRUCTURE_PROBES.items():
        path = '/tmp/tg-structure-%s.template.json' % name
        json.dump(template, open(path, 'w'), indent=1)
        # Validate the probe FIRST. Two probes in the first version of this file were invalid
        # templates (`kind: 'roundabout'`, `corridor.adjacentLanes`) and reported 0 sites because
        # the matcher never ran. A malformed instrument reading zero is not a map inventory fact,
        # so an unparseable probe is a hard error here rather than a silent absence.
        v = subprocess.run(CLI + ['template', 'validate', path],
                           capture_output=True, text=True, cwd=ROOT, timeout=300)
        if v.returncode != 0:
            reason = ''
            for line in v.stdout.splitlines():
                if line.strip().startswith('{'):
                    try:
                        issues = json.loads(line).get('issues') or []
                        reason = '; '.join(str(i.get('message'))[:160] for i in issues[:2])
                    except Exception:                                      # noqa: BLE001
                        pass
            unmatchable = 'unmatchable' in reason or 'not matchable' in reason
            if not unmatchable:
                raise SystemExit('structure probe %r is not a valid template: %s'
                                 % (name, (v.stdout or v.stderr)[-400:]))
            # The kind exists in the schema but the MATCHER cannot bind it, so no anchor can ever
            # ask for it. For a pre-check that is the same practical answer as "the maps do not
            # contain it", but the reason is different and is recorded rather than blurred.
            inv[name] = {'sites': 0, 'maps': 0, 'perMap': {}, 'satisfiesPortability': False,
                         'matchable': False, 'reason': reason}
            print('  %-32s UNMATCHABLE by the anchor matcher <-- CANNOT HOST' % name)
            continue
        p = subprocess.run(CLI + ['sites', 'match', path, '--all-maps'],
                           capture_output=True, text=True, cwd=ROOT, timeout=900)
        out = None
        for line in p.stdout.splitlines():
            line = line.strip()
            if line.startswith('{'):
                try:
                    out = json.loads(line)
                except Exception:                                          # noqa: BLE001
                    pass
        per_map, total = {}, 0
        if out:
            for m in out.get('maps', []):
                n = len(m.get('sites') or [])
                if n:
                    per_map[m['mapId']] = n
                total += n
        inv[name] = {'sites': total, 'maps': len(per_map), 'perMap': per_map, 'matchable': True,
                     'satisfiesPortability': bool(len(per_map) >= MIN_MAPS and total >= MIN_SITES)}
        print('  %-32s sites=%4d maps=%d %s' % (name, total, len(per_map),
                                                '' if inv[name]['satisfiesPortability'] else '<-- CANNOT HOST'))
    return inv


def precheck(brief, inv):
    """Two different questions, kept apart because they have different answers and different owners.

    ABSENT       the structure has zero sites, or the matcher cannot bind it at all. No site will
                 ever bind, so the brief cannot be authored here in any form. This is what
                 "the maps cannot host this category" means, and it is the pre-check's refusal.
    NOT PORTABLE the structure exists but cannot supply the frozen >= 2 maps / >= 3 sites clause.
                 The brief can be authored; it just cannot be ADMITTED portably. That is a
                 different, weaker statement, so it is a warning rather than a refusal.

    The distinction is decided by the rule, not by the answer: `crest` has 1 site on 1 map, so a
    crest brief is authorable but not portable; `roundabout` and `parking_aisle` have none at all.
    """
    needs = required_structures(brief)
    absent = [n for n in needs
              if inv.get(n, {}).get('sites', 0) == 0 or inv.get(n, {}).get('matchable') is False]
    thin = [n for n in needs
            if n not in absent and not inv.get(n, {}).get('satisfiesPortability')]
    return {'id': brief.get('id'), 'category': brief.get('category'),
            'requires': needs, 'missing': absent, 'notPortable': thin,
            'feasible': not absent,
            'feasibleAndPortable': not absent and not thin,
            'siteCounts': {n: inv.get(n, {}).get('sites', 0) for n in needs}}


# ------------------------------------------------------------------ validation
# The seven archetypes with a balanced, gate-independent BLIND plausibility measurement
# (tools/vista/FINDINGS.md section 42). The property is bimodal: 8/8, 8/8, 8/8, 7/8 vs 1/8, 1/8, 1/8.
BLIND_SEVEN = [
  {'id': 'blind-crest-queue', 'category': 'C1.car-following', 'plausible': '8/8', 'label': True,
   'brief': 'A queue of stopped traffic sits just beyond the crest of a hill and the ego arrives at speed.'},
  {'id': 'c4g-circulating-sudden-stop', 'category': 'C4.roundabout', 'plausible': '8/8', 'label': True,
   'brief': 'A circulating vehicle in the roundabout stops suddenly in front of the ego.'},
  {'id': 'low-friction-stop-slide', 'category': 'C14.loss-of-control', 'plausible': '8/8', 'label': True,
   'brief': 'The ego brakes on a low-friction surface and slides past its intended stopping point.'},
  {'id': 'c1g-illegal-u-turn', 'category': 'C10.oncoming', 'plausible': '7/8', 'label': True,
   'brief': 'An oncoming vehicle makes an illegal U-turn across the ego path.'},
  {'id': 'c11g-hidden-child', 'category': 'C11.parking', 'plausible': '1/8', 'label': False,
   'brief': 'A child runs out from between parked cars on a narrow residential street with kerbside parking.'},
  {'id': 'c11g-indicator-mislead', 'category': 'C11.parking', 'plausible': '1/8', 'label': False,
   'brief': 'A car in the parking aisle indicates one way and pulls out the other, into the ego path.'},
  {'id': 'parked-vans-narrow-road', 'category': 'C11.parking', 'plausible': '1/8', 'label': False,
   'brief': 'Parked vans line both sides of a narrow residential street with kerbside parking and the ego must thread between them.'},
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true', help='re-measure the structure inventory')
    ap.add_argument('--out')
    a = ap.parse_args()

    if a.refresh or not os.path.exists(INVENTORY):
        print('measuring structure inventory over all five maps...')
        inv = measure_inventory()
        json.dump(inv, open(INVENTORY, 'w'), indent=1)
    else:
        inv = json.load(open(INVENTORY))

    # ---- validation against the blind seven
    hits, strict_hits = [], []
    for b in BLIND_SEVEN:
        r = precheck(b, inv)
        ok = (r['feasible'] == b['label'])
        hits.append(ok)
        strict_hits.append(r['feasibleAndPortable'] == b['label'])
        print('  %-4s %-28s blind=%-4s precheck=%-10s absent=%-28s thin=%s'
              % ('OK' if ok else 'MISS', b['id'], b['plausible'],
                 'FEASIBLE' if r['feasible'] else 'INFEASIBLE',
                 ','.join(r['missing']) or '-', ','.join(r['notPortable']) or '-'))
    agreement = sum(hits) / len(hits)
    strict_agreement = sum(strict_hits) / len(strict_hits)
    print('\n  agreement, "can the maps host it at all"      : %.4f (%d/%d)'
          % (agreement, sum(hits), len(hits)))
    print('  agreement, stricter "portably" reading        : %.4f (%d/%d)'
          % (strict_agreement, sum(strict_hits), len(strict_hits)))

    # ---- the whole corpus
    corpus = json.load(open(os.path.join(EC, 'agent-authoring', 'brief-corpus-full.json')))
    briefs = corpus['briefs']
    per_brief = [precheck(b, inv) for b in briefs]
    by_cat = {}
    for r in per_brief:
        c = by_cat.setdefault(r['category'], {'total': 0, 'infeasible': 0, 'missing': {}})
        c['total'] += 1
        if not r['feasible']:
            c['infeasible'] += 1
            for m in r['missing']:
                c['missing'][m] = c['missing'].get(m, 0) + 1

    ranked = sorted(by_cat.items(),
                    key=lambda kv: (-kv[1]['infeasible'] / kv[1]['total'], -kv[1]['total']))
    print('\n  ranked: which categories the five maps cannot host')
    print('  %-22s %6s %11s %8s  %s' % ('category', 'briefs', 'infeasible', 'share', 'missing structure (sites on these maps)'))
    for cat, c in ranked:
        miss = ', '.join('%s (%d sites, %d maps)'
                         % (m, inv.get(m, {}).get('sites', 0), inv.get(m, {}).get('maps', 0))
                         for m in sorted(c['missing'], key=lambda k: -c['missing'][k]))
        print('  %-22s %6d %11d %7.2f  %s' % (cat, c['total'], c['infeasible'],
                                              c['infeasible'] / c['total'], miss or '-'))

    unhostable = {n: v for n, v in inv.items() if not v['satisfiesPortability']}
    rep = {'gate': 'brief-to-map feasibility pre-check (W6)',
           'portabilityClause': {'minMaps': MIN_MAPS, 'minSites': MIN_SITES},
           'blindSevenAgreement': round(agreement, 4),
           'blindSevenAgreementPortableReading': round(strict_agreement, 4),
           'blindSeven': [{'id': b['id'], 'blind': b['plausible'], 'label': b['label'],
                           'precheck': precheck(b, inv)['feasible'],
                           'missing': precheck(b, inv)['missing']} for b in BLIND_SEVEN],
           'structureInventory': inv,
           'structuresTheMapsCannotHost': unhostable,
           'corpus': {'briefs': len(briefs),
                      'infeasible': sum(1 for r in per_brief if not r['feasible']),
                      'byCategory': {k: v for k, v in ranked}},
           'perBrief': per_brief,
           'pass': bool(agreement >= 0.85)}
    if a.out:
        json.dump(rep, open(a.out, 'w'), indent=1)
        print('\nwrote %s' % a.out)
    print('\nPRE-CHECK GATE: %s (agreement %.4f, required >= 0.85)'
          % ('PASS' if rep['pass'] else 'FAIL', agreement))
    return 0 if rep['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
