//! The renderer, in process, for a closed-loop episode: one prewarmed scene,
//! the rig retained, and every reset/step/observe rendered through the
//! render service's own request path (`load_scene_state` for a new episode,
//! `append_scene_state` for the next instant, then `render_bundle` at that
//! frame with its simulation time).

use std::path::PathBuf;

use render_service::proto::{ResponseBody, WireRequest};
use render_service::server::{dispatch, prewarm, SceneSpec, ServiceState};
use render_service::shm::{ShmRing, RECORD_HEADER_BYTES};
use serde_json::{json, Value};

use crate::contract::CliError;

/// One published sensor payload of a render.
pub struct SensorFrame {
    pub sensor_id: String,
    pub pass: String,
    /// `rgba8`, `depth32f`, `ply-ascii`/`ply-binary`, `radar-csv`.
    pub format: String,
    pub width: u32,
    pub height: u32,
    /// Row padding stripped for images.
    pub data: Vec<u8>,
}

pub struct Sensors {
    state: ServiceState,
    shm_path: PathBuf,
    cameras: Vec<Value>,
    lidars: Vec<Value>,
    radars: Vec<Value>,
    passes: Vec<String>,
    /// Lidar/radar declarations are retained by the service after the first bundle.
    declared: bool,
    /// Frames in the loaded stream.
    ticks: u32,
    next_i: u64,
    pub render_config: Value,
}

fn request(value: Value) -> Result<WireRequest, CliError> {
    serde_json::from_value(value)
        .map_err(|e| CliError::new("internal_error", format!("render request: {e}")))
}

impl Sensors {
    /// Prewarm `scene` (the scene spec) with `cameras`/`lidars`/`radars` in
    /// the service wire shape.
    pub fn start(
        scene: Value,
        cameras: Vec<Value>,
        lidars: Vec<Value>,
        radars: Vec<Value>,
        passes: Vec<String>,
        shm_size_mb: u64,
    ) -> Result<Self, CliError> {
        let spec: SceneSpec = serde_json::from_value(scene)
            .map_err(|e| CliError::new("render_failed", format!("scene spec: {e}")))?;
        let (resolved, _) = spec
            .render_config()
            .map_err(|e| CliError::new("render_failed", format!("render config: {e:#}")))?;
        let app = prewarm(&spec)
            .map_err(|e| CliError::new("render_failed", format!("renderer prewarm: {e:#}")))?;
        let shm_path =
            std::env::temp_dir().join(format!("simforge-env-serve.{}", std::process::id()));
        let shm = ShmRing::create(&shm_path, (shm_size_mb * 1024 * 1024) as usize)
            .map_err(|e| CliError::new("render_failed", format!("shared memory ring: {e:#}")))?;
        let state = ServiceState::new(app, &spec, shm_path.to_string_lossy().into_owned(), shm)
            .map_err(|e| CliError::new("render_failed", format!("render service: {e:#}")))?;
        Ok(Self {
            state,
            shm_path,
            cameras,
            lidars,
            radars,
            passes,
            declared: false,
            ticks: 0,
            next_i: 1,
            render_config: serde_json::to_value(resolved).unwrap_or(Value::Null),
        })
    }

    fn call(&mut self, mut body: Value) -> Result<ResponseBody, CliError> {
        body["i"] = json!(self.next_i);
        self.next_i += 1;
        let response = dispatch(&mut self.state, request(body)?);
        if let ResponseBody::Error { error, .. } = response.body {
            return Err(CliError::new("render_failed", error));
        }
        Ok(response.body)
    }

    /// Render `frame` (a scene-state.v1 frame); `restart` begins a new
    /// stream (a reset), otherwise the frame continues the episode.
    pub fn render(
        &mut self,
        frame: Value,
        restart: bool,
        sim_time_s: f64,
    ) -> Result<Vec<SensorFrame>, CliError> {
        if restart {
            self.call(json!({ "op": "load_scene_state", "states": [frame] }))?;
            self.ticks = 1;
        } else {
            self.call(json!({ "op": "append_scene_state", "states": [frame] }))?;
            self.ticks += 1;
        }
        self.bundle(self.ticks - 1, sim_time_s)
    }

    /// Render the current frame of the stream again (no new instant).
    pub fn rerender(&mut self, sim_time_s: f64) -> Result<Vec<SensorFrame>, CliError> {
        if self.ticks == 0 {
            return Err(CliError::new(
                "episode_not_reset",
                "nothing has been rendered yet",
            ));
        }
        self.bundle(self.ticks - 1, sim_time_s)
    }

    pub fn shm_path(&self) -> &std::path::Path {
        &self.shm_path
    }

    fn bundle(&mut self, tick: u32, sim_time_s: f64) -> Result<Vec<SensorFrame>, CliError> {
        let mut body = json!({
            "op": "render_bundle",
            "sim_tick": tick,
            "tick_index": tick,
            "cameras": self.cameras,
            "passes": self.passes,
            "sim_time_s": sim_time_s,
        });
        if !self.declared {
            if !self.lidars.is_empty() {
                body["lidars"] = json!(self.lidars);
            }
            if !self.radars.is_empty() {
                body["radars"] = json!(self.radars);
            }
        }
        let ResponseBody::RenderBundle { frames, .. } = self.call(body)? else {
            return Err(CliError::new(
                "render_failed",
                "render_bundle answered with another response",
            ));
        };
        self.declared = true;
        let map = self.state.shm.as_bytes();
        let mut out = Vec::with_capacity(frames.len());
        for record in frames {
            let start = record.offset as usize + RECORD_HEADER_BYTES;
            let data = &map[start..start + record.len as usize];
            let data = match record.format.as_str() {
                "rgba8" | "depth32f" => render_core::engine::strip_padding(
                    data,
                    record.width as usize,
                    record.height as usize,
                    4,
                ),
                _ => data.to_vec(),
            };
            out.push(SensorFrame {
                sensor_id: record.sensor_id,
                pass: record.pass,
                format: record.format,
                width: record.width,
                height: record.height,
                data,
            });
        }
        Ok(out)
    }
}

impl Drop for Sensors {
    fn drop(&mut self) {
        // fallback-ok: best-effort cleanup of this process's own ring file
        let _ = std::fs::remove_file(&self.shm_path);
    }
}
