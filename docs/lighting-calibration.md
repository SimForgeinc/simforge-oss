# Lighting calibration

This is the single source of truth for outdoor lighting in SimForge. The
renderer implements it in `renderer/render-core/src/calibration.rs` (with
`lighting.rs` and `weather.rs`), and cites this document. Any other renderer
that draws SimForge scenes (for example the hosted app's browser viewer)
implements the same spec; a change here changes the spec for all of them.

## Sun model

| Quantity | Value | Rationale |
|---|---|---|
| Extraterrestrial illuminance `E_ext` | 128 000 lx | Solar illuminance constant above the atmosphere (≈128 klx) |
| Clear-sky transmittance `T` | 0.7 | Meinel/Laue clear-atmosphere model |
| Air mass `m(h)` | `1 / (sin h + 0.50572·(h° + 6.07995)^-1.6364)` | Kasten–Young (1989); finite at the horizon |
| Direct-normal illuminance `E_dn(h)` | `E_ext · T^(m(h)^0.678)` | Meinel; ≈89.6 klx at zenith, ≈83 klx at 60°, ≈1.5 klx at 4° |
| Twilight ramp | linear 1→0 from `h = 0°` to `h = −6°` | civil twilight: the scene darkens smoothly after sunset, not at it |
| Sun colour temperature `CCT(h)` | `2500 K + 3000 K · clamp(h/30°, 0, 1)` | 5 500 K high sun → 2 500 K at the horizon; blackbody → RGB via the Tanner-Helland approximation (`kelvin_to_rgb`) |
| Sun angular diameter | 0.53° | drives PCSS penumbra width |

`h` is sun elevation above the horizon in degrees. Directional-light intensity
is `E_dn(h)` (lux on a surface perpendicular to the sun), NOT a flat
100 klx — dusk scenes must darken through the model, never through an
ad-hoc multiplier.

## Sky / IBL

| Quantity | Value | Rationale |
|---|---|---|
| HDRI normalisation `HDRI_TO_CDM2` | 20 000 cd/m² per luma unit | Map HDRIs are normalised (mean sky luma ≈ 1.26); 20 000 restores physical sky luminance (measured, see `renderer/render-core/src/weather.rs`) |
| Clear-day sky diffuse target | 10–25 klx on horizontal | WMO/CIE clear-day band |
| Shadowed/sunlit ratio target | 0.15–0.25 (linear) on horizontal surfaces | the calibration acceptance band; below it shadows crush, above it the scene washes out |
| Sky brightness vs elevation | scales with `daylight(h) = E_dn(h)·max(sin h, 0) / (E_dn(60°)·sin 60°)`, floored at 0.004 | dusk sky dims with the sun; 0.004 is the measured lit-street/night floor |

When a scene ships no HDRI, it must still be sky-lit: the renderer generates
a deterministic analytic gradient cubemap (`lighting::synthetic_sky_cubemap`)
normalised to the same ≈1.26 mean sky luma, so `HDRI_TO_CDM2` applies
unchanged.

## Exposure (EV100)

Incident-light convention: `EV100 = log2(E_lx / 2.5)` (ISO 100, C = 250).

| Condition | Fixed EV100 | Check |
|---|---|---|
| Clear day, sun ≥ 30° | 15 | sunny-16: log2(100 000 / 2.5) ≈ 15.3 |
| Fog / overcast | 14 | |
| Rain | 13.5 | |
| Night (lit street) | 9 | |
| Clear, low sun (dusk) | `clamp(15 + log2(E_dh(h)/E_dh(60°)), 9, 15)` | tracks the sun model; ≈9–12 through golden hour |

`E_dh(h) = E_dn(h)·sin h` is direct horizontal illuminance. The **sensor**
profile always uses fixed EV100 (deterministic, hash-stable). The
**cinematic** profile uses the same fixed value until real frame pacing makes
auto-exposure deterministic (see `renderer/render-core/src/profiles.rs`).

## Tonemap

| Output | Tonemap |
|---|---|
| Human-facing (viewer, cinematic profile) | **AgX**, exposure per table above |
| Machine-vision (sensor profile) | none — linear output, fixed EV100 |

## Materials (clamp policy)

Surface styling must never destroy authored material response: no roughness
floors over the authored value, and environment-map intensity stays at 1.0
unless a user-facing multiplier changes it. Styling may blend toward a target
(`lerp(authored, target, mix)`, `mix ≤ 0.6`), and classified ground surfaces
(asphalt, grass, concrete, curb) may cap metalness at 0.04, which is physics,
not styling.
