# Camera profiles (`camera.profile`)

The dash-cam camera model (`render-core/src/camera_model.rs`) can imitate
different real cameras. A camera profile is a preset-like bundle of existing
render-config keys:

- `camera.exposure.compensationEv`, `metering`, `trim`
- `camera.wdr.whiteStops`, `midGrey`
- `grading.contrast`, `grading.postSaturation`
- `lens.vignette`

A render selects one with `render.set: {"camera.profile": "<profile>"}`. The
bundle is applied under every explicit override, in any key order, so an
explicit `lens.vignette` still wins. The resolved config records
`camera.profile` as provenance, the same way it records `preset`. A profile
changes no geometry, lighting or sensor model, only the camera.

## Profiles

| Key | `automotive` (default) | `consumer-dashcam` |
|---|---|---|
| `camera.exposure.compensationEv` | −1.1 | −1.3 |
| `camera.exposure.metering` | `average` | `dashcam` |
| `camera.exposure.trim` | 0.15 | 0.11 |
| `camera.wdr.whiteStops` | 5.5 | 6.4 |
| `camera.wdr.midGrey` | 0.12 | 0.232 |
| `grading.contrast` | 1.0 | 1.38 |
| `grading.postSaturation` | 0.6 | 0.46 |
| `lens.vignette` | 0.3 | 0.8 |

### `automotive`

`automotive` is the presets' own calibration: an automotive front camera,
calibrated against real automotive front-camera footage (internal dataset; results not published). It is what every render gets unless it sets another profile
(native-render-gpu-profile.md, "Dash-cam calibration defaults").

### `consumer-dashcam`

**Scope:** calibrated against Waylens-class consumer dash cams (KartaView
contributors). Held-out score 1.83, against 2.10 for `automotive`.

**Fit set.** 23 KartaView photos of the Easterbrook and San Ramon P1 maps.
They were chosen by the CEO comparison's own selection rule (on-lane,
daylight, clear, flat projection, 60 m farthest-point sampling). Every CEO
comparison photo was held out: each fit photo is at least 60 m from every CEO
photo.

- Devices: mostly Waylens (andy88), plus joeybab3's and lemba's cameras.
- Poses and render jobs come from the comparison's own `pose.py` and
  `make_jobs.py`, with the Waylens FOV fixed at the comparison's pick (95°).

**Search.**

- The engine's pre-exposure HDR frames go through the offline camera model
  (`dashcam-ref/tools/isp.py`, a port of `camera_model`).
- Each frame is scored against its photo with the comparison's metric code
  (`score.py`: refpool-normalised metric distances, calibration group
  weights).
- TPE over the eight keys, with `lens.vignette` capped at 0.8. Stronger
  vignettes scored better only by printing black corners, and that optimum
  was fragile under rounding.
- The values are the median of the 20 best trials, rounded; rounding them
  leaves the score unchanged.

**Held out: the CEO comparison's 8 scored locations, never searched.**

Real `simforge-render` output at each location's scored FOV, scored with the
comparison's metric code and an openly licensed segmenter (EoMT):

| | combined | brightness & shadows | color | haze & depth | sharpness & noise |
|---|---|---|---|---|---|
| `automotive` | 2.10 | 2.23 | 1.01 | 2.20 | 3.14 |
| `consumer-dashcam` | **1.83** | 1.70 | 1.05 | 2.36 | 3.14 |

- The gain is mostly tone: brighter mid-tones and harder contrast.
- Haze is slightly worse, and color is about the same.

**Limits.**

- The fit and test photos share devices, so this profile describes those
  cameras, not consumer dash cams in general.
- KartaView photos are JPEGs with the device's own processing. The profile
  does not add JPEG output (`output` is the consumer's choice).
