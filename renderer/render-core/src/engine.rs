//! Reusable headless Bevy rendering engine for SimForge (`native` engine).
//!
//! DefaultPlugins minus Winit/Audio, no primary window, offscreen `Image`
//! render targets. This module exposes a host-controlled [`SceneApp`]: the
//! owner mutates the resident scene (actors, poses, lighting) and then asks
//! for one [`SceneApp::capture`], which renders exactly one iteration and
//! returns the requested passes copied from that iteration's submission
//! under a [`FrameIdentity`]. Rendering and output are separate: an
//! iteration with nothing requested (warmup, asset loading) performs no
//! texture copy and no host map.
//!
//! Determinism contract: MSAA Off, no temporal effects on sensor views,
//! deterministic instance-ID assignment (meshes sorted by name then entity
//! bits), fixed clear color.
//!
//! Lighting/profile routing: the scene is lit by the WSB4 lighting ladder
//! (`crate::lighting::spawn_lighting` — IBL sky, physical sun via the shared
//! spec docs/lighting-calibration.md) and every RGB camera gets its render
//! look from `crate::profiles::RenderProfile::apply` (fixed EV100, the
//! render config's AA/SSAO/SSR/post stack; no auto-exposure).
use anyhow::{anyhow, bail, Context as _, Result};
use bevy::app::ScheduleRunnerPlugin;
use bevy::asset::RecursiveDependencyLoadState;
use crate::readiness::{GpuPending, GPU_IDLE_FRAMES};
use bevy::camera::visibility::RenderLayers;
use bevy::camera::RenderTarget;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::gltf::{Gltf, GltfMaterialName};
use bevy::light::DirectionalLightShadowMap;
use bevy::anti_alias::fxaa::Fxaa;
use bevy::anti_alias::smaa::{Smaa, SmaaPreset};
use bevy::anti_alias::taa::TemporalAntiAliasing;
use bevy::pbr::{DistanceFog, FogFalloff};
use bevy::log::LogPlugin;
use bevy::prelude::*;
use bevy::render::camera::ExtractedCamera;
use bevy::render::render_asset::RenderAssets;
use bevy::asset::RenderAssetUsages;
use bevy::render::render_resource::{
    Buffer, BufferDescriptor, BufferUsages, Extent3d, MapMode, PollType, TexelCopyBufferInfo,
    TexelCopyBufferLayout, TextureDimension, TextureFormat, TextureUsages,
};
use bevy::render::renderer::{RenderContext, RenderDevice, RenderGraph, RenderGraphSystems};
use bevy::render::texture::GpuImage;
use bevy::render::view::ViewDepthTexture;
use bevy::render::{Extract, Render, RenderApp, RenderSystems};
use bevy::window::ExitCondition;
use bevy::world_serialization::{WorldAssetRoot, WorldInstance, WorldInstanceSpawner};
use crate::lighting::{self, LightingRung};
use crate::profiles::{RenderProfile, RenderProfileConfig};
use crate::weather::Weather;
use bevy::mesh::{skinning::SkinnedMesh, Meshable, SphereKind, SphereMeshBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Scene lighting configuration, resolved through the shared lighting spec
/// (docs/lighting-calibration.md) at rung ≥ 2. `sun_lux`/`ambient` are the
/// spike-calibrated legacy values consumed only at rung < 2.
/// Unknown keys are refused: a misspelt or camelCase key would otherwise be
/// dropped and its default rendered instead.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lighting {
    #[serde(default = "default_sun_elev")]
    pub sun_elev_deg: f32,
    #[serde(default = "default_sun_azim")]
    pub sun_azim_deg: f32,
    /// Legacy spike sun illuminance; used only at rung < 2.
    #[serde(default = "default_lux")]
    pub sun_lux: f32,
    /// Legacy spike flat ambient; used only at rung 0.
    #[serde(default = "default_ambient")]
    pub ambient: f32,
    /// Lighting-ladder rung (crate::lighting): 0 spike baseline, 1 IBL,
    /// 2 physical sun/EV100, 3 +GTAO/contact shadows, 4 +PCSS.
    #[serde(default = "default_rung")]
    pub rung: u8,
    /// Weather state feeding the `LightingPlan` (sun/sky scaling + EV100).
    #[serde(default)]
    pub weather: Weather,
    /// Equirectangular HDRI for the sky/IBL. `None` generates the
    /// deterministic analytic sky (`lighting::synthetic_sky_cubemap`).
    #[serde(default)]
    pub sky_hdr: Option<String>,
    /// Multiplier on the resolved direct-sun illuminance. Applies at every
    /// rung (unlike `sun_lux`, which the ladder only honours below rung 2).
    #[serde(default = "unit_scale")]
    pub sun_scale: f32,
    /// Multiplier on the resolved IBL/environment intensity, and on the
    /// rung-0 flat ambient.
    #[serde(default = "unit_scale")]
    pub ambient_scale: f32,
    /// Multiplier on skybox brightness (the visible sky, not the IBL lobe).
    #[serde(default = "unit_scale")]
    pub sky_scale: f32,
    /// Exposure bias in stops added to the resolved fixed EV100. Positive
    /// darkens (EV100 is a stop scale), matching photographic convention
    /// inverted at the camera.
    #[serde(default)]
    pub ev100_bias: f32,
    /// Overrides the elevation-derived sun colour temperature, in kelvin.
    #[serde(default)]
    pub sun_temperature_k: Option<f32>,
    /// Fractional cloud cover in [0, 1]. `None` takes the weather label's
    /// cover. Under the physical atmosphere this scales the cloud deck's
    /// vertical optical depth as `cover^1.5`; on the legacy cubemap path it
    /// is the old sun x (1 - 0.85c) / IBL x (1 + 0.30c) / sky x (1 - 0.35c)
    /// multiplier set.
    #[serde(default)]
    pub cloud_cover: Option<f32>,
    /// Meteorological visibility in metres (Koschmieder). `None` or a value
    /// at/above `FOG_DISABLED_VISIBILITY_M` disables distance fog.
    #[serde(default)]
    pub visibility_m: Option<f32>,
    /// Extra haze in [0, 1]; divides effective visibility by (1 + 3h).
    #[serde(default)]
    pub haze: f32,
    /// Linear-sRGB fog colour override. `None` derives it from the sky.
    /// Legacy `DistanceFog` path only; ignored when `atmosphere` is on.
    #[serde(default)]
    pub fog_color: Option<[f32; 3]>,
    /// Road-surface wetness ramp in [0, 1] (roughness down, base colour
    /// darkened, a little metallic). Reversible: originals are retained.
    #[serde(default)]
    pub wetness: f32,

    // ----------------------------------------------------------- atmosphere
    /// Use the physically based Hillaire-2020 atmosphere
    /// (`crate::atmosphere`) instead of the static sky cubemap.
    ///
    /// On: the visible sky, the sun's colour and attenuation, the IBL and
    /// the distance aerial perspective all come out of one LUT solve, and
    /// `DistanceFog` is not attached (the aerial-perspective LUT already
    /// fogs the scene — attaching both would fog it twice).
    #[serde(default = "default_true")]
    pub atmosphere: bool,
    /// Linke turbidity of the tropospheric aerosol column. `None` takes the
    /// weather label's value. 1.9 = Rayleigh-only, 2.5 typical clear, 6+
    /// heavily polluted.
    #[serde(default)]
    pub turbidity: Option<f32>,
    /// Total column ozone, Dobson units. `None` = 300 (mid-latitude mean).
    #[serde(default)]
    pub ozone_du: Option<f32>,
    /// Rayleigh density multiplier, i.e. surface air density relative to
    /// standard sea level. `None` = 1.0.
    #[serde(default)]
    pub air_density: Option<f32>,
    /// Cloud deck type. `None` takes the weather label's deck.
    #[serde(default)]
    pub cloud_deck: Option<crate::atmosphere::CloudDeck>,
    /// Ground elevation of the scene in world Y, m. The atmosphere entity is
    /// placed `inner_radius` below this, so scene altitude is measured from
    /// it. `None` uses the corpus default and is refined from the scene's
    /// own ground field once tiles are loaded.
    #[serde(default)]
    pub ground_y: Option<f32>,
    /// The camera the meter reads the sky through (world forward, vertical
    /// FOV, aspect). With it, the applied EV never lets the brightest sky
    /// the camera frames — the solar aureole on a sunward shot — rise more
    /// than [`SKY_HIGHLIGHT_STOPS`] above middle grey. `None` meters on
    /// incident light alone.
    #[serde(default)]
    pub meter_view: Option<crate::atmosphere::MeterView>,
    /// `RenderConfig.atmosphere.hazeDensity`, set by the engine from the
    /// render config (not part of the authored lighting).
    #[serde(skip, default = "unit_haze_density")]
    pub haze_density: f32,
    /// UTC/site-resolved celestial, sky, fixture and honest fallback controls.
    #[serde(default)]
    pub night: crate::night::NightControls,
}

/// At or above this visibility, distance fog is not attached at all.
pub const FOG_DISABLED_VISIBILITY_M: f32 = 15_000.0;

/// Camera far plane assumed when the aerial-perspective LUT is sized before
/// any camera has registered. Matches the render service's `default_far`.
pub const DEFAULT_FAR_PLANE_M: f32 = 900.0;

// The Lookdev Lab's canonical hour: 06:25 PDT on day 172 at the corpus
// site, NOAA solar position (`lab/server/settings.py::solar_position`).
fn default_sun_elev() -> f32 {
    5.758
}
fn default_sun_azim() -> f32 {
    115.248
}
fn default_lux() -> f32 {
    12000.0
}
fn default_ambient() -> f32 {
    1.2
}
fn default_rung() -> u8 {
    3
}
fn unit_scale() -> f32 {
    1.0
}

impl Default for Lighting {
    fn default() -> Self {
        Self {
            sun_elev_deg: default_sun_elev(),
            sun_azim_deg: default_sun_azim(),
            sun_lux: default_lux(),
            ambient: default_ambient(),
            rung: default_rung(),
            weather: Weather::default(),
            sky_hdr: None,
            sun_scale: 1.0,
            ambient_scale: 1.0,
            sky_scale: 1.0,
            ev100_bias: 0.0,
            sun_temperature_k: None,
            cloud_cover: None,
            visibility_m: None,
            haze: 0.0,
            fog_color: None,
            wetness: 0.0,
            atmosphere: true,
            turbidity: None,
            ozone_du: None,
            air_density: None,
            cloud_deck: None,
            ground_y: None,
            meter_view: None,
            haze_density: 1.0,
            night: crate::night::NightControls::default(),
        }
    }
}

fn unit_haze_density() -> f32 {
    1.0
}

/// Exactly what the engine ended up with after the weather model, the
/// scale knobs and the cloud-cover layer were applied. Reported back so a
/// lookdev surface can show engine units beside its own normalized ones.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AppliedPhysicalLighting {
    pub applied_grading_exposure_ev: f32,
    /// Camera EV100 every view is exposed at; the same EV for sky, street
    /// and stars.
    pub scene_ev100: f32,
    /// Horizontal illuminance the meter read to reach it, lx: atmosphere
    /// (sun, sky, twilight) plus the night ledger.
    pub meter_illuminance_lx: f32,
    /// The night ledger's share of that reading, lx.
    pub night_ledger_illuminance_lx: f32,
    /// Incident reading with dark adaptation, before the night offset and
    /// bias.
    #[serde(default)]
    pub incident_ev100: f32,
    /// Highlight-priority reading from the framed sky (`atmosphere.view_sky`),
    /// `None` when no metering camera was given. The applied EV is the
    /// larger of the two, plus offset and bias.
    #[serde(default)]
    pub sky_highlight_ev100: Option<f32>,
    pub atmosphere_environment_gain: f32,
    pub global_ambient_enabled: bool,
    pub camera_headlamp_enabled: bool,
    pub atmosphere_sky_pass: bool,
    pub gpu_dark_lut_seed_lx: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolvedLighting {
    /// Directional-light illuminance actually spawned, in lux.
    ///
    /// Under the physical atmosphere this is the **extraterrestrial** value
    /// (~128 klx x `sun_scale`), not the ground-level one: `pbr_lighting.wgsl`
    /// multiplies it by the transmittance LUT. The ground-level number is
    /// `atmosphere.direct_normal_illuminance_lx`.
    pub sun_lux: f32,
    /// Sun colour as linear sRGB. White under the physical atmosphere
    /// unless `sun_temperature_k` overrides it, because the transmittance
    /// LUT is what reddens the beam.
    pub sun_color: [f32; 3],
    /// `EnvironmentMapLight::intensity` in cd/m² on the cubemap path;
    /// the `AtmosphereEnvironmentMapLight` gain (1.0 = physical) on the
    /// atmosphere path.
    pub env_intensity: f32,
    /// `Skybox::brightness` in cd/m². Zero under the physical atmosphere:
    /// there is no skybox.
    pub skybox_brightness: f32,
    /// Fixed `Exposure::ev100` handed to every RGB camera.
    pub ev100: f32,
    /// `FogFalloff::ExponentialSquared` density, when `DistanceFog` is
    /// attached. Always `None` under the physical atmosphere — the
    /// aerial-perspective LUT does this instead.
    pub fog_density: Option<f32>,
    /// Visibility the scene actually has, m.
    pub effective_visibility_m: Option<f32>,
    /// Wetness the road ramp was driven to.
    pub wetness: f32,
    /// Drivable-surface materials the wetness ramp actually reached. Zero
    /// means this map exposes no material the ramp recognises, so the
    /// wetness control is inert here and should say so rather than pretend.
    pub road_materials: u32,
    /// Full atmosphere readback. `None` when running the legacy cubemap sky.
    #[serde(default)]
    pub atmosphere: Option<crate::atmosphere::AtmosphereReadback>,
    /// Controls that are inert in the mode that was actually used, so the
    /// UI can grey them out instead of pretending they do something.
    #[serde(default)]
    pub inert_controls: Vec<String>,
    /// Components and gains actually applied after physical resolution.
    #[serde(default)]
    pub applied_physical: Option<AppliedPhysicalLighting>,
    /// Single resolved night source ledger used by renderer and UI.
    #[serde(default)]
    pub night_environment: Option<crate::night::NightEnvironment>,
    /// Audit of the façade-window fit for this relight.
    #[serde(default)]
    pub facade_windows: Option<crate::facade_windows::FacadeStats>,
}

impl Lighting {
    /// What SceneApp cannot render as declared fails here, before any
    /// relight, instead of being clamped (docs/engineering/no-silent-fallbacks.md).
    pub fn validate_for_scene_app(&self) -> Result<()> {
        if self.rung > 3 {
            bail!("[native_lighting_unsupported] lighting rung {} (4 = PCSS) is not deterministic in SceneApp; use rung <= 3", self.rung);
        }
        let night = &self.night;
        if night.fixture_budget > 12 {
            bail!("[native_lighting_unsupported] night fixture budget {} exceeds the renderer's 12 lights", night.fixture_budget);
        }
        if night.fixture_shadow_budget > 2 {
            bail!("[native_lighting_unsupported] night fixture shadow budget {} exceeds the renderer's 2 shadowed lights", night.fixture_shadow_budget);
        }
        if !(0.0..=0.5).contains(&night.urban_skyglow_lux) {
            bail!("[native_lighting_unsupported] urban skyglow {} lux is outside the calibrated 0..0.5", night.urban_skyglow_lux);
        }
        if !(0.001..=0.003).contains(&night.natural_ambient_lux) {
            bail!("[native_lighting_unsupported] natural night ambient {} lux is outside the calibrated 0.001..0.003", night.natural_ambient_lux);
        }
        for (index, fixture) in night.fixtures.iter().enumerate() {
            let out = |what: &str, value: f32, lo: f32, hi: f32| -> Result<()> {
                if (lo..=hi).contains(&value) {
                    Ok(())
                } else {
                    bail!("[native_lighting_unsupported] night fixture {index} {what} {value} is outside the calibrated {lo}..{hi}")
                }
            };
            out("lumens", fixture.lumens, 2_000.0, 8_000.0)?;
            out("range_m", fixture.range_m, 15.0, 90.0)?;
            out("cct_k", fixture.cct_k, 2_200.0, 4_000.0)?;
            out("outer_angle_deg", fixture.outer_angle_deg, 1.0, 89.0)?;
        }
        Ok(())
    }

    /// The physical atmosphere state this lighting authors, weather label
    /// seeding anything the caller left unset.
    ///
    /// `cloud_beam_transmittance` is the volumetric field's transmittance
    /// along the sun ray at the observer, when the caller has solved it;
    /// the CPU closure otherwise falls back to the uniform slab.
    pub fn atmosphere_inputs(
        &self,
        cloud_beam_transmittance: Option<f32>,
    ) -> crate::atmosphere::AtmosphereInputs {
        let seed = self.weather.atmosphere();
        // `haze` is aerosol, so it is turbidity, not a separate fudge:
        // +6 Linke over the full range takes clean air to industrial smog.
        let haze = self.haze.clamp(0.0, 1.0);
        crate::atmosphere::AtmosphereInputs {
            sun_elevation_deg: self.sun_elev_deg,
            turbidity: self.turbidity.unwrap_or(seed.turbidity) + 6.0 * haze, // fallback-ok: optional atmosphere overrides; None means the documented weather-preset value
            ozone_du: self.ozone_du.unwrap_or(crate::atmosphere::REFERENCE_OZONE_DU),
            air_density: self.air_density.unwrap_or(1.0), // fallback-ok: optional override; None is the documented standard density
            visibility_m: self.visibility_m.unwrap_or(seed.visibility_m),
            deck: self.cloud_deck.unwrap_or(seed.deck), // fallback-ok: optional override of the weather preset
            cloud_cover: self.cloud_cover.unwrap_or(seed.cloud_cover),
            cloud_base_m: self.night.cloud_base_m,
            cloud_beam_transmittance,
            ground_albedo: crate::atmosphere::GROUND_ALBEDO,
            meter_view: self.meter_view,
            sky_cube: self.sun_elev_deg <= PROBE_HANDOVER_ELEVATION_DEG,
            haze_density: self.haze_density,
        }
    }

    /// Volumetric cloud parameters this lighting authors. The field's cover
    /// is calibrated so that the fraction of zenith rays meeting thick cloud
    /// tracks the authored cover (`clouds::tests::sky_cover_tracks_authored_cover`),
    /// so the weather label's cover is handed over unchanged.
    pub fn cloud_params(&self, time_s: f32) -> crate::clouds::CloudParams {
        let cover = self
            .cloud_cover
            .unwrap_or_else(|| self.weather.atmosphere().cloud_cover) // fallback-ok: optional override of the weather preset
            .clamp(0.0, 1.0);
        let night = &self.night;
        crate::clouds::CloudParams {
            cover,
            // A broken fair-weather deck is optically thinner than an
            // overcast sheet, so the authored density is scaled with cover
            // rather than held constant across weathers.
            density: night.cloud_density.clamp(0.1, 3.0) * (0.25 + 0.5 * cover),
            kind: night.cloud_type.clamp(0.0, 1.0),
            base_m: night.cloud_base_m.clamp(200.0, 6_000.0),
            top_m: night.cloud_top_m.clamp(night.cloud_base_m + 300.0, 9_000.0),
            wind: Vec2::new(night.cloud_wind_mps[0], night.cloud_wind_mps[1]),
            time_s,
        }
    }

    /// Resolve the physical atmosphere into the plan the ladder spawns from.
    ///
    /// The normalized `sun_scale` / `ambient_scale` knobs survive as
    /// *calibration gain overrides* on top of the physical solve; at their
    /// 1.0 default the render is the model's own answer. `sky_scale` has no
    /// physical counterpart here (the sky is not a texture any more) and is
    /// reported as inert.
    fn resolve_atmosphere(
        &self,
        far_plane_m: f32,
        cloud_beam_transmittance: Option<f32>,
    ) -> (crate::lighting::LightingPlan, ResolvedLighting) {
        let inputs = self.atmosphere_inputs(cloud_beam_transmittance);
        let (_, readback) =
            crate::atmosphere::resolve(&inputs, self.sun_azim_deg, far_plane_m);

        let sun_scale = self.sun_scale.max(0.0);
        let ambient_scale = self.ambient_scale.max(0.0);
        // The transmittance LUT reddens the beam; authoring a colour on top
        // of that would double-count the reddening, so the light stays white
        // unless the operator explicitly overrides the temperature.
        let sun_color = match self.sun_temperature_k {
            Some(k) if k > 0.0 => crate::lighting::kelvin_to_rgb(k.clamp(1000.0, 20000.0)),
            _ => Color::WHITE,
        };
        // One incident-light meter for the whole ledger: the atmosphere's
        // horizontal illuminance (sun, sky, twilight, natural night floor)
        // plus the night sources (Moon, skyglow, the luminaires around the
        // camera). A single EV then exposes the sky, the street and the
        // stars in one photometric space, so twilight is continuous and no
        // pre-exposure or post-compensation has to reconcile two meters.
        //
        // A meter alone would print midnight as a grey afternoon; the eye
        // does not, so the applied EV carries a perceptual dark adaptation
        // (`dark_adaptation_stops`) on top of the reading. The floor is a
        // real camera limit (EV -4.5 at ISO 100 is f/1.4 at about 1/2 s);
        // the operator's night offset and bias come after.
        //
        // An incident meter is blind to what the camera frames. Pointed at
        // a low sun it exposes the street correctly and prints the aureole
        // and the sky around it several stops over white — the classic
        // washed-out sunset. So the sky the camera actually frames
        // (`view_sky`, from the same model) is read as a highlight and the
        // EV is raised until that highlight sits no more than
        // `SKY_HIGHLIGHT_STOPS` above middle grey: matrix metering's
        // highlight priority, deterministic and view-dependent. It only
        // bites when the framed sky is bright relative to the ground, i.e.
        // sunward at low sun; at noon the incident reading already sits
        // above it.
        let night_lx = night_ledger_illuminance_lx(self);
        let (incident_ev, highlight_ev) = meter_readings(&readback, night_lx);
        let ev100 = (incident_ev.max(highlight_ev.unwrap_or(f32::NEG_INFINITY)) // fallback-ok: no highlight reading means the incident meter alone (max identity)
            + self.night.exposure_offset_stops.clamp(-6.0, 12.0)
            + self.ev100_bias)
            .clamp(CAMERA_EV100_FLOOR, 20.0);

        let physical_sun_lux = crate::atmosphere::SOLAR_CONSTANT_LX
            * sun_scale
            * astronomical_twilight_sun_gain(self.sun_elev_deg);
        // Bevy skips rewriting the sky LUT when a view has no directional
        // sources, leaving the previous lit texture visible. A radiometrically
        // invisible seed keeps the pass scheduled so astronomical night
        // overwrites that texture with black. It is renderer plumbing, not a
        // reported light source.
        // The seed must be radiometrically invisible at the night
        // pre-exposure too. At 1e-4 lx it survived the night camera gain as a
        // brown twilight wash across the whole sky, which the night sky pass
        // then had to paint over every single frame - and any frame the pass
        // missed flashed brown. 1e-8 lx keeps the pass scheduled and leaves
        // the LUT black.
        let gpu_sun_lux = physical_sun_lux.max(1.0e-8);
        let plan = crate::lighting::LightingPlan {
            // Above civil twilight the atmosphere receives the full
            // extraterrestrial beam and performs horizon attenuation itself.
            // Below it, the source fades through astronomical twilight; the
            // tiny no-source LUT seed described above remains.
            sun_lux: gpu_sun_lux,
            sun_color,
            ev100_fixed: Some(ev100),
            env_intensity: ambient_scale,
            skybox_brightness: 0.0,
        };

        let mut inert = Vec::new();
        if (self.sky_scale - 1.0).abs() > 1.0e-3 {
            inert.push("sky_scale".to_string());
        }
        if self.fog_color.is_some() {
            inert.push("fog_color".to_string());
        }

        let linear = sun_color.to_linear();
        let resolved = ResolvedLighting {
            sun_lux: physical_sun_lux,
            sun_color: [linear.red, linear.green, linear.blue],
            env_intensity: plan.env_intensity,
            skybox_brightness: 0.0,
            ev100,
            fog_density: None,
            effective_visibility_m: Some(readback.effective_visibility_m),
            wetness: self.wetness.clamp(0.0, 1.0),
            road_materials: 0,
            atmosphere: Some(readback),
            inert_controls: inert,
            applied_physical: None,
            night_environment: None,
            facade_windows: None,
        };
        (plan, resolved)
    }
}

impl Lighting {
    /// Resolve the weather model plus this lab's scale knobs into the plan
    /// the ladder is spawned from, and the engine values worth reporting.
    pub fn resolve(&self) -> (crate::lighting::LightingPlan, ResolvedLighting) {
        self.resolve_for(DEFAULT_FAR_PLANE_M, None)
    }

    /// As [`Self::resolve`], but fits the aerial-perspective LUT to a known
    /// camera far plane and, when the caller has marched the volumetric
    /// field, closes the direct beam against its cloud transmittance.
    pub fn resolve_for(
        &self,
        far_plane_m: f32,
        cloud_beam_transmittance: Option<f32>,
    ) -> (crate::lighting::LightingPlan, ResolvedLighting) {
        if self.atmosphere {
            return self.resolve_atmosphere(far_plane_m, cloud_beam_transmittance);
        }
        let base = self.weather.lighting_plan(None, self.sun_elev_deg);
        let cloud = self.cloud_cover.unwrap_or(0.0).clamp(0.0, 1.0); // fallback-ok: legacy cubemap path: absent cover is clear sky by definition
        let sun_color = match self.sun_temperature_k {
            Some(k) if k > 0.0 => crate::lighting::kelvin_to_rgb(k.clamp(1000.0, 20000.0)),
            _ => base.sun_color,
        };
        let ev100 = base
            .ev100_fixed
            .unwrap_or_else(|| self.weather.sensor_ev100(self.sun_elev_deg)) // fallback-ok: optional fixed exposure; None is the documented weather-derived EV
            + self.ev100_bias;
        let plan = crate::lighting::LightingPlan {
            sun_lux: base.sun_lux * self.sun_scale.max(0.0) * (1.0 - 0.85 * cloud),
            sun_color,
            ev100_fixed: Some(ev100),
            env_intensity: base.env_intensity * self.ambient_scale.max(0.0)
                * (1.0 + 0.30 * cloud),
            skybox_brightness: base.skybox_brightness * self.sky_scale.max(0.0)
                * (1.0 - 0.35 * cloud),
        };
        let fog = self.fog_for(&plan);
        let (fog_density, effective_visibility_m) = match fog {
            Some((density, visibility, _)) => (Some(density), Some(visibility)),
            None => (None, None),
        };
        let linear = sun_color.to_linear();
        let resolved = ResolvedLighting {
            sun_lux: plan.sun_lux,
            sun_color: [linear.red, linear.green, linear.blue],
            env_intensity: plan.env_intensity,
            skybox_brightness: plan.skybox_brightness,
            ev100,
            fog_density,
            effective_visibility_m,
            wetness: self.wetness.clamp(0.0, 1.0),
            road_materials: 0,
            atmosphere: None,
            inert_controls: Vec::new(),
            applied_physical: None,
            night_environment: None,
            facade_windows: None,
        };
        (plan, resolved)
    }

    /// Distance-fog parameters: `(density, effective visibility m, colour)`.
    /// `None` when the authored visibility leaves the scene clear.
    ///
    /// `bevy_pbr::fog` mixes `DistanceFog::color` into the fragment *after*
    /// view exposure has been applied to the lit radiance, so the colour has
    /// to be authored display-referred. Sky luminance times the camera's
    /// exposure factor is exactly that, and it keeps the fog tracking the
    /// sky it is lit by instead of floating free of the exposure knob.
    pub fn fog_for(&self, plan: &crate::lighting::LightingPlan) -> Option<(f32, f32, Color)> {
        let authored = self.visibility_m?;
        if !authored.is_finite() || authored <= 0.0 {
            return None;
        }
        let visibility = (authored / (1.0 + 3.0 * self.haze.clamp(0.0, 1.0))).max(1.0);
        if visibility >= FOG_DISABLED_VISIBILITY_M {
            return None;
        }
        let density = match FogFalloff::from_visibility_squared(visibility) {
            FogFalloff::ExponentialSquared { density } => density,
            _ => return None,
        };
        let color = match self.fog_color {
            Some([r, g, b]) => Color::linear_rgb(r, g, b),
            None => {
                let ev100 = plan.ev100_fixed.unwrap_or(15.0); // fallback-ok: fog tint reference exposure constant, not scene data
                let exposure = 1.0 / (2.0f32.powf(ev100) * 1.2);
                // Aerial perspective is slightly cooler than the sky disc.
                let level = (plan.skybox_brightness * exposure).clamp(0.0, 1.6);
                Color::linear_rgb(level * 0.92, level * 0.96, level)
            }
        };
        Some((density, visibility, color))
    }
}

/// Marker for the planet entity carrying [`bevy::light::Atmosphere`].
#[derive(Component)]
struct AtmosphereMarker;

/// Output of [`SceneApp::resolve_relight`].
struct Relight {
    plan: crate::lighting::LightingPlan,
    resolved: ResolvedLighting,
    night_controls: crate::night::NightControls,
    night_environment: crate::night::NightEnvironment,
    cloud_params: crate::clouds::CloudParams,
    sun_dir: Dir3,
    sun_cloud_t: f32,
    moon_direct_precloud: f32,
    env_gain: f32,
    internal_scale: f32,
    camera_eye: Option<Vec3>,
}

/// Per-view components the physical atmosphere needs.
///
/// `Hdr` is mandatory (`AtmosphereSettings` requires it, and the sky is
/// scene-linear HDR radiance up to ~1.9e9 cd/m^2 on the solar disc), and
/// `RenderProfile::strip` removes it, so it is re-inserted here rather than
/// relied upon. `AtmosphereEnvironmentMapLight` is the IBL: Bevy expands it
/// into a `GeneratedEnvironmentMapLight` filtered from the sky-view LUT, so
/// ambient light is the resolved sky and not a separate authored term.
fn attach_atmosphere_view(
    commands: &mut bevy::prelude::Commands,
    entity: Entity,
    far_plane_m: f32,
    env_gain: f32,
) {
    commands.entity(entity).insert((
        bevy::camera::Hdr,
        crate::atmosphere::settings(far_plane_m),
        crate::atmosphere::environment_light(env_gain, 256),
    ));
}

/// Stop a view rendering the atmosphere.
///
/// Only `AtmosphereSettings` is removed — that is the component that makes
/// the view build LUTs and run the sky pass, so removing it is what actually
/// stops the cost. The IBL probe is *muted* rather than removed:
/// `prepare_atmosphere_probe_components` derives a private
/// `AtmosphereEnvironmentMap` marker alongside the light and skips any
/// entity that already carries it, so tearing the light off would make a
/// later re-attach silently produce no `GeneratedEnvironmentMapLight`.
fn detach_atmosphere_view(commands: &mut bevy::prelude::Commands, entity: Entity) {
    commands
        .entity(entity)
        .remove::<bevy::pbr::AtmosphereSettings>();
}

/// Drive the resolved IBL gain onto a live view.
///
/// Re-inserting `AtmosphereEnvironmentMapLight` is not enough: Bevy copies
/// its `intensity` once when it derives the `GeneratedEnvironmentMapLight`,
/// and copies *that* once more when the filtered `EnvironmentMapLight` is
/// created (`generate_environment_map_light`). Only the last component is
/// what the PBR shader reads, so every relight has to write all three or the
/// view keeps whatever gain it had on its first frame - which for a view
/// created before the physical ladder resolved is 0, i.e. black shadows.
/// The view-level `EnvironmentMapLight` is only ever the atmosphere's
/// derived probe; the cubemap path's probe is a separate `LightProbe` entity.
fn set_view_env_gain(world: &mut bevy::ecs::world::World, entity: Entity, gain: f32) {
    if let Some(mut light) = world.get_mut::<bevy::light::AtmosphereEnvironmentMapLight>(entity) {
        light.intensity = gain;
    }
    if let Some(mut light) = world.get_mut::<bevy::light::GeneratedEnvironmentMapLight>(entity) {
        light.intensity = gain;
    }
    if let Some(mut light) = world.get_mut::<bevy::light::EnvironmentMapLight>(entity) {
        light.intensity = gain;
    }
}


/// Which passes to produce for one camera. Pass keys are `<sensor>:rgb|id|depth`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassSet {
    #[serde(default = "default_true")]
    pub rgb: bool,
    #[serde(default)]
    pub id: bool,
    #[serde(default)]
    pub depth: bool,
    /// The pre-exposure linear HDR frame (`<sensor>:hdr`, RGBA f16; needs the
    /// dash-cam camera model, `crate::camera_model::HdrCapture`).
    #[serde(default)]
    pub hdr: bool,
}

fn default_true() -> bool {
    true
}

impl Default for PassSet {
    fn default() -> Self {
        Self { rgb: true, id: false, depth: false, hdr: false }
    }
}

impl PassSet {
    /// Every readback key this pass set produces for one sensor.
    pub fn keys(&self, sensor_id: &str) -> Vec<String> {
        let mut keys = Vec::with_capacity(3);
        if self.rgb {
            keys.push(format!("{sensor_id}:rgb"));
        }
        if self.id {
            keys.push(format!("{sensor_id}:id"));
        }
        if self.depth {
            keys.push(format!("{sensor_id}:depth"));
        }
        if self.hdr {
            keys.push(format!("{sensor_id}:hdr"));
        }
        keys
    }
}

/// Static description of one logical rig camera.
#[derive(Clone, Debug, PartialEq)]
pub struct CameraSpec {
    pub sensor_id: String,
    pub width: u32,
    pub height: u32,
    /// Vertical field of view in degrees (spike / W0 convention).
    pub fov_y_deg: f32,
    pub near: f32,
    pub far: f32,
    pub passes: PassSet,
}

/// Identity of one captured frame.
///
/// Every pass in a [`CapturedFrame`] was copied out of the same GPU
/// submission (`generation`) that rendered the resident scene at
/// `scene_revision` through the camera rig at `rig_revision`. `sim_tick` is
/// the caller's name for that resident scene state; the engine never
/// infers it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameIdentity {
    /// Simulation tick the caller declared the resident scene to represent.
    pub sim_tick: u64,
    /// Bumps on every resident-scene mutation: actor spawn/move/despawn,
    /// model attach, animation seek, camera pose, lighting, wetness, road
    /// detail, tile load.
    pub scene_revision: u64,
    /// Bumps when a camera is registered, removed, resized or re-hosted.
    pub rig_revision: u64,
    /// One per rendered app iteration. The copies that produced this frame
    /// were encoded after the camera passes and submitted with them.
    pub generation: u64,
}

/// One row-padded pass payload copied from a single submission.
#[derive(Clone, Debug)]
pub struct CapturedPass {
    pub width: u32,
    pub height: u32,
    /// Bytes per row including wgpu's 256-byte copy alignment.
    pub padded_row: usize,
    pub bytes: Vec<u8>,
}

/// One device-resident output published for a sensor by
/// [`SceneApp::capture_device`]: the consumer leases `(stream, slot)` for
/// exactly `generation` (`gpu_interop::ReadyFrame` on the wire).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceReady {
    pub stream: u64,
    pub slot: u32,
    pub generation: u64,
}

/// Every requested output of one submission. Host passes are keyed
/// `<sensor>:rgb|id|depth`; device outputs are keyed by sensor.
#[derive(Debug)]
pub struct CapturedFrame {
    pub identity: FrameIdentity,
    pub passes: HashMap<String, CapturedPass>,
    pub device: HashMap<String, DeviceReady>,
}

// ---------------------------------------------------------------------------
// Main world <-> render world plumbing
// ---------------------------------------------------------------------------

struct SentPass {
    key: String,
    generation: u64,
    width: u32,
    height: u32,
    padded_row: usize,
    data: Vec<u8>,
}

#[derive(Resource, Deref)]
struct RenderSender(crossbeam_channel::Sender<SentPass>);

/// Render-world timing of the last host readback, shared with the main world
/// (same pattern as [`GpuPending`]): how long the map waited on the device
/// (the frame's GPU work plus the copies) and how long the copy-out took.
#[derive(Resource, Clone, Default)]
struct ReadbackClock(std::sync::Arc<std::sync::Mutex<ReadbackTiming>>);

#[derive(Clone, Copy, Default, Debug)]
struct ReadbackTiming {
    wait_ms: f64,
    copy_ms: f64,
    bytes: u64,
}

/// How a capture's pixels depend on the frames rendered before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureClock {
    /// Every rendered frame advances the sky clock and the shader noise /
    /// jitter seed, and TAA carries history across frames: a capture depends
    /// on how many frames were drawn before it (the rc.73 behaviour, kept
    /// byte-identical for comparison and legacy re-renders).
    Free,
    /// A capture is a function of the scene at its simulation time only:
    /// the sky clock is pinned to the capture's simulation time, the shader
    /// noise seed and TAA jitter restart at sample 0 for every capture, and
    /// TAA (when a view uses it) resets its history and accumulates exactly
    /// `samples` jittered frames of the static capture pose. Extra frames
    /// (readiness, retries, relights) cannot change the result.
    Pinned { samples: u32 },
}

impl CaptureClock {
    /// Frames one capture renders under this clock (views with TAA).
    pub fn samples(self) -> u32 {
        match self {
            CaptureClock::Free => 1,
            CaptureClock::Pinned { samples } => samples.max(1),
        }
    }
}

/// The pinned shader-noise / jitter sample index, shared with the render
/// world. `None` leaves Bevy's frame count in charge ([`CaptureClock::Free`]).
#[derive(Resource, Clone, Default)]
struct PinnedSample(std::sync::Arc<std::sync::Mutex<Option<u32>>>);

impl PinnedSample {
    fn get(&self) -> Option<u32> {
        *self.0.lock().expect("pinned sample")
    }
    fn set(&self, value: Option<u32>) {
        *self.0.lock().expect("pinned sample") = value;
    }
}

/// The TAA jitter sequence Bevy uses (Halton 2,3 minus 0.5), indexed by the
/// pinned sample instead of the frame count.
const TAA_HALTON: [Vec2; 8] = [
    Vec2::new(0.0, 0.0),
    Vec2::new(0.0, -0.16666666),
    Vec2::new(-0.25, 0.16666669),
    Vec2::new(0.25, -0.3888889),
    Vec2::new(-0.375, -0.055555552),
    Vec2::new(0.125, 0.2777778),
    Vec2::new(-0.125, -0.2777778),
    Vec2::new(0.375, 0.055555582),
];

/// Render world: jitter every TAA view by the pinned sample (after Bevy's
/// frame-count jitter, before the view uniforms consume it).
fn pin_taa_jitter(pinned: Res<PinnedSample>, mut views: Query<&mut bevy::render::camera::TemporalJitter>) {
    let Some(sample) = pinned.get() else { return };
    let offset = TAA_HALTON[sample as usize % TAA_HALTON.len()];
    for mut jitter in &mut views {
        jitter.offset = offset;
    }
}

/// Render world: the shader globals' `frame_count` seeds SSAO, SSR, shadow
/// and specular noise. Rewrite it with the pinned sample after Bevy wrote
/// the frame count (the later queue write wins before the frame submits).
/// The views' own `frame_count` (mesh-change timestamps) stays real.
fn pin_shader_noise_seed(
    pinned: Res<PinnedSample>,
    device: Res<RenderDevice>,
    queue: Res<bevy::render::renderer::RenderQueue>,
    mut globals: ResMut<bevy::render::globals::GlobalsBuffer>,
) {
    let Some(sample) = pinned.get() else { return };
    use bevy::reflect::structs::GetField;
    let uniform = globals.buffer.get_mut();
    let Some(frame_count) = uniform.get_field_mut::<u32>("frame_count") else {
        // A Bevy upgrade renamed the field: fail loudly, never silently unpinned.
        panic!("GlobalsUniform has no frame_count field to pin");
    };
    *frame_count = sample;
    globals.buffer.write_buffer(&device, &queue);
}

/// Where the time of the last [`SceneApp::capture`] went (diagnostics; the
/// service reports it per bundle).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CaptureStats {
    /// Submissions made (1 on a settled scene; more when a submission was
    /// withdrawn because pipelines were still compiling).
    pub attempts: u32,
    /// Empty submissions [`SceneApp::capture`] spent settling the GPU.
    pub settle_updates: u32,
    /// Wall time of the capture submissions (CPU frame + GPU wait + copy-out).
    pub submit_ms: f64,
    /// Time the readback map waited on the device, summed over attempts.
    pub readback_wait_ms: f64,
    /// Time spent copying mapped staging buffers to host memory.
    pub readback_copy_ms: f64,
    /// Host bytes read back by the accepted submission.
    pub readback_bytes: u64,
    /// Extra TAA accumulation frames rendered before the capture frames
    /// ([`CaptureClock::Pinned`] with TAA views).
    pub accumulation_frames: u32,
}

/// Outcome of one device-sink copy for one sensor in one submission.
#[cfg(feature = "gpu-interop")]
struct SentDevice {
    sensor_id: String,
    generation: u64,
    result: std::result::Result<crate::gpu_interop::ReadyFrame, String>,
}

#[cfg(feature = "gpu-interop")]
#[derive(Resource, Deref)]
struct DeviceSender(crossbeam_channel::Sender<SentDevice>);

/// Main-world marker: the RGB target (or its view depth texture) identified
/// by `src_image` can be read back under `key`.
#[derive(Component, Clone)]
struct ReadbackTarget {
    key: String,
    src_image: Handle<Image>,
    depth: bool,
    /// The camera model's metering result of the view rendering
    /// `src_image` (16 bytes), not a texture.
    exposure: bool,
}

/// One plane of a device stream and the resident target it is copied from.
#[cfg(feature = "gpu-interop")]
#[derive(Clone)]
struct DevicePlane {
    name: &'static str,
    src_image: Handle<Image>,
    depth: bool,
}

/// A sensor's device stream: which planes to fill from which targets, and
/// how long to wait for a free slot before reporting backpressure.
#[cfg(feature = "gpu-interop")]
#[derive(Clone)]
struct DeviceCopy {
    sensor_id: String,
    stream: crate::gpu_interop::StreamId,
    wait: Option<Duration>,
    planes: Vec<DevicePlane>,
}

/// Which outputs the host wants from the next submission. Empty means the
/// frame renders without any copy or host map. Extracted into the render
/// world every iteration so the copies are stamped with the generation of
/// the submission they were encoded into.
#[derive(Resource, Clone, Default)]
struct CaptureRequest {
    generation: u64,
    keys: Vec<String>,
    #[cfg(feature = "gpu-interop")]
    device: Vec<DeviceCopy>,
    /// Staging slot the copies land in ([`READBACK_SLOTS`] alternate, so one
    /// capture's readback can be in flight while the next one renders).
    slot: usize,
    /// Map the slot without waiting ([`SceneApp::capture_begin`]); the host
    /// collects it in [`SceneApp::capture_finish`].
    deferred: bool,
}

/// Staging slots per readback target: one capture in flight plus the one
/// being rendered.
const READBACK_SLOTS: usize = 2;

/// The deferred map of one capture's slot, filled by the render world.
struct DeferredMap {
    generation: u64,
    slot: usize,
    expected: usize,
    done: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    failed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Resource, Clone, Default)]
struct DeferredMaps(std::sync::Arc<std::sync::Mutex<Vec<DeferredMap>>>);

/// A capture submitted by [`SceneApp::capture_begin`].
pub enum CaptureTicket {
    /// Collected already (the submission needed a settle/retry, or device
    /// outputs were requested): the frame the blocking path produced.
    Ready(CapturedFrame),
    /// On the GPU; [`SceneApp::capture_finish`] waits for and copies it.
    Pending(PendingCapture),
}

pub struct PendingCapture {
    identity: FrameIdentity,
    keys: Vec<String>,
    stats: CaptureStats,
}

/// One persistent GPU->CPU staging buffer in the render world. Exists only
/// for targets that have been requested at least once and is dropped as
/// soon as its target is unregistered.
struct StagingBuffer {
    key: String,
    src_image: Handle<Image>,
    depth: bool,
    exposure: bool,
    width: u32,
    height: u32,
    padded_row: usize,
    buffer: Buffer,
    /// Readback slot (see [`READBACK_SLOTS`]).
    slot: usize,
    /// Set by `copy_passes` when a copy from this submission was encoded;
    /// `receive_passes` maps only those and clears the flag.
    copied: bool,
}

#[derive(Resource, Default)]
struct Staging(Vec<StagingBuffer>);

fn setup_target_image(
    images: &mut Assets<Image>,
    w: u32,
    h: u32,
    format: TextureFormat,
) -> Handle<Image> {
    let mut img = Image::new_target_texture(w, h, format, None);
    img.texture_descriptor.usage |= TextureUsages::COPY_SRC;
    images.add(img)
}

fn make_buffer(device: &RenderDevice, size_bytes: usize) -> Buffer {
    device.create_buffer(&BufferDescriptor {
        label: Some("native-readback"),
        size: size_bytes as u64,
        usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn aligned_row(width: usize, pixel_size: usize) -> usize {
    RenderDevice::align_copy_bytes_per_row(width * pixel_size)
}

/// Strip wgpu 256-byte row padding from a readback buffer.
pub fn strip_padding(data: &[u8], width: usize, height: usize, pixel: usize) -> Vec<u8> {
    let row = width * pixel;
    let aligned = aligned_row(width, pixel);
    if row == aligned {
        return data[..row * height].to_vec();
    }
    data.chunks_exact(aligned)
        .take(height)
        .flat_map(|r| &r[..row])
        .copied()
        .collect()
}

/// Solar source available to the GPU LUT solve below the geometric horizon.
///
/// The upper atmosphere stays sunlit through civil and nautical twilight,
/// then reaches zero at astronomical night. Smoothstep avoids a visible
/// lighting discontinuity while time is animated.
fn astronomical_twilight_sun_gain(elev_deg: f32) -> f32 {
    let t = ((elev_deg + 18.0) / 12.0).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn atmosphere_view_active(lighting: &Lighting) -> bool {
    lighting.atmosphere
}

/// Stops of under-exposure the camera holds back as the scene gets dark, so
/// dusk is printed as dusk and midnight as night rather than both being
/// re-normalised to a grey afternoon. A fixed fraction
/// (`DARK_ADAPTATION_SLOPE`) of every stop the meter reads below full
/// daylight is withheld, up to `DARK_ADAPTATION_CAP_STOPS`: nothing at
/// noon, ~0.6 stops under overcast, ~3 stops at civil dusk, the cap on a
/// lit street at midnight, where a luminaire pool still prints legibly.
fn dark_adaptation_stops(illuminance_lx: f32) -> f32 {
    const DAYLIGHT_LX: f32 = 100_000.0;
    ((incident_meter_ev100(DAYLIGHT_LX) - incident_meter_ev100(illuminance_lx))
        * DARK_ADAPTATION_SLOPE)
        .clamp(0.0, DARK_ADAPTATION_CAP_STOPS)
}

/// Fraction of each metered stop below daylight the camera withholds.
pub const DARK_ADAPTATION_SLOPE: f32 = 0.35;
/// Upper bound on [`dark_adaptation_stops`].
pub const DARK_ADAPTATION_CAP_STOPS: f32 = 2.5;
/// Lowest EV100 the camera adapts to: f/1.4 at about 1/2 s at ISO 100,
/// which is as far as a hand-holdable night rig goes.
pub const CAMERA_EV100_FLOOR: f32 = -4.5;

/// Incident-light meter, ISO 100, C = 250: `EV100 = log2(E * 100 / 250)`.
fn incident_meter_ev100(illuminance_lx: f32) -> f32 {
    (illuminance_lx.max(1.0e-5) / 2.5).log2()
}

/// EV100 that places a sky luminance `SKY_HIGHLIGHT_STOPS` above middle
/// grey. Bevy's exposure maps `L = 0.18 * 1.2 * 2^EV` cd/m^2 to the 0.18
/// display-linear middle grey.
fn sky_highlight_ev100(luminance_cdm2: f32) -> f32 {
    (luminance_cdm2.max(1.0e-3) / (0.18 * 1.2)).log2() - SKY_HIGHLIGHT_STOPS
}

/// Stops above middle grey the brightest framed sky is allowed to reach.
/// AgX holds colour to about +2.5 stops and goes white past +4; the aureole
/// just outside the solar disc is placed here so it prints as a bright
/// warm glow rather than a white hole, with the disc itself still clipping.
pub const SKY_HIGHLIGHT_STOPS: f32 = 2.5;

/// The meter's two readings: the incident EV with dark adaptation, and the
/// highlight-priority EV from the framed sky when a metering camera was
/// given. The applied EV is the larger, then the operator's offset and
/// bias.
fn meter_readings(
    readback: &crate::atmosphere::AtmosphereReadback,
    night_lx: f32,
) -> (f32, Option<f32>) {
    let meter_lx = readback.total_horizontal_illuminance_lx + night_lx;
    let incident = incident_meter_ev100(meter_lx) + dark_adaptation_stops(meter_lx);
    let highlight = readback
        .view_sky
        .as_ref()
        .map(|v| sky_highlight_ev100(v.max_cdm2));
    (incident, highlight)
}

/// Average maintained illuminance the camera is standing in, by direct
/// point-by-point summation over the street-lighting installation.
///
/// This is the roadway-lighting calculation, not a proxy: each luminaire is a
/// downward cone of `lumens / omega` candela, and the illuminance it puts on
/// the road is `I cos(theta) / d^2`. It is averaged over the camera's own
/// ground point plus two rings at 15 m and 30 m, which is both the area a
/// night frame actually shows and enough spatial smoothing that walking under
/// a pole does not step the exposure.
fn local_fixture_illuminance_lx(
    fixtures: &[crate::night::NightFixture],
    active: usize,
    eye: Vec3,
) -> f32 {
    if fixtures.is_empty() || active == 0 {
        return 0.0;
    }
    let mut samples: Vec<Vec3> = vec![Vec3::new(eye.x, eye.y - 1.6, eye.z)];
    for ring in [12.0_f32, 25.0, 45.0] {
        for k in 0..8 {
            let a = k as f32 / 8.0 * std::f32::consts::TAU;
            samples.push(Vec3::new(
                eye.x + a.cos() * ring,
                eye.y - 1.6,
                eye.z + a.sin() * ring,
            ));
        }
    }
    let mut readings: Vec<f32> = Vec::with_capacity(samples.len());
    for target in &samples {
        let mut e = 0.0;
        for fixture in fixtures.iter().take(active) {
            let position = Vec3::from_array(fixture.position);
            let to_light = position - *target;
            let distance_sq = to_light.length_squared().max(1.0);
            let distance = distance_sq.sqrt();
            let unit = to_light / distance;
            // Luminaires point straight down; matched to `spawn_night_sources`.
            // The cone edge is soft (full at 70 deg off-axis, gone at 85 deg):
            // a hard 80 deg cut made the lower-quartile reading jump between
            // zero and a pool's worth as a dolly crept past a pole, which
            // read as a one-stop exposure flash in a clip metered per frame.
            let cos_off_axis = unit.y;
            let cone = {
                let lo = 85.0_f32.to_radians().cos();
                let hi = 70.0_f32.to_radians().cos();
                let x = ((cos_off_axis - lo) / (hi - lo)).clamp(0.0, 1.0);
                x * x * (3.0 - 2.0 * x)
            };
            if cone <= 0.0 {
                continue;
            }
            let half_angle = 80.0_f32.to_radians();
            let solid_angle = std::f32::consts::TAU * (1.0 - half_angle.cos());
            let intensity = fixture.lumens.clamp(2_000.0, 8_000.0) / solid_angle.max(0.1);
            // Cosine of incidence on a horizontal road surface.
            e += intensity * cone * unit.y.max(0.0) / distance_sq;
        }
        readings.push(e);
    }
    // Lower quartile, not mean or median: one luminaire near the camera must
    // not stop the whole frame down. A night exterior is graded off the road
    // between the pools, not the pools themselves, so the meter reads the
    // darker quarter of the sampled ground.
    readings.sort_by(f32::total_cmp);
    readings[readings.len() / 4]
}
/// Horizontal illuminance the night ledger puts at the camera, lx: the
/// natural sky, urban skyglow, the Moon and the luminaires around the
/// observer. Added to the atmosphere's own reading so one meter sees
/// everything that lights the shot; a lit street meters several stops
/// brighter than a field station with seven poles a hundred metres away,
/// which is exactly why one fixed EV could never serve both.
fn night_ledger_illuminance_lx(lighting: &Lighting) -> f32 {
    let env = crate::night::resolve_night(&lighting.night, 1.0, false);
    let active = lighting
        .night
        .fixtures
        .len()
        .min(lighting.night.fixture_budget.min(12));
    let eye = Vec3::from_array(lighting.night.observer_position);
    let fixtures = if lighting.sun_elev_deg <= NIGHT_SOURCES_ELEVATION_DEG {
        local_fixture_illuminance_lx(&lighting.night.fixtures, active, eye)
    } else {
        0.0
    };
    lighting.night.natural_ambient_lux.clamp(0.001, 0.003)
        + lighting.night.urban_skyglow_lux.clamp(0.0, 0.5)
        + env.celestial.horizontal_lux
        + fixtures
}





/// Assemble the per-view sky parameters from the resolved night state.
///
/// Two gains are computed here and both are reported:
///
/// * `star_gain` closes the star plate's arbitrary units against the site's
///   natural sky illuminance, then applies the declared display lift. The
///   lift is the night sky's long exposure: a single camera EV that prints a
///   3000 K street pool legibly puts a 22 mag/arcsec^2 sky, its skyglow and
///   its moonlit clouds several stops under black, so the sky's own
///   sources are lifted together (`night_lift`) and the lift is named
///   rather than hidden. It is invisible by day, where the atmosphere's
///   sky is thousands of times brighter than anything it multiplies.
/// * `moon_gain` is a pure energy closure: the disc integrates to the
///   resolved direct-normal illuminance over its own solid angle, which puts
///   a full Moon at roughly 4000 cd/m^2 without any authored number. The
///   disc is not lifted: it is already bright.
fn build_sky_pass(
    resolved: &ResolvedLighting,
    env: &crate::night::NightEnvironment,
    controls: &crate::night::NightControls,
    cloud: &crate::clouds::CloudParams,
    internal_scale: f32,
    ev100_fixed: f32,
    moon_direct_precloud: f32,
) -> crate::sky_pass::SkyPass {
    let frame = &env.frame;
    let r = frame.equ_from_world;
    let equ = Mat3::from_cols(
        Vec3::new(r[0][0], r[1][0], r[2][0]),
        Vec3::new(r[0][1], r[1][1], r[2][1]),
        Vec3::new(r[0][2], r[1][2], r[2][2]),
    );
    let rho = frame.angular_radius_rad.max(1.0e-4);
    // Mean of albedo x Lommel-Seeliger reflectance over the visible disc.
    // 0.05 is the full-Moon value (geometric albedo 0.10 x R = 0.5); the
    // exponent tracks how fast the lit area shrinks with phase.
    let disc_mean = 0.05 * env.celestial.illuminated_fraction.max(0.02).powf(1.1);
    let moon_gain = if moon_direct_precloud > 0.0 {
        (moon_direct_precloud / (disc_mean * std::f32::consts::PI * rho * rho))
            .clamp(0.0, 5.0e5)
    } else {
        0.0
    };
    let camera = 2.0f32.powf(ev100_fixed) * 1.2;
    let exposure_scene = internal_scale / camera;
    let exposure_sky = 1.0 / camera;
    // The lift is the sky's long exposure, so it is relative to the camera:
    // it raises the natural + urban sky background to `NIGHT_SKY_TARGET`
    // on the display and never past the authored ceiling. A dark site whose
    // camera is already wide open needs none; a lit street whose camera is
    // stopped down for its luminaires gets the full ceiling.
    let background_cd = (env.natural_ambient_lux + env.urban_skyglow_lux * 0.5)
        / std::f32::consts::PI;
    let lift = (NIGHT_SKY_TARGET / (background_cd * exposure_scene).max(1.0e-9))
        .clamp(1.0, controls.sky_display_lift.clamp(1.0, 600.0));

    // Daylight on the deck, from the same solve that lit the scene: the
    // extraterrestrial beam through the air above the deck base (colour and
    // strength), the zenith sky on the tops, the sunlit ground underneath.
    let (sun_lux, sun_tint, sky_ambient, ground_bounce, aerial_rayleigh, aerial_aerosol) =
        match &resolved.atmosphere {
            Some(a) => {
                let t = Vec3::from_array(a.deck_sun_transmittance);
                let luma = t.dot(Vec3::new(0.2126, 0.7152, 0.0722));
                let tint = if luma > 0.0 { t / luma } else { Vec3::ONE };
                let ground = a.total_horizontal_illuminance_lx
                    * crate::atmosphere::GROUND_ALBEDO
                    / std::f32::consts::PI;
                (
                    crate::atmosphere::SOLAR_CONSTANT_LX * luma,
                    tint,
                    Vec3::from_array(a.zenith_radiance),
                    ground,
                    Vec2::from_array(a.aerial_rayleigh),
                    Vec2::from_array(a.aerial_aerosol),
                )
            }
            None => (
                0.0,
                Vec3::ONE,
                Vec3::ZERO,
                0.0,
                Vec2::new(1.2e-5, 8_000.0),
                Vec2::new(4.4e-6, 1_200.0),
            ),
        };
    crate::sky_pass::SkyPass {
        equ_from_world: Mat4::from_mat3(equ),
        altitude_m: controls.elevation_m.max(0.0),
        moon_dir: Vec3::from_array(frame.moon_dir),
        moon_angular_radius: rho,
        moon_north: Vec3::from_array(frame.moon_north),
        sub_earth_lon: frame.sub_earth_lon_deg.to_radians(),
        sub_earth_lat: frame.sub_earth_lat_deg.to_radians(),
        moon_sun_dir: Vec3::from_array(frame.moon_sun_dir),
        sun_dir: Vec3::from_array(frame.sun_dir),
        sun_lux,
        sun_tint,
        ground_bounce,
        sky_ambient,
        aerial_rayleigh,
        aerial_aerosol,
        moon_lux: moon_direct_precloud,
        skyglow_rgb: Vec3::new(0.78, 0.80, 0.88),
        skyglow_luminance: env.urban_skyglow_lux / std::f32::consts::PI * lift,
        night_lift: lift,
        exposure_scene,
        exposure_sky,
        star_gain: env.sky_photometric_gain * lift,
        moon_gain,
        pixel_angle: 0.001,
        cloud_cover: cloud.cover,
        cloud_density: cloud.density,
        cloud_type: cloud.kind,
        cloud_base_m: cloud.base_m,
        cloud_top_m: cloud.top_m,
        wind_x: cloud.wind.x,
        wind_z: cloud.wind.y,
        march_steps: controls.cloud_quality.march_steps().max(16.0),
        light_steps: controls.cloud_quality.light_steps().max(3.0),
        debug_mode: controls.sky_debug_mode as f32,
        elapsed_seconds: cloud.time_s,
    }
}

/// Sun elevation at or below which the celestial `LightProbe` replaces the
/// atmosphere's view IBL. The probe carries the twilight sky closed against
/// the same diffuse illuminance the meter read, so the handover does not
/// step the ambient.
///
/// Measured (Yale Street, clear, road patch of albedo 0.1 read back in
/// linear, rev22): the LUT's own IBL delivers 0.83x the model's diffuse
/// illuminance at 4.8 deg, 1.35x at 2.2 deg, 2.6x at sunset, 3.4x at
/// -1.4 deg and 5.3x at -3.6 deg — Hillaire's isotropic multiple
/// scattering keeps the sky-view LUT bright long after the direct beam has
/// gone, while the meter follows the twilight law. Left on the LUT, a
/// sunset time-lapse brightened for three degrees after sunset and then
/// dropped 2x at the old -4 deg handover. So the probe takes over where
/// the two still agree, and the last two degrees of LUT IBL are tapered
/// towards the measured ratio ([`atmosphere_ibl_gain`]).
pub const PROBE_HANDOVER_ELEVATION_DEG: f32 = 2.0;

/// Gain on the atmosphere IBL above the probe handover: 1 down to
/// [`IBL_TAPER_START_ELEVATION_DEG`], then linear to `1 / 1.18` at the
/// handover. The LUT's excess at the handover is view-dependent — 1.0x on
/// a road facing away from the low sun, 1.36x on one facing its glow —
/// so the taper lands on the geometric mean and either view meets the
/// probe within ±15 %.
fn atmosphere_ibl_gain(sun_elev_deg: f32) -> f32 {
    const AT_HANDOVER: f32 = 1.0 / 1.18;
    let t = ((sun_elev_deg - PROBE_HANDOVER_ELEVATION_DEG)
        / (IBL_TAPER_START_ELEVATION_DEG - PROBE_HANDOVER_ELEVATION_DEG))
        .clamp(0.0, 1.0);
    AT_HANDOVER + (1.0 - AT_HANDOVER) * t
}

/// Sun elevation where the atmosphere IBL starts tapering towards the
/// probe's value.
pub const IBL_TAPER_START_ELEVATION_DEG: f32 = 4.0;

/// Which set of light sources a sun elevation calls for. Within one tier
/// the clock only moves what is already spawned (see
/// [`SceneApp::advance_lighting`]); crossing a tier respawns the ladder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LadderTier {
    /// Sun and the atmosphere's own IBL.
    Day,
    /// The celestial probe carries the ambient (sunset through civil
    /// twilight); no night sources yet.
    Twilight,
    /// Luminaires, windows and the Moon are on as well.
    Night,
}

fn ladder_tier(sun_elev_deg: f32) -> LadderTier {
    if sun_elev_deg > PROBE_HANDOVER_ELEVATION_DEG {
        LadderTier::Day
    } else if sun_elev_deg > NIGHT_SOURCES_ELEVATION_DEG {
        LadderTier::Twilight
    } else {
        LadderTier::Night
    }
}

/// Residual daylight the celestial probe carries below the handover: the
/// model's directional sky (`AtmosphereReadback::sky_cube`, closed against
/// the two-stream diffuse) when it was built, else a uniform hemisphere of
/// the diffuse illuminance (radiance `E / pi`) in the zenith's own
/// chromaticity. Either way the horizontal irradiance is the meter's
/// diffuse reading, so the ambient does not step where the probe takes
/// over from the IBL.
///
/// `PROBE_IRRADIANCE_CALIBRATION` is the read-back correction for Bevy's
/// diffuse convolution of a raw cubemap. With the directional cube a road
/// patch of albedo 0.1 reads back 0.98-1.01 of the closed irradiance
/// (Yale Street, clear and 45 % cloud, rev23), so no correction is needed;
/// the constant stays as the place to put one.
const PROBE_IRRADIANCE_CALIBRATION: f32 = 1.0;

fn probe_daylight(
    a: Option<&crate::atmosphere::AtmosphereReadback>,
) -> (Box<dyn Fn(Vec3) -> Vec3>, Vec3) {
    let Some(a) = a else {
        return (Box::new(|_| Vec3::ZERO), Vec3::ZERO);
    };
    let chroma = Vec3::from_array(a.zenith_radiance);
    let chroma = if chroma.max_element() > 0.0 {
        chroma / chroma.max_element()
    } else {
        Vec3::new(0.55, 0.68, 1.0)
    };
    let luma = chroma.dot(Vec3::new(0.2126, 0.7152, 0.0722)).max(1.0e-3);
    let uniform = chroma / luma
        * (a.diffuse_horizontal_illuminance_lx / std::f32::consts::PI)
        * PROBE_IRRADIANCE_CALIBRATION;
    match a.sky_cube.clone() {
        Some(cube) => (
            Box::new(move |dir| cube.sample(dir) * PROBE_IRRADIANCE_CALIBRATION),
            uniform,
        ),
        None => (Box::new(move |_| uniform), uniform),
    }
}

/// Sun elevation at or below which luminaires and windows come on. Street
/// lighting photocells trip at roughly 20-30 lx, which a clear sky delivers
/// about a quarter of an hour after sunset.
pub const NIGHT_SOURCES_ELEVATION_DEG: f32 = -3.0;

/// Scene-linear display level the lifted night-sky background is brought to
/// before tonemapping: a deep, readable grey that leaves the stars and the
/// Moon well above it.
pub const NIGHT_SKY_TARGET: f32 = 0.035;

/// Time constant, in cloud-clock seconds, of the low-pass on the sun's
/// cloud transmittance between in-place look advances.
pub const CLOUD_BEAM_SMOOTHING_S: f32 = 2.0;


fn spawn_night_sources(
    world: &mut World,
    lighting: &Lighting,
    controls: &crate::night::NightControls,
    env: &crate::night::NightEnvironment,
    internal_scale: f32,
) {
    if lighting.sun_elev_deg > NIGHT_SOURCES_ELEVATION_DEG {
        return;
    }
    let moon = &env.celestial;
    let moon_shadow = matches!(controls.cloud_quality, crate::night::CloudQuality::Lookdev)
        && moon.direct_normal_lux > 0.03;
    if moon.direct_normal_lux > 0.0 {
        let dir = sun_direction(moon.elevation_deg, moon.azimuth_deg);
        world.spawn((
            DirectionalLight {
                illuminance: moon.direct_normal_lux * internal_scale,
                color: Color::srgb(0.96, 0.97, 1.0),
                shadow_maps_enabled: moon_shadow,
                contact_shadows_enabled: moon_shadow,
                ..default()
            },
            Transform::IDENTITY.looking_to(dir, Vec3::Y),
            NightLightMarker,
        ));
    }
    let fixtures = controls.fixtures.clone();
    let active = env.fixtures_active;
    let shadow_budget = controls.fixture_shadow_budget.min(2);
    world.resource_scope(|world, mut meshes: Mut<Assets<Mesh>>| {
        world.resource_scope(|world, mut materials: Mut<Assets<StandardMaterial>>| {
            let head_mesh = meshes.add(
                SphereMeshBuilder::new(0.16, SphereKind::Uv { sectors: 12, stacks: 8 }).build(),
            );
            let _ = &lighting; // fallback-ok: borrow marker only
            let mut commands = world.commands();
            for (idx, fixture) in fixtures.iter().enumerate() {
                let position = Vec3::from_array(fixture.position);
                // Values are validated to the calibrated ranges up front.
                let color = lighting::kelvin_to_rgb(fixture.cct_k);
                let head_material = materials.add(StandardMaterial {
                    base_color: color,
                    emissive: color.to_linear() * (45.0 * internal_scale.sqrt()),
                    ..default()
                });
                commands.spawn((
                    Mesh3d(head_mesh.clone()),
                    MeshMaterial3d(head_material),
                    Transform::from_translation(position),
                    NightLightMarker,
                ));
                if idx < active {
                    let forward = Vec3::NEG_Y;
                    commands.spawn((
                        SpotLight {
                            color,
                            intensity: fixture.lumens * internal_scale,
                            range: fixture.range_m,
                            radius: 0.12,
                            // The authored cone, with the qualified 46/80
                            // inner/outer falloff ratio.
                            inner_angle: (fixture.outer_angle_deg * 46.0 / 80.0).to_radians(),
                            outer_angle: fixture.outer_angle_deg.to_radians(),
                            shadow_maps_enabled: idx < shadow_budget,
                            ..default()
                        },
                        Transform::from_translation(position).looking_to(forward, Vec3::Z),
                        NightLightMarker,
                    ));
                }
            }
        });
    });
    world.flush();
}
fn update_physical_windows(world: &mut World, enabled: bool, internal_scale: f32) -> Result<u32> {
    let restores: Vec<(Entity, Handle<StandardMaterial>)> = {
        let mut q = world.query::<(Entity, &NightWindowOriginal)>();
        q.iter(world).map(|(e, o)| (e, o.0.clone())).collect()
    };
    for (entity, handle) in restores {
        world.entity_mut(entity)
            .insert(MeshMaterial3d(handle))
            .remove::<NightWindowOriginal>();
    }
    if !enabled {
        return Ok(0);
    }
    // Occupancy must not depend on entity allocation (async load order):
    // targets are ordered by material name, material asset path and world
    // position, and occupancy is a function of that order alone.
    let mut targets: Vec<(Entity, Handle<StandardMaterial>, String, String, [u32; 3])> = {
        let mut q = world.query::<(
            Entity,
            &GltfMaterialName,
            &MeshMaterial3d<StandardMaterial>,
            Option<&GlobalTransform>,
        )>();
        q.iter(world)
            .filter_map(|(entity, name, material, global)| {
                let label = (&**name).to_lowercase();
                let positive = label.contains("window")
                    || (label.contains("glass")
                        && !["bulb", "signal", "streetlight", "train", "hydrant"]
                            .iter().any(|token| label.contains(token)));
                let path = material.0.path().map(|p| p.to_string()).unwrap_or_default(); // fallback-ok: sort key only; an unlabelled material sorts first, deterministically
                let position = global.map(|g| g.translation().to_array().map(f32::to_bits)).unwrap_or([0; 3]); // fallback-ok: sort key only
                positive.then(|| (entity, material.0.clone(), label, path, position))
            })
            .collect()
    };
    targets.sort_by(|a, b| (&a.2, &a.3, a.4).cmp(&(&b.2, &b.3, b.4)));
    let mut applied = 0u32;
    let mut missing: Option<String> = None;
    world.resource_scope(|world, mut materials: Mut<Assets<StandardMaterial>>| {
        for (ordinal, (entity, source, label, _, _)) in targets.into_iter().enumerate() {
            // 30% deterministic occupancy at primitive granularity: a
            // residential street around 22:00, not an office block.
            if (ordinal * 73) % 100 >= 30 {
                continue;
            }
            let Some(mut material) = materials.get(&source).cloned() else {
                missing.get_or_insert(label);
                continue;
            };
            let cct = 2_200.0 + ((ordinal * 317) % 1_800) as f32;
            // Same street-side luminance model as the synthetic façades.
            let roll = ((ordinal * 47) % 100) as f32 / 100.0;
            let luminance = crate::facade_windows::WINDOW_LUMINANCE_CDM2
                [crate::facade_windows::window_luminance_bin(roll)];
            let color = lighting::kelvin_to_rgb(cct);
            // `StandardMaterial::emissive` is luminance in cd/m2; the view's
            // `Exposure` converts it.
            material.emissive = color.to_linear() * (luminance * internal_scale);
            material.base_color = Color::BLACK;
            let handle = materials.add(material);
            world.entity_mut(entity).insert((
                MeshMaterial3d(handle),
                NightWindowOriginal(source),
            ));
            applied += 1;
        }
    });
    if let Some(label) = missing {
        bail!("night windows: window material {label:?} is not loaded");
    }
    Ok(applied)
}


fn sun_direction(elev_deg: f32, azim_deg: f32) -> Dir3 {
    // Unit vector pointing FROM the sun INTO the scene.
    let elev = elev_deg.to_radians();
    let azim = azim_deg.to_radians();
    let dir = Vec3::new(
        -(elev.cos() * azim.sin()),
        -elev.sin(),
        -(elev.cos() * azim.cos()),
    );
    Dir3::new(dir.normalize()).unwrap()
}

// ---------------------------------------------------------------------------
// Markers & state
// ---------------------------------------------------------------------------

#[derive(Component)]
struct TileLoad(Handle<Gltf>);
#[derive(Component)]
struct NightLightMarker;
#[derive(Component)]
struct NightWindowOriginal(Handle<StandardMaterial>);
#[derive(Component)]
struct SceneSpawned;
#[derive(Component)]
pub(crate) struct IdClone;
#[derive(Component, Clone, Copy)]
pub(crate) struct InstanceId(pub(crate) u32);
#[derive(Component)]
struct ActorModelRoot;
#[derive(Clone)]
struct ActorAnimationBinding {
    players: Vec<Entity>,
    node: AnimationNodeIndex,
}


/// One legend entry: instance-ID value -> source mesh name.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LegendEntry {
    pub id: u32,
    pub name: String,
}

/// World-space triangle snapshot for deterministic CPU lidar/radar raycasts.
#[derive(Clone, Copy, Debug)]
pub struct SensorTriangle {
    pub a: [f32; 3],
    pub b: [f32; 3],
    pub c: [f32; 3],
    pub instance_id: u32,
}

/// One visible actor mesh for the ray sensors (see
/// [`SceneApp::actor_sensor_meshes`]).
/// Whether a model mesh belongs to a rider: it or an ancestor up to the
/// model root carries glTF node extras `{"semanticClass": "rider"}`.
fn in_rider_subtree(world: &World, entity: Entity, model_root: Entity) -> bool {
    let mut current = Some(entity);
    while let Some(node) = current {
        if let Some(extras) = world.get::<bevy::gltf::GltfExtras>(node) {
            // fallback-ok: bevy_gltf stores extras as validated JSON (a RawValue), so the parse cannot fail; extras without a semanticClass string are simply not a rider tag
            let tagged = serde_json::from_str::<serde_json::Value>(&extras.value).ok()
                .and_then(|value| value.get("semanticClass").and_then(|v| v.as_str()).map(|c| c == "rider"))
                .unwrap_or(false); // fallback-ok: see above
            if tagged {
                return true;
            }
        }
        if node == model_root {
            return false;
        }
        current = world.get::<ChildOf>(node).map(|parent| parent.parent());
    }
    false
}

#[derive(Clone, Debug)]
pub struct ActorSensorMesh {
    pub actor_id: String,
    /// `<actor id>/<glTF node name>` for error messages and diagnostics.
    pub label: String,
    /// The actor's instance id, or for a ridden two-wheeler's rider meshes the
    /// rider's own instance id (class `rider`).
    pub instance_id: u32,
    pub geometry: ActorSensorGeometry,
}

/// One static map mesh as the lidar/radar scene instances it (see
/// [`SceneApp::static_sensor_meshes`]).
#[derive(Clone, Debug)]
pub struct StaticSensorMesh {
    pub mesh: Handle<Mesh>,
    pub world: Mat4,
    pub instance_id: u32,
    /// Asset label of the mesh (`<gltf>#Mesh<N>/Primitive<M>`), or its
    /// entity name for generated meshes; errors and ordering use it.
    pub label: String,
}

#[derive(Clone, Debug)]
pub enum ActorSensorGeometry {
    /// A rigid mesh: model-local triangles (see
    /// [`SceneApp::mesh_asset_triangles`], cacheable per asset) placed by
    /// the world matrix the camera draws it with this tick.
    Rigid { mesh: Handle<Mesh>, world: Mat4 },
    /// A skinned mesh posed this tick in world space.
    Skinned { mesh: AssetId<Mesh>, triangles: Vec<[Vec3; 3]> },
}

/// Triangle-list triangles of a mesh in its local space. Any layout the
/// ray sensors cannot reproduce exactly is an error naming the mesh, never
/// a silent skip or a reinterpretation.
pub fn mesh_local_triangles(mesh: &Mesh, label: &str) -> Result<Vec<[Vec3; 3]>> {
    use bevy::render::render_resource::PrimitiveTopology;
    if mesh.primitive_topology() != PrimitiveTopology::TriangleList {
        bail!("mesh {label} uses {:?}; the lidar/radar scene supports triangle lists only", mesh.primitive_topology());
    }
    if mesh.has_morph_targets() {
        bail!("mesh {label} has morph targets, which the lidar/radar scene cannot pose");
    }
    let Some(attribute) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else {
        bail!("mesh {label} has no POSITION attribute");
    };
    let bevy::mesh::VertexAttributeValues::Float32x3(vertices) = attribute else {
        bail!("mesh {label} POSITION is not Float32x3");
    };
    let vertex = |index: usize| -> Result<Vec3> {
        vertices.get(index).map(|v| Vec3::from(*v)).ok_or_else(|| anyhow::anyhow!(
            "mesh {label} index {index} is out of range ({} vertices)", vertices.len()
        ))
    };
    let indices: Vec<usize> = match mesh.indices() {
        Some(bevy::mesh::Indices::U16(indices)) => indices.iter().map(|i| *i as usize).collect(),
        Some(bevy::mesh::Indices::U32(indices)) => indices.iter().map(|i| *i as usize).collect(),
        None => (0..vertices.len()).collect(),
    };
    if indices.len() % 3 != 0 {
        bail!("mesh {label} has {} indices, not a whole number of triangles", indices.len());
    }
    indices
        .chunks_exact(3)
        .map(|tri| Ok([vertex(tri[0])?, vertex(tri[1])?, vertex(tri[2])?]))
        .collect()
}

/// World-space triangles of a skinned mesh under `joints` (joint world
/// matrix x inverse bindpose, as the skin extraction uploads them), blended
/// the way `skinning.wgsl` blends: the weighted sum of joint matrices
/// applied to the bind-pose position.
pub fn skinned_world_triangles(mesh: &Mesh, joints: &[Mat4], label: &str) -> Result<Vec<[Vec3; 3]>> {
    use bevy::mesh::VertexAttributeValues;
    let local = mesh_local_triangles(mesh, label)?;
    let Some(VertexAttributeValues::Float32x3(positions)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else {
        bail!("mesh {label} POSITION is not Float32x3");
    };
    let joint_indices: Vec<[u16; 4]> = match mesh.attribute(Mesh::ATTRIBUTE_JOINT_INDEX) {
        Some(VertexAttributeValues::Uint16x4(values)) => values.clone(),
        Some(other) => bail!("skinned mesh {label} JOINTS_0 has unsupported format {:?}", bevy::mesh::VertexFormat::from(other)),
        None => bail!("skinned mesh {label} has no JOINTS_0 attribute"),
    };
    let Some(VertexAttributeValues::Float32x4(weights)) = mesh.attribute(Mesh::ATTRIBUTE_JOINT_WEIGHT) else {
        bail!("skinned mesh {label} has no Float32x4 WEIGHTS_0 attribute");
    };
    if joint_indices.len() != positions.len() || weights.len() != positions.len() {
        bail!("skinned mesh {label} joint attributes do not match its {} vertices", positions.len());
    }
    let mut posed = Vec::with_capacity(positions.len());
    for ((position, index), weight) in positions.iter().zip(&joint_indices).zip(weights) {
        let mut model = Mat4::ZERO;
        for k in 0..4 {
            let joint = joints.get(index[k] as usize).ok_or_else(|| anyhow::anyhow!(
                "skinned mesh {label} references joint {} of {}", index[k], joints.len()
            ))?;
            model += *joint * weight[k];
        }
        posed.push(model.transform_point3(Vec3::from(*position)));
    }
    // Map each local triangle back onto posed vertices through the indices.
    let indices: Vec<usize> = match mesh.indices() {
        Some(bevy::mesh::Indices::U16(indices)) => indices.iter().map(|i| *i as usize).collect(),
        Some(bevy::mesh::Indices::U32(indices)) => indices.iter().map(|i| *i as usize).collect(),
        None => (0..positions.len()).collect(),
    };
    debug_assert_eq!(indices.len(), local.len() * 3);
    Ok(indices.chunks_exact(3).map(|tri| [posed[tri[0]], posed[tri[1]], posed[tri[2]]]).collect())
}

#[cfg(test)]
mod sensor_mesh_tests {
    use super::*;
    use bevy::asset::RenderAssetUsages;
    use bevy::mesh::{Indices, VertexAttributeValues};
    use bevy::render::render_resource::PrimitiveTopology;

    fn quad(topology: PrimitiveTopology) -> Mesh {
        let mut mesh = Mesh::new(topology, RenderAssetUsages::default());
        mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]]);
        mesh.insert_indices(Indices::U16(vec![0, 1, 2, 0, 2, 3]));
        mesh
    }

    #[test]
    fn triangle_list_meshes_yield_their_triangles() {
        let tris = mesh_local_triangles(&quad(PrimitiveTopology::TriangleList), "quad").unwrap();
        assert_eq!(tris.len(), 2);
        assert_eq!(tris[1], [Vec3::ZERO, Vec3::new(1.0, 1.0, 0.0), Vec3::new(0.0, 1.0, 0.0)]);
    }

    #[test]
    fn unreadable_meshes_fail_instead_of_disappearing_from_lidar() {
        let strip = mesh_local_triangles(&quad(PrimitiveTopology::TriangleStrip), "car/body").unwrap_err();
        assert!(format!("{strip}").contains("car/body"), "{strip}");
        let mut bad = quad(PrimitiveTopology::TriangleList);
        bad.insert_indices(Indices::U16(vec![0, 1, 9]));
        assert!(format!("{}", mesh_local_triangles(&bad, "car/wheel").unwrap_err()).contains("out of range"));
        let mut partial = quad(PrimitiveTopology::TriangleList);
        partial.insert_indices(Indices::U16(vec![0, 1]));
        assert!(mesh_local_triangles(&partial, "x").is_err());
        let mut no_position = Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default());
        no_position.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 1.0, 0.0]; 3]);
        assert!(mesh_local_triangles(&no_position, "x").is_err());
    }

    fn skinned_quad() -> Mesh {
        let mut mesh = quad(PrimitiveTopology::TriangleList);
        // Bottom edge on joint 0, top edge on joint 1.
        mesh.insert_attribute(Mesh::ATTRIBUTE_JOINT_INDEX, VertexAttributeValues::Uint16x4(vec![[0, 0, 0, 0], [0, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]]));
        mesh.insert_attribute(Mesh::ATTRIBUTE_JOINT_WEIGHT, vec![[1.0f32, 0.0, 0.0, 0.0]; 4]);
        mesh
    }

    #[test]
    fn skinned_meshes_are_posed_by_their_joints() {
        let mesh = skinned_quad();
        let rest = skinned_world_triangles(&mesh, &[Mat4::IDENTITY, Mat4::IDENTITY], "ped").unwrap();
        assert_eq!(rest, mesh_local_triangles(&mesh, "ped").unwrap());
        // Lift joint 1 (the top edge) by 2 m and move the whole skin 5 m in x.
        let base = Mat4::from_translation(Vec3::new(5.0, 0.0, 0.0));
        let posed = skinned_world_triangles(&mesh, &[base, base * Mat4::from_translation(Vec3::Y * 2.0)], "ped").unwrap();
        assert_eq!(posed[0], [Vec3::new(5.0, 0.0, 0.0), Vec3::new(6.0, 0.0, 0.0), Vec3::new(6.0, 3.0, 0.0)]);
        // Blended weights interpolate the joint matrices.
        let mut blended = mesh.clone();
        blended.insert_attribute(Mesh::ATTRIBUTE_JOINT_INDEX, VertexAttributeValues::Uint16x4(vec![[0, 1, 0, 0]; 4]));
        blended.insert_attribute(Mesh::ATTRIBUTE_JOINT_WEIGHT, vec![[0.5f32, 0.5, 0.0, 0.0]; 4]);
        let half = skinned_world_triangles(&blended, &[Mat4::IDENTITY, Mat4::from_translation(Vec3::Y * 2.0)], "ped").unwrap();
        assert_eq!(half[0][0], Vec3::new(0.0, 1.0, 0.0));
    }

    #[test]
    fn skins_that_reference_missing_joints_fail() {
        let error = skinned_world_triangles(&skinned_quad(), &[Mat4::IDENTITY], "ped/body").unwrap_err();
        assert!(format!("{error}").contains("joint 1 of 1"), "{error}");
        let mut unskinned = quad(PrimitiveTopology::TriangleList);
        unskinned.insert_attribute(Mesh::ATTRIBUTE_JOINT_WEIGHT, vec![[1.0f32, 0.0, 0.0, 0.0]; 4]);
        assert!(skinned_world_triangles(&unskinned, &[Mat4::IDENTITY], "x").is_err());
    }
}

/// Instance-ID pass encoding: the id's three low bytes as RGB, exact.
///
/// The value written for byte `b` is `b / 255` in linear space. Together
/// with [`id_pass_camera`] and [`ID_PASS_FORMAT`] nothing between the unlit
/// fragment and the readback rounds, dithers, filters or re-encodes it:
/// - the view is HDR, so the main target is Rgba16Float (b/255 is held within
///   0.03 of an 8-bit step) and no tonemap-in-shader/dither runs;
/// - tonemapping and deband dither are off (Bevy's default `DebandDither`
///   adds per-pixel screen-space noise before 8-bit quantisation; that
///   noise is what turned id 2024 into 2280 = 2024 + 256 at edges);
/// - MSAA is off, and no FXAA/SMAA/TAA is ever attached (profiles apply to
///   RGB views only);
/// - the target is `Rgba8Unorm` (no sRGB encode), and the final blit samples
///   texel centres of an equal-size source, so the byte written is b.
/// A float colour target, not an integer one: Bevy's forward pipelines
/// (skinned meshes included) write the view's float main texture, and an
/// integer attachment would need a separate pipeline for every material.
pub fn instance_id_color(id: u32) -> Color {
    let [r, g, b, _] = id.to_le_bytes();
    Color::linear_rgb(f32::from(r) / 255.0, f32::from(g) / 255.0, f32::from(b) / 255.0)
}

/// The unlit, fog-free material an instance id is drawn with.
pub fn instance_id_material(id: u32) -> StandardMaterial {
    StandardMaterial {
        base_color: instance_id_color(id),
        unlit: true,
        fog_enabled: false,
        ..default()
    }
}

/// Instance-ID render target format: raw bytes, never sRGB-encoded.
pub const ID_PASS_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;

/// Camera components that keep the ID pass exact (see [`instance_id_color`]).
///
/// `NoIndirectDrawing`: GPU-driven culling compacts visible instances with
/// atomics, so coplanar surfaces won their depth ties in a different order
/// on every run and single ID pixels flipped between runs (RTX 3080, Belmont).
/// CPU-ordered draws of entity-sorted bins (vendored bevy_render) make the ID
/// pass a function of the scene; it cost nothing measurable (93.1 vs 92.7 ms
/// GPU per 8-camera frame).
pub fn id_pass_camera() -> impl Bundle {
    (
        bevy::camera::Hdr,
        Msaa::Off,
        Tonemapping::None,
        bevy::core_pipeline::tonemapping::DebandDither::Disabled,
        bevy::render::view::NoIndirectDrawing,
    )
}

#[derive(Resource, Default)]
struct Legend(Vec<LegendEntry>);

/// Tearing down a render world whose device reported an error crashes in
/// wgpu (a segfault instead of the error the caller is returning), so a
/// failed app is leaked; the process is about to exit with that error.
impl Drop for SceneApp {
    fn drop(&mut self) {
        let failed = self.app.world().get_resource::<RenderFailure>().is_some_and(|failure| failure.0.is_some());
        if failed {
            std::mem::forget(std::mem::replace(&mut self.app, App::empty()));
        }
    }
}

/// The first GPU device error the renderer hit, if any (see
/// [`SceneApp::ensure_rendering`]). Rendering has stopped once it is set.
#[derive(Resource, Default)]
struct RenderFailure(Option<String>);

struct GroupEntities {
    spec: CameraSpec,
    rgb_entity: Entity,
    id_entity: Option<Entity>,
    /// Actor this camera is mounted on. Its RGB geometry is excluded from
    /// this view only; every other view still renders it.
    host: Option<String>,
}

/// First render layer handed to a camera host actor. Layer 0 is the shared
/// scene, layer 1 the instance-ID clones. Host layers come in pairs: the
/// host's RGB visuals on an even layer `2 + 2k`, its instance-ID clones on
/// `3 + 2k` (see [`id_host_layer`]), so a mounted camera's ID pass drops
/// its host exactly where its RGB pass does.
const FIRST_HOST_LAYER: usize = 2;

/// The instance-ID layer paired with a host's RGB layer.
fn id_host_layer(rgb_layer: usize) -> usize {
    rgb_layer + 1
}

/// Layers every light must cover: the shared scene plus every host actor's
/// private layer, so a host still casts shadows into views that exclude
/// its geometry (a mounted camera sees its own vehicle's shadow).
#[derive(Resource)]
struct HostLayerUnion(RenderLayers);

impl Default for HostLayerUnion {
    fn default() -> Self {
        Self(RenderLayers::layer(0))
    }
}

/// Keep every light on the host-layer union. Lights are respawned by
/// relights and night-source updates, so this runs every iteration rather
/// than at the mutation sites.
fn sync_light_layers(
    union: Res<HostLayerUnion>,
    lights: Query<
        (Entity, Option<&RenderLayers>),
        Or<(With<DirectionalLight>, With<PointLight>, With<SpotLight>)>,
    >,
    mut commands: Commands,
) {
    for (entity, layers) in &lights {
        if layers != Some(&union.0) {
            commands.entity(entity).insert(union.0.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// Dynamic actors + ground height (V4 SensorRig)
// ---------------------------------------------------------------------------

/// Coarse ground-height lookup: minimum world surface Y per grid cell.
///
/// Rasterize triangle interiors as well as vertices. Otherwise sparse road
/// meshes leave cells containing only foliage/roof vertices, and actors are
/// incorrectly snapped onto those elevated surfaces.
#[derive(Default)]
pub(crate) struct GroundField {
    cell_m: f32,
    min_y: HashMap<(i64, i64), f32>,
}

impl GroundField {
    fn build(app: &mut App, cell_m: f32) -> GroundField {
        let world = app.world_mut();
        let mut q = world.query::<(&Mesh3d, &GlobalTransform)>();
        let meshes = world.resource::<Assets<Mesh>>();
        Self::from_meshes(meshes, q.iter(world), cell_m)
    }

    pub(crate) fn from_meshes<'a>(
        meshes: &Assets<Mesh>,
        instances: impl IntoIterator<Item = (&'a Mesh3d, &'a GlobalTransform)>,
        cell_m: f32,
    ) -> GroundField {
        // A large map is hundreds of millions of triangles: split the
        // instances into contiguous chunks, build each chunk's field on its
        // own thread, and fold the chunk fields in order. Every cell is a
        // running `min`, and folding chunk minima in instance order applies
        // the same tie rule as the serial loop, so the field is
        // bit-identical to `from_meshes_serial`.
        let items: Vec<(&Mesh, Mat4)> = instances
            .into_iter()
            .filter_map(|(mesh, gt)| Some((meshes.get(&mesh.0)?, gt.to_matrix())))
            .collect();
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).clamp(1, 16);
        let chunk = items.len().div_ceil(threads).max(1);
        let parts: Vec<GroundField> = std::thread::scope(|scope| {
            let handles: Vec<_> = items
                .chunks(chunk)
                .map(|part| {
                    scope.spawn(move || {
                        let mut field = GroundField { cell_m, min_y: HashMap::new() };
                        for (mesh, matrix) in part {
                            field.add_mesh(mesh, matrix);
                        }
                        field
                    })
                })
                .collect();
            handles.into_iter().map(|handle| handle.join().expect("ground field thread panicked")).collect()
        });
        let mut field = GroundField { cell_m, min_y: HashMap::new() };
        for part in parts {
            if field.min_y.is_empty() {
                field.min_y = part.min_y;
                continue;
            }
            for (cell, y) in part.min_y {
                field.min_y.entry(cell).and_modify(|height| *height = height.min(y)).or_insert(y);
            }
        }
        field
    }

    /// The single-threaded reference [`Self::from_meshes`] must reproduce.
    #[cfg(test)]
    pub(crate) fn from_meshes_serial<'a>(
        meshes: &Assets<Mesh>,
        instances: impl IntoIterator<Item = (&'a Mesh3d, &'a GlobalTransform)>,
        cell_m: f32,
    ) -> GroundField {
        let mut field = GroundField { cell_m, min_y: HashMap::new() };
        for (mesh, gt) in instances {
            let Some(mesh) = meshes.get(&mesh.0) else { continue };
            field.add_mesh(mesh, &gt.to_matrix());
        }
        field
    }

    /// Fold one mesh instance into the field: every vertex's cell and every
    /// triangle's covered cell centres keep their minimum height.
    fn add_mesh(&mut self, mesh: &Mesh, gt: &Mat4) {
        let cell_m = self.cell_m;
        let Some(pos) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else { return };
        let bevy::mesh::VertexAttributeValues::Float32x3(values) = pos else { return };
        let positions: Vec<Vec3> = values.iter()
            .map(|v| gt.transform_point3(Vec3::from(*v)))
            .collect();
        for p in &positions {
            let key = (
                (p.x / cell_m).floor() as i64,
                (p.z / cell_m).floor() as i64,
            );
            self.min_y
                .entry(key)
                .and_modify(|y| *y = y.min(p.y))
                .or_insert(p.y);
        }
        if mesh.primitive_topology() == bevy::render::render_resource::PrimitiveTopology::TriangleList {
            if let Some(indices) = mesh.indices() {
                let mut indices = indices.iter();
                while let (Some(a), Some(b), Some(c)) = (indices.next(), indices.next(), indices.next()) {
                    self.rasterize_triangle(positions[a], positions[b], positions[c]);
                }
            } else {
                for triangle in positions.chunks_exact(3) {
                    self.rasterize_triangle(triangle[0], triangle[1], triangle[2]);
                }
            }
        }
    }

    fn rasterize_triangle(&mut self, a: Vec3, b: Vec3, c: Vec3) {
        let ab = b - a;
        let ac = c - a;
        let area = ab.x * ac.z - ab.z * ac.x;
        if area.abs() < 1.0e-8 {
            return;
        }
        let min = a.min(b).min(c);
        let max = a.max(b).max(c);
        let inv_area = area.recip();
        let x0 = (min.x / self.cell_m - 0.5).ceil() as i64;
        let x1 = (max.x / self.cell_m - 0.5).floor() as i64;
        let z0 = (min.z / self.cell_m - 0.5).ceil() as i64;
        let z1 = (max.z / self.cell_m - 0.5).floor() as i64;
        for cz in z0..=z1 {
            let z = (cz as f32 + 0.5) * self.cell_m - a.z;
            for cx in x0..=x1 {
                let x = (cx as f32 + 0.5) * self.cell_m - a.x;
                let u = (x * ac.z - z * ac.x) * inv_area;
                let v = (ab.x * z - ab.z * x) * inv_area;
                if u >= -1.0e-6 && v >= -1.0e-6 && u + v <= 1.0 + 1.0e-6 {
                    let y = a.y + u * ab.y + v * ac.y;
                    self.min_y.entry((cx, cz))
                        .and_modify(|height| *height = height.min(y))
                        .or_insert(y);
                }
            }
        }
    }

    /// Ground height under (x, z): the cell itself or the nearest populated
    /// cell within 20 m (cell-edge gaps); `None` further off the map.
    pub(crate) fn sample_covered(&self, x: f32, z: f32) -> Option<f32> {
        let (cx, cz) = ((x / self.cell_m).floor() as i64, (z / self.cell_m).floor() as i64);
        if let Some(y) = self.min_y.get(&(cx, cz)) {
            return Some(*y);
        }
        for ring in 1..=10i64 {
            let mut best: Option<(i64, f32)> = None;
            for dz in -ring..=ring {
                for dx in -ring..=ring {
                    if dx.abs() != ring && dz.abs() != ring {
                        continue;
                    }
                    if let Some(y) = self.min_y.get(&(cx + dx, cz + dz)) {
                        let d2 = dx * dx + dz * dz;
                        if best.is_none_or(|(bd, _)| d2 < bd) {
                            best = Some((d2, *y));
                        }
                    }
                }
            }
            if let Some((_, y)) = best {
                return Some(y);
            }
        }
        None
    }

    /// Median per-cell ground height across the whole scene, or `None` for
    /// an empty field. Median, not mean: a handful of cells under bridges
    /// or basements would drag a mean well below the street.
    fn median_y(&self) -> Option<f32> {
        if self.min_y.is_empty() {
            return None;
        }
        let mut ys: Vec<f32> = self.min_y.values().copied().collect();
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Some(ys[ys.len() / 2])
    }
}

/// The scene's placement height source (reported in the service `hello`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GroundSource {
    /// The map's ground derivative, identified by its sha256.
    GroundMesh { sha256: String },
    /// No ground derivative: the readiness field built from the rendered
    /// meshes. An explicit substitution for older map versions.
    LegacyMeshField,
}

/// World-Y ground height from the ground derivative under world (x, z).
pub(crate) fn ground_mesh_height(
    surface: &simforge_core::map::ground::GroundSurface,
    x: f32,
    z: f32,
) -> std::result::Result<f32, String> {
    let (xodr_x, xodr_y) = (f64::from(x), -f64::from(z));
    let hits = surface
        .surfaces_at(xodr_x, xodr_y)
        .map_err(|error| format!("[native_ground_height_unavailable] x={x:.2} z={z:.2}: {error}"))?;
    match hits.as_slice() {
        [] => Err(format!(
            "[native_ground_height_unavailable] x={x:.2} z={z:.2} is off the map's ground surface"
        )),
        [hit] => Ok(hit.z as f32),
        decks => Err(format!(
            "[native_ground_height_ambiguous] x={x:.2} z={z:.2} has {} stacked surfaces ({}) and no authored height to choose one",
            decks.len(),
            decks.iter().map(|hit| format!("{:.2} {}", hit.z, hit.class.as_str())).collect::<Vec<_>>().join(", ")
        )),
    }
}

// ---------------------------------------------------------------------------
// SceneApp
// ---------------------------------------------------------------------------

/// Bevy's default task pools, except that the IO pool (where the glTF
/// loader decodes and transcodes every map texture) gets a thread per core
/// instead of at most 4. The other pools keep their default sizes: the total
/// grows by exactly the extra IO threads, which sit idle after the map has
/// loaded. On Belmont's 2,305 UASTC textures the transcode is ~125 s of
/// CPU: 61 s on 4 threads, 13 s on 24 (measured by `ktx2_transcode_probe`).
fn map_load_task_pools() -> bevy::app::TaskPoolOptions {
    use bevy::app::{TaskPoolOptions, TaskPoolThreadAssignmentPolicy};
    let defaults = TaskPoolOptions::default();
    let cores = bevy::tasks::available_parallelism().max(1);
    // Bevy's own assignment (`TaskPoolThreadAssignmentPolicy::get_number_of_threads`).
    let share = |policy: &TaskPoolThreadAssignmentPolicy, remaining: usize| -> usize {
        let proportion = cores as f32 * policy.percent;
        let mut desired = proportion as usize;
        if proportion - desired as f32 >= 0.5 {
            desired += 1;
        }
        desired.min(remaining).clamp(policy.min_threads, policy.max_threads)
    };
    let default_io = share(&defaults.io, cores);
    let async_compute = share(&defaults.async_compute, cores.saturating_sub(default_io));
    let compute = share(&defaults.compute, cores.saturating_sub(default_io + async_compute));
    let fixed = |policy: &TaskPoolThreadAssignmentPolicy, threads: usize| TaskPoolThreadAssignmentPolicy {
        min_threads: threads,
        max_threads: threads,
        ..policy.clone()
    };
    let total = cores + async_compute + compute;
    TaskPoolOptions {
        min_total_threads: total,
        max_total_threads: total,
        io: fixed(&defaults.io, cores),
        async_compute: fixed(&defaults.async_compute, async_compute),
        compute: fixed(&defaults.compute, compute),
    }
}

/// Host-driven headless renderer over a resident tile scene.
///
/// The Bevy `App` is never `run()`; every [`Self::capture`] performs one
/// main-world + render-world iteration and returns the requested passes
/// copied from that iteration's submission.
pub struct SceneApp {
    app: App,
    receiver: crossbeam_channel::Receiver<SentPass>,
    groups: Vec<GroupEntities>,
    next_camera_order: isize,
    /// Private render layer per camera host actor (see [`FIRST_HOST_LAYER`]).
    host_layers: HashMap<String, usize>,
    /// See [`FrameIdentity`].
    scene_revision: u64,
    rig_revision: u64,
    generation: u64,
    #[cfg(feature = "gpu-interop")]
    device_receiver: crossbeam_channel::Receiver<SentDevice>,
    /// Open device streams by sensor id (see [`Self::open_device_stream`]).
    #[cfg(feature = "gpu-interop")]
    device_streams: HashMap<String, DeviceCopy>,
    ready: bool,
    /// Timing of the last capture (see [`CaptureStats`]).
    last_capture: CaptureStats,
    /// Phases of the last [`Self::wait_until_ready`], seconds (diagnostics).
    ready_phases: Vec<(&'static str, f64)>,
    /// Shared with the render world's `receive_passes`.
    readback_clock: ReadbackClock,
    /// See [`CaptureClock`]; `Free` until the host pins it.
    capture_clock: CaptureClock,
    /// Shared with the render world's seed/jitter overrides.
    pinned_sample: PinnedSample,
    /// Deferred readbacks the render world started ([`Self::capture_begin`]).
    deferred_maps: DeferredMaps,
    /// Bevy's GPU clustering setting before a pinned clock disabled it.
    gpu_clustering_default: Option<Option<bevy::light::cluster::GlobalClusterGpuSettings>>,
    /// Scene-state actors: id -> (cuboid entity, allocated instance id).
    actors: HashMap<String, (Entity, u32)>,
    /// Dynamic actor id -> (loaded catalog GLB root, authored scale, mesh count).
    actor_models: HashMap<String, (Entity, f32, usize)>,
    /// Rest transforms of articulated model nodes (`body`, `wheel_*`).
    actor_rest_poses: HashMap<String, HashMap<Entity, Transform>>,
    /// Layer-1 ID clone of each actor's cuboid; moved with the actor so the
    /// instance-ID pass never shows a body at its spawn pose.
    actor_id_clones: HashMap<String, Entity>,
    /// Per-actor cloned tint material handles. Catalog materials are shared
    /// assets, so tinting must never mutate the source GLB material.
    actor_tint_materials: HashMap<String, Vec<Handle<StandardMaterial>>>,
    /// Per-actor clones of palette-coloured material slots (ridden two-wheelers).
    actor_palette_materials: HashMap<String, Vec<Handle<StandardMaterial>>>,
    /// A ridden two-wheeler's rider: its own instance id (class `rider`) and
    /// the model mesh entities drawn under it, so the ID pass, semantic
    /// output and lidar/radar label the rider apart from the bike.
    actor_riders: HashMap<String, (u32, std::collections::HashSet<Entity>)>,
    /// Asset handles are retained by absolute path so repeated actor spawns
    /// instantiate an already-resident GLB rather than reloading it.
    actor_asset_cache: HashMap<String, Handle<Gltf>>,
    /// Deterministic, simulation-time-indexed skeletal animation bindings.
    actor_animations: HashMap<String, ActorAnimationBinding>,
    /// Instance id -> semantic class name for dynamically spawned actors.
    actor_classes: HashMap<u32, String>,
    /// Next instance id for dynamic actors (beyond the static legend range).
    next_instance_id: u32,
    /// Legacy coarse ground-height field (minimum surface Y per cell), built
    /// at readiness only when the scene has no ground derivative.
    ground: GroundField,
    /// The map's ground derivative (`derived/ground/ground-mesh.bin`): the
    /// one height source the simulator and the contact gate use. When set,
    /// every placement height comes from it and `ground` is never built.
    ground_surface: Option<simforge_core::map::ground::GroundSurface>,
    /// Sky cubemap spawned by the lighting ladder (rung ≥ 1), attached as a
    /// `Skybox` to every RGB camera.
    sky: Option<Handle<Image>>,
    /// Skybox brightness from the resolved `LightingPlan`.
    skybox_brightness: f32,
    /// Fixed EV100 from the resolved `LightingPlan` (spec §Exposure).
    ev100_fixed: f32,
    profile_config: RenderProfileConfig,
    /// Live lighting state, so `apply_lighting` can diff against it.
    lighting: Lighting,
    /// Distance fog attached to every RGB camera, when visibility asks for it.
    fog: Option<DistanceFog>,
    /// Pre-wetness material state, keyed by material asset, so the road ramp
    /// is reversible instead of a one-way destructive edit.
    dry_road_materials: HashMap<AssetId<StandardMaterial>, (f32, f32, Color)>,
    /// Handle of the [`ScatteringMedium`] the physical atmosphere resolves
    /// into. Reused across relights so the 1024x1024 density/phase LUT pair
    /// is replaced in place rather than leaked.
    medium: Option<Handle<bevy::light::atmosphere::ScatteringMedium>>,
    /// The planet entity carrying [`bevy::light::Atmosphere`].
    atmosphere_entity: Option<Entity>,
    /// Ground elevation the atmosphere origin is anchored to, world Y.
    atmosphere_ground_y: f32,
    /// Far plane the aerial-perspective LUT is currently fitted to.
    far_plane_m: f32,
    /// Audit of the last façade-window fit, reported to the lab.
    facade_windows: crate::facade_windows::FacadeStats,
    /// Sky parameters in force, so a camera registered *after* the relight
    /// still gets the sky pass. The service creates views lazily on the
    /// first render, which is after `apply_lighting` has already run.
    sky_pass: Option<crate::sky_pass::SkyPass>,
    /// Cloud beam transmittance along the sun ray the last relight solved
    /// from the volumetric field, so later readbacks and view registrations
    /// close against the same number.
    cloud_beam_t: Option<f32>,
    /// Light-texture handle carrying that transmittance onto the sun's
    /// surface lighting without touching the atmosphere solve.
    sun_cookie: Option<Handle<Image>>,
    /// The celestial `LightProbe` cubemap spawned by the last relight, so
    /// it can be released when the next one replaces it.
    probe_cubemap: Option<Handle<Image>>,
    /// Atmosphere IBL gain the last relight resolved, reused for views
    /// registered afterwards.
    env_gain: f32,
    /// Fit one directional cascade set to the whole RGB rig and render it
    /// once per frame ([`crate::shared_shadows`]).
    shared_shadows: bool,
    /// Distance LODs of the static map ([`crate::geometry_lod`]).
    geometry_lods: Option<crate::geometry_lod::GeometryLods>,
    /// Static master mesh entity -> its ID-pass clone and ID material.
    id_clone_of: HashMap<Entity, (Entity, Handle<StandardMaterial>)>,
    /// Resolved render config ([`Self::apply_render_config`]).
    render_config: Option<crate::render_config::RenderConfig>,
}

impl SceneApp {
    /// Build the headless app with lights and render-world plumbing.
    ///
    /// Fails when the lighting ladder cannot be built (e.g. an unreadable
    /// `sky_hdr`).
    pub fn new(lighting: &Lighting) -> Result<Self> {
        Self::new_with_profile_config(lighting, RenderProfileConfig::default())
    }

    pub fn new_with_profile_config(
        lighting: &Lighting,
        profile_config: RenderProfileConfig,
    ) -> Result<Self> {
        profile_config.cinematic.validate()?;
        // Star/Moon plates are part of the resident scene's look at every
        // hour; an engine without them would silently render a starless sky.
        let sky_assets = crate::sky_pass::SkyAssetPaths::resolve()?;
        std::env::set_var("BEVY_ASSET_ROOT", crate::platform::ASSET_ROOT);
        let (tx, rx) = crossbeam_channel::unbounded::<SentPass>();
        #[cfg(feature = "gpu-interop")]
        let (device_tx, device_rx) = crossbeam_channel::unbounded::<SentDevice>();
        let mut app = App::new();
        // The reusable job/service engine may render sensor and cinematic
        // views together. PCSS is stochastic on current wgpu/Bevy and made
        // sensor RGB hashes differ between identical replays, so mixed
        // SceneApp lighting is capped at deterministic hard cascades.
        // The standalone cinematic CLI still exposes rung-4 PCSS.
        lighting.validate_for_scene_app()?;
        let rung = LightingRung(lighting.rung);
        let (plan, _resolved) = lighting.resolve();
        let sun_dir = sun_direction(lighting.sun_elev_deg, lighting.sun_azim_deg);
        // Black, not a sky colour: under the physical atmosphere the sky
        // pass composites *over* whatever the target was cleared to, and at
        // night the clear colour would show straight through the LUT's
        // transmittance as a daylight-blue wash. The cubemap path draws a
        // Skybox over the clear anyway.
        // Exportable Vulkan memory/semaphores must be negotiated at device
        // creation; `gpu_interop` owns that configuration (Linux only).
        #[cfg(feature = "gpu-interop")]
        app.insert_resource(crate::gpu_interop::raw_vulkan_init_settings());
        // A device error (out of memory, device lost, validation) stops
        // rendering for good: record it so every wait fails at once with the
        // cause instead of timing out on frames that never come.
        app.init_resource::<RenderFailure>()
            .insert_resource(bevy::render::error_handler::RenderErrorHandler(|error, main_world, _| {
                let cause = format!("{:?} {}", error.ty, error.description).trim_end().to_string();
                main_world.resource_mut::<RenderFailure>().0.get_or_insert(cause);
                bevy::render::error_handler::RenderErrorPolicy::StopRendering
            }));
        app.insert_resource(ClearColor(Color::BLACK))
            .insert_resource(DirectionalLightShadowMap { size: 2048 })
            .insert_resource(Legend::default())
            .init_resource::<CaptureRequest>()
            .init_resource::<HostLayerUnion>()
            .add_plugins((
                DefaultPlugins
                    .set(bevy::app::TaskPoolPlugin { task_pool_options: map_load_task_pools() })
                    .set(crate::platform::asset_plugin())
                    // Device creation on the backend this OS is qualified
                    // for (Vulkan / Metal / DX12); the resident engine keeps
                    // asynchronous pipeline compilation.
                    .set(crate::platform::render_plugin(false))
                    .set(WindowPlugin {
                        primary_window: None,
                        exit_condition: ExitCondition::DontExit,
                        ..default()
                    })
                    .disable::<bevy::winit::WinitPlugin>()
                    .disable::<bevy::audio::AudioPlugin>()
                    // The pipelined renderer steps the render app on its own
                    // thread driven by App::run(); our host-controlled update
                    // loop requires in-line render stepping.
                    .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>()
                    .set(LogPlugin {
                        filter: "warn,wgpu_core=warn,wgpu_hal=warn,naga=warn".into(),
                        ..default()
                    }),
                ScheduleRunnerPlugin::run_loop(Duration::ZERO),
                crate::road_detail::RoadDetailPlugin,
                crate::sky_pass::SkyPassPlugin { assets: sky_assets },
                crate::camera_model::CameraModelPlugin,
                crate::readiness::GpuReadinessPlugin,
                crate::shared_shadows::SharedShadowsPlugin,
            ))
            .init_resource::<ShadowCascadeSettings>()
            .add_systems(
                PostUpdate,
                enforce_shadow_cascades
                    .before(bevy::light::SimulationLightSystems::UpdateDirectionalLightCascades),
            )
            .add_systems(
                Update,
                (
                    spawn_loaded_tiles,
                    crate::veg::load_veg_roots,
                    crate::veg::instantiate_veg,
                    sync_light_layers,
                )
                    .chain(),
            );

        // Lighting ladder. Spawned through Commands so the exact same
        // `spawn_lighting` path serves the CLI, the job runner and the
        // service. Under `Lighting::atmosphere` the sky, the IBL and the
        // aerial perspective come from `crate::atmosphere` instead of a
        // cubemap (see that module's header for why the built-in Bevy
        // implementation is the one used).
        let sky_mode = if lighting.atmosphere {
            lighting::SkyMode::Physical
        } else {
            lighting::SkyMode::Cubemap
        };
        let sky = {
            let world = app.world_mut();
            let sky = world.resource_scope(|world, mut images: Mut<Assets<Image>>| {
                let mut commands = world.commands();
                lighting::spawn_lighting(
                    &mut commands,
                    &mut images,
                    rung,
                    &plan,
                    sun_dir,
                    400.0,
                    lighting.sky_hdr.as_deref(),
                    sky_mode,
                    (
                        lighting.sun_lux * lighting.sun_scale.max(0.0),
                        lighting.ambient * lighting.ambient_scale.max(0.0),
                    ),
                )
            })?;
            world.flush();
            sky
        };

        let atmosphere_ground_y = lighting.ground_y.unwrap_or(lighting::GROUND_Y);
        let mut medium_handle = None;
        let mut atmosphere_entity = None;
        if lighting.atmosphere {
            let (entity, handle) = Self::spawn_atmosphere(
                app.world_mut(),
                lighting,
                &None,
                atmosphere_ground_y,
                DEFAULT_FAR_PLANE_M,
            );
            atmosphere_entity = Some(entity);
            medium_handle = Some(handle);
        }

        let readback_clock = ReadbackClock::default();
        let pinned_sample = PinnedSample::default();
        let deferred_maps = DeferredMaps::default();
        let render_app = app.get_sub_app_mut(RenderApp).unwrap();
        render_app
            .insert_resource(RenderSender(tx))
            .insert_resource(readback_clock.clone())
            .insert_resource(deferred_maps.clone())
            .insert_resource(pinned_sample.clone())
            .add_systems(
                Render,
                (
                    pin_taa_jitter.in_set(RenderSystems::Queue),
                    pin_shader_noise_seed.in_set(RenderSystems::PrepareBindGroups),
                ),
            )
            .init_resource::<Staging>()
            .init_resource::<ExtractedTargets>()
            .init_resource::<ExtractedCapture>()
            .add_systems(ExtractSchedule, extract_capture)
            .add_systems(
                RenderGraph,
                copy_passes
                    .after(RenderGraphSystems::Render)
                    .before(RenderGraphSystems::Submit),
            )
            .add_systems(
                Render,
                (
                    sync_staging.in_set(RenderSystems::Prepare),
                    receive_passes.after(RenderSystems::Render),
                ),
            );
        #[cfg(feature = "gpu-interop")]
        render_app.insert_resource(DeviceSender(device_tx)).add_systems(
            RenderGraph,
            copy_device_passes
                .after(RenderGraphSystems::Render)
                .before(RenderGraphSystems::Submit),
        );
        // A reconfigured look can drop the motion-vector prepass from a live
        // view; Bevy's background motion-vector pipeline id stays on the
        // retained render-world view and no longer matches its prepass.
        render_app.add_systems(
            bevy::render::Render,
            drop_stale_background_motion_vectors.in_set(bevy::render::RenderSystems::PrepareBindGroups),
        );

        // Opt-in GPU pass timing (timestamp queries + pipeline statistics per
        // Bevy render pass, plus a whole-frame timer), read back through
        // [`Self::take_gpu_pass_times`] / [`Self::take_gpu_frame_times`].
        // Profiling only: the queries add encoder work, so production never
        // sets the variable.
        if crate::gpu_diagnostics::enabled() {
            app.add_plugins(bevy::render::diagnostic::RenderDiagnosticsPlugin);
            crate::gpu_diagnostics::install_frame_timer(&mut app);
        }

        // Drive the plugin lifecycle to completion manually (we never call
        // app.run()): pump updates until plugins are built, then finish so the
        // render world has its RenderDevice before cameras register readbacks.
        while app.plugins_state() != bevy::app::PluginsState::Ready {
            app.update();
        }
        app.finish();
        app.cleanup();
        // Finish the frame's command encoders in parallel at submission
        // (vendored bevy_render patch). Order and content of the submitted
        // command buffers are unchanged, so output is identical; only
        // wgpu-core's HAL recording leaves the render thread.
        // SIMFORGE_ENCODER_FINISH_THREADS=1 restores serial finishing.
        {
            let threads = std::env::var("SIMFORGE_ENCODER_FINISH_THREADS")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()).min(16)); // fallback-ok: thread count only; output does not depend on it
            app.sub_app_mut(RenderApp)
                .insert_resource(EncoderFinishThreads(threads))
                // Counts directional shadow views whose camera the vendored
                // bevy_render could not resolve for LOD selection (a
                // correct frame adds nothing; see the regression test).
                .init_resource::<bevy::render::view::DirectionalShadowLodMisses>()
                .add_systems(RenderGraph, apply_encoder_finish_threads.in_set(RenderGraphSystems::Begin));
        }
        // A CPU or virtual adapter (lavapipe, llvmpipe, SwiftShader) renders a
        // different image than the qualified GPU: never silently. It is an
        // explicit, logged opt-in for tests and tooling.
        if let Some(info) = app.world().get_resource::<bevy::render::renderer::RenderAdapterInfo>() {
            let info = &info.0;
            eprintln!(
                "render-adapter: {} ({:?}, {:?}, driver {} {})",
                info.name, info.device_type, info.backend, info.driver, info.driver_info
            );
            let device_type = format!("{:?}", info.device_type);
            if matches!(device_type.as_str(), "Cpu" | "VirtualGpu")
                && std::env::var("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER").as_deref() != Ok("1")
            {
                bail!(
                    "[native_gpu_adapter_software] adapter {} is a {:?} device; set SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER=1 to render on it explicitly",
                    info.name, info.device_type
                );
            }
        } else {
            bail!("[native_gpu_adapter_unknown] the render device reported no adapter information");
        }
        Ok(Self {
            app,
            receiver: rx,
            groups: Vec::new(),
            next_camera_order: 0,
            host_layers: HashMap::new(),
            scene_revision: 0,
            rig_revision: 0,
            generation: 0,
            #[cfg(feature = "gpu-interop")]
            device_receiver: device_rx,
            #[cfg(feature = "gpu-interop")]
            device_streams: HashMap::new(),
            ready: false,
            last_capture: CaptureStats::default(),
            ready_phases: Vec::new(),
            readback_clock,
            capture_clock: CaptureClock::Free,
            pinned_sample,
            deferred_maps,
            gpu_clustering_default: None,
            actors: HashMap::new(),
            actor_models: HashMap::new(),
            actor_rest_poses: HashMap::new(),
            actor_id_clones: HashMap::new(),
            actor_tint_materials: HashMap::new(),
            actor_palette_materials: HashMap::new(),
            actor_riders: HashMap::new(),
            actor_asset_cache: HashMap::new(),
            actor_animations: HashMap::new(),
            actor_classes: HashMap::new(),
            next_instance_id: 0,
            ground: GroundField::default(),
            ground_surface: None,
            sky,
            skybox_brightness: plan.skybox_brightness,
            ev100_fixed: plan.ev100_fixed.unwrap_or_else(|| {
                lighting.weather.sensor_ev100(lighting.sun_elev_deg)
            }),
            profile_config,
            lighting: lighting.clone(),
            fog: if lighting.atmosphere {
                // The aerial-perspective LUT already integrates extinction
                // and inscattering over the same medium; adding DistanceFog
                // would apply the haze a second time.
                None
            } else {
                lighting.fog_for(&plan).map(|(density, _, color)| DistanceFog {
                    color,
                    directional_light_color: Color::srgb(1.0, 0.95, 0.86),
                    directional_light_exponent: 30.0,
                    falloff: FogFalloff::ExponentialSquared { density },
                })
            },
            dry_road_materials: HashMap::new(),
            medium: medium_handle,
            atmosphere_entity,
            atmosphere_ground_y,
            far_plane_m: DEFAULT_FAR_PLANE_M,
            facade_windows: crate::facade_windows::FacadeStats::default(),
            sky_pass: None,
            cloud_beam_t: None,
            sun_cookie: None,
            probe_cubemap: None,
            env_gain: 1.0,
            shared_shadows: false,
            geometry_lods: None,
            id_clone_of: HashMap::new(),
            render_config: None,
        })
    }

    /// Share one directional cascade set across every RGB camera
    /// ([`crate::shared_shadows`]). Applies to registered and future views.
    pub fn set_shared_shadows(&mut self, enabled: bool) {
        self.shared_shadows = enabled;
        let entities: Vec<Entity> = self.groups.iter().map(|g| g.rgb_entity).collect();
        let world = self.app.world_mut();
        for entity in entities {
            let mut e = world.entity_mut(entity);
            if enabled {
                e.insert(crate::shared_shadows::SharedShadowView);
            } else {
                e.remove::<crate::shared_shadows::SharedShadowView>();
            }
        }
    }

    /// Apply the non-look knobs of a resolved [`crate::render_config::RenderConfig`]
    /// (the look itself is the `RenderProfileConfig` the app was built and
    /// relit with: `config.profile_config()`). Call before loading tiles.
    pub fn apply_render_config(&mut self, config: &crate::render_config::RenderConfig) -> Result<()> {
        use crate::render_config::ClockMode;
        config.validate()?;
        self.render_config = Some(*config);
        self.set_shared_shadows(config.shadows.shared);
        {
            let world = self.app.world_mut();
            world.resource_mut::<DirectionalLightShadowMap>().size = config.shadows.map_size as usize;
            *world.resource_mut::<ShadowCascadeSettings>() = ShadowCascadeSettings {
                cascades: config.shadows.cascades,
                max_distance_m: config.shadows.max_distance_m,
            };
        }
        self.set_capture_clock(match config.clock.mode {
            ClockMode::Free => CaptureClock::Free,
            ClockMode::Pinned => CaptureClock::Pinned {
                samples: if config.aa.mode == crate::profiles::AntiAlias::Taa { config.aa.taa_samples } else { 1 },
            },
        });
        let threads = match config.encode.finish_threads {
            0 => std::thread::available_parallelism().map_or(1, |n| n.get()).min(16), // fallback-ok: thread count only; output does not depend on it
            n => n as usize,
        };
        self.app.sub_app_mut(RenderApp).insert_resource(EncoderFinishThreads(threads));
        if let Some(lods) = &mut self.geometry_lods {
            lods.pixel_error_px = config.lod.pixel_error_px;
            lods.applied_f_px = None;
        }
        self.refresh_lod_ranges();
        Ok(())
    }

    /// Reconfigure a running app: the non-look knobs, then a relight with
    /// the config's look (re-applies every camera's effects). Output after
    /// the next readiness settle is what a fresh app with this config
    /// renders (history-free pinned captures).
    pub fn reconfigure(&mut self, config: &crate::render_config::RenderConfig) -> Result<()> {
        self.apply_render_config(config)?;
        let lighting = self.lighting.clone();
        self.apply_lighting(&lighting, config.profile_config())?;
        Ok(())
    }

    /// `lighting` with the render config's haze density (the authored
    /// lighting never carries it).
    fn with_render_config_haze(&self, lighting: &Lighting) -> Lighting {
        Lighting {
            haze_density: self.render_config.map_or(1.0, |config| config.atmosphere.haze_density), // fallback-ok: without a render config the weather's own haze (density 1)
            ..lighting.clone()
        }
    }

    /// The resolved render config this app runs with, if one was applied.
    pub fn render_config(&self) -> Option<crate::render_config::RenderConfig> {
        self.render_config
    }

    /// Take one camera in or out of the shared cascade set (for example a
    /// narrow presentation camera that should keep its own tight fit).
    /// No-op unless shared shadows are enabled.
    pub fn set_camera_shared_shadows(&mut self, sensor_id: &str, shared: bool) {
        if !self.shared_shadows {
            return;
        }
        let Some(entity) = self.groups.iter().find(|g| g.spec.sensor_id == sensor_id).map(|g| g.rgb_entity) else {
            return;
        };
        let mut e = self.app.world_mut().entity_mut(entity);
        let marked = e.contains::<crate::shared_shadows::SharedShadowView>();
        if shared && !marked {
            e.insert(crate::shared_shadows::SharedShadowView);
        } else if !shared && marked {
            e.remove::<crate::shared_shadows::SharedShadowView>();
        }
    }

    /// Whole-frame GPU times (ms) completed since the last call; empty unless
    /// [`crate::gpu_diagnostics::enabled`].
    pub fn take_gpu_frame_times(&mut self) -> Vec<f64> {
        crate::gpu_diagnostics::take_frame_times(self.app.world())
    }

    /// The render sub-app's world (profiling tools only: phase statistics).
    pub fn render_world_mut(&mut self) -> &mut World {
        self.app.sub_app_mut(bevy::render::RenderApp).world_mut()
    }

    /// Direct world access for profiling tools and ablation experiments
    /// (`simforge-render job --ablate`). Production paths go through the typed methods.
    pub fn world_mut(&mut self) -> &mut World {
        self.app.world_mut()
    }

    /// Drain the GPU pass timings recorded since the last call (see
    /// [`crate::gpu_diagnostics`]). Empty unless diagnostics are enabled.
    pub fn take_gpu_pass_times(&mut self) -> Vec<crate::gpu_diagnostics::PassTotal> {
        crate::gpu_diagnostics::drain(self.app.world_mut())
    }

    /// Spawn (or re-point) the planet entity and its scattering medium.
    ///
    /// The planet centre goes `inner_radius` below `ground_y`, so scene
    /// altitude is measured from the corpus ground plane rather than from
    /// world origin — which matters, because the boundary-layer fog term has
    /// a 300 m scale height and the scene sits ~13 m above y = 0.
    fn spawn_atmosphere(
        world: &mut bevy::ecs::world::World,
        lighting: &Lighting,
        existing_medium: &Option<Handle<bevy::light::atmosphere::ScatteringMedium>>,
        ground_y: f32,
        far_plane_m: f32,
    ) -> (Entity, Handle<bevy::light::atmosphere::ScatteringMedium>) {
        let inputs = lighting.atmosphere_inputs(None);
        let (medium, _) =
            crate::atmosphere::resolve(&inputs, lighting.sun_azim_deg, far_plane_m);
        let handle = {
            let mut media = world
                .resource_mut::<Assets<bevy::light::atmosphere::ScatteringMedium>>();
            crate::atmosphere::upload_medium(&mut media, existing_medium, medium)
        };
        let entity = world
            .spawn((
                crate::atmosphere::atmosphere(&inputs, handle.clone()),
                Transform::from_xyz(
                    0.0,
                    ground_y - crate::atmosphere::INNER_RADIUS_M,
                    0.0,
                ),
                GlobalTransform::from(Transform::from_xyz(
                    0.0,
                    ground_y - crate::atmosphere::INNER_RADIUS_M,
                    0.0,
                )),
                AtmosphereMarker,
            ))
            .id();
        world.flush();
        (entity, handle)
    }

    /// Put the volumetric field's sun-beam transmittance on the sun as a
    /// light texture.
    ///
    /// Bevy's atmosphere reads every `DirectionalLight` as a sun, so scaling
    /// the light's illuminance by the cloud transmittance would also darken
    /// the Rayleigh sky seen through the gaps and the sky IBL. A
    /// `DirectionalLightTexture` is read only by surface lighting
    /// (`pbr_lighting.wgsl`), which is exactly the part the clouds shadow.
    /// The texture is a single texel: the beam transmittance at the observer.
    fn apply_sun_cookie(&mut self, transmittance: f32) {
        let world = self.app.world_mut();
        let suns: Vec<Entity> = {
            let mut q = world.query_filtered::<
                Entity,
                (With<lighting::VolumetricLightMarker>, With<DirectionalLight>),
            >();
            q.iter(world).collect()
        };
        if suns.is_empty() {
            return;
        }
        let value = transmittance.clamp(0.0, 1.0);
        let image = Image::new(
            Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            TextureDimension::D2,
            // R8: the decal sampler filters, and 32-bit float is not a
            // filterable format without an extra device feature.
            vec![(value * 255.0).round() as u8],
            TextureFormat::R8Unorm,
            RenderAssetUsages::RENDER_WORLD,
        );
        let handle = {
            let mut images = world.resource_mut::<Assets<Image>>();
            match &self.sun_cookie {
                Some(existing) => {
                    images.insert(existing.id(), image);
                    existing.clone()
                }
                None => images.add(image),
            }
        };
        self.sun_cookie = Some(handle.clone());
        for sun in suns {
            world.entity_mut(sun).insert(bevy::light::DirectionalLightTexture {
                image: handle.clone(),
                tiled: true,
            });
        }
    }

    /// Move the atmosphere origin onto the scene's own ground plane once
    /// tiles have loaded. Only meaningful for the physical sky.
    fn reanchor_atmosphere(&mut self, ground_y: f32) {
        if (ground_y - self.atmosphere_ground_y).abs() < 0.5 {
            return;
        }
        self.atmosphere_ground_y = ground_y;
        let Some(entity) = self.atmosphere_entity else {
            return;
        };
        let y = ground_y - crate::atmosphere::INNER_RADIUS_M;
        let world = self.app.world_mut();
        let transform = Transform::from_xyz(0.0, y, 0.0);
        if let Ok(mut e) = world.get_entity_mut(entity) {
            e.insert((transform, GlobalTransform::from(transform)));
        }
    }

    /// Everything a relight resolves before it touches the world.
    ///
    /// Shared by [`Self::apply_lighting`] (full respawn) and
    /// [`Self::advance_lighting`] (in-place update for time-lapses), so the
    /// two can never disagree about the sun, the exposure or the clouds.
    fn resolve_relight(
        &mut self,
        lighting: &Lighting,
        profile_config: &RenderProfileConfig,
        smooth_beam: bool,
    ) -> Relight {
        let camera_eye = {
            let world = self.app.world_mut();
            let mut views = world.query_filtered::<&GlobalTransform, With<Camera3d>>();
            views.iter(world).next().map(GlobalTransform::translation)
        };
        let mut night_controls = lighting.night.clone();
        if let Some(eye) = camera_eye {
            night_controls.fixtures.sort_by(|a, b| {
                Vec3::from_array(a.position).distance_squared(eye)
                    .total_cmp(&Vec3::from_array(b.position).distance_squared(eye))
            });
        }

        // One cloud model at every hour: the volumetric field the sky pass
        // marches. The same field attenuates the Sun's and the Moon's beams
        // and shapes the IBL, so the picture and the lighting never disagree
        // about where the clouds are.
        let cloud_params = lighting.cloud_params({
            let step = night_controls.cloud_fixed_step_s.clamp(0.0, 1.0);
            if let Some(mut clock) = self
                .app
                .world_mut()
                .get_resource_mut::<crate::sky_pass::SkyClock>()
            {
                clock.fixed_step = (step > 0.0).then_some(step);
                clock.seconds as f32
            } else {
                0.0
            }
        });
        let clouds_drawn = lighting.atmosphere
            && cloud_params.cover > 0.0
            && night_controls.cloud_quality != crate::night::CloudQuality::Off;
        let sun_dir = sun_direction(lighting.sun_elev_deg, lighting.sun_azim_deg);
        // `sun_direction` is the direction light travels; the field wants
        // the direction *towards* the source.
        let to_sun = -Vec3::from(sun_dir);
        let sampled_t = if clouds_drawn && to_sun.y > 0.004 {
            let field = self.app.world().resource::<crate::clouds::CloudField>();
            field.transmittance(Vec2::ZERO, 0.0, to_sun, &cloud_params, 48)
        } else {
            1.0
        };
        // The beam is one sample of the drifting field at the observer,
        // applied uniformly (the cloud shadow is not spatial). Re-read every
        // frame of a clip it flickered — a 48-step sample of a moving
        // field is noisy — so between in-place advances it is low-passed
        // with a two-second cloud-time constant; a full relight starts
        // from the fresh sample.
        let sun_cloud_t = match (smooth_beam, self.cloud_beam_t) {
            (true, Some(previous)) => {
                let dt = night_controls.cloud_fixed_step_s.clamp(0.0, 1.0);
                let dt = if dt > 0.0 { dt } else { 1.0 / 30.0 };
                let alpha = (dt / CLOUD_BEAM_SMOOTHING_S).clamp(0.0, 1.0);
                previous + (sampled_t - previous) * alpha
            }
            _ => sampled_t,
        };
        self.cloud_beam_t = lighting.atmosphere.then_some(sun_cloud_t);

        let (plan, mut resolved) =
            lighting.resolve_for(self.far_plane_m, self.cloud_beam_t);
        // One camera EV exposes everything (see `resolve_atmosphere`), so
        // every source is spawned at its nominal physical value: the
        // renderer-internal scale is 1 and the ledger reports it as such.
        let internal_scale = 1.0;
        let use_atmosphere = atmosphere_view_active(lighting);
        let deck_diffuse_gain = resolved
            .atmosphere
            .as_ref()
            .map(|a| a.deck_diffuse_gain)
            .unwrap_or(1.0);
        // Above the probe handover the ambient is the atmosphere's own sky
        // IBL, lifted by the deck's re-radiated diffuse light. Below it the
        // explicit celestial probe (twilight sky, Moon, skyglow, clouds)
        // takes over: a `LightProbe` replaces the view IBL wherever it
        // reaches, so the two are never summed.
        let env_gain = if lighting.sun_elev_deg <= PROBE_HANDOVER_ELEVATION_DEG {
            0.0
        } else {
            plan.env_intensity * deck_diffuse_gain * atmosphere_ibl_gain(lighting.sun_elev_deg)
        };
        let moon_shadows = matches!(night_controls.cloud_quality, crate::night::CloudQuality::Lookdev);
        let mut night_environment = crate::night::resolve_night(
            &night_controls,
            internal_scale,
            moon_shadows,
        );
        let moon_dir_for_cloud = Vec3::from_array(night_environment.frame.moon_dir);
        let (moon_cloud_t, zenith_tau) = if clouds_drawn {
            let field = self.app.world().resource::<crate::clouds::CloudField>();
            (
                field.transmittance(Vec2::ZERO, 0.0, moon_dir_for_cloud, &cloud_params, 48),
                field.optical_depth(Vec2::ZERO, 0.0, Vec3::Y, &cloud_params, 48),
            )
        } else {
            (1.0, 0.0)
        };
        // The raymarch attenuates the visible disc itself, so the sky pass
        // needs the illuminance arriving at the top of the deck.
        let moon_direct_precloud = night_environment.celestial.direct_normal_lux;
        night_environment.celestial.direct_normal_lux *= moon_cloud_t;
        night_environment.celestial.horizontal_lux *= moon_cloud_t;
        night_environment.cloud_beam_transmittance = moon_cloud_t;
        night_environment.cloud_zenith_optical_depth = zenith_tau;
        night_environment.cloud_animation_seconds = cloud_params.time_s;
        night_environment.cloud_wind_offset_m = [
            cloud_params.wind.x * cloud_params.time_s,
            cloud_params.wind.y * cloud_params.time_s,
        ];
        night_environment.cloud_continuous = clouds_drawn;
        if let Some(moon) = night_environment.source_ledger.iter_mut().find(|s| s.id == "moon") {
            moon.nominal_value = night_environment.celestial.direct_normal_lux;
            moon.renderer_internal_value = moon.nominal_value * internal_scale;
            moon.provenance.push_str(&format!(
                "; x{moon_cloud_t:.4} cloud transmittance from the same volumetric field the sky pass marches"
            ));
        }
        let night_lx = night_ledger_illuminance_lx(lighting);
        let (incident_ev100, sky_highlight_ev100) = resolved
            .atmosphere
            .as_ref()
            .map(|a| meter_readings(a, night_lx))
            .unwrap_or((resolved.ev100, None));
        resolved.applied_physical = lighting.atmosphere.then_some(AppliedPhysicalLighting {
            applied_grading_exposure_ev: profile_config.cinematic.grading_exposure,
            scene_ev100: resolved.ev100,
            meter_illuminance_lx: resolved
                .atmosphere
                .as_ref()
                .map(|a| a.total_horizontal_illuminance_lx)
                .unwrap_or(0.0)
                + night_lx,
            night_ledger_illuminance_lx: night_lx,
            incident_ev100,
            sky_highlight_ev100,
            atmosphere_environment_gain: env_gain,
            global_ambient_enabled: false,
            camera_headlamp_enabled: false,
            atmosphere_sky_pass: use_atmosphere,
            gpu_dark_lut_seed_lx: if resolved.sun_lux == 0.0 { 1.0e-8 } else { 0.0 },
        });
        resolved.night_environment = Some(night_environment.clone());
        Relight {
            plan,
            resolved,
            night_controls,
            night_environment,
            cloud_params,
            sun_dir,
            sun_cloud_t,
            moon_direct_precloud,
            env_gain,
            internal_scale,
            camera_eye,
        }
    }

    /// Re-light a live scene in place.
    ///
    /// Respawns the lighting ladder, rebuilds every registered RGB camera's
    /// profile stack, retunes the atmosphere (or the legacy distance fog)
    /// and drives the wet-road ramp. Tiles, vegetation, the instance-ID pass
    /// and the render targets are left alone, so the cost is one medium LUT
    /// rebuild plus one update — not a scene reload. Returns the engine
    /// values that were applied.
    pub fn apply_lighting(
        &mut self,
        lighting: &Lighting,
        profile_config: RenderProfileConfig,
    ) -> Result<ResolvedLighting> {
        profile_config.cinematic.validate()?;
        let lighting = &self.with_render_config_haze(lighting);
        lighting.validate_for_scene_app()?;
        self.scene_revision += 1;
        let rung = LightingRung(lighting.rung);
        let Relight {
            plan,
            mut resolved,
            night_controls,
            mut night_environment,
            cloud_params,
            sun_dir,
            sun_cloud_t,
            moon_direct_precloud,
            env_gain,
            internal_scale,
            camera_eye,
        } = self.resolve_relight(lighting, &profile_config, false);
        let use_atmosphere = atmosphere_view_active(lighting);
        let sky_mode = if lighting.atmosphere {
            lighting::SkyMode::Physical
        } else {
            lighting::SkyMode::Cubemap
        };

        let previous_sky = self.sky.take();
        let previous_atmosphere = self.atmosphere_entity.take();
        {
            let world = self.app.world_mut();
            let mut stale: Vec<Entity> = Vec::new();
            let mut suns =
                world.query_filtered::<Entity, With<lighting::VolumetricLightMarker>>();
            stale.extend(suns.iter(world));
            let mut probes = world.query_filtered::<Entity, With<LightProbe>>();
            stale.extend(probes.iter(world));
            let mut night_lights = world.query_filtered::<Entity, With<NightLightMarker>>();
            stale.extend(night_lights.iter(world));
            if let Some(entity) = previous_atmosphere {
                stale.push(entity);
            }
            for entity in stale {
                world.despawn(entity);
            }
            // `GlobalAmbientLight` is a resource, not a spawnable entity, so
            // it cannot be swept with the rest of the ladder. Clear it here
            // instead: the rung-0 branch of `spawn_lighting` re-inserts it,
            // and any other rung must not inherit a stale flat ambient.
            world.insert_resource(GlobalAmbientLight::NONE);
            if let Some(handle) = previous_sky {
                world.resource_mut::<Assets<Image>>().remove(&handle);
            }
        }

        // Below the probe handover the ambient is the explicit celestial
        // probe. It carries the twilight sky as well, closed against the
        // same diffuse illuminance the atmosphere meter read, so crossing
        // the handover does not step the ambient.
        let probe_cubemap = (lighting.atmosphere
            && lighting.sun_elev_deg <= PROBE_HANDOVER_ELEVATION_DEG)
            .then(|| {
                let (daylight, ground) = probe_daylight(resolved.atmosphere.as_ref());
                let field = self.app.world().resource::<crate::clouds::CloudField>();
                crate::night::celestial_ibl_cubemap(
                    &night_environment,
                    field,
                    &cloud_params,
                    daylight.as_ref(),
                    ground,
                    64,
                    internal_scale,
                )
            });
        let previous_probe = self.probe_cubemap.take();
        if let Some(handle) = previous_probe {
            self.app.world_mut().resource_mut::<Assets<Image>>().remove(&handle);
        }
        let sky = {
            let world = self.app.world_mut();
            let (sky, probe) = world.resource_scope(|world, mut images: Mut<Assets<Image>>| {
                let mut commands = world.commands();
                let legacy = lighting::spawn_lighting(
                    &mut commands,
                    &mut images,
                    rung,
                    &plan,
                    sun_dir,
                    400.0,
                    lighting.sky_hdr.as_deref(),
                    sky_mode,
                    (
                        lighting.sun_lux * lighting.sun_scale.max(0.0),
                        lighting.ambient * lighting.ambient_scale.max(0.0),
                    ),
                )?;
                let probe = probe_cubemap.map(|image| {
                    let handle = images.add(image);
                    commands.spawn((
                        LightProbe::default(),
                        Transform::from_scale(Vec3::splat(1_000_000.0)),
                        bevy::light::EnvironmentMapLight {
                            diffuse_map: handle.clone(),
                            specular_map: handle.clone(),
                            intensity: 1.0,
                            rotation: Quat::IDENTITY,
                            affects_lightmapped_mesh_diffuse: true,
                        },
                    ));
                    handle
                });
                Ok::<_, anyhow::Error>((legacy, probe))
            })?;
            world.flush();
            self.probe_cubemap = probe;
            sky
        };
        // The sun's cloud transmittance rides on a light texture: it scales
        // the beam on every surface without entering the atmosphere solve,
        // so the Rayleigh sky seen through the gaps keeps its full sun.
        self.apply_sun_cookie(sun_cloud_t);
        let facade_stats = crate::facade_windows::spawn(
            self.app.world_mut(),
            if lighting.sun_elev_deg <= NIGHT_SOURCES_ELEVATION_DEG {
                night_controls.window_mode
            } else {
                crate::night::WindowMode::Off
            },
            internal_scale,
            0x5EED_1A2B,
            camera_eye.unwrap_or(Vec3::from_array(night_controls.observer_position)),
        );
        self.facade_windows = facade_stats;
        resolved.facade_windows = Some(facade_stats);
        spawn_night_sources(
            self.app.world_mut(),
            lighting,
            &night_controls,
            &night_environment,
            internal_scale,
        );
        // Dedicated window primitives light in every mode but `Off`: the
        // synthetic façade cards fill in where the map has no window
        // materials, they do not replace the ones it has.
        let physical_window_primitives = update_physical_windows(
            self.app.world_mut(),
            lighting.sun_elev_deg <= NIGHT_SOURCES_ELEVATION_DEG
                && night_controls.window_mode != crate::night::WindowMode::Off,
            internal_scale,
        )?;
        if physical_window_primitives > 0 {
            night_environment.source_ledger.push(crate::night::SourceLedgerEntry {
                id: "selective-windows".into(),
                kind: "emissive_surface".into(),
                nominal_value: physical_window_primitives as f32,
                nominal_unit: "occupied dedicated GLB primitives".into(),
                renderer_internal_value: physical_window_primitives as f32,
                active_layers: vec!["emissive_surface".into()],
                shadows: false,
                confidence: 0.9,
                provenance: "dedicated window/glass GltfMaterialName clone; walls/facades excluded".into(),
            });
            resolved.night_environment = Some(night_environment.clone());
        }

        if lighting.atmosphere {
            let ground_y = lighting.ground_y.unwrap_or(self.atmosphere_ground_y);
            self.atmosphere_ground_y = ground_y;
            let medium = self.medium.clone();
            let far = self.far_plane_m;
            // The medium is deck-free by construction (`atmosphere::earth_terms`);
            // the volumetric field is the only cloud model at every hour.
            let atmosphere_lighting = lighting.clone();
            let (entity, handle) = Self::spawn_atmosphere(
                self.app.world_mut(),
                &atmosphere_lighting,
                &medium,
                ground_y,
                far,
            );
            self.atmosphere_entity = Some(entity);
            self.medium = Some(handle);
        } else {
            // Leaving the physical path: drop the medium so its 16 MB LUT
            // pair is not held for a sky that is no longer rendered.
            if let Some(handle) = self.medium.take() {
                self.app
                    .world_mut()
                    .resource_mut::<Assets<bevy::light::atmosphere::ScatteringMedium>>()
                    .remove(&handle);
            }
        }

        // before overwriting; see the warmup at the end of this function.
        let atmosphere_changed = self.lighting.atmosphere != lighting.atmosphere;
        let fx_changed = self.profile_config != profile_config || atmosphere_changed;
        self.sky = sky;
        self.skybox_brightness = if lighting.atmosphere { 1.0 } else { plan.skybox_brightness };
        self.ev100_fixed = resolved.ev100;
        self.env_gain = env_gain;
        self.profile_config = profile_config;
        self.fog = if lighting.atmosphere {
            None
        } else {
            lighting.fog_for(&plan).map(|(density, _, color)| DistanceFog {
                color,
                directional_light_color: Color::srgb(1.0, 0.95, 0.86),
                directional_light_exponent: 30.0,
                falloff: FogFalloff::ExponentialSquared { density },
            })
        };
        self.lighting = lighting.clone();

        let views: Vec<(Entity, f32, f32, u32)> = self
            .groups
            .iter()
            .map(|g| {
                (
                    g.rgb_entity,
                    g.spec.far,
                    g.spec.fov_y_deg,
                    g.spec.height,
                )
            })
            .collect();
        let sky_template = lighting.atmosphere.then(|| {
            build_sky_pass(
                &resolved,
                &night_environment,
                &night_controls,
                &cloud_params,
                internal_scale,
                self.ev100_fixed,
                moon_direct_precloud,
            )
        });
        self.sky_pass = sky_template;
        let (sky_handle, skybox_brightness, ev100, fx, fog) = (
            // The sky pass composites the background itself; a `Skybox`
            // would draw straight over the atmosphere inside the opaque pass.
            if lighting.atmosphere { None } else { self.sky.clone() },
            self.skybox_brightness,
            self.ev100_fixed,
            self.profile_config.cinematic,
            self.fog.clone(),
        );
        {
            let world = self.app.world_mut();
            let mut commands = world.commands();
            for (entity, far, fov_y_deg, height) in views {
                // A free camera is not a vehicle. Ensure a stale rev15
                // camera-owned source cannot survive the clean cutover.
                commands.entity(entity).remove::<SpotLight>();
                RenderProfile::strip(&mut commands, entity);
                commands.entity(entity).remove::<DistanceFog>();
                RenderProfile::apply(
                    &mut commands,
                    entity,
                    ev100,
                    sky_handle.clone(),
                    skybox_brightness,
                    fx,
                );
                match sky_template {
                    Some(template) => {
                        let mut sky = template;
                        sky.pixel_angle =
                            fov_y_deg.to_radians() / height.max(1) as f32;
                        commands.entity(entity).insert(sky);
                    }
                    None => {
                        commands.entity(entity).remove::<crate::sky_pass::SkyPass>();
                    }
                }
                if use_atmosphere {
                    attach_atmosphere_view(&mut commands, entity, far, env_gain);
                } else {
                    detach_atmosphere_view(&mut commands, entity);
                }
                if let Some(fog) = fog.clone() {
                    commands.entity(entity).insert(fog);
                }
            }
        }
        self.app.world_mut().flush();
        {
            let entities: Vec<Entity> = self.groups.iter().map(|g| g.rgb_entity).collect();
            let world = self.app.world_mut();
            for entity in entities {
                set_view_env_gain(world, entity, if use_atmosphere { env_gain } else { 0.0 });
            }
        }
        let mut resolved = resolved;
        resolved.road_materials = self.set_wetness(resolved.wetness) as u32;
        // A wet scene on a map whose road materials the ramp does not
        // recognise renders dry: say so instead of pretending.
        if resolved.wetness > 0.0 && resolved.road_materials == 0 {
            resolved.inert_controls.push("wetness".to_string());
        }
        // Changing which post-process components a view carries changes the
        // view's pipeline specialization key, its prepass texture set and
        // its view-target chain. For a frame or two afterwards the graph
        // can produce no readback at all — reliably reproducible by
        // switching anti-aliasing away from TAA, which also drops
        // `TemporalJitter`, `MipBias` and the motion-vector prepass. Spend
        // discarded frames here so the caller's next render is the real
        // one. Also gives TAA a first history sample when it is enabled.
        //
        // The atmosphere needs the same treatment for a different reason:
        // its four LUTs are rebuilt by the render graph, and the IBL probe
        // is filtered from the sky-view LUT one frame later.
        if (fx_changed || use_atmosphere) && !self.groups.is_empty() {
            self.warmup(if atmosphere_changed { 3 } else { 2 });
        }
        Ok(resolved)
    }

    /// Advance a live look in place, for time-lapses.
    ///
    /// A full [`Self::apply_lighting`] respawns every light and rebuilds
    /// every view's post-process stack, which re-inserts
    /// `TemporalAntiAliasing` with `reset: true` and drops the TAA history:
    /// one visibly unfiltered frame. A recording that moves the sun a
    /// fraction of a degree per frame cannot afford that, so this path
    /// updates only what the clock moves — the sun's direction, illuminance
    /// and cloud cookie, the camera EV, the atmosphere IBL gain and the sky
    /// pass parameters — on the entities already in the world. The
    /// scattering medium does not depend on the sun (the GPU medium is
    /// deck-free), so it is left alone.
    ///
    /// Three ladders exist, keyed on sun elevation: day (atmosphere IBL),
    /// twilight (the celestial probe carries the ambient from the probe
    /// handover down) and night (luminaires, windows and the Moon as well).
    /// Within one ladder everything the clock moves is updated in place —
    /// by night that is also the Moon's light and the probe cubemap, which
    /// is regenerated into the existing image handle. Crossing a ladder, or
    /// changing anything but the clock and the camera, falls back to
    /// [`Self::apply_lighting`] and says so in the result, so a recorder can
    /// mark the frame: a time-lapse from afternoon to midnight pays exactly
    /// two full relights, one at each handover, which is also when the
    /// street lights come on.
    pub fn advance_lighting(
        &mut self,
        lighting: &Lighting,
        profile_config: RenderProfileConfig,
    ) -> Result<(ResolvedLighting, bool)> {
        let lighting = &self.with_render_config_haze(lighting);
        lighting.validate_for_scene_app()?;
        let tier = ladder_tier(lighting.sun_elev_deg);
        self.scene_revision += 1;
        let same_ladder = {
            // Everything the clock and the camera move is neutralised; the
            // rest must match exactly. The fixture ledger arrives sorted by
            // distance to the camera, so it is compared as a set.
            let neutral = |l: &Lighting| -> Result<String> {
                let mut l = l.clone();
                l.sun_elev_deg = 0.0;
                l.sun_azim_deg = 0.0;
                l.night.utc_minutes = 0.0;
                l.night.utc_day_of_year = 0;
                l.night.observer_position = [0.0; 3];
                l.meter_view = None;
                let mut fixtures: Vec<String> = l
                    .night
                    .fixtures
                    .iter()
                    .map(serde_json::to_string)
                    .collect::<std::result::Result<_, _>>()?;
                fixtures.sort_unstable();
                l.night.fixtures.clear();
                Ok(format!("{}\n{}", serde_json::to_string(&l)?, fixtures.join("\n")))
            };
            neutral(&self.lighting)? == neutral(lighting)?
        };
        if !(lighting.atmosphere
            && same_ladder
            && tier == ladder_tier(self.lighting.sun_elev_deg)
            && self.profile_config == profile_config
            && !self.groups.is_empty())
        {
            return Ok((self.apply_lighting(lighting, profile_config)?, true));
        }

        let Relight {
            plan,
            resolved,
            night_controls,
            night_environment,
            cloud_params,
            sun_dir,
            sun_cloud_t,
            moon_direct_precloud,
            env_gain,
            internal_scale,
            ..
        } = self.resolve_relight(lighting, &profile_config, true);

        // The night ladder's Moon: exactly one directional light carries the
        // night marker (fixtures are spot/point lights). A Moon that rises
        // after the ladder was spawned has no light to move, so that case
        // takes the full relight.
        if tier == LadderTier::Night {
            let moon = &night_environment.celestial;
            let world = self.app.world_mut();
            let mut moons = world.query_filtered::<
                (&mut DirectionalLight, &mut Transform),
                With<NightLightMarker>,
            >();
            if moons.iter(world).next().is_none() && moon.direct_normal_lux > 0.0 {
                return Ok((self.apply_lighting(lighting, profile_config)?, true));
            }
            let dir = sun_direction(moon.elevation_deg, moon.azimuth_deg);
            for (mut light, mut transform) in moons.iter_mut(world) {
                light.illuminance = moon.direct_normal_lux * internal_scale;
                *transform = Transform::IDENTITY.looking_to(dir, Vec3::Y);
            }
        }

        // Sun: direction, extraterrestrial illuminance, colour. The ladder
        // spawns one (down to the astronomical-night seed) whenever the
        // plan has any, so there is at most one to move.
        {
            let world = self.app.world_mut();
            let mut suns = world.query_filtered::<
                (&mut DirectionalLight, &mut Transform),
                With<lighting::VolumetricLightMarker>,
            >();
            for (mut sun, mut transform) in suns.iter_mut(world) {
                sun.illuminance = plan.sun_lux;
                sun.color = plan.sun_color;
                *transform = Transform::IDENTITY.looking_to(sun_dir, Vec3::Y);
            }
        }
        self.apply_sun_cookie(sun_cloud_t);

        // The celestial probe carries the twilight sky, the Moon and the
        // lit cloud; all of it moves with the clock, so the cubemap is
        // rebuilt into the handle the `LightProbe` already holds.
        if let Some(handle) = self.probe_cubemap.clone() {
            let (daylight, ground) = probe_daylight(resolved.atmosphere.as_ref());
            let image = {
                let field = self.app.world().resource::<crate::clouds::CloudField>();
                crate::night::celestial_ibl_cubemap(
                    &night_environment,
                    field,
                    &cloud_params,
                    daylight.as_ref(),
                    ground,
                    64,
                    internal_scale,
                )
            };
            self.app
                .world_mut()
                .resource_mut::<Assets<Image>>()
                .insert(handle.id(), image);
        }

        self.ev100_fixed = resolved.ev100;
        self.env_gain = env_gain;
        let template = build_sky_pass(
            &resolved,
            &night_environment,
            &night_controls,
            &cloud_params,
            internal_scale,
            self.ev100_fixed,
            moon_direct_precloud,
        );
        self.sky_pass = Some(template);
        let views: Vec<(Entity, f32, u32)> = self
            .groups
            .iter()
            .map(|g| (g.rgb_entity, g.spec.fov_y_deg, g.spec.height))
            .collect();
        let world = self.app.world_mut();
        for (entity, fov_y_deg, height) in views {
            if let Some(mut exposure) = world.get_mut::<bevy::camera::Exposure>(entity) {
                exposure.ev100 = resolved.ev100;
            }
            set_view_env_gain(world, entity, env_gain);
            if let Some(mut sky) = world.get_mut::<crate::sky_pass::SkyPass>(entity) {
                let pixel_angle = fov_y_deg.to_radians() / height.max(1) as f32;
                *sky = template;
                sky.pixel_angle = pixel_angle;
            }
        }
        self.lighting = lighting.clone();
        Ok((resolved, false))
    }

    /// Engine values currently in force.
    pub fn resolved_lighting(&self) -> ResolvedLighting {
        self.lighting.resolve_for(self.far_plane_m, self.cloud_beam_t).1
    }

    /// The anti-aliasing mode actually present on each live RGB view, read
    /// back out of the ECS.
    ///
    /// This is deliberately not an echo of the request: it is the only way
    /// to prove that switching modes removed the previous AA component
    /// instead of stacking a second one. `("<sensorId>", "<mode>")` pairs;
    /// `"conflict:"`-prefixed when more than one AA component is present,
    /// which would be a bug in [`RenderProfile::strip`].
    pub fn camera_anti_alias(&self) -> Vec<(String, String)> {
        let world = self.app.world();
        self.groups
            .iter()
            .map(|group| {
                let entity = group.rgb_entity;
                let mut found: Vec<&str> = Vec::new();
                if world.get::<TemporalAntiAliasing>(entity).is_some() {
                    found.push("taa");
                }
                if world.get::<Fxaa>(entity).is_some() {
                    found.push("fxaa");
                }
                if let Some(smaa) = world.get::<Smaa>(entity) {
                    found.push(match smaa.preset {
                        SmaaPreset::Low => "smaa-low",
                        SmaaPreset::Medium => "smaa-medium",
                        SmaaPreset::High => "smaa-high",
                        SmaaPreset::Ultra => "smaa-ultra",
                    });
                }
                let mode = match found.len() {
                    0 => "off".to_string(),
                    1 => found[0].to_string(),
                    _ => format!("conflict:{}", found.join("+")),
                };
                (group.spec.sensor_id.clone(), mode)
            })
            .collect()
    }

    /// Drive the wet-road reflectance ramp to `wetness` ∈ [0, 1].
    ///
    /// Unlike `weather::apply_wetness`, this is reversible: the dry
    /// roughness/metallic/base colour of each drivable-surface material is
    /// captured the first time it is touched and every later call ramps from
    /// that original, so dragging a wetness slider back to zero restores the
    /// scene exactly instead of compounding the darkening.
    pub fn set_wetness(&mut self, wetness: f32) -> usize {
        // Matched against the mesh entity's name (older corpus exports) and
        // its glTF material name (RoadRunner masters: Belmont's road is
        // `MI_Road_Asphalt_A_Roads_Road_Layer0` on a generically named mesh,
        // so a name-only match left wetness inert there).
        const ROAD_MARKERS: [&str; 2] = ["asphalt1_road", "roads_road_layer0"];
        let wetness = wetness.clamp(0.0, 1.0);
        self.scene_revision += 1;
        let world = self.app.world_mut();
        let mut road_materials: Vec<Handle<StandardMaterial>> = Vec::new();
        {
            let mut meshes = world.query::<(
                Option<&Name>,
                Option<&ChildOf>,
                &MeshMaterial3d<StandardMaterial>,
                Option<&GltfMaterialName>,
            )>();
            let mut names = world.query::<&Name>();
            let mut seen: std::collections::HashSet<AssetId<StandardMaterial>> =
                std::collections::HashSet::new();
            let rows: Vec<(Option<String>, Option<Entity>, Handle<StandardMaterial>, Option<String>)> = meshes
                .iter(world)
                .map(|(name, parent, mat, material_name)| {
                    (name.map(|n| n.as_str().to_owned()), parent.map(|p| p.0), mat.0.clone(), material_name.map(|m| m.0.clone()))
                })
                .collect();
            for (name, parent, material, material_name) in rows {
                let mut label = name.unwrap_or_default();
                if label.is_empty() {
                    if let Some(parent) = parent {
                        if let Ok(parent_name) = names.get(world, parent) {
                            label = parent_name.as_str().to_owned();
                        }
                    }
                }
                let lower = label.to_ascii_lowercase();
                let material_lower = material_name.unwrap_or_default().to_ascii_lowercase(); // fallback-ok: an unnamed material only fails to match
                if ROAD_MARKERS.iter().any(|m| lower.contains(m) || material_lower.contains(m))
                    && seen.insert(material.id())
                {
                    road_materials.push(material);
                }
            }
        }
        let mut touched = 0usize;
        let mut assets = world.resource_mut::<Assets<StandardMaterial>>();
        for handle in road_materials {
            let id = handle.id();
            let Some(mut material) = assets.get_mut(&handle) else {
                continue;
            };
            let (dry_roughness, dry_metallic, dry_color) = *self
                .dry_road_materials
                .entry(id)
                .or_insert((material.perceptual_roughness, material.metallic, material.base_color));
            material.perceptual_roughness = dry_roughness * (1.0 - wetness) + 0.16 * wetness;
            material.metallic = dry_metallic.max(0.04 * wetness);
            let mut linear = dry_color.to_linear();
            let k = 1.0 - 0.35 * wetness;
            linear.red *= k;
            linear.green *= k;
            linear.blue *= k;
            material.base_color = Color::from(linear);
            touched += 1;
        }
        touched
    }


    /// Queue GLB tiles for loading. Call before [`Self::wait_until_ready`].
    pub fn load_tiles(&mut self, glbs: &[String]) -> Result<()> {
        let paths = glbs
            .iter()
            .map(|g| crate::platform::asset_path(std::path::Path::new(g)).map_err(|e| anyhow::anyhow!("glb {e}")))
            .collect::<Result<Vec<String>>>()?;
        self.scene_revision += 1;
        let server = self.app.world().resource::<AssetServer>().clone();
        for path in paths {
            let handle: Handle<Gltf> = server.load(path);
            self.app.world_mut().spawn(TileLoad(handle));
        }
        Ok(())
    }

    /// Queue vegetation prototype GLBs plus their `.instances.json` sidecars.
    /// Keeping this separate from static tiles avoids accidentally drawing the
    /// uninstanced prototype roots.
    pub fn load_vegetation(&mut self, glbs: &[String]) -> Result<()> {
        let paths = glbs
            .iter()
            .map(|g| {
                crate::platform::asset_path(std::path::Path::new(g))
                    .map(|path| (path, g.as_str()))
                    .map_err(|e| anyhow::anyhow!("vegetation glb {e}"))
            })
            .collect::<Result<Vec<_>>>()?;
        let server = self.app.world().resource::<AssetServer>().clone();
        let mut commands = self.app.world_mut().commands();
        crate::veg::spawn_veg(&mut commands, &server, &paths);
        Ok(())
    }

    /// Register a camera group (RGB target + optional ID camera + depth copy).
    ///
    /// Registration is allowed both before [`Self::wait_until_ready`] and
    /// after it. Post-ready groups join the already-finalized ID-pass layer
    /// directly; the legend is not re-derived, so IDs stay stable. A camera
    /// already registered under the same `sensor_id` is replaced (its
    /// targets, staging and host binding are released), which is how a
    /// resize is expressed.
    pub fn add_camera(&mut self, spec: CameraSpec) {
        let host = self
            .groups
            .iter()
            .find(|g| g.spec.sensor_id == spec.sensor_id)
            .and_then(|g| g.host.clone());
        self.remove_camera(&spec.sensor_id);

        let rgb_image = {
            let mut images = self.app.world_mut().resource_mut::<Assets<Image>>();
            setup_target_image(&mut images, spec.width, spec.height, TextureFormat::Rgba8UnormSrgb)
        };
        let rgb_handle = rgb_image.clone();

        let e = self.app.world_mut().spawn((
            Camera3d {
                depth_texture_usages: (TextureUsages::RENDER_ATTACHMENT
                    | TextureUsages::COPY_SRC)
                    .into(),
                ..default()
            },
            Projection::from(PerspectiveProjection {
                fov: spec.fov_y_deg.to_radians(),
                near: spec.near,
                far: spec.far,
                ..default()
            }),
            Msaa::Off,
            Camera { order: self.next_camera_order, ..default() },
            Transform::IDENTITY,
            RenderTarget::Image(rgb_image.into()),
        ));
        let rgb_entity = e.id();
        self.next_camera_order += 10;
        if self.shared_shadows {
            self.app
                .world_mut()
                .entity_mut(rgb_entity)
                .insert(crate::shared_shadows::SharedShadowView);
        }

        let use_atmosphere = atmosphere_view_active(&self.lighting);
        // Same gain and the same sky the last relight resolved; a view that
        // registers late must not re-derive either from a different path.
        let env_gain = if use_atmosphere { self.env_gain } else { 0.0 };
        {
            let world = self.app.world_mut();
            let mut commands = world.commands();
            RenderProfile::apply(
                &mut commands,
                rgb_entity,
                self.ev100_fixed,
                if use_atmosphere { None } else { self.sky.clone() },
                self.skybox_brightness,
                self.profile_config.cinematic,
            );
            if use_atmosphere {
                attach_atmosphere_view(&mut commands, rgb_entity, spec.far, env_gain);
            }
            if let Some(template) = self.sky_pass {
                let mut sky = template;
                sky.pixel_angle = spec.fov_y_deg.to_radians() / spec.height.max(1) as f32;
                commands.entity(rgb_entity).insert(sky);
            }
            if let Some(fog) = self.fog.clone() {
                commands.entity(rgb_entity).insert(fog);
            }
        }
        self.app.world_mut().flush();
        // The aerial-perspective LUT is fitted to the far plane; the first
        // registered camera decides it, and a later relight reuses it.
        if use_atmosphere && self.groups.is_empty() {
            self.far_plane_m = spec.far;
        }

        self.app.world_mut().spawn(ReadbackTarget {
            key: format!("{}:rgb", spec.sensor_id),
            src_image: rgb_handle.clone(),
            depth: false,
            exposure: false,
        });
        // Copied only when the look carries the camera model and the
        // caller asks for it.
        self.app.world_mut().spawn(ReadbackTarget {
            key: format!("{}:exposure", spec.sensor_id),
            src_image: rgb_handle.clone(),
            depth: false,
            exposure: true,
        });
        if spec.passes.hdr {
            let hdr_image = {
                let mut images = self.app.world_mut().resource_mut::<Assets<Image>>();
                let mut image = Image::new_target_texture(spec.width, spec.height, TextureFormat::Rgba16Float, None);
                image.texture_descriptor.usage |= TextureUsages::COPY_SRC | TextureUsages::COPY_DST;
                images.add(image)
            };
            self.app
                .world_mut()
                .entity_mut(rgb_entity)
                .insert(crate::camera_model::HdrCapture(hdr_image.clone()));
            self.app.world_mut().spawn(ReadbackTarget {
                key: format!("{}:hdr", spec.sensor_id),
                src_image: hdr_image,
                depth: false,
                exposure: false,
            });
        }

        let id_entity = if spec.passes.id {
            let id_image = {
                let mut images = self.app.world_mut().resource_mut::<Assets<Image>>();
                setup_target_image(&mut images, spec.width, spec.height, ID_PASS_FORMAT)
            };
            self.app.world_mut().spawn(ReadbackTarget {
                key: format!("{}:id", spec.sensor_id),
                src_image: id_image.clone(),
                depth: false,
                exposure: false,
            });
            let cmd = self.app.world_mut().spawn((
                Camera3d::default(),
                Camera {
                    clear_color: ClearColorConfig::Custom(Color::BLACK),
                    order: self.next_camera_order,
                    ..default()
                },
                Projection::from(PerspectiveProjection {
                    fov: spec.fov_y_deg.to_radians(),
                    near: spec.near,
                    far: spec.far,
                    ..default()
                }),
                id_pass_camera(),
                Transform::IDENTITY,
                RenderTarget::Image(id_image.into()),
                RenderLayers::layer(1),
            ));
            self.next_camera_order += 10;
            Some(cmd.id())
        } else {
            None
        };

        if spec.passes.depth {
            self.app.world_mut().spawn(ReadbackTarget {
                key: format!("{}:depth", spec.sensor_id),
                src_image: rgb_handle,
                depth: true,
                exposure: false,
            });
        }

        self.groups.push(GroupEntities { spec, rgb_entity, id_entity, host });
        self.rig_revision += 1;
        self.sync_host_layers();
        self.refresh_lod_ranges();
        if self.ready {
            // Post-ready registration: pump updates so extraction and
            // pipeline compilation happen before the next capture. Two
            // frames, not one: a cinematic view brings a whole post chain
            // with it (AA, bloom, SSAO, SSR), and with only one warmup the
            // first real frame came back with the anti-aliasing pass
            // silently missing — byte-identical to `aa: off`.
            self.warmup(2);
        }
    }

    /// Mount a registered camera on an actor: that actor's RGB geometry is
    /// excluded from this view only. `None` unmounts. The actor need not be
    /// spawned yet; the exclusion applies once it is.
    pub fn set_camera_host(&mut self, sensor_id: &str, host: Option<&str>) -> Result<()> {
        let group = self
            .groups
            .iter_mut()
            .find(|g| g.spec.sensor_id == sensor_id)
            .ok_or_else(|| anyhow::anyhow!("unknown sensor {sensor_id}"))?;
        if group.host.as_deref() == host {
            return Ok(());
        }
        group.host = host.map(str::to_owned);
        self.rig_revision += 1;
        self.sync_host_layers();
        Ok(())
    }

    /// Re-derive host layers from the current mounts and write them onto
    /// actor visuals, RGB cameras and the light union.
    ///
    /// Each host actor owns one private layer: its visuals live there
    /// instead of layer 0, every camera except the one mounted on it adds
    /// that layer, and every light covers all of them. Layers are released
    /// when no camera is mounted on the actor any more.
    fn sync_host_layers(&mut self) {
        let mounted: Vec<String> = self
            .groups
            .iter()
            .filter_map(|g| g.host.clone())
            .collect();
        self.host_layers.retain(|actor, _| mounted.contains(actor));
        for actor in &mounted {
            if self.host_layers.contains_key(actor) {
                continue;
            }
            let layer = (FIRST_HOST_LAYER..)
                .step_by(2)
                .find(|candidate| !self.host_layers.values().any(|used| used == candidate))
                .expect("unbounded layer range");
            self.host_layers.insert(actor.clone(), layer);
        }
        let union = RenderLayers::from_layers(
            &std::iter::once(0)
                .chain(self.host_layers.values().copied())
                .collect::<Vec<_>>(),
        );
        // Each view sees every host layer but its own host's: the RGB camera
        // on layer 0 plus the other hosts' RGB layers, the ID camera on
        // layer 1 plus the other hosts' ID layers. Labels therefore match
        // the pixels: a mounted camera neither renders nor labels its host.
        let mut views: Vec<(Entity, RenderLayers)> = Vec::new();
        for g in &self.groups {
            let others: Vec<usize> = self
                .host_layers
                .iter()
                .filter(|(actor, _)| Some(actor.as_str()) != g.host.as_deref())
                .map(|(_, layer)| *layer)
                .collect();
            let rgb: Vec<usize> = std::iter::once(0).chain(others.iter().copied()).collect();
            views.push((g.rgb_entity, RenderLayers::from_layers(&rgb)));
            if let Some(id_entity) = g.id_entity {
                let id: Vec<usize> = std::iter::once(1).chain(others.iter().map(|l| id_host_layer(*l))).collect();
                views.push((id_entity, RenderLayers::from_layers(&id)));
            }
        }
        let actor_ids: Vec<String> = self.actors.keys().cloned().collect();
        let world = self.app.world_mut();
        world.insert_resource(HostLayerUnion(union));
        for (entity, layers) in views {
            world.entity_mut(entity).insert(layers);
        }
        for actor in actor_ids {
            self.apply_actor_layers(&actor);
        }
    }

    /// Put one actor's RGB visuals (fallback cuboid and every mesh under
    /// its catalog model) on its host layer, or back on layer 0, and its
    /// instance-ID clones on the paired ID layer, or back on layer 1.
    fn apply_actor_layers(&mut self, actor_id: &str) {
        let Some((cuboid, _)) = self.actors.get(actor_id).copied() else {
            return;
        };
        let host = self.host_layers.get(actor_id).copied();
        let layer = host.unwrap_or(0);
        let id_layer = host.map(id_host_layer).unwrap_or(1);
        let model = self.actor_models.get(actor_id).map(|(entity, _, _)| *entity);
        let cuboid_clone = self.actor_id_clones.get(actor_id).copied();
        let world = self.app.world_mut();
        let mut targets = vec![(cuboid, layer)];
        targets.extend(cuboid_clone.map(|clone| (clone, id_layer)));
        if let Some(root) = model {
            let mut stack = vec![root];
            while let Some(entity) = stack.pop() {
                if let Some(children) = world.get::<Children>(entity) {
                    stack.extend(children.iter());
                }
                if world.get::<Mesh3d>(entity).is_some() {
                    let is_clone = world.get::<IdClone>(entity).is_some();
                    targets.push((entity, if is_clone { id_layer } else { layer }));
                }
            }
        }
        for (entity, layer) in targets {
            if let Ok(mut entity) = world.get_entity_mut(entity) {
                entity.insert(RenderLayers::layer(layer));
            }
        }
    }

    /// Registered spec of one camera, if it exists.
    pub fn camera(&self, sensor_id: &str) -> Option<&CameraSpec> {
        self.groups
            .iter()
            .find(|g| g.spec.sensor_id == sensor_id)
            .map(|g| &g.spec)
    }

    /// Frozen legend (static instance ids). Dynamic actors get ids above the
    /// static maximum; see [`Self::actor_instance_class`].
    pub fn legend(&self) -> Vec<LegendEntry> {
        self.app.world().resource::<Legend>().0.clone()
    }

    /// Decode the map's ground derivative and make it the scene's height
    /// source. Call before [`Self::wait_until_ready`]; the legacy readiness
    /// field is then never built. A malformed file is an error, never a
    /// silent return to the legacy field.
    pub fn load_ground_mesh(&mut self, path: &std::path::Path) -> Result<()> {
        let bytes = std::fs::read(path)
            .with_context(|| format!("[native_ground_mesh_unreadable] {}", path.display()))?;
        let surface = simforge_core::map::ground::GroundSurface::decode(&bytes)
            .map_err(|error| anyhow!("[native_ground_mesh_invalid] {}: {error}", path.display()))?;
        self.ground_surface = Some(surface);
        Ok(())
    }

    /// Which height source placement uses: the ground derivative (with its
    /// sha256) or the legacy readiness field, an explicit substitution for
    /// map versions published before their ground derivative.
    pub fn ground_source(&self) -> GroundSource {
        match &self.ground_surface {
            Some(surface) => GroundSource::GroundMesh { sha256: surface.digest().to_owned() },
            None => GroundSource::LegacyMeshField,
        }
    }

    /// Ground height (world Y) under world (x, z) for an actor that carries
    /// no authored height.
    ///
    /// With the ground derivative this is the single surface there (scene
    /// X = xodr x, scene Z = -xodr y, scene Y = xodr z). No surface, or two
    /// decks with no height to choose between them, is an error. Without it,
    /// the legacy field's cell (or its nearest populated cell within 20 m);
    /// off the map is an error. Never an invented height.
    pub fn ground_height(&self, x: f32, z: f32) -> std::result::Result<f32, String> {
        match &self.ground_surface {
            Some(surface) => ground_mesh_height(surface, x, z),
            None => self.ground.sample_covered(x, z).ok_or_else(|| format!(
                "[native_ground_height_unavailable] x={x:.2} z={z:.2} has no map ground within 20 m"
            )),
        }
    }

    /// Remove an actor's catalog model (and its ID clones), keeping the
    /// actor. Used to rebind a different model or animation GLB.
    pub fn detach_actor_asset(&mut self, actor_id: &str) -> Result<()> {
        let (model, _, _) = self
            .actor_models
            .remove(actor_id)
            .ok_or_else(|| anyhow::anyhow!("actor {actor_id} has no attached catalog asset"))?;
        self.actor_tint_materials.remove(actor_id);
        self.actor_palette_materials.remove(actor_id);
        self.actor_animations.remove(actor_id);
        if let Some((_, meshes)) = self.actor_riders.get_mut(actor_id) {
            meshes.clear();
        }
        let world = self.app.world_mut();
        world.despawn(model);
        // The cuboid (and its ID clone) stay hidden: an actor is never shown
        // as its proxy; the caller attaches the replacement in the same tick.
        self.scene_revision += 1;
        Ok(())
    }

    /// Apply a `simforge.road-detail/v1` sidecar (splat-blended asphalt
    /// variants + wear/marking modulation + decal overlay) to the spawned
    /// scene. Call after [`Self::wait_until_ready`]; follow with
    /// [`Self::warmup`] so the extended-material pipelines compile before
    /// capture. No-op for the instance-ID pass (ID materials are never
    /// GLB-named).
    pub fn apply_road_detail(
        &mut self,
        sidecar_path: &str,
    ) -> Result<crate::road_detail::RoadDetailStats> {
        self.scene_revision += 1;
        let stats =
            crate::road_detail::apply(&mut self.app, std::path::Path::new(sidecar_path))
                .map_err(|e| anyhow::anyhow!("{e:#}"))?;
        // Pump one update so the swapped materials extract before the next
        // render.
        self.app.update();
        Ok(stats)
    }

    /// Spawn or move one scene-state actor cuboid. The box is named
    /// `actor:<id>` and carries an instance id above the static legend range
    /// so ID-pass pixels resolve to the actor class.
    ///
    /// `position` is the cuboid centre; callers with ground-origin vehicle
    /// poses add half the height (see [`Self::ground_height`] for poses
    /// without one).
    /// `rotation` is the body orientation.
    /// Catalog asset calibration is applied separately with
    /// [`Self::set_actor_asset_pose`], never to the sensor/ID cuboid.
    pub fn upsert_actor(
        &mut self,
        id: &str,
        class: &str,
        position: [f32; 3],
        rotation: Quat,
        dims: [f32; 3],
        color: [f32; 3],
    ) {
        let transform = Transform {
            translation: Vec3::from_array(position),
            rotation,
            scale: Vec3::ONE,
        };
        self.scene_revision += 1;
        let world = self.app.world_mut();
        if let Some((entity, _)) = self.actors.get(id) {
            if let Some(mut t) = world.get_mut::<Transform>(*entity) {
                *t = transform;
            }
            if let Some(clone) = self.actor_id_clones.get(id) {
                if let Some(mut t) = world.get_mut::<Transform>(*clone) {
                    *t = transform;
                }
            }
            return;
        }
        let instance_id = self.next_instance_id + 1;
        self.next_instance_id = instance_id;
        let mesh_handle = {
            let mut meshes = world.resource_mut::<Assets<Mesh>>();
            meshes.add(Cuboid::new(dims[0], dims[1], dims[2]))
        };
        let mat_handle = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            materials.add(StandardMaterial {
                base_color: Color::srgb(color[0], color[1], color[2]),
                ..default()
            })
        };
        // Deterministic instance-ID material for the layer-1 clone: same
        // RGB24 encoding as finalize_scene.
        let id_mat = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            materials.add(instance_id_material(instance_id))
        };
        let e = world.spawn((
            Name::new(format!("actor:{id}")),
            Mesh3d(mesh_handle.clone()),
            MeshMaterial3d(mat_handle),
            InstanceId(instance_id),
            transform,
        )).id();
        let clone = world.spawn((
            IdClone,
            Name::new(format!("actor:{id}")),
            Mesh3d(mesh_handle),
            MeshMaterial3d(id_mat),
            RenderLayers::layer(1),
            transform,
        )).id();
        self.actors.insert(id.to_string(), (e, instance_id));
        self.actor_id_clones.insert(id.to_string(), clone);
        self.actor_classes.insert(instance_id, class.to_string());
        self.apply_actor_layers(id);
    }

    /// Apply the sprung-body attitude and wheel drop of a rigged catalog
    /// model (sampler/2, docs/engineering/ground-height.md): `body_attitude`
    /// `(pitch, roll)` rotates the model's `body` node about its origin
    /// (OpenSCENARIO signs, pitch positive nose down, roll positive right side
    /// down); `wheel_drop_m` `[FL, FR, RL, RR]` moves the `wheel_*` nodes along
    /// the body's up axis. The actor transform itself carries road attitude
    /// only, so the wheels stay on the ground. Models without these nodes
    /// (single-mesh bodies) keep their pose; absent inputs restore the rest
    /// pose. Returns the number of nodes posed.
    pub fn set_actor_articulation(
        &mut self,
        actor_id: &str,
        body_attitude: Option<(f32, f32)>,
        wheel_drop_m: Option<[f32; 4]>,
    ) -> Result<usize> {
        let Some(&(root, scale, _)) = self.actor_models.get(actor_id) else {
            bail!("actor {actor_id} has no attached catalog asset");
        };
        const WHEELS: [&str; 4] = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"];
        let nodes: Vec<(Entity, String)> = {
            let world = self.app.world();
            let mut stack = vec![root];
            let mut found = Vec::new();
            while let Some(entity) = stack.pop() {
                if let Some(children) = world.get::<Children>(entity) {
                    stack.extend(children.iter());
                }
                if let Some(name) = world.get::<Name>(entity) {
                    let name = name.as_str();
                    if name == "body" || WHEELS.contains(&name) {
                        found.push((entity, name.to_owned()));
                    }
                }
            }
            found
        };
        let mut posed = 0;
        for (entity, name) in nodes {
            let rest = *self
                .actor_rest_poses
                .entry(actor_id.to_owned())
                .or_default()
                .entry(entity)
                .or_insert_with(|| {
                    self.app
                        .world()
                        .get::<Transform>(entity)
                        .copied()
                        .unwrap_or(Transform::IDENTITY)
                });
            let mut pose = rest;
            if name == "body" {
                if let Some((pitch, roll)) = body_attitude {
                    pose.rotation =
                        Quat::from_rotation_z(-pitch) * Quat::from_rotation_x(roll) * rest.rotation;
                }
            } else if let Some(drop) = wheel_drop_m {
                let index = WHEELS.iter().position(|w| *w == name).expect("wheel name");
                // Node translations live inside the uniformly scaled model root.
                pose.translation.y += drop[index] / scale.max(1e-6);
            }
            if let Some(mut transform) = self.app.world_mut().get_mut::<Transform>(entity) {
                if *transform != pose {
                    *transform = pose;
                    self.scene_revision += 1;
                }
                posed += 1;
            }
        }
        Ok(posed)
    }

    /// Pose visible catalog geometry independently of the canonical cuboid.
    /// Asset yaw/origin corrections must not rotate or bury sensor geometry.
    pub fn set_actor_asset_pose(&mut self, actor_id:&str, position:[f32;3], rotation:Quat)->Result<()> {
        let Some(&(entity,_,_))=self.actor_models.get(actor_id) else {
            bail!("actor {actor_id} has no attached catalog asset");
        };
        let mut transform=self.app.world_mut().get_mut::<Transform>(entity)
            .ok_or_else(||anyhow::anyhow!("actor {actor_id} asset entity disappeared"))?;
        transform.translation=Vec3::from_array(position);
        transform.rotation=rotation;
        self.scene_revision+=1;
        Ok(())
    }

    /// Replace a spawned actor's visible cuboid with a catalog GLB while
    /// retaining its deterministic layer-1 cuboid as the sensor/ID proxy.
    /// Animated poses are sought from simulation time and paused, so
    /// wall-clock scheduling cannot affect rendered frames.
    ///
    /// Loading is blocking because the service must not acknowledge a tick
    /// until every modality sees the same fully-resident world.
    pub fn attach_actor_asset(
        &mut self,
        actor_id: &str,
        glb_path: &std::path::Path,
        uniform_scale: f32,
        tint: Option<[f32; 3]>,
        animation_clip: Option<&str>,
        animation_time_s: f32,
    ) -> Result<()> {
        let mesh_count_before = {
            let world = self.app.world_mut();
            let mut query = world.query::<&Mesh3d>();
            query.iter(world).count()
        };
        if self.actor_models.contains_key(actor_id) {
            return Ok(());
        }
        if !glb_path.is_absolute() || !glb_path.is_file() {
            bail!("actor model GLB is not an absolute existing file: {}", glb_path.display());
        }
        let (cuboid, _) = self
            .actors
            .get(actor_id)
            .copied()
            .ok_or_else(|| anyhow::anyhow!("attach model before actor spawn: {actor_id}"))?;
        let cache_key = glb_path.to_string_lossy().into_owned();
        let handle = if let Some(handle) = self.actor_asset_cache.get(&cache_key) {
            handle.clone()
        } else {
            let asset_path = crate::platform::asset_path(glb_path)?;
            let server = self.app.world().resource::<AssetServer>().clone();
            let handle: Handle<Gltf> = server.load(asset_path);
            self.actor_asset_cache.insert(cache_key, handle.clone());
            handle
        };
        let deadline = Instant::now() + Duration::from_secs(300);
        let (scene, animation) = loop {
            self.app.update();
            let loaded = self
                .app
                .world()
                .resource::<Assets<Gltf>>()
                .get(&handle)
                .and_then(|gltf| {
                    let scene = gltf.default_scene.clone()?;
                    let animation = animation_clip
                        .map(|name| {
                            gltf.named_animations
                                .get(name)
                                .cloned()
                                .ok_or_else(|| anyhow::anyhow!(
                                    "actor model {} has no animation clip {name:?}",
                                    glb_path.display()
                                ))
                        })
                        .transpose();
                    Some(animation.map(|animation| (scene, animation)))
                });
            if let Some(loaded) = loaded {
                break loaded?;
            }
            if Instant::now() > deadline {
                bail!("actor model failed to load: {}", glb_path.display());
            }
        };
        let base = self
            .app
            .world()
            .get::<Transform>(cuboid)
            .copied()
            .unwrap_or(Transform::IDENTITY);
        let mut model_transform = base;
        model_transform.scale = Vec3::splat(uniform_scale);
        let model_root = self
            .app
            .world_mut()
            .spawn((
                ActorModelRoot,
                Name::new(format!("actor-model:{actor_id}")),
                WorldAssetRoot(scene),
                model_transform,
            ))
            .id();
        self.app.world_mut().entity_mut(cuboid).insert(Visibility::Hidden);
        loop {
            self.app.update();
            let ready = {
                let world = self.app.world();
                match (
                    world.get::<WorldInstance>(model_root),
                    world.get_resource::<WorldInstanceSpawner>(),
                ) {
                    (Some(instance), Some(spawner)) => spawner.instance_is_ready(**instance),
                    _ => false,
                }
            };
            if ready {
                break;
            }
            if Instant::now() > deadline {
                bail!("actor model scene failed to instantiate: {}", glb_path.display());
            }
        }
        if let Some(clip) = animation {
            let (graph, node) = AnimationGraph::from_clip(clip);
            let graph = self
                .app
                .world_mut()
                .resource_mut::<Assets<AnimationGraph>>()
                .add(graph);
            let players = {
                let world = self.app.world_mut();
                let mut stack = vec![model_root];
                let mut players = Vec::new();
                while let Some(entity) = stack.pop() {
                    if let Some(children) = world.get::<Children>(entity) {
                        stack.extend(children.iter());
                    }
                    if world.get::<AnimationPlayer>(entity).is_some() {
                        players.push(entity);
                    }
                }
                players.sort_by_key(|entity| entity.index());
                for entity in &players {
                    let mut entity_mut = world.entity_mut(*entity);
                    entity_mut.insert(AnimationGraphHandle(graph.clone()));
                    entity_mut
                        .get_mut::<AnimationPlayer>()
                        .expect("animation player disappeared")
                        .play(node)
                        .seek_to(animation_time_s.max(0.0))
                        .pause();
                }
                players
            };
            if players.is_empty() {
                bail!(
                    "actor model {} clip {animation_clip:?} has no animation player",
                    glb_path.display()
                );
            }
            self.actor_animations.insert(
                actor_id.to_string(),
                ActorAnimationBinding { players, node },
            );
            self.app.update();
        }
        let tint_materials = if let Some(color) = tint {
            let targets = {
                let world = self.app.world();
                let mut stack = vec![model_root];
                let mut targets = Vec::new();
                while let Some(entity) = stack.pop() {
                    if let Some(children) = world.get::<Children>(entity) {
                        stack.extend(children.iter());
                    }
                    if world
                        .get::<GltfMaterialName>(entity)
                        .is_some_and(|name| &**name == "body_paint")
                    {
                        if let Some(material) =
                            world.get::<MeshMaterial3d<StandardMaterial>>(entity)
                        {
                            targets.push((entity, material.0.clone()));
                        }
                    }
                }
                targets
            };
            let Some((_, source_handle)) = targets.first() else {
                bail!(
                    "tintable actor model has no body_paint mesh slots: {}",
                    glb_path.display()
                );
            };
            let tinted_handle = {
                let world = self.app.world_mut();
                let mut tinted = world
                    .resource::<Assets<StandardMaterial>>()
                    .get(source_handle)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!(
                        "body_paint material missing after actor model load: {}",
                        glb_path.display()
                    ))?;
                tinted.base_color = Color::srgb(color[0], color[1], color[2]);
                world.resource_mut::<Assets<StandardMaterial>>().add(tinted)
            };
            for (entity, _) in targets {
                self.app
                    .world_mut()
                    .entity_mut(entity)
                    .insert(MeshMaterial3d(tinted_handle.clone()));
            }
            vec![tinted_handle]
        } else {
            Vec::new()
        };
        let mesh_count_after = {
            let world = self.app.world_mut();
            let mut query = world.query::<&Mesh3d>();
            query.iter(world).count()
        };
        let model_mesh_count = mesh_count_after.saturating_sub(mesh_count_before);
        if model_mesh_count == 0 {
            bail!("actor model instantiated without mesh nodes: {}", glb_path.display());
        }
        // The instance-ID pass must draw the model the RGB camera draws, not
        // the canonical cuboid: every model mesh gets a layer-1 child clone
        // under the actor's ID material (skinned meshes keep their skin so
        // the clone follows the animated pose), and the cuboid's own ID
        // clone is hidden.
        {
            let clone = *self
                .actor_id_clones
                .get(actor_id)
                .ok_or_else(|| anyhow::anyhow!("actor {actor_id} has no instance-ID clone"))?;
            let world = self.app.world_mut();
            let id_material = world
                .get::<MeshMaterial3d<StandardMaterial>>(clone)
                .ok_or_else(|| anyhow::anyhow!("actor {actor_id} instance-ID clone has no material"))?
                .0
                .clone();
            let mut stack = vec![model_root];
            let mut sources = Vec::new();
            while let Some(entity) = stack.pop() {
                if let Some(children) = world.get::<Children>(entity) {
                    stack.extend(children.iter());
                }
                if let Some(mesh) = world.get::<Mesh3d>(entity) {
                    sources.push((entity, mesh.0.clone(), world.get::<SkinnedMesh>(entity).cloned()));
                }
            }
            // A ridden two-wheeler's rider (glTF node extras `semanticClass:
            // "rider"` on it or an ancestor) is its own instance of class
            // `rider`: the common convention (CARLA, Cityscapes) labels the
            // person apart from the bicycle/motorcycle.
            let rider_meshes: std::collections::HashSet<Entity> = sources
                .iter()
                .map(|(entity, _, _)| *entity)
                .filter(|entity| in_rider_subtree(world, *entity, model_root))
                .collect();
            let rider_material = if rider_meshes.is_empty() {
                None
            } else {
                let rider_id = match self.actor_riders.get(actor_id) {
                    Some((id, _)) => *id,
                    None => {
                        self.next_instance_id += 1;
                        self.next_instance_id
                    }
                };
                self.actor_classes.insert(rider_id, "rider".to_string());
                self.actor_riders.insert(actor_id.to_string(), (rider_id, rider_meshes.clone()));
                Some(world.resource_mut::<Assets<StandardMaterial>>().add(instance_id_material(rider_id)))
            };
            for (entity, mesh, skin) in sources {
                let material = match &rider_material {
                    Some(rider) if rider_meshes.contains(&entity) => rider.clone(),
                    _ => id_material.clone(),
                };
                let mut cmd = world.spawn((
                    IdClone,
                    Name::new(format!("actor-id:{actor_id}")),
                    Mesh3d(mesh),
                    MeshMaterial3d(material),
                    RenderLayers::layer(1),
                    Transform::IDENTITY,
                    ChildOf(entity),
                ));
                if let Some(skin) = skin {
                    cmd.insert(skin);
                }
            }
            world.entity_mut(clone).insert(Visibility::Hidden);
        }
        self.actor_models.insert(
            actor_id.to_string(),
            (model_root, uniform_scale, model_mesh_count),
        );
        self.actor_tint_materials
            .insert(actor_id.to_string(), tint_materials);
        self.apply_actor_layers(actor_id);
        self.scene_revision += 1;
        Ok(())
    }
    /// Seek a bound actor animation to an explicit simulation timestamp.
    pub fn set_actor_animation_time(&mut self, actor_id: &str, time_s: f32) -> Result<()> {
        self.scene_revision += 1;
        let binding = self
            .actor_animations
            .get(actor_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("actor {actor_id} has no animation binding"))?;
        for entity in binding.players {
            let Some(mut player) = self.app.world_mut().get_mut::<AnimationPlayer>(entity) else {
                continue;
            };
            player
                .play(binding.node)
                .seek_to(time_s.max(0.0))
                .pause();
        }
        Ok(())
    }

    /// Write linear-RGB base colours into named material slots of an attached
    /// actor model (a ridden two-wheeler's `rider_*` palette slots). Each slot
    /// is cloned per actor, so instances sharing the GLB keep their own
    /// colours. Every requested slot must exist in the model: a missing slot
    /// fails instead of leaving the authored colour in place.
    pub fn set_actor_material_colors(&mut self, actor_id: &str, colors: &[(String, [f32; 3])]) -> Result<()> {
        if colors.is_empty() {
            return Ok(());
        }
        let (model_root, _, _) = *self
            .actor_models
            .get(actor_id)
            .ok_or_else(|| anyhow::anyhow!("set material colours before attaching a model: {actor_id}"))?;
        let targets = {
            let world = self.app.world();
            let mut stack = vec![model_root];
            let mut targets: Vec<(Entity, String, Handle<StandardMaterial>)> = Vec::new();
            while let Some(entity) = stack.pop() {
                if let Some(children) = world.get::<Children>(entity) {
                    stack.extend(children.iter());
                }
                let (Some(name), Some(material)) = (
                    world.get::<GltfMaterialName>(entity),
                    world.get::<MeshMaterial3d<StandardMaterial>>(entity),
                ) else {
                    continue;
                };
                if colors.iter().any(|(slot, _)| slot == &**name) {
                    targets.push((entity, name.to_string(), material.0.clone()));
                }
            }
            targets.sort_by_key(|(entity, _, _)| entity.index());
            targets
        };
        let mut owned = Vec::new();
        for (slot, color) in colors {
            let slot_targets: Vec<_> = targets.iter().filter(|(_, name, _)| name == slot).collect();
            let Some((_, _, source)) = slot_targets.first() else {
                bail!("actor {actor_id} model has no material slot {slot:?}");
            };
            let handle = {
                let world = self.app.world_mut();
                let mut material = world
                    .resource::<Assets<StandardMaterial>>()
                    .get(source)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("material {slot:?} missing after actor model load"))?;
                material.base_color = Color::linear_rgb(color[0], color[1], color[2]);
                world.resource_mut::<Assets<StandardMaterial>>().add(material)
            };
            for (entity, _, _) in slot_targets {
                self.app.world_mut().entity_mut(*entity).insert(MeshMaterial3d(handle.clone()));
            }
            owned.push(handle);
        }
        self.actor_palette_materials.insert(actor_id.to_string(), owned);
        self.scene_revision += 1;
        Ok(())
    }

    /// Linear-RGB base colours of the named slots on an attached model, in
    /// entity order (diagnostics and tests).
    pub fn actor_material_colors(&self, actor_id: &str, slot: &str) -> Vec<[f32; 3]> {
        let Some((model_root, _, _)) = self.actor_models.get(actor_id) else {
            return Vec::new();
        };
        let world = self.app.world();
        let materials = world.resource::<Assets<StandardMaterial>>();
        let mut stack = vec![*model_root];
        let mut out = Vec::new();
        while let Some(entity) = stack.pop() {
            if let Some(children) = world.get::<Children>(entity) {
                stack.extend(children.iter());
            }
            if world.get::<GltfMaterialName>(entity).is_some_and(|name| &**name == slot) {
                if let Some(material) = world.get::<MeshMaterial3d<StandardMaterial>>(entity).and_then(|m| materials.get(&m.0)) {
                    let c = material.base_color.to_linear();
                    out.push([c.red, c.green, c.blue]);
                }
            }
        }
        out
    }

    /// The world transform the renderer last drew for an actor's canonical
    /// body (the centre-origin cuboid that also drives the ID/sensor passes),
    /// read back from the ECS after propagation: an observation, not the
    /// requested pose. `None` for unknown actors.
    pub fn actor_world_pose(&self, actor_id: &str) -> Option<(Vec3, Quat)> {
        let (entity, _) = self.actors.get(actor_id)?;
        world_pose(self.app.world(), *entity)
    }

    /// Same for the actor's attached catalog model, when one is attached.
    pub fn actor_model_world_pose(&self, actor_id: &str) -> Option<(Vec3, Quat)> {
        let (entity, _, _) = self.actor_models.get(actor_id)?;
        world_pose(self.app.world(), *entity)
    }

    pub fn actor_has_model(&self, actor_id: &str) -> bool {
        self.actor_models.contains_key(actor_id)
    }

    pub fn actor_model_mesh_count(&self, actor_id: &str) -> usize {
        self.actor_models
            .get(actor_id)
            .map(|(_, _, count)| *count)
            .unwrap_or(0)
    }

    /// Effective sRGB base colors of this actor's cloned `body_paint`
    /// materials. Empty means the catalog model is not tintable.
    pub fn actor_model_tint_colors(&self, actor_id: &str) -> Vec<[f32; 4]> {
        let Some(handles) = self.actor_tint_materials.get(actor_id) else {
            return Vec::new();
        };
        let materials = self.app.world().resource::<Assets<StandardMaterial>>();
        handles
            .iter()
            .filter_map(|handle| materials.get(handle))
            .map(|material| material.base_color.to_srgba().to_f32_array())
            .collect()
    }
    /// Actor ids currently represented by visible scene geometry.
    pub fn actor_ids(&self) -> Vec<String> {
        self.actors.keys().cloned().collect()
    }

    /// Remove a despawned scene-state actor (both the visible box and its
    /// layer-1 ID clone).
    pub fn remove_actor(&mut self, id: &str) {
        self.scene_revision += 1;
        self.actor_id_clones.remove(id);
        if let Some((entity, instance)) = self.actors.remove(id) {
            let world = self.app.world_mut();
            let name = format!("actor:{id}");
            let mut q = world.query_filtered::<(Entity, &Name), With<IdClone>>();
            let clones: Vec<Entity> = q
                .iter(world)
                .filter(|(_, n)| n.as_str() == name)
                .map(|(e, _)| e)
                .collect();
            world.despawn(entity);
            for clone in clones {
                world.despawn(clone);
            }
            self.actor_classes.remove(&instance);
            if let Some((model, _, _)) = self.actor_models.remove(id) {
                world.despawn(model);
            }
            self.actor_tint_materials.remove(id);
            self.actor_palette_materials.remove(id);
            self.actor_animations.remove(id);
            if let Some((rider_id, _)) = self.actor_riders.remove(id) {
                self.actor_classes.remove(&rider_id);
            }
            self.actor_rest_poses.remove(id);
        }
    }

    /// The rider instance id of a ridden two-wheeler, if its model has a rider.
    pub fn actor_rider_instance_id(&self, actor_id: &str) -> Option<u32> {
        self.actor_riders.get(actor_id).map(|(id, _)| *id)
    }

    /// Semantic class name of a dynamic-actor instance id, if any.
    pub fn actor_instance_class(&self, instance_id: u32) -> Option<&str> {
        self.actor_classes.get(&instance_id).map(|s| s.as_str())
    }

    /// Stable instance id allocated to a dynamic actor, if it is spawned.
    pub fn actor_instance_id(&self, actor_id: &str) -> Option<u32> {
        self.actors.get(actor_id).map(|(_, instance_id)| *instance_id)
    }

    /// The static map geometry as instances of mesh assets: every
    /// instance-ID'd mesh that is not a dynamic actor, with the world matrix
    /// the cameras draw it with. The static layer of the lidar/radar scene
    /// is built from this (one tree per mesh asset, 2.2M unique triangles on
    /// Belmont instead of 266M world-space copies).
    ///
    /// Order is deterministic and part of the sensor contract (it is the
    /// last tie-break between coincident instances): by instance id, then
    /// the mesh's asset label, then the world matrix bits. Every mesh must
    /// have main-world data; a missing one is an error naming it.
    pub fn static_sensor_meshes(&mut self) -> Result<Vec<StaticSensorMesh>> {
        let world = self.app.world_mut();
        let mut query = world.query_filtered::<
            (&Mesh3d, &GlobalTransform, &InstanceId, Option<&Name>),
            Without<IdClone>,
        >();
        let meshes = world.resource::<Assets<Mesh>>();
        let mut out = Vec::new();
        for (mesh3d, transform, instance_id, name) in query.iter(world) {
            if name.is_some_and(|name| name.as_str().starts_with("actor:")) {
                continue;
            }
            let label = match mesh3d.0.path() {
                Some(path) => path.to_string(),
                None => format!("{}#{:?}", name.map(|name| name.as_str()).unwrap_or("unnamed static mesh"), mesh3d.0.id()),
            };
            if meshes.get(&mesh3d.0).is_none() {
                bail!(
                    "static mesh {label} (instance {}) has no main-world mesh data for the lidar/radar scene",
                    instance_id.0
                );
            }
            out.push(StaticSensorMesh {
                mesh: mesh3d.0.clone(),
                world: transform.to_matrix(),
                instance_id: instance_id.0,
                label,
            });
        }
        out.sort_by(|a, b| {
            a.instance_id
                .cmp(&b.instance_id)
                .then_with(|| a.label.cmp(&b.label))
                .then_with(|| a.world.to_cols_array().map(f32::to_bits).cmp(&b.world.to_cols_array().map(f32::to_bits)))
        });
        Ok(out)
    }

    /// Snapshot the static map geometry (every instance-ID'd mesh that is not
    /// a dynamic actor) as world-space triangles.
    ///
    /// Static geometry is captured once by the long-lived service. Actor
    /// geometry is never snapshotted as triangles: see
    /// [`Self::actor_sensor_meshes`]. A mesh the snapshot cannot read is an
    /// error naming it; it is never silently left out of the sensor world.
    pub fn static_sensor_triangles(&mut self) -> Result<Vec<SensorTriangle>> {
        let world = self.app.world_mut();
        let mut query = world.query_filtered::<
            (&Mesh3d, &GlobalTransform, &InstanceId, Option<&Name>),
            Without<IdClone>,
        >();
        let meshes = world.resource::<Assets<Mesh>>();
        let mut out = Vec::new();
        for (mesh3d, transform, instance_id, name) in query.iter(world) {
            if name.is_some_and(|name| name.as_str().starts_with("actor:")) {
                continue;
            }
            let label = name.map(|name| name.as_str()).unwrap_or("unnamed static mesh");
            let mesh = meshes.get(&mesh3d.0).ok_or_else(|| anyhow::anyhow!(
                "static mesh {label} (instance {}) has no main-world mesh data for the lidar/radar scene",
                instance_id.0
            ))?;
            let matrix = transform.to_matrix();
            for [a, b, c] in mesh_local_triangles(mesh, label)? {
                out.push(SensorTriangle {
                    a: matrix.transform_point3(a).to_array(),
                    b: matrix.transform_point3(b).to_array(),
                    c: matrix.transform_point3(c).to_array(),
                    instance_id: instance_id.0,
                });
            }
        }
        Ok(out)
    }

    /// The model-local triangles of one mesh asset, for the caller's
    /// per-mesh BLAS cache (built once per asset, not per tick).
    pub fn mesh_asset_triangles(&self, mesh: &Handle<Mesh>, label: &str) -> Result<Vec<[Vec3; 3]>> {
        let meshes = self.app.world().resource::<Assets<Mesh>>();
        let data = meshes.get(mesh).ok_or_else(|| anyhow::anyhow!(
            "mesh {label} has no main-world mesh data for the lidar/radar scene"
        ))?;
        mesh_local_triangles(data, label)
    }

    /// Every visible actor mesh as the ray sensors must see it this tick:
    /// exactly the geometry the RGB cameras draw. An actor with a catalog
    /// model contributes each visible mesh node of that model (wheels and
    /// other articulated nodes at their current world pose; skinned meshes
    /// posed on the CPU the way the skinning shader poses them). An actor
    /// without a model contributes the cuboid the cameras draw for it.
    ///
    /// Order is deterministic: actors by id, then model nodes in hierarchy
    /// order. Reads propagated `GlobalTransform`s, so call it after the
    /// tick's readiness/capture update (the same world the cameras drew).
    pub fn actor_sensor_meshes(&mut self) -> Result<Vec<ActorSensorMesh>> {
        let mut actor_ids: Vec<&String> = self.actors.keys().collect();
        actor_ids.sort();
        let world = self.app.world();
        let meshes = world.resource::<Assets<Mesh>>();
        let bindposes = world.resource::<Assets<bevy::mesh::skinning::SkinnedMeshInverseBindposes>>();
        let mut out = Vec::new();
        for actor_id in actor_ids {
            let (cuboid, instance_id) = self.actors[actor_id];
            let mut entities = Vec::new();
            match self.actor_models.get(actor_id) {
                Some(&(root, _, _)) => {
                    let mut stack = vec![root];
                    while let Some(entity) = stack.pop() {
                        if let Some(children) = world.get::<Children>(entity) {
                            // Reverse so the depth-first walk visits children
                            // in their declared order.
                            stack.extend(children.iter().rev());
                        }
                        if world.get::<IdClone>(entity).is_none() && world.get::<Mesh3d>(entity).is_some() {
                            entities.push(entity);
                        }
                    }
                    if entities.is_empty() {
                        bail!("actor {actor_id} has a catalog model with no mesh nodes for the lidar/radar scene");
                    }
                }
                None => entities.push(cuboid),
            }
            let mut contributed = 0usize;
            for entity in entities {
                let visible = world
                    .get::<InheritedVisibility>(entity)
                    .ok_or_else(|| anyhow::anyhow!("actor {actor_id} mesh {entity:?} has no visibility state"))?
                    .get();
                if !visible {
                    continue;
                }
                let label = world
                    .get::<Name>(entity)
                    .map(|name| format!("{actor_id}/{}", name.as_str()))
                    .unwrap_or_else(|| format!("{actor_id}/{entity:?}"));
                let handle = world.get::<Mesh3d>(entity).expect("filtered on Mesh3d").0.clone();
                let world_matrix = world
                    .get::<GlobalTransform>(entity)
                    .ok_or_else(|| anyhow::anyhow!("actor mesh {label} has no world transform"))?
                    .to_matrix();
                let geometry = match world.get::<SkinnedMesh>(entity) {
                    None => ActorSensorGeometry::Rigid { mesh: handle, world: world_matrix },
                    Some(skin) => {
                        let mesh = meshes.get(&handle).ok_or_else(|| anyhow::anyhow!(
                            "skinned actor mesh {label} has no main-world mesh data for the lidar/radar scene"
                        ))?;
                        let inverse = bindposes.get(&skin.inverse_bindposes).ok_or_else(|| anyhow::anyhow!(
                            "skinned actor mesh {label} has no inverse bindposes loaded"
                        ))?;
                        if inverse.len() < skin.joints.len() {
                            bail!("skinned actor mesh {label} has {} joints but {} inverse bindposes", skin.joints.len(), inverse.len());
                        }
                        let mut joints = Vec::with_capacity(skin.joints.len());
                        for (joint, inverse_bindpose) in skin.joints.iter().zip(inverse.iter()) {
                            let global = world.get::<GlobalTransform>(*joint).ok_or_else(|| anyhow::anyhow!(
                                "skinned actor mesh {label} joint {joint:?} has no world transform"
                            ))?;
                            // Same product the skin extraction uploads.
                            joints.push(Mat4::from(global.affine()) * *inverse_bindpose);
                        }
                        ActorSensorGeometry::Skinned {
                            mesh: handle.id(),
                            triangles: skinned_world_triangles(mesh, &joints, &label)?,
                        }
                    }
                };
                let instance_id = match self.actor_riders.get(actor_id) {
                    Some((rider_id, meshes)) if meshes.contains(&entity) => *rider_id,
                    _ => instance_id,
                };
                out.push(ActorSensorMesh { actor_id: actor_id.clone(), label, instance_id, geometry });
                contributed += 1;
            }
            if contributed == 0 {
                bail!("actor {actor_id} has no visible geometry for the lidar/radar scene");
            }
        }
        Ok(out)
    }

    /// Drop every registered camera group (respawn-on-view-change primitive:
    /// the next render re-registers with fresh attributes). Also prunes the
    /// render-world staging buffers for the removed targets.
    pub fn clear_cameras(&mut self) {
        let sensor_ids: Vec<String> =
            self.groups.iter().map(|g| g.spec.sensor_id.clone()).collect();
        for sensor_id in &sensor_ids {
            self.remove_camera(sensor_id);
        }
        self.next_camera_order = 0;
    }

    /// Wait for the current capture cameras' GPU permutations, not the prewarm rig.
    /// Returns the number of frames it rendered to get there.
    /// Fails once the GPU device reported an error (out of memory, device
    /// lost, validation): the renderer then produces no further frames, so
    /// every wait and capture reports the cause instead of timing out.
    pub fn ensure_rendering(&self) -> Result<()> {
        match &self.app.world().resource::<RenderFailure>().0 {
            None => Ok(()),
            Some(cause) => bail!("[native_render_device_error] the GPU device failed ({cause}); rendering has stopped"),
        }
    }

    pub fn wait_for_capture_ready(&mut self) -> Result<u32> {
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut last_sample = self.app.world().resource::<GpuPending>().samples();
        let mut idle_frames = 0;
        let mut updates = 0u32;
        loop {
            self.app.update();
            self.ensure_rendering()?;
            updates += 1;
            while self.receiver.try_recv().is_ok() {}
            let pending = self.app.world().resource::<GpuPending>();
            let sample = pending.samples();
            if sample != last_sample {
                last_sample = sample;
                idle_frames = if pending.is_idle() { idle_frames + 1 } else { 0 };
                if idle_frames >= GPU_IDLE_FRAMES {
                    return Ok(updates);
                }
            }
            if Instant::now() > deadline {
                bail!(
                    "capture cameras failed to become ready within 300 s ({} pipelines compiling, {} materials unbound)",
                    pending.pipelines(),
                    pending.materials()
                );
            }
        }
    }

    /// Update until all tiles are loaded, scenes spawned and instances built.
    /// Then builds the deterministic instance-ID pass. Returns the legend.
    pub fn wait_until_ready(&mut self) -> Result<Vec<LegendEntry>> {
        if self.ready {
            return Ok(self.app.world().resource::<Legend>().0.clone());
        }
        let deadline = Instant::now() + Duration::from_secs(300);
        let started = Instant::now();
        let mut scene_spawned_s: Option<f64> = None;
        let mut updates = 0u32;
        let mut gpu_idle_frames = 0u32;
        loop {
            self.app.update();
            self.ensure_rendering()?;
            updates += 1;
            let world = self.app.world_mut();
            if let Some(errors) = world.get_resource::<crate::veg::VegErrors>() {
                if !errors.0.is_empty() {
                    bail!("vegetation failed to load: {}", errors.0.join("; "));
                }
            }
            let pending_loads = {
                let mut q = world.query_filtered::<&TileLoad, Without<SceneSpawned>>();
                q.iter(world).count()
            };
            let pending_vegetation = {
                let mut q = world.query_filtered::<
                    &crate::veg::VegLoad,
                    (
                        Without<crate::veg::VegSceneSpawned>,
                        Without<crate::veg::VegFailed>,
                    ),
                >();
                q.iter(world).count()
            };
            let pending_instances = {
                let mut q = world.query_filtered::<
                    &crate::veg::VegRoot,
                    Without<crate::veg::VegInstantiated>,
                >();
                q.iter(world).count()
            };
            let pending_lods = match &self.geometry_lods {
                Some(lods) => {
                    use bevy::asset::RecursiveDependencyLoadState as State;
                    match world.resource::<AssetServer>().recursive_dependency_load_state(&lods.lod_gltf) {
                        State::Loaded => 0,
                        State::Failed(error) => bail!("geometry LOD derivative {} failed to load: {error}", lods.lod_path),
                        _ => 1,
                    }
                }
                None => 0,
            };
            if pending_loads == 0 && pending_vegetation == 0 && pending_instances == 0 && pending_lods == 0 {
                // Collect instance entities under the query's mutable borrow,
                // then re-check readiness through plain world access.
                let roots: Vec<Entity> = {
                    let mut q = world.query::<(Entity, &WorldInstance)>();
                    q.iter(world).map(|(e, _)| e).collect()
                };
                if !roots.is_empty() && world.get_resource::<WorldInstanceSpawner>().is_some() {
                    let spawner = world.resource::<WorldInstanceSpawner>();
                    let all_ready =
                        roots.iter().all(|e| match world.get::<WorldInstance>(*e) {
                            Some(wi) => spawner.instance_is_ready(**wi),
                            None => false,
                        });
                    // Scene entities exist; now the render world must have
                    // compiled every pipeline and bound every material, and
                    // stay that way for a few frames (each frame can queue
                    // new permutations).
                    if all_ready {
                        scene_spawned_s.get_or_insert(started.elapsed().as_secs_f64());
                        if world.resource::<GpuPending>().is_idle() {
                            gpu_idle_frames += 1;
                        } else {
                            gpu_idle_frames = 0;
                        }
                        if gpu_idle_frames >= GPU_IDLE_FRAMES {
                            break;
                        }
                    }
                }
            }
            if Instant::now() > deadline {
                let pending = self.app.world().resource::<GpuPending>();
                bail!(
                    "scene failed to become ready within 300 s ({} pipelines compiling, {} materials unbound)",
                    pending.pipelines(),
                    pending.materials()
                );
            }
        }
        let gpu_ready_s = started.elapsed().as_secs_f64();
        self.finalize_scene()?;
        let finalized_s = started.elapsed().as_secs_f64();
        // The ground derivative, when the scene has one, is the only height
        // source; the legacy field is built only for scenes without it.
        if self.ground_surface.is_none() {
            self.ground = GroundField::build(&mut self.app, 2.0);
        }
        let spawned = scene_spawned_s.unwrap_or(gpu_ready_s);
        self.ready_phases = vec![
            ("assetsLoadedAndSpawned", spawned),
            ("gpuPipelinesAndMaterials", gpu_ready_s - spawned),
            ("instanceIdPass", finalized_s - gpu_ready_s),
            ("groundField", started.elapsed().as_secs_f64() - finalized_s),
            ("readinessFrames", f64::from(updates)),
        ];
        // Now that tiles are loaded, put the planet surface on the scene's
        // own ground plane. The boundary-layer fog term has a 300 m scale
        // height, so a tens-of-metres offset would be visible.
        if self.lighting.atmosphere && self.lighting.ground_y.is_none() {
            let median = match &self.ground_surface {
                Some(surface) => Some(surface.median_z() as f32),
                None => self.ground.median_y(),
            };
            if let Some(median) = median {
                self.reanchor_atmosphere(median);
            }
        }
        self.ready = true;
        Ok(self.app.world().resource::<Legend>().0.clone())
    }

    fn finalize_scene(&mut self) -> Result<()> {
        let world = self.app.world_mut();

        // Deterministic instance-ID assignment: sort by mesh name then entity
        // bits (independent of ECS iteration order), then clone each mesh onto
        // render layer 1 under an unlit RGB24-encoded ID material.
        // A clone of a skinned mesh must carry the `SkinnedMesh` component:
        // the mesh's JOINTS/WEIGHTS attributes select the skinned pipeline
        // layout, and without the component Bevy binds the model-only bind
        // group and the draw fails validation (bevy#16929).
        //
        // Same-named meshes (instanced props, split primitives) are ordered
        // by their world pose, never by entity bits alone: entity allocation
        // follows async asset-load completion, so ordering on it gave the
        // same mesh a different ID from run to run (6 px of richmond id0
        // swapped ids between two runs on the RTX 3080). Entity bits remain
        // only as the last tie-break for exact duplicates (same name, same
        // sub-asset, same pose).
        let mut entries: Vec<(
            String,
            String,
            [f32; 7],
            u64,
            Entity,
            Handle<Mesh>,
            Option<Entity>,
            Transform,
            Option<SkinnedMesh>,
        )> = Vec::new();
        {
            let mut q = world.query::<(
                Entity,
                &Mesh3d,
                Option<&Name>,
                Option<&ChildOf>,
                Option<&Transform>,
                Option<&GlobalTransform>,
                Option<&SkinnedMesh>,
            )>();
            for (e, mesh, name, child_of, transform, global, skin) in q.iter(world) {
                let (_, rotation, translation) = global
                    .map(|g| g.to_scale_rotation_translation())
                    .unwrap_or_else(|| {
                        let t = transform.copied().unwrap_or(Transform::IDENTITY);
                        (t.scale, t.rotation, t.translation)
                    });
                entries.push((
                    name.map(|n| n.to_string())
                        .unwrap_or_else(|| "unnamed_mesh".to_string()),
                    // The glTF sub-asset label (`<file>#MeshN/PrimitiveM`):
                    // stable across runs, and it separates the primitives of
                    // one node, which share a name and a pose.
                    mesh.0.path().map(|p| p.to_string()).unwrap_or_default(),
                    [
                        translation.x,
                        translation.y,
                        translation.z,
                        rotation.x,
                        rotation.y,
                        rotation.z,
                        rotation.w,
                    ],
                    e.to_bits(),
                    e,
                    mesh.0.clone(),
                    child_of.map(|c| c.parent()),
                    transform.copied().unwrap_or(Transform::IDENTITY),
                    skin.cloned(),
                ));
            }
        }
        entries.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| {
                    a.2.iter()
                        .zip(b.2.iter())
                        .map(|(x, y)| x.total_cmp(y))
                        .find(|o| o.is_ne())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then(a.3.cmp(&b.3))
        });

        // Create all ID materials under one mutable borrow, then spawn the
        // clone entities once the assets borrow is released.
        let prepared: Vec<(
            u32,
            String,
            Entity,
            Handle<Mesh>,
            Handle<StandardMaterial>,
            Option<Entity>,
            Transform,
            Option<SkinnedMesh>,
        )> = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            entries
                .into_iter()
                .enumerate()
                .map(|(i, (name, _, _, _, entity, mesh_h, parent, transform, skin))| {
                    let id = (i + 1) as u32; // 0 reserved as background
                    let mat = materials.add(instance_id_material(id));
                    (id, name, entity, mesh_h, mat, parent, transform, skin)
                })
                .collect()
        };
        let mut legend = Vec::with_capacity(prepared.len());
        let mut id_clone_of = HashMap::with_capacity(prepared.len());
        for (id, name, entity, mesh_h, mat, parent, transform, skin) in prepared {
            world.entity_mut(entity).insert(InstanceId(id));
            let mut cmd = world.spawn((
                IdClone,
                Mesh3d(mesh_h),
                MeshMaterial3d(mat.clone()),
                RenderLayers::layer(1),
                transform,
            ));
            if let Some(p) = parent {
                cmd.insert(ChildOf(p));
            }
            if let Some(skin) = skin {
                cmd.insert(skin);
            }
            id_clone_of.insert(entity, (cmd.id(), mat));
            legend.push(LegendEntry { id, name });
        }
        // Dynamic actors take ids above the static legend: before this, the
        // first actors reused ids 1..N of static meshes, so the ID/semantic
        // passes, lidar/radar classes and radar velocities confused an actor
        // with a static mesh.
        let static_max = legend.iter().map(|entry| entry.id).max().unwrap_or(0); // fallback-ok: an empty legend has no ids to stay above
        world.resource_mut::<Legend>().0 = legend;
        if !self.actors.is_empty() {
            bail!("actors were spawned before the static instance-ID legend was frozen");
        }
        self.next_instance_id = static_max;
        self.id_clone_of = id_clone_of;
        if let Some(lods) = &self.geometry_lods {
            let (masters, levels) = crate::geometry_lod::spawn_levels(self.app.world_mut(), lods, &self.id_clone_of)?;
            eprintln!("geometry-lod: {masters} master primitives, {levels} level entities");
        }

        // One update so the newly spawned ID clones (and LOD levels, whose
        // ranges need propagated transforms) are extracted before the first
        // real render request.
        self.app.update();
        self.refresh_lod_ranges();
        Ok(())
    }

    /// Load the map's geometry LOD derivative (`manifest.json` beside its
    /// `lod.gltf`) for the master glTF `master`. Call after
    /// [`Self::load_tiles`] and before readiness; the levels are spawned
    /// when the scene is finalized.
    pub fn load_geometry_lods(&mut self, manifest: &std::path::Path, master: &str) -> Result<()> {
        let parsed = crate::geometry_lod::Manifest::load(manifest)?;
        let dir = manifest.parent().ok_or_else(|| anyhow::anyhow!("geometry LOD manifest has no directory"))?;
        let lod_path = crate::platform::asset_path(&dir.join("lod.gltf")).map_err(|e| anyhow::anyhow!("lod.gltf {e}"))?;
        let master_path = crate::platform::asset_path(std::path::Path::new(master)).map_err(|e| anyhow::anyhow!("master {e}"))?;
        let lod_gltf = self.app.world().resource::<AssetServer>().load(lod_path.clone());
        self.geometry_lods = Some(crate::geometry_lod::GeometryLods {
            manifest: parsed,
            lod_path,
            master_path,
            lod_gltf,
            pixel_error_px: self
                .render_config
                .map_or(crate::geometry_lod::DEFAULT_PIXEL_ERROR_PX, |config| config.lod.pixel_error_px), // fallback-ok: the derivative's own default when no render config was applied (tests)
            applied_f_px: None,
        });
        Ok(())
    }

    /// Recompute LOD ranges for the most demanding RGB camera of the rig
    /// (largest focal length in pixels). No-op without LODs or cameras, or
    /// when the rig's focal length did not change.
    fn refresh_lod_ranges(&mut self) {
        let Some(lods) = &self.geometry_lods else { return };
        let f_px = self
            .groups
            .iter()
            .map(|g| crate::geometry_lod::focal_px(g.spec.fov_y_deg.to_radians(), g.spec.height))
            .fold(0.0f32, f32::max);
        if f_px <= 0.0 || lods.applied_f_px == Some(f_px) {
            return;
        }
        let pixel_error = lods.pixel_error_px;
        crate::geometry_lod::apply_ranges(self.app.world_mut(), f_px, pixel_error);
        if let Some(lods) = &mut self.geometry_lods {
            lods.applied_f_px = Some(f_px);
        }
    }

    fn set_camera_transform(&mut self, sensor_id: &str, transform: Transform) -> Result<()> {
        let group = self
            .groups
            .iter()
            .find(|g| g.spec.sensor_id == sensor_id)
            .ok_or_else(|| anyhow::anyhow!("unknown sensor {sensor_id}"))?;
        self.scene_revision += 1;
        let world = self.app.world_mut();
        if let Some(mut t) = world.get_mut::<Transform>(group.rgb_entity) {
            *t = transform;
        }
        if let Some(id_entity) = group.id_entity {
            if let Some(mut t) = world.get_mut::<Transform>(id_entity) {
                *t = transform;
            }
        }
        Ok(())
    }

    /// Set the eye/target pose of a registered camera group (RGB + ID cams).
    pub fn set_pose(&mut self, sensor_id: &str, eye: &[f32; 3], target: &[f32; 3]) -> Result<()> {
        let transform = Transform::from_translation(Vec3::from_slice(eye))
            .looking_at(Vec3::from_slice(target), Vec3::Y);
        self.set_camera_transform(sensor_id, transform)
    }

    /// Set the full world pose of a registered camera group, preserving roll.
    pub fn set_camera_pose(
        &mut self,
        sensor_id: &str,
        position: &[f32; 3],
        rotation: Quat,
    ) -> Result<()> {
        self.set_camera_transform(
            sensor_id,
            Transform::from_translation(Vec3::from_slice(position)).with_rotation(rotation),
        )
    }

    /// Unregister a camera group: its cameras and readback targets are
    /// despawned, the render targets are released with their last handle,
    /// the render world drops the matching staging buffers on the next
    /// iteration (`sync_staging` reconciles against registered targets), and
    /// an open device stream for the sensor is torn down (outstanding
    /// consumer imports keep their own memory alive).
    pub fn remove_camera(&mut self, sensor_id: &str) -> bool {
        let Some(index) = self
            .groups
            .iter()
            .position(|g| g.spec.sensor_id == sensor_id)
        else {
            return false;
        };
        #[cfg(feature = "gpu-interop")]
        if let Err(error) = self.close_device_stream(sensor_id, Duration::ZERO) {
            eprintln!("remove_camera {sensor_id}: {error:#}");
        }
        let group = self.groups.remove(index);
        let keys: Vec<String> = group.spec.passes.keys(&group.spec.sensor_id);
        let world = self.app.world_mut();
        let mut stale: Vec<Entity> = vec![group.rgb_entity];
        stale.extend(group.id_entity);
        {
            let mut targets = world.query::<(Entity, &ReadbackTarget)>();
            for (entity, target) in targets.iter(world) {
                if keys.iter().any(|k| *k == target.key) {
                    stale.push(entity);
                }
            }
        }
        for entity in stale {
            world.despawn(entity);
        }
        world.flush();
        self.rig_revision += 1;
        self.sync_host_layers();
        self.refresh_lod_ranges();
        true
    }

    /// Expected readback keys across all registered cameras.
    pub fn expected_keys(&self) -> Vec<String> {
        self.groups
            .iter()
            .flat_map(|g| {
                let mut keys = g.spec.passes.keys(&g.spec.sensor_id);
                // Every RGB camera registers its exposure readback; it is
                // only filled when the look carries the camera model.
                if g.spec.passes.rgb {
                    keys.push(format!("{}:exposure", g.spec.sensor_id));
                }
                keys
            })
            .collect()
    }

    /// Current rig revision (see [`FrameIdentity::rig_revision`]).
    pub fn rig_revision(&self) -> u64 {
        self.rig_revision
    }

    /// Current scene revision (see [`FrameIdentity::scene_revision`]).
    pub fn scene_revision(&self) -> u64 {
        self.scene_revision
    }

    /// Render one iteration with the given capture request and return its
    /// generation. Nothing is copied or mapped for an empty request, and
    /// the request is cleared afterwards so plain `App::update` calls made
    /// while loading assets never copy.
    fn submit(&mut self, mut request: CaptureRequest) -> u64 {
        self.generation += 1;
        request.generation = self.generation;
        self.app.world_mut().insert_resource(request);
        self.app.update();
        self.app.world_mut().insert_resource(CaptureRequest {
            generation: self.generation,
            ..Default::default()
        });
        self.generation
    }

    /// Warmup iterations: lets shaders/pipelines compile so subsequent
    /// captures measure steady state. Renders without any readback.
    pub fn warmup(&mut self, iterations: u32) {
        for _ in 0..iterations {
            self.submit(CaptureRequest::default());
        }
        self.drain_outputs();
    }

    fn drain_outputs(&mut self) {
        while self.receiver.try_recv().is_ok() {}
        #[cfg(feature = "gpu-interop")]
        while self.device_receiver.try_recv().is_ok() {}
    }

    /// Capture every registered pass of one submission to host memory.
    pub fn render_once(&mut self, sim_tick: u64) -> Result<CapturedFrame> {
        let with_model: Vec<String> = self
            .groups
            .iter()
            .filter(|g| self.app.world().get::<crate::camera_model::CameraModel>(g.rgb_entity).is_some())
            .map(|g| format!("{}:exposure", g.spec.sensor_id))
            .collect();
        let keys: Vec<String> = self
            .expected_keys()
            .into_iter()
            .filter(|key| !key.ends_with(":exposure") || with_model.contains(key))
            .collect();
        self.capture(sim_tick, &keys)
    }

    /// Render one submission of the resident scene and return exactly the
    /// requested host passes, all copied from that submission.
    ///
    /// Instance-ID cameras render only when one of their passes is
    /// requested; RGB views always render so history-bearing cinematic
    /// stacks keep their state. Passes that were not requested are neither
    /// copied nor mapped.
    ///
    /// A frame is complete only when every requested output came from one
    /// submission *and* the render world sampled idle at the end of it:
    /// Bevy skips any draw whose pipeline is still compiling or whose
    /// material is not yet bound, so a submission that queued new
    /// permutations (a view registered after readiness, a relight, a newly
    /// spawned actor material) is rendered without them. Such a submission
    /// is withdrawn (its device slots returned), the GPU is settled
    /// ([`Self::settle_gpu`], bounded) and the request is resubmitted; on a
    /// steady scene no extra frame is spent. Outputs of an earlier generation
    /// are discarded, never merged.
    pub fn capture(&mut self, sim_tick: u64, keys: &[String]) -> Result<CapturedFrame> {
        self.capture_request(
            sim_tick,
            CaptureRequest { keys: keys.to_vec(), ..Default::default() },
        )
    }

    /// [`Self::capture`] plus device-resident outputs: every sensor in
    /// `device_sensors` must have an open stream
    /// ([`Self::open_device_stream`]); its planes are copied GPU-locally
    /// into a leased slot of that stream by the same submission, and the
    /// slot's ready signal is bound to it. The returned
    /// [`CapturedFrame::device`] entries name the slots to lease. A sensor
    /// whose slots are all outstanding past its wait is an error for the
    /// whole capture (bounded backpressure, no silent drop).
    #[cfg(feature = "gpu-interop")]
    pub fn capture_device(
        &mut self,
        sim_tick: u64,
        keys: &[String],
        device_sensors: &[String],
    ) -> Result<CapturedFrame> {
        let mut device = Vec::with_capacity(device_sensors.len());
        for sensor_id in device_sensors {
            let copy = self
                .device_streams
                .get(sensor_id)
                .ok_or_else(|| anyhow::anyhow!("capture: no device stream open for {sensor_id}"))?;
            device.push(copy.clone());
        }
        self.capture_request(sim_tick, CaptureRequest { keys: keys.to_vec(), device, ..Default::default() })
    }

    /// Submit a host capture and return without waiting for the GPU, so the
    /// caller can queue the next frame's CPU work while this one renders.
    /// Same contract as [`Self::capture`]: when the submission is not a
    /// complete, settled frame (pipelines compiling, a view not extracted)
    /// it is withdrawn and the blocking path produces the frame, returned
    /// as [`CaptureTicket::Ready`]. At most [`READBACK_SLOTS`] tickets may
    /// be pending: a caller begins capture N+1 and then finishes capture N.
    pub fn capture_begin(&mut self, sim_tick: u64, keys: &[String]) -> Result<CaptureTicket> {
        let registered = self.expected_keys();
        if let Some(unknown) = keys.iter().find(|k| !registered.contains(k)) {
            bail!("capture: pass {unknown:?} is not registered");
        }
        if self.deferred_maps.0.lock().expect("deferred maps").len() >= READBACK_SLOTS {
            bail!("capture_begin: every readback slot holds a pending capture; finish one first");
        }
        // Instance-ID views render only when requested (as in `capture`).
        let id_activity: Vec<(Entity, bool)> = self
            .groups
            .iter()
            .filter_map(|g| Some((g.id_entity?, keys.iter().any(|k| *k == format!("{}:id", g.spec.sensor_id)))))
            .collect();
        {
            let world = self.app.world_mut();
            for (entity, active) in id_activity {
                if let Some(mut camera) = world.get_mut::<Camera>(entity) {
                    if camera.is_active != active {
                        camera.is_active = active;
                    }
                }
            }
        }
        self.drain_outputs();
        let slot = self.free_slot();
        let mut stats = CaptureStats::default();
        let submitted = Instant::now();
        if let CaptureClock::Pinned { samples } = self.capture_clock {
            let taa = self.reset_taa_history();
            let lead = if taa { samples.max(1) - 1 } else { 0 };
            for sample in 0..lead {
                self.pinned_sample.set(Some(sample));
                self.submit(CaptureRequest::default());
                stats.accumulation_frames += 1;
            }
            self.pinned_sample.set(Some(lead));
        }
        let generation = self.submit(CaptureRequest { keys: keys.to_vec(), slot, deferred: true, ..Default::default() });
        self.ensure_rendering()?;
        if self.capture_clock != CaptureClock::Free {
            self.pinned_sample.set(Some(0));
        }
        stats.attempts = 1;
        stats.submit_ms = submitted.elapsed().as_secs_f64() * 1000.0;
        let settled = self.app.world().resource::<GpuPending>().is_idle();
        let started = {
            let maps = self.deferred_maps.0.lock().expect("deferred maps");
            maps.iter().find(|m| m.generation == generation).map_or(0, |m| m.expected)
        };
        let pending = PendingCapture {
            identity: FrameIdentity {
                sim_tick,
                scene_revision: self.scene_revision,
                rig_revision: self.rig_revision,
                generation,
            },
            keys: keys.to_vec(),
            stats,
        };
        if settled && started == keys.len() {
            return Ok(CaptureTicket::Pending(pending));
        }
        // Not a complete frame of the resident scene: drop it and let the
        // blocking path settle and resubmit (its retries restart from
        // sample 0 under a pinned clock).
        let _ = self.collect_deferred(&pending);
        let frame = self.capture(sim_tick, keys)?;
        self.last_capture.submit_ms += stats.submit_ms;
        self.last_capture.accumulation_frames += stats.accumulation_frames;
        Ok(CaptureTicket::Ready(frame))
    }

    /// Wait for a [`CaptureTicket`]'s readback and return its frame.
    pub fn capture_finish(&mut self, ticket: CaptureTicket) -> Result<CapturedFrame> {
        match ticket {
            CaptureTicket::Ready(frame) => Ok(frame),
            CaptureTicket::Pending(pending) => {
                let (passes, wait_ms, copy_ms, bytes) = self.collect_deferred(&pending)?;
                if let Some(missing) = pending.keys.iter().find(|k| !passes.contains_key(*k)) {
                    bail!("capture incomplete: generation {} missing {missing:?}", pending.identity.generation);
                }
                self.last_capture = CaptureStats {
                    readback_wait_ms: wait_ms,
                    readback_copy_ms: copy_ms,
                    readback_bytes: bytes,
                    ..pending.stats
                };
                Ok(CapturedFrame { identity: pending.identity, passes, device: HashMap::new() })
            }
        }
    }

    /// Poll (without blocking the queue on later work) until the deferred
    /// maps of `pending` complete, then copy them out and unmap.
    fn collect_deferred(&mut self, pending: &PendingCapture) -> Result<(HashMap<String, CapturedPass>, f64, f64, u64)> {
        let generation = pending.identity.generation;
        let map = {
            let mut maps = self.deferred_maps.0.lock().expect("deferred maps");
            let index = maps.iter().position(|m| m.generation == generation);
            index.map(|index| maps.remove(index))
        };
        let Some(map) = map else { return Ok((HashMap::new(), 0.0, 0.0, 0)) };
        let waited = Instant::now();
        let deadline = waited + Duration::from_secs(120);
        let device = self.app.world().resource::<RenderDevice>().clone();
        while map.done.load(std::sync::atomic::Ordering::Acquire) < map.expected {
            // `Poll` only reaps finished work; it never waits for frames
            // queued after this capture.
            device.poll(PollType::Poll).map_err(|error| anyhow::anyhow!("poll device: {error}"))?;
            if map.done.load(std::sync::atomic::Ordering::Acquire) >= map.expected {
                break;
            }
            self.ensure_rendering()?;
            if Instant::now() > deadline {
                bail!("capture readback of generation {generation} did not complete within 120 s");
            }
            std::thread::sleep(Duration::from_micros(250));
        }
        let wait_ms = waited.elapsed().as_secs_f64() * 1000.0;
        let failed = map.failed.load(std::sync::atomic::Ordering::Acquire);
        let copied = Instant::now();
        let mut passes = HashMap::with_capacity(map.expected);
        let mut bytes = 0u64;
        let render_world = self.app.get_sub_app_mut(RenderApp).expect("render app").world_mut();
        let mut staging = render_world.resource_mut::<Staging>();
        for b in staging.0.iter_mut().filter(|b| b.copied && b.slot == map.slot) {
            if !failed {
                let data = b.buffer.slice(..).get_mapped_range().to_vec();
                bytes += data.len() as u64;
                passes.insert(
                    b.key.clone(),
                    CapturedPass { width: b.width, height: b.height, padded_row: b.padded_row, bytes: data },
                );
                b.buffer.unmap();
            }
            b.copied = false;
        }
        if failed {
            bail!("capture readback of generation {generation} failed to map");
        }
        Ok((passes, wait_ms, copied.elapsed().as_secs_f64() * 1000.0, bytes))
    }

    /// A staging slot no deferred capture is holding.
    fn free_slot(&self) -> usize {
        let busy: Vec<usize> = self.deferred_maps.0.lock().expect("deferred maps").iter().map(|m| m.slot).collect();
        (0..READBACK_SLOTS).find(|slot| !busy.contains(slot)).unwrap_or(0)
    }

    fn capture_request(&mut self, sim_tick: u64, mut request: CaptureRequest) -> Result<CapturedFrame> {
        request.slot = self.free_slot();
        request.deferred = false;
        let registered = self.expected_keys();
        if let Some(unknown) = request.keys.iter().find(|k| !registered.contains(k)) {
            bail!("capture: pass {unknown:?} is not registered");
        }
        let wants_id = |sensor_id: &str| -> bool {
            let key = format!("{sensor_id}:id");
            let host = request.keys.iter().any(|k| *k == key);
            #[cfg(feature = "gpu-interop")]
            let host = host
                || request.device.iter().any(|copy| {
                    copy.sensor_id == sensor_id && copy.planes.iter().any(|p| p.name == "id")
                });
            host
        };
        let id_activity: Vec<(Entity, bool)> = self
            .groups
            .iter()
            .filter_map(|g| Some((g.id_entity?, wants_id(&g.spec.sensor_id))))
            .collect();
        {
            let world = self.app.world_mut();
            for (entity, active) in id_activity {
                if let Some(mut camera) = world.get_mut::<Camera>(entity) {
                    if camera.is_active != active {
                        camera.is_active = active;
                    }
                }
            }
        }
        self.drain_outputs();
        let mut stale = 0usize;
        let mut missing: Vec<String> = Vec::new();
        let mut stats = CaptureStats::default();
        for _ in 0..3 {
            *self.readback_clock.0.lock().expect("readback clock") = ReadbackTiming::default();
            let submitted = Instant::now();
            // Pinned clock: TAA views restart their history and accumulate
            // `samples` jittered frames of this pose; the last one is the
            // capture. Each attempt starts again from sample 0.
            if let CaptureClock::Pinned { samples } = self.capture_clock {
                let taa = self.reset_taa_history();
                let lead = if taa { samples.max(1) - 1 } else { 0 };
                for sample in 0..lead {
                    self.pinned_sample.set(Some(sample));
                    self.submit(CaptureRequest::default());
                    stats.accumulation_frames += 1;
                }
                self.pinned_sample.set(Some(lead));
            }
            let generation = self.submit(request.clone());
            self.ensure_rendering()?;
            if self.capture_clock != CaptureClock::Free {
                self.pinned_sample.set(Some(0));
            }
            stats.attempts += 1;
            stats.submit_ms += submitted.elapsed().as_secs_f64() * 1000.0;
            {
                let timing = *self.readback_clock.0.lock().expect("readback clock");
                stats.readback_wait_ms += timing.wait_ms;
                stats.readback_copy_ms += timing.copy_ms;
                stats.readback_bytes = timing.bytes;
            }
            let mut passes: HashMap<String, CapturedPass> =
                HashMap::with_capacity(request.keys.len());
            while let Ok(p) = self.receiver.try_recv() {
                if p.generation != generation {
                    stale += 1;
                    continue;
                }
                passes.insert(
                    p.key,
                    CapturedPass {
                        width: p.width,
                        height: p.height,
                        padded_row: p.padded_row,
                        bytes: p.data,
                    },
                );
            }
            #[cfg_attr(not(feature = "gpu-interop"), allow(unused_mut))]
            let mut device: HashMap<String, DeviceReady> = HashMap::new();
            #[cfg(feature = "gpu-interop")]
            {
                while let Ok(sent) = self.device_receiver.try_recv() {
                    if sent.generation != generation {
                        stale += 1;
                        continue;
                    }
                    match sent.result {
                        Ok(ready) => {
                            device.insert(
                                sent.sensor_id,
                                DeviceReady {
                                    stream: ready.stream_id.0,
                                    slot: ready.slot,
                                    generation: ready.generation,
                                },
                            );
                        }
                        // A slot could not be filled from this submission:
                        // backpressure, capability or a view that did not
                        // render. Retrying would only burn slots.
                        Err(error) => bail!("capture: device stream {}: {error}", sent.sensor_id),
                    }
                }
            }
            missing = request
                .keys
                .iter()
                .filter(|k| !passes.contains_key(*k))
                .cloned()
                .collect();
            #[cfg(feature = "gpu-interop")]
            missing.extend(
                request
                    .device
                    .iter()
                    .filter(|copy| !device.contains_key(&copy.sensor_id))
                    .map(|copy| format!("device:{}", copy.sensor_id)),
            );
            // Bevy silently skips a draw whose pipeline is still compiling
            // or whose material has no bind group yet. `GpuPending` is
            // sampled at the end of this frame's render, so a non-idle
            // sample means this submission may be missing primitives: it
            // is not a frame of the resident scene. Settle and resubmit.
            let settled = self.app.world().resource::<GpuPending>().is_idle();
            if missing.is_empty() && settled {
                self.last_capture = stats;
                return Ok(CapturedFrame {
                    identity: FrameIdentity {
                        sim_tick,
                        scene_revision: self.scene_revision,
                        rig_revision: self.rig_revision,
                        generation,
                    },
                    passes,
                    device,
                });
            }
            #[cfg(feature = "gpu-interop")]
            self.withdraw_device_frames(device)?;
            if !settled {
                missing.push("gpu-settled (pipelines compiling or materials unbound during the frame)".into());
                stats.settle_updates += self.settle_gpu()?;
            }
        }
        self.last_capture = stats;
        bail!(
            "capture incomplete: generation {} missing {:?} ({stale} outputs of other generations discarded)",
            self.generation,
            missing
        )
    }

    /// Pump empty submissions until the render world reports no pipeline
    /// compiling and no material unbound for [`GPU_IDLE_FRAMES`]
    /// consecutive frames. Bounded: a permutation that never compiles is an
    /// error, not a black frame.
    fn settle_gpu(&mut self) -> Result<u32> {
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut idle = 0u32;
        let mut updates = 0u32;
        while idle < GPU_IDLE_FRAMES {
            if Instant::now() > deadline {
                let pending = self.app.world().resource::<GpuPending>();
                bail!(
                    "render world failed to settle within 120 s ({} pipelines compiling, {} materials unbound)",
                    pending.pipelines(),
                    pending.materials()
                );
            }
            self.submit(CaptureRequest::default());
            self.ensure_rendering()?;
            updates += 1;
            idle = if self.app.world().resource::<GpuPending>().is_idle() { idle + 1 } else { 0 };
        }
        self.drain_outputs();
        Ok(updates)
    }

    /// Phases of the scene's readiness wait, seconds (diagnostics).
    pub fn ready_phases(&self) -> &[(&'static str, f64)] {
        &self.ready_phases
    }

    /// Timing of the last [`Self::capture`] (diagnostics).
    pub fn last_capture_stats(&self) -> CaptureStats {
        self.last_capture
    }

    /// Select how captures depend on previously rendered frames (see
    /// [`CaptureClock`]).
    pub fn set_capture_clock(&mut self, clock: CaptureClock) {
        self.capture_clock = clock;
        // Clustered lights: Bevy's GPU clustering fills each cluster's light
        // list through atomics, so the order lights are summed in (and the
        // low bits of the result) varies run to run, and an overflowing list
        // is resized with "a few incorrect frames". CPU clustering orders the
        // lists deterministically; a pinned capture uses it.
        if let Some(mut settings) = self.app.world_mut().get_resource_mut::<bevy::light::cluster::GlobalClusterSettings>() {
            if self.gpu_clustering_default.is_none() {
                self.gpu_clustering_default = Some(settings.gpu_clustering);
            }
            settings.gpu_clustering = match clock {
                CaptureClock::Free => self.gpu_clustering_default.flatten(),
                CaptureClock::Pinned { .. } => None,
            };
        }
        match clock {
            CaptureClock::Free => {
                self.pinned_sample.set(None);
                if let Some(mut sky) = self.app.world_mut().get_resource_mut::<crate::sky_pass::SkyClock>() {
                    sky.pinned = None;
                }
            }
            CaptureClock::Pinned { .. } => {
                self.pinned_sample.set(Some(0));
                let seconds = self
                    .app
                    .world()
                    .get_resource::<crate::sky_pass::SkyClock>()
                    .map_or(0.0, |sky| sky.seconds);
                self.set_sim_time(seconds);
            }
        }
    }

    pub fn capture_clock(&self) -> CaptureClock {
        self.capture_clock
    }

    /// Pin the sky (cloud drift) to simulation time `seconds` for every
    /// frame until the next call. Only meaningful under
    /// [`CaptureClock::Pinned`]; the free clock keeps advancing per frame.
    pub fn set_sim_time(&mut self, seconds: f64) {
        if self.capture_clock == CaptureClock::Free {
            return;
        }
        if let Some(mut sky) = self.app.world_mut().get_resource_mut::<crate::sky_pass::SkyClock>() {
            sky.pinned = Some(seconds);
            sky.seconds = seconds;
        }
    }

    /// Restart every TAA view's history (pinned captures).
    fn reset_taa_history(&mut self) -> bool {
        let entities: Vec<Entity> = self.groups.iter().map(|g| g.rgb_entity).collect();
        let world = self.app.world_mut();
        let mut any = false;
        for entity in entities {
            if let Some(mut taa) = world.get_mut::<TemporalAntiAliasing>(entity) {
                taa.reset = true;
                any = true;
            }
        }
        any
    }

    /// Return device slots filled by a submission that will not be
    /// published: their `ReadyFrame` never reaches a consumer, so the
    /// producer withdraws them instead of leaving them outstanding.
    #[cfg(feature = "gpu-interop")]
    fn withdraw_device_frames(&mut self, device: HashMap<String, DeviceReady>) -> Result<()> {
        if device.is_empty() {
            return Ok(());
        }
        let interop = self.device_interop()?;
        for (sensor_id, ready) in device {
            interop
                .withdraw(crate::gpu_interop::ReadyFrame {
                    stream_id: crate::gpu_interop::StreamId(ready.stream),
                    slot: ready.slot,
                    generation: ready.generation,
                })
                .map_err(|error| anyhow::anyhow!("withdraw device frame for {sensor_id}: {error}"))?;
        }
        Ok(())
    }

    /// Open (or return the existing) device interop on the render device.
    /// Fails with the explicit capability rejection when the device cannot
    /// export memory/semaphores; callers keep the host capture path.
    #[cfg(feature = "gpu-interop")]
    fn device_interop(&mut self) -> Result<&mut crate::gpu_interop::GpuInterop> {
        use bevy::render::renderer::RenderQueue;
        use crate::gpu_interop::GpuInterop;
        let world = self.app.sub_app_mut(RenderApp).world_mut();
        if !world.contains_resource::<GpuInterop>() {
            let device = world.resource::<RenderDevice>().clone();
            let queue = world.resource::<RenderQueue>().clone();
            let interop = GpuInterop::new(&device, &queue)
                .map_err(|error| anyhow::anyhow!("device interop unavailable: {error}"))?;
            world.insert_resource(interop);
        }
        Ok(world.resource_mut::<GpuInterop>().into_inner())
    }

    /// Vulkan device identity and export capabilities, opening the interop
    /// if needed.
    #[cfg(feature = "gpu-interop")]
    pub fn device_capabilities(&mut self) -> Result<crate::gpu_interop::InteropCapabilities> {
        Ok(self.device_interop()?.capabilities().clone())
    }

    /// Allocate an exportable device stream for a registered camera with
    /// `slots` independently leasable outputs and one plane per requested
    /// pass (`rgb`/`id` RGBA8 sRGB, `depth` Depth32Float, all at the
    /// camera's resolution). `wait` bounds how long a capture blocks for a
    /// consumer release when every slot is outstanding; `None` fails fast.
    /// A stream already open for the sensor is replaced.
    #[cfg(feature = "gpu-interop")]
    pub fn open_device_stream(
        &mut self,
        sensor_id: &str,
        passes: PassSet,
        slots: usize,
        wait: Option<Duration>,
    ) -> Result<(u64, Vec<crate::gpu_interop::PlaneLayout>)> {
        use crate::gpu_interop::{PlaneDescriptor, PlaneFormat, StreamDescriptor};
        let group = self
            .groups
            .iter()
            .find(|g| g.spec.sensor_id == sensor_id)
            .ok_or_else(|| anyhow::anyhow!("unknown sensor {sensor_id}"))?;
        if passes.id && group.id_entity.is_none() {
            bail!("camera {sensor_id} was registered without an instance-ID pass");
        }
        if !passes.rgb && !passes.id && !passes.depth {
            bail!("device stream for {sensor_id} needs at least one plane");
        }
        let world = self.app.world();
        let target_image = |entity: Entity| -> Result<Handle<Image>> {
            match world.get::<RenderTarget>(entity) {
                Some(RenderTarget::Image(target)) => Ok(target.handle.clone()),
                _ => bail!("camera {sensor_id} has no image render target"),
            }
        };
        let rgb_image = target_image(group.rgb_entity)?;
        let (width, height) = (group.spec.width, group.spec.height);
        let mut planes = Vec::with_capacity(3);
        if passes.rgb {
            planes.push(DevicePlane { name: "rgb", src_image: rgb_image.clone(), depth: false });
        }
        if passes.id {
            let id_image = target_image(group.id_entity.expect("checked above"))?;
            planes.push(DevicePlane { name: "id", src_image: id_image, depth: false });
        }
        if passes.depth {
            planes.push(DevicePlane { name: "depth", src_image: rgb_image, depth: true });
        }
        let descriptor = StreamDescriptor {
            label: sensor_id.to_string(),
            slots,
            planes: planes
                .iter()
                .map(|plane| PlaneDescriptor {
                    name: plane.name.to_string(),
                    width,
                    height,
                    format: if plane.depth {
                        PlaneFormat::Depth32Float
                    } else if plane.name == "id" {
                        PlaneFormat::Rgba8Unorm
                    } else {
                        PlaneFormat::Rgba8UnormSrgb
                    },
                })
                .collect(),
        };
        self.close_device_stream(sensor_id, Duration::ZERO)?;
        let interop = self.device_interop()?;
        let stream = interop
            .create_stream(&descriptor)
            .map_err(|error| anyhow::anyhow!("create device stream for {sensor_id}: {error}"))?;
        let layouts = interop
            .planes(stream)
            .map_err(|error| anyhow::anyhow!("{error}"))?
            .to_vec();
        self.device_streams.insert(
            sensor_id.to_string(),
            DeviceCopy { sensor_id: sensor_id.to_string(), stream, wait, planes },
        );
        Ok((stream.0, layouts))
    }

    /// Fresh exportable handles and the manifest of a sensor's stream.
    #[cfg(feature = "gpu-interop")]
    pub fn export_device_stream(&mut self, sensor_id: &str) -> Result<crate::gpu_interop::ExportedStream> {
        let stream = self
            .device_streams
            .get(sensor_id)
            .map(|copy| copy.stream)
            .ok_or_else(|| anyhow::anyhow!("no device stream open for {sensor_id}"))?;
        self.device_interop()?
            .export_stream(stream)
            .map_err(|error| anyhow::anyhow!("export device stream for {sensor_id}: {error}"))
    }

    /// Release a sensor's device stream after waiting up to `grace` for
    /// outstanding consumer leases. Returns `None` when no stream was open.
    #[cfg(feature = "gpu-interop")]
    pub fn close_device_stream(
        &mut self,
        sensor_id: &str,
        grace: Duration,
    ) -> Result<Option<crate::gpu_interop::StreamTeardown>> {
        let Some(copy) = self.device_streams.remove(sensor_id) else {
            return Ok(None);
        };
        self.device_interop()?
            .destroy_stream(copy.stream, grace)
            .map(Some)
            .map_err(|error| anyhow::anyhow!("close device stream for {sensor_id}: {error}"))
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }
}

// ---------------------------------------------------------------------------
// Main-world systems
// ---------------------------------------------------------------------------

/// When a queued tile's glTF and every asset it references (external images,
/// buffers) have loaded, spawn its default scene (WorldAssetRoot) and mark it
/// loaded. Gating on the `Gltf` asset alone is not enough: master glTFs keep
/// their images as external `.ktx2` files that load after the document, and a
/// frame captured before they land shows fallback materials.
fn spawn_loaded_tiles(
    mut commands: Commands,
    server: Res<AssetServer>,
    gltfs: Res<Assets<Gltf>>,
    loads: Query<(Entity, &TileLoad), Without<SceneSpawned>>,
) {
    for (e, tile) in &loads {
        let Some(gltf) = gltfs.get(&tile.0) else {
            continue;
        };
        match server.recursive_dependency_load_state(tile.0.id()) {
            RecursiveDependencyLoadState::Loaded => {}
            RecursiveDependencyLoadState::Failed(error) => {
                panic!("glTF dependency failed to load: {error}");
            }
            RecursiveDependencyLoadState::NotLoaded | RecursiveDependencyLoadState::Loading => continue,
        }
        // glTF makes `scene` optional; a file without a default scene is
        // still valid, so fall back to its first scene.
        let Some(scene) = gltf.default_scene.clone().or_else(|| gltf.scenes.first().cloned()) else {
            panic!("GLB without any scene");
        };
        commands.entity(e).insert(SceneSpawned);
        commands.spawn((WorldAssetRoot(scene),));
    }
}

// ---------------------------------------------------------------------------
// Render-world systems
// ---------------------------------------------------------------------------

/// Per-frame extraction of main-world readback targets.
#[derive(Resource, Default)]
struct ExtractedTargets(Vec<ReadbackTarget>);

/// Per-frame extraction of the host's capture request.
#[derive(Resource, Default)]
struct ExtractedCapture(CaptureRequest);

fn extract_capture(
    targets: Extract<Query<&ReadbackTarget>>,
    request: Extract<Res<CaptureRequest>>,
    mut out: ResMut<ExtractedTargets>,
    mut capture: ResMut<ExtractedCapture>,
) {
    out.0 = targets.iter().cloned().collect();
    capture.0 = CaptureRequest::clone(&request);
}

/// Reconcile staging buffers with the registered targets: drop buffers whose
/// target is gone (camera removed, resized or cleared) and allocate, on
/// first request only, a buffer for each target the host asked for.
fn sync_staging(
    targets: Res<ExtractedTargets>,
    capture: Res<ExtractedCapture>,
    device: Res<RenderDevice>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    mut staging: ResMut<Staging>,
) {
    staging.0.retain(|b| {
        targets
            .0
            .iter()
            .any(|t| t.src_image == b.src_image && t.depth == b.depth && t.exposure == b.exposure && t.key == b.key)
    });
    let slot = capture.0.slot;
    for target in targets.0.iter() {
        if !capture.0.keys.iter().any(|k| *k == target.key)
            || staging
                .0
                .iter()
                .any(|b| b.src_image == target.src_image && b.depth == target.depth && b.exposure == target.exposure && b.slot == slot)
        {
            continue;
        }
        // Depth views share the colour target's extent.
        let Some(gpu) = gpu_images.get(&target.src_image) else { continue };
        let (width, height) = if target.exposure {
            (4, 1)
        } else {
            (gpu.texture_descriptor.size.width, gpu.texture_descriptor.size.height)
        };
        let pixel: usize = if target.depth || target.exposure {
            4
        } else {
            gpu.texture_descriptor.format.block_copy_size(None).unwrap_or(4) as usize
        };
        let padded_row = aligned_row(width as usize, pixel);
        staging.0.push(StagingBuffer {
            key: target.key.clone(),
            src_image: target.src_image.clone(),
            depth: target.depth,
            exposure: target.exposure,
            width,
            height,
            padded_row,
            buffer: make_buffer(&device, padded_row * height as usize),
            slot,
            copied: false,
        });
    }
}

fn targets_image(camera: &ExtractedCamera, image: &Handle<Image>) -> bool {
    matches!(
        &camera.target,
        Some(bevy::camera::NormalizedRenderTarget::Image(irt))
            if irt.handle.id() == image.id()
    )
}

/// Encode texture->staging copies for every requested pass whose view was
/// extracted and rendered in this iteration.
///
/// Runs after `RenderGraphSystems::Render` and before `Submit`, recording
/// into the same pending command stream as the camera passes, so the copy
/// is ordered after this frame's rendering inside one submission. A
/// requested pass whose camera was not extracted this frame (just
/// registered, inactive, or removed) is not copied and therefore never
/// reported: stale staging bytes cannot be relabelled as this frame.
/// Cascade layout of every directional light (`RenderConfig.shadows`).
#[derive(Resource, Clone, Copy, Debug, PartialEq)]
pub struct ShadowCascadeSettings {
    pub cascades: u32,
    pub max_distance_m: f32,
}

impl Default for ShadowCascadeSettings {
    fn default() -> Self {
        Self { cascades: 4, max_distance_m: 400.0 }
    }
}

/// Keep every directional light's cascades on the configured layout (the
/// lighting ladder respawns lights on relight).
fn enforce_shadow_cascades(
    settings: Res<ShadowCascadeSettings>,
    mut lights: Query<(Ref<DirectionalLight>, &mut bevy::light::CascadeShadowConfig)>,
) {
    for (light, mut config) in &mut lights {
        if settings.is_changed() || light.is_added() {
            *config = bevy::light::cascade::CascadeShadowConfigBuilder {
                minimum_distance: 1.0,
                maximum_distance: settings.max_distance_m,
                num_cascades: settings.cascades as usize,
                ..Default::default()
            }
            .build();
        }
    }
}

/// Remove Bevy's background motion-vector pipeline and bind group from views
/// that no longer have a motion-vector prepass (see `SceneApp::new`).
fn drop_stale_background_motion_vectors(
    mut commands: Commands,
    stale: Query<
        Entity,
        (
            With<bevy::core_pipeline::prepass::background_motion_vectors::BackgroundMotionVectorsPipelineId>,
            Without<bevy::core_pipeline::prepass::MotionVectorPrepass>,
        ),
    >,
) {
    for entity in &stale {
        commands.entity(entity).remove::<(
            bevy::core_pipeline::prepass::background_motion_vectors::BackgroundMotionVectorsPipelineId,
            bevy::core_pipeline::prepass::background_motion_vectors::BackgroundMotionVectorsBindGroup,
        )>();
    }
}

/// Threads that finish the frame's command encoders (see `SceneApp::new`).
#[derive(Resource)]
struct EncoderFinishThreads(usize);

fn apply_encoder_finish_threads(
    threads: Res<EncoderFinishThreads>,
    mut pending: ResMut<bevy::render::renderer::PendingCommandBuffers>,
) {
    pending.set_finish_threads(threads.0);
}

fn copy_passes(
    mut ctx: RenderContext,
    capture: Res<ExtractedCapture>,
    mut staging: ResMut<Staging>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    cameras: Query<&ExtractedCamera>,
    depth_views: Query<(&ExtractedCamera, &ViewDepthTexture)>,
    model_views: Query<(&ExtractedCamera, &crate::camera_model::CameraModelBuffers)>,
    hdr_views: Query<&crate::camera_model::HdrCapture, With<ExtractedCamera>>,
) {
    if capture.0.keys.is_empty() {
        return;
    }
    for b in staging.0.iter_mut().filter(|b| b.slot == capture.0.slot) {
        b.copied = false;
        if !capture.0.keys.iter().any(|k| *k == b.key) {
            continue;
        }
        let layout = TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(b.padded_row as u32),
            rows_per_image: None,
        };
        if b.exposure {
            let Some((_, buffers)) = model_views
                .iter()
                .find(|(camera, _)| targets_image(camera, &b.src_image))
            else {
                continue;
            };
            ctx.command_encoder().copy_buffer_to_buffer(&buffers.result, 0, &b.buffer, 0, 16);
        } else if b.depth {
            let Some((_, view)) = depth_views
                .iter()
                .find(|(camera, _)| targets_image(camera, &b.src_image))
            else {
                continue;
            };
            ctx.command_encoder().copy_texture_to_buffer(
                view.texture.as_image_copy(),
                TexelCopyBufferInfo { buffer: &b.buffer, layout },
                view.texture.size(),
            );
        } else {
            // A camera's own target, or the HDR copy its camera model made
            // this frame.
            if !cameras.iter().any(|camera| targets_image(camera, &b.src_image))
                && !hdr_views.iter().any(|hdr| hdr.0.id() == b.src_image.id())
            {
                continue;
            }
            let Some(src) = gpu_images.get(&b.src_image) else {
                continue;
            };
            ctx.command_encoder().copy_texture_to_buffer(
                src.texture.as_image_copy(),
                TexelCopyBufferInfo { buffer: &b.buffer, layout },
                src.texture_descriptor.size,
            );
        }
        b.copied = true;
    }
}

/// Map and publish only the buffers `copy_passes` filled from this
/// submission, stamped with its generation.
fn receive_passes(
    device: Res<RenderDevice>,
    sender: Res<RenderSender>,
    capture: Res<ExtractedCapture>,
    clock: Res<ReadbackClock>,
    deferred: Res<DeferredMaps>,
    mut staging: ResMut<Staging>,
) {
    // Frames without a capture request copy nothing; a deferred slot keeps
    // its `copied` flags until the host collects it.
    if capture.0.keys.is_empty() {
        return;
    }
    let slot = capture.0.slot;
    let pending = staging.0.iter().filter(|b| b.copied && b.slot == slot).count();
    if pending == 0 {
        return;
    }
    if capture.0.deferred {
        // Start the maps and return: the host collects them after it has
        // queued more work (`SceneApp::capture_finish`).
        let done = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let failed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        for b in staging.0.iter().filter(|b| b.copied && b.slot == slot) {
            let (done, failed) = (done.clone(), failed.clone());
            b.buffer.slice(..).map_async(MapMode::Read, move |res| {
                if res.is_err() {
                    failed.store(true, std::sync::atomic::Ordering::Release);
                }
                done.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            });
        }
        deferred.0.lock().expect("deferred maps").push(DeferredMap {
            generation: capture.0.generation,
            slot,
            expected: pending,
            done,
            failed,
        });
        return;
    }
    let waited = Instant::now();
    let (s, r) = crossbeam_channel::bounded::<()>(pending);
    for b in staging.0.iter().filter(|b| b.copied && b.slot == slot) {
        let tx = s.clone();
        b.buffer.slice(..).map_async(MapMode::Read, move |res| {
            res.expect("map readback buffer");
            let _ = tx.send(());
        });
    }
    device
        .poll(PollType::wait_indefinitely())
        .expect("poll device");
    for _ in 0..pending {
        r.recv().expect("map_async result");
    }
    let wait_ms = waited.elapsed().as_secs_f64() * 1000.0;
    let copied = Instant::now();
    let mut bytes = 0u64;
    for b in staging.0.iter_mut().filter(|b| b.copied && b.slot == slot) {
        let data = b.buffer.slice(..).get_mapped_range().to_vec();
        bytes += data.len() as u64;
        b.buffer.unmap();
        b.copied = false;
        let _ = sender.send(SentPass {
            key: b.key.clone(),
            generation: capture.0.generation,
            width: b.width,
            height: b.height,
            padded_row: b.padded_row,
            data,
        });
    }
    *clock.0.lock().expect("readback clock") = ReadbackTiming {
        wait_ms,
        copy_ms: copied.elapsed().as_secs_f64() * 1000.0,
        bytes,
    };
}

/// Fill each requested device stream slot from this submission.
///
/// Same ordering contract as `copy_passes`: after the camera passes and
/// before `Submit`, recording into the pending command stream, so
/// `GpuInterop::arm_ready` binds the slot's ready signal to the submission
/// that carries the copies. A plane whose view was not rendered this frame
/// is reported as an error for the sensor, never as a stale slot.
#[cfg(feature = "gpu-interop")]
fn copy_device_passes(
    mut ctx: RenderContext,
    capture: Res<ExtractedCapture>,
    interop: Option<ResMut<crate::gpu_interop::GpuInterop>>,
    sender: Res<DeviceSender>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    cameras: Query<&ExtractedCamera>,
    depth_views: Query<(&ExtractedCamera, &ViewDepthTexture)>,
) {
    if capture.0.device.is_empty() {
        return;
    }
    let generation = capture.0.generation;
    let Some(mut interop) = interop else {
        for copy in &capture.0.device {
            let _ = sender.send(SentDevice {
                sensor_id: copy.sensor_id.clone(),
                generation,
                result: Err("device interop is not open".into()),
            });
        }
        return;
    };
    for copy in &capture.0.device {
        let result = (|| {
            let mut sources = Vec::with_capacity(copy.planes.len());
            for plane in &copy.planes {
                let src = if plane.depth {
                    depth_views
                        .iter()
                        .find(|(camera, _)| targets_image(camera, &plane.src_image))
                        .map(|(_, view)| view.texture.as_image_copy())
                } else if cameras.iter().any(|camera| targets_image(camera, &plane.src_image)) {
                    gpu_images.get(&plane.src_image).map(|src| src.texture.as_image_copy())
                } else {
                    None
                };
                let Some(src) = src else {
                    return Err(format!("{}:{} was not rendered this frame", copy.sensor_id, plane.name));
                };
                sources.push((plane.name, src));
            }
            let lease = interop
                .acquire(copy.stream, copy.wait)
                .map_err(|error| error.to_string())?;
            for (name, src) in sources {
                if let Err(error) = interop.encode_copy(ctx.command_encoder(), &lease, name, src) {
                    let _ = interop.cancel(lease);
                    return Err(error.to_string());
                }
            }
            interop.arm_ready(lease).map_err(|error| error.to_string())
        })();
        let _ = sender.send(SentDevice { sensor_id: copy.sensor_id.clone(), generation, result });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ground_field_covers_sparse_road_under_foliage() {
        let mut meshes = Assets::<Mesh>::default();
        let mesh = Mesh::new(
            bevy::render::render_resource::PrimitiveTopology::TriangleList,
            RenderAssetUsages::MAIN_WORLD,
        )
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, vec![
            [0.0, 1.0, 0.0], [10.0, 2.0, 0.0], [0.0, 1.0, 10.0],
            [4.2, 20.0, 4.2], [4.8, 20.0, 4.2], [4.2, 20.0, 4.8],
        ])
        .with_inserted_indices(bevy::mesh::Indices::U32(vec![0, 2, 1, 3, 4, 5]));
        let mesh = Mesh3d(meshes.add(mesh));
        let transform = GlobalTransform::IDENTITY;
        let field = GroundField::from_meshes(&meshes, [(&mesh, &transform)], 2.0);
        // This cell has foliage vertices but no road vertices. Its road
        // triangle still covers the centre (5, 5), at interpolated Y = 1.5.
        assert!((field.sample_covered(4.3, 4.3).unwrap() - 1.5).abs() < 1.0e-5);
    }

    #[test]
    fn ground_mesh_height_maps_scene_axes_and_refuses_to_guess() {
        use simforge_core::map::ground::{encode_ground_mesh, GroundSurface, SurfaceClass};
        // A street at z=2 m over xodr x,y in [0,20]^2 and a deck at z=8 m
        // over x in [10,20] (xodr-local, mm).
        let vertices = [
            [0, 0, 2000], [20000, 0, 2000], [20000, 20000, 2000], [0, 20000, 2000],
            [10000, 0, 8000], [20000, 0, 8000], [20000, 20000, 8000], [10000, 20000, 8000],
        ];
        let triangles = [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]];
        let classes = [SurfaceClass::Road, SurfaceClass::Road, SurfaceClass::Bridge, SurfaceClass::Bridge];
        let surface = GroundSurface::decode(&encode_ground_mesh(&vertices, &triangles, &classes)).unwrap();
        // Scene (x, z) = xodr (x, -y): xodr (5, 7) is scene (5, -7).
        assert!((ground_mesh_height(&surface, 5.0, -7.0).unwrap() - 2.0).abs() < 1e-6);
        // xodr y = -7 is off the surface: an error, not a height.
        let off = ground_mesh_height(&surface, 5.0, 7.0).unwrap_err();
        assert!(off.starts_with("[native_ground_height_unavailable]"), "{off}");
        // Two decks and no authored height: refuse to choose.
        let stacked = ground_mesh_height(&surface, 15.0, -7.0).unwrap_err();
        assert!(stacked.starts_with("[native_ground_height_ambiguous]"), "{stacked}");
    }

    #[test]
    fn parallel_ground_field_is_bit_identical_to_the_serial_build() {
        // Many overlapping instances with equal heights (signed zeros too):
        // the chunked build must keep exactly the serial tie winners.
        let mut meshes = Assets::<Mesh>::default();
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            ((state >> 40) as f32) / (1u64 << 24) as f32
        };
        let mut instances = Vec::new();
        for i in 0..200 {
            let mut positions = Vec::new();
            for _ in 0..30 {
                let y = match i % 4 { 0 => 0.0, 1 => -0.0, _ => (next() * 4.0).floor() * 0.5 };
                positions.push([next() * 60.0, y, next() * 60.0]);
            }
            let indices: Vec<u32> = (0..30).collect();
            let mesh = Mesh::new(bevy::render::render_resource::PrimitiveTopology::TriangleList, RenderAssetUsages::MAIN_WORLD)
                .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
                .with_inserted_indices(bevy::mesh::Indices::U32(indices));
            let transform = GlobalTransform::from(Transform::from_xyz(next() * 5.0, 0.0, next() * 5.0));
            instances.push((Mesh3d(meshes.add(mesh)), transform));
        }
        let pairs: Vec<(&Mesh3d, &GlobalTransform)> = instances.iter().map(|(m, t)| (m, t)).collect();
        let parallel = GroundField::from_meshes(&meshes, pairs.iter().copied(), 2.0);
        let serial = GroundField::from_meshes_serial(&meshes, pairs.iter().copied(), 2.0);
        assert_eq!(parallel.min_y.len(), serial.min_y.len());
        for (cell, y) in &serial.min_y {
            assert_eq!(parallel.min_y[cell].to_bits(), y.to_bits(), "cell {cell:?}");
        }
    }

    #[test]
    fn map_load_pools_give_io_every_core_and_keep_the_other_pools() {
        let cores = bevy::tasks::available_parallelism().max(1);
        let options = map_load_task_pools();
        assert_eq!((options.io.min_threads, options.io.max_threads), (cores, cores));
        let others = options.async_compute.max_threads + options.compute.max_threads;
        assert_eq!(options.min_total_threads, cores + others);
        assert_eq!(options.max_total_threads, options.min_total_threads);
        // What Bevy's defaults leave the async and compute pools on this host.
        let default_io = if cores >= 16 { 4 } else { ((cores as f32 * 0.25).round() as usize).clamp(1, 4) };
        assert_eq!(others, cores - default_io, "async + compute keep Bevy's default share");
    }

    /// Measurement probe (not a gate): CPU cost of turning a staged map's
    /// KTX2 textures into GPU images, as Bevy's glTF loader does, on the
    /// IO pool's thread count and on every core.
    /// `SIMFORGE_KTX2_PROBE_DIR=<staged closure> cargo test --release -p render-core ktx2_transcode_probe -- --ignored --nocapture`
    #[test]
    #[ignore = "measurement probe over a staged map closure"]
    fn ktx2_transcode_probe() {
        let dir = std::env::var("SIMFORGE_KTX2_PROBE_DIR").expect("SIMFORGE_KTX2_PROBE_DIR");
        let mut files = Vec::new();
        let mut stack = vec![std::path::PathBuf::from(dir)];
        while let Some(path) = stack.pop() {
            for entry in std::fs::read_dir(&path).unwrap() {
                let entry = entry.unwrap().path();
                if entry.is_dir() {
                    stack.push(entry);
                } else if entry.extension().is_some_and(|ext| ext == "ktx2") {
                    files.push(entry);
                }
            }
        }
        files.sort();
        let read = Instant::now();
        let buffers: Vec<Vec<u8>> = files.iter().map(|path| std::fs::read(path).unwrap()).collect();
        let bytes: usize = buffers.iter().map(Vec::len).sum();
        eprintln!("{} ktx2 files, {:.2} GB on disk, read in {:.1} s", files.len(), bytes as f64 / 1e9, read.elapsed().as_secs_f64());
        let formats = bevy::image::CompressedImageFormats::BC;
        for threads in [1usize, 4, std::thread::available_parallelism().map_or(4, |n| n.get())] {
            let started = Instant::now();
            let next = std::sync::atomic::AtomicUsize::new(0);
            let gpu_bytes = std::sync::atomic::AtomicUsize::new(0);
            let limit = if threads == 1 { buffers.len().min(200) } else { buffers.len() };
            std::thread::scope(|scope| {
                for _ in 0..threads {
                    scope.spawn(|| loop {
                        let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        if index >= limit {
                            break;
                        }
                        let image = bevy::image::ktx2_buffer_to_image(&buffers[index], formats, true).expect("transcode");
                        gpu_bytes.fetch_add(image.data.as_ref().map_or(0, Vec::len), std::sync::atomic::Ordering::Relaxed);
                    });
                }
            });
            let seconds = started.elapsed().as_secs_f64();
            eprintln!(
                "{threads:>2} threads: {limit} textures -> {:.2} GB GPU data in {seconds:.1} s{}",
                gpu_bytes.load(std::sync::atomic::Ordering::Relaxed) as f64 / 1e9,
                if limit < buffers.len() { format!(" (x{:.0} extrapolated: {:.0} s)", buffers.len() as f64 / limit as f64, seconds * buffers.len() as f64 / limit as f64) } else { String::new() }
            );
        }
    }

    #[test]
    fn one_meter_exposes_twilight_between_noon_and_night() {
        let at = |elev: f32| {
            let lighting = Lighting {
                atmosphere: true,
                sun_elev_deg: elev,
                ..Default::default()
            };
            lighting.resolve().1.ev100
        };
        let noon = at(60.0);
        let dusk = at(-5.0);
        let night = at(-26.0);
        assert!(noon > dusk && dusk > night, "{noon} {dusk} {night}");
        // A lit street is not daylight, and the camera does not pretend it is.
        assert!(night < 3.0, "{night}");
        assert!(night >= CAMERA_EV100_FLOOR);
        // Civil dusk (~7 lx of skylight, EV ~1.5 metered, ~3.5 stops of
        // adaptation) still meters on the twilight sky, not on the ledger.
        assert!((4.0..8.0).contains(&dusk), "{dusk}");
    }

    #[test]
    fn night_ledger_lifts_the_meter_when_luminaires_are_near() {
        let mut lit = Lighting {
            atmosphere: true,
            sun_elev_deg: -26.0,
            ..Default::default()
        };
        let dark = lit.resolve().1.ev100;
        lit.night.observer_position = [0.0, 1.6, 0.0];
        lit.night.fixtures = (0..8)
            .map(|i| crate::night::NightFixture {
                source_id: format!("f{i}"),
                source_name: "lamp".into(),
                position: [(i as f32 - 4.0) * 25.0, 9.0, 6.0],
                heading_rad: 0.0,
                lumens: 6_000.0,
                cct_k: 2_700.0,
                range_m: 32.0,
                outer_angle_deg: 70.0,
                confidence: 1.0,
                rule: "test".into(),
            })
            .collect();
        let street = lit.resolve().1.ev100;
        assert!(street > dark + 2.0, "{street} vs {dark}");
    }

    #[test]
    fn exposure_bias_and_night_offset_are_applied_after_the_meter() {
        let base = Lighting {
            atmosphere: true,
            sun_elev_deg: -7.0,
            ..Default::default()
        };
        let reference = base.resolve().1.ev100;
        let biased = Lighting {
            ev100_bias: 2.0,
            ..base.clone()
        };
        assert!((biased.resolve().1.ev100 - (reference + 2.0)).abs() < 1.0e-4);
        let mut offset = base.clone();
        offset.night.exposure_offset_stops = 1.5;
        assert!((offset.resolve().1.ev100 - (reference + 1.5)).abs() < 1.0e-4);
    }

    #[test]
    fn gpu_solar_source_reaches_zero_at_astronomical_night() {
        assert_eq!(astronomical_twilight_sun_gain(-18.0), 0.0);
        assert_eq!(astronomical_twilight_sun_gain(-30.0), 0.0);
        assert_eq!(astronomical_twilight_sun_gain(-6.0), 1.0);
        assert_eq!(astronomical_twilight_sun_gain(20.0), 1.0);
        assert!((0.0..1.0).contains(&astronomical_twilight_sun_gain(-12.0)));

        let night = Lighting {
            atmosphere: true,
            sun_elev_deg: -26.0,
            ..Default::default()
        };
        let (plan, resolved) = night.resolve();
        assert_eq!(resolved.sun_lux, 0.0);
        assert_eq!(plan.sun_lux, 1.0e-8, "GPU-only dark-LUT seed");
    }

    #[test]
    fn incident_meter_matches_the_iso_100_convention() {
        // 250 lx is EV100 6.64 on a C = 250 incident meter.
        assert!((incident_meter_ev100(250.0) - 6.643856).abs() < 1.0e-4);
        assert!((incident_meter_ev100(2.5) - 0.0).abs() < 1.0e-6);
    }

    #[test]
    fn sky_highlight_meter_places_the_luminance_at_the_ceiling() {
        // Middle grey at EV 10 is 0.216 * 2^10 cd/m^2; the same luminance
        // read as a highlight sits SKY_HIGHLIGHT_STOPS below that EV.
        let mid_grey = 0.18 * 1.2 * 2f32.powi(10);
        assert!((sky_highlight_ev100(mid_grey) - (10.0 - SKY_HIGHLIGHT_STOPS)).abs() < 1.0e-4);
    }

    fn towards(azimuth_deg: f32, elevation_deg: f32) -> [f32; 3] {
        let e = elevation_deg.to_radians();
        let a = azimuth_deg.to_radians();
        [e.cos() * a.sin(), e.sin(), e.cos() * a.cos()]
    }

    #[test]
    fn sunward_low_sun_is_metered_on_the_aureole_and_noon_is_not() {
        let sunset = Lighting {
            atmosphere: true,
            sun_elev_deg: 5.7,
            sun_azim_deg: 245.0,
            ..Default::default()
        };
        let incident_only = sunset.resolve().1.ev100;
        let sunward = Lighting {
            meter_view: Some(crate::atmosphere::MeterView {
                forward: towards(245.0, -3.0),
                fov_y_deg: 55.0,
                aspect: 16.0 / 9.0,
            }),
            ..sunset.clone()
        };
        let (_, resolved) = sunward.resolve();
        let view = resolved.atmosphere.as_ref().unwrap().view_sky.unwrap();
        assert!(view.sun_in_field > 0.99, "sun framed: {view:?}");
        assert!(view.max_cdm2 > 4.0 * view.mean_cdm2, "aureole dominates: {view:?}");
        assert!(
            resolved.ev100 > incident_only + 1.0,
            "sunward sunset stops down: {} vs {incident_only}",
            resolved.ev100
        );
        // Facing away, the framed sky is the dim anti-solar side: the
        // incident meter wins and the picture is unchanged.
        let away = Lighting {
            meter_view: Some(crate::atmosphere::MeterView {
                forward: towards(65.0, -3.0),
                fov_y_deg: 55.0,
                aspect: 16.0 / 9.0,
            }),
            ..sunset.clone()
        };
        let (_, away_resolved) = away.resolve();
        assert!((away_resolved.ev100 - incident_only).abs() < 1.0e-4);
        assert_eq!(away_resolved.atmosphere.unwrap().view_sky.unwrap().sun_in_field, 0.0);

        let noon = Lighting {
            atmosphere: true,
            sun_elev_deg: 69.5,
            sun_azim_deg: 180.0,
            meter_view: Some(crate::atmosphere::MeterView {
                forward: towards(180.0, -3.0),
                fov_y_deg: 55.0,
                aspect: 16.0 / 9.0,
            }),
            ..Default::default()
        };
        let plain = Lighting { meter_view: None, ..noon.clone() };
        assert!((noon.resolve().1.ev100 - plain.resolve().1.ev100).abs() < 1.0e-4);
    }

    #[test]
    fn atmosphere_ibl_tapers_into_the_probe_without_a_step() {
        assert_eq!(atmosphere_ibl_gain(10.0), 1.0);
        assert_eq!(atmosphere_ibl_gain(IBL_TAPER_START_ELEVATION_DEG), 1.0);
        let at_handover = atmosphere_ibl_gain(PROBE_HANDOVER_ELEVATION_DEG);
        assert!((at_handover - 1.0 / 1.18).abs() < 1.0e-6);
        let mid = atmosphere_ibl_gain(
            0.5 * (IBL_TAPER_START_ELEVATION_DEG + PROBE_HANDOVER_ELEVATION_DEG),
        );
        assert!(mid > at_handover && mid < 1.0);
    }

    #[test]
    fn ladder_tiers_follow_the_two_handovers() {
        assert_eq!(ladder_tier(30.0), LadderTier::Day);
        assert_eq!(ladder_tier(PROBE_HANDOVER_ELEVATION_DEG + 0.01), LadderTier::Day);
        assert_eq!(ladder_tier(PROBE_HANDOVER_ELEVATION_DEG), LadderTier::Twilight);
        assert_eq!(ladder_tier(NIGHT_SOURCES_ELEVATION_DEG + 0.01), LadderTier::Twilight);
        assert_eq!(ladder_tier(NIGHT_SOURCES_ELEVATION_DEG), LadderTier::Night);
        assert_eq!(ladder_tier(-30.0), LadderTier::Night);
    }

    #[test]
    fn sun_membership_fades_across_the_field_edge() {
        let probe = |azimuth_offset: f32| {
            let lighting = Lighting {
                atmosphere: true,
                sun_elev_deg: 8.0,
                sun_azim_deg: 200.0,
                meter_view: Some(crate::atmosphere::MeterView {
                    forward: towards(200.0 + azimuth_offset, 0.0),
                    fov_y_deg: 40.0,
                    aspect: 1.0,
                }),
                ..Default::default()
            };
            lighting.resolve().1.atmosphere.unwrap().view_sky.unwrap().sun_in_field
        };
        // Half-field is 20 deg (tan 0.364): fully inside, on the ramp
        // (tangent between 0.8 and 1.25 of the half-field), fully outside.
        assert_eq!(probe(0.0), 1.0);
        assert_eq!(probe(10.0), 1.0);
        let edge = probe(20.0);
        assert!(edge > 0.0 && edge < 1.0, "soft edge: {edge}");
        assert_eq!(probe(30.0), 0.0);
    }

    #[test]
    fn physical_default_has_no_global_fill_or_camera_headlamp() {
        let lighting = Lighting::default();
        let env = crate::night::resolve_night(&lighting.night, 16.0, false);
        assert!((env.urban_skyglow_lux - 0.05).abs() < 1.0e-6);
        assert!(env.source_ledger.iter().any(|source| source.id == "urban-skyglow"));
    }
    #[test]
    #[ignore = "focused GPU integration test"]
    fn service_actor_catalog_models_instantiate_mesh_nodes() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");

        let vehicle = repo.join(
            "catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb",
        );
        let pedestrian =
            repo.join("catalog/pedestrians-carla/models/pedestrian_0015.glb");
        assert!(vehicle.is_file() && pedestrian.is_file());

        let mut app = SceneApp::new(&Lighting::default()).unwrap();
        app.load_tiles(&[vehicle.to_string_lossy().into_owned()])
            .unwrap();
        app.wait_until_ready().unwrap();

        app.upsert_actor(
            "vehicle-test",
            "car",
            [0.0, 0.0, 0.0],
            Quat::IDENTITY,
            [4.5, 1.6, 1.8],
            [0.5, 0.5, 0.5],
        );
        app.attach_actor_asset("vehicle-test", &vehicle, 1.0, Some([0.56, 0.18, 0.18]), None, 0.0)
            .unwrap();
        app.upsert_actor(
            "walker-test",
            "pedestrian",
            [8.0, 0.0, 0.0],
            Quat::IDENTITY,
            [0.5, 1.8, 0.5],
            [0.5, 0.5, 0.5],
        );
        app.attach_actor_asset("walker-test", &pedestrian, 1.0, None, None, 0.0)
            .unwrap();

        assert!(app.actor_model_mesh_count("vehicle-test") > 1);
        assert!(app.actor_model_mesh_count("walker-test") > 1);
        assert_eq!(
            app.actor_model_tint_colors("vehicle-test"),
            vec![[0.56, 0.18, 0.18, 1.0]]
        );
        assert!(app.actor_model_tint_colors("walker-test").is_empty());
        // Bevy's async asset tasks can still hold the test-only wgpu device
        // when the process tears down; the production service intentionally
        // lives for the process lifetime.
        std::mem::forget(app);
    }

    /// The ray sensors see the meshes the camera draws: every visible GLB
    /// node (never the hidden cuboid), CPU-posed skins that follow the
    /// animation clock, and an instance-ID pass drawn from the model.
    /// Runs on a GPU, or on lavapipe with
    /// `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER=1`.
    /// A ridden two-wheeler's rider is its own instance (class `rider`) in the
    /// ID pass and in the lidar/radar meshes, separate from the bike, and its
    /// ride clip poses the skin. GPU (or lavapipe) as below.
    #[test]
    #[ignore = "focused GPU integration test"]
    fn ridden_two_wheeler_rider_is_its_own_instance() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let bike = repo.join("catalog/vehicles-carla/models/vehicle_motorcycle_harley_rider.glb");
        let mut app = SceneApp::new(&Lighting::default()).unwrap();
        app.load_tiles(&[repo.join("catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb").to_string_lossy().into_owned()]).unwrap();
        app.add_camera(
            CameraSpec { passes: PassSet { rgb: true, id: true, depth: false, hdr: false }, ..test_camera("cam", 160, 120) }
        );
        app.wait_until_ready().unwrap();
        app.upsert_actor("moto", "motorcycle", [0.0, 0.7, -20.0], Quat::IDENTITY, [2.1, 1.4, 0.75], [0.5, 0.5, 0.5]);
        app.attach_actor_asset("moto", &bike, 0.9, None, Some("ride"), 0.25).unwrap();
        app.set_actor_asset_pose("moto", [0.0, 0.0, -20.0], Quat::IDENTITY).unwrap();
        app.set_actor_material_colors("moto", &[("rider_top".into(), [0.8, 0.1, 0.1])]).unwrap();
        assert_eq!(app.actor_material_colors("moto", "rider_top").first().copied(), Some([0.8, 0.1, 0.1]));
        assert!(app.set_actor_material_colors("moto", &[("no_such_slot".into(), [1.0, 1.0, 1.0])]).is_err());
        app.warmup(2);
        let bike_id = app.actor_instance_id("moto").unwrap();
        let rider_id = app.actor_rider_instance_id("moto").expect("the Harley model carries a rider");
        assert_ne!(bike_id, rider_id);
        assert_eq!(app.actor_instance_class(rider_id), Some("rider"));
        assert_eq!(app.actor_instance_class(bike_id), Some("motorcycle"));
        let meshes = app.actor_sensor_meshes().unwrap();
        let rider: Vec<_> = meshes.iter().filter(|m| m.instance_id == rider_id).collect();
        assert!(!rider.is_empty() && rider.len() < meshes.len(), "rider and bike meshes both present");
        assert!(rider.iter().any(|m| matches!(m.geometry, ActorSensorGeometry::Skinned { .. })), "the rider body is skinned");
        // Rider pixels sit above bike pixels in a side view.
        app.set_pose("cam", &[0.0, 1.0, -14.0], &[0.0, 0.9, -20.0]).unwrap();
        let frame = app.render_once(1).unwrap();
        let id = &frame.passes["cam:id"].bytes;
        let rows_of = |instance: u32| -> Vec<usize> {
            let b = instance.to_le_bytes();
            id.chunks_exact(4).enumerate().filter(|(_, px)| px[..3] == b[..3]).map(|(i, _)| i / 160).collect()
        };
        let (rider_rows, bike_rows) = (rows_of(rider_id), rows_of(bike_id));
        assert!(rider_rows.len() > 100 && bike_rows.len() > 100, "rider {} px, bike {} px", rider_rows.len(), bike_rows.len());
        let mean = |rows: &[usize]| rows.iter().sum::<usize>() as f32 / rows.len() as f32;
        assert!(mean(&rider_rows) < mean(&bike_rows), "rider is drawn above the bike");
        app.remove_actor("moto");
        assert_eq!(app.actor_instance_class(rider_id), None);
    }

    #[test]
    #[ignore = "focused GPU integration test"]
    fn actor_sensor_meshes_are_the_drawn_catalog_meshes() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let vehicle = repo.join("catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb");
        let pedestrian = repo.join("catalog/pedestrians-carla/models/pedestrian_0015.glb");
        let mut app = SceneApp::new(&Lighting::default()).unwrap();
        app.load_tiles(&[vehicle.to_string_lossy().into_owned()]).unwrap();
        app.add_camera(
            CameraSpec { passes: PassSet { rgb: true, id: true, depth: false, hdr: false }, ..test_camera("cam", 128, 96) }
        );
        app.wait_until_ready().unwrap();

        let body = [0.0, 0.8, -20.0];
        app.upsert_actor("car", "car", body, Quat::IDENTITY, [4.5, 1.6, 1.8], [0.5, 0.5, 0.5]);
        let legend_max = app.legend().iter().map(|entry| entry.id).max().unwrap();
        assert!(app.actor_instance_id("car").unwrap() > legend_max, "actor ids never reuse static legend ids");
        // Before a model is attached the cuboid is what the camera draws
        // (read after an update, like the service's post-readiness snapshot).
        app.warmup(1);
        let cuboid = app.actor_sensor_meshes().unwrap();
        assert_eq!(cuboid.len(), 1);
        let ActorSensorGeometry::Rigid { mesh, .. } = &cuboid[0].geometry else { panic!("cuboid is rigid") };
        assert_eq!(app.mesh_asset_triangles(mesh, "cuboid").unwrap().len(), 12);

        app.attach_actor_asset("car", &vehicle, 1.0, None, None, 0.0).unwrap();
        app.set_actor_asset_pose("car", [0.0, 0.0, -20.0], Quat::IDENTITY).unwrap();
        app.warmup(2);
        let meshes = app.actor_sensor_meshes().unwrap();
        assert_eq!(meshes.len(), app.actor_model_mesh_count("car"), "one sensor mesh per drawn model node");
        let mut triangles = 0;
        for mesh in &meshes {
            assert_eq!(mesh.actor_id, "car");
            let ActorSensorGeometry::Rigid { mesh: handle, world } = &mesh.geometry else { panic!("vehicle meshes are rigid") };
            triangles += app.mesh_asset_triangles(handle, &mesh.label).unwrap().len();
            // Every node sits on the actor (world translation within the body).
            let t = world.w_axis.truncate();
            assert!((t - Vec3::new(0.0, 0.0, -20.0)).length() < 4.0, "{} at {t}", mesh.label);
        }
        assert!(triangles > 1_000, "the sedan GLB, not a 12-triangle box ({triangles})");

        // The ID pass draws the model: the silhouette differs from the box
        // (the box also fills the space above the hood and under the body).
        app.set_pose("cam", &[6.0, 1.2, -20.0], &[0.0, 0.9, -20.0]).unwrap();
        let frame = app.render_once(1).unwrap();
        let id = &frame.passes["cam:id"].bytes;
        let actor_id = app.actor_instance_id("car").unwrap().to_le_bytes();
        let hits = id.chunks_exact(4).filter(|px| px[..3] == actor_id[..3]).count();
        assert!(hits > 200, "the actor is visible in the ID pass ({hits} px)");
        let box_px = {
            let cols = 128usize;
            // Projected cuboid footprint is a solid rectangle; the car's is
            // not: some pixels inside the actor's ID bounding box are not the actor.
            let rows: Vec<usize> = id.chunks_exact(4).enumerate().filter(|(_, px)| px[..3] == actor_id[..3]).map(|(i, _)| i).collect();
            let (x0, x1) = rows.iter().fold((usize::MAX, 0), |(a, b), i| (a.min(i % cols), b.max(i % cols)));
            let (y0, y1) = rows.iter().fold((usize::MAX, 0), |(a, b), i| (a.min(i / cols), b.max(i / cols)));
            (x1 - x0 + 1) * (y1 - y0 + 1)
        };
        assert!(hits < box_px * 95 / 100, "ID silhouette is the car, not a filled box ({hits} of {box_px})");

        // A walking pedestrian's skin is posed on the CPU and follows the clip.
        app.upsert_actor("ped", "pedestrian", [3.0, 0.9, -20.0], Quat::IDENTITY, [0.5, 1.8, 0.5], [0.5, 0.5, 0.5]);
        app.attach_actor_asset("ped", &pedestrian, 1.0, None, Some("walk"), 0.0).unwrap();
        app.set_actor_asset_pose("ped", [3.0, 0.0, -20.0], Quat::IDENTITY).unwrap();
        app.warmup(2);
        let posed = |app: &mut SceneApp| -> Vec<[Vec3; 3]> {
            app.actor_sensor_meshes().unwrap().into_iter()
                .filter(|mesh| mesh.actor_id == "ped")
                .flat_map(|mesh| match mesh.geometry {
                    ActorSensorGeometry::Skinned { triangles, .. } => triangles,
                    ActorSensorGeometry::Rigid { .. } => Vec::new(),
                })
                .collect()
        };
        let at_zero = posed(&mut app);
        assert!(!at_zero.is_empty(), "the walker is skinned geometry");
        app.set_actor_animation_time("ped", 0.4).unwrap();
        app.warmup(2);
        let at_later = posed(&mut app);
        assert_eq!(at_zero.len(), at_later.len());
        assert!(at_zero.iter().zip(&at_later).any(|(a, b)| (a[0] - b[0]).length() > 0.01), "the skin follows the walk clip");

        // Rebinding the model (idle <-> walk GLB) keeps one ID clone set.
        app.detach_actor_asset("ped").unwrap();
        assert!(app.actor_sensor_meshes().is_err(), "an actor whose model was detached has no visible geometry");
        app.attach_actor_asset("ped", &pedestrian, 1.0, None, Some("idle"), 0.0).unwrap();
        assert!(!posed(&mut app).is_empty());
        std::mem::forget(app);
    }

    /// Every ID-pass pixel decodes to the background, a static legend entry
    /// or a live actor: no dithered, blended or sRGB-rounded neighbour ids
    /// (formerly ~10k px per 960x540 frame decoded to id +/- 1, 256 or 65536).
    /// Two views (post-process AA on their RGB cameras) both hold. Runs on a GPU or on lavapipe (see the actor mesh test).
    #[test]
    #[ignore = "focused GPU integration test"]
    fn every_id_pass_pixel_decodes_to_a_known_instance() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let vehicle = repo.join("catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb");
        let pedestrian = repo.join("catalog/pedestrians-carla/models/pedestrian_0015.glb");
        let mut app = SceneApp::new(&Lighting::default()).unwrap();
        app.load_tiles(&[vehicle.to_string_lossy().into_owned()]).unwrap();
        for sensor in ["left", "right"] {
            app.add_camera(CameraSpec { passes: PassSet { rgb: true, id: true, depth: false, hdr: false }, ..test_camera(sensor, 320, 180) });
        }
        app.wait_until_ready().unwrap();
        for (k, x) in [-6.0f32, 0.0, 6.0].into_iter().enumerate() {
            let id = format!("car{k}");
            app.upsert_actor(&id, "car", [x, 0.8, -18.0], Quat::from_rotation_y(0.4 * k as f32), [4.5, 1.6, 1.8], [0.5, 0.5, 0.5]);
            app.attach_actor_asset(&id, &vehicle, 1.0, Some([0.2, 0.3, 0.6]), None, 0.0).unwrap();
            app.set_actor_asset_pose(&id, [x, 0.0, -18.0], Quat::from_rotation_y(0.4 * k as f32)).unwrap();
        }
        app.upsert_actor("ped", "pedestrian", [3.0, 0.9, -14.0], Quat::IDENTITY, [0.5, 1.8, 0.5], [0.5, 0.5, 0.5]);
        app.attach_actor_asset("ped", &pedestrian, 1.0, None, Some("walk"), 0.3).unwrap();
        app.set_actor_asset_pose("ped", [3.0, 0.0, -14.0], Quat::IDENTITY).unwrap();
        let mut known: std::collections::HashSet<u32> = app.legend().iter().map(|entry| entry.id).collect();
        for id in app.actor_ids() {
            known.insert(app.actor_instance_id(&id).unwrap());
        }
        known.insert(0);
        let mut tick = 0;
        for eye in [[9.0, 2.5, -8.0], [-10.0, 1.2, -12.0], [0.5, 6.0, -2.0]] {
            for cam in ["left", "right"] {
                app.set_pose(cam, &eye, &[0.0, 0.8, -18.0]).unwrap();
            }
            app.warmup(2);
            tick += 1;
            let frame = app.render_once(tick).unwrap();
            for cam in ["left", "right"] {
                let bytes = &frame.passes[&format!("{cam}:id")].bytes;
                let raw = strip_padding(bytes, 320, 180, 4);
                let mut hist: HashMap<u32, usize> = HashMap::new();
                for px in raw.chunks_exact(4) {
                    *hist.entry(u32::from_le_bytes([px[0], px[1], px[2], 0])).or_default() += 1;
                }
                let unknown: Vec<(u32, usize)> = hist.iter().filter(|(id, _)| !known.contains(id)).map(|(id, n)| (*id, *n)).collect();
                assert!(unknown.is_empty(), "{cam} at {eye:?}: pixels with unknown ids {unknown:?}");
                let actor_px: usize = app.actor_ids().iter().map(|id| hist.get(&app.actor_instance_id(id).unwrap()).copied().unwrap_or(0)).sum();
                assert!(actor_px > 100, "{cam} at {eye:?}: actors must be in view ({actor_px} px)");
                assert!(raw.chunks_exact(4).all(|px| px[3] == 255), "{cam}: ID pixels are opaque");
            }
        }
        std::mem::forget(app);
    }

    /// Measurement probe (not a gate): the shadow fill the renderer delivers
    /// against the atmosphere model's own diffuse/total horizontal
    /// illuminance. A 0.5-albedo, fully rough horizontal plane under a
    /// floating box; no AO/contact shadows/SSR/bloom, linear output. Prints
    /// the linear shadow/lit ratio beside the model's E_diffuse/E_total.
    /// `SIMFORGE_SKY_FILL_ELEVATIONS=60,30,15` (default), GPU or lavapipe.
    #[test]
    #[ignore = "measurement probe"]
    fn sky_fill_probe() {
        use crate::profiles::{AntiAlias, CinematicFx, RenderProfileConfig, ToneMap};
        let elevations: Vec<f32> = std::env::var("SIMFORGE_SKY_FILL_ELEVATIONS")
            .unwrap_or_else(|_| "60,30,15".into())
            .split(',')
            .map(|v| v.trim().parse().unwrap())
            .collect();
        let weathers: Vec<String> = std::env::var("SIMFORGE_SKY_FILL_WEATHERS")
            .unwrap_or_else(|_| "clear".into())
            .split(',')
            .map(|v| v.trim().to_string())
            .collect();
        let look = RenderProfileConfig {
            cinematic: CinematicFx {
                aa: AntiAlias::Off,
                ssr: false,
                ssao: false,
                contact_shadows: false,
                bloom_intensity: 0.0,
                vignette_intensity: 0.0,
                lens_distortion: 0.0,
                chromatic_aberration: 0.0,
                grading_exposure: 0.0,
                grading_contrast: 1.0,
                grading_post_saturation: 1.0,
                tone_map: ToneMap::None,
                ..Default::default()
            },
        };
        for weather in &weathers {
            for &elev in &elevations {
                let lighting = Lighting {
                    atmosphere: true,
                    sun_elev_deg: elev,
                    sun_azim_deg: 180.0,
                    weather: serde_json::from_value(serde_json::json!(weather)).unwrap(),
                    ..Default::default()
                };
                let mut app = SceneApp::new_with_profile_config(&lighting, look).unwrap();
                // Readiness needs one loaded tile; it is moved out of view.
                let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
                app.load_tiles(&[repo.join("catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb").to_string_lossy().into_owned()]).unwrap();
                app.add_camera(CameraSpec { passes: PassSet { rgb: true, id: false, depth: false, hdr: false }, ..test_camera("cam", 256, 256) });
                app.wait_until_ready().unwrap();
                {
                    let world = app.app.world_mut();
                    let roots: Vec<Entity> = world.query_filtered::<Entity, With<WorldAssetRoot>>().iter(world).collect();
                    for root in roots {
                        world.entity_mut(root).insert(Transform::from_xyz(5000.0, 0.0, 5000.0));
                    }
                    let plane = world.resource_mut::<Assets<Mesh>>().add(Plane3d::default().mesh().size(600.0, 600.0));
                    let block = world.resource_mut::<Assets<Mesh>>().add(Cuboid::new(40.0, 10.0, 40.0));
                    let grey = world.resource_mut::<Assets<StandardMaterial>>().add(StandardMaterial {
                        base_color: Color::linear_rgb(0.5, 0.5, 0.5),
                        perceptual_roughness: 1.0,
                        metallic: 0.0,
                        reflectance: 0.0,
                        ..default()
                    });
                    world.spawn((Mesh3d(plane), MeshMaterial3d(grey.clone()), Transform::IDENTITY));
                    world.spawn((Mesh3d(block), MeshMaterial3d(grey), Transform::from_xyz(0.0, 40.0, 0.0)));
                }
                app.apply_lighting(&lighting, look).unwrap();
                // Straight down from 150 m over the box's shadow (the sun is
                // due south, -z; the shadow falls towards +z).
                let shadow_z = 40.0 / elev.to_radians().tan();
                app.set_pose("cam", &[0.0, 150.0, shadow_z + 0.01], &[0.0, 0.0, shadow_z]).unwrap();
                app.warmup(4);
                let frame = app.render_once(1).unwrap();
                let pass = &frame.passes["cam:rgb"];
                let raw = strip_padding(&pass.bytes, 256, 256, 4);
                if let Ok(dir) = std::env::var("SIMFORGE_SKY_FILL_DUMP") {
                    image::save_buffer(format!("{dir}/sky-fill-{weather}-{elev}.png"), &raw, 256, 256, image::ColorType::Rgba8).unwrap();
                }
                let decode = |v: u8| {
                    let c = v as f32 / 255.0;
                    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
                };
                let mut lum: Vec<f32> = raw
                    .chunks_exact(4)
                    .map(|p| 0.2126 * decode(p[0]) + 0.7152 * decode(p[1]) + 0.0722 * decode(p[2]))
                    .collect();
                lum.sort_by(|a, b| a.total_cmp(b));
                // Shadow: the darkest 3% (the box's shadow is ~4-8% of the
                // frame); lit: the brightest half.
                let n = lum.len();
                let shadow: f32 = lum[n / 200..n * 3 / 100].iter().sum::<f32>() / (n * 3 / 100 - n / 200) as f32;
                let lit: f32 = lum[n / 2..].iter().sum::<f32>() / (n - n / 2) as f32;
                let resolved = app.resolved_lighting();
                let a = resolved.atmosphere.as_ref().unwrap();
                eprintln!(
                    "sky-fill weather={weather} elev={elev}: rendered shadow/lit {:.3} (shadow {:.4}, lit {:.4}, lit clipped {}) | model E_diff/E_total {:.3} (E_dir {:.0} lx, E_diff {:.0} lx) | ev100 {:.2}",
                    shadow / lit,
                    shadow,
                    lit,
                    lum[n - 1] >= 0.999,
                    a.diffuse_horizontal_illuminance_lx / a.total_horizontal_illuminance_lx,
                    a.direct_horizontal_illuminance_lx,
                    a.diffuse_horizontal_illuminance_lx,
                    resolved.ev100,
                );
                std::mem::forget(app);
            }
        }
    }

    fn test_camera(sensor_id: &str, width: u32, height: u32) -> CameraSpec {
        CameraSpec {
            sensor_id: sensor_id.into(),
            width,
            height,
            fov_y_deg: 58.0,
            near: 0.5,
            far: 200.0,
            passes: PassSet { rgb: true, id: true, depth: true, hdr: false },
        }
    }

    fn sedan_scene_with(config: &crate::render_config::RenderConfig) -> SceneApp {
        let vehicle = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb");
        let mut app = SceneApp::new_with_profile_config(&Lighting::default(), config.profile_config()).unwrap();
        app.apply_render_config(config).unwrap();
        app.load_tiles(&[vehicle.to_string_lossy().into_owned()]).unwrap();
        app
    }

    fn sedan_scene() -> SceneApp {
        let vehicle = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb");
        assert!(vehicle.is_file());
        let mut app = SceneApp::new(&Lighting::default()).unwrap();
        app.load_tiles(&[vehicle.to_string_lossy().into_owned()]).unwrap();
        app
    }

    #[test]
    #[ignore = "focused GPU integration test"]
    fn capture_returns_the_submission_it_names_and_follows_camera_lifecycle() {
        let mut app = sedan_scene();
        // Frames are compared across ticks, so time must not move the sky.
        app.set_capture_clock(CaptureClock::Pinned { samples: 1 });
        app.add_camera(test_camera("cam", 96, 64));
        app.wait_until_ready().unwrap();
        app.warmup(3);
        let left = ([6.0, 1.5, 6.0], [0.0, 0.5, 0.0]);
        let right = ([-6.0, 1.5, 6.0], [0.0, 0.5, 0.0]);

        // Alternating poses on consecutive single captures: each frame must
        // carry the pose set immediately before it, never the previous one.
        app.set_pose("cam", &left.0, &left.1).unwrap();
        let a = app.render_once(1).unwrap();
        app.set_pose("cam", &right.0, &right.1).unwrap();
        let b = app.render_once(2).unwrap();
        app.set_pose("cam", &left.0, &left.1).unwrap();
        let a_again = app.render_once(3).unwrap();
        assert_ne!(a.passes["cam:rgb"].bytes, b.passes["cam:rgb"].bytes);
        assert_eq!(a.passes["cam:rgb"].bytes, a_again.passes["cam:rgb"].bytes);
        assert_ne!(a.passes["cam:depth"].bytes, b.passes["cam:depth"].bytes);
        assert_eq!(a.identity.sim_tick, 1);
        assert!(a.identity.generation < b.identity.generation);
        assert!(b.identity.generation < a_again.identity.generation);
        assert!(a.identity.scene_revision < b.identity.scene_revision);
        assert_eq!(a.identity.rig_revision, b.identity.rig_revision);

        // Sinks are per request: an rgb-only capture copies nothing else.
        let rgb_only = app.capture(4, &["cam:rgb".into()]).unwrap();
        assert_eq!(rgb_only.passes.len(), 1);
        assert_eq!(rgb_only.passes["cam:rgb"].bytes, a.passes["cam:rgb"].bytes);
        let full = app.render_once(5).unwrap();
        assert_eq!(full.passes.len(), 3);
        assert_eq!(full.passes["cam:id"].bytes, a.passes["cam:id"].bytes);

        // Re-registering resizes in place and bumps the rig.
        let before = app.rig_revision();
        app.add_camera(test_camera("cam", 128, 64));
        app.set_pose("cam", &left.0, &left.1).unwrap();
        let wide = app.render_once(6).unwrap();
        assert!(wide.identity.rig_revision > before);
        assert_eq!(wide.passes["cam:rgb"].width, 128);
        assert_eq!(wide.passes["cam:rgb"].bytes.len(), wide.passes["cam:rgb"].padded_row * 64);

        // Removal makes the pass unknown instead of serving stale bytes.
        assert!(app.remove_camera("cam"));
        assert!(app.capture(7, &["cam:rgb".into()]).is_err());
        assert!(app.render_once(8).unwrap().passes.is_empty());
        std::mem::forget(app);
    }

    /// The pinned capture clock's contract: a capture is a function of the
    /// scene and its simulation time only. Frames drawn before it (readiness,
    /// warmup, retries, relights) must not change a single byte, for SMAA
    /// and for explicit N-sample TAA; the free (rc.73) clock is expected to
    /// drift with them, which is the determinism bug the pinned clock fixes.
    fn pinned_scene(aa: crate::profiles::AntiAlias, clock: CaptureClock) -> SceneApp {
        let vehicle = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb");
        let lighting = Lighting { atmosphere: true, cloud_cover: Some(0.6), ..Lighting::default() };
        let mut config = RenderProfileConfig::default();
        config.cinematic.aa = aa;
        let mut app = SceneApp::new_with_profile_config(&lighting, config).unwrap();
        // As the service does: the clock (and with it the light-clustering
        // mode) is chosen before the scene loads.
        app.set_capture_clock(clock);
        app.apply_lighting(&lighting, config).unwrap();
        app.load_tiles(&[vehicle.to_string_lossy().into_owned()]).unwrap();
        let mut spec = test_camera("cam", 160, 96);
        spec.passes = PassSet { rgb: true, id: false, depth: false, hdr: false };
        app.add_camera(spec);
        app.wait_until_ready().unwrap();
        app.set_pose("cam", &[6.0, 1.8, 6.0], &[0.0, 0.8, 0.0]).unwrap();
        app.wait_for_capture_ready().unwrap();
        app
    }

    fn capture_after(app: &mut SceneApp, extra_frames: u32, sim_time: f64) -> Vec<u8> {
        app.warmup(extra_frames);
        app.set_sim_time(sim_time);
        app.capture(1, &["cam:rgb".into()]).unwrap().passes["cam:rgb"].bytes.clone()
    }

    #[test]
    #[ignore = "focused GPU integration test"]
    fn pinned_capture_does_not_depend_on_frames_drawn_before_it() {
        use crate::profiles::AntiAlias;
        for (aa, samples) in [(AntiAlias::SmaaHigh, 1), (AntiAlias::Taa, 4)] {
            let mut app = pinned_scene(aa, CaptureClock::Pinned { samples });
            let first = capture_after(&mut app, 0, 12.5);
            let after_three = capture_after(&mut app, 3, 12.5);
            let after_eleven = capture_after(&mut app, 11, 12.5);
            assert!(first == after_three && first == after_eleven, "{aa:?}: pinned capture changed with the frames drawn before it");
            let stats = app.last_capture_stats();
            assert_eq!(stats.accumulation_frames, samples - 1, "{aa:?}");
            // The sky is simulation time: a later time is a different sky.
            let later = capture_after(&mut app, 0, 40.0);
            assert!(later != first, "{aa:?}: the sky did not follow simulation time");
            std::mem::forget(app);
        }
        // The rc.73 clock drifts with every drawn frame (TAA history, jitter, clouds).
        let mut app = pinned_scene(AntiAlias::Taa, CaptureClock::Free);
        let first = capture_after(&mut app, 0, 12.5);
        let after_three = capture_after(&mut app, 3, 12.5);
        assert!(first != after_three, "free clock unexpectedly stable");
        std::mem::forget(app);
    }

    #[test]
    #[ignore = "focused GPU integration test"]
    fn deferred_captures_return_the_frames_blocking_captures_return() {
        use crate::profiles::AntiAlias;
        let keys = vec!["cam:rgb".to_string()];
        let poses = [([6.0, 1.8, 6.0], [0.0, 0.8, 0.0]), ([-6.0, 1.8, 6.0], [0.0, 0.8, 0.0]), ([0.0, 2.5, 8.0], [0.0, 0.5, 0.0])];
        let mut app = pinned_scene(AntiAlias::SmaaHigh, CaptureClock::Pinned { samples: 1 });
        // Both sequences start from the same drawn history (the last pose),
        // so only the readback path differs between them.
        let prime = |app: &mut SceneApp| {
            let (eye, target) = poses[2];
            app.set_pose("cam", &eye, &target).unwrap();
            app.set_sim_time(2.0);
            app.capture(99, &keys).unwrap();
        };
        prime(&mut app);
        let blocking: Vec<Vec<u8>> = poses
            .iter()
            .enumerate()
            .map(|(tick, (eye, target))| {
                app.set_pose("cam", eye, target).unwrap();
                app.set_sim_time(tick as f64);
                app.capture(tick as u64, &keys).unwrap().passes["cam:rgb"].bytes.clone()
            })
            .collect();
        prime(&mut app);
        // Pipelined order: begin N+1 before finishing N.
        let mut frames = Vec::new();
        let mut pending: Option<CaptureTicket> = None;
        for (tick, (eye, target)) in poses.iter().enumerate() {
            app.set_pose("cam", eye, target).unwrap();
            app.set_sim_time(tick as f64);
            let ticket = app.capture_begin(tick as u64, &keys).unwrap();
            if let Some(previous) = pending.replace(ticket) {
                frames.push(app.capture_finish(previous).unwrap());
            }
        }
        frames.push(app.capture_finish(pending.take().unwrap()).unwrap());
        assert_eq!(frames.len(), blocking.len());
        for (tick, (frame, expected)) in frames.iter().zip(&blocking).enumerate() {
            assert_eq!(frame.identity.sim_tick, tick as u64);
            assert!(frame.passes["cam:rgb"].bytes == *expected, "deferred frame {tick} differs from the blocking capture");
        }
        assert!(blocking[0] != blocking[1], "fixture poses must differ");
        std::mem::forget(app);
    }

    /// Probe (reports, does not gate): does a pinned capture depend on the
    /// pose drawn before it? The same pose and time captured after two
    /// different predecessors; prints which passes of the frame differ.
    /// A pinned capture is a function of (scene, sim time) only: the pose
    /// drawn before it must not leak in. It did through the atmosphere's
    /// per-view environment probe, filtered one frame late (fixed in the
    /// vendored bevy_pbr, `downsampling_current_view`).
    /// Reconfiguring a running app between looks (SMAA -> TAA adds the
    /// motion-vector prepass, and back) must render like a fresh app: no
    /// pipeline specialized for the old prepass set may meet the new pass.
    /// GPU or lavapipe.
    #[test]
    #[ignore = "focused GPU integration test"]
    fn reconfigure_between_looks_keeps_rendering() {
        use crate::render_config::{Preset, RenderConfig};
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let showcase = RenderConfig::preset(Preset::Showcase);
        let mut app = SceneApp::new_with_profile_config(&Lighting::default(), showcase.profile_config()).unwrap();
        app.apply_render_config(&showcase).unwrap();
        app.load_tiles(&[repo.join("catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb").to_string_lossy().into_owned()]).unwrap();
        app.add_camera(test_camera("cam", 96, 64));
        app.wait_until_ready().unwrap();
        app.render_once(1).unwrap();
        let reference = RenderConfig::reference();
        for (tick, config) in [reference, showcase, reference].into_iter().enumerate() {
            app.reconfigure(&config).unwrap();
            app.wait_for_capture_ready().unwrap();
            app.render_once(2 + tick as u64).unwrap_or_else(|error| panic!("after reconfigure to {:?}: {error}", config.aa.mode));
        }
        std::mem::forget(app);
    }

    /// A car in a caster's shadow is darker than the same car in sun, in
    /// both presets. Two identical catalog cars (the actor path the service
    /// uses) on a ground plane, one under an overhead slab; each car is
    /// masked by its instance-ID pixels and its mean linear luminance
    /// compared, next to the ground's own shadowed/sunlit ratio. GPU or
    /// lavapipe. `SIMFORGE_CAR_SHADE_DUMP=dir` writes the frames.
    #[test]
    #[ignore = "focused GPU integration test"]
    fn a_car_in_shadow_is_darker_than_in_sun() {
        use crate::render_config::{Preset, RenderConfig};
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let vehicle = repo.join("catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb");
        let (w, h) = (256usize, 160usize);
        let elev: f32 = 40.0;
        let lighting = Lighting { atmosphere: true, sun_elev_deg: elev, sun_azim_deg: 180.0, ..Default::default() };
        for preset in [Preset::Showcase, Preset::Training] {
            let config = RenderConfig::preset(preset);
            let mut app = SceneApp::new_with_profile_config(&lighting, config.profile_config()).unwrap();
            app.apply_render_config(&config).unwrap();
            app.set_capture_clock(CaptureClock::Pinned { samples: 1 });
            app.load_tiles(&[vehicle.to_string_lossy().into_owned()]).unwrap();
            app.add_camera(CameraSpec {
                passes: PassSet { rgb: true, id: true, depth: false, hdr: true },
                ..test_camera("cam", w as u32, h as u32)
            });
            app.wait_until_ready().unwrap();
            let slab_height = 6.0;
            {
                let world = app.app.world_mut();
                let roots: Vec<Entity> = world.query_filtered::<Entity, With<WorldAssetRoot>>().iter(world).collect();
                for root in roots {
                    world.entity_mut(root).insert(Transform::from_xyz(5000.0, 0.0, 5000.0));
                }
                let plane = world.resource_mut::<Assets<Mesh>>().add(Plane3d::default().mesh().size(300.0, 300.0));
                let slab = world.resource_mut::<Assets<Mesh>>().add(Cuboid::new(10.0, 0.4, 10.0));
                let grey = world.resource_mut::<Assets<StandardMaterial>>().add(StandardMaterial {
                    base_color: Color::linear_rgb(0.3, 0.3, 0.3),
                    perceptual_roughness: 1.0,
                    ..default()
                });
                world.spawn((Mesh3d(plane), MeshMaterial3d(grey.clone()), Transform::IDENTITY));
                // Sun due south (-z) at `elev`: the shadow of a slab at
                // height H lands H / tan(elev) towards +z.
                let offset = slab_height / elev.to_radians().tan();
                world.spawn((Mesh3d(slab), MeshMaterial3d(grey), Transform::from_xyz(-6.0, slab_height, -offset)));
            }
            for (id, x) in [("shaded", -6.0f32), ("sunlit", 6.0)] {
                app.upsert_actor(id, "car", [x, 0.8, 0.0], Quat::IDENTITY, [4.5, 1.6, 1.8], [0.8, 0.8, 0.8]);
                app.attach_actor_asset(id, &vehicle, 1.0, None, None, 0.0).unwrap();
                app.set_actor_asset_pose(id, [x, 0.0, 0.0], Quat::IDENTITY).unwrap();
            }
            app.set_pose("cam", &[0.0, 14.0, 16.0], &[0.0, 0.0, 0.0]).unwrap();
            app.wait_for_capture_ready().unwrap();
            let frame = app.render_once(1).unwrap();
            let hdr = strip_padding(&frame.passes["cam:hdr"].bytes, w, h, 8);
            let ids = strip_padding(&frame.passes["cam:id"].bytes, w, h, 4);
            if let Ok(dir) = std::env::var("SIMFORGE_CAR_SHADE_DUMP") {
                let rgb = strip_padding(&frame.passes["cam:rgb"].bytes, w, h, 4);
                image::save_buffer(format!("{dir}/car-shade-{preset:?}.png"), &rgb, w as u32, h as u32, image::ColorType::Rgba8).unwrap();
            }
            let luminance = |i: usize| {
                let c = |k: usize| half::f16::from_le_bytes([hdr[i * 8 + 2 * k], hdr[i * 8 + 2 * k + 1]]).to_f32();
                0.2126 * c(0) + 0.7152 * c(1) + 0.0722 * c(2)
            };
            let id_at = |i: usize| u32::from(ids[i * 4]) | (u32::from(ids[i * 4 + 1]) << 8) | (u32::from(ids[i * 4 + 2]) << 16);
            let mean_of = |instance: u32| {
                let px: Vec<f32> = (0..w * h).filter(|&i| id_at(i) == instance).map(luminance).collect();
                assert!(px.len() > 200, "{preset:?}: only {} pixels of instance {instance}", px.len());
                px.iter().sum::<f32>() / px.len() as f32
            };
            let shaded = mean_of(app.actor_instance_id("shaded").unwrap());
            let sunlit = mean_of(app.actor_instance_id("sunlit").unwrap());
            // The ground next to each car (background pixels, id 0, in the
            // lower half): the darkest and brightest deciles.
            let mut ground: Vec<f32> = (w * h / 2..w * h).filter(|&i| id_at(i) == 0).map(luminance).collect();
            ground.sort_by(f32::total_cmp);
            let decile = ground.len() / 10;
            let ground_ratio = (ground[..decile].iter().sum::<f32>() / decile as f32)
                / (ground[ground.len() - decile..].iter().sum::<f32>() / decile as f32);
            let ratio = shaded / sunlit;
            eprintln!("{preset:?}: car shaded/sunlit {ratio:.3} (shaded {shaded:.4}, sunlit {sunlit:.4}); ground {ground_ratio:.3}");
            assert!(ratio < 0.6, "{preset:?}: a car in shadow is {ratio:.3} of the same car in sun (ground {ground_ratio:.3})");
            std::mem::forget(app);
        }
    }

    /// Directional shadow cascades pick LODs from their own camera. The
    /// vendored bevy_render resolved a cascade's camera by a main-world id in
    /// a render-world query; the lookup always missed, so cascades picked
    /// visibility ranges (LODs) from Bevy's fallback origin while CPU
    /// visibility used the camera. A LOD chain member was drawn into the
    /// shadow map only where both picks agreed: on Belmont every street tree
    /// lost its shadow in the training preset (box 3 A/B in
    /// docs/engineering/native-render-gpu-profile.md). Every cascade of every
    /// camera, shared or not, must now resolve its camera. GPU or lavapipe.
    #[test]
    #[ignore = "focused GPU integration test"]
    fn directional_shadow_cascades_resolve_lods_from_their_camera() {
        use crate::render_config::{Preset, RenderConfig};
        for preset in [Preset::Showcase, Preset::Training] {
            let config = RenderConfig::preset(preset);
            let mut app = sedan_scene_with(&config);
            // A camera that keeps its own cascades, and two sharing a set.
            app.add_camera(test_camera("chase", 64, 48));
            app.add_camera(test_camera("front", 96, 64));
            app.add_camera(test_camera("rear", 96, 64));
            app.set_camera_shared_shadows("chase", false);
            for (cam, eye, target) in [
                ("chase", [0.0, 3.0, 9.0], [0.0, 0.5, 0.0]),
                ("front", [0.0, 1.5, 4.0], [0.0, 1.0, -10.0]),
                ("rear", [0.0, 1.5, 4.0], [0.0, 1.0, 14.0]),
            ] {
                app.set_pose(cam, &eye, &target).unwrap();
            }
            app.wait_until_ready().unwrap();
            app.render_once(1).unwrap();
            app.render_once(2).unwrap();
            let misses = app.app.sub_app(RenderApp).world().resource::<bevy::render::view::DirectionalShadowLodMisses>().0;
            std::mem::forget(app);
            assert_eq!(misses, 0, "{preset:?}: {misses} cascade views picked LODs from the fallback origin");
        }
    }

    /// A device error stops rendering for good; the next wait must fail at
    /// once with the cause, not time out (an out-of-memory device used to
    /// spin in `wait_until_ready` for its full 300 s). GPU or lavapipe.
    #[test]
    #[ignore = "focused GPU integration test"]
    fn a_device_error_fails_the_next_wait_with_its_cause() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut app = SceneApp::new(&Lighting::default()).unwrap();
        app.load_tiles(&[repo.join("catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb").to_string_lossy().into_owned()]).unwrap();
        app.add_camera(test_camera("cam", 64, 64));
        app.wait_until_ready().unwrap();
        let device = app.app.world().resource::<RenderDevice>().clone();
        // A zero-sized texture is a validation error, reported uncaptured.
        let _invalid = device.wgpu_device().create_texture(&bevy::render::render_resource::TextureDescriptor {
            label: Some("invalid"),
            size: bevy::render::render_resource::Extent3d { width: 0, height: 0, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: bevy::render::render_resource::TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let started = Instant::now();
        let error = app.wait_for_capture_ready().expect_err("rendering stopped");
        assert!(error.to_string().contains("[native_render_device_error]"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(30), "failed at once, not at the deadline");
        assert!(app.render_once(1).is_err(), "every later capture fails too");
        // Dropping a failed app must not crash the process (it is leaked).
        drop(app);
    }

    #[test]
    #[ignore = "focused GPU integration test"]
    fn pinned_capture_does_not_depend_on_the_previous_pose() {
        use crate::profiles::AntiAlias;
        let keys = vec!["cam:rgb".to_string()];
        let mut app = pinned_scene(AntiAlias::SmaaHigh, CaptureClock::Pinned { samples: 1 });
        let mut after = |app: &mut SceneApp, previous: ([f32; 3], [f32; 3])| {
            app.set_pose("cam", &previous.0, &previous.1).unwrap();
            app.set_sim_time(1.0);
            app.capture(1, &keys).unwrap();
            app.set_pose("cam", &[6.0, 1.8, 6.0], &[0.0, 0.8, 0.0]).unwrap();
            app.set_sim_time(1.0);
            app.capture(2, &keys).unwrap().passes["cam:rgb"].bytes.clone()
        };
        let same = after(&mut app, ([6.0, 1.8, 6.0], [0.0, 0.8, 0.0]));
        let moved = after(&mut app, ([0.0, 2.5, 8.0], [0.0, 0.5, 0.0]));
        let differing = same.iter().zip(&moved).filter(|(a, b)| a != b).count();
        std::mem::forget(app);
        assert_eq!(differing, 0, "{differing} of {} bytes depend on the previously drawn pose", same.len());
    }

    /// The dash-cam camera model meters every frame from that frame alone:
    /// tick t's exposure and pixels are the same rendered cold or after a
    /// frame of a very different (brighter/darker) view. GPU or lavapipe.
    #[test]
    #[ignore = "focused GPU integration test"]
    fn camera_model_exposure_does_not_depend_on_the_previous_frame() {
        use crate::render_config::{Preset, RenderConfig};
        let vehicle = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb");
        let config = RenderConfig::preset(Preset::Training);
        let lighting = Lighting { atmosphere: true, ..Lighting::default() };
        let mut app = SceneApp::new_with_profile_config(&lighting, config.profile_config()).unwrap();
        app.apply_render_config(&config).unwrap();
        app.apply_lighting(&lighting, config.profile_config()).unwrap();
        app.load_tiles(&[vehicle.to_string_lossy().into_owned()]).unwrap();
        let mut spec = test_camera("cam", 160, 96);
        spec.passes = PassSet { rgb: true, id: false, depth: false, hdr: false };
        app.add_camera(spec);
        app.wait_until_ready().unwrap();
        let keys = vec!["cam:rgb".to_string(), "cam:exposure".to_string()];
        let target = ([6.0, 1.8, 6.0], [0.0, 0.8, 0.0]);
        let mut shot = |app: &mut SceneApp, before: Option<([f32; 3], [f32; 3])>| {
            if let Some(before) = before {
                app.set_pose("cam", &before.0, &before.1).unwrap();
                app.set_sim_time(1.0);
                app.capture(1, &keys).unwrap();
            }
            app.set_pose("cam", &target.0, &target.1).unwrap();
            app.set_sim_time(1.0);
            let frame = app.capture(2, &keys).unwrap();
            (frame.passes["cam:rgb"].bytes.clone(), frame.passes["cam:exposure"].bytes[..16].to_vec())
        };
        app.wait_for_capture_ready().unwrap();
        let cold = shot(&mut app, None);
        // Straight up at the sky, then straight down at the ground: two
        // frames metered far apart.
        let after_sky = shot(&mut app, Some(([0.0, 2.0, 0.0], [0.01, 50.0, 0.0])));
        let after_ground = shot(&mut app, Some(([0.0, 30.0, 0.0], [0.01, 0.0, 0.0])));
        std::mem::forget(app);
        let ev = |bytes: &[u8]| f32::from_le_bytes(bytes[..4].try_into().unwrap());
        assert!(ev(&cold.1).is_finite() && ev(&cold.1) > 5.0, "metered EV100 {}", ev(&cold.1));
        assert_eq!(cold.1, after_sky.1, "exposure depends on the previous frame");
        assert_eq!(cold.1, after_ground.1, "exposure depends on the previous frame");
        assert_eq!(cold.0, after_sky.0, "pixels depend on the previous frame");
        assert_eq!(cold.0, after_ground.0, "pixels depend on the previous frame");
    }

    #[test]
    #[ignore = "focused GPU integration test"]
    fn mounted_camera_excludes_only_its_own_host() {
        let mut app = sedan_scene();
        // Frames are compared across ticks, so time must not move the sky.
        app.set_capture_clock(CaptureClock::Pinned { samples: 1 });
        app.add_camera(test_camera("mounted", 96, 64));
        app.add_camera(test_camera("spectator", 96, 64));
        app.wait_until_ready().unwrap();
        app.upsert_actor("ego", "car", [0.0, 0.0, 0.0], Quat::IDENTITY, [4.5, 1.6, 1.8], [0.9, 0.1, 0.1]);
        app.upsert_actor("lead", "car", [0.0, 0.0, -6.0], Quat::IDENTITY, [4.5, 1.6, 1.8], [0.1, 0.1, 0.9]);
        let pose = ([0.0, 2.5, 8.0], [0.0, 0.5, -3.0]);
        for cam in ["mounted", "spectator"] {
            app.set_pose(cam, &pose.0, &pose.1).unwrap();
        }
        app.set_camera_host("mounted", Some("ego")).unwrap();
        app.warmup(3);

        let frame = app.render_once(1).unwrap();
        let hosted = &frame.passes["mounted:rgb"].bytes;
        let spectator = &frame.passes["spectator:rgb"].bytes;
        assert_ne!(hosted, spectator, "the mounted view must not render its host");
        // The ID pass drops the host exactly where the RGB pass does, so
        // labels match pixels.
        assert_ne!(
            frame.passes["mounted:id"].bytes, frame.passes["spectator:id"].bytes,
            "the mounted view must not label its host"
        );

        app.set_camera_host("mounted", None).unwrap();
        let unmounted = app.render_once(2).unwrap();
        assert_eq!(
            unmounted.passes["mounted:rgb"].bytes,
            unmounted.passes["spectator:rgb"].bytes,
            "unmounting restores the host for that view"
        );
        assert_eq!(unmounted.passes["spectator:rgb"].bytes, *spectator);
        assert_eq!(
            unmounted.passes["mounted:id"].bytes,
            unmounted.passes["spectator:id"].bytes,
            "unmounting restores the host's labels for that view"
        );
        std::mem::forget(app);
    }
}

/// `GlobalTransform` when propagated, else the local `Transform` (top-level
/// actor entities have no parent, so both name the same pose).
fn world_pose(world: &World, entity: Entity) -> Option<(Vec3, Quat)> {
    if let Some(global) = world.get::<GlobalTransform>(entity) {
        let (_, rotation, translation) = global.to_scale_rotation_translation();
        return Some((translation, rotation));
    }
    world
        .get::<Transform>(entity)
        .map(|transform| (transform.translation, transform.rotation))
}
