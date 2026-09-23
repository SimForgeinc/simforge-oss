//! The dash-cam camera model: per-camera automatic exposure and a wide
//! dynamic range (WDR) tone curve, like an automotive camera's ISP.
//!
//! Every RGB camera whose look uses `grading.toneMap = dashcam-wdr` carries
//! a [`CameraModel`]. It runs as one post-process step, after Bevy's
//! (disabled) tone mapping and before FXAA/SMAA, on the pre-exposed HDR frame:
//!
//! 1. **Metering** (`camera_model_meter.wgsl`). A 128-bin log2-luminance
//!    histogram of this frame, each pixel weighted by the metering mode
//!    (`dashcam`: centre-weighted, the sky band at the top counting 1/4).
//!    The darkest and brightest `trim` of the weighted samples are dropped;
//!    the weighted mean log2 luminance is placed at `key` (0.18). The result
//!    is the frame's exposure adjustment in stops, plus `compensationEv`,
//!    bounded so the final EV100 stays inside the sensor's range.
//! 2. **Tone mapping** (`camera_model_apply.wgsl`). The frame is scaled by the
//!    adjustment and its luminance mapped through
//!    `f(x) = log2(1 + c·x) / log2(1 + c·W)`, where `W` is the scene
//!    luminance that prints white (`key · 2^whiteStops`) and `c` is solved so
//!    that `f(key) = midGrey`. The log curve lifts shadows and rolls
//!    highlights off like a WDR sensor instead of crushing the toe the way a
//!    filmic curve does. Chroma is kept; highlights desaturate towards white.
//!
//! Exposure is **instant**: the adjustment is a function of the frame being
//! rendered, with no state carried between renders, so a pinned capture of
//! tick `t` is the same whichever ticks were rendered before it. Histogram
//! counts are integer atomics, so the metering does not depend on invocation
//! order. The metered EV100 is read back with every capture that asks for
//! `<sensor>:exposure` (four f32: final EV100, adjustment in stops, metered
//! mean log2 luminance, total metering weight).
use bevy::asset::embedded_asset;
use bevy::camera::Exposure;
use bevy::core_pipeline::schedule::{Core3d, Core3dSystems};
use bevy::core_pipeline::tonemapping::tonemapping;
use bevy::core_pipeline::FullscreenShader;
use bevy::image::Image;
use bevy::math::Vec4;
use bevy::prelude::*;
use bevy::render::extract_component::{ExtractComponent, ExtractComponentPlugin};
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_resource::binding_types::{storage_buffer, storage_buffer_read_only, texture_2d, uniform_buffer};
use bevy::render::render_resource::{
    BindGroupEntries, BindGroupLayoutDescriptor, BindGroupLayoutEntries, Buffer, BufferDescriptor, BufferUsages,
    CachedComputePipelineId, CachedRenderPipelineId, ColorTargetState, ColorWrites, ComputePassDescriptor,
    ComputePipelineDescriptor, DynamicUniformBuffer, FragmentState, Operations, PipelineCache,
    RenderPassColorAttachment, RenderPassDescriptor, RenderPipelineDescriptor, ShaderStages, ShaderType,
    TextureFormat, TextureSampleType,
};
use bevy::render::diagnostic::RecordDiagnostics;
use bevy::render::renderer::{RenderContext, RenderDevice, RenderQueue, ViewQuery};
use bevy::render::sync_component::SyncComponent;
use bevy::render::texture::GpuImage;
use bevy::render::view::ViewTarget;
use bevy::render::{Render, RenderApp, RenderStartup, RenderSystems};
use bevy::shader::ShaderRef;
use std::collections::HashMap;

/// Histogram range in log2 of pre-exposed luminance (display-linear units
/// before the camera's own adjustment; mid grey at the incident exposure is
/// log2(0.18) = -2.47).
pub const HISTOGRAM_MIN_LOG2: f32 = -14.0;
pub const HISTOGRAM_RANGE_LOG2: f32 = 20.0;

/// Where the metering looks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metering {
    /// Every pixel counts the same.
    Average,
    /// Centre-weighted: the central ellipse counts fully, the corners 1/4.
    CenterWeighted,
    /// Centre-weighted with the sky band at the top of the frame at 1/4:
    /// what a forward dash camera meters on.
    Dashcam,
}

/// The dash-cam camera model on one RGB camera. See the module docs.
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct CameraModel {
    /// Meter every frame (true) or keep the incident exposure (false).
    pub auto: bool,
    /// Added to the metered adjustment, stops (positive: brighter).
    pub compensation_ev: f32,
    pub metering: Metering,
    /// Fraction of the weighted samples dropped at each end of the histogram.
    pub trim: f32,
    /// Pre-exposed luminance the metered mean is placed at.
    pub key: f32,
    /// Sensor EV100 range the final exposure is bounded to.
    pub min_ev100: f32,
    pub max_ev100: f32,
    /// Stops above `key` that print white.
    pub white_stops: f32,
    /// Display-linear value `key` prints at.
    pub mid_grey: f32,
    pub saturation: f32,
    pub contrast: f32,
    /// Extra exposure after metering, stops (the grading exposure).
    pub grading_exposure_ev: f32,
}

impl CameraModel {
    /// The documented defaults (see `RenderConfig`'s `camera` group).
    pub fn dashcam() -> Self {
        Self {
            auto: true,
            compensation_ev: 0.0,
            metering: Metering::Dashcam,
            trim: 0.05,
            key: 0.18,
            min_ev100: 0.0,
            max_ev100: 16.0,
            white_stops: 6.0,
            mid_grey: 0.2,
            saturation: 1.0,
            contrast: 1.0,
            grading_exposure_ev: 0.0,
        }
    }

    /// The curve constant `c` with `f(key) = mid_grey`, by bisection:
    /// `f` rises monotonically from `key / W` (c → 0) to 1 (c → ∞).
    pub fn curve_c(&self) -> f32 {
        let white = self.key * self.white_stops.exp2();
        let f = |c: f64| (1.0 + c * self.key as f64).log2() / (1.0 + c * white as f64).log2();
        let (mut lo, mut hi) = (1.0e-4f64, 1.0e7f64);
        for _ in 0..200 {
            let mid = (lo * hi).sqrt();
            if f(mid) < self.mid_grey as f64 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        ((lo * hi).sqrt()) as f32
    }

    /// The display-linear value a pre-exposed luminance `x` prints at
    /// (after the metered adjustment), before saturation and contrast.
    pub fn curve(&self, x: f32) -> f32 {
        let c = self.curve_c();
        let white = self.key * self.white_stops.exp2();
        (1.0 + c * x).log2() / (1.0 + c * white).log2()
    }
}

/// Copy the pre-exposure HDR frame of this camera into `0` every frame (the
/// `hdr` pass): linear, pre-exposed (`L_scene = value · 1.2 · 2^EV100`
/// cd/m², EV100 being the camera's base exposure before the metered
/// adjustment).
#[derive(Component, Clone, Debug, ExtractComponent)]
pub struct HdrCapture(pub Handle<Image>);

/// Render-world copy of [`CameraModel`] with the camera's base EV100.
#[derive(Component, Clone, Copy, Debug)]
pub struct ExtractedCameraModel {
    model: CameraModel,
    base_ev100: f32,
}

impl SyncComponent for CameraModel {
    type Target = ExtractedCameraModel;
}

impl ExtractComponent for CameraModel {
    type QueryData = (&'static CameraModel, Option<&'static Exposure>);
    type QueryFilter = ();
    type Out = ExtractedCameraModel;

    fn extract_component((model, exposure): (&CameraModel, Option<&Exposure>)) -> Option<ExtractedCameraModel> {
        Some(ExtractedCameraModel {
            model: *model,
            // Bevy's own default when a camera carries no Exposure.
            base_ev100: exposure.map_or(Exposure::default().ev100, |e| e.ev100), // fallback-ok: Bevy's default exposure is what such a camera renders with
        })
    }
}

/// Per-view GPU state: the histogram and the metering result (also the
/// source of the `<sensor>:exposure` readback).
#[derive(Component)]
pub struct CameraModelBuffers {
    histogram: Buffer,
    pub result: Buffer,
}

#[derive(Clone, Copy, ShaderType)]
struct GpuCameraParams {
    exposure: Vec4,
    metering: Vec4,
    curve: Vec4,
    misc: Vec4,
    size: Vec4,
}

#[derive(Resource, Default)]
struct CameraModelUniforms(DynamicUniformBuffer<GpuCameraParams>);

#[derive(Component)]
struct CameraModelOffset(u32);

#[derive(Resource)]
struct CameraModelPipelines {
    meter_layout: BindGroupLayoutDescriptor,
    apply_layout: BindGroupLayoutDescriptor,
    histogram: CachedComputePipelineId,
    average: CachedComputePipelineId,
    apply_shader: Handle<Shader>,
    fullscreen: FullscreenShader,
    apply: HashMap<TextureFormat, CachedRenderPipelineId>,
}

pub struct CameraModelPlugin;

impl Plugin for CameraModelPlugin {
    fn build(&self, app: &mut App) {
        embedded_asset!(app, "shaders/camera_model_meter.wgsl");
        embedded_asset!(app, "shaders/camera_model_apply.wgsl");
        app.add_plugins((ExtractComponentPlugin::<CameraModel>::default(), ExtractComponentPlugin::<HdrCapture>::default()));
        let Some(render_app) = app.get_sub_app_mut(RenderApp) else {
            return;
        };
        render_app
            .init_resource::<CameraModelUniforms>()
            .add_systems(RenderStartup, init_pipelines)
            .add_systems(
                Render,
                (
                    prepare_buffers.in_set(RenderSystems::PrepareResources),
                    prepare_uniforms.in_set(RenderSystems::PrepareResources),
                    prepare_apply_pipelines.in_set(RenderSystems::Prepare),
                ),
            )
            .add_systems(
                Core3d,
                camera_model_pass
                    .after(tonemapping)
                    .before(bevy::anti_alias::fxaa::fxaa)
                    .before(bevy::anti_alias::smaa::smaa)
                    .in_set(Core3dSystems::PostProcess),
            );
    }
}

fn shader(asset_server: &AssetServer, name: &str) -> Handle<Shader> {
    match ShaderRef::Path(format!("embedded://render_core/shaders/{name}").into()) {
        ShaderRef::Path(path) => asset_server.load(path),
        _ => unreachable!(),
    }
}

fn init_pipelines(
    mut commands: Commands,
    asset_server: Res<AssetServer>,
    fullscreen: Res<FullscreenShader>,
    pipeline_cache: Res<PipelineCache>,
) {
    let meter_layout = BindGroupLayoutDescriptor::new(
        "camera_model_meter_layout",
        &BindGroupLayoutEntries::sequential(
            ShaderStages::COMPUTE,
            (
                uniform_buffer::<GpuCameraParams>(true),
                texture_2d(TextureSampleType::Float { filterable: false }),
                storage_buffer::<[u32; 128]>(false),
                storage_buffer::<[f32; 4]>(false),
            ),
        ),
    );
    let apply_layout = BindGroupLayoutDescriptor::new(
        "camera_model_apply_layout",
        &BindGroupLayoutEntries::sequential(
            ShaderStages::FRAGMENT,
            (
                uniform_buffer::<GpuCameraParams>(true),
                texture_2d(TextureSampleType::Float { filterable: false }),
                storage_buffer_read_only::<[f32; 4]>(false),
            ),
        ),
    );
    let meter = shader(&asset_server, "camera_model_meter.wgsl");
    let compute = |label: &'static str, entry: &'static str| ComputePipelineDescriptor {
        label: Some(label.into()),
        layout: vec![meter_layout.clone()],
        shader: meter.clone(),
        entry_point: Some(entry.into()),
        ..default()
    };
    let histogram = pipeline_cache.queue_compute_pipeline(compute("camera_model_histogram", "histogram_pass"));
    let average = pipeline_cache.queue_compute_pipeline(compute("camera_model_average", "average_pass"));
    commands.insert_resource(CameraModelPipelines {
        meter_layout,
        apply_layout,
        histogram,
        average,
        apply_shader: shader(&asset_server, "camera_model_apply.wgsl"),
        fullscreen: fullscreen.clone(),
        apply: HashMap::new(),
    });
}

fn prepare_apply_pipelines(
    pipelines: Option<ResMut<CameraModelPipelines>>,
    pipeline_cache: Res<PipelineCache>,
    views: Query<&ViewTarget, With<ExtractedCameraModel>>,
) {
    let Some(mut pipelines) = pipelines else { return };
    for target in &views {
        let format = target.main_texture_format();
        if pipelines.apply.contains_key(&format) {
            continue;
        }
        let descriptor = RenderPipelineDescriptor {
            label: Some("camera_model_apply".into()),
            layout: vec![pipelines.apply_layout.clone()],
            vertex: pipelines.fullscreen.to_vertex_state(),
            fragment: Some(FragmentState {
                shader: pipelines.apply_shader.clone(),
                entry_point: Some("apply_pass".into()),
                targets: vec![Some(ColorTargetState { format, blend: None, write_mask: ColorWrites::ALL })],
                ..default()
            }),
            ..default()
        };
        let id = pipeline_cache.queue_render_pipeline(descriptor);
        pipelines.apply.insert(format, id);
    }
}

fn prepare_buffers(
    mut commands: Commands,
    device: Res<RenderDevice>,
    views: Query<Entity, (With<ExtractedCameraModel>, Without<CameraModelBuffers>)>,
) {
    for entity in &views {
        let buffer = |label: &'static str, size: u64, usage: BufferUsages| {
            device.create_buffer(&BufferDescriptor { label: Some(label), size, usage, mapped_at_creation: false })
        };
        commands.entity(entity).insert(CameraModelBuffers {
            histogram: buffer("camera_model_histogram", 128 * 4, BufferUsages::STORAGE | BufferUsages::COPY_DST),
            result: buffer("camera_model_result", 16, BufferUsages::STORAGE | BufferUsages::COPY_SRC),
        });
    }
}

fn prepare_uniforms(
    mut commands: Commands,
    device: Res<RenderDevice>,
    queue: Res<RenderQueue>,
    mut uniforms: ResMut<CameraModelUniforms>,
    views: Query<(Entity, &ExtractedCameraModel, &ViewTarget)>,
) {
    if views.iter().len() == 0 {
        return;
    }
    uniforms.0.clear();
    let mut offsets = Vec::new();
    for (entity, extracted, target) in &views {
        let m = &extracted.model;
        let c = m.curve_c();
        let white = m.key * m.white_stops.exp2();
        let size = target.main_texture().size();
        let gpu = GpuCameraParams {
            exposure: Vec4::new(extracted.base_ev100, m.compensation_ev, m.min_ev100, m.max_ev100),
            metering: Vec4::new(
                if m.auto { 1.0 } else { 0.0 },
                match m.metering {
                    Metering::Average => 0.0,
                    Metering::CenterWeighted => 1.0,
                    Metering::Dashcam => 2.0,
                },
                m.trim,
                m.key,
            ),
            curve: Vec4::new(c, 1.0 / (1.0 + c * white).log2(), m.saturation, m.contrast),
            misc: Vec4::new(m.grading_exposure_ev, HISTOGRAM_MIN_LOG2, HISTOGRAM_RANGE_LOG2, size.width as f32),
            size: Vec4::new(size.height as f32, 0.0, 0.0, 0.0),
        };
        offsets.push((entity, uniforms.0.push(&gpu)));
    }
    uniforms.0.write_buffer(&device, &queue);
    for (entity, offset) in offsets {
        commands.entity(entity).insert(CameraModelOffset(offset));
    }
}

fn camera_model_pass(
    view: ViewQuery<(
        &ViewTarget,
        &CameraModelBuffers,
        &CameraModelOffset,
        Option<&HdrCapture>,
    )>,
    pipelines: Option<Res<CameraModelPipelines>>,
    pipeline_cache: Res<PipelineCache>,
    uniforms: Res<CameraModelUniforms>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    mut ctx: RenderContext,
) {
    let (target, buffers, offset, hdr) = view.into_inner();
    let Some(pipelines) = pipelines else { return };
    let (Some(histogram), Some(average)) = (
        pipeline_cache.get_compute_pipeline(pipelines.histogram),
        pipeline_cache.get_compute_pipeline(pipelines.average),
    ) else {
        return;
    };
    let Some(apply) = pipelines
        .apply
        .get(&target.main_texture_format())
        .and_then(|id| pipeline_cache.get_render_pipeline(*id))
    else {
        return;
    };
    let Some(binding) = uniforms.0.binding() else { return };
    let device = ctx.render_device().clone();
    let post = target.post_process_write();
    let size = post.source_texture.size();
    if let Some(gpu) = hdr.and_then(|hdr| gpu_images.get(&hdr.0)) {
        ctx.command_encoder().copy_texture_to_texture(
            post.source_texture.as_image_copy(),
            gpu.texture.as_image_copy(),
            size,
        );
    }
    let meter_group = device.create_bind_group(
        "camera_model_meter",
        &pipeline_cache.get_bind_group_layout(&pipelines.meter_layout),
        &BindGroupEntries::sequential((
            binding.clone(),
            post.source,
            buffers.histogram.as_entire_binding(),
            buffers.result.as_entire_binding(),
        )),
    );
    let apply_group = device.create_bind_group(
        "camera_model_apply",
        &pipeline_cache.get_bind_group_layout(&pipelines.apply_layout),
        &BindGroupEntries::sequential((binding, post.source, buffers.result.as_entire_binding())),
    );
    let diagnostics = ctx.diagnostic_recorder();
    let diagnostics = diagnostics.as_deref();
    let encoder = ctx.command_encoder();
    let span = diagnostics.time_span(encoder, "camera_model");
    // The histogram starts from zero every frame: nothing carries over.
    encoder.clear_buffer(&buffers.histogram, 0, None);
    {
        let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor { label: Some("camera_model_meter"), timestamp_writes: None });
        pass.set_bind_group(0, &meter_group, &[offset.0]);
        pass.set_pipeline(histogram);
        pass.dispatch_workgroups(size.width.div_ceil(16), size.height.div_ceil(16), 1);
        pass.set_pipeline(average);
        pass.dispatch_workgroups(1, 1, 1);
    }
    let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
        label: Some("camera_model_apply"),
        color_attachments: &[Some(RenderPassColorAttachment {
            view: post.destination,
            depth_slice: None,
            resolve_target: None,
            ops: Operations::default(),
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    pass.set_pipeline(apply);
    pass.set_bind_group(0, &apply_group, &[offset.0]);
    pass.draw(0..3, 0..1);
    drop(pass);
    span.end(encoder);
}

/// The exposure a camera program realises for a final EV100: aperture
/// fixed, shutter first (ISO 100) up to the longest shutter, then gain.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposureSettings {
    pub ev100: f32,
    pub f_number: f32,
    pub shutter_s: f32,
    pub iso: f32,
    pub gain_db: f32,
}

/// `EV100 = log2(N²/t) − log2(S/100)`.
pub fn exposure_program(ev100: f32, f_number: f32, min_shutter_s: f32, max_shutter_s: f32, iso_max: f32) -> ExposureSettings {
    let n2 = f_number * f_number;
    let mut shutter = (n2 / ev100.exp2()).clamp(min_shutter_s, max_shutter_s);
    let mut iso = 100.0 * n2 / (shutter * ev100.exp2());
    if iso < 100.0 {
        iso = 100.0;
        shutter = n2 / ev100.exp2();
    }
    let iso = iso.min(iso_max);
    ExposureSettings { ev100, f_number, shutter_s: shutter, iso, gain_db: 20.0 * (iso / 100.0).log10() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> CameraModel {
        CameraModel::dashcam()
    }

    #[test]
    fn the_curve_prints_key_at_mid_grey_and_white_at_white() {
        let m = model();
        assert!((m.curve(0.18) - 0.2).abs() < 1.0e-4);
        assert!((m.curve(0.18 * 64.0) - 1.0).abs() < 1.0e-4);
        // Shadows two stops under the key keep more than a linear print.
        assert!(m.curve(0.045) > 0.2 / 4.0);
    }

    #[test]
    fn the_exposure_program_prefers_shutter_then_gain() {
        let noon = exposure_program(15.0, 1.8, 1.0 / 8000.0, 1.0 / 30.0, 6400.0);
        assert_eq!(noon.iso, 100.0);
        assert!((noon.shutter_s - 3.24 / 32768.0).abs() < 1.0e-7);
        let dusk = exposure_program(4.0, 1.8, 1.0 / 8000.0, 1.0 / 30.0, 6400.0);
        assert!((dusk.shutter_s - 1.0 / 30.0).abs() < 1.0e-6);
        assert!(dusk.iso > 100.0 && dusk.gain_db > 0.0);
    }
}
