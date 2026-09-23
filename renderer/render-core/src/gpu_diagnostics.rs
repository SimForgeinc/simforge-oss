//! Opt-in per-pass GPU timing for profiling the resident engine.
//!
//! Set `SIMFORGE_RENDER_DIAGNOSTICS=1` before building a [`crate::engine::SceneApp`]
//! and Bevy's `RenderDiagnosticsPlugin` records a timestamp pair (and, where
//! the adapter supports it, pipeline statistics) around every instrumented
//! render pass. [`drain`] sums everything synced into the `DiagnosticsStore`
//! since the previous call, per diagnostic path, and clears the history so
//! consecutive calls never double count.
//!
//! Every view records its own span under the same path, so a total is the
//! sum over views and frames; `count` is the number of spans summed.
use bevy::diagnostic::DiagnosticsStore;
use bevy::prelude::World;

/// Environment switch read once at app construction.
pub const ENV: &str = "SIMFORGE_RENDER_DIAGNOSTICS";

/// Whether the diagnostics plugin should be installed.
pub fn enabled() -> bool {
    std::env::var_os(ENV).is_some_and(|value| !value.is_empty() && value != "0")
}

/// Sum of one diagnostic path since the last drain.
#[derive(Clone, Debug, serde::Serialize)]
pub struct PassTotal {
    pub path: String,
    pub total: f64,
    pub count: usize,
}

/// Sum and clear every `render/...` diagnostic in the store.
pub fn drain(world: &mut World) -> Vec<PassTotal> {
    let Some(mut store) = world.get_resource_mut::<DiagnosticsStore>() else {
        return Vec::new();
    };
    let mut totals = Vec::new();
    for diagnostic in store.iter_mut() {
        let path = diagnostic.path().as_str().to_string();
        if !path.starts_with("render/") {
            continue;
        }
        let (total, count) = diagnostic
            .values()
            .fold((0.0f64, 0usize), |(sum, n), value| (sum + value, n + 1));
        if count > 0 {
            totals.push(PassTotal { path, total, count });
        }
        diagnostic.clear_history();
    }
    totals.sort_by(|a, b| a.path.cmp(&b.path));
    totals
}

// ---------------------------------------------------------------------------
// Whole-frame GPU time.
//
// Bevy's per-pass spans are capped at 256 timestamps per frame (a rig of
// eight cinematic views overflows it) and the shadow passes carry no span
// at all, so the per-pass sums undercount. The frame timer brackets the
// whole render graph instead: one timestamp in an encoder recorded before
// `RenderGraphSystems::Render`, one after it (before `Submit`), resolved
// into a small ring of mappable buffers and read back asynchronously.
// Everything the frame submits runs between the two, in queue order.

use bevy::prelude::{App, IntoScheduleConfigs, Res, ResMut, Resource};
use bevy::render::render_resource::{Buffer, BufferDescriptor, BufferUsages, MapMode};
use wgpu::QuerySet;
use bevy::render::renderer::{RenderContext, RenderDevice, RenderGraph, RenderGraphSystems, RenderQueue};
use bevy::render::RenderApp;
use std::sync::{Arc, Mutex};

const RING: usize = 8;

/// Completed whole-frame GPU times, milliseconds, oldest first. Shared by
/// the main and render worlds.
#[derive(Resource, Clone, Default)]
pub struct GpuFrameTimes(pub Arc<Mutex<Vec<f64>>>);

#[derive(Resource)]
struct FrameTimer {
    set: QuerySet,
    resolve: Buffer,
    slots: Vec<(Buffer, Arc<std::sync::atomic::AtomicBool>)>,
    frame: usize,
    armed: Option<usize>,
    period_ns: f64,
}

/// Install the frame timer (only when [`enabled`]).
pub fn install_frame_timer(app: &mut App) {
    let times = GpuFrameTimes::default();
    app.insert_resource(times.clone());
    let render_app = app.sub_app_mut(RenderApp);
    render_app.insert_resource(times).init_resource::<SharedTimer>().add_systems(
        RenderGraph,
        (
            frame_timer_begin
                .after(RenderGraphSystems::Begin)
                .before(RenderGraphSystems::Render),
            frame_timer_end
                .after(RenderGraphSystems::Render)
                .before(RenderGraphSystems::Submit),
            frame_timer_map.after(RenderGraphSystems::Submit),
        ),
    );
}

fn timer<'a>(slot: &'a mut Option<FrameTimer>, device: &RenderDevice, queue: &RenderQueue) -> Option<&'a mut FrameTimer> {
    if slot.is_none() {
        let features = device.features();
        if !features.contains(bevy::render::settings::WgpuFeatures::TIMESTAMP_QUERY_INSIDE_ENCODERS) {
            return None;
        }
        let set = device.wgpu_device().create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("simforge_frame_timer"),
            ty: wgpu::QueryType::Timestamp,
            count: 2,
        });
        let resolve = device.create_buffer(&BufferDescriptor {
            label: Some("simforge_frame_timer_resolve"),
            size: 16,
            usage: BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let slots = (0..RING)
            .map(|_| {
                (
                    device.create_buffer(&BufferDescriptor {
                        label: Some("simforge_frame_timer_read"),
                        size: 16,
                        usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    }),
                    Arc::new(std::sync::atomic::AtomicBool::new(false)),
                )
            })
            .collect();
        *slot = Some(FrameTimer {
            set: set.into(),
            resolve,
            slots,
            frame: 0,
            armed: None,
            period_ns: f64::from(queue.get_timestamp_period()),
        });
    }
    slot.as_mut()
}

fn frame_timer_begin(
    mut ctx: RenderContext,
    device: Res<RenderDevice>,
    queue: Res<RenderQueue>,
    mut shared: ResMut<SharedTimer>,
) {
    // Built lazily on the first frame (the render device exists by then).
    let Some(t) = timer(&mut shared.0, &device, &queue) else { return };
    let index = t.frame % RING;
    t.armed = None;
    if t.slots[index].1.load(std::sync::atomic::Ordering::Acquire) {
        return; // slot still being read back; skip timing this frame
    }
    ctx.command_encoder().write_timestamp(&t.set, 0);
    t.armed = Some(index);
}

#[derive(Resource, Default)]
struct SharedTimer(Option<FrameTimer>);

fn frame_timer_end(mut ctx: RenderContext, mut shared: ResMut<SharedTimer>) {
    let Some(t) = shared.0.as_mut() else { return };
    let Some(index) = t.armed else { return };
    let encoder = ctx.command_encoder();
    encoder.write_timestamp(&t.set, 1);
    encoder.resolve_query_set(&t.set, 0..2, &t.resolve, 0);
    encoder.copy_buffer_to_buffer(&t.resolve, 0, &t.slots[index].0, 0, 16);
}

fn frame_timer_map(mut shared: ResMut<SharedTimer>, times: Res<GpuFrameTimes>) {
    let Some(t) = shared.0.as_mut() else { return };
    t.frame += 1;
    let Some(index) = t.armed.take() else { return };
    let (buffer, busy) = t.slots[index].clone();
    busy.store(true, std::sync::atomic::Ordering::Release);
    let period = t.period_ns;
    let times = times.0.clone();
    let slice_buffer = buffer.clone();
    buffer.slice(..).map_async(MapMode::Read, move |result| {
        if result.is_ok() {
            let bytes = slice_buffer.slice(..).get_mapped_range();
            let begin = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
            let end = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
            drop(bytes);
            if end > begin {
                times.lock().unwrap().push((end - begin) as f64 * period / 1.0e6);
            }
        }
        slice_buffer.unmap();
        busy.store(false, std::sync::atomic::Ordering::Release);
    });
}

/// Drain the whole-frame GPU times completed so far.
pub fn take_frame_times(world: &World) -> Vec<f64> {
    world
        .get_resource::<GpuFrameTimes>()
        .map(|times| std::mem::take(&mut *times.0.lock().unwrap()))
        .unwrap_or_default()
}
