"""simforge-oss-gym: the SimForge Python SDK.

The Rust native runtime ships inside this wheel as ``simforge_oss_gym._native``
(no Node, Studio or subprocess). Execution profiles with their own providers
(GPU batch, articulated MuJoCo, resident Bevy sensors) are explicit extras
selected through :mod:`simforge_oss_gym.profiles`.
"""

# The socket client (``simforge env serve``) needs no compiled extension.
from .socket_env import EnvServeError, SimForgeSocketEnv, SocketEnvClient, spawn_env_server

# Everything else rides on the extension. An install without it cannot run
# them, and says so the moment one is used: the socket client above stays
# importable, nothing falls back.
try:
    from .env import SimForgeEnv, action_space_for, encode_action, observation_space_for
    from .episodes import EpisodeSpec, LoadedEpisode, available_maps, load_episode_spec, maps_root
    from .native import (
        ACTION_FIELDS,
        ACTION_WIDTH,
        ENGINE_HZ,
        ENGINE_VERSION,
        OBJECT_FEATURES,
        STATE_VECTOR_SIZE,
        EngineError,
        EnvSession,
        LaneGraph,
        MapBundle,
        NativeError,
        ScenarioInput,
        SchemaError,
        SessionBatch,
        SessionError,
        UnsupportedError,
        WorldSession,
        compile_situation,
        compile_template,
        find_site,
        find_sites,
        Site,
        Route,
        match_sites,
        rehearse_situation,
        solve_situation,
        compare_situation,
        apply_situation_transaction,
        template_identity_json,
        cell_seed,
        adapt_template_notes_json,
        run_simulation,
        check_feasibility,
    )
    from .policy import PolicyRunner
    from .profiles import ARTICULATED, PROFILES, ROADWAY_GPU, ROADWAY_NATIVE, ProfileUnavailableError, available_profiles, make_env, make_vector_env
    from .vector import SimForgeVectorEnv
    from .world import SimForgeWorld, TruthStream

except ImportError as _native_error:  # pragma: no cover - installation failure path
    _NATIVE_ERROR = _native_error

    def __getattr__(name: str):  # noqa: D401 - module-level attribute hook
        if name in __all__:
            raise ImportError(f"simforge_oss_gym.{name} needs the compiled extension: {_NATIVE_ERROR}") from _NATIVE_ERROR
        raise AttributeError(name)

__all__ = [
    "EnvServeError",
    "SimForgeSocketEnv",
    "SocketEnvClient",
    "spawn_env_server",
    "ACTION_FIELDS",
    "ACTION_WIDTH",
    "ARTICULATED",
    "ENGINE_HZ",
    "ENGINE_VERSION",
    "OBJECT_FEATURES",
    "PROFILES",
    "ROADWAY_GPU",
    "ROADWAY_NATIVE",
    "STATE_VECTOR_SIZE",
    "EngineError",
    "EnvSession",
    "EpisodeSpec",
    "LaneGraph",
    "LoadedEpisode",
    "MapBundle",
    "NativeError",
    "PolicyRunner",
    "ProfileUnavailableError",
    "ScenarioInput",
    "SchemaError",
    "SessionBatch",
    "SessionError",
    "SimForgeEnv",
    "SimForgeVectorEnv",
    "SimForgeWorld",
    "TruthStream",
    "UnsupportedError",
    "WorldSession",
    "action_space_for",
    "available_maps",
    "available_profiles",
    "adapt_template_notes_json",
    "apply_situation_transaction",
    "cell_seed",
    "template_identity_json",
    "compare_situation",
    "compile_situation",
    "compile_template",
    "encode_action",
    "find_site",
    "find_sites",
    "Route",
    "Site",
    "match_sites",
    "rehearse_situation",
    "solve_situation",
    "load_episode_spec",
    "make_env",
    "make_vector_env",
    "maps_root",
    "observation_space_for",
    "run_simulation",
    "check_feasibility",
]
