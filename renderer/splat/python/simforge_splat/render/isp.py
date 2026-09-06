"""Per-camera image-formation post-processing carried by the NuRec package
(`.post_processings.0.ppisp.{vignetting_params[C,3,5], crf_params[C,3,7]}`).

At novel viewpoints NRE's service applies only the per-camera terms (vignetting, camera response
curve); the per-frame exposure/color terms are indexed by recorded frame and are skipped
(frame_idx = -1). This module evaluates the same parameterization:

- vignetting: v = clamp(1 + a1 r² + a2 r⁴ + a3 r⁶, 0, 1), r² = |xy_norm − c|², xy_norm = pixel/(W−1, H−1)
- CRF: piecewise power function per channel with raw params
  [x0_offset, y0, y1_fract, toe_length, shoulder_length, shoulder_overshoot, gamma]
  (softplus/sigmoid activations), toe power curve → gamma line → shoulder power curve → 1.
"""
from __future__ import annotations

import torch
import torch.nn.functional as F

EPS = 1e-6


def vignetting(rgb: torch.Tensor, params: torch.Tensor) -> torch.Tensor:
    """rgb [H,W,3] in [0,1]; params [3,5] = per channel [cx, cy, a1, a2, a3]."""
    H, W, _ = rgb.shape
    ys = torch.arange(H, device=rgb.device, dtype=torch.float32) / max(H - 1, 1)
    xs = torch.arange(W, device=rgb.device, dtype=torch.float32) / max(W - 1, 1)
    yy, xx = torch.meshgrid(ys, xs, indexing="ij")
    out = torch.empty_like(rgb)
    for c in range(3):
        cx, cy, a1, a2, a3 = params[c].tolist()
        r2 = (xx - cx) ** 2 + (yy - cy) ** 2
        v = (1.0 + a1 * r2 + a2 * r2**2 + a3 * r2**3).clamp(0.0, 1.0)
        out[..., c] = rgb[..., c] * v
    return out


def _crf_curve(raw: torch.Tensor) -> dict[str, torch.Tensor]:
    x0_offset = F.softplus(raw[0])
    y0 = torch.sigmoid(raw[1])
    y1_fract = torch.sigmoid(raw[2])
    toe_length = F.softplus(raw[3])
    shoulder_length = F.softplus(raw[4])
    shoulder_overshoot = F.softplus(raw[5])
    gamma = F.softplus(raw[6]).clamp(min=0.1)
    x0 = x0_offset * (1.0 + toe_length)
    slope_p0 = y0 / x0_offset
    y0_pre = y0.pow(1.0 / gamma)
    slope_line = slope_p0 / (gamma * y0_pre.pow(gamma - 1.0))
    y1 = y0 + (1.0 - y0) * y1_fract
    y1_pre = y1.pow(1.0 / gamma)
    x1 = x0 + (y1_pre - y0_pre) / slope_line
    slope_p1 = gamma * slope_line * y1_pre.pow(gamma - 1.0)
    shoulder_y = 1.0 + (1.0 - y1) * shoulder_overshoot
    shoulder_x = x1 + (shoulder_y - y1) / slope_p1 * (1.0 + shoulder_length)
    return dict(x0=x0, y0=y0, slope_p0=slope_p0, y0_pre=y0_pre, slope_line=slope_line, gamma=gamma, x1=x1, y1=y1, slope_p1=slope_p1, shoulder_x=shoulder_x, shoulder_y=shoulder_y)


def _pow_through(x0, y0, m):
    b = (m * x0) / y0
    ln_a = torch.log(y0.clamp(min=EPS)) - b * torch.log(x0.clamp(min=EPS))
    return ln_a, b


def crf_channel(x: torch.Tensor, raw: torch.Tensor) -> torch.Tensor:
    c = _crf_curve(raw)
    ln_a_toe, b_toe = _pow_through(c["x0"], c["y0"], c["slope_p0"])
    xs = x.clamp(min=EPS)
    toe = torch.exp(ln_a_toe + b_toe * torch.log(xs))
    mid = (c["y0_pre"] + c["slope_line"] * (x - c["x0"])).clamp(min=EPS).pow(c["gamma"])
    ln_a_sh, b_sh = _pow_through(c["shoulder_x"] - c["x1"], c["shoulder_y"] - c["y1"], c["slope_p1"])
    sh = (c["shoulder_y"] - torch.exp(ln_a_sh + b_sh * torch.log((c["shoulder_x"] - x).clamp(min=EPS)))).clamp(max=1.0)
    y = torch.zeros_like(x)
    y = torch.where((x >= 0) & (x < c["x0"]), toe, y)
    y = torch.where((x >= c["x0"]) & (x < c["x1"]), mid, y)
    y = torch.where((x >= c["x1"]) & (x < c["shoulder_x"]), sh, y)
    y = torch.where(x >= c["shoulder_x"], torch.ones_like(x), y)
    return y


def crf(rgb: torch.Tensor, params: torch.Tensor) -> torch.Tensor:
    """rgb [...,3]; params [3,7] raw per channel."""
    return torch.stack([crf_channel(rgb[..., c], params[c]) for c in range(3)], dim=-1)


def apply_camera_isp(rgb: torch.Tensor, vig_params: torch.Tensor | None, crf_params: torch.Tensor | None) -> torch.Tensor:
    if vig_params is not None:
        rgb = vignetting(rgb, vig_params)
    if crf_params is not None:
        rgb = crf(rgb, crf_params)
    return rgb.clamp(0.0, 1.0)
