//! GPU allocation census: attribute the bytes this process holds on the GPU
//! to named categories, from measured sources only.
//!
//! The streaming scheduler's `residentBytes` is an *intent* ledger: it counts
//! the vertex/index bytes it decided to admit plus the on-disk length of the
//! KTX2 file a material references. It is not, and was never, a statement
//! about what the driver allocated. The benchmark's `gpuProcessBytes` is the
//! opposite — a true driver figure, but a single sample with no breakdown.
//! Between them sat a 2.5-11x unexplained gap.
//!
//! This module closes it with three independent ledgers:
//!
//! | ledger | source | what it proves |
//! |---|---|---|
//! | scheduler accounting | `LoadedMap::resident_bytes` (`main.rs`) | what the planner believes it admitted |
//! | wgpu/hal allocation | [`wgpu::Device::get_internal_counters`] | bytes wgpu's Vulkan/Metal backend actually allocated, split buffer vs texture |
//! | driver per-process | `nvidia-smi --query-compute-apps` (harness) | what the driver charges the process, including its own heaps |
//!
//! Inside the wgpu ledger the split is measured, not modelled:
//!
//! * mesh geometry — [`MeshAllocator::slabs_size`], the slab buffers Bevy
//!   actually created for vertex/index data (`bevy_render::mesh::allocator`);
//! * transcoded textures + mips — every [`GpuImage`] in `RenderAssets` whose
//!   asset id is one of the map's material images, sized from its real
//!   `texture_descriptor` (format block size x mip chain x layers), which is
//!   the transcode target, not the file length;
//! * sky + LUTs — the same computation over the non-map `GpuImage`s (the
//!   tonemapping LUTs and Bevy's fallback images);
//! * render targets, depth and internal caches — wgpu texture memory minus
//!   the asset images above. Captured as a *baseline* before any map is
//!   loaded, so the figure is a measured delta rather than a guess at the
//!   core 3d pipeline's target set;
//! * staging/transient and uniform/instance buffers — wgpu buffer memory
//!   minus the mesh slabs;
//! * unreclaimed-after-eviction — the wgpu ledger after the scheduler has
//!   evicted every node and the device has been polled to completion, minus
//!   the baseline. Dropping an ECS handle is not proof the driver retired the
//!   memory; this is the number that proves it either way.
//!
//! Every field is sampled once per render frame, so `peak` is a peak over
//! frames rather than a single dwell-time sample.

use bevy::asset::AssetId;
use bevy::image::Image;
use bevy::pbr::{ExtractedDirectionalLight, ExtractedPointLight};
use bevy::prelude::*;
use bevy::render::mesh::allocator::MeshAllocator;
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_resource::{PollType, TextureDimension, TextureFormat};
use bevy::render::renderer::RenderDevice;
use bevy::render::texture::GpuImage;
use bevy::render::{Render, RenderApp, RenderSystems};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// One coherent sample of every measured GPU quantity, taken inside a single
/// render frame. Coherent matters: per-field maxima taken from different
/// frames do not add up to a state the process was ever in.
#[derive(Clone, Copy, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    /// Render frames sampled when this snapshot was taken.
    pub frame: u64,
    /// `HalCounters::buffer_memory`: bytes wgpu's backend allocated for
    /// buffers. Allocation sizes, so alignment padding is included.
    pub wgpu_buffer_bytes: u64,
    /// `HalCounters::texture_memory`: bytes wgpu's backend allocated for
    /// textures, including mip chains it created.
    pub wgpu_texture_bytes: u64,
    /// `HalCounters::memory_allocations`: distinct device allocations.
    pub wgpu_allocations: u64,
    /// `MeshAllocator::slabs_size`: total size of the vertex/index slab
    /// buffers. Slabs grow by `growth_factor` and are never shrunk, so this
    /// exceeds the sum of live allocations and is the honest charge.
    pub mesh_slab_bytes: u64,
    pub mesh_slab_count: u64,
    /// Transcoded map textures with their mip chains, from the GPU texture
    /// descriptors actually created.
    pub map_texture_bytes: u64,
    pub map_textures: u64,
    /// Non-map `GpuImage`s: tonemapping LUTs, sky/environment images and
    /// Bevy's fallback images.
    pub other_texture_bytes: u64,
    pub other_textures: u64,
    /// Lights that would own a shadow atlas. Zero is evidence, not an
    /// assumption, that the shadow-atlas category is empty.
    pub shadow_casting_lights: u64,
}

impl GpuSample {
    /// Bytes wgpu itself admits to having allocated.
    pub fn wgpu_total(&self) -> u64 {
        self.wgpu_buffer_bytes + self.wgpu_texture_bytes
    }

    /// Buffer memory that is not mesh geometry: uniform/storage buffers, the
    /// GPU-preprocessing instance buffers, and the staging belt.
    pub fn transient_buffer_bytes(&self) -> u64 {
        self.wgpu_buffer_bytes.saturating_sub(self.mesh_slab_bytes)
    }

    /// Texture memory that belongs to no asset: swapchain-sized render
    /// targets, depth, prepass and post-processing textures from
    /// `bevy_render::texture::TextureCache`.
    pub fn non_asset_texture_bytes(&self) -> u64 {
        self.wgpu_texture_bytes
            .saturating_sub(self.map_texture_bytes)
            .saturating_sub(self.other_texture_bytes)
    }
}

#[derive(Default)]
struct CensusInner {
    latest: GpuSample,
    baseline: Option<GpuSample>,
    /// The sample at which `wgpu_total()` was highest.
    peak: GpuSample,
    frames: u64,
    arm_baseline: bool,
    poll_pending: bool,
    map_images: HashSet<AssetId<Image>>,
}

/// Shared between the main and render worlds; written by the render world.
#[derive(Resource, Clone, Default)]
pub struct GpuCensus(Arc<Mutex<CensusInner>>);

impl GpuCensus {
    pub fn latest(&self) -> GpuSample {
        self.0.lock().expect("census lock").latest
    }

    pub fn peak(&self) -> GpuSample {
        self.0.lock().expect("census lock").peak
    }

    pub fn baseline(&self) -> Option<GpuSample> {
        self.0.lock().expect("census lock").baseline
    }

    pub fn frames(&self) -> u64 {
        self.0.lock().expect("census lock").frames
    }

    /// Take the next render frame's sample as the empty-scene baseline.
    pub fn arm_baseline(&self) {
        self.0.lock().expect("census lock").arm_baseline = true;
    }

    /// Block the render thread on device completion before the next sample,
    /// so a post-eviction reading reflects retired allocations rather than
    /// frees still queued behind in-flight submissions.
    pub fn request_device_poll(&self) {
        self.0.lock().expect("census lock").poll_pending = true;
    }

    /// Publish the asset ids of the map's material textures. Without this the
    /// render world cannot tell a transcoded map texture from a LUT, and the
    /// two categories would collapse into one.
    pub fn set_map_images(&self, images: HashSet<AssetId<Image>>) {
        self.0.lock().expect("census lock").map_images = images;
    }

    /// Forget accumulated peaks; used when the device is recreated.
    pub fn reset_peak(&self) {
        let mut inner = self.0.lock().expect("census lock");
        inner.peak = GpuSample::default();
    }
}

/// Shape of one GPU texture, read back from the `wgpu::Texture` that was
/// actually created rather than from the `Image` asset that asked for it:
/// the KTX2 transcode target, mip count and format are decided inside the
/// loader, and the asset's own idea of its size is what produced the gap
/// this module exists to explain.
#[derive(Clone, Copy, Debug)]
struct TextureShape {
    width: u32,
    height: u32,
    /// Array layers for a 2d texture, depth for a 3d one.
    layers: u32,
    mips: u32,
    samples: u32,
    volume: bool,
    format: TextureFormat,
}

impl TextureShape {
    fn of(texture: &bevy::render::render_resource::Texture) -> Self {
        let size = texture.size();
        Self {
            width: size.width,
            height: size.height,
            layers: size.depth_or_array_layers,
            mips: texture.mip_level_count(),
            samples: texture.sample_count(),
            volume: texture.dimension() == TextureDimension::D3,
            format: texture.format(),
        }
    }
}

/// Bytes a texture occupies: block-compressed formats charge per block, and
/// every mip level counts.
fn texture_bytes(shape: TextureShape) -> u64 {
    let (block_width, block_height) = shape.format.block_dimensions();
    // A format whose copy size depends on the aspect asked for — combined
    // depth-stencil, multi-planar — has no single byte size. Those are
    // render targets rather than assets, and belong in the non-asset
    // residual instead of being guessed at here.
    let Some(block_bytes) = shape.format.block_copy_size(None) else { return 0 };
    let mut total = 0u64;
    for level in 0..shape.mips {
        let width = (shape.width >> level).max(1);
        let height = (shape.height >> level).max(1);
        let depth = if shape.volume { (shape.layers >> level).max(1) } else { shape.layers.max(1) };
        let blocks_x = u64::from(width.div_ceil(block_width));
        let blocks_y = u64::from(height.div_ceil(block_height));
        total += blocks_x * blocks_y * u64::from(depth) * u64::from(block_bytes) * u64::from(shape.samples.max(1));
    }
    total
}

pub struct MemoryCensusPlugin;

impl Plugin for MemoryCensusPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GpuCensus>();
    }

    fn finish(&self, app: &mut App) {
        let census = app.world().resource::<GpuCensus>().clone();
        let Some(render_app) = app.get_sub_app_mut(RenderApp) else { return };
        render_app
            .insert_resource(census)
            .add_systems(Render, sample_census.after(RenderSystems::Render));
    }
}

fn sample_census(
    census: Res<GpuCensus>,
    device: Res<RenderDevice>,
    mesh_allocator: Res<MeshAllocator>,
    images: Res<RenderAssets<GpuImage>>,
    directional: Query<&ExtractedDirectionalLight>,
    point: Query<&ExtractedPointLight>,
) {
    let mut inner = census.0.lock().expect("census lock");
    if std::mem::take(&mut inner.poll_pending) {
        // `PollType::Wait` returns once every submission has completed, which
        // is when wgpu drops the resources whose last reference went away.
        let _ = device.wgpu_device().poll(PollType::wait_indefinitely());
    }
    let counters = device.wgpu_device().get_internal_counters().hal;
    let mut map_texture_bytes = 0u64;
    let mut map_textures = 0u64;
    let mut other_texture_bytes = 0u64;
    let mut other_textures = 0u64;
    for (id, image) in images.iter() {
        let bytes = texture_bytes(TextureShape::of(&image.texture));
        if inner.map_images.contains(&id) {
            map_texture_bytes += bytes;
            map_textures += 1;
        } else {
            other_texture_bytes += bytes;
            other_textures += 1;
        }
    }
    inner.frames += 1;
    let sample = GpuSample {
        frame: inner.frames,
        wgpu_buffer_bytes: counters.buffer_memory.read() as u64,
        wgpu_texture_bytes: counters.texture_memory.read() as u64,
        wgpu_allocations: counters.memory_allocations.read() as u64,
        mesh_slab_bytes: mesh_allocator.slabs_size(),
        mesh_slab_count: mesh_allocator.slab_count() as u64,
        map_texture_bytes,
        map_textures,
        other_texture_bytes,
        other_textures,
        shadow_casting_lights: (directional.iter().filter(|light| light.shadow_maps_enabled).count()
            + point.iter().filter(|light| light.shadow_maps_enabled).count()) as u64,
    };
    inner.latest = sample;
    if sample.wgpu_total() > inner.peak.wgpu_total() {
        inner.peak = sample;
    }
    if std::mem::take(&mut inner.arm_baseline) {
        inner.baseline = Some(sample);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::render::render_resource::TextureFormat;

    fn shape(width: u32, height: u32, layers: u32, mips: u32, format: TextureFormat, volume: bool) -> TextureShape {
        TextureShape { width, height, layers, mips, samples: 1, volume, format }
    }

    #[test]
    fn block_compressed_mip_chain_is_charged_per_block() {
        // The gap this whole module exists to explain: a 1024x1024 BC7 map
        // texture with a full mip chain is 1,398,128 bytes on the GPU,
        // whatever the KTX2 file happened to weigh. The tail levels each
        // still cost one whole 4x4 block, which is why it is not 4/3 of
        // level 0 exactly.
        let bytes = texture_bytes(shape(1024, 1024, 1, 11, TextureFormat::Bc7RgbaUnormSrgb, false));
        assert_eq!(bytes, 1_398_128);
        // Level 0 alone is 1 byte per pixel for BC7; the chain adds a third.
        let level0 = texture_bytes(shape(1024, 1024, 1, 1, TextureFormat::Bc7RgbaUnormSrgb, false));
        assert_eq!(level0, 1024 * 1024);
        assert!(bytes > level0);
    }

    #[test]
    fn array_layers_and_volume_mips_differ() {
        // An array texture keeps every layer at each mip; a 3d texture halves
        // depth too. Charging an array as a volume under-counts the LUTs.
        let array = texture_bytes(shape(4, 4, 6, 1, TextureFormat::Rgba8Unorm, false));
        assert_eq!(array, 4 * 4 * 6 * 4);
        let volume = texture_bytes(shape(4, 4, 4, 3, TextureFormat::Rgba8Unorm, true));
        assert_eq!(volume, (4 * 4 * 4 + 2 * 2 * 2 + 1) * 4);
    }

    #[test]
    fn aspect_dependent_formats_are_left_to_the_non_asset_residual() {
        // A plain depth format has one byte size and is charged; a combined
        // depth-stencil format does not, and guessing one would put a
        // modelled number into a ledger whose whole claim is that it is
        // measured.
        assert_eq!(texture_bytes(shape(1600, 1000, 1, 1, TextureFormat::Depth32Float, false)), 1600 * 1000 * 4);
        assert_eq!(texture_bytes(shape(1600, 1000, 1, 1, TextureFormat::Depth24PlusStencil8, false)), 0);
    }

    #[test]
    fn derived_categories_never_underflow_below_their_parts() {
        let sample = GpuSample {
            wgpu_buffer_bytes: 100,
            wgpu_texture_bytes: 500,
            mesh_slab_bytes: 140,
            map_texture_bytes: 400,
            other_texture_bytes: 200,
            ..GpuSample::default()
        };
        // A slab total above the hal buffer figure means the two ledgers
        // disagree; the census must report zero rather than wrap.
        assert_eq!(sample.transient_buffer_bytes(), 0);
        assert_eq!(sample.non_asset_texture_bytes(), 0);
        assert_eq!(sample.wgpu_total(), 600);
    }
}
