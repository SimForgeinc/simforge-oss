//! Which map derivatives a native render reads, and what their absence
//! means (engine.ts `nativeDerivativesRead` / `assertNativeDerivativesDelivered`
//! and the warnings `createRenderEngine` records).
//!
//! The rule is no silent fallbacks, classified exactly as the worker does:
//!
//! | Derivative | Read when | Present but wrong | Absent |
//! |---|---|---|---|
//! | `derived/geometry-lod/` | LOD mode `auto` | error | evidence only (`geometryLod.manifestSha256: null`, full detail) |
//! | `derived/road-decals/manifest.json` | always | error | evidence only (authored decal opacity) |
//! | `derived/texture-density/manifest.json` | `uastc-full` | error | evidence only (full mip chains) |
//! | `derived/luminaires/manifest.json` | always | error | warning `night_luminaires_absent`, at night only |
//! | `textures-full-bc7` GPU blocks | `uastc-full` | load-time transcode | warning `texture_tier_miss` |
//! | `3d/variants` `textures-512-bc7` | `bc7-512` | error | error `native_ml_texture_variant_unavailable` |
//! | `derived/ground/ground-mesh.bin` | always | error (contact gate) | warnings `render_contact_gate_unavailable` + `native_ground_legacy_field` |
//!
//! A derivative the closure lists but the run cannot read is always an
//! error (`native_derivative_not_delivered`): rendering without it would
//! silently drop the decals or upload every mip level.

use serde::Serialize;

use super::error::{PlanError, PlanResult, Warning};
use super::geometry_lod::{self, GeometryLodMode};
use super::map_closure::{MapClosure, MemberSource};
use super::textures::TextureTier;
use super::{residency, road_decals};

pub const LUMINAIRES_MANIFEST: &str = "derived/luminaires/manifest.json";
pub const GROUND_MESH: &str = "derived/ground/ground-mesh.bin";
/// The sun elevation (degrees) at or below which street luminaires light.
pub const LUMINAIRES_ON_ELEVATION_DEG: f64 = -3.0;
/// `SIMFORGE_NATIVE_TEXTURE_RESIDENCY=off` disables per-job residency.
pub const RESIDENCY_ENV: &str = "SIMFORGE_NATIVE_TEXTURE_RESIDENCY";

/// `nativeDerivativesRead`: the single-file derivatives a run reads when the
/// map carries them. Geometry LOD members follow the LOD plan.
pub fn derivatives_read(tier: TextureTier) -> &'static [&'static str] {
    match tier {
        TextureTier::UastcFull => &[
            road_decals::MANIFEST,
            LUMINAIRES_MANIFEST,
            residency::MANIFEST,
        ],
        TextureTier::Bc7_512 => &[road_decals::MANIFEST, LUMINAIRES_MANIFEST],
    }
}

/// `assertNativeDerivativesDelivered`: every derivative the run reads that
/// the closure declares must be readable.
pub fn assert_derivatives_delivered(
    tier: TextureTier,
    declared: impl Fn(&str) -> bool,
    delivered: impl Fn(&str) -> bool,
) -> PlanResult<()> {
    for uri in derivatives_read(tier) {
        if declared(uri) && !delivered(uri) {
            return Err(PlanError::message(
                "native_derivative_not_delivered",
                format!("the intent declares {uri} but the job's inputs do not carry it"),
            ));
        }
    }
    Ok(())
}

/// The CLI form: the installed closure declares a derivative in its receipt;
/// it is delivered when the file is on disk.
pub fn assert_closure_derivatives(tier: TextureTier, closure: &MapClosure) -> PlanResult<()> {
    assert_derivatives_delivered(
        tier,
        |uri| closure.member(uri).is_some(),
        |uri| closure.path(uri).is_some_and(|p| p.is_file()),
    )
    .map_err(|e| {
        PlanError::message(
            e.code,
            e.message
                .replace("the intent declares", "the map receipt lists")
                .replace(
                    "the job's inputs do not carry it",
                    "the file is missing from the installed map",
                ),
        )
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivativeStatus {
    pub name: &'static str,
    pub member: &'static str,
    /// Whether this run reads it (tier, LOD mode).
    pub read: bool,
    pub present: bool,
    pub sha256: Option<String>,
    /// What the run does without it.
    pub when_absent: &'static str,
}

/// Every derivative the render path knows, with presence and consequence
/// (for the run's evidence and `doctor`-style reporting).
pub fn survey(
    closure: &dyn MemberSource,
    tier: TextureTier,
    lod: GeometryLodMode,
) -> Vec<DerivativeStatus> {
    let status = |name, member: &'static str, read: bool, when_absent| {
        let sha256 = closure.sha256(member).map(str::to_owned);
        DerivativeStatus {
            name,
            member,
            read,
            present: sha256.is_some(),
            sha256,
            when_absent,
        }
    };
    let full_variant = if closure
        .sha256("derived/textures-full-bc7/manifest.json")
        .is_some()
    {
        "derived/textures-full-bc7/manifest.json"
    } else {
        "3d/variants/manifest.json"
    };
    vec![
        status(
            "geometry-lod",
            geometry_lod::MANIFEST,
            lod == GeometryLodMode::Auto,
            "evidence: full detail",
        ),
        status(
            "road-decals",
            road_decals::MANIFEST,
            true,
            "evidence: authored decal opacity",
        ),
        status(
            "texture-density",
            residency::MANIFEST,
            tier == TextureTier::UastcFull,
            "evidence: full mip chains",
        ),
        status(
            "luminaires",
            LUMINAIRES_MANIFEST,
            true,
            "warning night_luminaires_absent (night only)",
        ),
        status(
            "ground",
            GROUND_MESH,
            true,
            "warnings render_contact_gate_unavailable, native_ground_legacy_field",
        ),
        status(
            "texture-variants",
            full_variant,
            true,
            match tier {
                TextureTier::UastcFull => "warning texture_tier_miss (UASTC transcodes at load)",
                TextureTier::Bc7_512 => "error native_ml_texture_variant_unavailable",
            },
        ),
    ]
}

/// The residency switch: `Some(warning)` when the environment turns
/// per-job residency off (the run must say so).
pub fn residency_disabled() -> Option<Warning> {
    (std::env::var(RESIDENCY_ENV).as_deref() == Ok("off")).then(|| Warning {
        code: "texture_residency_disabled",
        message: format!("{RESIDENCY_ENV}=off: every texture uploads its full mip chain"),
    })
}

/// The warnings a map without its ground derivative carries.
pub fn ground_absent_warnings() -> [Warning; 2] {
    [
        Warning {
            code: "render_contact_gate_unavailable",
            message: format!("the map closure carries no {GROUND_MESH}; wheel contact was not checked (a map version published before its ground derivative)"),
        },
        Warning {
            code: "native_ground_legacy_field",
            message: format!("the map closure carries no {GROUND_MESH}; heights for actors without one come from the renderer's legacy mesh field (a map version published before its ground derivative)"),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::testing::FakeSource;

    #[test]
    fn reads_the_density_manifest_only_at_uastc_full() {
        assert_eq!(
            derivatives_read(TextureTier::UastcFull),
            [
                road_decals::MANIFEST,
                LUMINAIRES_MANIFEST,
                residency::MANIFEST
            ]
        );
        assert_eq!(
            derivatives_read(TextureTier::Bc7_512),
            [road_decals::MANIFEST, LUMINAIRES_MANIFEST]
        );
    }

    #[test]
    fn refuses_a_run_without_a_declared_derivative() {
        let declared = |uri: &str| uri != LUMINAIRES_MANIFEST;
        assert!(assert_derivatives_delivered(TextureTier::UastcFull, declared, |_| true).is_ok());
        let without_density = |uri: &str| uri != residency::MANIFEST;
        let error = assert_derivatives_delivered(TextureTier::UastcFull, declared, without_density)
            .unwrap_err();
        assert_eq!(error.code, "native_derivative_not_delivered");
        // The density manifest is read only at uastc-full.
        assert!(
            assert_derivatives_delivered(TextureTier::Bc7_512, declared, without_density).is_ok()
        );
    }

    #[test]
    fn surveys_presence_and_consequence() {
        let source = FakeSource::default().file(road_decals::MANIFEST, &"c".repeat(64), "{}");
        let survey = survey(&source, TextureTier::Bc7_512, GeometryLodMode::Off);
        let decals = survey.iter().find(|s| s.name == "road-decals").unwrap();
        assert!(decals.present && decals.read);
        let lod = survey.iter().find(|s| s.name == "geometry-lod").unwrap();
        assert!(!lod.present && !lod.read);
        assert!(
            !survey
                .iter()
                .find(|s| s.name == "texture-density")
                .unwrap()
                .read
        );
    }
}
