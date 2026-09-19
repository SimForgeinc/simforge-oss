"""One native Simulation, atomic per-actor action batches, canonical trace export.

PolicySession is ego-only and advances while acting. Simulation.advance is the
existing native multi-actor interface; its speed/acceleration override retains
native lane steering and physical dynamics. No second Python vehicle model.
"""
import json
import math
import numpy as np
from simforge_oss_gym import native
from simforge_oss_gym.episodes import load_episode_spec
from . import policy as C

class NativeWorld:
    def __init__(self, spec, seconds, seed):
        self.episode = load_episode_spec(spec).episodes[0]
        self.input = self.episode.input.with_clip_seconds(seconds).with_seed(seed)
        self.data = json.loads(self.input.to_json())
        if self.input.physics_mode != "dynamic-v1" or self.input.dt != C.DT_S:
            raise ValueError("native dynamic-v1 at 50 Hz is required")
        if self.input.warmup_seconds:
            raise ValueError("multi-driver episodes must explicitly use warmupSeconds=0")
        self.sim = native.Simulation(self.input, self.episode.graph,
                                    json.dumps({"captureTrace": True, "resolveArrival": False}))
        self.ids = list(self.sim.actor_ids)
        self.index = {aid: i for i, aid in enumerate(self.ids)}
        self.dims = self.sim.actor_dims
        self.kinds = list(self.sim.actor_kinds)
        self.specs = {a["id"]: a for a in self.data["actors"]}
        self.actions = np.full((len(self.ids), 1 + native.ACTION_WIDTH), np.nan)
        self.actions[:, 0] = np.arange(len(self.ids))
        self.refresh()

    def refresh(self):
        self.rows = self.sim.actors()
        self.present = self.sim.present()
        self.time_s = self.sim.t_s
        self.tick = self.sim.tick_index

    def pose(self, actor_id):
        r = self.rows[self.index[actor_id]]
        return (self.time_s, float(r[0]), float(r[1]), float(r[2]), float(r[3]))

    def advance(self, drivers):
        self.actions[:, 1:] = np.nan
        fields = {name: i + 1 for i, name in enumerate(native.ACTION_FIELDS)}
        for driver in drivers:
            latch = driver.latch()
            points = latch["points"]
            age = max(0.0, self.time_s - latch["time_s"])
            target = float(np.interp(age + C.DT_S, points[:, 4], points[:, 3], left=latch["speed_mps"]))
            # Feed-forward bounded acceleration, with a zero-speed tail. Native
            # speed tracking does not suffer held raw brake's through-zero bug.
            v0 = float(np.interp(age, points[:, 4], points[:, 3], left=latch["speed_mps"]))
            accel = max(-C.MAX_BRAKE_MPS2, min(driver.persona.safety_profile.max_accel_mps2,
                                             (target - v0) / C.DT_S))
            i = self.index[driver.actor_id]
            self.actions[i, fields["target_speed_mps"]] = max(0.0, target)
            self.actions[i, fields["target_acceleration_mps2"]] = accel
            self.actions[i, fields["motion_direction"]] = 1.0
        advanced, done = self.sim.advance(1, self.actions)
        if advanced != 1:
            raise RuntimeError("native world ended before requested clip duration")
        events = json.loads(self.sim.drain_events_json())
        self.refresh()
        return events

    def write_scene(self, path, drivers):
        # This is the canonical emitter, not a hand-written frame conversion.
        trace_text = self.sim.trace_json()
        trace = native.Trace.parse(trace_text.encode())
        doc = json.loads(trace.scene_state_json())
        personas = {d.actor_id: d.persona.name for d in drivers}
        for actor in doc["actors"]:
            actor["persona"] = personas.get(actor["id"])
            actor["controlled"] = actor["id"] in personas
        doc["driverMetadata"] = [{"actor_id": d.actor_id, "persona": d.persona.name} for d in drivers]
        path.write_text(json.dumps(doc))
        path.with_name("trace.json").write_text(trace_text)
        return doc
