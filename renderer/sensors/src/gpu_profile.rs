//! Opt-in device timestamps. One slot per ordered view, no CPU fence per pass.
use super::{ArmedFrames, FrameStamp};
use bevy::core_pipeline::schedule::{Core3d, Core3dSystems};
use bevy::prelude::*;
use bevy::render::camera::ExtractedCamera;
use bevy::render::renderer::{RenderContext, RenderDevice, RenderGraph, RenderGraphSystems, RenderQueue, ViewQuery};
use bevy::render::{Render, RenderApp, RenderStartup, RenderSystems};
use std::time::Instant;

const MAX_VIEWS: u32 = 64;
const STRIDE: u32 = 6;
const COPY_START: u32 = MAX_VIEWS * STRIDE;
const FRAME_START: u32 = COPY_START + 2;
const QUERY_COUNT: u32 = FRAME_START + 1;

#[derive(Resource)]
pub(super) struct GpuProfile {
    queries: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    staging: wgpu::Buffer,
    period_ns: f64,
    views: Vec<isize>,
}

#[derive(Resource)]
struct CpuClock(Instant);

fn cpu_start(mut clock: ResMut<CpuClock>) { clock.0 = Instant::now(); }

fn cpu_mark<const STAGE: u8>(mut clock: ResMut<CpuClock>, armed: Res<ArmedFrames>, frame: Res<FrameStamp>) {
    if armed.0.contains(&frame.0) {
        let label = ["assets", "viewsQueue", "prepare", "submit"][STAGE as usize];
        println!("PROF renderCpu frame={} stage={label} ms={:.3}", frame.0, clock.0.elapsed().as_secs_f64()*1e3);
    }
    clock.0 = Instant::now();
}

pub(super) fn install(app: &mut App) {
    use bevy::pbr::{
        clear_indirect_parameters_metadata, early_prepass_build_indirect_parameters,
        late_prepass_build_indirect_parameters, per_view_shadow_pass,
    };
    let render = app.sub_app_mut(RenderApp);
    render.insert_resource(CpuClock(Instant::now())).add_systems(Render, (
        cpu_start.before(RenderSystems::ExtractCommands),
        cpu_mark::<0>.after(RenderSystems::PrepareMeshes).before(RenderSystems::CreateViews),
        cpu_mark::<1>.after(RenderSystems::PhaseSort).before(RenderSystems::Prepare),
        cpu_mark::<2>.after(RenderSystems::Prepare).before(RenderSystems::Render),
        cpu_mark::<3>.after(RenderSystems::Render).before(super::receive_passes),
    ));
    render.add_systems(RenderGraph, frame_start.after(RenderGraphSystems::Begin).before(RenderGraphSystems::Render));
    render.add_systems(RenderStartup, setup).add_systems(
        Core3d,
        (
            stamp::<0>.before(clear_indirect_parameters_metadata).before(Core3dSystems::Prepass),
            stamp::<1>.after(early_prepass_build_indirect_parameters).before(per_view_shadow_pass::<false>),
            stamp::<2>.after(per_view_shadow_pass::<false>).before(bevy::core_pipeline::mip_generation::experimental::depth::early_downsample_depth),
            stamp::<3>.after(late_prepass_build_indirect_parameters).before(per_view_shadow_pass::<true>),
            stamp::<4>.after(per_view_shadow_pass::<true>).before(Core3dSystems::MainPass),
            stamp::<5>.after(bevy::core_pipeline::upscaling::upscaling),
        ),
    );
}

fn setup(mut commands: Commands, device: Res<RenderDevice>, queue: Res<RenderQueue>) {
    let needed = wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
    assert!(device.features().contains(needed), "GPU profiling requires encoder timestamp queries");
    let queries = device.wgpu_device().create_query_set(&wgpu::QuerySetDescriptor {
        label: Some("sensor-capture timestamps"), ty: wgpu::QueryType::Timestamp, count: QUERY_COUNT,
    });
    let make = |usage| device.wgpu_device().create_buffer(&wgpu::BufferDescriptor {
        label: Some("sensor-capture timestamps"), size: u64::from(QUERY_COUNT) * 8,
        usage, mapped_at_creation: false,
    });
    commands.insert_resource(GpuProfile {
        queries,
        resolve: make(wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC),
        staging: make(wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ),
        period_ns: f64::from(queue.get_timestamp_period()),
        views: Vec::new(),
    });
    println!("PROF gpuTimestampPeriodNs={}", queue.get_timestamp_period());
}

fn frame_start(mut ctx: RenderContext, profile: Res<GpuProfile>, armed: Res<ArmedFrames>, frame: Res<FrameStamp>) {
    if armed.0.contains(&frame.0) {
        ctx.command_encoder().write_timestamp(&profile.queries, FRAME_START);
    }
}

fn stamp<const SLOT: u32>(
    view: ViewQuery<&ExtractedCamera>, mut ctx: RenderContext,
    mut profile: ResMut<GpuProfile>, armed: Res<ArmedFrames>, frame: Res<FrameStamp>,
) {
    if !armed.0.contains(&frame.0) { return; }
    let order = view.into_inner().order;
    assert!(order >= 0 && order < MAX_VIEWS as isize, "too many profiled views");
    if SLOT == 0 { profile.views.push(order); }
    ctx.command_encoder().write_timestamp(&profile.queries, order as u32 * STRIDE + SLOT);
}

impl GpuProfile {
    pub(super) fn copy_start(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.write_timestamp(&self.queries, COPY_START);
    }
    pub(super) fn copy_end(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.write_timestamp(&self.queries, COPY_START + 1);
        // Unwritten Vulkan queries must never be resolved: WAIT on one can
        // stall the entire queue. Camera orders are contiguous from zero.
        if let Some(last) = self.views.iter().max() {
            encoder.resolve_query_set(&self.queries, 0..(*last as u32 + 1) * STRIDE, &self.resolve, 0);
        }
        encoder.resolve_query_set(&self.queries, COPY_START..QUERY_COUNT, &self.resolve, u64::from(COPY_START) * 8);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.staging, 0, u64::from(QUERY_COUNT) * 8);
    }
    pub(super) fn map(&self) -> crossbeam_channel::Receiver<()> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.staging.slice(..).map_async(wgpu::MapMode::Read, move |result| {
            result.expect("map timestamp buffer");
            tx.send(()).expect("timestamp receiver");
        });
        rx
    }
    pub(super) fn report(&mut self, frame: u64) {
        let mapped = self.staging.slice(..).get_mapped_range();
        let values: Vec<u64> = mapped.chunks_exact(8).map(|x| u64::from_ne_bytes(x.try_into().unwrap())).collect();
        let ms = |start: usize, end: usize| values[end].saturating_sub(values[start]) as f64 * self.period_ns / 1e6;
        self.views.sort_unstable();
        let mut render = 0.0;
        let mut shadows = 0.0;
        for order in self.views.drain(..) {
            let i = order as usize * STRIDE as usize;
            let total = ms(i, i + 5);
            let shadow = ms(i + 1, i + 2) + ms(i + 3, i + 4);
            render += total;
            shadows += shadow;
            println!("PROF gpuView frame={frame} order={order} totalMs={total:.3} shadowMs={shadow:.3}");
        }
        let copy = ms(COPY_START as usize, COPY_START as usize + 1);
        let all_render = ms(FRAME_START as usize, COPY_START as usize);
        println!("PROF gpuWholeFrame frame={frame} allRenderMs={all_render:.3} outsideViewMs={:.3}", all_render-render);
        println!("PROF gpuFrame frame={frame} renderMs={render:.3} shadowMs={shadows:.3} transferMs={copy:.3}");
        drop(mapped);
        self.staging.unmap();
    }
}
