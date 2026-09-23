"""A visible-object DeepSets PPO teacher with one shared checkpoint contract.

Only ego motion and LOS-gated objects reach the network. World position,
world heading, route-s and the privileged native nearest-range slot are not
inputs. Setpoints intentionally delegate lateral guidance to the native route
follower; this is not the proposed pixels-to-controls student.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.distributions import Normal


from .store import register
FORMAT = 'simforge.ppo-teacher/v1'
OBS_PRESET = 'ego-motion+visible-objects-v1'
ACTION_HEAD = 'setpoint-speed0-14-accel-6-3'


def observations(state: np.ndarray, objects: np.ndarray, device: torch.device | str) -> tuple[torch.Tensor, torch.Tensor]:
    return (torch.as_tensor(state, dtype=torch.float32, device=device), torch.as_tensor(objects, dtype=torch.float32, device=device))


class Teacher(nn.Module):
    def __init__(self, hidden: int = 1024) -> None:
        super().__init__()
        self.hidden = hidden
        self.objects = nn.Sequential(nn.Linear(4, 64), nn.Tanh(), nn.Linear(64, 64), nn.Tanh())
        self.trunk = nn.Sequential(nn.Linear(134, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh())
        self.actor = nn.Sequential(nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, 2))
        self.critic = nn.Sequential(nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, 1))
        self.log_std = nn.Parameter(torch.full((2,), -0.7))
        self.register_buffer('action_mid', torch.tensor([7.0, -1.5]))
        self.register_buffer('action_half', torch.tensor([7.0, 4.5]))
        # Only the output heads need a small initialization. Dense orthogonal
        # decompositions of ~6M parameters add startup time without changing PPO.
        nn.init.normal_(self.actor[-1].weight, std=0.01)
        nn.init.zeros_(self.actor[-1].bias)

    def features(self, state: torch.Tensor, objects: torch.Tensor) -> torch.Tensor:
        visible = (objects[..., 3] > 0.5) & (objects[..., 4] > 0.5)
        r = objects[..., 0]
        bearing = objects[..., 1]
        inputs = torch.stack((r / 60.0, bearing.sin(), bearing.cos(), objects[..., 2] / 15.0), dim=-1)
        # Mask before embedding too: invisible NaN/outlier values must not leak.
        inputs = torch.where(visible[..., None], inputs, torch.zeros_like(inputs)).clamp(-10.0, 10.0)
        embedded = self.objects(inputs)
        masked = embedded * visible[..., None]
        count = visible.sum(-1, keepdim=True)
        mean = masked.sum(-2) / count.clamp_min(1)
        maximum = embedded.masked_fill(~visible[..., None], -1e6).amax(-2)
        maximum = torch.where(count > 0, maximum, torch.zeros_like(maximum))
        nearest = torch.where(visible, r, torch.full_like(r, 60.0)).amin(-1, keepdim=True).clamp(0, 60) / 60.0
        ego = torch.cat((state[..., 4:5] / 15.0, state[..., 5:6] / 5.0, state[..., 6:8] / 3.0, nearest, count / objects.shape[-2]), dim=-1).clamp(-10, 10)
        return self.trunk(torch.cat((ego, mean, maximum), dim=-1))

    def distribution_value(self, state: torch.Tensor, objects: torch.Tensor) -> tuple[Normal, torch.Tensor]:
        features = self.features(state, objects)
        mean = self.actor(features)
        return Normal(mean, self.log_std.clamp(-3.0, 1.0).exp().expand_as(mean)), self.critic(features).squeeze(-1)

    def setpoints(self, raw: torch.Tensor) -> torch.Tensor:
        return self.action_mid + self.action_half * raw.tanh()

    def deterministic(self, state: torch.Tensor, objects: torch.Tensor) -> torch.Tensor:
        return self.setpoints(self.actor(self.features(state, objects)))


def save_checkpoint(path: Path, model: Teacher, optimizer: torch.optim.Optimizer, metadata: dict[str, Any]) -> dict[str, Any]:
    payload = {'format': FORMAT, 'obs_preset': OBS_PRESET, 'action_head': ACTION_HEAD, 'hidden': model.hidden, 'model': model.state_dict(), 'optimizer': optimizer.state_dict(), 'metadata': metadata, 'torch_rng': torch.get_rng_state()}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.partial')
    torch.save(payload, temporary)
    temporary.replace(path)
    entry = register(path, recipe='ppo-teacher', obs_preset='visible', action_head='setpoint', metadata=metadata)
    receipt = {'format': FORMAT, **entry, 'checkpoint': path.name, 'obs_preset': OBS_PRESET, 'action_head': ACTION_HEAD, **metadata}
    path.with_suffix('.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def load_checkpoint(path: str | Path, device: str | torch.device = 'cpu') -> tuple[Teacher, dict[str, Any]]:
    payload = torch.load(path, map_location=device, weights_only=True)
    if payload.get('format') != FORMAT or payload.get('obs_preset') != OBS_PRESET or payload.get('action_head') != ACTION_HEAD:
        raise ValueError('unsupported teacher checkpoint format, observation preset, or action head')
    model = Teacher(payload['hidden']).to(device)
    model.load_state_dict(payload['model'], strict=True)
    model.eval()
    return model, payload
