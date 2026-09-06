"""Explicit execution profiles of the one public SDK.

Each profile names a backend with its own provider, capability claims and
install extra. Selecting a profile whose provider is not installed raises
``ProfileUnavailableError`` naming the extra; nothing falls back to another
backend. Documents a profile cannot execute are rejected by that profile's own
admission (``ProfileAdmissionError`` for the GPU batch, schema/engine errors
for the native core, ``BackendCapabilityError`` for MuJoCo Warp).

| profile                    | backend                              | extra                 |
|----------------------------|--------------------------------------|-----------------------|
| ``roadway-native``         | Rust core in-process (this wheel)    | none                  |
| ``roadway-dynamic-gpu-v1`` | Warp/CUDA device batch               | ``gpu``               |
| ``articulated-mujoco-v1``  | MuJoCo CPU / MuJoCo Warp             | ``articulated[-warp]``|
| sensor observations        | NuRec in-process tensor renderer     | ``nurec``             |
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import gymnasium as gym
from gymnasium.vector import VectorEnv

ProfileId = Literal["roadway-native", "roadway-dynamic-gpu-v1", "articulated-mujoco-v1"]

ROADWAY_NATIVE: ProfileId = "roadway-native"
ROADWAY_GPU: ProfileId = "roadway-dynamic-gpu-v1"
ARTICULATED: ProfileId = "articulated-mujoco-v1"


class ProfileUnavailableError(ImportError):
    """The selected profile's provider is not installed."""


@dataclass(frozen=True)
class ProfileInfo:
    id: ProfileId
    extra: str | None
    description: str
    vector_only: bool = False


PROFILES: dict[str, ProfileInfo] = {
    ROADWAY_NATIVE: ProfileInfo(ROADWAY_NATIVE, None, "Rust engine in-process: planar roadway scenarios, single and CPU-parallel vector worlds."),
    ROADWAY_GPU: ProfileInfo(ROADWAY_GPU, "gpu", "Warp/CUDA device batch of one admitted roadway document; torch tensors on device.", vector_only=True),
    ARTICULATED: ProfileInfo(ARTICULATED, "articulated", "MuJoCo delivery-robot curb/ramp workload; CPU single env, MuJoCo Warp vector env (`articulated-warp`)."),
}


def _require(profile: str) -> ProfileInfo:
    info = PROFILES.get(profile)
    if info is None:
        raise ValueError(f"unknown profile {profile!r}; known: {sorted(PROFILES)}")
    return info


def _import(info: ProfileInfo, module: str) -> Any:
    import importlib

    try:
        return importlib.import_module(module)
    except ImportError as error:
        extra = f"`pip install simforge-oss-gym[{info.extra}]`" if info.extra else "the native extension"
        raise ProfileUnavailableError(f"profile {info.id!r} needs {extra}: {error}") from error


def make_env(profile: str = ROADWAY_NATIVE, /, **kwargs: Any) -> gym.Env:
    """Single-world environment for ``profile``; kwargs go to the profile's class."""
    info = _require(profile)
    if info.vector_only:
        raise ValueError(f"profile {profile!r} is batch-only; use make_vector_env")
    if info.id == ROADWAY_NATIVE:
        return _import(info, "simforge_oss_gym.env").SimForgeEnv(**kwargs)
    return _import(info, "simforge_oss_gym.articulated").ArticulatedEnv(**kwargs)


def make_vector_env(profile: str = ROADWAY_NATIVE, /, **kwargs: Any) -> VectorEnv:
    """Vector environment for ``profile``; kwargs go to the profile's class."""
    info = _require(profile)
    if info.id == ROADWAY_NATIVE:
        return _import(info, "simforge_oss_gym.vector").SimForgeVectorEnv(**kwargs)
    if info.id == ROADWAY_GPU:
        return _import(info, "simforge_oss_gym.gpu").SimForgeGpuVectorEnv(**kwargs)
    return _import(info, "simforge_oss_gym.articulated").ArticulatedVectorEnv(**kwargs)


def available_profiles() -> dict[str, bool]:
    """Which profiles can be constructed in this interpreter (provider importable)."""
    import importlib.util

    providers = {ROADWAY_NATIVE: "simforge_oss_gym._native", ROADWAY_GPU: "simforge_oss_gpu", ARTICULATED: "simforge_oss_physics"}
    return {profile: importlib.util.find_spec(module) is not None for profile, module in providers.items()}
