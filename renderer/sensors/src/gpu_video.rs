//! Vulkan texture -> exportable device buffer -> CUDA -> NVENC. Only compressed
//! H.264 packets cross host memory. Slot leases remain held through encoding.
//! This is a device-local COPY, not an assertion of zero copies or codec parity.
use super::{CaptureConfig, Copiers, RenderSender, SentPass};
use bevy::prelude::*;
use bevy::render::{RenderApp, render_asset::RenderAssets, renderer::{RenderDevice, RenderQueue}, texture::GpuImage};
use render_core::gpu_interop::{ExportedStream, GpuInterop, PlaneDescriptor, PlaneFormat, ReadyFrame, StreamDescriptor, StreamId};
use std::{ffi::{c_char, c_void, CStr}, io::Write, os::fd::IntoRawFd, process::{Command, Stdio}, sync::Arc, thread::JoinHandle, time::Duration};
use parking_lot::Mutex;

// All sensor-owned submissions share this gate. In particular, the CPU ray
// worker must not submit between registering an external ready signal and the
// copy submission to which that signal belongs. Bevy submits on this same
// render thread, outside the gated interval.
pub(super) static SUBMIT_GATE: Mutex<()> = Mutex::new(());

unsafe extern "C" {
    fn sensor_nvenc_create(uuid: *const u8, slots: u32, cameras: u32, fds: *mut i32,
        allocation_bytes: u64, slot_bytes: u64, offsets: *const u64, width: u32, height: u32,
        pitch: u32, fps_num: u32, fps_den: u32, quality: u32, error: *mut c_char, error_size: usize) -> *mut c_void;
    fn sensor_nvenc_error(session: *mut c_void) -> *const c_char;
    fn sensor_nvenc_begin(session: *mut c_void, slot: u32, generation: u64) -> i32;
    fn sensor_nvenc_encode(session: *mut c_void, camera: u32, slot: u32, frame: u64, data: *mut *const u8, bytes: *mut u32) -> i32;
    fn sensor_nvenc_unlock(session: *mut c_void, camera: u32) -> i32;
    fn sensor_nvenc_release(session: *mut c_void, slot: u32, generation: u64) -> i32;
    fn sensor_nvenc_finish(session: *mut c_void) -> i32;
    fn sensor_nvenc_destroy(session: *mut c_void);
}

struct Session(*mut c_void);
impl Session {
    fn check(&self, result: i32) -> Result<(), String> {
        if result == 0 { Ok(()) } else { Err(unsafe { CStr::from_ptr(sensor_nvenc_error(self.0)) }.to_string_lossy().into_owned()) }
    }
}
impl Drop for Session { fn drop(&mut self) { unsafe { sensor_nvenc_destroy(self.0) }; } }

enum Work { Frame(u64, ReadyFrame), Finish }
struct Worker { tx: crossbeam_channel::Sender<Work>, join: JoinHandle<Result<u64, String>> }
#[derive(Resource, Clone, Default)]
pub(super) struct Completion(Arc<Mutex<Option<Worker>>>);
impl Completion {
    pub(super) fn finish(&self) -> u64 {
        let worker = self.0.lock().take().expect("GPU encoder was never initialized");
        worker.tx.send(Work::Finish).expect("GPU encoder worker exited");
        worker.join.join().expect("GPU encoder panicked").expect("GPU encoder failed")
    }
    pub(super) fn check(&self) {
        let mut worker = self.0.lock();
        if worker.as_ref().is_some_and(|worker| worker.join.is_finished()) {
            let result = worker.take().unwrap().join.join();
            panic!("GPU encoder terminated before capture completion: {result:?}");
        }
    }
}

#[derive(Resource)]
pub(super) struct DeviceVideo {
    args: CaptureConfig,
    cameras: Vec<(String, String)>,
    completion: Completion,
    stream: Option<(GpuInterop, StreamId, crossbeam_channel::Sender<Work>)>,
}

pub(super) fn install(app: &mut App, args: &CaptureConfig, cameras: Vec<(String, String)>) {
    let completion = Completion::default();
    app.insert_resource(completion.clone());
    app.sub_app_mut(RenderApp).insert_resource(DeviceVideo {
        args: args.clone(), cameras, completion, stream: None,
    });
}

impl DeviceVideo {
    pub(super) fn copy(&mut self, device: &RenderDevice, queue: &RenderQueue,
        copiers: &Copiers, images: &RenderAssets<GpuImage>, sender: &RenderSender, frame: u64) {
        if self.stream.is_none() {
            let mut interop = GpuInterop::new(device, queue).expect("GPU video interoperability unavailable");
            let stream = interop.create_stream(&StreamDescriptor {
                label: "sensor video".into(), slots: self.args.readback_slots.max(2) as usize,
                planes: self.cameras.iter().map(|(key, _)| PlaneDescriptor {
                    name: key.clone(), width: self.args.consumer.width, height: self.args.consumer.height, format: PlaneFormat::Rgba8UnormSrgb,
                }).collect(),
            }).expect("allocate device video ring");
            let export = interop.export_stream(stream).expect("export device video ring");
            let (tx, rx) = crossbeam_channel::bounded(self.args.readback_slots.max(2) as usize);
            let (ready_tx, ready_rx) = crossbeam_channel::bounded(1);
            let args = self.args.clone(); let cameras = self.cameras.clone(); let sender = sender.0.clone();
            let join = std::thread::Builder::new().name("sensor-nvenc".into()).spawn(move ||
                encode(export, args, cameras, sender, rx, ready_tx)).expect("start GPU encoder");
            ready_rx.recv().expect("GPU encoder startup failed").expect("initialize GPU encoder");
            *self.completion.0.lock() = Some(Worker { tx: tx.clone(), join });
            self.stream = Some((interop, stream, tx));
        }
        let (interop, stream, tx) = self.stream.as_mut().unwrap();
        let lease = interop.acquire(*stream, Some(Duration::from_secs(30))).expect("GPU video backpressure");
        let mut encoder = device.create_command_encoder(&Default::default());
        for (key, _) in &self.cameras {
            let copy = copiers.0.iter().find(|copy| &copy.key == key).expect("RGB copier");
            let image = images.get(&copy.src_image).expect("RGB target prepared");
            interop.encode_copy(&mut encoder, &lease, key, image.texture.as_image_copy()).expect("copy RGB to encoder");
        }
        let ready = {
            let _gate = SUBMIT_GATE.lock();
            interop.submit_ready(lease, [encoder.finish()]).expect("submit GPU video")
        };
        tx.send(Work::Frame(frame, ready)).expect("GPU encoder exited");
    }
}

fn encode(export: ExportedStream, args: CaptureConfig, cameras: Vec<(String, String)>,
    sender: crossbeam_channel::Sender<SentPass>, rx: crossbeam_channel::Receiver<Work>,
    ready: crossbeam_channel::Sender<Result<(), String>>) -> Result<u64, String> {
    let (manifest, handles) = export.into_parts();
    let uuid = hex::decode(&manifest.device.device_uuid).map_err(|e| e.to_string())?;
    if uuid.len() != 16 { return Err("invalid physical-device UUID".into()); }
    let offsets: Vec<_> = manifest.planes.iter().map(|p| p.offset).collect();
    let mut fds: Vec<_> = handles.into_iter().map(IntoRawFd::into_raw_fd).collect();
    let fps = args.video_fps.expect("resolved sample cadence");
    let fps_num = (fps * 1000.0).round() as u32;
    let mut error = [0 as c_char; 512];
    // C takes ownership of every fd, including closing unimported fds on error.
    let pointer = unsafe { sensor_nvenc_create(uuid.as_ptr(), manifest.slots, cameras.len() as u32,
        fds.as_mut_ptr(), manifest.allocation_bytes, manifest.slot_bytes, offsets.as_ptr(),
        args.consumer.width, args.consumer.height, manifest.planes[0].row_stride, fps_num, 1000, args.consumer.video_quality(),
        error.as_mut_ptr(), error.len()) };
    if pointer.is_null() {
        let error = unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy().into_owned();
        let _ = ready.send(Err(error.clone())); return Err(error);
    }
    let session = Session(pointer);
    let mut muxers = Vec::new();
    for (_, camera) in &cameras {
        let child = Command::new("ffmpeg")
            .args(["-hide_banner","-loglevel","error","-y","-r",&fps.to_string(),"-f","h264","-i","-","-c:v","copy","-fflags","+bitexact"])
            .arg(std::path::Path::new(&args.out).join(format!("{camera}.mp4")))
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit())
            .spawn().map_err(|e| e.to_string())?;
        muxers.push(child);
    }
    ready.send(Ok(())).map_err(|e| e.to_string())?;
    let mut frames = 0u64;
    while let Ok(work) = rx.recv() {
        let Work::Frame(frame, lease) = work else { break };
        session.check(unsafe { sensor_nvenc_begin(pointer, lease.slot, lease.generation) })?;
        for (index, muxer) in muxers.iter_mut().enumerate() {
            let mut data = std::ptr::null(); let mut bytes = 0;
            session.check(unsafe { sensor_nvenc_encode(pointer, index as u32, lease.slot, frames, &mut data, &mut bytes) })?;
            let packet = unsafe { std::slice::from_raw_parts(data, bytes as usize) };
            let written = muxer.stdin.as_mut().unwrap().write_all(packet);
            session.check(unsafe { sensor_nvenc_unlock(pointer, index as u32) })?;
            written.map_err(|e| e.to_string())?;
        }
        session.check(unsafe { sensor_nvenc_release(pointer, lease.slot, lease.generation) })?;
        for (key, _) in &cameras {
            sender.send(SentPass { key: key.clone(), frame, data: Vec::new() }).map_err(|e| e.to_string())?;
        }
        frames += 1;
    }
    session.check(unsafe { sensor_nvenc_finish(pointer) })?;
    for muxer in &mut muxers { drop(muxer.stdin.take()); }
    for mut muxer in muxers {
        let status = muxer.wait().map_err(|e| e.to_string())?;
        if !status.success() { return Err(format!("GPU video muxer failed: {status}")); }
    }
    Ok(frames * cameras.len() as u64)
}
