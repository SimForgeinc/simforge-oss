"""ResNet18 + 256-GRU pixels/motion/navigation to bounded vehicle controls."""
from __future__ import annotations

import numpy as np
import torch
from PIL import Image
from torch import nn
from torchvision.models import ResNet18_Weights, resnet18

FORMAT = 'simforge.distill-student/v1'
OBS_PRESET = 'cams:student-front'
SIZE = (640, 360)


class Student(nn.Module):
    def __init__(self, *, imagenet: bool = True):
        super().__init__()
        backbone = resnet18(weights=ResNet18_Weights.IMAGENET1K_V1 if imagenet else None)
        backbone.fc = nn.Identity()
        self.visual = backbone
        self.gru = nn.GRU(512 + 2 + 16, 256, batch_first=True)
        self.control = nn.Linear(256, 2)

    def forward(self, rgb: torch.Tensor, motion: torch.Tensor, navigation: torch.Tensor, hidden=None):
        batch, steps = rgb.shape[:2]
        visual = self.visual(rgb.flatten(0, 1)).reshape(batch, steps, 512)
        features = torch.cat((visual, motion / motion.new_tensor([15.0, 1.0]), navigation.flatten(-2) / 40.0), dim=-1)
        recurrent, hidden = self.gru(features, hidden)
        return self.control(recurrent).tanh(), hidden


def image_tensor(image: Image.Image) -> torch.Tensor:
    array = np.array(image.convert('RGB').resize(SIZE, Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
    array = (array - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    return torch.from_numpy(array.transpose(2, 0, 1).copy())


def navigation(points, pose) -> np.ndarray:
    points = np.asarray(points, dtype=np.float64)
    if points.ndim != 2 or points.shape[0] < 2 or points.shape[1] < 2 or not np.isfinite(points).all():
        raise ValueError('student requires at least two real route points')
    points = points[:, :2] - np.asarray([pose['x'], pose['y']])
    c, s = np.cos(pose['yawRad']), np.sin(pose['yawRad'])
    local = points @ np.asarray([[c, -s], [s, c]])
    arc = np.concatenate(([0.0], np.cumsum(np.linalg.norm(np.diff(local, axis=0), axis=1))))
    targets = np.arange(1, 9) * 5.0
    return np.column_stack([np.interp(targets, arc, local[:, i]) for i in range(2)]).astype(np.float32)


def load_student(path, device='cpu'):
    payload = torch.load(path, map_location=device, weights_only=True)
    if payload.get('format') != FORMAT or payload.get('obs_preset') != OBS_PRESET or payload.get('action_head') != 'control':
        raise ValueError('unsupported camera student checkpoint contract')
    model = Student(imagenet=False).to(device)
    model.load_state_dict(payload['model'], strict=True)
    model.eval()
    return model, payload
