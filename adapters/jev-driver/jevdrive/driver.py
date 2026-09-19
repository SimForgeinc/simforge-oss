"""One driver's observation, advisory decision and deterministic held maneuver."""
from dataclasses import dataclass
import math
from . import policy as C
from .client import ask
from .safety import generate, conservative_baseline, minimum_risk_stop, monitor

@dataclass(frozen=True)
class Decision:
    chosen_maneuver: str
    record: dict


class JevDriver:
    def __init__(self, actor_id, persona, provider, client):
        self.actor_id, self.persona, self.provider, self.client = actor_id, persona, provider, client
        self._latch = None
        self.active = None
        self.decision_index = 0
        self.distance_m = 0.0
        self.previous_pose = None

    def observe(self, world):
        pose = world.pose(self.actor_id)
        if self.previous_pose is not None:
            self.distance_m += math.hypot(pose[1] - self.previous_pose[1], pose[2] - self.previous_pose[2])
        self.previous_pose = pose
        return self.provider.observe(world)

    def feasible(self, scene, pose):
        return generate(scene, self._latch, pose, profile=self.persona.safety_profile,
                        candidate_family=self.persona.candidate_family)

    def decide(self, obs, feasible):
        # This function does not mutate a latch, world, or peer. The coordinator
        # collects every result before committing any driver in this barrier.
        baseline = conservative_baseline(obs, feasible)
        state = dict(obs, candidates=[c.summary() for c in feasible.values()],
                     safety_assumptions=self.persona.safety_profile.document())
        if len(feasible) > 1:
            response = ask(self.client, state, self.persona)
            chosen = response["jev_choice"] if response["fallback_reason"] is None else baseline
        else:
            response = {"jev_choice": None, "probabilities": {}, "confidence": None,
                        "api_latency_ms": None, "raw_response": {},
                        "fallback_reason": "no_feasible_candidate" if not feasible else "forced_single_candidate"}
            chosen = baseline
        record = {**response, "actor_id": self.actor_id, "persona": self.persona.name,
                  "tick": obs["seq"], "time_s": obs["state_time_s"], "decision_index": self.decision_index,
                  "staleness_m": 0.0, "staleness_s": 0.0, "baseline": baseline,
                  "latched_maneuver": chosen, "state": state, "feasible": list(feasible),
                  "decision_age_ticks": 0, "decision_age_s": 0.0, "fresh_decision": True,
                  **self.provider.debug_counts}
        return Decision(chosen, record)

    def commit(self, decision, scene, feasible, pose):
        self.active = decision.record
        self.decision_index += 1
        self._set_latch(decision.chosen_maneuver, scene, feasible, pose)

    def _set_latch(self, name, scene, feasible, pose):
        self._latch = {"id": name, "time_s": scene["state_time_s"], "speed_mps": scene["ego"]["speed_mps"],
                       "pose": pose, "points": minimum_risk_stop(scene) if name == "emergency_brake" else feasible[name].points}

    def supervise(self, scene, feasible, pose):
        name, override = monitor(scene, self._latch, feasible, pose, self.persona.safety_profile)
        if override:
            self._set_latch(name, scene, feasible, pose)
        return override

    def latch(self):
        return self._latch

    def display(self, tick, override):
        active = self.active
        age = tick - active["tick"] if active else None
        fields = ("jev_choice", "probabilities", "confidence", "api_latency_ms", "staleness_m", "fallback_reason", "decision_index")
        record = {k: active[k] if active else ({} if k == "probabilities" else None) for k in fields}
        return {**record, "actor_id": self.actor_id, "persona": self.persona.name,
                "latched_maneuver": self._latch["id"], "decision_age_ticks": age,
                "decision_age_s": None if age is None else round(age * C.DT_S, 2),
                "fresh_decision": age == 0, "safety_override": override,
                "speed_mps": round(self.previous_pose[4], 3), "distance_m": round(self.distance_m, 3),
                **self.provider.debug_counts}
