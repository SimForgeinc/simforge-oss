//! Linux NVIDIA Vulkan → CUDA external-memory bridge for sensor outputs.
//!
//! This module owns *only* the exportable output side of the renderer:
//!
//! * dedicated, exportable `VkDeviceMemory` + `VkBuffer` slots wrapped into
//!   `wgpu::Buffer`s so ordinary `copy_texture_to_buffer` (and future compute
//!   conversion passes) can target them through wgpu's tracked API;
//! * one exportable *ready* and one exportable *release* timeline semaphore per
//!   slot (opaque-fd handles, reference semantics) — the renderer signals
//!   `ready = generation` on the submission that fills the slot, the consumer
//!   signals `release = generation` on its CUDA stream(s) after its kernels
//!   finished reading, and the renderer never rewrites a slot before that
//!   release has landed (`vkGetSemaphoreCounterValue` / `vkWaitSemaphores`);
//! * bounded, generation-tagged leases: a stream has `K` slots; when all `K`
//!   are outstanding `acquire` either waits (backpressure) or reports it, it
//!   never overwrites or frees a leased slot;
//! * real same-host handle export (`vkGetMemoryFdKHR` / `vkGetSemaphoreFdKHR`)
//!   transferred as file descriptors (in-process, or over a Unix socket with
//!   `SCM_RIGHTS`) together with a JSON manifest carrying the physical-device
//!   UUID so the consumer imports on the *same* GPU. No pointer integers are
//!   ever transmitted.
//!
//! The data path is an honest GPU-local copy (render target → linear buffer
//! with wgpu's 256-byte row alignment); it is not "zero copy", but it never
//! stages pixels through host memory. Row strides are published so consumers
//! build strided tensors directly (odd widths are fine).
//!
//! Unsupported hardware (non-Vulkan backend, non-NVIDIA device, missing
//! `VK_KHR_external_memory_fd` / `VK_KHR_external_semaphore_fd`, no Vulkan 1.2
//! timeline semaphores, non-exportable opaque-fd handle types) fails
//! [`GpuInterop::new`] / [`GpuInterop::probe`] with an explicit
//! [`InteropError::Unsupported`]; there is no reduced-functionality mode here.
//!
//! # Integration contract (renderer owner)
//!
//! 1. Before `DefaultPlugins`: `app.insert_resource(raw_vulkan_init_settings())`
//!    (requires the `bevy/raw_vulkan_init` cargo feature). This enables the
//!    external-semaphore/memory fd extensions at device creation when the
//!    physical device supports them; wgpu-hal already enables
//!    `VK_KHR_timeline_semaphore`/1.2 timeline features.
//! 2. In the render world, once `RenderDevice`/`RenderQueue` exist:
//!    `GpuInterop::new(&device, &queue)` → insert as a resource. Failure is a
//!    capability rejection; keep the host staging path for that host.
//! 3. Per camera/pass set: `create_stream(StreamDescriptor)` describing planes
//!    (name + extent + format) and the slot count; `export_stream` to hand the
//!    manifest + fds to the consumer.
//! 4. Per capture: `acquire` → call `encode_copy` for each plane into an
//!    encoder → either `arm_ready(lease)` when that encoder is the render
//!    graph's `RenderContext::command_encoder()` (submitted by Bevy's
//!    `RenderGraphSystems::Submit` right after), or
//!    `submit_ready(lease, [encoder.finish()])` for a private encoder. Both
//!    bind the ready signal to the submission carrying the copies and require
//!    that no other queue submission slips in between. Publish the
//!    returned [`ReadyFrame`] on the control channel together with the frame
//!    identity (snapshot/tick/rig revision). If capture is abandoned after
//!    acquire, `cancel(lease)`.
//! 5. Resize/reset/camera removal: `destroy_stream(id, grace)`; it waits up to
//!    `grace` for outstanding consumer releases, then drops the wgpu buffers,
//!    drains the device and frees memory/semaphores. Consumers still holding an
//!    import keep the underlying allocation alive through their own reference
//!    (opaque-fd reference transference); the renderer merely stops writing.

use std::collections::HashMap;
use std::ffi::CStr;
use std::fmt;
use std::io::{self, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use ash::{khr, vk};
use bevy::prelude::Resource;
use bevy::render::renderer::raw_vulkan_init::{AdditionalVulkanFeatures, RawVulkanInitSettings};
use bevy::render::renderer::{RenderDevice, RenderQueue};
use serde::{Deserialize, Serialize};
use wgpu::hal::api::Vulkan;

/// Manifest/handle protocol version understood by `simforge_native.gpu`.
pub const PROTOCOL: &str = "simforge-gpu-interop/1";
/// Frame prefix for [`ExportedStream::send_over_unix`].
pub const WIRE_MAGIC: &[u8; 4] = b"SFGX";
/// Handles per slot in export order: memory, ready, release.
pub const HANDLES_PER_SLOT: usize = 3;
/// Linux `SCM_MAX_FD`; one export message carries every slot handle.
pub const SCM_MAX_FD: usize = 253;
/// Largest slot count exportable in one message.
pub const MAX_SLOTS: usize = SCM_MAX_FD / HANDLES_PER_SLOT;

/// Plane offsets are aligned to this so any plane is a valid copy destination.
const PLANE_ALIGN: u64 = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as u64;
const NVIDIA_VENDOR_ID: u32 = 0x10DE;
const HANDLE_TYPE_MEM: vk::ExternalMemoryHandleTypeFlags = vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD;
const HANDLE_TYPE_SEM: vk::ExternalSemaphoreHandleTypeFlags =
    vk::ExternalSemaphoreHandleTypeFlags::OPAQUE_FD;
const VK_USAGE: vk::BufferUsageFlags = vk::BufferUsageFlags::from_raw(
    vk::BufferUsageFlags::TRANSFER_DST.as_raw()
        | vk::BufferUsageFlags::TRANSFER_SRC.as_raw()
        | vk::BufferUsageFlags::STORAGE_BUFFER.as_raw(),
);
const WGPU_USAGE: wgpu::BufferUsages = wgpu::BufferUsages::COPY_DST
    .union(wgpu::BufferUsages::COPY_SRC)
    .union(wgpu::BufferUsages::STORAGE);

// ----------------------------------------------------------------------------
// Errors

#[derive(Debug)]
pub enum InteropError {
    /// The wgpu device is not backed by the Vulkan HAL.
    NotVulkan,
    /// Capability check failed; the message names the missing requirement.
    Unsupported(String),
    /// A Vulkan entry point failed.
    Vulkan { what: &'static str, code: vk::Result },
    /// Descriptor rejected (empty planes, zero extent, too many slots, ...).
    InvalidDescriptor(String),
    UnknownStream(StreamId),
    UnknownPlane { stream: StreamId, plane: String },
    /// A lease was used out of order (e.g. `submit_ready` after `cancel`).
    LeaseState { stream: StreamId, slot: u32, generation: u64, expected: &'static str },
    /// Copy extent or format does not match the plane layout.
    PlaneMismatch { plane: String, detail: String },
    /// Every slot is outstanding; nothing was released within the wait.
    Backpressure { stream: StreamId, waited: Duration },
    Io(io::Error),
}

impl fmt::Display for InteropError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotVulkan => write!(f, "render device is not a Vulkan device"),
            Self::Unsupported(why) => write!(f, "GPU interop unsupported: {why}"),
            Self::Vulkan { what, code } => write!(f, "{what} failed: {code:?}"),
            Self::InvalidDescriptor(why) => write!(f, "invalid stream descriptor: {why}"),
            Self::UnknownStream(id) => write!(f, "unknown interop stream {}", id.0),
            Self::UnknownPlane { stream, plane } => {
                write!(f, "stream {} has no plane {plane:?}", stream.0)
            }
            Self::LeaseState { stream, slot, generation, expected } => write!(
                f,
                "stream {} slot {slot} generation {generation}: expected state {expected}",
                stream.0
            ),
            Self::PlaneMismatch { plane, detail } => write!(f, "plane {plane:?}: {detail}"),
            Self::Backpressure { stream, waited } => write!(
                f,
                "stream {}: all slots leased, none released within {waited:?}",
                stream.0
            ),
            Self::Io(e) => write!(f, "handle transfer failed: {e}"),
        }
    }
}

impl std::error::Error for InteropError {}

impl From<io::Error> for InteropError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

fn vk_err(what: &'static str) -> impl FnOnce(vk::Result) -> InteropError {
    move |code| InteropError::Vulkan { what, code }
}

// ----------------------------------------------------------------------------
// Identity / capabilities

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceIdentity {
    pub device_name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    /// `VkPhysicalDeviceProperties::apiVersion` (packed).
    pub api_version: u32,
    pub driver_version: u32,
    /// `VkPhysicalDeviceIDProperties::deviceUUID`, lowercase hex, no dashes.
    /// Equals the bytes returned by `cuDeviceGetUuid` for the same GPU.
    pub device_uuid: String,
    pub driver_uuid: String,
}

#[derive(Clone, Debug)]
pub struct InteropCapabilities {
    pub identity: DeviceIdentity,
    pub queue_family_index: u32,
    /// Driver requires dedicated allocations for exportable buffers. We always
    /// allocate dedicated, so this is informational.
    pub dedicated_only: bool,
}

/// Marker inserted into [`AdditionalVulkanFeatures`] when the fd extensions
/// were enabled at device creation.
pub struct ExternalHandlesEnabled;

/// Settings to insert into the `App` before `DefaultPlugins` so device creation
/// enables the external memory/semaphore fd extensions where supported.
pub fn raw_vulkan_init_settings() -> RawVulkanInitSettings {
    let mut settings = RawVulkanInitSettings::default();
    // SAFETY: the callback only appends extensions the physical device
    // reports as supported and never removes or disables anything.
    unsafe {
        settings.add_create_device_callback(|args: &mut wgpu::hal::vulkan::CreateDeviceCallbackArgs<'_, '_, '_>, adapter: &wgpu::hal::vulkan::Adapter, features: &mut AdditionalVulkanFeatures| {
            let caps = adapter.physical_device_capabilities();
            let wanted: [&'static CStr; 2] =
                [khr::external_memory_fd::NAME, khr::external_semaphore_fd::NAME];
            let mut all = true;
            for ext in wanted {
                if caps.supports_extension(ext) {
                    if !args.extensions.contains(&ext) {
                        args.extensions.push(ext);
                    }
                } else {
                    all = false;
                }
            }
            if all {
                features.insert::<ExternalHandlesEnabled>();
            }
        });
    }
    settings
}

// ----------------------------------------------------------------------------
// Plane / stream description

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaneFormat {
    Rgba8Unorm,
    Rgba8UnormSrgb,
    Bgra8Unorm,
    Bgra8UnormSrgb,
    Rgba16Float,
    Rgba32Float,
    R32Float,
    R32Uint,
    R16Float,
    Depth32Float,
}

impl PlaneFormat {
    pub fn from_texture_format(format: wgpu::TextureFormat) -> Option<Self> {
        use wgpu::TextureFormat as T;
        Some(match format {
            T::Rgba8Unorm => Self::Rgba8Unorm,
            T::Rgba8UnormSrgb => Self::Rgba8UnormSrgb,
            T::Bgra8Unorm => Self::Bgra8Unorm,
            T::Bgra8UnormSrgb => Self::Bgra8UnormSrgb,
            T::Rgba16Float => Self::Rgba16Float,
            T::Rgba32Float => Self::Rgba32Float,
            T::R32Float => Self::R32Float,
            T::R32Uint => Self::R32Uint,
            T::R16Float => Self::R16Float,
            T::Depth32Float => Self::Depth32Float,
            _ => return None,
        })
    }

    pub fn texture_format(self) -> wgpu::TextureFormat {
        use wgpu::TextureFormat as T;
        match self {
            Self::Rgba8Unorm => T::Rgba8Unorm,
            Self::Rgba8UnormSrgb => T::Rgba8UnormSrgb,
            Self::Bgra8Unorm => T::Bgra8Unorm,
            Self::Bgra8UnormSrgb => T::Bgra8UnormSrgb,
            Self::Rgba16Float => T::Rgba16Float,
            Self::Rgba32Float => T::Rgba32Float,
            Self::R32Float => T::R32Float,
            Self::R32Uint => T::R32Uint,
            Self::R16Float => T::R16Float,
            Self::Depth32Float => T::Depth32Float,
        }
    }

    /// (`numpy`/CUDA-array-interface typestr, channels, bytes per pixel).
    pub fn element(self) -> (&'static str, u32, u32) {
        match self {
            Self::Rgba8Unorm | Self::Rgba8UnormSrgb | Self::Bgra8Unorm | Self::Bgra8UnormSrgb => {
                ("|u1", 4, 4)
            }
            Self::Rgba16Float => ("<f2", 4, 8),
            Self::Rgba32Float => ("<f4", 4, 16),
            Self::R32Float | Self::Depth32Float => ("<f4", 1, 4),
            Self::R32Uint => ("<u4", 1, 4),
            Self::R16Float => ("<f2", 1, 2),
        }
    }
}

#[derive(Clone, Debug)]
pub struct PlaneDescriptor {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub format: PlaneFormat,
}

#[derive(Clone, Debug)]
pub struct StreamDescriptor {
    pub label: String,
    /// Number of independently leasable output slots (bounded backpressure).
    pub slots: usize,
    pub planes: Vec<PlaneDescriptor>,
}

/// Resolved byte layout of one plane inside every slot of a stream.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaneLayout {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub format: PlaneFormat,
    /// numpy-style typestr of one channel (`|u1`, `<f4`, `<u4`, `<f2`).
    pub dtype: String,
    pub channels: u32,
    pub pixel_bytes: u32,
    /// Byte offset of row 0 inside the slot allocation.
    pub offset: u64,
    /// Bytes between consecutive rows (256-byte aligned copy stride).
    pub row_stride: u32,
    /// `row_stride * height`.
    pub bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StreamId(pub u64);

/// Manifest accompanying exported handles. Serialized as JSON for the
/// consumer (`simforge_native.gpu.ImportedStream`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StreamManifest {
    pub protocol: String,
    pub stream_id: StreamId,
    pub label: String,
    pub device: DeviceIdentity,
    pub slots: u32,
    /// Bytes addressed by the wgpu buffer (sum of aligned plane sizes).
    pub slot_bytes: u64,
    /// Bytes of the dedicated allocation backing each slot (>= `slot_bytes`);
    /// this is the size the consumer must pass to `cuImportExternalMemory`.
    pub allocation_bytes: u64,
    pub dedicated: bool,
    /// Handle order per slot within the exported fd list.
    pub handle_order: [String; HANDLES_PER_SLOT],
    pub planes: Vec<PlaneLayout>,
}

/// Identity of one filled slot, published on the control channel after
/// [`GpuInterop::submit_ready`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyFrame {
    pub stream_id: StreamId,
    pub slot: u32,
    pub generation: u64,
}

/// An acquired slot that has not been submitted or cancelled yet.
#[must_use = "a lease must be finished with submit_ready or cancel"]
#[derive(Debug)]
pub struct SlotLease {
    stream: StreamId,
    slot: u32,
    generation: u64,
}

impl SlotLease {
    pub fn stream(&self) -> StreamId {
        self.stream
    }
    pub fn slot(&self) -> u32 {
        self.slot
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StreamTeardown {
    /// Published slots whose consumer release had not landed when the grace
    /// period expired. Their memory stays valid for the consumer through its
    /// own import; the producer simply stopped writing.
    pub outstanding_consumer_leases: usize,
    /// Slots acquired by the producer but never submitted or cancelled.
    pub abandoned_producer_leases: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotStatus {
    Free,
    /// Acquired by the producer, not yet submitted.
    Leased { generation: u64 },
    /// Ready signal submitted; waiting for consumer release.
    Published { generation: u64, released: bool },
}

// ----------------------------------------------------------------------------
// Internal state

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SlotState {
    Free,
    Leased(u64),
    Published(u64),
}

struct Slot {
    memory: vk::DeviceMemory,
    allocation_bytes: u64,
    /// `None` only during teardown.
    buffer: Option<wgpu::Buffer>,
    ready: vk::Semaphore,
    release: vk::Semaphore,
    generation: u64,
    state: SlotState,
}

struct Stream {
    label: String,
    planes: Vec<PlaneLayout>,
    slot_bytes: u64,
    slots: Vec<Slot>,
}

struct Raw {
    instance: ash::Instance,
    device: ash::Device,
    physical: vk::PhysicalDevice,
    memory_props: vk::PhysicalDeviceMemoryProperties,
    ext_mem_fd: khr::external_memory_fd::Device,
    ext_sem_fd: khr::external_semaphore_fd::Device,
}

/// Render-world resource owning every exportable output stream.
#[derive(Resource)]
pub struct GpuInterop {
    device: RenderDevice,
    queue: RenderQueue,
    raw: Raw,
    caps: InteropCapabilities,
    streams: HashMap<StreamId, Stream>,
    next_stream: u64,
}

// ----------------------------------------------------------------------------
// Construction / capability probe

impl GpuInterop {
    /// Capability check only; does not allocate.
    pub fn probe(device: &RenderDevice) -> Result<InteropCapabilities, InteropError> {
        open_raw(device).map(|(_, caps)| caps)
    }

    pub fn new(device: &RenderDevice, queue: &RenderQueue) -> Result<Self, InteropError> {
        let (raw, caps) = open_raw(device)?;
        Ok(Self {
            device: device.clone(),
            queue: queue.clone(),
            raw,
            caps,
            streams: HashMap::new(),
            next_stream: 1,
        })
    }

    pub fn capabilities(&self) -> &InteropCapabilities {
        &self.caps
    }

    /// Resolve the plane layout a descriptor would produce (no allocation).
    pub fn layout(desc: &StreamDescriptor) -> Result<(Vec<PlaneLayout>, u64), InteropError> {
        if desc.planes.is_empty() {
            return Err(InteropError::InvalidDescriptor("no planes".into()));
        }
        if desc.slots == 0 || desc.slots > MAX_SLOTS {
            return Err(InteropError::InvalidDescriptor(format!(
                "slots must be in 1..={MAX_SLOTS}, got {}",
                desc.slots
            )));
        }
        let mut offset = 0u64;
        let mut planes = Vec::with_capacity(desc.planes.len());
        for p in &desc.planes {
            if p.width == 0 || p.height == 0 {
                return Err(InteropError::InvalidDescriptor(format!(
                    "plane {:?} has zero extent",
                    p.name
                )));
            }
            if planes.iter().any(|l: &PlaneLayout| l.name == p.name) {
                return Err(InteropError::InvalidDescriptor(format!(
                    "duplicate plane name {:?}",
                    p.name
                )));
            }
            let (dtype, channels, pixel_bytes) = p.format.element();
            let row_stride =
                RenderDevice::align_copy_bytes_per_row(p.width as usize * pixel_bytes as usize)
                    as u32;
            let bytes = row_stride as u64 * p.height as u64;
            planes.push(PlaneLayout {
                name: p.name.clone(),
                width: p.width,
                height: p.height,
                format: p.format,
                dtype: dtype.to_owned(),
                channels,
                pixel_bytes,
                offset,
                row_stride,
                bytes,
            });
            offset = (offset + bytes).div_ceil(PLANE_ALIGN) * PLANE_ALIGN;
        }
        Ok((planes, offset))
    }
}

fn open_raw(device: &RenderDevice) -> Result<(Raw, InteropCapabilities), InteropError> {
    let wgpu_device = device.wgpu_device();
    // SAFETY: we only read handles/loaders from the guard and clone the ash
    // dispatch tables; the underlying VkDevice outlives us because we keep a
    // `RenderDevice` clone alive for as long as `GpuInterop` exists.
    let hal = unsafe { wgpu_device.as_hal::<Vulkan>() }.ok_or(InteropError::NotVulkan)?;
    let shared = hal.shared_instance();
    if shared.instance_api_version() < vk::API_VERSION_1_1 {
        return Err(InteropError::Unsupported(
            "Vulkan instance < 1.1 (external capability queries unavailable)".into(),
        ));
    }
    let enabled = hal.enabled_device_extensions();
    for (ext, label) in [
        (khr::external_memory_fd::NAME, "VK_KHR_external_memory_fd"),
        (khr::external_semaphore_fd::NAME, "VK_KHR_external_semaphore_fd"),
    ] {
        if !enabled.contains(&ext) {
            return Err(InteropError::Unsupported(format!(
                "{label} not enabled on the device (device unsupported, or \
                 raw_vulkan_init_settings() was not installed before RenderPlugin)"
            )));
        }
    }
    let instance = shared.raw_instance().clone();
    let raw_device = hal.raw_device().clone();
    let physical = hal.raw_physical_device();
    let queue_family_index = hal.queue_family_index();
    drop(hal);

    let mut id_props = vk::PhysicalDeviceIDProperties::default();
    let props = {
        let mut props2 = vk::PhysicalDeviceProperties2::default().push_next(&mut id_props);
        // SAFETY: valid physical device from the live instance; instance >= 1.1.
        unsafe { instance.get_physical_device_properties2(physical, &mut props2) };
        props2.properties
    };
    if props.vendor_id != NVIDIA_VENDOR_ID {
        return Err(InteropError::Unsupported(format!(
            "CUDA import needs an NVIDIA device; found vendor {:#06x}",
            props.vendor_id
        )));
    }
    if props.api_version < vk::API_VERSION_1_2 {
        return Err(InteropError::Unsupported(format!(
            "device Vulkan {}.{} < 1.2 (timeline semaphores)",
            vk::api_version_major(props.api_version),
            vk::api_version_minor(props.api_version)
        )));
    }

    let mem_props = {
        let info = vk::PhysicalDeviceExternalBufferInfo::default()
            .usage(VK_USAGE)
            .handle_type(HANDLE_TYPE_MEM);
        let mut out = vk::ExternalBufferProperties::default();
        // SAFETY: valid physical device and fully initialised query structs.
        unsafe { instance.get_physical_device_external_buffer_properties(physical, &info, &mut out) };
        out.external_memory_properties
    };
    if !mem_props
        .external_memory_features
        .contains(vk::ExternalMemoryFeatureFlags::EXPORTABLE)
        || !mem_props.compatible_handle_types.contains(HANDLE_TYPE_MEM)
    {
        return Err(InteropError::Unsupported(
            "opaque-fd export of TRANSFER_DST|STORAGE buffers not supported".into(),
        ));
    }
    let dedicated_only = mem_props
        .external_memory_features
        .contains(vk::ExternalMemoryFeatureFlags::DEDICATED_ONLY);

    let sem_props = {
        let mut ty = vk::SemaphoreTypeCreateInfo::default().semaphore_type(vk::SemaphoreType::TIMELINE);
        let info = vk::PhysicalDeviceExternalSemaphoreInfo::default()
            .handle_type(HANDLE_TYPE_SEM)
            .push_next(&mut ty);
        let mut out = vk::ExternalSemaphoreProperties::default();
        // SAFETY: as above.
        unsafe {
            instance.get_physical_device_external_semaphore_properties(physical, &info, &mut out)
        };
        out
    };
    if !sem_props
        .external_semaphore_features
        .contains(vk::ExternalSemaphoreFeatureFlags::EXPORTABLE)
        || !sem_props.compatible_handle_types.contains(HANDLE_TYPE_SEM)
    {
        return Err(InteropError::Unsupported(
            "opaque-fd export of timeline semaphores not supported".into(),
        ));
    }

    // SAFETY: valid physical device.
    let memory_props = unsafe { instance.get_physical_device_memory_properties(physical) };
    let ext_mem_fd = khr::external_memory_fd::Device::new(&instance, &raw_device);
    let ext_sem_fd = khr::external_semaphore_fd::Device::new(&instance, &raw_device);

    let identity = DeviceIdentity {
        device_name: props
            .device_name_as_c_str()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        vendor_id: props.vendor_id,
        device_id: props.device_id,
        api_version: props.api_version,
        driver_version: props.driver_version,
        device_uuid: hex16(&id_props.device_uuid),
        driver_uuid: hex16(&id_props.driver_uuid),
    };
    Ok((
        Raw {
            instance,
            device: raw_device,
            physical,
            memory_props,
            ext_mem_fd,
            ext_sem_fd,
        },
        InteropCapabilities {
            identity,
            queue_family_index,
            dedicated_only,
        },
    ))
}

fn hex16(bytes: &[u8; 16]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(32);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn pick_memory_type(props: &vk::PhysicalDeviceMemoryProperties, type_bits: u32) -> Option<u32> {
    let types = &props.memory_types[..props.memory_type_count as usize];
    let mut fallback = None;
    for (i, t) in types.iter().enumerate() {
        if type_bits & (1u32 << i) == 0 {
            continue;
        }
        let f = t.property_flags;
        if !f.contains(vk::MemoryPropertyFlags::DEVICE_LOCAL) {
            continue;
        }
        if !f.contains(vk::MemoryPropertyFlags::HOST_VISIBLE) {
            return Some(i as u32);
        }
        fallback.get_or_insert(i as u32);
    }
    fallback
}

// ----------------------------------------------------------------------------
// Stream lifecycle

impl GpuInterop {
    pub fn create_stream(&mut self, desc: &StreamDescriptor) -> Result<StreamId, InteropError> {
        let (planes, slot_bytes) = Self::layout(desc)?;
        let id = StreamId(self.next_stream);
        let mut slots: Vec<Slot> = Vec::with_capacity(desc.slots);
        let mut result = Ok(());
        for i in 0..desc.slots {
            match self.create_slot(&format!("{}[{i}]", desc.label), slot_bytes) {
                Ok(slot) => slots.push(slot),
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }
        if let Err(e) = result {
            // Nothing was submitted yet: buffers are unused, safe to tear down now.
            let stream = Stream { label: desc.label.clone(), planes, slot_bytes, slots };
            self.teardown(stream, Duration::ZERO);
            return Err(e);
        }

        // wgpu requires imported buffers to be initialised; clear them once on
        // the device (this also moves them into a tracked state).
        let mut encoder = self
            .device
            .wgpu_device()
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("gpu-interop-init"),
            });
        for slot in &slots {
            encoder.clear_buffer(slot.buffer.as_ref().expect("fresh slot"), 0, None);
        }
        self.queue.submit(std::iter::once(encoder.finish()));

        self.next_stream += 1;
        self.streams.insert(
            id,
            Stream { label: desc.label.clone(), planes, slot_bytes, slots },
        );
        Ok(id)
    }

    fn create_slot(&self, label: &str, slot_bytes: u64) -> Result<Slot, InteropError> {
        let dev = &self.raw.device;
        let mut ext = vk::ExternalMemoryBufferCreateInfo::default().handle_types(HANDLE_TYPE_MEM);
        let info = vk::BufferCreateInfo::default()
            .size(slot_bytes)
            .usage(VK_USAGE)
            .sharing_mode(vk::SharingMode::EXCLUSIVE)
            .push_next(&mut ext);
        // SAFETY: live device, valid create info.
        let buffer = unsafe { dev.create_buffer(&info, None) }.map_err(vk_err("vkCreateBuffer"))?;

        let mut dedicated_req = vk::MemoryDedicatedRequirements::default();
        let reqs = {
            let mut reqs2 = vk::MemoryRequirements2::default().push_next(&mut dedicated_req);
            let info = vk::BufferMemoryRequirementsInfo2::default().buffer(buffer);
            // SAFETY: `buffer` is a live buffer of `dev`.
            unsafe { dev.get_buffer_memory_requirements2(&info, &mut reqs2) };
            reqs2.memory_requirements
        };
        let Some(type_index) = pick_memory_type(&self.raw.memory_props, reqs.memory_type_bits)
        else {
            // SAFETY: buffer unused and unbound.
            unsafe { dev.destroy_buffer(buffer, None) };
            return Err(InteropError::Unsupported(
                "no DEVICE_LOCAL memory type accepts an exportable buffer".into(),
            ));
        };

        let mut export = vk::ExportMemoryAllocateInfo::default().handle_types(HANDLE_TYPE_MEM);
        let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().buffer(buffer);
        let alloc = vk::MemoryAllocateInfo::default()
            .allocation_size(reqs.size)
            .memory_type_index(type_index)
            .push_next(&mut export)
            .push_next(&mut dedicated);
        // SAFETY: valid allocate info; dedicated allocation for `buffer`.
        let memory = match unsafe { dev.allocate_memory(&alloc, None) } {
            Ok(m) => m,
            Err(code) => {
                unsafe { dev.destroy_buffer(buffer, None) };
                return Err(InteropError::Vulkan { what: "vkAllocateMemory", code });
            }
        };
        // SAFETY: memory was allocated dedicated for this buffer, offset 0.
        if let Err(code) = unsafe { dev.bind_buffer_memory(buffer, memory, 0) } {
            unsafe {
                dev.destroy_buffer(buffer, None);
                dev.free_memory(memory, None);
            }
            return Err(InteropError::Vulkan { what: "vkBindBufferMemory", code });
        }

        let ready = match self.create_timeline() {
            Ok(s) => s,
            Err(e) => {
                // SAFETY: nothing references these objects yet.
                unsafe {
                    dev.destroy_buffer(buffer, None);
                    dev.free_memory(memory, None);
                }
                return Err(e);
            }
        };
        let release = match self.create_timeline() {
            Ok(s) => s,
            Err(e) => {
                // SAFETY: nothing references these objects yet.
                unsafe {
                    dev.destroy_semaphore(ready, None);
                    dev.destroy_buffer(buffer, None);
                    dev.free_memory(memory, None);
                }
                return Err(e);
            }
        };

        // SAFETY: `buffer` was created on exactly this wgpu device's VkDevice with
        // usage matching `WGPU_USAGE`, is bound to caller-managed memory (kept
        // alive by the `Slot`), is non-zero sized, and is cleared before its first
        // tracked use in `create_stream`. wgpu takes over `vkDestroyBuffer`.
        let wgpu_buffer = unsafe {
            let hal_buffer = wgpu::hal::vulkan::Buffer::from_raw(buffer);
            self.device.wgpu_device().create_buffer_from_hal::<Vulkan>(
                hal_buffer,
                &wgpu::BufferDescriptor {
                    label: Some(label),
                    size: slot_bytes,
                    usage: WGPU_USAGE,
                    mapped_at_creation: false,
                },
            )
        };

        Ok(Slot {
            memory,
            allocation_bytes: reqs.size,
            buffer: Some(wgpu_buffer),
            ready,
            release,
            generation: 0,
            state: SlotState::Free,
        })
    }

    fn create_timeline(&self) -> Result<vk::Semaphore, InteropError> {
        let mut ty = vk::SemaphoreTypeCreateInfo::default()
            .semaphore_type(vk::SemaphoreType::TIMELINE)
            .initial_value(0);
        let mut export = vk::ExportSemaphoreCreateInfo::default().handle_types(HANDLE_TYPE_SEM);
        let info = vk::SemaphoreCreateInfo::default()
            .push_next(&mut ty)
            .push_next(&mut export);
        // SAFETY: live device; timeline feature enabled by wgpu-hal on >= 1.2.
        unsafe { self.raw.device.create_semaphore(&info, None) }.map_err(vk_err("vkCreateSemaphore"))
    }

    pub fn streams(&self) -> impl Iterator<Item = StreamId> + '_ {
        self.streams.keys().copied()
    }

    pub fn planes(&self, stream: StreamId) -> Result<&[PlaneLayout], InteropError> {
        Ok(&self.stream(stream)?.planes)
    }

    pub fn plane(&self, stream: StreamId, name: &str) -> Result<&PlaneLayout, InteropError> {
        let s = self.stream(stream)?;
        s.planes
            .iter()
            .find(|p| p.name == name)
            .ok_or_else(|| InteropError::UnknownPlane { stream, plane: name.to_owned() })
    }

    /// Current state of every slot, including whether a published slot's
    /// release has already landed (non-blocking query).
    pub fn slot_status(&self, stream: StreamId) -> Result<Vec<SlotStatus>, InteropError> {
        let s = self.stream(stream)?;
        s.slots
            .iter()
            .map(|slot| {
                Ok(match slot.state {
                    SlotState::Free => SlotStatus::Free,
                    SlotState::Leased(g) => SlotStatus::Leased { generation: g },
                    SlotState::Published(g) => SlotStatus::Published {
                        generation: g,
                        released: self.counter(slot.release)? >= g,
                    },
                })
            })
            .collect()
    }

    /// Tear a stream down. Waits up to `grace` for consumer releases so the
    /// teardown report is meaningful, then drops the wgpu buffers, drains the
    /// device and frees Vulkan objects.
    ///
    /// Must not run between `arm_ready` and the submission that carries the
    /// armed signal (i.e. not between `RenderGraphSystems::Render` and
    /// `Submit` of the same frame): the pending signal would reference a
    /// destroyed semaphore. Any other point in the frame is fine.
    pub fn destroy_stream(
        &mut self,
        stream: StreamId,
        grace: Duration,
    ) -> Result<StreamTeardown, InteropError> {
        let s = self.streams.remove(&stream).ok_or(InteropError::UnknownStream(stream))?;
        Ok(self.teardown(s, grace))
    }

    fn teardown(&mut self, mut s: Stream, grace: Duration) -> StreamTeardown {
        let dev = &self.raw.device;
        let mut report = StreamTeardown::default();

        let published: Vec<(vk::Semaphore, u64)> = s
            .slots
            .iter()
            .filter_map(|slot| match slot.state {
                SlotState::Published(g) => Some((slot.release, g)),
                _ => None,
            })
            .collect();
        if !published.is_empty() && !grace.is_zero() {
            let (sems, vals): (Vec<_>, Vec<_>) = published.iter().copied().unzip();
            let info = vk::SemaphoreWaitInfo::default().semaphores(&sems).values(&vals);
            // SAFETY: live timeline semaphores; TIMEOUT is an expected outcome.
            let _ = unsafe { dev.wait_semaphores(&info, nanos(grace)) };
        }
        for slot in &s.slots {
            match slot.state {
                SlotState::Published(g) => {
                    if self.counter(slot.release).map(|c| c < g).unwrap_or(true) {
                        report.outstanding_consumer_leases += 1;
                    }
                }
                SlotState::Leased(_) => report.abandoned_producer_leases += 1,
                SlotState::Free => {}
            }
        }

        // Drop wgpu's view of the buffers, then let wgpu run its deferred
        // destruction (vkDestroyBuffer) before we free the backing memory.
        for slot in &mut s.slots {
            slot.buffer = None;
        }
        let _ = self.device.wgpu_device().poll(wgpu::PollType::wait_indefinitely());

        for slot in &s.slots {
            // SAFETY: no wgpu buffer references the memory any more (drained
            // above); all queue signals on `ready` completed with that drain; a
            // consumer's import holds its own reference to memory/semaphores.
            unsafe {
                dev.free_memory(slot.memory, None);
                dev.destroy_semaphore(slot.ready, None);
                dev.destroy_semaphore(slot.release, None);
            }
        }
        report
    }

    fn stream(&self, id: StreamId) -> Result<&Stream, InteropError> {
        self.streams.get(&id).ok_or(InteropError::UnknownStream(id))
    }

    fn stream_mut(&mut self, id: StreamId) -> Result<&mut Stream, InteropError> {
        self.streams.get_mut(&id).ok_or(InteropError::UnknownStream(id))
    }

    fn counter(&self, sem: vk::Semaphore) -> Result<u64, InteropError> {
        // SAFETY: live timeline semaphore owned by this instance.
        unsafe { self.raw.device.get_semaphore_counter_value(sem) }
            .map_err(vk_err("vkGetSemaphoreCounterValue"))
    }
}

fn nanos(d: Duration) -> u64 {
    d.as_nanos().min(u64::MAX as u128) as u64
}

// ----------------------------------------------------------------------------
// Leases

impl GpuInterop {
    /// Take the next free slot. A slot is free when it was never published or
    /// when its consumer release counter reached its last generation. With
    /// `wait = Some(d)` the call blocks the calling thread up to `d` for any
    /// outstanding release (bounded backpressure); otherwise it fails fast.
    pub fn acquire(
        &mut self,
        stream: StreamId,
        wait: Option<Duration>,
    ) -> Result<SlotLease, InteropError> {
        if let Some(lease) = self.take_free(stream)? {
            return Ok(lease);
        }
        let Some(wait) = wait else {
            return Err(InteropError::Backpressure { stream, waited: Duration::ZERO });
        };
        let (sems, vals): (Vec<_>, Vec<_>) = self
            .stream(stream)?
            .slots
            .iter()
            .filter_map(|slot| match slot.state {
                SlotState::Published(g) => Some((slot.release, g)),
                _ => None,
            })
            .unzip();
        if sems.is_empty() {
            // Every slot is held by the producer itself (acquired, never
            // submitted/cancelled); waiting cannot help.
            return Err(InteropError::Backpressure { stream, waited: Duration::ZERO });
        }
        let info = vk::SemaphoreWaitInfo::default()
            .flags(vk::SemaphoreWaitFlags::ANY)
            .semaphores(&sems)
            .values(&vals);
        // SAFETY: live timeline semaphores of this device.
        match unsafe { self.raw.device.wait_semaphores(&info, nanos(wait)) } {
            Ok(()) => {}
            Err(vk::Result::TIMEOUT) => {
                return Err(InteropError::Backpressure { stream, waited: wait });
            }
            Err(code) => return Err(InteropError::Vulkan { what: "vkWaitSemaphores", code }),
        }
        self.take_free(stream)?
            .ok_or(InteropError::Backpressure { stream, waited: wait })
    }

    fn take_free(&mut self, stream: StreamId) -> Result<Option<SlotLease>, InteropError> {
        let dev = &self.raw.device;
        let s = self.streams.get_mut(&stream).ok_or(InteropError::UnknownStream(stream))?;
        for (i, slot) in s.slots.iter_mut().enumerate() {
            let free = match slot.state {
                SlotState::Free => true,
                SlotState::Leased(_) => false,
                SlotState::Published(g) => {
                    // SAFETY: live timeline semaphore.
                    let c = unsafe { dev.get_semaphore_counter_value(slot.release) }
                        .map_err(vk_err("vkGetSemaphoreCounterValue"))?;
                    c >= g
                }
            };
            if free {
                slot.generation += 1;
                slot.state = SlotState::Leased(slot.generation);
                return Ok(Some(SlotLease { stream, slot: i as u32, generation: slot.generation }));
            }
        }
        Ok(None)
    }

    /// The wgpu buffer backing a leased slot (for compute conversion passes
    /// that write planes directly instead of `encode_copy`).
    pub fn slot_buffer(&self, lease: &SlotLease) -> Result<&wgpu::Buffer, InteropError> {
        let slot = self.leased_slot(lease)?;
        Ok(slot.buffer.as_ref().expect("live slot"))
    }

    /// Record a GPU-local copy of `src` (full mip 0 of a 2D texture whose
    /// extent/format matches the plane) into the plane of the leased slot.
    pub fn encode_copy(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        lease: &SlotLease,
        plane: &str,
        src: wgpu::TexelCopyTextureInfo<'_>,
    ) -> Result<(), InteropError> {
        let s = self.stream(lease.stream)?;
        let layout = s
            .planes
            .iter()
            .find(|p| p.name == plane)
            .ok_or_else(|| InteropError::UnknownPlane { stream: lease.stream, plane: plane.to_owned() })?;
        let slot = self.leased_slot(lease)?;
        let size = src.texture.size();
        if size.width != layout.width || size.height != layout.height || size.depth_or_array_layers != 1
        {
            return Err(InteropError::PlaneMismatch {
                plane: plane.to_owned(),
                detail: format!(
                    "texture extent {}x{}x{} != plane {}x{}",
                    size.width, size.height, size.depth_or_array_layers, layout.width, layout.height
                ),
            });
        }
        if src.texture.format() != layout.format.texture_format() {
            return Err(InteropError::PlaneMismatch {
                plane: plane.to_owned(),
                detail: format!(
                    "texture format {:?} != plane format {:?}",
                    src.texture.format(),
                    layout.format
                ),
            });
        }
        if src.mip_level != 0 || src.origin != wgpu::Origin3d::ZERO {
            return Err(InteropError::PlaneMismatch {
                plane: plane.to_owned(),
                detail: "only full mip 0 at origin is supported".into(),
            });
        }
        encoder.copy_texture_to_buffer(
            src,
            wgpu::TexelCopyBufferInfo {
                buffer: slot.buffer.as_ref().expect("live slot"),
                layout: wgpu::TexelCopyBufferLayout {
                    offset: layout.offset,
                    bytes_per_row: Some(layout.row_stride),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d { width: layout.width, height: layout.height, depth_or_array_layers: 1 },
        );
        Ok(())
    }

    /// Bind the slot's ready signal (`ready = generation`) to the **next**
    /// wgpu queue submission on this device and mark the slot published.
    ///
    /// Use this when the plane copies were recorded into a command encoder
    /// that somebody else submits — e.g. Bevy's render-graph
    /// `RenderContext::command_encoder()` submitted by `RenderGraphSystems::Submit`.
    /// Invariant the caller must uphold: no other `Queue::submit` (from any
    /// thread) happens between this call and the submission carrying the copies.
    /// On Bevy's render thread with pipelined rendering disabled that is the
    /// case for a system ordered `.after(RenderGraphSystems::Render)
    /// .before(RenderGraphSystems::Submit)`.
    pub fn arm_ready(&mut self, lease: SlotLease) -> Result<ReadyFrame, InteropError> {
        let ready = self.leased_slot(&lease)?.ready;
        self.add_ready_signal(ready, lease.generation)?;
        let slot = self.leased_slot_mut(&lease)?;
        slot.state = SlotState::Published(lease.generation);
        Ok(ReadyFrame { stream_id: lease.stream, slot: lease.slot, generation: lease.generation })
    }

    /// Submit the command buffers that fill the slot and bind the slot's ready
    /// signal (`ready = generation`) to that submission.
    ///
    /// Self-contained variant of [`Self::arm_ready`]: signal registration and
    /// submit happen back-to-back inside this call, so callers only need to
    /// not submit concurrently from another thread.
    pub fn submit_ready<I>(&mut self, lease: SlotLease, command_buffers: I) -> Result<ReadyFrame, InteropError>
    where
        I: IntoIterator<Item = wgpu::CommandBuffer>,
    {
        let ready = self.leased_slot(&lease)?.ready;
        self.add_ready_signal(ready, lease.generation)?;
        self.queue.submit(command_buffers);
        let slot = self.leased_slot_mut(&lease)?;
        slot.state = SlotState::Published(lease.generation);
        Ok(ReadyFrame { stream_id: lease.stream, slot: lease.slot, generation: lease.generation })
    }

    fn add_ready_signal(&self, ready: vk::Semaphore, generation: u64) -> Result<(), InteropError> {
        let queue: &wgpu::Queue = &self.queue;
        // SAFETY: the guard is dropped before any submission; the semaphore is a
        // live timeline semaphore of this device and `generation` is strictly
        // greater than any value previously signalled on it.
        let hal_queue = unsafe { queue.as_hal::<Vulkan>() }.ok_or(InteropError::NotVulkan)?;
        hal_queue.add_signal_semaphore(ready, Some(generation));
        Ok(())
    }

    /// Abandon an acquired slot without publishing it. Both timelines are
    /// advanced from the host so the slot returns to the free pool and later
    /// generations keep strictly increasing values.
    pub fn cancel(&mut self, lease: SlotLease) -> Result<(), InteropError> {
        let (ready, release) = {
            let slot = self.leased_slot(&lease)?;
            (slot.ready, slot.release)
        };
        for (sem, what) in [(ready, "vkSignalSemaphore(ready)"), (release, "vkSignalSemaphore(release)")] {
            let info = vk::SemaphoreSignalInfo::default().semaphore(sem).value(lease.generation);
            // SAFETY: live timeline semaphore; value exceeds its current counter
            // because this generation was never signalled.
            unsafe { self.raw.device.signal_semaphore(&info) }.map_err(vk_err(what))?;
        }
        self.leased_slot_mut(&lease)?.state = SlotState::Free;
        Ok(())
    }

    /// Take back a published frame whose [`ReadyFrame`] was never delivered
    /// to any consumer (e.g. the capture was judged incomplete after
    /// submission). Host-signals the release timeline to `generation`, so the
    /// slot becomes free for the next `acquire` once the GPU ready signal has
    /// passed. Errors if the slot is not `Published` at exactly this
    /// generation. Caller guarantee: no consumer holds or will receive this
    /// `ReadyFrame`; a consumer that had leased it would otherwise read a
    /// slot the renderer may rewrite.
    pub fn withdraw(&mut self, frame: ReadyFrame) -> Result<(), InteropError> {
        let s = self.stream_mut(frame.stream_id)?;
        let slot = s
            .slots
            .get_mut(frame.slot as usize)
            .ok_or(InteropError::UnknownStream(frame.stream_id))?;
        if slot.state != SlotState::Published(frame.generation) {
            return Err(InteropError::LeaseState {
                stream: frame.stream_id,
                slot: frame.slot,
                generation: frame.generation,
                expected: "published",
            });
        }
        let release = slot.release;
        let info = vk::SemaphoreSignalInfo::default().semaphore(release).value(frame.generation);
        // SAFETY: live timeline semaphore; no consumer imported a lease for
        // this generation, so `generation` exceeds its current counter.
        unsafe { self.raw.device.signal_semaphore(&info) }.map_err(vk_err("vkSignalSemaphore(release)"))?;
        // Leave the state Published: `acquire` re-validates via the release
        // counter, which now equals `generation`, and the ready signal bound
        // to the earlier submission still completes on its own semaphore.
        Ok(())
    }

    /// Whether the consumer has released a published frame (non-blocking).
    pub fn is_released(&self, frame: ReadyFrame) -> Result<bool, InteropError> {
        let s = self.stream(frame.stream_id)?;
        let slot = s
            .slots
            .get(frame.slot as usize)
            .ok_or(InteropError::UnknownStream(frame.stream_id))?;
        Ok(self.counter(slot.release)? >= frame.generation)
    }

    fn leased_slot(&self, lease: &SlotLease) -> Result<&Slot, InteropError> {
        let s = self.stream(lease.stream)?;
        let slot = s
            .slots
            .get(lease.slot as usize)
            .ok_or(InteropError::UnknownStream(lease.stream))?;
        if slot.state != SlotState::Leased(lease.generation) {
            return Err(InteropError::LeaseState {
                stream: lease.stream,
                slot: lease.slot,
                generation: lease.generation,
                expected: "leased",
            });
        }
        Ok(slot)
    }

    fn leased_slot_mut(&mut self, lease: &SlotLease) -> Result<&mut Slot, InteropError> {
        let stream = lease.stream;
        let s = self.stream_mut(stream)?;
        let slot = s
            .slots
            .get_mut(lease.slot as usize)
            .ok_or(InteropError::UnknownStream(stream))?;
        if slot.state != SlotState::Leased(lease.generation) {
            return Err(InteropError::LeaseState {
                stream,
                slot: lease.slot,
                generation: lease.generation,
                expected: "leased",
            });
        }
        Ok(slot)
    }
}

// ----------------------------------------------------------------------------
// Handle export

/// Fresh opaque-fd handles of one slot. Each `export_stream` call produces new
/// descriptors; the importer (CUDA) takes ownership of the fds it imports.
#[derive(Debug)]
pub struct SlotHandles {
    pub memory: OwnedFd,
    pub ready: OwnedFd,
    pub release: OwnedFd,
}

#[derive(Debug)]
pub struct ExportedStream {
    pub manifest: StreamManifest,
    pub handles: Vec<SlotHandles>,
}

impl ExportedStream {
    /// Handles flattened in manifest `handle_order` per slot.
    pub fn fds(&self) -> Vec<BorrowedFd<'_>> {
        let mut out = Vec::with_capacity(self.handles.len() * HANDLES_PER_SLOT);
        for h in &self.handles {
            out.push(h.memory.as_fd());
            out.push(h.ready.as_fd());
            out.push(h.release.as_fd());
        }
        out
    }

    /// Consume into (manifest, flattened owned fds) for in-process hand-off
    /// (e.g. a Python extension passing raw fds to `ImportedStream.from_handles`).
    pub fn into_parts(self) -> (StreamManifest, Vec<OwnedFd>) {
        let mut fds = Vec::with_capacity(self.handles.len() * HANDLES_PER_SLOT);
        for h in self.handles {
            fds.push(h.memory);
            fds.push(h.ready);
            fds.push(h.release);
        }
        (self.manifest, fds)
    }

    pub fn manifest_json(&self) -> Vec<u8> {
        serde_json::to_vec(&self.manifest).expect("manifest serialises")
    }

    /// Send `WIRE_MAGIC ++ u32le(len) ++ manifest JSON` with every handle
    /// attached as `SCM_RIGHTS` ancillary data on the first byte. The socket
    /// must not carry interleaved traffic from another writer during this call.
    pub fn send_over_unix(&self, sock: &UnixStream) -> io::Result<()> {
        let json = self.manifest_json();
        let mut frame = Vec::with_capacity(8 + json.len());
        frame.extend_from_slice(WIRE_MAGIC);
        frame.extend_from_slice(&(json.len() as u32).to_le_bytes());
        frame.extend_from_slice(&json);
        let fds = self.fds();
        let sent = send_with_fds(sock, &frame, &fds)?;
        (&*sock).write_all(&frame[sent..])
    }
}

impl GpuInterop {
    /// Export fresh handles for every slot of a stream.
    pub fn export_stream(&self, stream: StreamId) -> Result<ExportedStream, InteropError> {
        let s = self.stream(stream)?;
        let allocation_bytes = s.slots.first().map_or(0, |slot| slot.allocation_bytes);
        // Dedicated allocations of identical buffers have identical sizes; the
        // manifest carries one import size, so refuse anything else.
        if s.slots.iter().any(|slot| slot.allocation_bytes != allocation_bytes) {
            return Err(InteropError::Unsupported(
                "slot allocations of one stream differ in size".into(),
            ));
        }
        let mut handles = Vec::with_capacity(s.slots.len());
        for slot in &s.slots {
            let memory = self.export_memory(slot.memory)?;
            let ready = self.export_semaphore(slot.ready)?;
            let release = self.export_semaphore(slot.release)?;
            handles.push(SlotHandles { memory, ready, release });
        }
        Ok(ExportedStream {
            manifest: StreamManifest {
                protocol: PROTOCOL.to_owned(),
                stream_id: stream,
                label: s.label.clone(),
                device: self.caps.identity.clone(),
                slots: s.slots.len() as u32,
                slot_bytes: s.slot_bytes,
                allocation_bytes,
                dedicated: true,
                handle_order: ["memory".into(), "ready".into(), "release".into()],
                planes: s.planes.clone(),
            },
            handles,
        })
    }

    fn export_memory(&self, memory: vk::DeviceMemory) -> Result<OwnedFd, InteropError> {
        let info = vk::MemoryGetFdInfoKHR::default().memory(memory).handle_type(HANDLE_TYPE_MEM);
        // SAFETY: memory was allocated with a matching export info.
        let fd: RawFd = unsafe { self.raw.ext_mem_fd.get_memory_fd(&info) }
            .map_err(vk_err("vkGetMemoryFdKHR"))?;
        // SAFETY: the driver returned a fresh descriptor owned by us.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn export_semaphore(&self, sem: vk::Semaphore) -> Result<OwnedFd, InteropError> {
        let info = vk::SemaphoreGetFdInfoKHR::default().semaphore(sem).handle_type(HANDLE_TYPE_SEM);
        // SAFETY: semaphore was created with a matching export info.
        let fd: RawFd = unsafe { self.raw.ext_sem_fd.get_semaphore_fd(&info) }
            .map_err(vk_err("vkGetSemaphoreFdKHR"))?;
        // SAFETY: fresh descriptor owned by us.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

/// `sendmsg` with `SCM_RIGHTS`; returns the number of payload bytes sent.
fn send_with_fds(sock: &UnixStream, payload: &[u8], fds: &[BorrowedFd<'_>]) -> io::Result<usize> {
    if fds.len() > SCM_MAX_FD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} fds exceed SCM_MAX_FD ({SCM_MAX_FD})", fds.len()),
        ));
    }
    let fd_bytes = fds.len() * std::mem::size_of::<RawFd>();
    // SAFETY: CMSG_SPACE/CMSG_LEN are pure size computations.
    let space = unsafe { libc::CMSG_SPACE(fd_bytes as u32) } as usize;
    let mut control = vec![0u64; space.div_ceil(std::mem::size_of::<u64>())];
    let mut iov = libc::iovec {
        iov_base: payload.as_ptr() as *mut libc::c_void,
        iov_len: payload.len(),
    };
    // SAFETY: msghdr is plain data; all pointers below outlive the sendmsg call.
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = space as _;
    unsafe {
        let cmsg = libc::CMSG_FIRSTHDR(&msg);
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN(fd_bytes as u32) as _;
        let data = libc::CMSG_DATA(cmsg) as *mut RawFd;
        for (i, fd) in fds.iter().enumerate() {
            data.add(i).write_unaligned(fd.as_raw_fd());
        }
    }
    // SAFETY: valid socket fd and fully initialised msghdr.
    let n = unsafe { libc::sendmsg(sock.as_raw_fd(), &msg, libc::MSG_NOSIGNAL) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(n as usize)
}

impl Drop for GpuInterop {
    fn drop(&mut self) {
        let streams: Vec<Stream> = self.streams.drain().map(|(_, s)| s).collect();
        for s in streams {
            self.teardown(s, Duration::ZERO);
        }
    }
}

// Keep the physical device handle reachable for diagnostics/extensions without
// exposing raw HAL state publicly.
impl GpuInterop {
    /// Raw Vulkan physical device (diagnostics; no ownership transferred).
    pub fn physical_device(&self) -> vk::PhysicalDevice {
        self.raw.physical
    }

    /// Raw ash instance handle (diagnostics; must not be destroyed).
    pub fn raw_instance(&self) -> &ash::Instance {
        &self.raw.instance
    }
}
