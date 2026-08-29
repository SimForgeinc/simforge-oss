"""VISTA2 agent loop: perceive (PNG) -> reason (free-form language, predict/verify)
-> act (one JSON action) -> observe, with lossless visual memory and two notes files.

Faithful to the VISTA harness design (vista-research.github.io):
  - the agent sees rendered PNGs, never symbolic scene dumps;
  - before each action it states the visual result it expects; after, all visible
    changes, expected or not;
  - every frame is kept on disk indexed by id; `inspect` re-renders any past frame,
    region or zoom from stored scene state (lossless memory); `read_pixels` is a
    SEMANTIC query answered from the topology index, not a colour sample;
  - GUIDE.md holds durable cross-brief engine understanding (persists across briefs —
    that is the cross-level learning VISTA measures); WORKING.md is a per-brief
    scratchpad; both are written by the agent, never pre-taught by the harness;
  - the frozen admission gate is the WIN CONDITION, its criteria shown as game rules;
  - read-only looks (inspect/read_pixels) are free; world-touching actions count.
"""
import base64, json, os, re, time

import httpx

import vrender as R
import vworld as W

MUTATING = {'view_site', 'place_actor', 'set_motion', 'set_world', 'simulate', 'emit', 'remove'}
FREE = {'inspect', 'read_pixels'}

SYSTEM_PROMPT = """# Scenario authoring game

Author a driving scenario where: {brief}

You act by emitting one JSON action per turn; every action returns top-down PNG views of the world. You win when the frozen admission gate admits the scenario: simulate() shows the gate's per-rule verdict at your working site. Research-corpus briefs additionally require portability at >=2 maps and >=3 sites; briefs carrying a HARD EXECUTABLE CONTRACT require one truthful host because their exact structure may exist on only one map.

Before each action, briefly state what you expect to see. Afterward, briefly state all visible changes, expected or not.

Keep concise, durable, revisable engine understanding in GUIDE.md (it persists across scenarios); use WORKING.md as a scratchpad for this one.

## Reply format (every turn)
State what you observe/conclude, then exactly one fenced json block:
```json
{{"expect": "what you expect the next observation to show",
 "do": {{"action": "...", ...}},
 "guide": "(optional) FULL replacement text for GUIDE.md",
 "working": "(optional) FULL replacement text for WORKING.md"}}
```

## Actions
Counted (budget shown each turn):
1. {{"action":"view_site"}} — list candidate sites; add "site":N to select+render one; add "need":{{"feature":"junction"|"crossing"|"parking_zone"|"occlusion_zone"|"merge"|"lane_drop"|"driveway"|"bus_stop"|"crest"|"curve"|null,"control":"signalized"|"all_way_stop"|null,"egoTurn":"left"|"right"|"straight"|null,"minLanes":N,"minOpposingLanes":N,"adjacentSidewalk":true}} to re-query with different road structure (resets placements). Hard contract requirements are always merged back and cannot be removed.
2. {{"action":"place_actor","id":"name","catalog":"<id>","at":{{"frame":"fN","px":[x,y]}} OR {{"dsM":m,"dLane":k,"tFrac":f}} OR {{"dsM":m,"lateralM":m_left_positive}},"speedKph":n,"headingDeg":deg_vs_lane,"static":true_for_scenery,"occludes":{{"observer":"ego","target":"id"}}}} — id "ego" moves/retunes the ego. Pixels are projected to portable lane-relative anchors; the emitted template never contains coordinates.
3. {{"action":"set_motion","actor":"id","motion":M}} where M is one of:
   {{"kind":"speed","speedKph":n|"stop","trigger":T,"rateMps2":r}}
   {{"kind":"route","points":[P,...],"trigger":T}} (P = {{"frame":"fN","px":[x,y]}} or {{"dsM":m,"tFrac":f}}; 2-8 points; walking/driving path)
   {{"kind":"cross_path","target":"ego","clearanceM":0.5,"pass":"front"|"behind"|"auto","trigger":T}} (solver-owned near-miss crossing of the target's path)
   {{"kind":"lane_offset","tFrac":-1..1,"durationS":d,"trigger":T}} (swerve/drift within lane, + = left)
   {{"kind":"change_lane","dk":+1|-1,"durationS":d,"trigger":T}}
   {{"kind":"gap","behind":"roleId","gapS":s,"trigger":T}} (car-following)
   {{"kind":"rule","key":K,"value":v,"trigger":T}} — ACTOR-scoped only. K: rules.collisionAvoidance rules.yieldToVehicles rules.yieldToPedestrians rules.obeySignals rules.obeySpeedLimit rules.aggression rules.reactionTimeS motion.gear pose.gesture pose.paddle pose.stopArm lights.indicator lights.brake lights.emergency doors.left doors.right doors.rear
   World-scoped keys are NOT actor rules; use set_world below.
   Triggers T: {{"at":sec}} | {{"after":{{"of":"iN","event":"start"|"end","delayS":d}}}} | {{"arrival":{{"of":"id","at":{{"frame":"fN","px":[x,y]}}|{{"dsM":m}},"syncWith":"ego","ttc":sec}}}} (solver back-solves the start so "of" reaches "at" ttc seconds before "syncWith") | {{"when":{{...,"byLatest":sec}}}} with one of "ttcBelow":{{"of","to","valueS"}} "distanceBelow":{{"from","to","valueM"}} "speedBelow"/"speedAbove":{{"of","valueKph"}} "visible":{{"of","to","visible"}} "standstill":{{"of","forS"}}
4. {{"action":"set_world","key":K,"value":v}} — the ONE world-scoped authoring mechanism. Exact environment forms:
   {{"action":"set_world","key":"env.weather","value":"snow"}}
   {{"action":"set_world","key":"env.timeOfDay","value":"dusk"}} or key env.frictionScale with a numeric value
   AFTER selecting a site, place one contiguous ego-route approach window with concrete numbers and laneOffsets:[0]. The window must cover >=20 m between ego s=40 and s=100; off-route/scattered windows are rejected:
   {{"action":"set_world","key":"env.surfacePatch","value":{{"id":"ice-zone","kind":"ice","atM":25,"lengthM":50,"laneOffsets":[0]}}}}
   {{"action":"set_world","key":"env.marking","value":{{"id":"faded-zone","quality":"faded","atM":50,"lengthM":30,"laneOffsets":[0]}}}} — exactly one marking window; it must lower to one non-junction lane because junction lanes have no painted boundaries.
   {{"action":"set_world","key":"env.wind","value":{{"directionDeg":90,"speedMps":0,"gust":{{"startS":3,"durationS":4,"peakSpeedMps":35}}}}}}
   Signal phase is also world-scoped and may carry "trigger":T: {{"action":"set_world","key":"signal:feature:<featureId>:<ego|opposing|left|right>.phase","value":"red","trigger":{{"at":3}}}}. Phase values: green yellow red flashing_yellow flashing_red off green_arrow yellow_arrow red_x flashing_yellow_arrow flashing_red_arrow. Environment keys are static and reject trigger.
5. {{"action":"simulate"}} — run the scenario at the working site: rollout keyframes + gate verdict per rule + measured facts.
6. {{"action":"emit"}} — freeze and batch the template across all five maps (the portability half of the win). Win ends the game; a loss returns per-map evidence and you may continue.
7. {{"action":"remove","id":"name"}} or {{"action":"remove","interaction":"iN"}}
Free (not counted):
8. {{"action":"inspect","frame":"fN","centerPx":[x,y],"spanM":m}} — re-render any PAST frame at any region/zoom, losslessly (frames never expire).
9. {{"action":"read_pixels","frame":"fN","px":[x,y]}} — ground truth at a point: surface (drivable/sidewalk/shoulder/parking/junction/off_road), lane width/speed-limit/travel-heading, and the portable projection of that point.

## The gate (game rules)
C1 the ego really drives: max speed >=2 m/s AND distance travelled >=10 m.
C2 the closest approach AND the min-TTC moment happen at t > warmup+0.5 s (not a spawn artifact).
C3 true closest OBB clearance <=5 m.
C4 genuine demand on the ego: required decel >=1.5 m/s^2 OR minTTC <=3 s.
C5 evaluator verdict=accept, band=critical, zero collisions, zero never-fired triggers.
C6 (only for briefs that name occlusion) a declared occlusion provably blocks, then reveals.
Portability: research-corpus briefs require passing cells on >=2 maps and >=3 distinct sites. HARD EXECUTABLE CONTRACT briefs require >=1 passing site without relaxing any gate rule.

## Catalog (use FULL ids, e.g. "vehicle.sedan"; static:true makes scenery/occluders)
vehicle.<sedan|suv|hatchback|pickup|minivan|van|delivery_van|box_truck|semi_truck|dump_truck|flatbed_truck|garbage_truck|tanker_truck|cement_mixer|tow_truck|bus|school_bus|shuttle_bus|taxi|police_cruiser|police_suv|ambulance|fire_engine|motorcycle|bicycle|mobility_scooter>
pedestrian.<adult_walking|adult_standing|child_walking|child_standing|elderly_walking|traffic_marshal>
animal.<deer|dog|cat|stray_dog|raccoon|goose> | hazard.<tire_debris|mattress|ladder|cardboard_box|debris|downed_branch|trash_bags> | construction.<traffic_cone|channelizer_drum|jersey_barrier|excavator|flagger|arrow_board|sign_road_work> | occluder.<dumpster|covered_car|hedge_run|fence_run> | street.<bus_shelter|food_cart|shopping_cart>
"""


def _extract_json(text):
    blocks = re.findall(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.S)
    if not blocks:
        m = re.search(r'\{.*\}', text, re.S)
        if not m:
            return None
        blocks = [m.group(0)]
    raw = blocks[-1]
    for attempt in (raw, re.sub(r',\s*([}\]])', r'\1', raw)):
        try:
            return json.loads(attempt)
        except Exception:  # noqa: BLE001
            continue
    return None


class LLM:
    def __init__(self, model, effort, log_path, timeout=420):
        self.base = os.environ.get('OPENAI_BASE_URL', 'http://127.0.0.1:4141/v1').rstrip('/')
        self.key = os.environ.get('OPENAI_API_KEY', 'x')
        self.model, self.effort, self.timeout = model, effort, timeout
        self.log_path = log_path
        self.usage = {'calls': 0, 'input_tokens': 0, 'output_tokens': 0,
                      'reasoning_tokens': 0, 'wallS': 0.0}

    def call(self, items, max_output=6000):
        last_err = None
        # Reasoning models spend this budget on thinking before emitting any
        # output_text, so an exhausted budget returns status=incomplete with an
        # empty answer. Retrying at the SAME budget can never succeed, so the
        # budget escalates with each attempt.
        for attempt, wait in enumerate((0, 8, 25, 60)):
            if wait:
                time.sleep(wait)
            budget = max_output * (1, 3, 6, 10)[attempt]
            body = {'model': self.model, 'reasoning': {'effort': self.effort},
                    'max_output_tokens': budget, 'input': items}
            t0 = time.time()
            try:
                r = httpx.post(self.base + '/responses',
                               headers={'Authorization': 'Bearer ' + self.key},
                               json=body, timeout=self.timeout)
            except Exception as e:  # noqa: BLE001
                last_err = '%s: %s' % (type(e).__name__, e)
                continue
            dt = time.time() - t0
            if r.status_code != 200:
                last_err = 'HTTP %d: %s' % (r.status_code, r.text[:300])
                continue
            d = r.json()
            txt = ' '.join(c.get('text', '') for it in d.get('output', [])
                           for c in (it.get('content') or [])
                           if c.get('type') == 'output_text').strip()
            u = d.get('usage') or {}
            self.usage['calls'] += 1
            self.usage['input_tokens'] += u.get('input_tokens', 0) or 0
            self.usage['output_tokens'] += u.get('output_tokens', 0) or 0
            self.usage['reasoning_tokens'] += ((u.get('output_tokens_details') or {})
                                               .get('reasoning_tokens', 0) or 0)
            self.usage['wallS'] += dt
            with open(self.log_path, 'a') as f:
                f.write(json.dumps({'t': time.time(), 'wallS': round(dt, 1),
                                    'status': d.get('status'), 'usage': u,
                                    'maxOutputTokens': budget,
                                    'nItems': len(items), 'text': txt}) + '\n')
            if not txt:
                last_err = ('empty output (status=%s, budget=%d, reasoning=%s)'
                            % (d.get('status'), budget,
                               (u.get('output_tokens_details') or {}).get('reasoning_tokens')))
                continue
            return txt
        raise RuntimeError('LLM failed after retries: %s' % last_err)


class FrameStore:
    """Lossless visual memory: every frame's SOURCE STATE is kept and re-renderable."""

    def __init__(self, framedir):
        self.dir = framedir
        os.makedirs(framedir, exist_ok=True)
        self.frames = {}   # fid -> {view, kind, source}
        self.n = 0

    def add(self, view, kind, source):
        self.n += 1
        fid = 'f%d' % self.n
        self.frames[fid] = {'view': view, 'kind': kind, 'source': source}
        return fid

    def view(self, fid):
        return self.frames[fid]['view'] if fid in self.frames else None

    def rerender(self, fid, center=None, span=None, mark=None):
        """Re-render frame `fid` from its stored source at a new view. Lossless."""
        fr = self.frames.get(fid)
        if fr is None:
            return None, 'no frame %r' % fid
        v = fr['view']
        center = center or v['center']
        span = span or max(15, v['span'] // 2)
        out = os.path.join(self.dir, 'inspect-%d.png' % (self.n + 1))
        src = fr['source']
        marks = [dict(x=mark[0], y=mark[1], label='query')] if mark else None
        if src['type'] == 'trace':
            trace = R.load_trace(src['path'])
            view = R.render_keyframe(trace, src['idx'], out, view=(center, span))
            if marks:
                view = R.render_view(v['map'], center, span, out,
                                     actors=_trace_actors(trace, src['idx']),
                                     trails=None, marks=marks,
                                     route_pl=None,
                                     title='| t=%.1fs' % trace['ticks']['t'][src['idx']])
        else:
            view = R.render_view(v['map'], center, span, out,
                                 actors=src.get('actors'), route_pl=src.get('route'),
                                 marks=marks, title=src.get('title', ''))
        fid2 = self.add(view, 'inspect', src)
        return fid2, view


def _trace_actors(trace, idx):
    order = 0
    out = []
    for a in R.actors_from_trace(trace, idx):
        a['color'] = '#666666' if a.pop('ambient', False) else R.actor_color(a['id'], order)
        if a['color'] != '#666666':
            order += 1
        out.append(a)
    return out


class Episode:
    """One brief, one game."""

    def __init__(self, brief, run_dir, llm, guide_path, budget=40, turn_cap=80,
                 wall_cap_s=2400, span=60):
        self.brief = brief
        self.dir = os.path.join(run_dir, brief['id'])
        os.makedirs(self.dir, exist_ok=True)
        self.scene = W.Scene(brief, os.path.join(self.dir, 'work'))
        self.frames = FrameStore(os.path.join(self.dir, 'frames'))
        self.llm = llm
        self.guide_path = guide_path
        self.working_path = os.path.join(self.dir, 'WORKING.md')
        open(self.working_path, 'w').write('')
        self.budget, self.turn_cap, self.wall_cap = budget, turn_cap, wall_cap_s
        self.span = span
        self.turns = []          # [{text, images: [paths], role}]
        self.actions_used = 0
        self.sim_count = 0
        self.emit_count = 0
        self.protocol_errors = 0
        self.admitted = False
        self.emit_result = None
        self.transcript = os.path.join(self.dir, 'transcript.jsonl')

    # --------------------------------------------------------- observation text
    def _notes_state(self):
        guide = open(self.guide_path).read() if os.path.exists(self.guide_path) else ''
        working = open(self.working_path).read()
        return ('\n## GUIDE.md (yours, persists across scenarios)\n%s\n'
                '## WORKING.md (this scenario)\n%s\n'
                % (guide.strip() or '(empty)', working.strip() or '(empty)'))

    def _budget_line(self):
        return ('[actions used %d/%d | free looks uncounted | brief: %s]'
                % (self.actions_used, self.budget, self.brief['brief']))

    # --------------------------------------------------------- LLM plumbing
    def _api_items(self):
        items = [{'role': 'system',
                  'content': [{'type': 'input_text',
                               'text': SYSTEM_PROMPT.format(brief=self.brief['brief'])}]}]
        n = len(self.turns)
        for i, t in enumerate(self.turns):
            if t['role'] == 'assistant':
                items.append({'role': 'assistant',
                              'content': [{'type': 'output_text', 'text': t['text']}]})
                continue
            content = [{'type': 'input_text', 'text': t['text']}]
            if i >= n - 5:  # images only in the recent window; older -> inspect
                for p in t.get('images', []):
                    b64 = base64.b64encode(open(p, 'rb').read()).decode()
                    content.append({'type': 'input_image',
                                    'image_url': 'data:image/png;base64,' + b64})
            else:
                fids = t.get('frameIds', [])
                if fids:
                    content.append({'type': 'input_text',
                                    'text': '[frames %s stored; use inspect to re-view]'
                                            % ', '.join(fids)})
            items.append({'role': 'user', 'content': content})
        return items

    def _log(self, rec):
        with open(self.transcript, 'a') as f:
            f.write(json.dumps(rec) + '\n')

    # --------------------------------------------------------- the loop
    def run(self):
        t_start = time.time()
        obs_text = ("New scenario. No site selected yet. Start with view_site to see "
                    "candidate road structure (add \"need\" if the brief wants a junction/"
                    "crossing/parking/occlusion feature).\n" + self._notes_state()
                    + self._budget_line())
        self.turns.append({'role': 'user', 'text': obs_text, 'images': [], 'frameIds': []})
        consecutive_errors = 0
        while True:
            if self.admitted:
                break
            if self.actions_used >= self.budget:
                self._log({'end': 'budget'}); break
            if len(self.turns) // 2 >= self.turn_cap:
                self._log({'end': 'turn_cap'}); break
            if time.time() - t_start > self.wall_cap:
                self._log({'end': 'wall_cap'}); break
            try:
                reply = self.llm.call(self._api_items())
            except RuntimeError as e:
                self._log({'end': 'llm_failure', 'error': str(e)})
                break
            self.turns.append({'role': 'assistant', 'text': reply})
            act = _extract_json(reply)
            if not act or 'do' not in act or 'action' not in (act.get('do') or {}):
                self.protocol_errors += 1
                consecutive_errors += 1
                self._log({'turn': len(self.turns), 'protocolError': True})
                if consecutive_errors >= 3:
                    self._log({'end': 'protocol'}); break
                self.turns.append({'role': 'user', 'images': [], 'frameIds': [],
                                   'text': 'Could not parse an action. Reply with exactly '
                                           'one fenced json block: {"expect":"...","do":'
                                           '{"action":"..."}}.\n' + self._budget_line()})
                continue
            consecutive_errors = 0
            self._apply_notes(act)
            do = act['do']
            name = do.get('action')
            t0 = time.time()
            try:
                text, images, fids = self.dispatch(do)
            except Exception as e:  # noqa: BLE001  (harness bug surfaces to transcript, not fake result)
                text, images, fids = ('HARNESS ERROR (not your fault, action not counted): %s'
                                      % str(e)[:300]), [], []
                self._log({'turn': len(self.turns), 'harnessError': str(e)[:500]})
            if name in MUTATING and not text.startswith('HARNESS ERROR'):
                self.actions_used += 1
            self._log({'turn': len(self.turns), 'action': do, 'expect': act.get('expect'),
                       'resultText': text[:2000], 'frames': fids,
                       'actionWallS': round(time.time() - t0, 1),
                       'actionsUsed': self.actions_used})
            obs = (text + '\n' + self._notes_state() + self._budget_line()
                   + '\nState all visible changes (expected or not), then your next action.')
            self.turns.append({'role': 'user', 'text': obs, 'images': images,
                               'frameIds': fids})
        wall = time.time() - t_start
        return self._summary(wall)

    def _apply_notes(self, act):
        if isinstance(act.get('guide'), str):
            open(self.guide_path, 'w').write(act['guide'])
        if isinstance(act.get('working'), str):
            open(self.working_path, 'w').write(act['working'])

    def _summary(self, wall):
        return {'briefId': self.brief['id'], 'category': self.brief.get('category'),
                'admitted': self.admitted, 'actions': self.actions_used,
                'turns': len(self.turns) // 2, 'simulates': self.sim_count,
                'emits': self.emit_count, 'protocolErrors': self.protocol_errors,
                'wallS': round(wall, 1),
                'portability': (self.emit_result or {}).get('portability'),
                'cells': len((self.emit_result or {}).get('cells', [])),
                'usage': dict(self.llm.usage)}

    # --------------------------------------------------------- actions
    def dispatch(self, do):
        name = do.get('action')
        if name == 'view_site':
            return self.a_view_site(do)
        if name == 'place_actor':
            return self.a_place(do)
        if name == 'set_motion':
            return self.a_motion(do)
        if name == 'set_world':
            return self.a_world(do)
        if name == 'simulate':
            return self.a_simulate(do)
        if name == 'inspect':
            return self.a_inspect(do)
        if name == 'read_pixels':
            return self.a_read_pixels(do)
        if name == 'emit':
            return self.a_emit(do)
        if name == 'remove':
            return self.a_remove(do)
        return 'Unknown action %r.' % name, [], []

    def a_view_site(self, do):
        if do.get('need') is not None:
            requested = {k: v for k, v in (do['need'] or {}).items() if v}
            self.scene.need = {**requested, **self.scene.fixed_need}
            self.scene.sites = []; self.scene.site = None
        if not self.scene.sites:
            sites, fail = self.scene.match_sites()
            if sites is None:
                return 'Site matching failed: %s' % '; '.join(fail), [], []
            if not sites:
                return ('No site on any map satisfies that road structure. '
                        'failureSummary: %s' % json.dumps(fail)[:800]), [], []
        if do.get('site') is None:
            lines = ['Candidate sites (select with {"action":"view_site","site":N}):']
            for s in self.scene.sites[:12]:
                lines.append('  %2d  %-28s score %.2f  runway %sm'
                             % (s['i'], s['mapId'], s['score'] or 0,
                                int(s['runwayDownstreamM'] or 0)))
            # preview the best site so choice is visual, not blind
            s0 = self.scene.sites[0]
            img, fid = self._site_preview(s0)
            lines.append('Previewing site %d (%s). Select any index to lock and render it.'
                         % (s0['i'], s0['mapId']))
            return '\n'.join(lines), [img], [fid]
        ok, err = self.scene.select_site(int(do['site']))
        if not ok:
            return 'Site selection failed: %s' % '; '.join(err), [], []
        return self._t0_frame('Working site locked: %s site %s. Ego (blue) placed on the '
                              'reference lane; gold line is the ego route.'
                              % (self.scene.site['mapId'], self.scene.site['siteId'][:8]))

    def _site_preview(self, s):
        LNS = R.topo(R.DEV_ASSETS, s['mapId'])['lanes']
        ln = LNS.get(s['entryLaneRsl'])
        pl = [(q['x'], q['y']) for q in (ln.get('polyline') or [])]
        cx, cy, _ = R.station(ln['polyline'], 60)
        out = os.path.join(self.frames.dir, 'site-%d.png' % (self.frames.n + 1))
        view = R.render_view(s['mapId'], (cx, cy), 90, out, route_pl=pl,
                             title='| site %d preview' % s['i'])
        fid = self.frames.add(view, 'site', {'type': 'scene', 'route': pl,
                                             'title': '| site %d' % s['i']})
        return out, fid

    def _t0_frame(self, caption, marks=None):
        inst = getattr(self.scene, '_last_instance', None)
        if inst is None:
            inst, err = self.scene.instantiate_t0()
            if inst is None:
                return 'Cannot materialize the scene: %s' % '; '.join(err), [], []
            self.scene._last_instance = inst
        actors = R.actors_from_instance(inst)
        order = 0
        for a in actors:
            if a.get('kind') == 'prop':
                a['color'] = '#7f6a3d'
            else:
                a['color'] = R.actor_color(a['id'], order)
                if a['id'] != 'ego':
                    order += 1
        ego = next(a for a in actors if a['id'] == 'ego')
        out = os.path.join(self.frames.dir, 't0-%d.png' % (self.frames.n + 1))
        view = R.render_view(self.scene.site['mapId'], (ego['x'], ego['y']), self.span,
                             out, actors=actors, route_pl=self.scene.route_pl,
                             marks=marks, title='| scene t=0 (pre-warmup placement)')
        fid = self.frames.add(view, 't0', {'type': 'scene', 'actors': actors,
                                           'route': self.scene.route_pl,
                                           'title': '| scene t=0'})
        roles = ', '.join('%s@dsM=%s' % (r['id'], r.get('dsM', 'ref'))
                          for r in self.scene.roles.values() if r['id'] != 'ego')
        txt = ('%s\nThis is frame %s. Actors: ego + [%s]; props: [%s]. Interactions: %s.'
               % (caption, fid, roles or 'none', ', '.join(self.scene.props) or 'none',
                  ', '.join('%s(%s %s)' % (i['id'], i['verb'], i['actor'])
                            for i in self.scene.interactions) or 'none'))
        return txt, [out], [fid]

    def a_place(self, do):
        at = do.get('at') or {}
        view = self.frames.view(at.get('frame')) if 'px' in at else None
        if 'px' in at and view is None:
            return 'Pixel placement needs a valid "frame" (e.g. "f3").', [], []
        ok, info = self.scene.place(do.get('id'), do.get('catalog', 'vehicle.sedan'),
                                    at, speed_kph=do.get('speedKph'),
                                    heading_deg=do.get('headingDeg'),
                                    static=bool(do.get('static')),
                                    occludes=do.get('occludes'), view=view)
        if not ok:
            detail = info.get('issues') or [info.get('error')]
            diag = info.get('diag') or {}
            extra = ''
            if diag.get('sem'):
                extra = ' Point ground truth: %s.' % json.dumps(diag['sem'])
            return ('Placement rejected by the engine: %s.%s'
                    % ('; '.join(str(d) for d in detail), extra)), [], []
        diag = info.get('diag') or {}
        cap = 'Placed %r.' % do.get('id')
        if diag:
            cap += (' Projection: %s; surface at point: %s%s.'
                    % (json.dumps(diag.get('rel') or self.scene.roles['ego']['pose']),
                       (diag.get('sem') or {}).get('surface'),
                       ' — OPPOSING-direction lane' if diag.get('opposing') else ''))
        return self._t0_frame(cap)

    def a_motion(self, do):
        frames = {fid: fr['view'] for fid, fr in self.frames.frames.items()}
        try:
            ok, info = self.scene.set_motion(do.get('actor'), do.get('motion') or {}, frames)
        except (ValueError, TypeError, KeyError) as e:
            return ('set_motion rejected: bad arguments (%s). Check the motion forms in '
                    'the rules.' % e), [], []
        if not ok:
            return ('set_motion rejected: %s %s'
                    % (info.get('error'), '; '.join(info.get('issues', []))[:600])), [], []
        it = info['compiled']
        return self._t0_frame('Interaction %s added: %s %s trigger=%s.'
                              % (info['interactionId'], it['verb'], it['actor'],
                                 json.dumps(it['trigger'])[:200]))

    def a_world(self, do):
        frames = {fid: fr['view'] for fid, fr in self.frames.frames.items()}
        ok, info = self.scene.set_world(do.get('key'), do.get('value'),
                                        trigger=do.get('trigger'), frames=frames)
        if not ok:
            return ('set_world rejected: %s %s'
                    % (info.get('error'), '; '.join(info.get('issues', []))[:600])), [], []
        if info.get('compiled'):
            it = info['compiled']
            caption = ('World interaction %s added: %s=%s trigger=%s.'
                       % (info['interactionId'], it['target']['key'],
                          json.dumps(it['target']['value']),
                          json.dumps(it['trigger'])[:200]))
        else:
            caption = ('World environment authored: %s=%s.'
                       % (info['key'], json.dumps(info['value'])))
        if self.scene.site is None:
            return caption + ' No working site selected yet.', [], []
        return self._t0_frame(caption)

    def a_simulate(self, do):
        res, err = self.scene.simulate()
        if res is None:
            return 'simulate failed: %s' % '; '.join(err), [], []
        self.sim_count += 1
        g = res['gate']
        trace = R.load_trace(res['trace'])
        idxs = R.keyframe_indices(trace, closest_t=g.get('closestT'))
        images, fids = [], []
        for idx in idxs:
            out = os.path.join(self.frames.dir, 'sim%d-k%d.png' % (self.sim_count, idx))
            view = R.render_keyframe(trace, idx, out)
            fid = self.frames.add(view, 'sim', {'type': 'trace', 'path': res['trace'],
                                                'idx': idx})
            images.append(out); fids.append(fid)
        rules = []
        for k, desc in (('C1', 'ego drives'), ('C2', 'not a spawn artifact'),
                        ('C3', 'clearance <=5m'), ('C4', 'demand on ego'),
                        ('C5', 'evaluator accept+critical'), ('C6', 'occlusion proven')):
            rules.append('%s %s: %s' % (k, desc, 'PASS' if g.get(k) else 'FAIL'))
        facts = ('facts: maxSpeed=%.1fm/s dist=%.0fm | closest clearance=%sm at t=%ss '
                 '(warmup=%ss, so spawn-artifact threshold is t>%.1fs) with %r | minTTC=%s '
                 'at t=%s | requiredDecel=%s m/s^2 | collisions=%d | neverFired=%s | '
                 'verdict=%s band=%s %s'
                 % (g['maxSpeedMps'], g['distanceTravelledM'], g.get('clearanceM'),
                    g.get('closestT'), g.get('warmupSeconds'),
                    (g.get('warmupSeconds') or 0) + 0.5, g.get('closestWith'),
                    g.get('minTTC'), g.get('minTTCt'), g.get('requiredDecelMaxEgo'),
                    g.get('collisions', 0), g.get('triggerNeverFired'),
                    res.get('verdict'), res.get('band'),
                    ('| findings: ' + '; '.join(res['findings'])) if res.get('findings') else ''))
        win = 'ALL GATE RULES PASS at this site — emit() to attempt the portability win.' \
            if g.get('pass') else 'Gate not yet passed here.'
        txt = ('Rollout keyframes (frames %s), fixed view, white trails = motion history, '
               'grey = ambient.\n%s\n%s\n%s'
               % (', '.join(fids), ' | '.join(rules), facts, win))
        return txt, images, fids

    def a_inspect(self, do):
        fid = do.get('frame')
        center = None
        if do.get('centerPx'):
            v = self.frames.view(fid)
            if v is None:
                return 'No frame %r.' % fid, [], []
            center = R.world_from_pixel(v, do['centerPx'][0], do['centerPx'][1])
        fid2, view = self.frames.rerender(fid, center=center, span=do.get('spanM'))
        if fid2 is None:
            return str(view), [], []
        return ('Frame %s re-rendered as %s (span %dm).' % (fid, fid2, view['span']),
                [view['out']], [fid2])

    def a_read_pixels(self, do):
        fid = do.get('frame')
        v = self.frames.view(fid)
        if v is None:
            return 'No frame %r.' % fid, [], []
        x, y = R.world_from_pixel(v, do['px'][0], do['px'][1])
        on_site = (self.scene.site and v['map'] == self.scene.site['mapId']
                   and self.scene.route_pl is not None)
        if on_site:
            aw = self.scene.anchor_from_world(x, y)
            txt = ('Ground truth at %s px%s: %s\n'
                   'Portable projection: sAnchor=%.1f (ego pose s=%.1f -> dsM=%.1f), '
                   'lateral=%.2fm left+, -> %s%s'
                   % (fid, do['px'], json.dumps(aw['sem']),
                      aw['proj']['sAnchor'], float(self.scene.roles['ego']['pose']['s']),
                      aw['proj']['sAnchor'] - float(self.scene.roles['ego']['pose']['s']),
                      aw['proj']['lateralM'], json.dumps(aw['lateral']),
                      ' — OPPOSING-direction lane' if aw['opposing'] else ''))
        else:
            sem = R.semantic_at(v['map'], x, y)
            txt = 'Ground truth at %s px%s: %s' % (fid, do['px'], json.dumps(sem))
        fid2, view = self.frames.rerender(fid, center=(x, y), span=22, mark=(x, y))
        return txt, [view['out']] if fid2 else [], [fid2] if fid2 else []

    def a_emit(self, do):
        outdir = os.path.join(self.dir, 'emit-%d' % (self.emit_count + 1))
        res, err = self.scene.emit_batch(outdir)
        self.emit_count += 1
        if res is None:
            return 'emit failed before batch: %s' % '; '.join(str(e) for e in err), [], []
        self.emit_result = res
        per_map = {}
        for c in res['cells']:
            m = per_map.setdefault(c.get('mapId') or '?', {'cells': 0, 'pass': 0, 'ff': {}})
            m['cells'] += 1
            if c.get('pass'):
                m['pass'] += 1
            elif c.get('firstFailure'):
                m['ff'][c['firstFailure']] = m['ff'].get(c['firstFailure'], 0) + 1
        lines = ['emit(): batched across all maps (%d cells).' % len(res['cells'])]
        for m, v in sorted(per_map.items()):
            lines.append('  %-28s %d/%d pass  firstFailures=%s'
                         % (m, v['pass'], v['cells'], json.dumps(v['ff'])))
        p = res['portability']
        need = '>=1 truthful site' if self.scene.contract.get('obligations') else '>=2 maps, >=3 sites'
        lines.append('portability: %d maps / %d sites passing (need %s)'
                     % (p['nMaps'], p['nSites'], need))
        if res['admitted']:
            self.admitted = True
            lines.append('*** WIN — the frozen gate admits this scenario, portably. ***')
        else:
            lines.append('No win yet. The template stays editable; simulate/adjust and '
                         'emit again if budget allows.')
        return '\n'.join(lines), [], []

    def a_remove(self, do):
        ok, err = self.scene.remove(do.get('id'), do.get('interaction'))
        if not ok:
            return 'remove failed: %s' % err, [], []
        if self.scene.site is None:
            return 'Removed. No working site yet.', [], []
        return self._t0_frame('Removed %s.' % (do.get('id') or do.get('interaction')))
