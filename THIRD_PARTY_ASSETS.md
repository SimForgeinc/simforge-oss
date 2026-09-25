# Third-party asset ledger

This ledger covers third-party content the SDK carries or fetches. Map bundles
keep their upstream provenance and are not redistributed by this repository.
Large binary assets are not in git: each pack is a content-addressed closure
(`catalog/<pack>/closure.json`, pinned in `catalog/closures.lock.json`), and
`simforge assets pull` fetches the actor closure and verifies every blob. The
per-file attribution travels in each pack's `ATTRIBUTION.json`.

| Asset | Attribution record | License | Notes |
|---|---|---|---|
| CARLA vehicle models | `catalog/vehicles-carla/ATTRIBUTION.json` | CC BY 4.0 | Extracted from the CARLA 0.10.0 UE5 distribution and re-authored as glTF 2.0 (`catalog/vehicles-carla/CONVENTIONS.md`). |
| CARLA pedestrian models and animations | `catalog/pedestrians-carla/ATTRIBUTION.json` | CC BY 4.0 | Converted to glTF 2.0 (`catalog/pedestrians-carla/CONVENTIONS.md`). |
| Sky plates (star map, Moon) | `catalog/sky/ATTRIBUTION.json` | Public domain (NASA SVS) | Materialised by `renderer/tools/prepare_sky.py` from the pins in `renderer/render-core/assets/sky/SOURCES.json` (converted by `renderer/tools/prepare_sky_assets.py`); the plates are derivatives and are not committed. |
| Elementary math functions (V8 / fdlibm) | `native/crates/simforge-core/THIRD_PARTY_NOTICES`, `adapters/gym/simforge_oss_gym/THIRD_PARTY_NOTICES` | BSD-3-Clause / fdlibm notice | Source code adapted in `simforge-core/src/math/ieee754.rs`. |
| Vendored Bevy 0.19.1 crates | `renderer/vendor/*/LICENSE-APACHE`, `LICENSE-MIT` | MIT / Apache-2.0 | Patched copies; the deviations are listed in the root `Cargo.toml` and each crate's README. |

Any new third-party pack must record its canonical URL, author, exact license,
version and per-file SHA-256 in its `ATTRIBUTION.json` and closure before it
is added to `catalog/closures.lock.json`.
