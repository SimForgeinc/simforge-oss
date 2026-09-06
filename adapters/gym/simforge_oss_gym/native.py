"""Native runtime import boundary.

The whole package rides on the compiled extension ``simforge_oss_gym._native``.
There is deliberately no pure-Python or subprocess fallback: a missing or
mismatched extension is an installation error and is reported as one.
"""

from __future__ import annotations

try:
    from . import _native
except ImportError as error:  # pragma: no cover - installation failure path
    raise ImportError(
        "simforge_oss_gym._native is not built for this interpreter. Install the wheel "
        "(`pip install simforge-oss-gym`) or build it in place from the repository with "
        "`maturin develop -m native/crates/simforge-bindings-python/Cargo.toml` "
        "(run from adapters/gym: `maturin develop`). The Rust toolchain is required for source builds."
    ) from error

#: Binding ABI this package is written against; a mismatched extension is refused.
ABI_VERSION = 2
if getattr(_native, "ABI_VERSION", None) != ABI_VERSION:
    raise ImportError(
        f"simforge_oss_gym._native has binding ABI {getattr(_native, 'ABI_VERSION', None)!r} but this package requires "
        f"{ABI_VERSION}; rebuild the extension from the same checkout (`maturin develop` in adapters/gym)."
    )

ENGINE_HZ: int = _native.ENGINE_HZ
STATE_VECTOR_SIZE: int = _native.STATE_VECTOR_SIZE
OBJECT_FEATURES: int = _native.OBJECT_FEATURES
ACTION_WIDTH: int = _native.ACTION_WIDTH
ACTION_FIELDS: tuple[str, ...] = tuple(_native.ACTION_FIELDS)
ENGINE_VERSION: str = _native.ENGINE_VERSION
ACTOR_ROW: int = _native.ACTOR_ROW

NativeError = _native.NativeError
SchemaError = _native.SchemaError
EngineError = _native.EngineError
SessionError = _native.SessionError
UnsupportedError = _native.UnsupportedError

LaneGraph = _native.LaneGraph
ScenarioInput = _native.ScenarioInput
MapBundle = _native.MapBundle
CompileResult = _native.CompileResult
EnvSession = _native.EnvSession
SessionBatch = _native.SessionBatch
StepView = _native.StepView
BatchView = _native.BatchView
WorldSession = _native.WorldSession
WorldSnapshot = _native.WorldSnapshot
TruthSubscription = _native.TruthSubscription
PolicySession = _native.PolicySession
PolicyStep = _native.PolicyStep
Simulation = _native.Simulation
Trace = _native.Trace

compile_template = _native.compile_template
match_sites = _native.match_sites
find_sites = _native.find_sites
find_site = _native.find_site
Site = _native.Site
Route = _native.Route
compile_situation = _native.compile_situation
rehearse_situation = _native.rehearse_situation
solve_situation = _native.solve_situation
compare_situation = _native.compare_situation
apply_situation_transaction = _native.apply_situation_transaction
template_identity_json = _native.template_identity_json
cell_seed = _native.cell_seed
adapt_template_notes_json = _native.adapt_template_notes_json
run_simulation = _native.run_simulation
check_feasibility = _native.check_feasibility
materialize_ambient_traffic = _native.materialize_ambient_traffic
replay_world_log = _native.replay_world_log
canonical_json = _native.canonical_json
content_hash = _native.content_hash
sha256_hex = _native.sha256_hex

__all__ = [
    "ABI_VERSION",
    "ACTION_FIELDS",
    "ACTOR_ROW",
    "ACTION_WIDTH",
    "BatchView",
    "CompileResult",
    "ENGINE_HZ",
    "ENGINE_VERSION",
    "EngineError",
    "EnvSession",
    "LaneGraph",
    "MapBundle",
    "NativeError",
    "OBJECT_FEATURES",
    "PolicySession",
    "PolicyStep",
    "STATE_VECTOR_SIZE",
    "ScenarioInput",
    "SchemaError",
    "SessionBatch",
    "SessionError",
    "Simulation",
    "StepView",
    "Trace",
    "TruthSubscription",
    "UnsupportedError",
    "WorldSession",
    "WorldSnapshot",
    "adapt_template_notes_json",
    "apply_situation_transaction",
    "cell_seed",
    "template_identity_json",
    "compare_situation",
    "compile_situation",
    "compile_template",
    "find_site",
    "find_sites",
    "Route",
    "Site",
    "match_sites",
    "rehearse_situation",
    "solve_situation",
    "replay_world_log",
    "materialize_ambient_traffic",
    "run_simulation",
    "check_feasibility",
    "canonical_json",
    "content_hash",
    "sha256_hex",
]
