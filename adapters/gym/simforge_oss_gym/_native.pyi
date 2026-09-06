"""Type surface of the native extension ``simforge_oss_gym._native``.

The extension is the SimForge Rust runtime (``native/crates/simforge-bindings-python``)
compiled by maturin. Every array returned here is a fresh NumPy array the
caller owns; the runtime never aliases its internal state into Python, so
retained observations cannot be mutated by later steps.

Actions are flat ``float64[ACTION_WIDTH]`` rows (``NaN`` = field unset);
see :data:`ACTION_FIELDS` for slot order. Metadata (scenario documents,
episode configuration, world commands, causal frames) crosses as JSON text
once per call; stepping never does.
"""

from __future__ import annotations

from typing import Callable, Sequence

import numpy as np
from numpy.typing import NDArray

ENGINE_HZ: int
STATE_VECTOR_SIZE: int
OBJECT_FEATURES: int
ACTION_WIDTH: int
#: Slot names in flat action order.
ACTION_FIELDS: tuple[str, ...]
#: Engine identity string (``simforge_core::ENGINE_VERSION``).
ENGINE_VERSION: str
DEFAULT_MAX_OBJECTS: int
#: Binding ABI version; ``simforge_oss_gym.native`` refuses any other value.
ABI_VERSION: int
#: Columns of ``Simulation.actors()`` rows.
ACTOR_ROW: int

class NativeError(RuntimeError):
    """Base of every runtime error; ``kind`` selects the failure family."""

    kind: str
    #: JSON-encoded ``SchemaIssue[]`` / ``SimIssue[]`` when the failure carries them.
    issues_json: str | None

class SchemaError(NativeError): ...
class EngineError(NativeError): ...
class SessionError(NativeError): ...
class UnsupportedError(NativeError): ...

class LaneGraph:
    """Immutable, shareable lane graph decoded from a topology sidecar."""

    @staticmethod
    def from_topology(data: bytes) -> LaneGraph:
        """Decode plain or gzip topology JSON. Identical bytes share one graph."""

    @property
    def digest(self) -> str:
        """Topology ``source.xodrSha256`` (empty for synthetic topologies)."""

    @property
    def byte_digest(self) -> str:
        """SHA-256 of the topology bytes this graph was decoded from."""

    @property
    def lane_count(self) -> int: ...
    @property
    def lane_ids(self) -> list[str]: ...
    def lane_length_m(self, rsl: str) -> float: ...
    def nearest_lane(self, x: float, y: float, max_dist_m: float = 25.0) -> tuple[str, float, float] | None:
        """``(rsl, s, d)`` of the nearest drivable lane in xodr-local metres, or ``None``."""

    def lane_width_at(self, rsl: str, s: float) -> float: ...
    def sample_lane(self, rsl: str, s: float, reversed: bool = False) -> tuple[float, float, float]:
        """``(x, y, heading_rad)`` at arc length ``s`` (clamped) measured along the traversal direction; ``reversed`` runs from the last polyline point (storage ``len - s``)."""

    def project_onto_lane(self, rsl: str, x: float, y: float) -> tuple[float, float]:
        """``(s, d)`` projection of a point onto the lane polyline."""

    def successors(self, rsl: str, reversed: bool = False) -> list[tuple[str, bool]]: ...
    def nominal_reversed(self, rsl: str) -> bool | None: ...
    def lane_json(self, rsl: str) -> str:
        """The decoded ``TopologyLane`` record."""

    def default_placement_route(self, start_rsl: str, start_storage_s: float, required_downstream_m: float) -> tuple[list[str], float] | None:
        """``(lane_rsls, downstream_m)`` for a newly placed road actor, or ``None`` when no route provides the runway."""

    def follow_route(self, start_rsl: str, turns: Sequence[str], max_length_m: float, start_reversed: bool | None = None, strict_turns: bool = False) -> list[str] | None:
        """Lane rsls walking successors consuming ``turns`` (``Straight|Left|Right|UTurnLeft|UTurnRight``); ``None`` when ``strict_turns`` finds a turn unavailable."""

    def route(self, spec_json: str) -> Route:
        """Resolve a ``RouteSpec`` document (``{kind: lanePath|follow|polyline|timedPolyline, ...}``); raises with the ``RouteBuildError`` JSON on failure."""

    def turn_relation_of(self, rsl: str) -> str | None:
        """Turn relation of the first gate whose connecting lane is ``rsl``."""


class Route:
    """A resolved route: engine-frame geometry plus its persisted snapshot."""

    @property
    def length_m(self) -> float: ...
    @property
    def lane_rsls(self) -> list[str]:
        """Empty for polyline routes."""
    def pose_at(self, s: float) -> tuple[float, float, float]:
        """``(x, y, heading_rad)`` at arc length ``s`` (clamped)."""
    def snapshot_json(self) -> str:
        """``RouteSnapshot`` JSON."""

class ScenarioInput:
    """Validated and normalised ``SimScenarioInput``."""

    @staticmethod
    def parse(document: str | bytes) -> ScenarioInput:
        """Validate a scenario JSON document (raw input or ``scenario-instance`` envelope)."""

    def to_json(self) -> str: ...
    def with_seed(self, seed: int | float | str) -> ScenarioInput: ...
    def with_clip_seconds(self, clip_seconds: float) -> ScenarioInput: ...
    @property
    def content_hash(self) -> str: ...
    @property
    def map_id(self) -> str: ...
    @property
    def seed(self) -> int | float | str: ...
    @property
    def clip_seconds(self) -> float: ...
    @property
    def warmup_seconds(self) -> float: ...
    @property
    def dt(self) -> float: ...
    @property
    def metric_subject(self) -> str | None: ...
    @property
    def actor_ids(self) -> list[str]: ...
    @property
    def physics_mode(self) -> str: ...

class MapBundle:
    """Compiled immutable map: native lane graph plus catalog/signal/derived facts."""

    @staticmethod
    def load(path: str) -> MapBundle:
        """Load a compiled map directory or bundle file from the immutable map corpus."""

    @staticmethod
    def from_topology(map_id: str, topology: bytes) -> MapBundle:
        """Bundle a bare topology sidecar (no catalog/signal facts) under ``map_id``."""

    @staticmethod
    def from_sources(sources_json: str, topology: bytes) -> MapBundle:
        """Bundle from in-memory sources ``{mapId, derived?, locations?, searchIndex?, xodr?, signalsGeojson?, staticColliders?: StaticMapCollider[]}`` plus the topology sidecar bytes."""

    @property
    def map_id(self) -> str: ...
    @property
    def digest(self) -> str: ...
    @property
    def graph(self) -> LaneGraph: ...
    def control_plan_json(self) -> str:
        """``{signalPrograms, roadControls}`` bound from the map's signal catalog."""

    def topology_json(self) -> str:
        """The merged ``TopologyIndex`` (map speed limits applied)."""

    def signal_catalog_json(self) -> str:
        """The ``MapSignalCatalog`` (heads, road controls, speed limits)."""

    def signal_control_index_json(self) -> str:
        """Exact physical-head/controller/junction/movement reverse indices."""

    def index_json(self) -> str:
        """The matcher's ``DerivedMapIndex``."""

    def static_collider_diagnostics_json(self) -> str: ...

    def site_signal_plan_json(self, site: Site) -> str:
        """``SiteSignalPlan`` JSON for the site's origin junction."""

    def resolve_site_signal_program(self, site: Site, ref_json: str) -> str | None:
        """Resolve ``{"handle": id}`` or ``{"featureId": id, "approach": "subject"|"opposing"|"left"|"right"}`` to a concrete program id."""

class Site:
    """One grounded matched site (native handle)."""

    @property
    def site_id(self) -> str: ...
    @property
    def map_id(self) -> str: ...
    def to_json(self) -> str:
        """The full ``MatchedSite`` document."""

def find_site(template_json: str, bundle: MapBundle, site_id: str | None = None) -> Site:
    """Resolve one site; ``site_id=None`` picks the top-ranked site, an explicit id may name a matcher-rejected site."""

class CompileResult:
    @property
    def input(self) -> ScenarioInput: ...
    @property
    def manifest_json(self) -> str:
        """JSON ``InstanceManifest``: replay key, site id, parameter draw, notes, warnings."""

    @property
    def observations_json(self) -> str:
        """JSON ``LoweredObservation[]``."""

def compile_template(
    template_json: str,
    bundle: MapBundle,
    site: str | None = None,
    *,
    seed: int | float | str | None = None,
    options_json: str | None = None,
) -> CompileResult:
    """Materialise template x map x site x seed. ``site=None`` picks the top-ranked matched site;
    map-bound documents skip matching. ``options_json``: ``{drawIndex?, seed?, variant?, ambient?, ambientSettleSeconds?}``."""

def match_sites(template_json: str, bundle: MapBundle, options_json: str | None = None) -> str:
    """Ranked ``SiteMatch`` JSON ``{mapId, report: MatchReport, notes}``; ``options_json``: ``{minScore?, maxSites?, exactCatalogSiteResolution?}``."""

def find_sites(template_json: str, bundle: MapBundle) -> list[str]:
    """Ranked site ids in ``bundle`` matching the template's requirements."""

def compile_situation(document_json: str, bundle: MapBundle, options_json: str | None = None) -> tuple[ScenarioInput, str]:
    """Compile a situation document; returns the executable input and the ``BoundSituation`` JSON.
    ``options_json``: ``{materialize?, siteId?, geometryBindings?, runtime?}``."""

PolicyCallback = Callable[[str], str | None]
"""Host policy for declared policy roles: ``(context_json) -> action_json | None``; ``None`` is a rehearsal failure."""

def rehearse_situation(document_json: str, bundle: MapBundle, options_json: str | None = None, policy: PolicyCallback | None = None) -> str:
    """Simulate a situation; ``SituationRehearsal`` JSON."""

def solve_situation(
    document_json: str,
    bundle: MapBundle,
    options_json: str | None = None,
    on_evaluation: Callable[[str], object] | None = None,
    policy: PolicyCallback | None = None,
) -> str:
    """Bounded deterministic solve; ``SituationSolveResult`` JSON. Options add ``maxEvaluations?`` (1..256) and
    ``relativeResolution?``; ``on_evaluation`` receives each ``{program, rehearsal}`` JSON (raising aborts the solve)."""

def compare_situation(document_json: str, transaction_json: str, bundle: MapBundle, options_json: str | None = None, policy: PolicyCallback | None = None) -> str:
    """Compare a declared transaction against the base program; ``SituationComparison`` JSON. Options add ``reactiveRoleIds?``."""

def template_identity_json(template_json: str) -> str:
    """``{templateId, paramsVersion}``: the replay-key identity of a template."""

def adapt_template_notes_json(template_json: str) -> str:
    """``AdaptNote[]`` JSON (``{path, reason, severity: "note"|"error", code?}``) from adapting a template onto the matcher vocabulary; needs no map."""

def cell_seed(template_id: str, params_version: str, site_id: str, draw_index: int) -> str:
    """``sha256(templateId|paramsVersion|siteId|drawIndex)``, the per-cell seed."""

def apply_situation_transaction(document_json: str, transaction_json: str) -> str:
    """Apply a transaction without simulating; ``SituationTransactionResult`` JSON."""

def materialize_ambient_traffic(input: ScenarioInput, graph: LaneGraph, profile_json: str, options_json: str | None = None) -> tuple[ScenarioInput, str]:
    """Apply an ``AmbientTrafficProfile`` document; returns the input with ``ambient``-tagged actors and the provenance JSON."""

def check_feasibility(input: ScenarioInput, graph: LaneGraph) -> str:
    """The ``t = 0`` feasibility guards alone; ``SimIssue[]`` JSON (no clip run)."""

def run_simulation(input: ScenarioInput, graph: LaneGraph, options_json: str | None = None) -> str:
    """Run a whole clip; returns the ``SimResult`` JSON (normalised input, trace, issues, arrival)."""

class StepView:
    """One decision's result. Arrays are owned copies."""

    @property
    def t_s(self) -> float: ...
    @property
    def reward(self) -> float: ...
    @property
    def terminated(self) -> bool: ...
    @property
    def truncated(self) -> bool: ...
    @property
    def state_vector(self) -> NDArray[np.float64]:
        """``(STATE_VECTOR_SIZE,)`` fixed engine layout."""

    @property
    def objects(self) -> NDArray[np.float32]:
        """``(max_objects, OBJECT_FEATURES)`` rows ``[range_m, bearing_rad, range_rate_mps, los, valid]``, zero-padded."""

    @property
    def object_count(self) -> int: ...
    @property
    def object_ids(self) -> list[str]: ...
    @property
    def bev(self) -> NDArray[np.float32] | None:
        """``(height, width, 3)`` ego-centric raster when BEV is configured."""

    @property
    def reward_terms(self) -> NDArray[np.float64]:
        """``[progress, proximity, comfort]``."""

    def info_json(self) -> str:
        """JSON ``{events, minima, causal}`` for this decision."""

class EnvSession:
    """Finite Gymnasium-semantics episode over one world."""

    def __init__(self, input: ScenarioInput, graph: LaneGraph, episode_json: str | None = None, max_objects: int = 64) -> None: ...
    @property
    def ego(self) -> str: ...
    @property
    def decision_hz(self) -> int: ...
    @property
    def decision_ticks(self) -> int: ...
    @property
    def clip_seconds(self) -> float: ...
    @property
    def max_objects(self) -> int: ...
    @property
    def bev_shape(self) -> tuple[int, int, int] | None: ...
    def reset(self, seed: int | float | str | None = None) -> StepView: ...
    def step(self, action: NDArray[np.float64] | None) -> StepView:
        """Hold ``action`` (flat row; ``None`` keeps choreography) for one decision interval."""

    def checkpoint(self) -> bytes:
        """Complete continuation state (RNG, timers, controllers, contacts, episode counters)."""

    def restore(self, checkpoint: bytes) -> StepView:
        """Restore a checkpoint taken from an identical scenario/config; returns the current observation."""

    def ego_pose(self) -> tuple[float, float, float, float, float]:
        """``(t_s, x, y, yaw_rad, speed_mps)`` at the current observation instant."""

    @property
    def actor_count(self) -> int:
        """Actors in the world at the observation instant; raises ``SessionError`` before ``reset()``."""

    @property
    def actor_ids(self) -> list[str]:
        """Canonical ids in snapshot order — the row order of ``actors()``, ``present()`` and ``actor_dims``; raises before ``reset()``."""

    @property
    def actor_kinds(self) -> list[str]: ...
    @property
    def actor_dims(self) -> NDArray[np.float64]:
        """``(N, 3)`` rows ``[l, w, h]``."""

    def actors(self) -> NDArray[np.float64]:
        """``(N, ACTOR_ROW)`` rows ``[x, y, heading_rad, speed_mps, accel_mps2, lateral_offset_m, lateral_rate_mps, s]`` (xodr-local)
        at the current observation instant (after ``reset``/``step``/``restore``); owned copy, raises before ``reset()``."""

    def present(self) -> NDArray[np.bool_]:
        """``(N,)`` whether each actor exists in the world at the observation instant."""

    def signal_book_json(self) -> str: ...
    def causal_channel_json(self) -> str:
        """The accumulated ``CausalChannel`` of the current episode as JSON."""

class BatchView:
    """Results for all worlds of one ``SessionBatch`` call; world-major arrays."""

    @property
    def size(self) -> int: ...
    @property
    def t_s(self) -> NDArray[np.float64]: ...
    @property
    def reward(self) -> NDArray[np.float64]: ...
    @property
    def terminated(self) -> NDArray[np.bool_]: ...
    @property
    def truncated(self) -> NDArray[np.bool_]: ...
    @property
    def state_vector(self) -> NDArray[np.float64]:
        """``(N, STATE_VECTOR_SIZE)``."""

    @property
    def objects(self) -> NDArray[np.float32]:
        """``(N, max_objects, OBJECT_FEATURES)``."""

    @property
    def object_count(self) -> NDArray[np.uint32]: ...
    @property
    def reward_terms(self) -> NDArray[np.float64]:
        """``(N, 3)``."""

    @property
    def bev(self) -> NDArray[np.float32] | None:
        """``(N, height, width, 3)`` when BEV is configured."""

    def object_ids(self, world: int) -> list[str]: ...
    def info_json(self, world: int) -> str: ...

class SessionBatch:
    """N independent ``EnvSession`` worlds stepped together; CPU parallel over worlds."""

    def __init__(
        self,
        inputs: Sequence[ScenarioInput],
        graphs: Sequence[LaneGraph],
        episode_json: str | None = None,
        threads: int | None = None,
        max_objects: int = 64,
    ) -> None: ...
    @property
    def size(self) -> int: ...
    @property
    def egos(self) -> list[str]: ...
    @property
    def decision_hz(self) -> int: ...
    @property
    def max_objects(self) -> int: ...
    @property
    def bev_shape(self) -> tuple[int, int, int] | None: ...
    def reset_all(self, seeds: Sequence[int | float | str] | None = None) -> BatchView: ...
    def reset_worlds(
        self, worlds: NDArray[np.int64], seeds: Sequence[int | float | str | None] | None = None
    ) -> BatchView:
        """Reset only the listed worlds; the view carries all N rows (unlisted rows repeat their current observation)."""

    def step_batch(self, actions: NDArray[np.float64], mask: NDArray[np.bool_] | None = None) -> BatchView:
        """Step every world (or only ``mask``-true worlds) with its ``(N, ACTION_WIDTH)`` action row."""

    def checkpoint(self, world: int) -> bytes: ...
    def restore(self, world: int, checkpoint: bytes) -> None: ...

class WorldSnapshot:
    @property
    def t_s(self) -> float: ...
    @property
    def tick(self) -> int: ...
    @property
    def done(self) -> bool: ...
    @property
    def actor_ids(self) -> list[str]: ...
    @property
    def kinds(self) -> list[str]: ...
    @property
    def present(self) -> NDArray[np.bool_]: ...
    @property
    def lane_rsls(self) -> list[str | None]: ...
    @property
    def pose(self) -> NDArray[np.float64]:
        """``(N, 5)`` rows ``[x, z, heading_rad, speed_mps, s]`` in the scene frame."""

    def to_json(self) -> str: ...

class TruthSubscription:
    """Bounded per-tick ground-truth subscriber; drop-oldest with a cumulative gap counter."""

    def drain(self) -> list[str]:
        """Take every queued tick document (TruthFrame JSON) in order."""

    def drain_frames(self) -> list[bytes]:
        """Every queued frame as ``u32le length || msgpack(TruthFrame)`` (truth-stream wire framing)."""

    @property
    def dropped(self) -> int: ...
    @property
    def queued(self) -> int: ...
    @property
    def active(self) -> bool: ...
    def close(self) -> None: ...

class WorldSession:
    """Command-driven live/clip world with atomic edits, replay log and truth subscribers."""

    def __init__(self, input: ScenarioInput, graph: LaneGraph, options_json: str | None = None) -> None: ...
    @property
    def time(self) -> float: ...
    @property
    def tick(self) -> int: ...
    @property
    def digest(self) -> str: ...
    def command(self, command_json: str, client_id: str = "python", seq: int = 0) -> str:
        """Apply one ``WorldCommand`` (spawn/despawn/batch/act); returns the ``CommandOutcome`` JSON."""

    def advance(self, ticks: int) -> str:
        """Advance ``ticks`` engine ticks; returns ``AdvanceResult`` JSON (``t_s``, ``done``, events)."""

    def snapshot(self) -> WorldSnapshot: ...
    def subscribe(self, capacity: int | None = None) -> TruthSubscription: ...
    def log_json(self) -> str:
        """The replayable ``WorldSessionLog`` (commands, advances, digest)."""

    def checkpoint(self) -> bytes: ...
    def restore(self, checkpoint: bytes) -> None: ...

def replay_world_log(log_json: str, input: ScenarioInput, graph: LaneGraph) -> str:
    """Replay a session log; returns ``ReplayResult`` JSON whose digest must equal the log's."""

class PolicyStep:
    @property
    def step(self) -> StepView: ...
    @property
    def deadline_limit_ms(self) -> float | None: ...
    @property
    def deadline_elapsed_ms(self) -> float | None: ...
    @property
    def deadline_miss(self) -> bool: ...
    @property
    def applied(self) -> str:
        """``policy`` | ``repeat-last`` | ``zero-control`` | ``scripted``."""

    def executor_json(self) -> str | None:
        """Trajectory executor telemetry (pose, cross-track, setpoints, preview) or ``None``."""

class PolicySession:
    """Deadline-accounted policy execution (control or ego-frame trajectory plans) over an ``EnvSession``."""

    def __init__(self, session: EnvSession, deadline_ms: float | None = None, fallback: str = "repeat-last", execution: str = "pure-pursuit") -> None: ...
    @property
    def execution(self) -> str: ...
    def reset(self, seed: int | float | str | None = None) -> StepView: ...
    def act_control(self, throttle: float, brake: float, steer: float, elapsed_ms: float | None = None) -> PolicyStep: ...
    def act_trajectory(self, points: NDArray[np.float64], elapsed_ms: float | None = None) -> PolicyStep:
        """``points`` is ``(K, 5)`` rows ``[x, y, heading_rad, speed_mps, t_s]`` in the ego frame at issuance."""

    def checkpoint(self) -> bytes:
        """Env continuation state plus the executor's held plan / last applied action."""

    def restore(self, checkpoint: bytes) -> StepView: ...

class Simulation:
    """Bare engine world with explicit per-actor action batches (no episode/warmup/reward semantics)."""

    def __init__(self, input: ScenarioInput, graph: LaneGraph, options_json: str | None = None) -> None:
        """``options_json``: ``{captureTrace?, resolveArrival?, includeWarmupTrace?, ambientReactivity?: "scripted"|"reactive"}``."""

    @property
    def t_s(self) -> float: ...
    @property
    def dt_s(self) -> float: ...
    @property
    def tick_index(self) -> int: ...
    @property
    def done(self) -> bool: ...
    def result_json(self) -> str:
        """The completed run's ``SimResult`` JSON (``{input, trace, issues, arrival}``); raises (engine kind) until ``done``."""

    def trace_json(self) -> str:
        """Recorded trace prefix without advancing or finalizing the world."""
    def input_json(self) -> str:
        """The exact resolved input executed by this world."""
    def issues_json(self) -> str: ...
    def arrival_json(self) -> str: ...

    @property
    def actor_count(self) -> int: ...
    @property
    def actor_ids(self) -> list[str]:
        """Canonical ids in actor-index order (stable for the world's lifetime)."""

    @property
    def actor_kinds(self) -> list[str]: ...
    @property
    def actor_dims(self) -> NDArray[np.float64]:
        """``(N, 3)`` rows ``[l, w, h]``."""

    def actor_index(self, id: str) -> int: ...
    def advance(self, max_ticks: int, actions: NDArray[np.float64] | None = None) -> tuple[int, bool]:
        """Hold ``actions`` (``(K, 1 + ACTION_WIDTH)`` rows ``[actor_index, ...action]``) for up to ``max_ticks``; returns ``(ticks_advanced, done)``."""

    def actors(self) -> NDArray[np.float64]:
        """``(N, ACTOR_ROW)`` rows ``[x, y, heading_rad, speed_mps, accel_mps2, lateral_offset_m, lateral_rate_mps, s]`` (xodr-local)."""

    def present(self) -> NDArray[np.bool_]: ...
    def lane_rsls(self) -> list[str | None]: ...
    def minima_json(self) -> str: ...
    def drain_events_json(self) -> str:
        """JSON ``SimEvent[]`` recorded since the previous drain."""

    def signal_state_json(self) -> str:
        """JSON ``{tS, signals: SignalSnapshot[], overrides}`` at the current instant."""

    def checkpoint(self) -> bytes: ...
    def restore(self, checkpoint: bytes) -> None: ...

class Trace:
    """A validated current-format trace document."""

    @staticmethod
    def parse(data: bytes) -> Trace:
        """Parse plain or gzip trace JSON; non-current formats are rejected."""

    def digest(self) -> str:
        """``sha256(canonicalJson(quantize(trace)))`` (the current ``traceDigest``)."""

    def to_json(self) -> str: ...
    def scene_state_json(self) -> str:
        """``simforge.scene-state.v1`` document."""

    def metrics_json(self) -> str:
        """``EpisodeMetrics`` recorded in the trace."""

    def evaluate_json(self, filters_json: str | None = None) -> str:
        """``TraceEvaluation`` with an optional camelCase ``EvaluateFilters`` patch."""

    def intent_rubric_json(self, rubric_json: str) -> str:
        """``IntentEvaluation`` JSON for an intent rubric document."""

    def blind_review_packet_json(self, rubric_json: str) -> str:
        """``BlindReviewPacket`` JSON: the rubric evaluated against this trace, stripped for blind review."""

    def behavior_summary_json(self, limits_json: str | None = None) -> str:
        """``BehaviorSummary`` JSON; ``limits_json`` is an optional camelCase ``BehaviorSummaryLimits``."""

    def invariants_json(self, template_json: str, options_json: str | None = None) -> str:
        """``InvariantResidualReport[]`` JSON: the template's declared invariants checked against this trace.
        ``options_json``: ``{scope?: {lane?: {speedLimitKph?, widthM?}, junction?: {sizeM?}, clip?: {seconds?}, params?},
        arrival?: ArrivalSolution[], speedLimitKph?}``."""


def canonical_json(document: str) -> str: ...
def content_hash(document: str) -> str: ...
def sha256_hex(data: bytes) -> str: ...
