"""Canonical policy/action types shared by imported clients and the module CLI.

Model factories import these types here, never from an executable __main__.
"""
from dataclasses import asdict, dataclass
from typing import Protocol
from .observation import PolicyObservation


@dataclass(frozen=True)
class BicycleAction:
    acceleration_mps2: float
    steering_rad: float

    def wire(self) -> dict:
        return {'kind':'bicycle', **asdict(self)}


class DrivingPolicy(Protocol):
    def infer(self, observation: PolicyObservation) -> BicycleAction: ...


class FixedArcPolicy:
    """Explicit deterministic stub, not an autonomous driving model."""
    def __init__(self, steering: float, acceleration: float):
        self.action = BicycleAction(acceleration, steering)

    def infer(self, observation: PolicyObservation) -> BicycleAction:
        return self.action
