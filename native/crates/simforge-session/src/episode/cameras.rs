//! Resident camera transport and leases. The Episode is the only render/tick owner.
//! Host payloads remain in the renderer ring; claimed leases must be released
//! before advancing. A service socket must be dedicated to this Episode.
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{c_char, c_void, CStr, CString};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Arc};
use std::thread::JoinHandle;

use libloading::Library;
use memmap2::MmapMut;
use serde_json::{json, Value};
use simforge_core::hash::{canonical_json, sha256};
use simforge_core::math::Vec2;
use simforge_core::trace::scene_state::{actor_class_of, catalog_id_for, LiveActorSample, SceneStateStream};
use simforge_core::types::SimScenarioInput;

use crate::env::EnvSession;
use crate::error::{Result, SessionError};
use super::camera_types::{CameraBackend, CameraEnhance, CameraObservation, CameraPass, FrameDescriptor, ResidentCameraRig};

fn camera_error(message: impl std::fmt::Display) -> SessionError {
    SessionError::Camera(message.to_string())
}


struct Lease {
    map: Arc<MmapMut>,
    claimed: AtomicBool,
    released: AtomicBool,
}

/// A borrowed ring slot, with explicit release. Exported buffers retain the map
/// allocation even after Episode.close(), but may not be used after release.
#[derive(Clone)]
pub struct FrameRef {
    pub descriptor: FrameDescriptor,
    lease: Arc<Lease>,
}

impl FrameRef {
    pub fn release(&self) { self.lease.released.store(true, Ordering::Release); }
    pub fn released(&self) -> bool { self.lease.released.load(Ordering::Acquire) }
    pub fn claim(&self) -> Result<Self> {
        if self.released() { return Err(camera_error("frame lease was released")); }
        self.lease.claimed.store(true, Ordering::Release);
        Ok(self.clone())
    }
    /// Exported memory is read-only by contract, even for Node's mutable Buffer.
    /// The caller must not read/write it after release or concurrently with a
    /// renderer writer. The Episode enforces this for its own render requests.
    pub fn raw_parts(&self) -> Result<(*mut u8, usize)> {
        if self.released() { return Err(camera_error("frame lease was released")); }
        let end = self.descriptor.offset.checked_add(self.descriptor.len)
            .filter(|&end| end <= self.lease.map.len())
            .ok_or_else(|| camera_error("frame descriptor exceeds its mapped ring"))?;
        Ok((self.lease.map.as_ptr().wrapping_add(self.descriptor.offset) as *mut u8, end - self.descriptor.offset))
    }
    fn live(&self) -> bool { self.lease.claimed.load(Ordering::Acquire) && !self.released() }
}

pub(crate) struct Cameras {
    rig: ResidentCameraRig,
    passes: Vec<CameraPass>,
    camera_documents: Value,
    backend: CameraBackend,
    transport: Option<Transport>,
    enhance: Option<CameraEnhance>,
    filter: Option<EnhanceTransport>,
    map: Option<Arc<MmapMut>>,
    shm: String,
    frames: Vec<FrameRef>,
    observations: Vec<CameraObservation>,
    next_id: u32,
    cursor: Option<u64>,
    stream: SceneStateStream,
    catalog: BTreeMap<String, Value>,
    map_id: String,
    scene: Value,
    scene_json: String,
    scene_digest: String,
}

impl Cameras {
    pub fn new(rig: ResidentCameraRig, passes: Vec<CameraPass>, backend: CameraBackend, enhance: Option<CameraEnhance>,
               scenario: &SimScenarioInput, decision_hz: u32) -> Result<Self> {
        if rig.cameras.is_empty() || passes.is_empty() {
            return Err(camera_error("cameras rig and passes must not be empty"));
        }
        let mut sensors = BTreeSet::new();
        let mut ids = BTreeSet::new();
        for c in &rig.cameras {
            if c.sensor_id.is_empty() || c.sensor_id.len() > 47 || c.sensor_id.contains('\0')
                || !sensors.insert(&c.sensor_id) || !ids.insert(c.camera_id)
                || c.width == 0 || c.height == 0 || c.width > 8192 || c.height > 8192
                || ![c.fwd,c.left,c.up,c.yaw_deg,c.pitch_deg,c.hfov].iter().all(|n| n.is_finite())
                || c.hfov <= 0.0 || c.hfov >= 180.0 {
                return Err(camera_error("camera ids must be unique; dimensions 1..8192; finite mount and 0 < hfov < 180"));
            }
        }
        if passes.iter().map(|p| p.wire()).collect::<BTreeSet<_>>().len() != passes.len() {
            return Err(camera_error("duplicate camera pass"));
        }
        if enhance.as_ref().is_some_and(|e| e.socket.is_empty() || e.identity.is_empty() || !passes.contains(&CameraPass::Rgb)) {
            return Err(camera_error("enhance requires RGB, a filter socket and a content-addressed identity"));
        }
        let catalog = scenario.actors.iter().map(|a| (a.id.clone(), json!({
            "catalogId": catalog_id_for(a.kind, &a.tags), "actorClass": actor_class_of(a.kind), "dims": a.dims,
        }))).collect();
        let ego = crate::env::resolve_ego_id(scenario)?;
        let camera_documents = json!(rig.cameras.iter().map(|c| {
            let vfov = 2.0 * ((c.hfov.to_radians() / 2.0).tan() / (c.width as f64 / c.height as f64)).atan();
            json!({"sensorId":c.sensor_id,"width":c.width,"height":c.height,"fovDeg":vfov.to_degrees(),
                "eye":[0,0,0],"target":[1,0,0],"attach":{"actorId":ego,"offsetM":[c.fwd,-c.left,c.up],
                "yawDeg":c.yaw_deg,"pitchDeg":c.pitch_deg}})
        }).collect::<Vec<_>>());
        Ok(Self { rig, passes, camera_documents, backend, transport: None, enhance, filter: None, map: None, shm: String::new(),
            frames: Vec::new(), observations: Vec::new(), next_id: 0, cursor: None,
            stream: SceneStateStream::new(1.0 / f64::from(decision_hz)), catalog,
            map_id: scenario.map_id.clone(), scene: Value::Null, scene_json: String::new(), scene_digest: String::new() })
    }

    pub fn ensure_released(&self) -> Result<()> {
        if self.frames.iter().any(FrameRef::live) {
            return Err(camera_error("release every claimed FrameRef before stepping or resetting the Episode"));
        }
        if let (Some(map), Some(expected)) = (&self.map, self.cursor) {
            let actual = u64::from_le_bytes(map[8..16].try_into().expect("ring cursor"));
            if actual != expected { return Err(camera_error("renderer ring changed outside Episode; use a dedicated service socket")); }
        }
        Ok(())
    }

    pub fn reset(&mut self) -> Result<()> {
        self.ensure_released()?;
        self.invalidate();
        if self.transport.is_none() {
            let mut transport = Transport::open(&self.backend)?;
            let hello = transport.request(json!({"op":"hello"}))?;
            if hello["protocol"] != 5 { return Err(camera_error("renderer must implement protocol 5")); }
            self.shm = hello["shm"]["path"].as_str().ok_or_else(|| camera_error("renderer hello missing shm.path"))?.to_owned();
            let file = OpenOptions::new().read(true).write(true).open(&self.shm).map_err(camera_error)?;
            let map = unsafe { MmapMut::map_mut(&file).map_err(camera_error)? };
            if map.len() < 4096 { return Err(camera_error("renderer shm ring is smaller than its meta page")); }
            let frame_bytes: usize = self.rig.cameras.iter().map(|c|
                (128 + (c.width as usize * 4).div_ceil(256) * 256 * c.height as usize) * self.passes.len()).sum();
            if frame_bytes + 128 + 32 + 96 * self.rig.cameras.len() * self.passes.len() > (map.len() - 4096) / 2 {
                return Err(camera_error("renderer shm ring must hold two complete camera bundles"));
            }
            self.map = Some(Arc::new(map));
            self.transport = Some(transport);
        }
        if self.filter.is_none() {
            self.filter = self.enhance.as_ref().map(EnhanceTransport::open).transpose()?;
        }
        self.transport.as_mut().expect("opened").request(json!({"op":"reset_cameras"}))?;
        self.stream.clear();
        self.scene = Value::Null;
        Ok(())
    }

    fn invalidate(&mut self) {
        for frame in &self.frames { frame.release(); }
        self.frames.clear();
        self.observations.clear();
    }

    pub fn render(&mut self, env: &EnvSession) -> Result<()> {
        self.ensure_released()?;
        self.invalidate();
        let sim = env.simulation().ok_or(SessionError::NotReset)?;
        let t = env.last_result().info.t_s;
        let tick = (t * 50.0).round() as u64;
        let frame = self.stream.frame(tick, t, env.actor_snapshots()?.iter().map(|a| LiveActorSample {
            id: sim.actor_id(a.index), present: a.present, position: Vec2 { x: a.x, y: a.y },
            heading_rad: a.heading_rad, speed_mps: a.longitudinal_velocity_mps,
        }));
        let mut actors: Vec<Value> = frame.actors.into_iter().map(|a| {
            let mut actor = self.catalog[&a.id].clone();
            actor["id"] = json!(a.id); actor["kind"] = json!(a.kind);
            actor["transform"] = json!({"position":a.position,"rotation":a.rotation});
            actor["velocity"] = json!(a.velocity);
            actor
        }).collect();
        if self.scene.is_null() {
            // A reset must remove bodies that existed at the end of the prior
            // run but are absent initially; omission leaves ghosts in Bevy.
            for a in env.actor_snapshots()?.iter().filter(|a| !a.present) {
                actors.push(json!({"id":sim.actor_id(a.index),"kind":"despawn",
                    "transform":{"position":[a.x,0.0,-a.y],"rotation":[0,0,0,1]}}));
            }
            actors.sort_by(|a,b| a["id"].as_str().cmp(&b["id"].as_str()));
        }
        self.scene = json!({"version":"simforge.scene-state.v1","mapId":self.map_id,
            "tick":tick,"tickHz":50,"actors":actors});
        self.scene_json = canonical_json(&self.scene)?;
        self.scene_digest = sha256(&self.scene_json);
        let transport = self.transport.as_mut().ok_or_else(|| camera_error("camera channel not reset"))?;
        transport.request(json!({"op":"load_scene_state","states":[self.scene]}))?;
        let response = transport.request(json!({"op":"render_bundle","sim_tick":tick,"tick_index":0,
            "cameras":self.camera_documents,"passes":self.passes.iter().map(|p| p.wire()).collect::<Vec<_>>()}))?;
        let records = response["frames"].as_array().ok_or_else(|| camera_error("render_bundle missing frames"))?;
        if response["frame"]["simTick"] != tick || records.len() != self.rig.cameras.len() * self.passes.len() {
            return Err(camera_error("renderer returned a stale or incomplete camera bundle"));
        }
        let map = self.map.as_ref().expect("opened").clone();
        for camera in &self.rig.cameras {
            for pass in &self.passes {
                let row = records.iter().find(|r| r["sensorId"] == camera.sensor_id && r["pass"] == pass.wire())
                    .ok_or_else(|| camera_error(format!("missing {} {} frame",camera.sensor_id,pass.wire())))?;
                let offset = row["offset"].as_u64().and_then(|n| usize::try_from(n).ok()).and_then(|n| n.checked_add(128))
                    .ok_or_else(|| camera_error("invalid frame offset"))?;
                let len = row["len"].as_u64().and_then(|n| usize::try_from(n).ok()).ok_or_else(|| camera_error("invalid frame length"))?;
                let stride = (camera.width as usize * 4).div_ceil(256) * 256;
                let format = row["format"].as_str().ok_or_else(|| camera_error("missing frame format"))?;
                if row["width"] != camera.width || row["height"] != camera.height || row["tickId"] != tick
                    || len != stride * camera.height as usize || offset.checked_add(len).is_none_or(|end| end > map.len())
                    || !matches!(format, "rgba8" | "depth32f" | "carla-depth-bgra") {
                    return Err(camera_error("renderer frame geometry/tick/format disagrees with camera rig"));
                }
                let bytes = &map[offset..offset+len];
                let digest = format!("{:08x}", crc32fast::hash(bytes));
                if row["digest"] != digest { return Err(camera_error("renderer frame CRC32 mismatch")); }
                self.next_id = self.next_id.checked_add(1).ok_or_else(|| camera_error("frame id exhausted"))?;
                let descriptor = FrameDescriptor { id: self.next_id, tick, format: format.to_owned(), row_stride: stride,
                    digest, sha256: simforge_core::hash::sha256_bytes(bytes), shm: self.shm.clone(), offset, len };
                self.frames.push(FrameRef { descriptor: descriptor.clone(), lease: Arc::new(Lease {
                    map: map.clone(), claimed: AtomicBool::new(false), released: AtomicBool::new(false),
                }) });
                self.observations.push(CameraObservation { sensor_id:camera.sensor_id.clone(),pass:pass.public().to_owned(),
                    width:camera.width,height:camera.height,frame:descriptor,enhance_ms:None });
                if *pass == CameraPass::Rgb {
                    if let Some(filter) = &mut self.filter {
                        if format != "rgba8" { return Err(camera_error("enhance requires rgba8 RGB frames")); }
                        let start = std::time::Instant::now();
                        let enhanced = filter.apply(camera.width, camera.height, stride, tick, &camera.sensor_id, bytes)?;
                        let enhance_ms = start.elapsed().as_secs_f64() * 1000.0;
                        self.next_id = self.next_id.checked_add(1).ok_or_else(|| camera_error("frame id exhausted"))?;
                        let descriptor = FrameDescriptor {
                            id: self.next_id, tick, format: "rgba8".into(), row_stride: camera.width as usize * 4,
                            digest: format!("{:08x}", crc32fast::hash(&enhanced)),
                            sha256: simforge_core::hash::sha256_bytes(&enhanced), shm: String::new(), offset: 0, len: enhanced.len(),
                        };
                        self.frames.push(FrameRef { descriptor: descriptor.clone(), lease: Arc::new(Lease {
                            map: Arc::new(enhanced), claimed: AtomicBool::new(false), released: AtomicBool::new(false),
                        }) });
                        self.observations.push(CameraObservation { sensor_id:camera.sensor_id.clone(),pass:"enhanced".into(),
                            width:camera.width,height:camera.height,frame:descriptor,enhance_ms:Some(enhance_ms) });
                    }
                }
            }
        }
        self.cursor = Some(u64::from_le_bytes(map[8..16].try_into().expect("ring cursor")));
        Ok(())
    }

    /// Callback leases are retired, and reset returns a distinct lease over the
    /// final warmup pixels. No re-render or stale-handle resurrection occurs.
    pub fn renew(&mut self) -> Result<()> {
        self.ensure_released()?;
        for (frame, observation) in self.frames.iter_mut().zip(&mut self.observations) {
            frame.release();
            self.next_id = self.next_id.checked_add(1).ok_or_else(|| camera_error("frame id exhausted"))?;
            frame.descriptor.id = self.next_id;
            frame.lease = Arc::new(Lease { map: frame.lease.map.clone(), claimed: AtomicBool::new(false), released: AtomicBool::new(false) });
            observation.frame = frame.descriptor.clone();
        }
        Ok(())
    }
    pub fn observations(&self) -> &[CameraObservation] { &self.observations }
    pub fn frame(&self, id: u32) -> Result<FrameRef> {
        self.frames.iter().find(|f| f.descriptor.id == id).ok_or_else(|| camera_error("unknown or expired frame id"))?.claim()
    }
    pub fn frames(&self) -> Result<Vec<FrameRef>> { self.frames.iter().map(FrameRef::claim).collect() }
    pub fn scene_json(&self) -> &str { &self.scene_json }
    pub fn evidence(&self) -> Value {
        json!({"sceneStateDigest":self.scene_digest,"frames":self.observations.iter().map(|o| json!({
            "sensorId":o.sensor_id,"pass":o.pass,"width":o.width,"height":o.height,"tick":o.frame.tick,
            "format":o.frame.format,"rowStride":o.frame.row_stride,"digest":o.frame.digest,"sha256":o.frame.sha256,
        })).collect::<Vec<_>>()})
    }
    pub fn close(&mut self) {
        self.invalidate();
        self.transport = None;
        self.filter = None;
        self.map = None;
        self.cursor = None;
    }
}

/// Length-prefixed JSON metadata followed by raw RGBA bytes. No simulation state
/// or policy action crosses this boundary; filter failure refuses the episode.
struct EnhanceTransport {
    #[cfg(unix)]
    stream: std::os::unix::net::UnixStream,
    identity: String,
}
impl EnhanceTransport {
    fn open(config: &CameraEnhance) -> Result<Self> {
        #[cfg(unix)] {
            let stream = std::os::unix::net::UnixStream::connect(&config.socket).map_err(camera_error)?;
            let timeout = Some(std::time::Duration::from_secs(120));
            stream.set_read_timeout(timeout).map_err(camera_error)?;
            stream.set_write_timeout(timeout).map_err(camera_error)?;
            Ok(Self { stream, identity: config.identity.clone() })
        }
        #[cfg(not(unix))] { let _ = config; Err(camera_error("enhance requires Unix sockets")) }
    }
    fn apply(&mut self, width: u32, height: u32, stride: usize, tick: u64, sensor: &str, bytes: &[u8]) -> Result<MmapMut> {
        #[cfg(unix)] {
            let header = serde_json::to_vec(&json!({"schema":"simforge.appearance-filter/v1","identity":self.identity,
                "width":width,"height":height,"rowStride":stride,"tick":tick,"sensorId":sensor,"bytes":bytes.len()})).map_err(camera_error)?;
            self.stream.write_all(&(header.len() as u32).to_le_bytes()).map_err(camera_error)?;
            self.stream.write_all(&header).map_err(camera_error)?;
            self.stream.write_all(bytes).map_err(camera_error)?;
            let mut prefix = [0;4]; self.stream.read_exact(&mut prefix).map_err(camera_error)?;
            let header_len = u32::from_le_bytes(prefix) as usize;
            if header_len > 65536 { return Err(camera_error("enhance response header exceeds 64KiB")); }
            let mut header = vec![0;header_len]; self.stream.read_exact(&mut header).map_err(camera_error)?;
            let response: Value = serde_json::from_slice(&header).map_err(camera_error)?;
            let len = width as usize * height as usize * 4;
            if response["ok"] != true || response["identity"] != self.identity || response["bytes"] != len
                || response["width"] != width || response["height"] != height {
                return Err(camera_error(format!("invalid enhance response: {response}")));
            }
            let mut map = MmapMut::map_anon(len).map_err(camera_error)?;
            self.stream.read_exact(&mut map).map_err(camera_error)?;
            Ok(map)
        }
        #[cfg(not(unix))] { let _ = (width,height,stride,tick,sensor,bytes); Err(camera_error("enhance requires Unix sockets")) }
    }
}

struct Transport { connection: Connection, seq: u64 }
enum Connection {
    #[cfg(unix)]
    Service(std::os::unix::net::UnixStream),
    Embedded { send: Option<mpsc::SyncSender<(Value,mpsc::Sender<std::result::Result<Value,String>>)>>, worker: Option<JoinHandle<()>> },
}

impl Transport {
    fn open(backend: &CameraBackend) -> Result<Self> {
        let connection = match backend {
            CameraBackend::Service { socket } => {
                #[cfg(unix)] {
                    let stream = std::os::unix::net::UnixStream::connect(socket).map_err(camera_error)?;
                    let timeout = Some(std::time::Duration::from_secs(120));
                    stream.set_read_timeout(timeout).map_err(camera_error)?;
                    stream.set_write_timeout(timeout).map_err(camera_error)?;
                    Connection::Service(stream)
                }
                #[cfg(not(unix))] { let _ = socket; return Err(camera_error("service backend requires Unix sockets")); }
            }
            CameraBackend::Embedded { scene, library, shm_size_bytes } => {
                let (send, recv) = mpsc::sync_channel::<(Value,mpsc::Sender<std::result::Result<Value,String>>)>(1);
                let (ready_send, ready_recv) = mpsc::channel();
                let (scene,library,size) = (scene.clone(),library.clone(),*shm_size_bytes);
                let worker = std::thread::Builder::new().name("episode-renderer".into()).spawn(move || {
                    let mut renderer = match Embedded::open(scene, library, size) {
                        Ok(renderer) => { let _ = ready_send.send(Ok(())); renderer }
                        Err(error) => { let _ = ready_send.send(Err(error.to_string())); return; }
                    };
                    while let Ok((request,reply)) = recv.recv() {
                        let _ = reply.send(renderer.request(request).map_err(|e| e.to_string()));
                    }
                }).map_err(camera_error)?;
                ready_recv.recv().map_err(camera_error)?.map_err(camera_error)?;
                Connection::Embedded { send:Some(send),worker:Some(worker) }
            }
        };
        Ok(Self { connection,seq:0 })
    }
    fn request(&mut self, mut request: Value) -> Result<Value> {
        self.seq += 1;
        request["i"] = json!(self.seq);
        let response = match &mut self.connection {
            #[cfg(unix)]
            Connection::Service(stream) => {
                let bytes = rmp_serde::to_vec_named(&request).map_err(camera_error)?;
                stream.write_all(&(bytes.len() as u32).to_le_bytes()).map_err(camera_error)?;
                stream.write_all(&bytes).map_err(camera_error)?;
                let mut prefix = [0;4]; stream.read_exact(&mut prefix).map_err(camera_error)?;
                let len = u32::from_le_bytes(prefix) as usize;
                if len > 64 * 1024 * 1024 { return Err(camera_error("renderer response exceeds 64MiB")); }
                let mut payload = vec![0;len]; stream.read_exact(&mut payload).map_err(camera_error)?;
                rmp_serde::from_slice::<Value>(&payload).map_err(camera_error)?
            }
            Connection::Embedded { send,.. } => {
                let (tx,rx) = mpsc::channel();
                send.as_ref().expect("open").send((request,tx)).map_err(camera_error)?;
                rx.recv().map_err(camera_error)?.map_err(camera_error)?
            }
        };
        if response["i"] != self.seq || response["ok"] != true {
            return Err(camera_error(format!("renderer request failed: {response}")));
        }
        Ok(response)
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Self::Embedded { send,worker } = self {
            send.take();
            if let Some(worker) = worker.take() { let _ = worker.join(); }
        }
    }
}

type OpenFn = unsafe extern "C" fn(*const c_char,*const c_char,u64,*mut *mut c_char) -> *mut c_void;
type RequestFn = unsafe extern "C" fn(*mut c_void,*const c_char) -> *mut c_char;
type FreeFn = unsafe extern "C" fn(*mut c_char);
type CloseFn = unsafe extern "C" fn(*mut c_void);
struct Embedded { _library: Library, handle:*mut c_void, request:RequestFn, free:FreeFn, close:CloseFn, shm:PathBuf }
static SHM_ID: AtomicU64 = AtomicU64::new(0);
impl Embedded {
    fn open(scene:Value, library:Option<String>, size:u64) -> Result<Self> {
        let library = library.map(PathBuf::from).or_else(|| std::env::var_os("SIMFORGE_RENDER_LIB").map(PathBuf::from)).unwrap_or_else(|| {
            let root = std::env::var_os("SIMFORGE_NATIVE_RUNTIME_ROOT").map(PathBuf::from).unwrap_or_else(|| {
                std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")).join("simforge/native-runtime")
            });
            root.join("lib/libsimforge_render.so")
        });
        let library = unsafe { Library::new(&library).map_err(camera_error)? };
        unsafe {
            let abi = library.get::<unsafe extern "C" fn()->i32>(b"simforge_render_abi\0").map_err(camera_error)?;
            let protocol = library.get::<unsafe extern "C" fn()->i32>(b"simforge_render_protocol\0").map_err(camera_error)?;
            if abi() != 1 || protocol() != 5 { return Err(camera_error("libsimforge_render requires ABI 1 / protocol 5")); }
            let open = *library.get::<OpenFn>(b"simforge_render_open\0").map_err(camera_error)?;
            let request = *library.get::<RequestFn>(b"simforge_render_request\0").map_err(camera_error)?;
            let free = *library.get::<FreeFn>(b"simforge_render_free_string\0").map_err(camera_error)?;
            let close = *library.get::<CloseFn>(b"simforge_render_close\0").map_err(camera_error)?;
            let shm = std::env::temp_dir().join(format!("simforge-episode-{}-{}.shm",std::process::id(),SHM_ID.fetch_add(1,Ordering::Relaxed)));
            let scene = if let Some(path) = scene.as_str() { std::fs::read_to_string(path).map_err(camera_error)? } else { scene.to_string() };
            let document = CString::new(scene).map_err(camera_error)?;
            let path = CString::new(shm.to_string_lossy().as_bytes()).map_err(camera_error)?;
            let mut error = std::ptr::null_mut();
            let handle = open(document.as_ptr(),path.as_ptr(),size,&mut error);
            if handle.is_null() {
                let message = if error.is_null() { "libsimforge_render open failed".into() } else {
                    let msg = CStr::from_ptr(error).to_string_lossy().into_owned(); free(error); msg
                };
                return Err(camera_error(message));
            }
            Ok(Self { _library:library,handle,request,free,close,shm })
        }
    }
    fn request(&mut self, request:Value) -> Result<Value> {
        let request = CString::new(request.to_string()).map_err(camera_error)?;
        unsafe {
            let response = (self.request)(self.handle,request.as_ptr());
            if response.is_null() { return Err(camera_error("libsimforge_render returned a null response")); }
            let value = serde_json::from_slice(CStr::from_ptr(response).to_bytes()).map_err(camera_error);
            (self.free)(response);
            value
        }
    }
}
impl Drop for Embedded {
    fn drop(&mut self) {
        unsafe { (self.close)(self.handle); }
        let _ = std::fs::remove_file(&self.shm);
    }
}
