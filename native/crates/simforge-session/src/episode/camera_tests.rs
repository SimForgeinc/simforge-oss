//! Protocol fixture exercises leases and scene ownership without requiring a GPU.
//! Real renderer/binding parity is in adapters/gym/tests/test_episode_parity.py.
use super::cameras::*;
use super::*;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc};
use simforge_core::engine::RunOptions;
use simforge_core::map::{LaneGraph, TopologyIndex};
use serde_json::{json, Value};

static ID: AtomicU64 = AtomicU64::new(0);
struct ServiceFixture { root: std::path::PathBuf, worker: Option<std::thread::JoinHandle<()>> }
impl ServiceFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("episode-camera-test-{}-{}",std::process::id(),ID.fetch_add(1,Ordering::Relaxed)));
        std::fs::create_dir_all(&root).unwrap();
        let listener = UnixListener::bind(root.join("render.sock")).unwrap();
        let shm = root.join("ring.shm");
        let file = std::fs::OpenOptions::new().read(true).write(true).create_new(true).open(&shm).unwrap();
        file.set_len(1024 * 1024).unwrap();
        let mut map = unsafe { memmap2::MmapMut::map_mut(&file).unwrap() };
        let worker = std::thread::spawn(move || {
            let (mut stream,_) = listener.accept().unwrap();
            let mut cursor = 0u64;
            loop {
                let mut prefix = [0;4];
                if stream.read_exact(&mut prefix).is_err() { break; }
                let mut bytes = vec![0;u32::from_le_bytes(prefix) as usize]; stream.read_exact(&mut bytes).unwrap();
                let request: Value = rmp_serde::from_slice(&bytes).unwrap();
                let mut response = json!({"i":request["i"],"ok":true});
                match request["op"].as_str().unwrap() {
                    "hello" => { response["protocol"] = json!(5); response["shm"] = json!({"path":shm}); }
                    "reset_cameras" | "load_scene_state" => {},
                    "render_bundle" => {
                        let tick = request["sim_tick"].as_u64().unwrap();
                        let mut frames = Vec::new();
                        let mut offset = 4096;
                        for camera in request["cameras"].as_array().unwrap() {
                            for pass in request["passes"].as_array().unwrap() {
                                let width = camera["width"].as_u64().unwrap() as usize;
                                let height = camera["height"].as_u64().unwrap() as usize;
                                let len = (width * 4).div_ceil(256) * 256 * height;
                                let payload = offset + 128;
                                map[payload..payload+len].fill((tick % 251) as u8);
                                frames.push(json!({"sensorId":camera["sensorId"],"pass":pass,"width":width,"height":height,
                                    "offset":offset,"len":len,"tickId":tick,"format":if pass == "depth" { "depth32f" } else { "rgba8" },
                                    "digest":format!("{:08x}",crc32fast::hash(&map[payload..payload+len]))}));
                                offset = payload + len;
                            }
                        }
                        cursor += offset as u64;
                        map[8..16].copy_from_slice(&cursor.to_le_bytes());
                        response["frames"] = json!(frames);
                        response["frame"] = json!({"simTick":tick});
                    }
                    op => panic!("unexpected camera op {op}"),
                }
                let response = rmp_serde::to_vec_named(&response).unwrap();
                stream.write_all(&(response.len() as u32).to_le_bytes()).unwrap();
                stream.write_all(&response).unwrap();
            }
        });
        Self { root,worker:Some(worker) }
    }
    fn episode(&self, warmup: u32) -> Episode {
        self.episode_enhanced(warmup, None)
    }
    fn episode_enhanced(&self, warmup: u32, enhance: Option<CameraEnhance>) -> Episode {
        let doc: Value = serde_json::from_str(include_str!("../../../../../adapters/gym/tests/fixtures/synthetic-episode.json")).unwrap();
        let instance = &doc["instances"][0];
        let graph = Arc::new(LaneGraph::new(TopologyIndex::from_json_slice(&serde_json::to_vec(&instance["topology"]).unwrap()).unwrap()));
        let mut scenario = simforge_core::types::parse_scenario_input(&instance["input"].to_string()).unwrap();
        scenario.actors.iter_mut().find(|a| a.id == "other").unwrap().present_at_start = false;
        Episode::new(EpisodeSpec { scenario,topology:RunOptions::new(graph), options:EpisodeOptions {
            warmup_decisions:warmup, observation:EpisodeObservationConfig { channels:vec![ObservationChannel::State,
                ObservationChannel::Cameras { rig:ResidentCameraRig { cameras:vec![CameraSpec {
                    sensor_id:"front".into(),camera_id:1,fwd:2.05,left:0.0,up:1.5,yaw_deg:0.0,pitch_deg:0.0,hfov:120.0,width:17,height:3,
                }] },passes:vec![CameraPass::Rgb,CameraPass::Depth,CameraPass::Seg],
                backend:CameraBackend::Service { socket:self.root.join("render.sock").to_string_lossy().into_owned() }, enhance }],
                ..EpisodeObservationConfig::default() }, ..EpisodeOptions::default()
        } }).unwrap()
    }
}
impl Drop for ServiceFixture {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() { worker.join().unwrap(); }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
fn action() -> EpisodeAction { serde_json::from_value(json!({"k":"s","speedMps":8})).unwrap() }

#[test]
fn cameras_leases_block_advance_before_world_mutation_and_expire_on_release() {
    let service = ServiceFixture::new();
    let mut episode = service.episode(0);
    let obs = episode.reset().unwrap();
    let rows = obs.cameras.unwrap();
    assert_eq!(rows.iter().map(|r|r.pass.as_str()).collect::<Vec<_>>(), ["rgb","depth","seg"]);
    assert_eq!(rows[0].frame.row_stride,256);
    let id = rows[0].frame.id;
    let reset: Value = serde_json::from_str(episode.trace_json().lines().next().unwrap()).unwrap();
    assert!(reset["reset"]["options"]["observation"]["channels"][1].get("enhance").is_none(),
        "disabled enhancement must not add a null option to existing v2 trace identities");
    let lease = episode.frame(id).unwrap();
    let (ptr,len) = lease.raw_parts().unwrap();
    let bytes = unsafe { std::slice::from_raw_parts(ptr,len) };
    assert_eq!(simforge_core::hash::sha256_bytes(bytes),lease.descriptor.sha256);
    let mut malformed = lease.clone();
    malformed.descriptor.offset = usize::MAX;
    assert!(malformed.raw_parts().is_err(), "a modified Rust descriptor must not expose an out-of-map pointer");
    let snapshot = episode.snapshot().unwrap();
    assert!(episode.step(action()).is_err());
    assert_eq!(episode.snapshot().unwrap(),snapshot);
    lease.release();
    assert!(lease.raw_parts().is_err());
    episode.step(action()).unwrap();
    assert!(episode.frame(id).is_err());
    assert!(episode.snapshot().unwrap()["tS"].as_f64().unwrap() > snapshot["tS"].as_f64().unwrap());
    let scene: Value = serde_json::from_str(episode.scene_state_json().unwrap()).unwrap();
    let snapshot = episode.snapshot().unwrap();
    let ego = snapshot["actors"].as_array().unwrap().iter().find(|a| a["id"] == episode.ego()).unwrap();
    let rendered = scene["actors"].as_array().unwrap().iter().find(|a| a["id"] == episode.ego()).unwrap();
    assert!((rendered["transform"]["position"][0].as_f64().unwrap() - ego["state"]["x"].as_f64().unwrap()).abs() < 1e-6);
    assert!((rendered["transform"]["position"][2].as_f64().unwrap() + ego["state"]["y"].as_f64().unwrap()).abs() < 1e-6);
    let row: Value = serde_json::from_str(episode.trace_json().lines().last().unwrap()).unwrap();
    assert_eq!(row["cameras"]["sceneStateDigest"],simforge_core::hash::sha256(episode.scene_state_json().unwrap()));
    assert_eq!(row["cameras"]["frames"][0]["sha256"],episode.last_step().obs.cameras.unwrap()[0].frame.sha256);
    episode.reset().unwrap();
    let reset_scene: Value = serde_json::from_str(episode.scene_state_json().unwrap()).unwrap();
    assert!(reset_scene["actors"].as_array().unwrap().iter().any(|a| a["id"] == "other" && a["kind"] == "despawn"),
        "reset must explicitly remove initially absent bodies from a prior rendered run");
    episode.close();
}

#[test]
fn cameras_warmup_delivers_real_ticks_then_renews_final_pixels_without_rendering() {
    let service = ServiceFixture::new();
    let mut episode = service.episode(4);
    let mut callbacks = Vec::new();
    let final_observation = episode.reset_with(|ep,phase| {
        let frames = ep.frames()?;
        callbacks.push((phase,ep.last_step().obs.t_s,frames[0].descriptor.id,frames[0].descriptor.sha256.clone()));
        for frame in frames { frame.release(); }
        Ok(())
    },true).unwrap();
    assert_eq!(callbacks.iter().map(|r|r.1).collect::<Vec<_>>(),vec![0.0,0.1,0.2,0.3,0.4]);
    assert_eq!(callbacks[0].0,"reset");
    assert!(callbacks[1..].iter().all(|r|r.0 == "warmup"));
    let final_frame = &final_observation.cameras.unwrap()[0].frame;
    assert_ne!(final_frame.id,callbacks.last().unwrap().2);
    assert_eq!(final_frame.sha256,callbacks.last().unwrap().3);
    let id = final_frame.id;
    assert!(episode.frame(callbacks[0].2).is_err());
    let lease = episode.frame(id).unwrap();
    assert!(!lease.released());
    lease.release();
    episode.step(action()).unwrap();
    assert_eq!(episode.last_step().obs.t_s,0.5);
    episode.close();
}

#[test]
fn enhanced_pass_is_separate_digest_evidence_and_obeys_camera_leases() {
    let service = ServiceFixture::new();
    let socket = service.root.join("filter.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let filter = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        loop {
            let mut prefix = [0;4];
            if stream.read_exact(&mut prefix).is_err() { break; }
            let mut header = vec![0;u32::from_le_bytes(prefix) as usize];
            stream.read_exact(&mut header).unwrap();
            let request: Value = serde_json::from_slice(&header).unwrap();
            let mut raw = vec![0;request["bytes"].as_u64().unwrap() as usize];
            stream.read_exact(&mut raw).unwrap();
            let width = request["width"].as_u64().unwrap() as usize;
            let height = request["height"].as_u64().unwrap() as usize;
            let stride = request["rowStride"].as_u64().unwrap() as usize;
            let mut enhanced = Vec::new();
            for row in raw.chunks_exact(stride).take(height) {
                enhanced.extend(row[..width*4].iter().map(|v| v ^ 0x5a));
            }
            let response = serde_json::to_vec(&json!({"ok":true,"identity":request["identity"],
                "width":width,"height":height,"bytes":enhanced.len()})).unwrap();
            stream.write_all(&(response.len() as u32).to_le_bytes()).unwrap();
            stream.write_all(&response).unwrap();
            stream.write_all(&enhanced).unwrap();
        }
    });
    let mut episode = service.episode_enhanced(2, Some(CameraEnhance {
        socket: socket.to_string_lossy().into_owned(), identity: "test-filter-v1".into(),
    }));
    episode.reset_with(|ep,_| {
        for frame in ep.frames()? { frame.release(); }
        Ok(())
    },true).unwrap();
    let rows = episode.last_step().obs.cameras.unwrap();
    assert_eq!(rows.iter().map(|r|r.pass.as_str()).collect::<Vec<_>>(), ["rgb","enhanced","depth","seg"]);
    assert_ne!(rows[0].frame.sha256,rows[1].frame.sha256);
    for row in rows {
        let frame = episode.frame(row.frame.id).unwrap();
        let (ptr,len) = frame.raw_parts().unwrap();
        let bytes = unsafe { std::slice::from_raw_parts(ptr,len) };
        assert_eq!(simforge_core::hash::sha256_bytes(bytes),row.frame.sha256);
        frame.release();
    }
    episode.step(action()).unwrap();
    let rows = episode.last_step().obs.cameras.unwrap();
    let enhanced = episode.frame(rows[1].frame.id).unwrap();
    let before = episode.snapshot().unwrap();
    assert!(episode.step(action()).is_err());
    assert_eq!(before,episode.snapshot().unwrap());
    enhanced.release();
    let trace: Vec<Value> = episode.trace_json().lines().map(|r|serde_json::from_str(r).unwrap()).collect();
    let channel = &trace[0]["reset"]["options"]["observation"]["channels"][1];
    assert_eq!(channel["enhance"]["identity"],"test-filter-v1");
    assert!(channel["enhance"].get("socket").is_none());
    for row in &trace {
        let frames = if row.get("reset").is_some() { &row["reset"]["observation"]["cameras"]["frames"] }
            else { &row["cameras"]["frames"] };
        let raw = &frames[0];
        let enhanced = &frames[1];
        assert_eq!(raw["pass"],"rgb");
        assert_eq!(enhanced["pass"],"enhanced");
        assert_eq!(raw["tick"],enhanced["tick"]);
        assert_ne!(raw["sha256"],enhanced["sha256"]);
        assert!(enhanced.get("enhanceMs").is_none());
    }
    // A changed enhanced digest must change the same v2 chain, not an unsealed sidecar.
    let mut altered = trace.last().unwrap().clone();
    altered.as_object_mut().unwrap().remove("digest");
    altered["cameras"]["frames"][1]["sha256"] = json!("different");
    let hash = simforge_core::hash::sha256(&format!("{}{}",trace[trace.len()-2]["digest"].as_str().unwrap(),
        simforge_core::hash::canonical_json(&altered).unwrap()));
    assert_ne!(hash,episode.trace_digest());
    episode.close();
    filter.join().unwrap();
}
