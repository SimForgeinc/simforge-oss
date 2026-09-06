"""Episode specs: ordered ``(scenario input, lane graph)`` pairs loaded natively.

An episode spec is the same JSON document the former env-server consumed:

Form A (pre-materialised instances)::

    {"episode": {...}, "topology": "<fallback topology path or inline>",
     "instances": ["instance.json", {"input": {...} | "path", "topology": {...} | "path"}]}

Form B (template x map x site x seeds)::

    {"episode": {...}, "template": "t.json", "map": "<map id>", "site": "<site id>", "seeds": [...]}

Paths resolve against the spec file's directory. Instances that name no
topology fall back to the map named by their ``mapId`` in the installed map
corpus (``SIMFORGE_MAPS_CACHE_ROOT``/``SCEN_DEV_ASSETS``, same layout as the
CLI). Materialisation, validation and lane-graph construction all run in the
native runtime; this module only resolves files and shares graphs by digest.
"""

from __future__ import annotations

import gzip
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from .native import LaneGraph, MapBundle, ScenarioInput, compile_template

_MAP_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_REQUIRED_MAP_FILES = (
    "map.xodr",
    "signals.geojson.gz",
    "topology-index.json.gz",
    "derived/topology-derived.json.gz",
    "derived/locations.json.gz",
)


def maps_root(env: Mapping[str, str] | None = None) -> Path:
    """``SCEN_DEV_ASSETS`` or ``${SIMFORGE_MAPS_CACHE_ROOT:-$XDG_DATA_HOME/simforge/maps}/dev-assets``."""
    env = os.environ if env is None else env
    explicit = env.get("SCEN_DEV_ASSETS")
    if explicit:
        return Path(explicit).resolve()
    cache_root = env.get("SIMFORGE_MAPS_CACHE_ROOT")
    if not cache_root:
        data_home = env.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        cache_root = str(Path(data_home) / "simforge" / "maps")
    return Path(cache_root).resolve() / "dev-assets"


def map_dir(map_id: str, root: Path | None = None) -> Path:
    if not _MAP_ID.match(map_id):
        raise ValueError(f"invalid map identifier {map_id!r}")
    return (root or maps_root()) / map_id


def available_maps(root: Path | None = None) -> list[str]:
    """Complete installed map bundles under ``root``, lexically sorted."""
    root = root or maps_root()
    if not root.is_dir():
        return []
    return sorted(
        entry.name
        for entry in root.iterdir()
        if _MAP_ID.match(entry.name) and entry.is_dir() and all((entry / name).is_file() for name in _REQUIRED_MAP_FILES)
    )


def _read_json(path: Path) -> Any:
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def _read_bytes(path: Path) -> bytes:
    return path.read_bytes()


def _resolve(spec_dir: Path, candidate: str) -> Path:
    path = Path(candidate)
    return path if path.is_absolute() else (spec_dir / path)


@dataclass(frozen=True)
class LoadedEpisode:
    """One materialised episode; session order follows spec order."""

    input: ScenarioInput
    graph: LaneGraph
    #: Map identity for scene-state consumers; ``None`` for synthetic topologies.
    map_id: str | None
    topology_digest: str | None
    #: The exact topology sidecar bytes ``graph`` was decoded from (plain or
    #: gzip JSON), for providers that decode the map themselves (GPU profile).
    topology_bytes: bytes


@dataclass(frozen=True)
class EpisodeSpec:
    episodes: tuple[LoadedEpisode, ...]
    #: Spec-level ``EpisodeConfig`` (camelCase keys) shared by every session.
    episode_config: dict[str, Any] = field(default_factory=dict)

    @property
    def egos(self) -> tuple[str, ...]:
        return tuple(_ego_of(ep.input) for ep in self.episodes)


def _ego_of(input: ScenarioInput) -> str:
    # Mirrors the session's metric-subject rule; the native EnvSession is the
    # authority and re-derives it, this is only for spec-level bookkeeping.
    subject = input.metric_subject
    if subject:
        return subject
    ids = sorted(input.actor_ids)
    if not ids:
        raise ValueError("scenario has no actors")
    return ids[0]


class _GraphCache:
    """Share one lane graph per distinct topology byte content."""

    def __init__(self) -> None:
        self._by_path: dict[Path, bytes] = {}
        self._by_bytes: dict[bytes, LaneGraph] = {}

    def for_path(self, path: Path) -> tuple[LaneGraph, bytes]:
        resolved = path.resolve()
        data = self._by_path.get(resolved)
        if data is None:
            data = _read_bytes(resolved)
            self._by_path[resolved] = data
        return self.for_bytes(data), data

    def for_bytes(self, data: bytes) -> LaneGraph:
        # The native side dedups by SHA-256 as well; this only saves the FFI call.
        graph = self._by_bytes.get(data)
        if graph is None:
            graph = LaneGraph.from_topology(data)
            self._by_bytes[data] = graph
        return graph

    def for_inline(self, topology: Mapping[str, Any]) -> tuple[LaneGraph, bytes]:
        data = json.dumps(topology, separators=(",", ":")).encode()
        return self.for_bytes(data), data


class _BundleCache:
    def __init__(self, root: Path | None) -> None:
        self._root = root
        self._bundles: dict[str, tuple[MapBundle, bytes]] = {}

    def load(self, map_id: str) -> tuple[MapBundle, bytes]:
        entry = self._bundles.get(map_id)
        if entry is None:
            directory = map_dir(map_id, self._root)
            missing = [name for name in _REQUIRED_MAP_FILES if not (directory / name).is_file()]
            if missing:
                raise FileNotFoundError(
                    f"map {map_id!r} is not installed under {directory.parent} (missing {missing}); "
                    "pull it with `simforge maps pull <name>@<version>` or set SIMFORGE_MAPS_CACHE_ROOT"
                )
            entry = (MapBundle.load(str(directory)), _read_bytes(directory / "topology-index.json.gz"))
            self._bundles[map_id] = entry
        return entry


def _load_instances(spec_dir: Path, spec: Mapping[str, Any], graphs: _GraphCache, bundles: _BundleCache) -> list[LoadedEpisode]:
    episodes: list[LoadedEpisode] = []
    spec_topology = spec.get("topology")
    for entry in spec["instances"]:
        topology_ref: Any = spec_topology
        if isinstance(entry, str):
            raw_input = _read_bytes(_resolve(spec_dir, entry))
        elif isinstance(entry, Mapping):
            inline = entry["input"]
            raw_input = _read_bytes(_resolve(spec_dir, inline)) if isinstance(inline, str) else json.dumps(inline).encode()
            if "topology" in entry:
                topology_ref = entry["topology"]
        else:
            raise ValueError(f"instance entry must be a path or an object, got {type(entry).__name__}")

        input = ScenarioInput.parse(raw_input)
        if topology_ref is None:
            bundle, topology = bundles.load(input.map_id)
            episodes.append(LoadedEpisode(input, bundle.graph, input.map_id, bundle.graph.digest or None, topology))
            continue
        graph, topology = graphs.for_path(_resolve(spec_dir, topology_ref)) if isinstance(topology_ref, str) else graphs.for_inline(topology_ref)
        episodes.append(LoadedEpisode(input, graph, input.map_id or None, graph.digest or None, topology))
    return episodes


def _load_template(spec_dir: Path, spec: Mapping[str, Any], bundles: _BundleCache) -> list[LoadedEpisode]:
    missing = [key for key in ("template", "map", "seeds") if key not in spec]
    if missing:
        raise ValueError(f"template episode spec needs {missing}")
    template_json = json.dumps(_read_json(_resolve(spec_dir, spec["template"])))
    bundle, topology = bundles.load(spec["map"])
    # ``site``: matcher site id, or absent/null for the top-ranked site.
    # ``options``: materialize options ``{drawIndex?, variant?, ambient?, ambientSettleSeconds?}``.
    options = spec.get("options")
    options_json = None if options is None else json.dumps(options)
    episodes: list[LoadedEpisode] = []
    for seed in spec["seeds"]:
        result = compile_template(template_json, bundle, spec.get("site"), seed=seed, options_json=options_json)
        episodes.append(LoadedEpisode(result.input, bundle.graph, spec["map"], bundle.graph.digest or None, topology))
    return episodes


def load_episode_spec(spec_path: str | Path, *, maps_dir: str | Path | None = None) -> EpisodeSpec:
    """Load a spec file into ordered episodes; exactly one form must be present."""
    absolute = Path(spec_path).resolve()
    spec = _read_json(absolute)
    if not isinstance(spec, Mapping):
        raise ValueError(f"episode spec {absolute} must be a JSON object")
    has_a = "instances" in spec
    has_b = "template" in spec or "seeds" in spec
    if has_a == has_b:
        raise ValueError('episode spec must declare exactly one of "instances" or "template"/"map"/"site"/"seeds"')
    if has_a and not spec["instances"]:
        raise ValueError('"instances" must not be empty')

    bundles = _BundleCache(None if maps_dir is None else Path(maps_dir).resolve())
    episodes = (
        _load_instances(absolute.parent, spec, _GraphCache(), bundles) if has_a else _load_template(absolute.parent, spec, bundles)
    )
    config = spec.get("episode") or {}
    if not isinstance(config, Mapping):
        raise ValueError('"episode" must be an object')
    return EpisodeSpec(tuple(episodes), dict(config))


def episode_config(
    base: Mapping[str, Any],
    *,
    decision_hz: int | None = None,
    clip_seconds: float | None = None,
    max_decisions: int | None = None,
    bev: Mapping[str, Any] | bool | None = None,
) -> dict[str, Any]:
    """Merge caller overrides over a spec-level ``EpisodeConfig`` (camelCase)."""
    config = dict(base)
    if decision_hz is not None:
        config["decisionHz"] = int(decision_hz)
    if clip_seconds is not None:
        config["clipSeconds"] = float(clip_seconds)
    if max_decisions is not None:
        config["maxDecisions"] = int(max_decisions)
    if bev is not None:
        observation = dict(config.get("observation") or {})
        observation["bev"] = {} if bev is True else (None if bev is False else dict(bev))
        config["observation"] = observation
    return config


def episode_config_json(config: Mapping[str, Any]) -> str | None:
    return json.dumps(config) if config else None


__all__: Sequence[str] = [
    "EpisodeSpec",
    "LoadedEpisode",
    "available_maps",
    "episode_config",
    "episode_config_json",
    "load_episode_spec",
    "map_dir",
    "maps_root",
]
