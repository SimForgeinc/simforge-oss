"""Live ``simforge.scene-state.v1`` export from a running episode.

The resident Bevy renderer renders from scene-state documents the *world owner*
publishes (``renderer/service/src/scene.rs`` ``LoadSceneState``). ``EnvSession``
has no scene-state exporter of its own, but it does expose the authoritative
per-decision state — ``actor_ids``, ``actor_kinds``, ``actor_dims``,
``actors()`` and ``present()`` — so this module builds the renderer's documents
from it directly. No native change is needed and nothing is re-derived from a
recording: every document describes the world *as it is after the last applied
action*, which is exactly what makes the resulting camera frames
policy-dependent rather than a replay.

Frame conventions (mirroring ``packages/engine/src/scene-state/helpers.ts`` and
``adapters/physics/simforge_oss_physics/scene_state.py``):

- Engine world is xodr-local, x forward / y left / z up; the scene frame is
  y-up, ``scene = (x, z, -y)``. Planar road actors have ``z = 0``, so their
  scene position is ``[x, groundY, -y]`` and ``groundY`` (default 0) is only a
  ground hint the service may raycast against.
- Yaw about engine +z equals yaw about scene +y, so a heading becomes the y-up
  quaternion ``[0, sin(h/2), 0, cos(h/2)]``.
- Actor lifecycle is emitted as ``spawn`` on first appearance (carrying
  ``catalogId``/``actorClass``/``dims``), ``update`` thereafter and ``despawn``
  when an actor leaves the world.

The catalog/class defaults mirror `helpers.ts` so browser and native renders
select the same meshes; a rig document may override them per actor kind or per
actor id, and an unknown kind falls back to `vehicle.sedan` exactly as the
TypeScript helper does.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

from .native import ENGINE_HZ

SCENE_STATE_VERSION = "simforge.scene-state.v1"

#: Mirror of ``CATALOG_BY_KIND`` in packages/engine/src/scene-state/helpers.ts.
CATALOG_BY_KIND: dict[str, str] = {
    "pedestrian": "pedestrian.adult",
    "bicycle": "cyclist.commuter",
    "bus": "vehicle.transit-bus",
    "truck": "vehicle.box-truck",
    "motorcycle": "vehicle.motorcycle",
    "obstacle": "prop.traffic-cone",
    "static_object": "hazard.cardboard_box",
}
DEFAULT_CATALOG_ID = "vehicle.sedan"

#: Scene-state ``actorClass`` (`packages/engine/src/scene-state/schema.ts`).
ACTOR_CLASS_BY_KIND: dict[str, str] = {
    "vehicle": "car",
    "car": "car",
    "truck": "truck",
    "bus": "bus",
    "motorcycle": "motorcycle",
    "bicycle": "bicycle",
    "cyclist": "bicycle",
    "pedestrian": "pedestrian",
    "obstacle": "prop",
    "static_object": "prop",
}
DEFAULT_ACTOR_CLASS = "car"


def yaw_to_quaternion(yaw: float) -> list[float]:
    """Yaw about scene +Y as the y-up quaternion ``[x, y, z, w]``."""
    return [0.0, math.sin(yaw / 2.0), 0.0, math.cos(yaw / 2.0)]


class EnvSceneStateExporter:
    """Callable ``SceneStateProvider`` over a live :class:`SimForgeEnv`.

    Each call returns the documents recorded since the previous call — in
    practice one, describing the current observation instant. The renderer
    replaces its resident chunk with it, so the next rendered frame shows the
    world the policy's last action produced.

    Actors whose row is not ``present`` are skipped (and despawned once), so a
    scenario that spawns traffic mid-episode renders it from the tick it
    appears. Nothing is invented: dims come from the engine's actor table and
    poses from ``actors()``.
    """

    def __init__(
        self,
        env: Any,
        *,
        map_id: str | None = None,
        tick_hz: float | None = None,
        ground_y: float = 0.0,
        weather: Mapping[str, Any] | None = None,
        time_of_day: float | None = None,
        catalog_by_kind: Mapping[str, str] | None = None,
        catalog_by_id: Mapping[str, str] | None = None,
        actor_class_by_kind: Mapping[str, str] | None = None,
    ) -> None:
        self.env = env
        episode = getattr(env, "episode", None)
        self.map_id = map_id or getattr(episode, "map_id", None) or "synthetic"
        self.tick_hz = float(tick_hz if tick_hz is not None else ENGINE_HZ)
        self.ground_y = float(ground_y)
        self.weather = dict(weather) if weather else None
        self.time_of_day = time_of_day
        self.catalog_by_kind = {**CATALOG_BY_KIND, **dict(catalog_by_kind or {})}
        self.catalog_by_id = dict(catalog_by_id or {})
        self.actor_class_by_kind = {**ACTOR_CLASS_BY_KIND, **dict(actor_class_by_kind or {})}
        self._spawned: set[str] = set()

    # ---------------------------------------------------------------- catalog

    def _catalog_id(self, actor_id: str, kind: str) -> str:
        return self.catalog_by_id.get(actor_id) or self.catalog_by_kind.get(kind, DEFAULT_CATALOG_ID)

    def _actor_class(self, kind: str) -> str:
        return self.actor_class_by_kind.get(kind, DEFAULT_ACTOR_CLASS)

    # ----------------------------------------------------------------- export

    def document(self) -> dict[str, Any]:
        """One ``LoadSceneState`` document for the current observation instant."""
        session = self.env.native
        rows = session.actors()
        present = session.present()
        ids: Sequence[str] = session.actor_ids
        kinds: Sequence[str] = session.actor_kinds
        dims = session.actor_dims
        t_s = float(session.ego_pose()[0])
        tick = int(round(t_s * self.tick_hz))

        actors: list[dict[str, Any]] = []
        live: set[str] = set()
        for index, actor_id in enumerate(ids):
            if not bool(present[index]):
                continue
            live.add(actor_id)
            x, y, heading, speed = (float(rows[index][0]), float(rows[index][1]), float(rows[index][2]), float(rows[index][3]))
            kind = str(kinds[index])
            first = actor_id not in self._spawned
            actor: dict[str, Any] = {
                "id": actor_id,
                "kind": "spawn" if first else "update",
                "transform": {
                    # scene = (x, z, -y); planar road actors sit at z = 0.
                    "position": [x, self.ground_y, -y],
                    "rotation": yaw_to_quaternion(heading),
                },
                "velocity": [speed * math.cos(heading), 0.0, -speed * math.sin(heading)],
            }
            if first:
                actor["catalogId"] = self._catalog_id(actor_id, kind)
                actor["actorClass"] = self._actor_class(kind)
                actor["dims"] = {"l": float(dims[index][0]), "w": float(dims[index][1]), "h": float(dims[index][2])}
                self._spawned.add(actor_id)
            actors.append(actor)

        for gone in sorted(self._spawned - live):
            actors.append({"id": gone, "kind": "despawn", "transform": {"position": [0.0, self.ground_y, 0.0]}})
            self._spawned.discard(gone)

        document: dict[str, Any] = {
            "version": SCENE_STATE_VERSION,
            "mapId": self.map_id,
            "tick": tick,
            "tickHz": self.tick_hz,
            "weather": self.weather,
            "timeOfDay": self.time_of_day,
            "groundY": self.ground_y,
            "actors": actors,
        }
        return document

    def __call__(self) -> list[dict[str, Any]]:
        return [self.document()]

    def reset(self) -> None:
        """Forget spawn history; the next document re-spawns every actor."""
        self._spawned.clear()


def make_env_scene_state_provider(env: Any, **options: Any) -> EnvSceneStateExporter:
    """Default ``sceneState`` factory for a Bevy rig over a live episode."""
    return EnvSceneStateExporter(env, **options)
