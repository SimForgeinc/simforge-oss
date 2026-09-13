"""VISTA2 world state: the scene under construction, its portable template, and the
engine plumbing (sites match / instantiate / simulate / evaluate / batch / frozen gate).

Portability invariant (non-negotiable): the agent may point at pixels, but every
placement is projected pixel -> world -> route arc -> lane-relative anchor
(dsM / dLane / tFrac / lateralM) BEFORE it enters the template. The template never
contains a coordinate or a road id.

Route calibration: selecting a working site instantiates the current (ego-only)
template once at --draw 0; the materialized ego carries behavior.route.lanes — the
concrete lane chain. Concatenating those lanes' topology polylines gives the route
centerline in world coordinates; projecting the ego's realized spawn onto it and
comparing with the ego's authored pose.s gives the arc<->anchor-s shift. From then on
any world point projects to an exact anchor pose.
"""
import copy, hashlib, json, math, os, re, subprocess, sys, time

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
sys.path.insert(0, _HERE)

import tg_gate as G          # frozen gate (read-only)  # noqa: E402
import vrender as R          # noqa: E402

CLI = ['node', os.path.join(ROOT, 'packages', 'cli', 'bin', 'uniscenarios.js')]
MAPS = ['yale-street', 'belmont-research-center', 'el-camino-road',
        'easterbrook-discovery-school', 'richmond-field-station']


WORLD_ENV_KEYS = {
    'env.weather': 'weather',
    'env.timeOfDay': 'timeOfDay',
    'env.frictionScale': 'frictionScale',
    'env.wind': 'wind',
}
WORLD_COLLECTION_KEYS = {
    'env.surfacePatch': 'surfacePatches',
    'env.marking': 'markingTreatments',
}
SIGNAL_PHASE_KEY = re.compile(
    r'^signal:feature:[A-Za-z][A-Za-z0-9_-]{0,63}:(ego|opposing|left|right)\.phase$')
WORLD_USAGE = (
    '{"action":"set_world","key":"env.weather","value":"snow"}; '
    'use env.timeOfDay/env.frictionScale/env.wind, env.surfacePatch/env.marking, '
    'or signal:feature:<featureId>:<ego|opposing|left|right>.phase')

VEHICLE_CLASS = {
    'vehicle.bus': 'bus', 'vehicle.school_bus': 'bus', 'vehicle.shuttle_bus': 'bus',
    'vehicle.tram': 'bus',
    'vehicle.box_truck': 'truck', 'vehicle.semi_truck': 'truck', 'vehicle.dump_truck': 'truck',
    'vehicle.cement_mixer': 'truck', 'vehicle.flatbed_truck': 'truck',
    'vehicle.garbage_truck': 'truck', 'vehicle.tanker_truck': 'truck',
    'vehicle.tow_truck': 'truck', 'vehicle.fire_engine': 'truck',
    'vehicle.utility_bucket_truck': 'truck',
    'vehicle.delivery_van': 'van', 'vehicle.van': 'van', 'vehicle.minivan': 'van',
    'vehicle.ambulance': 'van',
    'vehicle.motorcycle': 'motorcycle', 'vehicle.bicycle': 'bicycle',
    'vehicle.mobility_scooter': 'scooter',
}

# The known catalog (from packages/scenario-materializer/src/prop-dims.ts). Short names
# are normalized; unknown ids are rejected with candidates — a bad catalogId otherwise
# passes `template validate` silently and materializes as a dead static_object.
KNOWN_CATALOG = set((
    'vehicle.sedan vehicle.suv vehicle.hatchback vehicle.pickup vehicle.minivan '
    'vehicle.van vehicle.delivery_van vehicle.box_truck vehicle.semi_truck '
    'vehicle.dump_truck vehicle.flatbed_truck vehicle.garbage_truck vehicle.tanker_truck '
    'vehicle.cement_mixer vehicle.tow_truck vehicle.bus vehicle.school_bus '
    'vehicle.shuttle_bus vehicle.taxi vehicle.police_cruiser vehicle.police_suv '
    'vehicle.ambulance vehicle.fire_engine vehicle.fire_command_suv vehicle.motorcycle '
    'vehicle.bicycle vehicle.mobility_scooter vehicle.tram vehicle.utility_bucket_truck '
    'pedestrian.adult_walking pedestrian.adult_standing pedestrian.child_walking '
    'pedestrian.child_standing pedestrian.elderly_walking pedestrian.traffic_marshal '
    'animal.deer animal.dog animal.cat animal.stray_dog animal.raccoon animal.goose '
    'animal.buck animal.doe '
    'hazard.tire_debris hazard.mattress hazard.ladder hazard.cardboard_box hazard.debris '
    'hazard.downed_branch hazard.trash_bags '
    'construction.traffic_cone construction.channelizer_drum construction.jersey_barrier '
    'construction.excavator construction.flagger construction.arrow_board '
    'construction.sign_road_work construction.jersey_barrier_run '
    'occluder.dumpster occluder.covered_car occluder.hedge_run occluder.fence_run '
    'street.bus_shelter street.food_cart street.shopping_cart'
).split())
_SHORT = {c.split('.', 1)[1]: c for c in KNOWN_CATALOG}


def normalize_catalog(catalog):
    """(id or None, error or None). Accepts full ids and unambiguous short names."""
    c = str(catalog or '').strip()
    if c in KNOWN_CATALOG:
        return c, None
    if c in _SHORT:
        return _SHORT[c], None
    near = [k for k in KNOWN_CATALOG if c and (c in k or k.split('.')[1] in c)][:6]
    return None, ('unknown catalog id %r; nearest: %s' % (catalog, ', '.join(near) or
                  'none — see the catalog list in the rules'))


def actor_class(catalog):
    head = catalog.split('.')[0]
    if head == 'vehicle':
        return VEHICLE_CLASS.get(catalog, 'car')
    if head == 'pedestrian':
        return 'pedestrian'
    if head == 'cyclist':
        return 'bicycle'
    if head == 'animal':
        return 'animal'
    if head == 'drone':
        return 'drone'
    return 'static_object'


def cli(*args, timeout=1800):
    p = subprocess.run(CLI + [str(a) for a in args], capture_output=True, text=True,
                       timeout=timeout, cwd=ROOT)
    out = None
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                out = json.loads(line)
            except Exception:  # noqa: BLE001
                pass
    return p.returncode, out, p.stdout[-2500:], p.stderr[-2500:]


def _issues(out, so, se):
    if out and out.get('issues'):
        return [str(i.get('message', i))[:200] for i in out['issues'][:5]]
    txt = (se or so or '').strip()
    return [txt[-400:]] if txt else ['unknown error']


class Scene:
    """One brief's scene under construction."""

    def __init__(self, brief, workdir, clip_s=16.0, warmup_s=2.0):
        self.brief = brief
        self.workdir = workdir
        os.makedirs(workdir, exist_ok=True)
        self.contract = brief.get('showcaseContract') or {'obligations': [], 'structures': []}
        self.clip_s = max(20.0, clip_s) if brief.get('showcaseContract') else clip_s
        self.warmup_s = warmup_s
        self.fixed_need = self._contract_need()
        self.need = dict(self.fixed_need)  # agent may add requirements, never remove contract requirements
        self.sites = []          # flattened match results
        self.site = None         # selected site record
        self.route_pl = None     # [(x,y)...] route centerline at working site
        self.route_arc = None    # cumulative arc lengths
        self.s_shift = 0.0       # anchor s = arc + s_shift
        self.roles = {}          # id -> role dict (template form)
        self.props = {}          # id -> prop dict (template form)
        self.interactions = []   # template form, ids i1..iN
        self._iseq = 0
        self.environment = {}    # authored v2 environment; empty preserves legacy default

        self._ego_default()

    def _contract_need(self):
        kinds = {item['kind'] for item in self.contract.get('obligations', [])}
        need = {}
        if 'signalized_junction' in kinds:
            need.update(feature='junction', control='signalized')
        elif 'junction' in kinds or 'ego_left_turn' in kinds:
            need['feature'] = 'junction'
        if 'ego_left_turn' in kinds:
            need['egoTurn'] = 'left'
        if 'lane_splitting_actor' in kinds:
            need['minOpposingLanes'] = 2
        elif 'oncoming_actor' in kinds:
            need['minOpposingLanes'] = 1
        return need

    def contract_invariants(self):
        kinds = {item['kind'] for item in self.contract.get('obligations', [])}
        invariants = []
        motorcycle = next((role['id'] for role in self.roles.values()
                           if role.get('actor', {}).get('class') == 'motorcycle'), None)
        if motorcycle:
            invariants.append({'id': 'requested-criticality', 'kind': 'ttc',
                               'essentiality': 'required', 'of': 'ego',
                               'to': motorcycle, 'range': [0.5, 3]})
        if 'ego_braking_response' in kinds:
            invariants.append({'id': 'ego-decel-budget', 'kind': 'decel_budget',
                               'essentiality': 'required', 'of': 'ego', 'maxMps2': 8})
        return invariants

    # ------------------------------------------------------------- template
    def _ego_default(self):
        self.roles['ego'] = {
            'id': 'ego', 'kind': 'on_reference', 'label': 'vehicle under test',
            'actor': {'class': 'car', 'catalogId': 'vehicle.sedan'},
            'essentiality': 'required',
            'pose': {'laneOffset': 0, 's': 40.0, 'tFrac': 0, 'headingOffsetRad': 0},
            'initialSpeedKph': 'clamp(0.8 * lane.speedLimitKph, 25, 50)',
        }

    def corridor(self):
        c = {'throughLanesSameDir': {'value': [int(self.need.get('minLanes', 1)), 8],
                                     'essentiality': 'required'},
             'runwayDownstreamM': {'value': [120, None], 'essentiality': 'required'}}
        if self.need.get('minOpposingLanes'):
            c['throughLanesOpposing'] = {
                'value': [int(self.need['minOpposingLanes']), 8], 'essentiality': 'required'}
        if self.need.get('adjacentSidewalk'):
            c['requiresAdjacent'] = {'value': ['sidewalk'], 'essentiality': 'preferred',
                                     'weight': 3}
        return c

    def features(self):
        f = self.need.get('feature')
        if not f:
            return []
        at_m = [0, 0] if f == 'junction' else [40, 200]
        base = {'id': 'f-%s' % f, 'kind': f, 'essentiality': 'required',
                'atM': {'value': at_m, 'essentiality': 'required'}}
        if self.need.get('control'):
            base['control'] = {'value': [self.need['control']], 'essentiality': 'required'}
        if self.need.get('egoTurn'):
            base['egoTurn'] = {'value': [self.need['egoTurn']], 'essentiality': 'required'}
        return [base]

    def _anchor_id(self):
        """Schema-bounded anchor id (^[A-Za-z][A-Za-z0-9_-]{0,63}$). Long brief ids
        (the owner list) overflowed the 64-char limit and made emit() unwinnable —
        harness defect found in run main1, fixed in harness v2."""
        slug = re.sub(r'[^a-z0-9-]', '-', self.brief['id'].lower()).strip('-')
        base = 'vista2-%s' % slug
        if len(base) <= 64:
            return base
        h = hashlib.sha256(self.brief['id'].encode()).hexdigest()[:8]
        return ('vista2-%s-%s' % (slug[:47], h)).replace('--', '-')

    def _description(self):
        """Keep repair evidence from overflowing the v2 metadata contract."""
        description = str(self.brief.get('brief', ''))
        return description if len(description) <= 4000 else description[:3999].rstrip() + '…'

    def template(self):
        now = '2026-08-16T00:00:00.000Z'
        return {
            'scenarioVersion': 2,
            'meta': {'name': self.brief['id'], 'description': self._description(),
                     'createdAt': now, 'modifiedAt': now,
                     'appVersion': 'uniscenarios/0.0.1',
                     'archetype': self.brief.get('category', 'unknown'),
                     'tags': ['vista2'], 'author': 'agent/vista2-visual',
                     'negativeControl': False},
            'params': {'declarations': [], 'constraints': []},
            'environment': (copy.deepcopy(self.environment) if self.environment else
                            {'weather': 'clear', 'timeOfDay': 'afternoon'}),

            'anchor': {'id': self._anchor_id(),
                       'corridor': self.corridor(),
                       'features': self.features(),
                       'policy': {'allowMirror': False, 'maxSitesPerMap': 6,
                                  'diversity': 'moderate', 'minScore': 0.35}},
            'roles': list(self.roles.values()),
            'props': list(self.props.values()),
            'choreography': {'clipSeconds': self.clip_s, 'warmupSeconds': self.warmup_s,
                             'interactions': copy.deepcopy(self.interactions)},
            'invariants': self.contract_invariants(),
            'variants': [],
            'metricSubject': 'ego',
        }

    def write_template(self, tag='wip'):
        path = os.path.join(self.workdir, '%s.template.json' % tag)
        json.dump(self.template(), open(path, 'w'), indent=1)
        return path

    def validate(self):
        path = self.write_template()
        rc, out, so, se = cli('template', 'validate', path)
        return rc == 0, _issues(out, so, se) if rc != 0 else []

    # ------------------------------------------------------------- sites
    def match_sites(self, max_per_map=4):
        path = self.write_template('match')
        rc, out, so, se = cli('sites', 'match', path, '--all-maps')
        if not out:
            return None, _issues(out, so, se)
        flat = []
        for m in out.get('maps', []):
            ranked = sorted(m.get('sites') or [],
                            key=lambda s: (-(s.get('score') or 0), s['siteId']))
            for s in ranked[:max_per_map]:
                flat.append({'mapId': s.get('mapId') or m.get('mapId'),
                             'siteId': s['siteId'], 'score': s.get('score'),
                             'entryLaneRsl': s.get('entryLaneRsl'),
                             'runwayDownstreamM': s.get('runwayDownstreamM')})
        flat.sort(key=lambda s: (-(s['score'] or 0), s['mapId'], s['siteId']))
        for i, s in enumerate(flat):
            s['i'] = i
        self.sites = flat
        fail = out.get('failureSummary') or {}
        for m in out.get('maps', []):
            if m.get('failureSummary'):
                fail[m.get('mapId', '?')] = m['failureSummary']
        return flat, fail

    def select_site(self, i):
        if not self.sites or i < 0 or i >= len(self.sites):
            return False, ['no such site index %s (have %d)' % (i, len(self.sites))]
        self.site = self.sites[i]
        ok, err = self._calibrate()
        if not ok:
            self.site = None
            return False, err
        return True, []

    def _calibrate(self):
        inst, err = self.instantiate_t0()
        if inst is None:
            return False, ['site calibration failed: %s' % '; '.join(err)]
        ego = next(a for a in inst['input']['actors'] if a['id'] == 'ego')
        lanes = (ego.get('behavior', {}).get('route') or {}).get('lanes') or []
        if not lanes:
            return False, ['ego has no lanePath route in instance']
        LNS = R.topo(R.DEV_ASSETS, self.site['mapId'])['lanes']
        pl = []
        for rsl in lanes:
            ln = LNS.get(rsl)
            if not ln or not ln.get('polyline'):
                continue
            pts = [(q['x'], q['y']) for q in ln['polyline']]
            if pl and math.hypot(pl[-1][0] - pts[0][0], pl[-1][1] - pts[0][1]) > \
               math.hypot(pl[-1][0] - pts[-1][0], pl[-1][1] - pts[-1][1]):
                pts = pts[::-1]
            pl += pts
        if len(pl) < 2:
            return False, ['route polyline empty']
        self.route_pl = pl
        acc = [0.0]
        for a, b in zip(pl, pl[1:]):
            acc.append(acc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        self.route_arc = acc
        ex, ey = ego['initial']['pose']['x'], -ego['initial']['pose']['z']
        arc0 = self.route_project(ex, ey)['arc']
        authored_s = self.roles['ego']['pose']['s']
        self.s_shift = float(authored_s) - arc0
        self._last_instance = inst
        return True, []

    def route_project(self, x, y):
        """World point -> {'arc': along-route m, 'lateralM': signed left+, 'sAnchor'}."""
        pl, acc = self.route_pl, self.route_arc
        best = None
        for i, (a, b) in enumerate(zip(pl, pl[1:])):
            seg = math.hypot(b[0] - a[0], b[1] - a[1])
            if seg < 1e-9:
                continue
            t = max(0.0, min(1.0, ((x - a[0]) * (b[0] - a[0])
                                   + (y - a[1]) * (b[1] - a[1])) / seg ** 2))
            qx = a[0] + t * (b[0] - a[0]); qy = a[1] + t * (b[1] - a[1])
            d = math.hypot(x - qx, y - qy)
            if best is None or d < best[0]:
                cross = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / seg
                best = (d, acc[i] + t * seg, cross)
        d, arc, cross = best
        return {'arc': arc, 'lateralM': round(cross, 2),
                'sAnchor': round(arc + self.s_shift, 2), 'distanceM': round(d, 2)}

    def anchor_from_world(self, x, y):
        """Full projection: world -> anchor pose pieces + ground truth diagnostics."""
        proj = self.route_project(x, y)
        rh = self._route_heading(proj['arc'])
        sem = R.semantic_at(self.site['mapId'], x, y, route_heading_deg=rh)
        lane_w = 3.5
        if sem.get('laneWidthM') and sem.get('surface') in ('drivable', 'junction'):
            lane_w = sem['laneWidthM']
        lat = proj['lateralM']
        if abs(lat) <= lane_w / 2 + 0.15:
            lateral = {'dLane': 0, 'tFrac': round(max(-1.0, min(1.0, 2 * lat / lane_w)), 3)}
        else:
            k = int(round(abs(lat) / max(lane_w, 3.0))) * (1 if lat > 0 else -1)
            resid = lat - k * lane_w
            lateral = {'dLane': k, 'tFrac': round(max(-1.0, min(1.0, 2 * resid / lane_w)), 3)}
            if sem['surface'] in ('sidewalk', 'shoulder', 'parking', 'off_road'):
                # beside the carriageway: metric lateral from the route lane centre
                lateral = {'dLane': 0, 'lateralM': round(lat, 2), 'lateralRef': 'lane_centre'}
        opposing = False
        if sem.get('laneTravelHeadingDeg') is not None:
            diff = abs((sem['laneTravelHeadingDeg'] - rh + 180) % 360 - 180)
            opposing = diff > 120 and sem['surface'] in ('drivable', 'junction')
        return {'proj': proj, 'sem': sem, 'lateral': lateral, 'opposing': opposing}

    def _route_heading(self, arc):
        pl, acc = self.route_pl, self.route_arc
        for i in range(len(acc) - 1):
            if acc[i + 1] >= arc:
                a, b = pl[i], pl[i + 1]
                return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        a, b = pl[-2], pl[-1]
        return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))

    # ------------------------------------------------------------- placement
    def place(self, aid, catalog, at, speed_kph=None, heading_deg=None,
              static=False, occludes=None, view=None):
        """Compile a placement to a portable role/prop. `at` is either
        {'px':[x,y]} resolved against `view` (a stored frame's view dict) or
        {'dsM':m,'dLane':k,'tFrac':f}/{'s':m,...} relative form. Returns (ok, info)."""
        if self.site is None:
            return False, {'error': 'select a site first (view_site)'}
        if aid != 'ego':
            catalog, cerr = normalize_catalog(catalog)
            if cerr:
                return False, {'error': cerr}
        diag = {}
        if 'px' in at:
            if view is None:
                return False, {'error': 'pixel placement needs a frame'}
            x, y = R.world_from_pixel(view, at['px'][0], at['px'][1])
            aw = self.anchor_from_world(x, y)
            diag = aw
            s_anchor = aw['proj']['sAnchor']
            lateral = aw['lateral']
            if aid == 'ego':
                pose = {'laneOffset': 0, 's': round(s_anchor, 2), 'headingOffsetRad': 0}
                pose.update({k: v for k, v in lateral.items() if k != 'dLane'}
                            if lateral.get('dLane', 0) == 0 else {'tFrac': 0})
                self.roles['ego']['pose'] = _norm_pose(pose)
            else:
                ds = round(s_anchor - float(self.roles['ego']['pose']['s']), 2)
                rel = {'dsM': ds}
                rel.update(lateral)
                diag['rel'] = rel
                self._upsert(aid, catalog, rel, speed_kph, heading_deg, static, occludes)
        else:
            if aid == 'ego':
                if 's' in at:
                    self.roles['ego']['pose']['s'] = float(at['s'])
                if 'tFrac' in at:
                    self.roles['ego']['pose']['tFrac'] = float(at['tFrac'])
            else:
                rel = {'dsM': float(at.get('dsM', 20)), 'dLane': int(at.get('dLane', 0)),
                       'tFrac': float(at.get('tFrac', 0))}
                if at.get('lateralM') is not None:
                    rel = {'dsM': rel['dsM'], 'dLane': 0,
                           'lateralM': float(at['lateralM']), 'lateralRef': 'lane_centre'}
                self._upsert(aid, catalog, rel, speed_kph, heading_deg, static, occludes)
        if aid == 'ego' and speed_kph is not None:
            self.roles['ego']['initialSpeedKph'] = speed_kph
        # placement is verified by materializing: the agent sees the solver's truth
        inst, err = self.instantiate_t0()
        if inst is None:
            return False, {'error': 'placement does not materialize', 'issues': err,
                           'diag': diag}
        self._last_instance = inst
        return True, {'diag': diag, 'instance': inst}

    def _upsert(self, aid, catalog, rel, speed_kph, heading_deg, static, occludes):
        h = math.radians(heading_deg) if heading_deg else 0.0
        if static:
            prop = {'id': aid, 'catalogId': catalog,
                    'label': aid, 'essentiality': 'required',
                    'pose': {'laneOffset': rel.get('dLane', 0),
                             's': round(float(self.roles['ego']['pose']['s']) + rel['dsM'], 2),
                             'headingOffsetRad': h},
                    'headingOffsetRad': h, 'scale': 1}
            if 'lateralM' in rel:
                prop['pose']['lateralM'] = rel['lateralM']
                prop['pose']['lateralRef'] = rel['lateralRef']
            else:
                prop['pose']['tFrac'] = max(-1.0, min(1.0, rel.get('tFrac', 0)))
            if occludes:
                prop['occludes'] = occludes
            self.props[aid] = prop
            self.roles.pop(aid, None)
        else:
            role = {'id': aid, 'kind': 'relative_to', 'ref': 'ego',
                    'label': aid, 'essentiality': 'required',
                    'actor': {'class': actor_class(catalog), 'catalogId': catalog},
                    'dsM': rel['dsM'], 'dLane': rel.get('dLane', 0),
                    'headingOffsetRad': h}
            if 'lateralM' in rel:
                role['lateralM'] = rel['lateralM']; role['lateralRef'] = rel['lateralRef']
                role['tFrac'] = 0
            else:
                role['tFrac'] = max(-1.0, min(1.0, rel.get('tFrac', 0)))
            if speed_kph is not None:
                role['initialSpeedKph'] = speed_kph
            self.roles[aid] = role
            self.props.pop(aid, None)

    def remove(self, aid=None, interaction=None):
        if aid:
            if aid == 'ego':
                return False, 'the ego cannot be removed'
            found = bool(self.roles.pop(aid, None)) or bool(self.props.pop(aid, None))
            self.interactions = [i for i in self.interactions if i['actor'] != aid]
            return found, None if found else 'no role/prop %r' % aid
        if interaction:
            n = len(self.interactions)
            self.interactions = [i for i in self.interactions if i['id'] != interaction]
            return len(self.interactions) < n, None
        return False, 'nothing to remove'

    # ------------------------------------------------------------- motion
    def compile_trigger(self, t, frames=None):
        """Simplified trigger -> schema trigger. `frames` resolves pixel refs."""
        if t is None:
            return {'kind': 'at', 't': 0}
        if 'at' in t:
            return {'kind': 'at', 't': float(t['at'])}
        if 'after' in t:
            a = t['after']
            return {'kind': 'after', 'of': a['of'], 'event': a.get('event', 'start'),
                    'delayS': float(a.get('delayS', 0))}
        if 'arrival' in t:
            a = t['arrival']
            at = self._pointref(a.get('at'), frames)
            out = {'kind': 'arrival', 'of': a.get('of'), 'at': at,
                   'syncWith': a.get('syncWith', 'ego')}
            if a.get('deltaT') is not None:
                out['deltaT'] = float(a['deltaT'])
            else:
                out['ttc'] = float(a.get('ttc', 1.8))
            return out
        if 'when' in t:
            w = dict(t['when'])
            by = float(w.pop('byLatest', self.clip_s - 2))
            if_never = w.pop('ifNever', 'fire')
            cond = self._condition(w)
            return {'kind': 'when', 'condition': cond, 'byLatest': by, 'ifNever': if_never}
        raise ValueError('unknown trigger %r' % t)

    def _pointref(self, at, frames):
        if at is None:
            return {'role': 'ego'}
        if 'px' in at:
            view = frames[at['frame']] if frames else None
            x, y = R.world_from_pixel(view, at['px'][0], at['px'][1])
            aw = self.anchor_from_world(x, y)
            pose = {'laneOffset': aw['lateral'].get('dLane', 0),
                    's': aw['proj']['sAnchor'], 'headingOffsetRad': 0}
            if 'lateralM' in aw['lateral']:
                pose['lateralM'] = aw['lateral']['lateralM']; pose['lateralRef'] = 'lane_centre'
            else:
                pose['tFrac'] = aw['lateral'].get('tFrac', 0)
            return {'pose': _norm_pose(pose)}
        if 'dsM' in at:
            return {'pose': {'laneOffset': int(at.get('dLane', 0)),
                             's': round(float(self.roles['ego']['pose']['s']) + float(at['dsM']), 2),
                             'tFrac': float(at.get('tFrac', 0)), 'headingOffsetRad': 0}}
        if 'role' in at:
            return {'role': at['role']}
        raise ValueError('unknown point %r' % at)

    def _condition(self, w):
        if 'ttcBelow' in w:
            c = w['ttcBelow']
            return {'kind': 'ttc', 'of': c.get('of', 'ego'), 'to': c['to'],
                    'op': '<=', 'valueS': float(c['valueS'])}
        if 'distanceBelow' in w:
            c = w['distanceBelow']
            return {'kind': 'distance', 'from': c.get('from', 'ego'),
                    'to': self._pointref(c['to'] if isinstance(c['to'], dict)
                                         else {'role': c['to']}, None),
                    'op': '<=', 'valueM': float(c['valueM'])}
        if 'speedBelow' in w or 'speedAbove' in w:
            k = 'speedBelow' if 'speedBelow' in w else 'speedAbove'
            c = w[k]
            return {'kind': 'speed', 'of': c.get('of', 'ego'),
                    'op': '<=' if k == 'speedBelow' else '>=', 'valueKph': float(c['valueKph'])}
        if 'visible' in w:
            c = w['visible']
            return {'kind': 'visible', 'of': c['of'], 'to': c['to'],
                    'visible': bool(c.get('visible', True))}
        if 'standstill' in w:
            c = w['standstill']
            return {'kind': 'standstill', 'of': c.get('of', 'ego'), 'forS': float(c['forS'])}
        raise ValueError('unknown condition %r' % w)

    def _validate_corridor_world(self, key, value):
        """Prove a local environment window is on the visible ego approach."""
        noun = 'surface patch' if key == 'env.surfacePatch' else 'marking treatment'
        usage = ('select a site first, then use one contiguous window on the reference '
                 'lane, e.g. {"action":"set_world","key":"%s","value":'
                 '{"id":"approach","%s":"%s","atM":50,"lengthM":30,'
                 '"laneOffsets":[0]}}'
                 % (key, 'kind' if key == 'env.surfacePatch' else 'quality',
                    'ice' if key == 'env.surfacePatch' else 'absent'))
        if self.site is None or self.route_pl is None:
            return False, '%s needs a calibrated working site; %s' % (noun, usage)
        if not isinstance(value, dict):
            return False, '%s value must be an object; %s' % (noun, usage)
        if value.get('feature') is not None:
            return False, ('%s must use a frame-relative approach window, not a feature '
                           'anchor; %s' % (noun, usage))
        if value.get('laneOffsets') != [0]:
            return False, ('%s must target laneOffsets:[0], the ego route corridor; %s'
                           % (noun, usage))
        try:
            start = float(value['atM'])
            length = float(value['lengthM'])
        except (KeyError, TypeError, ValueError):
            return False, '%s needs concrete numeric atM and lengthM; %s' % (noun, usage)
        ego_s = float(self.roles['ego']['pose']['s'])
        approach_overlap = max(0.0, min(start + length, ego_s + 60.0) -
                               max(start, ego_s))
        if length <= 0 or approach_overlap < min(20.0, length):
            return False, (
                '%s must cover at least %.0fm of the ego approach [%g,%g] so the ego '
                'drives it and the camera frames it; authored window was [%g,%g]. %s'
                % (noun, min(20.0, max(length, 0.0)), ego_s, ego_s + 60.0,
                   start, start + length, usage))

        field = 'surfacePatches' if key == 'env.surfacePatch' else 'markingTreatments'
        authored_id = str(value.get('id', ''))
        previous = copy.deepcopy(self.environment)
        items = self.environment.setdefault(field, [])
        existing_index = next((i for i, item in enumerate(items)
                               if item.get('id') == authored_id), None)
        if existing_index is None:
            items.append(copy.deepcopy(value))
        else:
            items[existing_index] = copy.deepcopy(value)
        try:
            inst, issues = self.instantiate_t0()
        finally:
            self.environment = previous
        if inst is None:
            return False, '%s could not be proven at this site: %s; %s' \
                % (noun, '; '.join(issues), usage)
        ego = next(a for a in inst['input']['actors'] if a['id'] == 'ego')
        route_lanes = set((ego.get('behavior', {}).get('route') or {}).get('lanes') or [])
        authored_id = str(value.get('id', ''))
        lowered = [item for item in inst['input'].get(field, [])
                   if item.get('id') == authored_id or
                   str(item.get('id', '')).startswith(authored_id + ':')]
        if not lowered:
            return False, '%s produced no concrete lane window; %s' % (noun, usage)
        windows = [item.get('region') or {} for item in lowered]
        if any(w.get('rsl') not in route_lanes for w in windows):
            return False, '%s resolved away from the ego route corridor; %s' % (noun, usage)
        covered_m = sum(max(0.0, float(w.get('sMax', 0)) - float(w.get('sMin', 0)))
                        for w in windows)
        if covered_m < min(20.0, length):
            return False, ('%s resolved to only %.1fm on the driven corridor; %s'
                           % (noun, covered_m, usage))
        if key == 'env.marking':
            lanes = R.topo(R.DEV_ASSETS, self.site['mapId'])['lanes']
            if any((lanes.get(w.get('rsl')) or {}).get('isJunction') for w in windows):
                return False, (
                    'marking treatment reaches a junction lane, which has no painted '
                    'boundaries and is unprovable; place one shorter contiguous window '
                    'on the non-junction approach. %s' % usage)
            if len(windows) != 1:
                return False, (
                    'marking treatment fragmented into %d lane stubs; use one contiguous '
                    'window on a single painted ego-route approach instead. %s'
                    % (len(windows), usage))
        return True, None

    def set_world(self, key, value, trigger=None, frames=None):
        """Author environment state or a world-scoped signal phase.

        Environment changes are static template state. Signal phases remain timed
        `set` interactions, but the agent never has to invent a synthetic world role.
        Every mutation is validated through the v2 template schema before it sticks.
        """
        if key in WORLD_ENV_KEYS or key in WORLD_COLLECTION_KEYS:
            if key in WORLD_COLLECTION_KEYS:
                field = WORLD_COLLECTION_KEYS[key]
                existing = self.environment.get(field) or []
                authored_id = value.get('id') if isinstance(value, dict) else None
                if (key == 'env.marking' and existing and
                        all(item.get('id') != authored_id for item in existing)):
                    return False, {
                        'error': 'use one contiguous ego-route marking window, not many '
                                 'scattered fragments; reuse id %r to replace the existing '
                                 'treatment' % existing[0].get('id'),
                    }
                ok, reason = self._validate_corridor_world(key, value)
                if not ok:
                    return False, {'error': reason}
            if trigger is not None:
                return False, {'error': 'environment state is static and does not accept "trigger"; '
                                        'correct invocation: %s' % WORLD_USAGE}
            previous = copy.deepcopy(self.environment)
            if key in WORLD_ENV_KEYS:
                self.environment[WORLD_ENV_KEYS[key]] = copy.deepcopy(value)
            else:
                field = WORLD_COLLECTION_KEYS[key]
                items = self.environment.setdefault(field, [])
                authored_id = value.get('id')
                existing_index = next((i for i, item in enumerate(items)
                                       if item.get('id') == authored_id), None)
                if existing_index is None:
                    items.append(copy.deepcopy(value))
                else:
                    items[existing_index] = copy.deepcopy(value)
            ok, issues = self.validate()
            if not ok:
                self.environment = previous
                return False, {
                    'error': 'invalid world value; correct invocation is %s' % WORLD_USAGE,
                    'issues': issues,
                }
            self._last_instance = None
            return True, {'key': key, 'value': copy.deepcopy(value)}

        if SIGNAL_PHASE_KEY.fullmatch(str(key)):
            try:
                trig = self.compile_trigger(trigger, frames)
            except (ValueError, KeyError, TypeError) as e:
                return False, {'error': 'bad trigger: %s; correct invocation: %s'
                                        % (e, WORLD_USAGE)}
            self._iseq += 1
            iid = 'i%d' % self._iseq
            it = {'id': iid, 'actor': '@world', 'verb': 'set', 'trigger': trig,
                  'target': {'key': key, 'value': value}}
            self.interactions.append(it)
            ok, issues = self.validate()
            if not ok:
                self.interactions.pop()
                self._iseq -= 1
                return False, {
                    'error': 'invalid world value; correct invocation is %s' % WORLD_USAGE,
                    'issues': issues,
                }
            self._last_instance = None
            return True, {'interactionId': iid, 'compiled': it}

        return False, {
            'error': 'unknown world key %r; correct invocation is %s' % (key, WORLD_USAGE),
        }

    def set_motion(self, actor, motion, frames=None):
        if motion.get('kind') == 'rule':
            key = str(motion.get('key', ''))
            if key in WORLD_ENV_KEYS or key in WORLD_COLLECTION_KEYS or SIGNAL_PHASE_KEY.fullmatch(key):
                return False, {'error': 'world-scoped key %r cannot be an actor rule; '
                                        'correct invocation is %s' % (key, WORLD_USAGE)}
        if actor not in self.roles:
            return False, {'error': 'no role %r (props cannot move; place with static:false)' % actor}
        kind = motion.get('kind')
        try:
            trig = self.compile_trigger(motion.get('trigger'), frames)
        except (ValueError, KeyError, TypeError) as e:
            return False, {'error': 'bad trigger: %s' % e}
        self._iseq += 1
        iid = 'i%d' % self._iseq
        base = {'id': iid, 'actor': actor, 'trigger': trig}
        dyn_rate = motion.get('rateMps2')
        dur = motion.get('durationS')
        if kind == 'speed':
            v = motion.get('speedKph')
            if v is None and motion.get('stop'):
                v = 'stop'
            if v is None:
                self._iseq -= 1
                return False, {'error': 'speed motion needs "speedKph": <kph> or "stop"'}
            target = {'mode': 'stop'} if v in ('stop', 0) else {'mode': 'absolute',
                                                                'valueKph': float(v)}
            it = dict(base, verb='speed', target=target,
                      dynamics={'shape': 'linear', 'constraint': 'rate',
                                'value': float(dyn_rate or 2.5)})
        elif kind == 'route':
            pts = []
            for p in motion.get('points', []):
                ref = self._pointref(p, frames)
                if 'pose' not in ref:
                    return False, {'error': 'route points must be pixels or dsM offsets'}
                pts.append(ref['pose'])
            if len(pts) < 2:
                return False, {'error': 'route needs >=2 points'}
            it = dict(base, verb='route', target={'mode': 'polyline', 'points': pts})
        elif kind == 'cross_path':
            it = dict(base, verb='route',
                      target={'mode': 'nearMiss', 'target': motion.get('target', 'ego'),
                              'clearanceM': float(motion.get('clearanceM', 0.5)),
                              'pass': motion.get('pass', 'auto')})
        elif kind == 'lane_offset':
            it = dict(base, verb='laneOffset',
                      target={'tFrac': float(motion.get('tFrac', 0.8)),
                              'reference': 'lane_center'},
                      dynamics={'shape': 'sinusoidal', 'constraint': 'time',
                                'value': float(dur or 1.5)})
        elif kind == 'change_lane':
            it = dict(base, verb='changeLane',
                      target={'mode': 'relative', 'dk': int(motion.get('dk', 1))},
                      dynamics={'shape': 'sinusoidal', 'constraint': 'time',
                                'value': float(dur or 3.0)})
        elif kind == 'gap':
            it = dict(base, verb='gap',
                      target={'role': motion['behind'], 'value': float(motion.get('gapS', 1.0)),
                              'unit': 'time'},
                      dynamics={'shape': 'linear', 'constraint': 'rate',
                                'value': float(dyn_rate or 2.0)})
        elif kind == 'rule':
            it = dict(base, verb='set',
                      target={'key': motion['key'], 'value': motion['value']})
        else:
            return False, {'error': 'unknown motion kind %r' % kind}
        self.interactions.append(it)
        ok, issues = self.validate()
        if not ok:
            self.interactions.pop()
            return False, {'error': 'engine rejected the interaction', 'issues': issues}
        return True, {'interactionId': iid, 'compiled': it}

    # ------------------------------------------------------------- engine
    def instantiate_t0(self):
        if self.site is None:
            return None, ['no working site selected — use view_site with "site":N first']
        path = self.write_template('t0')
        out_path = os.path.join(self.workdir, 't0.instance.json')
        rc, out, so, se = cli('instantiate', path, '--map', self.site['mapId'],
                              '--site', self.site['siteId'], '--draw', 0,
                              '--out', out_path)
        if rc not in (0, 2) or not os.path.exists(out_path):
            return None, _issues(out, so, se)
        return json.load(open(out_path)), []

    def simulate(self):
        """One engine pass at the working site; frozen gate on the raw trace."""
        inst, err = self.instantiate_t0()
        if inst is None:
            return None, err
        inst_path = os.path.join(self.workdir, 't0.instance.json')
        n = int(time.time() * 1000) % 100000
        trace_path = os.path.join(self.workdir, 'sim-%05d.trace.json.gz' % n)
        rc, out, so, se = cli('simulate', inst_path, '--trace', trace_path)
        if rc not in (0, 2) or not os.path.exists(trace_path):
            return None, _issues(out, so, se)
        rc2, ev, so2, se2 = cli('evaluate', trace_path)
        verdict = (ev or {}).get('verdict'); band = (ev or {}).get('band')
        g = G.gate_cell(trace_path, verdict=verdict, band=band,
                        brief=self.brief['brief'], version=2)
        return {'trace': trace_path, 'instance': inst, 'gate': g,
                'verdict': verdict, 'band': band,
                'findings': [str(f)[:160] for f in (ev or {}).get('findings', [])[:4]]}, []

    def emit_batch(self, outdir, draws=2, max_sites=4, concurrency=4):
        """The portability half of the win: batch the frozen template across all maps."""
        path = self.write_template('emit')
        ok, issues = self.validate()
        if not ok:
            return None, issues
        os.makedirs(outdir, exist_ok=True)
        rc, out, so, se = cli('batch', path, '--out', outdir, '--draws', draws,
                              '--concurrency', concurrency, '--all-maps',
                              '--max-sites', max_sites, timeout=2400)
        summ_path = os.path.join(outdir, 'batch-summary.json')
        if not os.path.exists(summ_path):
            return None, _issues(out, so, se)
        summary = json.load(open(summ_path))
        recs = []
        for r in summary.get('results', []):
            tf = r.get('traceFile')
            if not tf or not os.path.exists(tf):
                recs.append({'mapId': r.get('mapId'), 'site': r.get('siteId'),
                             'draw': r.get('drawIndex'), 'pass': False,
                             'firstFailure': 'NOTRACE',
                             'status': r.get('status')})
                continue
            g = G.gate_cell(tf, verdict=r.get('verdict'), band=r.get('band'),
                            brief=self.brief['brief'], version=2)
            g['site'] = r.get('siteId'); g['draw'] = r.get('drawIndex')
            g['traceFile'] = tf
            g['instanceFile'] = r.get('instanceFile')
            g['firstFailure'] = G.first_failure(g)
            recs.append(g)
        port = G.portability(recs)
        passing = [record for record in recs if record.get('pass')]
        if self.contract.get('obligations'):
            port = {**port, 'productPolicy': 'one truthful host is sufficient',
                    'ok': bool(passing)}
        admitted = bool(port['ok'] and passing)
        return {'template': path, 'summary': summary, 'cells': recs,
                'portability': port, 'admitted': admitted}, []


def _norm_pose(pose):
    p = dict(pose)
    if 'lateralM' in p:
        p.pop('tFrac', None)
    elif 'tFrac' not in p:
        p['tFrac'] = 0
    p.setdefault('laneOffset', 0)
    p.setdefault('headingOffsetRad', 0)
    return p
