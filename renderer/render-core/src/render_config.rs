//! `RenderConfig`: every knob of the native renderer in one typed,
//! serializable struct, and the two named presets over it.
//!
//! There is one renderer and exactly two presets:
//!
//! * `training`: the fastest configuration that keeps every effect of the
//!   look (shadows, SSAO + contact shadows, SSR, atmosphere/sky/clouds,
//!   bloom, grading, lens, full vegetation). Only quality levels are lower.
//! * `showcase`: about 90–95% of the engine's maximum perceptual quality,
//!   minus the expensive last few percent nobody sees.
//!
//! No preset renders at maximum settings; [`RenderConfig::reference`] is the
//! measurement reference the presets are scored against (and is reachable
//! with overrides). Output encoding (`output`) is the consumer's choice and
//! not part of a preset's identity.
//!
//! A caller picks a preset and overrides individual knobs with dotted keys
//! (`--preset training --set shadows.cascades=2 --set aa.mode=fxaa`). The
//! same surface serves the CLI, the job scene spec, the closed-loop
//! protocol and config files ([`RenderRequest`]). Unknown keys, unknown
//! values and out-of-range values are errors; nothing falls back silently.
//! The resolved config is what a manifest records.
//!
//! Serialized names are stable (camelCase fields, kebab-case enum values).
use crate::profiles::{AntiAlias, CinematicFx, RenderProfileConfig, ToneMap};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The two named presets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Preset {
    Training,
    Showcase,
}

impl Preset {
    pub const ALL: [Preset; 2] = [Preset::Training, Preset::Showcase];

    pub fn as_str(self) -> &'static str {
        match self {
            Preset::Training => "training",
            Preset::Showcase => "showcase",
        }
    }

    pub fn parse(name: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|preset| preset.as_str() == name)
            .ok_or_else(|| anyhow::anyhow!("[native_render_preset_unknown] preset {name:?} (training | showcase)"))
    }
}

/// Anti-aliasing.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AaConfig {
    /// `off | fxaa | smaa-low | smaa-medium | smaa-high | smaa-ultra | taa`.
    pub mode: AntiAlias,
    /// Jittered frames a TAA capture accumulates (1..=16; ignored by the
    /// other modes). Each sample is a full render of the rig.
    pub taa_samples: u32,
}

/// Directional (sun) shadows.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShadowConfig {
    /// Cascade atlas edge in texels (512..=8192, power of two not required).
    pub map_size: u32,
    /// Cascades per view (1..=4).
    pub cascades: u32,
    /// Distance the last cascade reaches, metres.
    pub max_distance_m: f32,
    /// One cascade set fitted to the whole RGB rig and rendered once per
    /// frame, instead of one per camera (`shared_shadows`).
    pub shared: bool,
}

/// SSAO quality (Bevy GTAO slice/sample presets).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SsaoQuality {
    Low,
    Medium,
    High,
    Ultra,
}

/// Ambient occlusion (screen-space GTAO plus contact shadows).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SsaoConfig {
    pub enabled: bool,
    pub quality: SsaoQuality,
    /// Screen-space contact shadows ride with SSAO.
    pub contact_shadows: bool,
    /// Contact-shadow ray-march steps (1..=64).
    pub contact_shadow_steps: u32,
}

/// Screen-space reflections.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SsrConfig {
    pub enabled: bool,
    /// Linear ray-march steps (1..=64).
    pub linear_steps: u32,
    /// Bisection refinement steps (0..=16).
    pub bisection_steps: u32,
}

/// Bloom.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BloomConfig {
    /// 0 disables the pass.
    pub intensity: f32,
}

/// Depth of field.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DofConfig {
    pub enabled: bool,
    pub aperture_f_stops: f32,
    pub focal_distance_m: f32,
}

/// Motion blur.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MotionBlurConfig {
    /// Shutter angle in degrees; 0 disables the pass.
    pub shutter_angle: f32,
    pub samples: u32,
}

/// Display transform and colour grade.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GradingConfig {
    pub tone_map: ToneMap,
    pub exposure: f32,
    pub temperature: f32,
    pub tint: f32,
    pub post_saturation: f32,
    pub contrast: f32,
}

/// Lens effects.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LensConfig {
    pub vignette: f32,
    pub distortion: f32,
    pub chromatic_aberration: f32,
}

/// Static-map geometry LOD (the map's `derived/geometry-lod` derivative).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LodConfig {
    /// Use the derivative when the map ships one. When the map has none a
    /// job records `geometryLod: absent` in its manifest (never silent).
    pub enabled: bool,
    /// Screen-space error budget of a level switch, pixels (0.25..=16).
    pub pixel_error_px: f32,
}

/// Map texture tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextureTier {
    /// Full-resolution UASTC (or the ingest-built BC7 blocks of it).
    UastcFull,
    /// 512-px BC7 variant.
    #[serde(rename = "bc7-512")]
    Bc7_512,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextureConfig {
    pub tier: TextureTier,
}

/// Lidar tracing backend. Every backend produces the same bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LidarBackend {
    /// RT cores when the device has them, else the CPU reference.
    Auto,
    Gpu,
    Cpu,
    /// RT cores, each scan re-traced on the CPU and compared bit for bit.
    Verify,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LidarConfig {
    pub backend: LidarBackend,
}

/// RGB image product. Instance-ID, semantic and depth products are always
/// lossless whatever this says.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RgbOutput {
    Jpeg { quality: u8 },
    Png,
}

/// Video product (per-camera streams).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoCodec {
    H264,
    Hevc,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoOutput {
    pub codec: VideoCodec,
    /// Constant-quality value (CRF/CQ, 0..=51; lower is better).
    pub quality: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputConfig {
    /// Image-sequence RGB format.
    pub rgb: RgbOutput,
    pub video: VideoOutput,
}

/// CPU-side encoding of the frame's GPU work.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncodeConfig {
    /// Threads that finish the frame's command encoders (0 = one per core,
    /// capped at 16; 1 = serial). Output does not depend on it.
    pub finish_threads: u32,
}

/// When a capture's shader noise, jitter and sky clock advance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClockMode {
    /// A capture is a function of scene + simulation time only.
    Pinned,
    /// rc.73 semantics: captures depend on frames drawn before them.
    Free,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockConfig {
    pub mode: ClockMode,
}

/// Every knob of the native renderer. See the module docs.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderConfig {
    /// The preset these values started from (provenance; overrides do not
    /// change it).
    pub preset: Preset,
    pub aa: AaConfig,
    pub shadows: ShadowConfig,
    pub ssao: SsaoConfig,
    pub ssr: SsrConfig,
    pub bloom: BloomConfig,
    pub dof: DofConfig,
    pub motion_blur: MotionBlurConfig,
    pub grading: GradingConfig,
    pub lens: LensConfig,
    pub lod: LodConfig,
    pub textures: TextureConfig,
    pub lidar: LidarConfig,
    pub output: OutputConfig,
    pub encode: EncodeConfig,
    pub clock: ClockConfig,
}

impl RenderConfig {
    /// The preset's values.
    pub fn preset(preset: Preset) -> Self {
        let look = CinematicFx::default();
        let base = Self {
            preset,
            aa: AaConfig { mode: AntiAlias::SmaaUltra, taa_samples: 4 },
            shadows: ShadowConfig { map_size: 4096, cascades: 4, max_distance_m: 400.0, shared: true },
            ssao: SsaoConfig { enabled: true, quality: SsaoQuality::Ultra, contact_shadows: true, contact_shadow_steps: 16 },
            ssr: SsrConfig { enabled: true, linear_steps: 10, bisection_steps: 5 },
            bloom: BloomConfig { intensity: look.bloom_intensity },
            dof: DofConfig {
                enabled: look.dof_enabled,
                aperture_f_stops: look.dof_aperture_f_stops,
                focal_distance_m: look.dof_focal_distance_m,
            },
            motion_blur: MotionBlurConfig { shutter_angle: look.motion_shutter_angle, samples: look.motion_samples },
            grading: GradingConfig {
                tone_map: look.tone_map,
                exposure: look.grading_exposure,
                temperature: look.grading_temperature,
                tint: look.grading_tint,
                post_saturation: look.grading_post_saturation,
                contrast: look.grading_contrast,
            },
            lens: LensConfig {
                vignette: look.vignette_intensity,
                distortion: look.lens_distortion,
                chromatic_aberration: look.chromatic_aberration,
            },
            lod: LodConfig { enabled: true, pixel_error_px: 1.0 },
            textures: TextureConfig { tier: TextureTier::UastcFull },
            lidar: LidarConfig { backend: LidarBackend::Auto },
            // Output encoding is the consumer's choice, not part of a
            // preset's identity: both presets carry the same default.
            output: OutputConfig {
                rgb: RgbOutput::Png,
                video: VideoOutput { codec: VideoCodec::H264, quality: 20 },
            },
            encode: EncodeConfig { finish_threads: 0 },
            clock: ClockConfig { mode: ClockMode::Pinned },
        };
        match preset {
            Preset::Showcase => base,
            // Every effect stays; only its cost goes down. Values are the
            // result of the 3080 sweep (docs/engineering/native-render-config.md).
            Preset::Training => Self {
                aa: AaConfig { mode: AntiAlias::SmaaHigh, taa_samples: 4 },
                shadows: ShadowConfig { map_size: 2048, cascades: 3, max_distance_m: 250.0, shared: true },
                ssao: SsaoConfig { enabled: true, quality: SsaoQuality::Medium, contact_shadows: true, contact_shadow_steps: 8 },
                ssr: SsrConfig { enabled: true, linear_steps: 6, bisection_steps: 3 },
                lod: LodConfig { enabled: true, pixel_error_px: 2.0 },
                ..base
            },
        }
    }

    /// The measurement reference: every knob at its maximum. Not a preset;
    /// reachable through overrides and used to score the presets.
    pub fn reference() -> Self {
        let base = Self::preset(Preset::Showcase);
        Self {
            aa: AaConfig { mode: AntiAlias::Taa, taa_samples: 8 },
            shadows: ShadowConfig { map_size: 4096, cascades: 4, max_distance_m: 400.0, shared: false },
            ssao: SsaoConfig { enabled: true, quality: SsaoQuality::Ultra, contact_shadows: true, contact_shadow_steps: 32 },
            ssr: SsrConfig { enabled: true, linear_steps: 32, bisection_steps: 8 },
            lod: LodConfig { enabled: false, pixel_error_px: 1.0 },
            ..base
        }
    }

    /// Check every knob's range. The only error path for a bad value.
    pub fn validate(&self) -> Result<()> {
        let bad = |what: String| -> Result<()> { bail!("[native_render_config_invalid] {what}") };
        if !(1..=16).contains(&self.aa.taa_samples) {
            return bad(format!("aa.taaSamples {} (1..=16)", self.aa.taa_samples));
        }
        // Bevy silently rounds a non-power-of-two atlas up (2560 renders as
        // 4096), so such a size would not be what the config records.
        if !(512..=8192).contains(&self.shadows.map_size) || !self.shadows.map_size.is_power_of_two() {
            return bad(format!("shadows.mapSize {} (a power of two in 512..=8192)", self.shadows.map_size));
        }
        if !(1..=4).contains(&self.shadows.cascades) {
            return bad(format!("shadows.cascades {} (1..=4)", self.shadows.cascades));
        }
        if !(self.shadows.max_distance_m.is_finite() && self.shadows.max_distance_m >= 10.0) {
            return bad(format!("shadows.maxDistanceM {} (>= 10)", self.shadows.max_distance_m));
        }
        if !(1..=64).contains(&self.ssao.contact_shadow_steps) {
            return bad(format!("ssao.contactShadowSteps {} (1..=64)", self.ssao.contact_shadow_steps));
        }
        if !(1..=64).contains(&self.ssr.linear_steps) || self.ssr.bisection_steps > 16 {
            return bad(format!("ssr steps {}/{} (linear 1..=64, bisection 0..=16)", self.ssr.linear_steps, self.ssr.bisection_steps));
        }
        if !(0.25..=16.0).contains(&self.lod.pixel_error_px) {
            return bad(format!("lod.pixelErrorPx {} (0.25..=16)", self.lod.pixel_error_px));
        }
        if let RgbOutput::Jpeg { quality } = self.output.rgb {
            if !(1..=100).contains(&quality) {
                return bad(format!("output.rgb.quality {quality} (1..=100)"));
            }
        }
        if self.output.video.quality > 51 {
            return bad(format!("output.video.quality {} (0..=51)", self.output.video.quality));
        }
        if self.encode.finish_threads > 64 {
            return bad(format!("encode.finishThreads {} (0..=64)", self.encode.finish_threads));
        }
        self.cinematic_fx().validate().context("[native_render_config_invalid]")?;
        Ok(())
    }

    /// The camera/post look as the engine's per-camera profile consumes it.
    pub fn cinematic_fx(&self) -> CinematicFx {
        CinematicFx {
            aa: self.aa.mode,
            ssr: self.ssr.enabled,
            ssao: self.ssao.enabled,
            ssao_ultra: self.ssao.quality == SsaoQuality::Ultra,
            ssao_quality: Some(self.ssao.quality),
            contact_shadows: self.ssao.contact_shadows,
            contact_shadow_steps: self.ssao.contact_shadow_steps,
            ssr_linear_steps: self.ssr.linear_steps,
            ssr_bisection_steps: self.ssr.bisection_steps,
            chromatic_aberration: self.lens.chromatic_aberration,
            vignette_intensity: self.lens.vignette,
            lens_distortion: self.lens.distortion,
            dof_aperture_f_stops: self.dof.aperture_f_stops,
            dof_focal_distance_m: self.dof.focal_distance_m,
            dof_enabled: self.dof.enabled,
            motion_shutter_angle: self.motion_blur.shutter_angle,
            motion_samples: self.motion_blur.samples,
            bloom_intensity: self.bloom.intensity,
            grading_exposure: self.grading.exposure,
            grading_temperature: self.grading.temperature,
            grading_tint: self.grading.tint,
            grading_post_saturation: self.grading.post_saturation,
            grading_contrast: self.grading.contrast,
            tone_map: self.grading.tone_map,
        }
    }

    pub fn profile_config(&self) -> RenderProfileConfig {
        RenderProfileConfig { cinematic: self.cinematic_fx() }
    }

    /// Every dotted key a `--set` may name, with its current value.
    pub fn keys(&self) -> Result<Vec<(String, serde_json::Value)>> {
        fn walk(prefix: &str, value: &serde_json::Value, out: &mut Vec<(String, serde_json::Value)>) {
            match value {
                serde_json::Value::Object(map) if !map.contains_key("format") => {
                    for (key, child) in map {
                        let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
                        walk(&path, child, out);
                    }
                }
                other => out.push((prefix.to_string(), other.clone())),
            }
        }
        let mut out = Vec::new();
        walk("", &serde_json::to_value(self)?, &mut out);
        Ok(out)
    }
}

/// A preset plus overrides: the one config surface (CLI `--preset/--set`,
/// scene spec `render`, closed-loop protocol, config file).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderRequest {
    /// `training | showcase` (default `showcase`).
    #[serde(default)]
    pub preset: Option<String>,
    /// Dotted key -> JSON value, applied in key order.
    #[serde(default)]
    pub set: BTreeMap<String, serde_json::Value>,
}

impl RenderRequest {
    /// Parse `key=value` (value as JSON, else as a string).
    pub fn push_set(&mut self, assignment: &str) -> Result<()> {
        let (key, value) = assignment
            .split_once('=')
            .with_context(|| format!("[native_render_config_invalid] --set {assignment:?} is not key=value"))?;
        let value = serde_json::from_str(value).unwrap_or_else(|_| serde_json::Value::String(value.to_string())); // fallback-ok: an unquoted value is the string it spells; the typed deserialize below rejects a wrong type
        self.set.insert(key.trim().to_string(), value);
        Ok(())
    }

    /// The preset with every override applied, validated.
    pub fn resolve(&self) -> Result<RenderConfig> {
        let preset = match &self.preset {
            Some(name) => Preset::parse(name)?,
            None => Preset::Showcase,
        };
        let mut value = serde_json::to_value(RenderConfig::preset(preset))?;
        for (key, new) in &self.set {
            if key == "preset" {
                bail!("[native_render_config_invalid] set the preset with `preset`, not `set.preset`");
            }
            let mut slot = &mut value;
            for part in key.split('.') {
                slot = slot
                    .as_object_mut()
                    .and_then(|map| map.get_mut(part))
                    .ok_or_else(|| anyhow::anyhow!("[native_render_config_unknown_key] {key:?} is not a render config key"))?;
            }
            *slot = new.clone();
        }
        let config: RenderConfig = serde_json::from_value(value)
            .map_err(|error| anyhow::anyhow!("[native_render_config_invalid] {error}"))?;
        config.validate()?;
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_validate_and_round_trip() {
        for preset in Preset::ALL {
            let config = RenderConfig::preset(preset);
            config.validate().unwrap();
            let json = serde_json::to_string(&config).unwrap();
            assert_eq!(serde_json::from_str::<RenderConfig>(&json).unwrap(), config);
        }
    }

    #[test]
    fn training_keeps_every_effect_of_showcase() {
        let training = RenderConfig::preset(Preset::Training);
        assert!(training.ssao.enabled && training.ssao.contact_shadows && training.ssr.enabled);
        assert!(training.bloom.intensity > 0.0 && training.shadows.cascades >= 1);
        assert_ne!(training.aa.mode, AntiAlias::Off);
        assert!(training.lod.enabled);
    }

    #[test]
    fn overrides_apply_and_unknown_keys_fail() {
        let mut request = RenderRequest { preset: Some("training".into()), ..Default::default() };
        request.push_set("shadows.cascades=2").unwrap();
        request.push_set("aa.mode=fxaa").unwrap();
        request.push_set("output.rgb={\"format\":\"png\"}").unwrap();
        let config = request.resolve().unwrap();
        assert_eq!(config.preset, Preset::Training);
        assert_eq!(config.shadows.cascades, 2);
        assert_eq!(config.aa.mode, AntiAlias::Fxaa);
        assert_eq!(config.output.rgb, RgbOutput::Png);

        for bad in ["shadows.cascadez=2", "nope=1", "shadows.cascades.x=1"] {
            let mut request = RenderRequest::default();
            request.push_set(bad).unwrap();
            let error = request.resolve().unwrap_err().to_string();
            assert!(error.contains("native_render_config_unknown_key"), "{bad}: {error}");
        }
        for bad in ["shadows.cascades=9", "aa.mode=msaa", "shadows.cascades=\"two\"", "lod.pixelErrorPx=0"] {
            let mut request = RenderRequest::default();
            request.push_set(bad).unwrap();
            assert!(request.resolve().unwrap_err().to_string().contains("native_render_config_invalid"), "{bad}");
        }
        assert!(RenderRequest { preset: Some("cinematic".into()), ..Default::default() }.resolve().is_err());
    }

    #[test]
    fn every_key_is_listed() {
        let keys: Vec<String> = RenderConfig::preset(Preset::Showcase).keys().unwrap().into_iter().map(|k| k.0).collect();
        for key in ["aa.mode", "shadows.cascades", "ssao.quality", "ssr.linearSteps", "lod.pixelErrorPx", "output.rgb", "clock.mode"] {
            assert!(keys.iter().any(|k| k == key), "{key} missing from {keys:?}");
        }
    }
}
